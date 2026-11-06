import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Case {
  variant: string;
  retestPasses: boolean;
  codeCheck: { outcome: string };
  result: {
    static: { verdict: string; level: string };
    behavioral: { verdict: string };
    mismatch: { kind: string } | null;
    proposedAction: { kind: string } | null;
    captures: { id: string; status: string }[];
    scope: string[];
  };
  record: { codeCheck: { verdict: string }; behavioral: { verdict: string }; mismatch: unknown };
}

describe('staged export workflow acceptance (real local processes, no model)', () => {
  it('keeps static and runtime results apart; only the proper repair passes retest', () => {
    if (!existsSync('dist/bin.js') || !existsSync('jurator/dist/bin.js'))
      spawnSync('npm', ['run', 'build', '--silent'], { encoding: 'utf8' });
    const run = spawnSync(process.execPath, ['scripts/acceptance-export-case.mjs', '--json'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', META_API_KEY: '', MODEL_API_KEY: '' },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const { cases } = JSON.parse(run.stdout) as { cases: Case[] };
    const by = Object.fromEntries(cases.map((c) => [c.variant, c]));
    expect(Object.keys(by)).toEqual([
      'unrepaired',
      'exact-request-binding',
      'destination-allowlist-overblocking',
    ]);
    const capture = (c: Case, id: string) => c.result.captures.find((k) => k.id === id)?.status;
    for (const c of cases) {
      expect(c.codeCheck).toMatchObject({ via: 'jurator check --no-ai', verdict: 'holds' });
      expect(c.result.static).toMatchObject({ verdict: 'holds', level: 'rule' });
      expect(c.record.codeCheck.verdict).toBe('holds');
      expect(c.result.proposedAction).not.toBeNull();
      expect(c.result.scope.length).toBeGreaterThan(0);
    }
    const before = by.unrepaired!;
    expect(before.result.behavioral.verdict).toBe('contradicted');
    expect(before.result.mismatch?.kind).toBe('static-pass-runtime-contradicted');
    expect(before.record.mismatch).not.toBeNull();
    expect(before.result.proposedAction?.kind).toBe('repair');
    expect(capture(before, 'permitted-work')).toBe('PASS');
    expect(before.retestPasses).toBe(false);

    const fixed = by['exact-request-binding']!;
    expect(fixed.result.behavioral.verdict).toBe('supported');
    expect(fixed.result.mismatch).toBeNull();
    expect(capture(fixed, 'permitted-work')).toBe('PASS');
    expect(fixed.retestPasses).toBe(true);

    const over = by['destination-allowlist-overblocking']!;
    expect(capture(over, 'permitted-work')).toBe('FAIL');
    // Overblocking repair: stops the attack but denies authorized work, so the engine itself must not say supported.
    expect(over.result.behavioral.verdict).toBe('contradicted');
    expect(over.result.mismatch?.kind).toBe('static-pass-runtime-contradicted');
    expect(over.result.proposedAction?.kind).toBe('repair');
    expect(over.retestPasses).toBe(false);
  }, 120_000);
});
