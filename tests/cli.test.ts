import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXAMPLE_DIRECTORY, temporaryCase } from './helpers.js';

function output() {
  const stdout: string[] = [],
    stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

describe('standalone command line', () => {
  it('exposes regression evaluation explicitly without model credentials', async () => {
    const captured = output();
    expect(await runCli(['evaluate', '--cases', '2', '--json'], {}, captured.io)).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      mode: 'deterministic-regression-not-model-quality',
      totals: { cases: 2, passed: 2 },
    });
    expect(await runCli(['evaluate', '--live', '--cases', '1'], {}, output().io)).toBe(2);
  });
  it('renders verified HTML/JUnit and exposes its structural JSON Schema', async () => {
    const fixture = await temporaryCase();
    try {
      const path = join(fixture.directory, 'case-report.json');
      expect(await runCli(['demo', '--out', path], {}, output().io)).toBe(1);
      for (const format of ['html', 'junit']) {
        const destination = join(fixture.directory, `report.${format}`);
        expect(
          await runCli(['render', path, '--out', destination, '--format', format], {}, output().io),
        ).toBe(0);
        expect(await readFile(destination, 'utf8')).toContain(
          format === 'html' ? '<!doctype html>' : '<testsuites',
        );
      }
      const schema = output();
      expect(await runCli(['schema'], {}, schema.io)).toBe(0);
      expect(JSON.parse(schema.stdout.join(''))).toMatchObject({
        $id: 'urn:praesidia:investigator:case-report:v1',
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('saves a cancelled investigation as incomplete instead of losing the case', async () => {
    const fixture = await temporaryCase();
    try {
      const signal = AbortSignal.abort();
      const path = join(fixture.directory, 'incomplete.json');
      expect(await runCli(['demo', '--out', path], {}, output().io, signal)).toBe(2);
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        run: { status: 'incomplete', finding: null, error: { code: 'RUN_ABORTED' } },
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('runs and verifies the standalone external repair workflow', async () => {
    const fixture = await temporaryCase();
    try {
      const destination = join(fixture.directory, 'repair');
      expect(await runCli(['repair-demo', '--out', destination], {}, output().io)).toBe(0);
      const captured = output();
      expect(
        await runCli(
          ['verify-repair', join(destination, 'repair.json'), '--json'],
          {},
          captured.io,
        ),
      ).toBe(0);
      expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
        closedGap: true,
        unchangedExpectations: true,
        permittedWorkPreserved: true,
        authenticity: 'not-established',
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });
  it.each([
    ['request-unbound', 1],
    ['request-bound', 0],
    ['block-all', 1],
    ['false-refusal', 1],
    ['unavailable', 2],
  ] as const)('runs %s without Praesidia or model credentials', async (variant, expectedCode) => {
    const captured = output();
    const code = await runCli(['demo', '--variant', variant, '--json'], {}, captured.io);
    expect(code).toBe(expectedCode);
    expect(captured.stderr).toEqual([]);
    const report = JSON.parse(captured.stdout.join('')) as { run: { provider: { mode: string } } };
    expect(report.run.provider.mode).toBe('scripted');
  });

  it('requires an explicit model key for live mode and never falls back', async () => {
    const captured = output();
    const code = await runCli(['investigate', EXAMPLE_DIRECTORY], {}, captured.io);
    expect(code).toBe(2);
    expect(captured.stderr.join('')).toContain('MODEL_KEY_REQUIRED');
    expect(captured.stdout).toEqual([]);
  });

  it('exports and verifies a report through CLI commands', async () => {
    const fixture = await temporaryCase();
    try {
      const reportPath = join(fixture.directory, 'report.json');
      expect(await runCli(['demo', '--out', reportPath], {}, output().io)).toBe(1);
      const captured = output();
      expect(await runCli(['verify', reportPath, '--json'], {}, captured.io)).toBe(0);
      expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
        integrity: 'consistent-with-supplied-manifest',
        authenticity: 'not-established',
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('does not echo unknown argument values into errors', async () => {
    const captured = output();
    expect(await runCli(['demo', '--api-key', 'sensitive-test-key'], {}, captured.io)).toBe(2);
    expect(captured.stderr.join('')).not.toContain('sensitive-test-key');
  });
});
