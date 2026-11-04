// Test helpers for tests/rules: a scripted model from fixture files, acme files read from git, promise records.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelJsonRequest, ModelJsonResult, PromiseRecord, Rule, SourceFile } from '../../src/contracts.js';
import { JuratorError } from '../../src/util/errors.js';

/** The demo app as a git repo, built once per test run from examples/acme-notes (scripts/make-demo-repo.sh). */
function buildAcme(): string {
  const override = process.env.ACME_NOTES;
  if (override && existsSync(join(override, '.git'))) return override;
  const dir = join(mkdtempSync(join(tmpdir(), 'kw-acme-')), 'acme-notes');
  try {
    execFileSync('bash', [join(import.meta.dirname, '../../scripts/make-demo-repo.sh'), dir], { stdio: 'ignore' });
  } catch {
    return dir;
  }
  return dir;
}
export const ACME = buildAcme();
export const hasAcme = existsSync(join(ACME, '.git'));
export const SCRIPTED_ACME = join(import.meta.dirname, '../../fixtures/scripted/acme');
export const COMMIT = 'abc1234';

/** Reads `<dir>/<task with ':' -> '__'>.json` (the raw answer value), like the scripted client in src/model. */
export function scriptedModel(dir: string, calls: string[] = []): ModelClient {
  return {
    id: 'scripted',
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      calls.push(request.task);
      const file = join(dir, `${request.task.replaceAll(':', '__')}.json`);
      if (!existsSync(file)) throw new JuratorError('NO_SCRIPTED_ANSWER', `no scripted answer ${file}`);
      const value = request.schema.parse(JSON.parse(readFileSync(file, 'utf8')));
      return { value, usage: { id: 'scripted', mode: 'scripted', inputTokens: request.input.length, outputTokens: 0, usd: 0 } };
    },
  };
}
/** A model that answers every task with `answer`. */
export function fixedModel(answer: unknown): ModelClient {
  return {
    id: 'fixed',
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      return { value: request.schema.parse(answer), usage: { id: 'fixed', mode: 'scripted', inputTokens: 1, outputTokens: 1, usd: 0 } };
    },
  };
}

export function acmeFiles(ref: string): SourceFile[] {
  const paths = execFileSync('git', ['-C', ACME, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.ts'));
  return paths.map((path) => ({ path, text: execFileSync('git', ['-C', ACME, 'show', `${ref}:${path}`], { encoding: 'utf8' }) }));
}

const SHA = 'a'.repeat(64);
export function promise(id: string, wording: string, scope: string[] = [], extra: Partial<PromiseRecord> = {}): PromiseRecord {
  return {
    id,
    status: 'accepted',
    wording,
    quote: { alias: id.split('.')[0] as string, policySha256: SHA, text: wording },
    kind: 'must',
    checkable: 'code',
    scope,
    foundBy: 'model',
    firstSeen: '2026-11-04T03:00:00.000Z',
    ...extra,
  };
}
export const ACME_PROMISES: Record<string, PromiseRecord> = {
  'security.01': promise('security.01', 'Only workspace admins can export customer data.', ['src/routes/**', 'src/auth/**']),
  'privacy.01': promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**']),
  'security.03': promise('security.03', 'Card numbers and passwords are never written to logs.', ['src/**'], { kind: 'must-not' }),
  'privacy.02': promise('privacy.02', 'Exports never include deleted or archived notes.', ['src/export/**', 'src/routes/**']),
  'praesidia.03': promise('praesidia.03', 'The export_notes tool needs approval before it runs.', ['src/agent/**']),
  'privacy.03': promise('privacy.03', 'We never sell your notes or share them with advertisers.', [], { kind: 'must-not' }),
};

export function rule(over: Partial<Rule> & Pick<Rule, 'mode' | 'pattern'>): Rule {
  return {
    id: 'R-test.01-1',
    promiseId: 'test.01',
    description: 'test rule',
    globs: ['src/**'],
    provenBy: null,
    status: 'accepted',
    author: 'human',
    createdAt: '2026-11-04T03:00:00.000Z',
    ...over,
  };
}
