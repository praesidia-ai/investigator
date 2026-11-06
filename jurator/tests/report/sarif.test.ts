import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import report from '../../src/cli/commands/report.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { CheckRun } from '../../src/contracts.js';
import { readRunFile } from '../../src/report/index.js';
import { runToSarif } from '../../src/report/sarif.js';
import { makeStyle } from '../../src/util/term.js';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures/report');

async function variant(): Promise<CheckRun> {
  const run = structuredClone(await readRunFile(join(FIXTURES, 'sample-run.json')));
  const ai = run.results.find((r) => r.level === 'ai-read' && r.citations.length)!;
  ai.verdict = 'looks-broken';
  ai.explanation = 'MODEL TEXT must not be evidence';
  ai.reason = 'MODEL REASON';
  const broken = run.results.find((r) => r.verdict === 'broken')!;
  broken.assurance = { coverage: 'limited-detector', openCounterexamples: 2, warning: 'misses aliased guards' };
  return run;
}

describe('SARIF export', () => {
  it('emits valid 2.1.0 structure with exact line regions', async () => {
    const log = runToSarif(await variant());
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    const run = log.runs[0]!;
    expect(run.tool.driver.name).toBeTruthy();
    const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
    for (const r of run.results) {
      expect(ruleIds.has(r.ruleId)).toBe(true);
      expect(['error', 'note']).toContain(r.level);
      for (const l of r.locations) {
        const p = l.physicalLocation;
        expect(p.artifactLocation.uri).not.toMatch(/^\//u);
        expect(p.region.startLine).toBeGreaterThan(0);
        expect(p.region.endLine).toBeGreaterThanOrEqual(p.region.startLine);
      }
    }
    const err = run.results.filter((r) => r.level === 'error');
    expect(err).toHaveLength(1);
    expect(err[0]!.ruleId).toBe('security.01');
    expect(err[0]!.locations[0]!.physicalLocation.region.startLine).toBe(15);
    expect(err[0]!.properties).toMatchObject({ scope: 'rule-level', detectorScope: 'limited-detector', openCounterexamples: 2, detectorWarning: 'misses aliased guards' });
  });

  it('advisory AI looks-broken is a labelled note, never an error, with no model text', async () => {
    const log = runToSarif(await variant());
    const notes = log.runs[0]!.results.filter((r) => r.level === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.properties).toMatchObject({ scope: 'advisory-ai-read', independentlyVerified: false });
    expect(notes[0]!.message.text).toMatch(/Advisory AI read, not verified/u);
    expect(JSON.stringify(log)).not.toContain('MODEL');
  });

  it('holds, kept and cant-tell are not alerts; cant-tell stays visible in run properties', async () => {
    const log = runToSarif(await variant());
    expect(log.runs[0]!.results.map((r) => r.level).sort()).toEqual(['error', 'note']);
    expect(log.runs[0]!.properties.notEvaluated).toContainEqual({ promiseId: 'praesidia.02', verdict: 'cant-tell', level: 'ai-read' });
  });

  it('labels a dirty run', async () => {
    const run = await variant();
    run.snapshot.dirty = true;
    const props = runToSarif(run).runs[0]!.properties;
    expect(props).toMatchObject({ dirty: true, reproducible: false });
    expect(runToSarif(await variant()).runs[0]!.properties).not.toHaveProperty('reproducible');
  });
});

describe('SARIF location scope', () => {
  it('keeps only head citations as locations, encodes paths, and lists a base-only result', async () => {
    const run = await variant();
    const broken = run.results.find((r) => r.verdict === 'broken')!;
    const base = { ...broken.citations[0]!, commit: 'b'.repeat(40), path: 'src/my dir/#a.ts' };
    broken.citations = [broken.citations[0]!, base];
    const result = runToSarif(run).runs[0]!.results.find((r) => r.ruleId === broken.promiseId)!;
    expect(result.locations).toHaveLength(1);
    expect(result.relatedLocations![0]!.physicalLocation.artifactLocation.uri).toBe('src/my%20dir/%23a.ts');
    broken.citations = [base];
    const log = runToSarif(run);
    expect(log.runs[0]!.results.some((r) => r.ruleId === broken.promiseId)).toBe(false);
    expect(log.runs[0]!.properties.notEvaluated).toContainEqual(expect.objectContaining({ promiseId: broken.promiseId }));
  });
});

describe('jurator report --format sarif', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });
  const ctx = (cwd: string, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const c: CommandContext = { cwd, argv, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), style: makeStyle(false), now: () => new Date('2026-11-04T04:00:00Z') };
    return { c, out, err };
  };
  async function repo() {
    dir = await mkdtemp(join(tmpdir(), 'kw-sarif-'));
    await mkdir(join(dir, '.git'));
    await cp(join(FIXTURES, 'acme', '.jurator'), join(dir, '.jurator'), { recursive: true });
    return dir;
  }

  it('writes the SARIF file', async () => {
    const root = await repo();
    const { c, err } = ctx(root, [join(FIXTURES, 'sample-run.json'), '--format', 'sarif', '--out', 'o/r.sarif']);
    expect(await report.run(c)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(await readFile(join(root, 'o', 'r.sarif'), 'utf8')).version).toBe('2.1.0');
  });

  it('rejects an unknown format and a missing run', async () => {
    const root = await repo();
    expect(await report.run(ctx(root, ['--format', 'pdf']).c)).toBe(2);
    expect(await report.run(ctx(root, ['--format', 'sarif']).c)).toBe(2);
  });
});
