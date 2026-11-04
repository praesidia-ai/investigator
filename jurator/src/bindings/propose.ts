// Owner: WP-B. The model names code locations for a promise; the program checks them and copies the lines from git.
import type { Binding, ModelClient, ModelUsage, PromiseRecord, SourceFile } from '../contracts.js';
import { filesForModel } from '../model/secrets.js';
import { BIND_INSTRUCTIONS, BIND_SCHEMA_NAME, MAX_LOCATIONS, bindAnswerSchema, bindTaskKey, type BindAnswer } from './prompts.js';
import { makeBinding } from './from-rule.js';
import { hasWord, kindFor, symbolFor } from './symbols.js';
import { fairOrder, promiseWords } from '../rules/select.js';

export const MAX_BIND_PROMPT_CHARS = 30_000;
/** A binding is a few lines (a constant, a guard), never a whole function. */
export const MAX_BINDING_LINES = 20;
/** How far the program looks for a stated name when the model's line numbers are off by a little. */
const NEAR = 3;

const splitLines = (text: string): string[] => text.split(/\r?\n/u);

/**
 * Promise, quote, facets and the code with line numbers, capped. Files in the promise's scope first; repos take turns
 * (R5-A) and files that name the promise's words lead within a repo.
 */
export function buildBindPrompt(promise: PromiseRecord, files: readonly SourceFile[], commit: string, maxChars = MAX_BIND_PROMPT_CHARS): string {
  const ordered = fairOrder(filesForModel(files), (f) => f.path, { scope: promise.scope, words: promiseWords(promise), textOf: (f) => f.text });
  const c = promise.facets?.constraint;
  const head = [
    `Promise ${promise.id} (${promise.kind}): ${promise.wording}`,
    `Policy quote (${promise.quote.alias}): "${promise.quote.text}"`,
    ...(promise.facets
      ? [`Typed facets: subject "${promise.facets.subject}", action "${promise.facets.action}", constraint ${c ? [c.name, c.op, c.value ?? '', c.unit ?? ''].filter(Boolean).join(' ') : 'none'}.`]
      : []),
    '',
    `Code at commit ${commit.slice(0, 12)}. Each line starts with its number and "| ", which is not part of the file.`,
  ];
  const parts: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const block = [`=== ${file.path}`, ...splitLines(file.text).map((l, i) => `${i + 1}| ${l}`)].join('\n');
    if (used + block.length <= maxChars) {
      parts.push(block);
      used += block.length;
    } else skipped.push(file.path);
  }
  if (skipped.length > 0) parts.push(`Other files not shown: ${skipped.slice(0, 40).join(', ')}${skipped.length > 40 ? ', ...' : ''}`);
  return [...head, ...parts].join('\n');
}

export interface DroppedLocation {
  readonly path: string;
  readonly lines: string;
  readonly reason: string;
}

/**
 * Checks each model location against the files (which the caller read from git at `commit`) and keeps only what the
 * program can verify: the file is shown, the lines exist and are not blank, at most 20 lines, and the stated name is
 * on them (a name 1-3 lines away moves the range onto it). The quote is copied from the file, never from the model.
 */
export function verifyLocations(
  promise: PromiseRecord,
  answer: BindAnswer,
  files: readonly SourceFile[],
  commit: string,
): { bindings: Binding[]; dropped: DroppedLocation[] } {
  const byPath = new Map(files.map((f) => [f.path, splitLines(f.text)]));
  const bindings: Binding[] = [];
  const dropped: DroppedLocation[] = [];
  for (const loc of answer.locations.slice(0, MAX_LOCATIONS)) {
    const where = `${loc.startLine}-${loc.endLine}`;
    const drop = (reason: string): void => void dropped.push({ path: loc.path, lines: where, reason });
    const lines = byPath.get(loc.path.replace(/^\.\//u, ''));
    if (!lines) {
      drop(`${loc.path} is not a file of this commit in the promise's code`);
      continue;
    }
    let start = loc.startLine;
    let end = loc.endLine;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      drop(`lines ${where} do not exist (the file has ${lines.length})`);
      continue;
    }
    if (end - start + 1 > MAX_BINDING_LINES) {
      drop(`lines ${where} are more than ${MAX_BINDING_LINES} lines; a binding points at the line itself`);
      continue;
    }
    const name = loc.name?.trim() || null;
    if (name && !lines.slice(start - 1, end).some((l) => hasWord(l, name))) {
      const near: number[] = [];
      for (let n = Math.max(1, start - NEAR); n <= Math.min(lines.length, end + NEAR); n += 1) if (hasWord(lines[n - 1] ?? '', name)) near.push(n);
      if (near.length !== 1) {
        drop(`${name} is not on ${loc.path}:${where}`);
        continue;
      }
      start = near[0] as number;
      end = start;
    }
    const quoteLines = lines.slice(start - 1, end);
    if (quoteLines.every((l) => l.trim() === '')) {
      drop(`${loc.path}:${where} is blank`);
      continue;
    }
    const path = loc.path.replace(/^\.\//u, '');
    if (bindings.some((b) => b.path === path && b.startLine <= end && start <= b.endLine)) {
      drop(`${path}:${where} repeats a location already bound`);
      continue;
    }
    const first = quoteLines.find((l) => (name ? hasWord(l, name) : l.trim() !== '')) ?? '';
    const symbol = name ?? symbolFor(first);
    const kind = kindFor(path, first, symbol) === 'guard' ? 'guard' : loc.kind;
    bindings.push(
      makeBinding(promise, { path, commit, startLine: start, endLine: end, quote: quoteLines.join('\n') }, {
        symbol,
        kind,
        foundBy: 'model',
        n: bindings.length + 1,
      }),
    );
  }
  return { bindings, dropped };
}

/** Model step `bind:<promiseId>`: the code locations whose value or presence makes the promise true. */
export async function proposeBindings(
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  model: ModelClient,
): Promise<{ bindings: Binding[]; usage: ModelUsage; dropped: DroppedLocation[] }> {
  const result = await model.json({
    task: bindTaskKey(promise.id),
    instructions: BIND_INSTRUCTIONS,
    input: buildBindPrompt(promise, files, commit),
    schemaName: BIND_SCHEMA_NAME,
    schema: bindAnswerSchema,
    maxOutputTokens: 1500,
  });
  return { ...verifyLocations(promise, result.value, files, commit), usage: result.usage };
}
