// Owner: WP-R. Repo-aware proof for must-not-match rules: the model's example of a bad line must call something this
// repo really uses (acme logs with `log(`, not `console.log(`), else the rule only catches code nobody here writes.
import type { SourceFile } from '../contracts.js';
import { splitLines } from './engine.js';

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void', 'delete', 'await', 'async', 'yield',
  'super', 'import', 'new', 'in', 'of', 'do', 'else', 'try', 'throw', 'case',
]);
const STRINGS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;
const CALL = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\??\.\s*)*[A-Za-z_$][\w$]*)\s*\(/gu;

/** `this.logger.info` -> `logger.info`; `log` -> `log`. Calls are compared on their last two parts. */
function callKey(name: string): string {
  const parts = name.replace(/\s|\?/gu, '').split('.');
  return parts.slice(-2).join('.');
}
const lastPart = (key: string): string => key.split('.').pop() ?? key;

/** Every call in one line of code (strings and line comments removed first), left to right. */
export function callsIn(line: string): string[] {
  const code = line.replace(STRINGS, "''").replace(/\/\/.*$/u, '');
  const out: string[] = [];
  for (const m of code.matchAll(CALL)) {
    const key = callKey(m[1] as string);
    if (!KEYWORDS.has(key)) out.push(key);
  }
  return out;
}

interface Seen {
  readonly key: string;
  readonly where: string;
}

/** First place each call appears in the files, in path order. */
function callsInFiles(files: readonly SourceFile[]): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  const byPath = [...new Map(files.map((f) => [f.path, f])).values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of byPath) {
    splitLines(f.text).forEach((line, i) => {
      for (const key of callsIn(line)) if (!seen.has(key)) seen.set(key, { key, where: `${f.path}:${i + 1}` });
    });
  }
  return seen;
}

/**
 * Why the violation example is not repo-aware, or null when it is. The example's first (outermost) call must appear
 * as a call somewhere in `files` (the rule's files and the code shown to the model). An example with no call passes.
 */
export function exampleCallProblem(example: string | null | undefined, files: readonly SourceFile[]): string | null {
  const first = example ? callsIn(example)[0] : undefined;
  if (!first) return null;
  const seen = callsInFiles(files);
  if (seen.has(first)) return null;
  const last = lastPart(first).toLowerCase();
  const similar = [...seen.values()]
    .filter((s) => {
      const l = lastPart(s.key).toLowerCase();
      return l === last || (last.length >= 3 && (l.includes(last) || last.includes(l)) && l.length >= 3);
    })
    .slice(0, 3)
    .map((s) => `${s.key}( (${s.where})`);
  const hint = similar.length > 0 ? `; this code uses ${similar.join(', ')}` : '';
  return (
    `the violationExample calls ${first}(, which no file in this repo calls, so the rule would only catch code nobody ` +
    `here writes${hint}. Write the example and the pattern with the calls this code uses`
  );
}
