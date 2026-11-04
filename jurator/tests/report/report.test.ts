import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import report from '../../src/cli/commands/report.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { CheckRun, PromiseRecord } from '../../src/contracts.js';
import { buildGraph, loadReportInput, promiseViews, readRunFile, renderReport, ruleViews, type ReportInput } from '../../src/report/index.js';
import { makeStyle } from '../../src/util/term.js';
import { openStore } from '../../src/workspace/index.js';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures/report');
const NOW = () => new Date('2026-11-04T04:00:00Z');

async function sampleInput(run = 'sample-run.json'): Promise<ReportInput> {
  return loadReportInput(openStore(join(FIXTURES, 'acme')), { runPath: join(FIXTURES, run), now: NOW });
}

/** Text content of the page without tags, entities decoded enough for plain assertions. */
function text(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/gu, '')
    .replace(/<script>[\s\S]*?<\/script>/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');
}

describe('jurator report: sample run', () => {
  it('renders the headline, verdict words by level, quotes, code and the graph', async () => {
    const input = await sampleInput();
    const html = renderReport(input);
    const t = text(html);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(t).toContain('6 of 9 code promises are covered by rules');
    // Level decides the words: rules say HOLDS/BROKEN, AI reads only LOOKS KEPT / CAN'T TELL.
    expect(t).toMatch(/security\.01 BROKEN rule, no AI/u);
    expect(t).toMatch(/privacy\.02 HOLDS rule, no AI/u);
    expect(t).toMatch(/privacy\.03 LOOKS KEPT read by AI/u);
    expect(t).toMatch(/praesidia\.02 CAN'T TELL read by AI/u);
    expect(t).not.toMatch(/praesidia\.0[12] HOLDS/u);
    // Diff run: untouched promises say so instead of pretending they were checked.
    expect(t).toMatch(/privacy\.01 not touched by this change/u);
    expect(t).toMatch(/privacy\.04 on the PR checklist/u);
    // Policy quote with source and line, code citation with path:line and the copied line.
    expect(t).toContain('Only workspace admins can export customer data.');
    expect(t).toContain('docs/security.md:3');
    expect(t).toContain('src/routes/export.ts:15');
    expect(t).toContain("router.get('/export.csv', async (req, res) => {");
    // Rules with their proof, contradictions with their example.
    expect(t).toContain('R-security.01-1');
    expect(t).toMatch(/removed requireAdmin\( from 1 line \(src\/routes\/export\.ts:9\); the rule then failed/u);
    expect(t).toContain('A support chat from 1 March must be deleted by 31 March');
    // The graph: inline SVG, the broken path drawn in red.
    expect(html).toContain('<svg class="graph"');
    expect(html).toMatch(/class="g-edge e-broken"/u);
    expect(html).toContain('href="#promise-security.01"');
    expect(t).toContain('jurator verify');
  });

  it('is self-contained: no scripts or styles from the network, only Google Fonts', async () => {
    const html = renderReport(await sampleInput());
    const urls = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/gu)].map((m) => m[1] ?? '');
    for (const url of urls) expect(url).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/u);
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(html.match(/<script>/gu)?.length).toBe(1);
  });

  it('puts problems first', async () => {
    const html = renderReport(await sampleInput());
    const order = [...html.matchAll(/<article class="promise [^"]*" id="promise-([^"]+)"/gu)].map((m) => m[1]);
    expect(order[0]).toBe('security.01');
    expect(order.indexOf('praesidia.02')).toBeLessThan(order.indexOf('privacy.02'));
  });

  it('a repo run on main shows every code promise and no broken edge', async () => {
    const html = renderReport(await sampleInput('main-run.json'));
    expect(text(html)).toMatch(/privacy\.01 HOLDS rule, no AI/u);
    const svg = html.slice(html.indexOf('<svg class="graph"'), html.indexOf('</svg>'));
    expect(svg).toContain('R-privacy.01-1');
    expect(svg).not.toMatch(/class="g-edge e-broken"/u);
  });

  it('builds graph columns policies -> promises -> code -> rules', async () => {
    const input = await sampleInput();
    const g = buildGraph(promiseViews(input), ruleViews(input), input.contradictions, input.sources);
    expect(g.columns.map((c) => c.length)).toEqual([3, 11, 7, 6]);
    expect(g.edges).toContainEqual({ from: 'p:security.01', to: 'f:src/routes/export.ts', tone: 'broken' });
    expect(g.edges).toContainEqual({ from: 'f:src/routes/export.ts', to: 'r:R-security.01-1', tone: 'broken' });
    expect(g.conflicts).toHaveLength(1);
  });
});

describe('jurator report: escaping', () => {
  it('escapes <script> in a policy quote, a wording, code and a rule pattern', async () => {
    const input = await sampleInput();
    const evil = '<script>alert(1)</script>';
    const promises: PromiseRecord[] = input.promises.map((p) =>
      p.id === 'security.01' ? { ...p, wording: `Admins only ${evil}`, quote: { ...p.quote, text: `Quote ${evil}"'` } } : p,
    );
    const run = structuredClone(input.run) as CheckRun;
    const hit = run.results.find((r) => r.promiseId === 'security.01');
    if (hit?.citations[0]) hit.citations[0].quote = `res.send("${evil}")`;
    const rules = input.rules.map((r) => (r.id === 'R-security.01-1' ? { ...r, pattern: `</code>${evil}` } : r));
    const html = renderReport({ ...input, promises, run, rules, sources: { ...input.sources, security: `docs/${evil}.md` } });
    expect(html).not.toContain(evil);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(/<script>/gu)?.length).toBe(1);
  });
});

describe('jurator report: empty states', () => {
  const empty: ReportInput = { promises: [], rules: [], contradictions: [], sources: {}, run: null, generatedAt: NOW() };

  it('renders a page with no promises, no rules, no run', () => {
    const t = text(renderReport({ ...empty, repoName: 'fresh-repo' }));
    expect(t).toContain('No code promises yet');
    expect(t).toContain('No check yet.');
    expect(t).toContain('No promises yet. Run jurator compile');
    expect(t).toContain('No rules yet. Run jurator rule propose --all');
    expect(t).toContain('No contradictions found');
    expect(t).toContain('The graph appears once there are promises.');
    expect(t).toContain('fresh-repo');
  });

  it('without a run, coverage comes from the store and promises say "no check yet"', async () => {
    const input = await sampleInput();
    const t = text(renderReport({ ...input, run: null }));
    expect(t).toContain('6 of 9 code promises are covered by rules');
    expect(t).toMatch(/security\.01 no check yet/u);
  });

  it('a diff that touches nothing says so', async () => {
    const input = await sampleInput();
    const run = { ...(input.run as CheckRun), results: [], checklist: [] };
    expect(text(renderReport({ ...input, run }))).toContain('This change touches no promise.');
  });
});

describe('jurator report command', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  function ctx(cwd: string, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const c: CommandContext = {
      cwd,
      argv,
      env: {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      style: makeStyle(false),
      now: NOW,
    };
    return { c, out, err };
  }

  async function repo(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'kw-report-'));
    await mkdir(join(dir, '.git'));
    await cp(join(FIXTURES, 'acme', '.jurator'), join(dir, '.jurator'), { recursive: true });
    return dir;
  }

  it('writes the HTML file for a given run', async () => {
    const root = await repo();
    const { c, out, err } = ctx(root, [join(FIXTURES, 'sample-run.json'), '--out', 'out/report.html']);
    expect(await report.run(c)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toContain('Wrote out/report.html: 11 promises, 6 rules, run 20261104T033604Z-74cf09b.');
    expect(out.at(-1)).toMatch(/^Next: /u);
    const html = await readFile(join(root, 'out', 'report.html'), 'utf8');
    expect(html).toContain('6 of 9 code promises are covered by rules');
  });

  it('uses the newest saved run by default', async () => {
    const root = await repo();
    const run = await readRunFile(join(FIXTURES, 'sample-run.json'));
    await openStore(root).writeRun(run);
    const { c, out } = ctx(root, []);
    expect(await report.run(c)).toBe(0);
    expect(out[0]).toContain('Wrote jurator-report.html');
    const html = await readFile(join(root, 'jurator-report.html'), 'utf8');
    expect(html).toContain('jurator verify .jurator/local/runs/20261104T033604Z-74cf09b/run.json');
  });

  it('works with no run yet and says what to do next', async () => {
    const root = await repo();
    const { c, out } = ctx(root, ['--out', 'r.html']);
    expect(await report.run(c)).toBe(0);
    expect(out.at(-1)).toBe('Next: jurator check, then jurator report again.');
  });

  it('exits 2 on a file that is not a run, and outside a workspace', async () => {
    const root = await repo();
    const bad = ctx(root, [join(FIXTURES, 'acme', '.jurator', 'config.json')]);
    expect(await report.run(bad.c)).toBe(2);
    expect(bad.err[0]).toMatch(/^BAD_RUN_FILE: /u);
    await rm(join(root, '.jurator'), { recursive: true });
    const none = ctx(root, []);
    expect(await report.run(none.c)).toBe(2);
    expect(none.err[0]).toContain('No .jurator/ folder');
  });
});
