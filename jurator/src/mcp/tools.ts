// Owner: X-AGENTS. The four MCP tools: read and check only. No tool can accept, waive or edit a promise or a rule.
// Principle 2 holds here too: check_change runs rules (no AI) and the quick level; it never asks a model.
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { isSelected, scopeOf } from '../check/index.js';
import type {
  CheckOptions,
  CheckResult,
  CheckRun,
  Citation,
  Config,
  GitRepo,
  PromiseRecord,
  Rule,
  Store,
} from '../contracts.js';
import { LABELS, policyText, policyWhere, renderRunText } from '../render/index.js';
import { JuratorError } from '../util/errors.js';
import { makeStyle } from '../util/term.js';
import type { ToolDefinition, ToolResult } from './protocol.js';

export interface McpWorkspace {
  readonly store: Store;
  readonly repo: GitRepo;
}

/** Everything the tools need from the outside world; tests pass fakes. */
export interface McpDeps {
  /** Opens the repo and its store. Called on every tool call, so promises accepted meanwhile are seen. */
  open(): Promise<McpWorkspace>;
  runCheck(options: CheckOptions): Promise<CheckRun>;
  /** Saved check runs, newest last. */
  listRuns(store: Store): Promise<CheckRun[]>;
  now(): Date;
}

const PLAIN = makeStyle(false);
const DEFAULT_BASE = 'main';
const MAX_CITATIONS = 5;
const GUARDRAIL = `Never decide yourself that a promise holds or is broken (only ${BRAND.command} check says so), and never edit ${BRAND.folder}/.`;

export const SERVER_INSTRUCTIONS = [
  `${BRAND.name} checks code changes against the company's written promises (numbered, each with the exact policy quote).`,
  'Before you edit files, call promises_for_change with the files you plan to change, and respect what it returns.',
  `Before you push, call check_change (or run \`${BRAND.command} check --diff main\`) and fix anything BROKEN.`,
  GUARDRAIL,
].join(' ');

/* ------------------------------ helpers ------------------------------ */

async function workspace(deps: McpDeps): Promise<McpWorkspace & { config: Config }> {
  const ws = await deps.open();
  if (!(await ws.store.exists())) {
    throw new JuratorError(
      'NO_WORKSPACE',
      `No ${BRAND.folder}/ folder in this repo yet. A person sets it up with \`${BRAND.command} init\`; do not create it yourself.`,
    );
  }
  return { ...ws, config: await ws.store.readConfig() };
}

function sourcesOf(config: Config): Record<string, string> {
  return Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const));
}

function rulesOf(rules: readonly Rule[], promiseId: string, acceptedOnly = true): Rule[] {
  return rules
    .filter((r) => r.promiseId === promiseId && (!acceptedOnly || r.status === 'accepted'))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function byId(a: PromiseRecord, b: PromiseRecord): number {
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

function policyOf(p: PromiseRecord, sources: Record<string, string>): { quote: string; where: string } {
  return { quote: p.quote.text, where: policyWhere(p.quote, sources) };
}

function ruleJson(r: Rule) {
  return {
    id: r.id,
    status: r.status,
    description: r.description,
    mode: r.mode,
    globs: r.globs,
    provenToFail: r.provenBy?.failedAsExpected === true,
  };
}

function citationJson(c: Citation): Record<string, unknown> {
  return { path: c.path, startLine: c.startLine, endLine: c.endLine, commit: c.commit, quote: c.quote };
}

function resultJson(r: CheckResult, sources: Record<string, string>): Record<string, unknown> {
  return {
    promiseId: r.promiseId,
    wording: r.wording,
    verdict: r.verdict,
    level: r.level,
    label: LABELS[r.verdict],
    explanation: r.explanation ?? r.reason ?? null,
    policy: { quote: r.policyQuote.text, where: policyWhere(r.policyQuote, sources) },
    citations: r.citations.slice(0, MAX_CITATIONS).map(citationJson),
  };
}

/** Accepts repo-relative paths, './x', Windows separators, or absolute paths inside the repo. */
export function toRepoPath(root: string, file: string): string {
  let f = file.trim();
  if (isAbsolute(f)) {
    const rel = relative(root, f);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) f = rel.split(sep).join('/');
  }
  return f.replace(/\\/gu, '/').replace(/^(\.\/)+/u, '');
}

/** A branch, tag or commit; never something git could read as an option. */
const refSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./@{}~^-]+$/u, 'use a branch, tag or commit name')
  .refine((s) => !s.startsWith('-'), 'a ref cannot start with "-"');

function badInput(error: z.ZodError, usage: string): ToolResult {
  const issue = error.issues[0];
  const where = issue && issue.path.length ? `${issue.path.join('.')}: ` : '';
  return { text: `Bad input: ${where}${issue?.message ?? 'invalid arguments'}. ${usage}`, isError: true };
}

/* ------------------------------ tools ------------------------------ */

function listPromises(deps: McpDeps): ToolDefinition {
  return {
    name: 'list_promises',
    title: 'List promises',
    description:
      `Lists the company's accepted promises: id, wording, kind (must / must-not / may), what checks it (code, process, runtime), ` +
      'the files it is about, and whether a rule (no AI) checks it. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async call() {
      const { store, config } = await workspace(deps);
      const sources = sourcesOf(config);
      const promises = (await store.readPromises()).filter((p) => p.status === 'accepted').sort(byId);
      const rules = await store.readRules();
      const items = promises.map((p) => {
        const accepted = rulesOf(rules, p.id);
        return {
          id: p.id,
          wording: p.wording,
          kind: p.kind,
          checkable: p.checkable,
          scope: p.scope,
          appliesTo: [...scopeOf(p, config)],
          hasRule: accepted.length > 0,
          rules: accepted.map((r) => r.id),
          policy: policyOf(p, sources),
        };
      });
      const code = items.filter((i) => i.checkable === 'code');
      const covered = code.filter((i) => i.hasRule).length;
      if (items.length === 0) {
        return {
          text: `No accepted promises yet. A person compiles and accepts them (\`${BRAND.command} compile\`, \`${BRAND.command} accept\`).`,
          structured: { promises: [], coveredByRules: 0, codePromises: 0 },
        };
      }
      const width = Math.max(...items.map((i) => i.id.length));
      const lines = [
        `${items.length} accepted promise${items.length === 1 ? '' : 's'} (${covered} of ${code.length} code promises checked by a rule, no AI):`,
        ...items.map(
          (i) =>
            `${i.id.padEnd(width)}  ${i.kind.padEnd(8)} ${i.checkable.padEnd(7)} ${i.hasRule ? 'rule   ' : 'no rule'}  ${i.wording}  [${i.appliesTo.join(', ')}]`,
        ),
        'Next: before editing, call promises_for_change with the files you plan to change.',
      ];
      return { text: lines.join('\n'), structured: { promises: items, coveredByRules: covered, codePromises: code.length } };
    },
  };
}

const forChangeArgs = z.object({ files: z.array(z.string().min(1)).min(1) });

function promisesForChange(deps: McpDeps): ToolDefinition {
  return {
    name: 'promises_for_change',
    title: 'Promises for a change',
    description:
      'Call this BEFORE you edit files. Give the files you plan to change (repo-relative paths); it returns the accepted promises ' +
      'about those files, with the exact policy quote and the rule that checks each one, so you can respect them while you edit. Read only.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Files you plan to change, repo-relative, e.g. ["src/routes/export.ts"].',
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    async call(raw) {
      const parsed = forChangeArgs.safeParse(raw);
      if (!parsed.success) return badInput(parsed.error, 'Pass {"files": ["src/path/to/file.ts", ...]}.');
      const { store, repo, config } = await workspace(deps);
      const sources = sourcesOf(config);
      const files = [...new Set(parsed.data.files.map((f) => toRepoPath(repo.root, f)))].sort();
      const rules = await store.readRules();
      const promises = (await store.readPromises())
        .filter((p) => p.status === 'accepted' && p.checkable !== 'runtime')
        .sort(byId);
      const hits = promises
        .map((p) => {
          const accepted = rulesOf(rules, p.id);
          const matched = files.filter((f) => isSelected(p, accepted, config, [f]));
          return { p, accepted, matched };
        })
        .filter((x) => x.matched.length > 0);
      const items = hits.map(({ p, accepted, matched }) => ({
        id: p.id,
        wording: p.wording,
        kind: p.kind,
        checkable: p.checkable,
        policy: policyOf(p, sources),
        checkedBy: p.checkable === 'process' ? 'checklist' : accepted.length > 0 ? 'rule' : 'none',
        rules: accepted.map(ruleJson),
        files: matched,
      }));
      const structured = { files, promises: items };
      if (items.length === 0) {
        return {
          text: `No accepted promise is about ${files.join(', ')}.\nNext: before you push, call check_change (or run \`${BRAND.command} check --diff main\`).`,
          structured,
        };
      }
      const lines = [`${items.length} promise${items.length === 1 ? '' : 's'} apply to ${files.join(', ')}. Respect them while you edit:`];
      for (const [n, i] of items.entries()) {
        const how =
          i.checkedBy === 'rule'
            ? `checked by ${i.rules.map((r) => r.id).join(', ')} (no AI)`
            : i.checkedBy === 'checklist'
              ? 'a person confirms it before merge'
              : 'no rule yet: a check will say NOT CHECKED';
        lines.push(`${i.id} (${i.kind}, ${how}): ${i.wording}`);
        const quote = hits[n]?.p.quote;
        if (quote) lines.push(`  Policy: ${policyText(quote, 300)}  ${i.policy.where}`);
        for (const r of i.rules) lines.push(`  Rule ${r.id}: ${r.description}  [${r.globs.join(', ')}]`);
        lines.push(`  Files: ${i.files.join(', ')}`);
      }
      lines.push(`Next: before you push, call check_change. ${GUARDRAIL}`);
      return { text: lines.join('\n'), structured };
    },
  };
}

const checkArgs = z.object({ base: refSchema.optional() });

function checkChange(deps: McpDeps): ToolDefinition {
  return {
    name: 'check_change',
    title: 'Check the change',
    description:
      `Runs ${BRAND.command} check on base...HEAD (default base: main) with rules only, no AI: HOLDS/BROKEN come from rules, ` +
      'promises without a rule are NOT CHECKED. It reads committed code at HEAD, so commit first. Returns the verdicts with the ' +
      'code lines (copied from git) and the policy quotes. Writes only its local run record.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: `Branch or commit to compare HEAD with (default "${DEFAULT_BASE}").` },
      },
      additionalProperties: false,
    },
    async call(raw) {
      const parsed = checkArgs.safeParse(raw);
      if (!parsed.success) return badInput(parsed.error, `Pass {"base": "${DEFAULT_BASE}"} or nothing.`);
      const { store, repo, config } = await workspace(deps);
      const sources = sourcesOf(config);
      const base = parsed.data.base ?? DEFAULT_BASE;
      const run = await deps.runCheck({
        repo,
        store,
        model: null,
        target: { kind: 'diff', base, head: 'HEAD' },
        aiRead: false,
        now: () => deps.now(),
      });
      let runPath: string | undefined;
      try {
        const saved = await store.writeRun(run);
        const rel = relative(store.repoRoot, saved);
        runPath = rel && !rel.startsWith('..') ? rel.split(sep).join('/') : saved;
      } catch {
        runPath = undefined; // the verdicts still stand; only the saved record is missing
      }
      const s = run.summary;
      const blocking = run.failMode === 'block' && s.broken > 0;
      const lines = [renderRunText(run, PLAIN, runPath === undefined ? { sources } : { sources, runPath })];
      if (s.broken > 0) {
        lines.push(
          `A rule found ${s.broken} broken promise${s.broken === 1 ? '' : 's'}. Fix the cited code lines; do not change the rule, the promise or ${BRAND.folder}/ to make the check pass.`,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          passed: s.broken === 0,
          blocking,
          failMode: run.failMode,
          status: run.status,
          base,
          head: run.target.head,
          changedFiles: run.target.changedFiles ?? [],
          runId: run.id,
          runPath: runPath ?? null,
          digest: run.digest,
          summary: s,
          results: run.results.map((r) => resultJson(r, sources)),
          checklist: run.checklist,
        },
      };
    },
  };
}

const explainArgs = z.object({ id: z.string().min(1).max(80) });

function explainPromise(deps: McpDeps): ToolDefinition {
  return {
    name: 'explain_promise',
    title: 'Explain a promise',
    description:
      'Explains one promise by id (e.g. "security.01"): its wording, the exact policy quote and where it is, the rules that check it, ' +
      'known contradictions, and its verdict in the last saved check run. Read only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Promise id, e.g. "privacy.01".' } },
      required: ['id'],
      additionalProperties: false,
    },
    async call(raw) {
      const parsed = explainArgs.safeParse(raw);
      if (!parsed.success) return badInput(parsed.error, 'Pass {"id": "privacy.01"}.');
      const id = parsed.data.id.trim();
      const { store, config } = await workspace(deps);
      const sources = sourcesOf(config);
      const promise = (await store.readPromises()).find((p) => p.id === id);
      if (!promise) {
        return { text: `No promise "${id}". Call list_promises to see the ids.`, isError: true };
      }
      const rules = rulesOf(await store.readRules(), id, false);
      const contradictions = (await store.readContradictions()).filter(
        (c) => c.promiseIds.includes(id) && c.status !== 'not-a-conflict',
      );
      let last: { run: CheckRun; result: CheckResult } | null = null;
      try {
        const runs = await deps.listRuns(store);
        for (let i = runs.length - 1; i >= 0 && !last; i -= 1) {
          const run = runs[i] as CheckRun;
          const result = run.results.find((r) => r.promiseId === id);
          if (result) last = { run, result };
        }
      } catch {
        last = null; // local runs are a cache; a broken one never fails the explanation
      }

      const lines = [
        `${promise.id} (${promise.status}, ${promise.kind}, ${promise.checkable}): ${promise.wording}`,
        `Policy: ${policyText(promise.quote, 400)}  ${policyWhere(promise.quote, sources)}`,
        `About: ${scopeOf(promise, config).join(', ')}${promise.scope.length ? '' : ' (the default code scope)'}`,
      ];
      if (rules.length === 0) {
        lines.push(
          promise.checkable === 'code'
            ? 'Rules: none yet, so a check says NOT CHECKED (an AI read, when on, only says LOOKS KEPT / LOOKS BROKEN and never blocks).'
            : `Rules: none (a ${promise.checkable} promise is not checked in code).`,
        );
      }
      for (const r of rules) {
        const proof = r.provenBy?.failedAsExpected ? `proven to fail when: ${r.provenBy.mutation}` : 'not proven to fail';
        lines.push(`Rule ${r.id} (${r.status}, ${proof}): ${r.description}  [${r.globs.join(', ')}]`);
      }
      for (const c of contradictions) {
        const others = c.promiseIds.filter((p) => p !== id).join(', ');
        lines.push(`Contradiction ${c.id} (${c.status}) with ${others}: ${c.example}`);
      }
      if (last) {
        const c = last.result.citations[0];
        const at = c ? `  ${c.path}:${c.startLine}  ${c.quote.split('\n')[0]?.trim() ?? ''}` : '';
        lines.push(`Last verdict: ${LABELS[last.result.verdict]} in run ${last.run.id}${at}`);
        if (last.result.explanation) lines.push(`  ${last.result.explanation}`);
      } else {
        lines.push('Last verdict: no saved check run includes it yet. Call check_change.');
      }
      lines.push(GUARDRAIL);

      return {
        text: lines.join('\n'),
        structured: {
          promise: {
            id: promise.id,
            status: promise.status,
            wording: promise.wording,
            kind: promise.kind,
            checkable: promise.checkable,
            scope: promise.scope,
            appliesTo: [...scopeOf(promise, config)],
            policy: policyOf(promise, sources),
          },
          rules: rules.map(ruleJson),
          contradictions: contradictions.map((c) => ({ id: c.id, status: c.status, promiseIds: c.promiseIds, example: c.example })),
          lastVerdict: last
            ? { runId: last.run.id, createdAt: last.run.createdAt, ...resultJson(last.result, sources) }
            : null,
        },
      };
    },
  };
}

/** The tool list, in the order an agent uses them. */
export function createTools(deps: McpDeps): ToolDefinition[] {
  return [promisesForChange(deps), checkChange(deps), explainPromise(deps), listPromises(deps)];
}
