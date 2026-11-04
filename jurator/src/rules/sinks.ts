// AC-A (SC-3 fix 2): where the code writes, logs, sends, deletes and sets a lifetime, found by the program. The live run
// showed the model never saw the line that decides a promise (the upload at orchestrator.py:650, storage.ts:90): files
// were ranked by the promise's words and cut at 30k characters. This list, from the whole promise scope, goes before the
// files, and each long file is shown as a window around its first such line. No AI here; everything is deterministic.
import type { PromiseRecord, SourceFile } from '../contracts.js';
import { codeView } from './code-text.js';
import { splitLines } from './engine.js';
import { isTestPath, promiseWords } from './select.js';
import { numericConstraint } from './values.js';

/** At most this many program-found lines before the files, plus this many definitions they use. */
export const MAX_SINK_LINES = 80;
export const MAX_SINK_DEFINITIONS = 15;
/** A file longer than this is shown as a window of this many characters around its first sink line. */
export const MAX_FILE_WINDOW_CHARS = 6_000;
const MAX_QUOTE = 160;
const MAX_SCAN_LINE = 400;

export type SinkKind = 'write' | 'log' | 'send' | 'delete' | 'lifetime';

interface SinkSpec {
  readonly kind: SinkKind;
  readonly label: string;
  readonly re: RegExp;
  /** Promise words that make this kind relevant (it is listed first, with a larger share). */
  readonly about: RegExp;
}

const SINKS: readonly SinkSpec[] = [
  {
    kind: 'write',
    label: 'stores or writes',
    re: /\.(?:set|setex|setItem|put|put_object|upload\w*|insert\w*|write\w*|save\w*)\s*\(/u,
    about: /stor|writ|sav|cach|upload|persist|memory|disk|local|bucket|database|session|clipboard|keep|retain/iu,
  },
  {
    kind: 'log',
    label: 'logs',
    re: /\b(?:console|logger|logging|log|_logger|LOGGER|LOG)\.(?:debug|info|warn|warning|error|exception|critical|log|trace)\s*\(|(?<![\w$.])(?:log|print)\s*\(/u,
    about: /\blog|record|print|trace|telemetr|analytic/iu,
  },
  {
    kind: 'send',
    label: 'sends (AI or network calls)',
    re: /(?<![\w$.])fetch\s*\(|\baxios(?:\.\w+)?\s*\(|\brequests\.(?:get|post|put|patch|delete|request)\s*\(|\bhttpx\.\w+\s*\(|\.(?:messages|completions|responses)\.create\s*\(|\bgenerate_content\s*\(|\burlopen\s*\(|\.sendMessage\s*\(|\bnew\s+(?:Anthropic|OpenAI|WebSocket|XMLHttpRequest)\b/u,
    about: /send|share|third|vendor|provider|\bai\b|model|anthropic|openai|claude|network|server|upload|transmit|leave|external|advertis|sell/iu,
  },
  {
    kind: 'delete',
    label: 'deletes or clears',
    re: /\.(?:delete(?:_\w+|Many|One|Item|Database)?|remove(?:Item|_\w*file\w*|_object\w*)?|unlink|rmtree|clear|destroy|expire|evict|flushall|flushdb|delete_objects?)\s*\(|\bDELETE\s+FROM\b|\bdeleteDatabase\s*\(/u,
    about: /delet|remov|eras|purg|clear|retain|retention|expir|ttl|days|hours|lifetime|memory/iu,
  },
  {
    kind: 'lifetime',
    label: 'sets a lifetime (ttl, expiry, retention)',
    re: /\b\w*(?:ttl|expir\w*|retention|max_?age)\w*['"]?\s*(?::|=(?!=))/iu,
    about: /delet|retain|retention|expir|ttl|days|hours|lifetime|keep|cach/iu,
  },
];

export interface SinkLine {
  readonly kind: SinkKind;
  readonly path: string;
  readonly line: number;
  readonly quote: string;
}

const capQuote = (s: string): string => {
  const t = s.trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
};

/** The sink kinds this promise is about (its words, action and number). */
export function relevantSinks(promise: Pick<PromiseRecord, 'wording'> & { facets?: PromiseRecord['facets'] }): SinkKind[] {
  const text = [promise.wording, promise.facets?.subject ?? '', promise.facets?.action ?? '', numericConstraint(promise) ? 'retention lifetime' : ''].join(' ');
  return SINKS.filter((s) => s.about.test(text)).map((s) => s.kind);
}

/** The sink kinds in the order they matter to this promise: the relevant ones first. */
export function sinkOrder(promise: Pick<PromiseRecord, 'wording'> & { facets?: PromiseRecord['facets'] }): SinkKind[] {
  const relevant = relevantSinks(promise);
  return [...relevant, ...SINKS.map((s) => s.kind).filter((k) => !relevant.includes(k))];
}

/** Each file's lines and live view, kept while the file object lives (one propose run shows the same files to every promise). */
const views = new WeakMap<SourceFile, { raw: string[]; live: string[]; sinks: SinkLine[] | null }>();
function viewOf(f: SourceFile): { raw: string[]; live: string[]; sinks: SinkLine[] | null } {
  let v = views.get(f);
  if (!v) {
    v = { raw: splitLines(f.text), live: codeView(f.path, f.text).live, sinks: null };
    views.set(f, v);
  }
  return v;
}

/** Every sink line of `files` (live code: comments and lone strings left out), in file order. */
export function findSinks(files: readonly SourceFile[]): SinkLine[] {
  const out: SinkLine[] = [];
  for (const f of files) {
    const v = viewOf(f);
    if (!v.sinks) {
      const found: SinkLine[] = [];
      v.live.forEach((line, i) => {
        if (line.trim() === '' || line.length > MAX_SCAN_LINE) return;
        const spec = SINKS.find((s) => s.re.test(line));
        if (spec) found.push({ kind: spec.kind, path: f.path, line: i + 1, quote: capQuote(v.raw[i] ?? line) });
      });
      v.sinks = found;
    }
    out.push(...v.sinks);
  }
  return out;
}

/** The receiver a sink calls through (`storage.setItem(` -> storage, `self.cache.set(` -> cache), if one. */
function receiverOf(quote: string): string | null {
  const m = /([A-Za-z_$][\w$]*)\s*\??\.\s*[A-Za-z_$][\w$]*\s*\(/u.exec(quote);
  const name = m?.[1];
  if (!name || COMMON.has(name) || name.length < 3) return null;
  return name;
}
const COMMON = new Set([
  'this', 'self', 'cls', 'console', 'logger', 'logging', 'log', 'window', 'document', 'globalThis', 'Object', 'Array', 'JSON',
  'Math', 'Promise', 'os', 'sys', 'json', 'requests', 'httpx', 'axios', 'super', 'res', 'req', 'app', 'router', 'path',
]);
const escapeName = (name: string): string => name.replace(/\$/gu, '\\$');

/** Where each receiver is defined (const/let/var/class/function/def, or a plain assignment), first one per name. */
export function definitionsOf(names: readonly string[], files: readonly SourceFile[], skip: ReadonlySet<string>): SinkLine[] {
  const out: SinkLine[] = [];
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return out;
  const res = wanted.map((name) => ({
    name,
    // Module-level const/let/var or assignment, a class or function anywhere, or a self./this. attribute.
    re: new RegExp(
      `^(?:export\\s+)?(?:default\\s+)?(?:const|let|var)\\s+${escapeName(name)}\\b|` +
        `^\\s*(?:export\\s+)?(?:default\\s+)?(?:class|function|def|async\\s+def|async\\s+function)\\s+${escapeName(name)}\\b|` +
        `^\\s*(?:self|this)\\.${escapeName(name)}\\s*(?::[^=]+)?=(?!=)|^${escapeName(name)}\\s*(?::[^=]+)?=(?!=)`,
      'u',
    ),
  }));
  const found = new Set<string>();
  for (const f of files) {
    const { raw, live } = viewOf(f);
    live.forEach((line, i) => {
      if (line.length > MAX_SCAN_LINE || skip.has(`${f.path}:${i + 1}`)) return;
      for (const { name, re } of res) {
        if (found.has(name) || !re.test(line)) continue;
        found.add(name);
        out.push({ kind: 'write', path: f.path, line: i + 1, quote: capQuote(raw[i] ?? line) });
      }
    });
    if (found.size === wanted.length) break;
  }
  return out;
}

export interface SinkSection {
  /** The prompt lines (empty when the scope has no sink line). */
  readonly lines: string[];
  /** The first sink line of each file, most relevant kind first (for the file windows). */
  readonly firstHit: ReadonlyMap<string, number>;
}

/**
 * The program-found list before the files: up to 80 sink lines from the promise's scope (files already in prompt
 * order), the kinds this promise is about first, then the definitions those lines call through.
 */
export function sinkSection(
  promise: Pick<PromiseRecord, 'wording' | 'scope'> & { facets?: PromiseRecord['facets'] },
  files: readonly SourceFile[],
): SinkSection {
  const scoped = files.filter((f) => !isTestPath(f.path));
  const all = findSinks(scoped);
  const order = sinkOrder(promise);
  const rank = (k: SinkKind): number => order.indexOf(k);
  const relevant = new Set(relevantSinks(promise));
  const firstHit = new Map<string, { line: number; rank: number }>();
  for (const s of all) {
    const cur = firstHit.get(s.path);
    if (!cur || rank(s.kind) < cur.rank) firstHit.set(s.path, { line: s.line, rank: rank(s.kind) });
  }
  // Other kinds get 6 lines each, the relevant ones share the rest; what a kind leaves unused goes to the next. Within a
  // kind, lines that name the promise's words or a real store come first, and files take turns so one never fills it.
  const words = promiseWords(promise);
  const score = (s: SinkLine): number => {
    const q = s.quote.toLowerCase();
    return (words.some((w) => q.includes(w) || s.path.toLowerCase().includes(w)) ? 2 : 0) + (STORE_WORDS.test(s.quote) ? 1 : 0);
  };
  const others = order.length - relevant.size;
  const share = relevant.size > 0 ? Math.floor((MAX_SINK_LINES - 6 * others) / relevant.size) : 0;
  const picked: SinkLine[] = [];
  const ranked = new Map<SinkKind, SinkLine[][]>();
  for (const kind of order) {
    const byFile = new Map<string, SinkLine[]>();
    for (const s of all) if (s.kind === kind) byFile.set(s.path, [...(byFile.get(s.path) ?? []), s]);
    const lists = [...byFile.values()].map((l) => [...l].sort((a, b) => score(b) - score(a) || a.line - b.line));
    ranked.set(kind, lists.sort((a, b) => score(b[0]!) - score(a[0]!)));
  }
  const take = (kind: SinkKind, cap: number): void => {
    const lists = ranked.get(kind) ?? [];
    let n = 0;
    for (let i = 0; n < cap && picked.length < MAX_SINK_LINES && lists.some((l) => i < l.length); i += 1) {
      for (const l of lists) {
        if (i >= l.length || n >= cap || picked.length >= MAX_SINK_LINES) continue;
        if (picked.includes(l[i]!)) continue;
        picked.push(l[i]!);
        n += 1;
      }
    }
  };
  for (const kind of order) take(kind, relevant.has(kind) ? share : 6);
  for (const kind of order) if (picked.length < MAX_SINK_LINES) take(kind, MAX_SINK_LINES);
  const lines: string[] = [];
  if (picked.length === 0) return { lines, firstHit: new Map([...firstHit].map(([p, v]) => [p, v.line])) };
  const inOrder = [...picked].sort((a, b) => rank(a.kind) - rank(b.kind));
  lines.push(
    `Where this code ${order.map((k) => SINKS.find((s) => s.kind === k)!.label).join(', ')} (${plural(inOrder.length, 'line')} found by the program in the promise's code; path:line, then the code):`,
  );
  let kind: SinkKind | null = null;
  for (const s of inOrder) {
    if (s.kind !== kind) {
      kind = s.kind;
      lines.push(`- ${SINKS.find((x) => x.kind === kind)!.label}:`);
    }
    lines.push(`  ${s.path}:${s.line}  ${s.quote}`);
  }
  const skip = new Set(picked.map((s) => `${s.path}:${s.line}`));
  // Receivers most sink lines call through first (storage.set( in ten files -> storage's definition).
  const counts = new Map<string, number>();
  for (const s of picked) {
    const r = receiverOf(s.quote);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const receivers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, MAX_SINK_DEFINITIONS * 2);
  const defs = definitionsOf(receivers, scoped, skip).slice(0, MAX_SINK_DEFINITIONS);
  if (defs.length > 0) {
    lines.push('- definitions those lines call through:');
    for (const d of defs) lines.push(`  ${d.path}:${d.line}  ${d.quote}`);
  }
  return { lines, firstHit: new Map([...firstHit].map(([p, v]) => [p, v.line])) };
}

/** A line that touches a real store (not an in-memory buffer). */
const STORE_WORDS = /redis|s3|storage|bucket|cache|upload|put_object|setex|localStorage|sessionStorage|indexedDB|chrome\.storage|\bdb\b|session|blob|disk|file/iu;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * A numbered file block for the prompt: the whole file, or, when longer than `maxChars`, a window of about that size
 * starting a little before `firstHit` (line numbers stay the file's own).
 */
export function fileBlock(file: SourceFile, firstHit: number | undefined, maxChars = MAX_FILE_WINDOW_CHARS): string {
  const lines = splitLines(file.text);
  const numbered = lines.map((line, i) => `${i + 1}| ${line}`);
  const whole = [`=== ${file.path}`, ...numbered].join('\n');
  if (whole.length <= maxChars) return whole;
  let start = Math.max(0, (firstHit ?? 1) - 1 - 20);
  let used = 0;
  let end = start;
  while (end < numbered.length && used + (numbered[end] as string).length + 1 <= maxChars) {
    used += (numbered[end] as string).length + 1;
    end += 1;
  }
  // Near the end of the file: use the rest of the window before the hit.
  while (start > 0 && used + (numbered[start - 1] as string).length + 1 <= maxChars) {
    start -= 1;
    used += (numbered[start] as string).length + 1;
  }
  if (end === start) end = Math.min(numbered.length, start + 1);
  const out = [`=== ${file.path}`];
  if (start > 0) out.push(`... (lines 1-${start} not shown)`);
  out.push(...numbered.slice(start, end).map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l)));
  if (end < numbered.length) out.push(`... (lines ${end + 1}-${numbered.length} not shown)`);
  return out.join('\n');
}
