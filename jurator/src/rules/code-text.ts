// Owner: WP-R (FX-1). What a rule reads: code, not comments. A small lexer blanks comments (same length, so columns and
// line numbers stay put) and marks dead text lines, and a tiny evaluator reads the value a constant is set to.
// Strings are kept as they are in `code`: rules often match a route path or a key inside quotes. AC-B (SC-3 fix 3): the
// `text` view, for must-not-match, also blanks docstrings and the words of messages (a string with a space), keeping
// what the string carries in ({…}, ${…}), keys ('uploading_files') and SQL.

/** Comment syntax by file extension: C-like (// and /* *\/), hash (#), or none (Markdown, JSON, unknown). */
type Syntax = 'c' | 'hash' | 'none';
const C_LIKE = /\.(?:[cm]?[jt]sx?|java|kt|kts|scala|swift|go|rs|c|h|cc|cpp|hpp|cs|php|dart|groovy|gradle)$/iu;
const HASH = /\.(?:py|pyi|sh|bash|zsh|rb|ya?ml|toml|tf|r|pl|ps1|conf|ini|cfg|env(?:\.[\w-]+)?)$|(?:^|\/)(?:Dockerfile|Makefile|\.env[\w.-]*)$/iu;

export function syntaxOf(path: string): Syntax {
  if (C_LIKE.test(path)) return 'c';
  if (HASH.test(path)) return 'hash';
  return 'none';
}

export interface CodeView {
  /** Each line with comment text replaced by spaces (strings kept). */
  readonly code: string[];
  /** `code`, but lines that hold only a string (or a docstring) are empty: text that does nothing. */
  readonly live: string[];
  /**
   * `code` with docstring lines empty and the prose inside strings blanked (same length): what a must-not-match rule
   * reads. A string with a space that is not SQL is a message; its `{…}` / `${…}` parts (the values it carries) stay.
   * A string with no space (a key, a path, a pattern) and SQL stay whole.
   */
  readonly text: string[];
}

// R4-I: a backslash is matched only as an escape (`[^\\]` in the other branch). With `(?!\1).` both branches took a
// backslash, so a line like `"\\bsms\\b|..." +` (a vendored masking.ts:448) backtracked for minutes and hung rule propose.
// R5-B: the tail is `\s*(?:;\s*)?$`, not `\s*;?\s*$`: two `\s*` around an optional `;` split a run of spaces in n ways,
// so a string followed by 20k spaces and one more character took 170 ms (quadratic; minutes on a minified line).
// Every branch here now has one way to match each character, so the scan is linear in the line length.
const STRING_ONLY = /^\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*\1\s*(?:;\s*)?)$/u;
const blank = (s: string): string => s.replace(/[^\s]/gu, ' ');

/** Where a string's text sits: line, start column, end column (exclusive), quotes not included. */
type Span = readonly [line: number, from: number, to: number];

/** Splits `text` into lines (\r?\n) and blanks comments for the file's syntax. */
export function codeView(path: string, text: string): CodeView {
  const raw = text.split(/\r?\n/u);
  const syntax = syntaxOf(path);
  if (syntax === 'none') return { code: raw, live: raw, text: raw };
  const code: string[] = [];
  const docLines = new Set<number>();
  const strings: Span[][] = [];
  let open: Span[] | null = null; // the spans of a string still open at the end of a line (template or triple)
  const piece = (n: number, from: number, to: number): void => {
    if (open && to > from) open.push([n, from, to]);
  };
  let inBlock = false; // inside /* */
  let inTemplate = false; // inside a `...` string across lines (C-like files)
  let triple: string | null = null; // inside a ''' or """ string (Python)
  let tripleStartsLine = false;
  raw.forEach((line, n) => {
    let out = '';
    let i = 0;
    if (triple && tripleStartsLine) docLines.add(n);
    // A template or triple string that runs on from the line above: its text starts at column 0.
    let from = inTemplate || triple ? 0 : -1;
    while (i < line.length) {
      const c = line[i] as string;
      const two = line.slice(i, i + 2);
      if (inBlock) {
        const end = line.indexOf('*/', i);
        const stop = end === -1 ? line.length : end + 2;
        out += blank(line.slice(i, stop));
        i = stop;
        if (end !== -1) inBlock = false;
        continue;
      }
      if (inTemplate) {
        if (c === '\\') {
          out += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === '`') {
          inTemplate = false;
          piece(n, from, i - 1);
          open = null;
          from = -1;
        }
        continue;
      }
      if (triple) {
        const end = line.indexOf(triple, i);
        const stop = end === -1 ? line.length : end + 3;
        out += line.slice(i, stop);
        i = stop;
        if (end !== -1) {
          triple = null;
          piece(n, from, end);
          open = null;
          from = -1;
          if (tripleStartsLine && line.slice(stop).trim() === '') docLines.add(n);
        }
        continue;
      }
      if (syntax === 'c' && two === '/*') {
        inBlock = true;
        out += '  ';
        i += 2;
        continue;
      }
      if ((syntax === 'c' && two === '//') || (syntax === 'hash' && c === '#')) {
        out += blank(line.slice(i));
        break;
      }
      if (syntax === 'hash' && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        triple = line.slice(i, i + 3);
        tripleStartsLine = line.slice(0, i).trim() === '';
        if (tripleStartsLine) docLines.add(n);
        out += triple;
        i += 3;
        open = [];
        strings.push(open);
        from = i;
        continue;
      }
      if (c === '`' && syntax === 'c') {
        inTemplate = true;
        out += c;
        i += 1;
        open = [];
        strings.push(open);
        from = i;
        continue;
      }
      if (c === '"' || c === "'") {
        // A one-line string: copy it whole so a // or # inside it is not a comment.
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        out += line.slice(i, Math.min(j + 1, line.length));
        strings.push([[n, i + 1, Math.min(j, line.length)]]);
        i = j + 1;
        continue;
      }
      out += c;
      i += 1;
    }
    // A template or triple string still open at the end of the line: the rest of the line is its text.
    if (from >= 0) piece(n, from, line.length);
    code.push(out);
  });
  const live = code.map((l, n) => (docLines.has(n) || STRING_ONLY.test(l) ? '' : l));
  return { code, live, text: textView(code, raw, strings, docLines) };
}

/** A string that is a query, not a message: its words are code (`SELECT … FROM`, `INSERT INTO`, `UPDATE t SET`). */
const SQL =
  /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+(?:OR\s+\w+\s+)?INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|(?:CREATE|ALTER|DROP)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|SCHEMA|DATABASE|TRIGGER)\b|TRUNCATE\b|UPSERT\b|MERGE\s+INTO\b|WITH\s+(?:RECURSIVE\s+)?\w+\s+AS\s*\()/iu;

/**
 * Which characters of a string's text stay in the `text` view: the `{…}` and `${…}` parts (balanced braces), so a
 * message that carries a value (`f"stored {clipboard}"`, `\`token ${token}\``) still shows it.
 */
function keptInside(content: string): boolean[] {
  const keep = new Array<boolean>(content.length).fill(false);
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < content.length; j += 1) {
      if (content[j] === '{') depth += 1;
      else if (content[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue; // an unbalanced { is just a character of the message
    const start = i > 0 && content[i - 1] === '$' ? i - 1 : i;
    for (let k = start; k <= end; k += 1) keep[k] = true;
    i = end;
  }
  return keep;
}

function textView(code: readonly string[], raw: readonly string[], strings: readonly Span[][], docLines: ReadonlySet<number>): string[] {
  // Only lines with a message in them are split into characters (most lines have none).
  const rows = new Map<number, string[]>();
  for (const spans of strings) {
    if (spans.every(([n]) => docLines.has(n))) continue;
    const content = spans.map(([n, a, b]) => (raw[n] ?? '').slice(a, b)).join('\n');
    // A key, a path, a pattern or a name (no space), or a query: the rule may be about exactly that text.
    if (!/\s/u.test(content) || SQL.test(content)) continue;
    const keep = keptInside(content);
    let at = 0;
    for (const [n, a, b] of spans) {
      let row = rows.get(n);
      if (!row) {
        row = (code[n] ?? '').split('');
        rows.set(n, row);
      }
      for (let col = a; col < b; col += 1) {
        const ch = row[col];
        if (!keep[at + col - a] && ch !== undefined && ch !== ' ' && ch !== '\t') row[col] = ' ';
      }
      at += b - a + 1;
    }
  }
  return code.map((line, n) => (docLines.has(n) ? '' : (rows.get(n)?.join('') ?? line)));
}

/* ------------------------------ the value a constant is set to ------------------------------ */

export type ValueRead =
  | { readonly kind: 'number'; readonly value: number; readonly text: string }
  | { readonly kind: 'expression'; readonly text: string };

/** The longest part of a line valueAssigned reads (the same cap as rule scans, src/rules/regex.ts MAX_LINE_LENGTH). */
const MAX_VALUE_LINE = 2000;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Where `name` is assigned on `line` (`NAME = …`, `NAME: type = …`, `"NAME": …`, `NAME: …`, `#define NAME …`), the
 * value it gets: a number when the right-hand side is a literal or plain arithmetic on literals, else the expression
 * text. Null when the line does not assign `name`. `line` should already have its comments blanked.
 */
export function valueAssigned(line0: string, name: string): ValueRead | null {
  // R5-B: like rule scans, read at most the first MAX_VALUE_LINE characters of a line (minified files, data blobs).
  const line = line0.length > MAX_VALUE_LINE ? line0.slice(0, MAX_VALUE_LINE) : line0;
  const n = escapeRe(name);
  const forms = [
    // R5-B: the type's class takes whitespace itself (no `\s*` after it), so a long line of spaces is linear, not n².
    new RegExp(`(?<![\\w$.])["']?${n}["']?\\s*:\\s*[A-Za-z_$][\\w$<>\\[\\]|.,\\s]*=(?![=>])`, 'u'),
    new RegExp(`(?<![\\w$.])["']?${n}["']?\\s*(?:=(?![=>])|:(?!:))`, 'u'),
    new RegExp(`#define\\s+${n}\\s`, 'u'),
  ];
  for (const re of forms) {
    const m = re.exec(line);
    if (!m) continue;
    const text = rightHandSide(line.slice(m.index + m[0].length));
    if (text === '') return null;
    const value = evaluate(text);
    return value === null ? { kind: 'expression', text } : { kind: 'number', value, text };
  }
  return null;
}

/** The expression up to the first , ; or closing bracket at depth 0 (or the end of the line). */
function rightHandSide(rest: string): string {
  let depth = 0;
  let quote: string | null = null;
  let end = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i] as string;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) {
      end = i;
      break;
    }
  }
  return rest
    .slice(0, end)
    .trim()
    .replace(/\s+as\s+const$/u, '')
    .trim();
}

/** + - * / and parentheses over number literals (1_000 and 1.5 allowed); null for anything else. */
export function evaluate(text: string): number | null {
  const tokens = text.match(/\d[\d_]*(?:\.\d+)?|[-+*/()]|\S+/gu) ?? [];
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const num = (t: string | undefined): number | null => (t !== undefined && /^\d[\d_]*(?:\.\d+)?$/u.test(t) ? Number(t.replace(/_/gu, '')) : null);
  const factor = (): number | null => {
    const t = peek();
    if (t === '(') {
      i += 1;
      const v = sum();
      if (peek() !== ')') return null;
      i += 1;
      return v;
    }
    if (t === '-' || t === '+') {
      i += 1;
      const v = factor();
      return v === null ? null : t === '-' ? -v : v;
    }
    const v = num(t);
    if (v === null) return null;
    i += 1;
    return v;
  };
  const product = (): number | null => {
    let v = factor();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = peek();
      i += 1;
      const r = factor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = peek();
      i += 1;
      const r = product();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  if (tokens.length === 0) return null;
  const v = sum();
  return v !== null && i === tokens.length && Number.isFinite(v) ? v : null;
}

/* ------------------------------ units ------------------------------ */

const SECONDS: Record<string, number> = {
  ms: 0.001, msec: 0.001, millis: 0.001, millisecond: 0.001, milliseconds: 0.001,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86_400, day: 86_400, days: 86_400,
  w: 604_800, wk: 604_800, week: 604_800, weeks: 604_800,
  y: 31_536_000, yr: 31_536_000, year: 31_536_000, years: 31_536_000,
};
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w !== '');
/** The unit word a name ends with (`CHAT_TTL_DAYS` -> days), in seconds; null when none. */
function statedUnit(words: readonly string[]): number | null {
  const last = words[words.length - 1];
  return last !== undefined && words.length > 1 ? (SECONDS[last] ?? null) : null;
}
/** Names of a duration that Redis, caches, cookies and tokens count in seconds (`EXTRACTION_RESULT_CACHE_TTL`). */
const SECONDS_BY_DEFAULT = /(?:^|_)(?:ttl|expire|expires|expiry|expiration|max_age|maxage)(?:_|$)/u;
/** Last words that make such a name a point in time, not a duration (`expires_at`, `expiry_date`). */
const POINT_IN_TIME = new Set(['at', 'on', 'time', 'date', 'datetime', 'timestamp', 'ts']);
/**
 * AC-B (SC-3 fix 6): a ttl, expire or max_age whose name states no unit is read as seconds (`ttl=172800`,
 * `EXTRACTION_RESULT_CACHE_TTL = 1209600`), so it is compared with "24 hours" as 86400, not as 24.
 */
export function readsAsSeconds(name: string): boolean {
  const words = wordsOf(name);
  const last = words[words.length - 1];
  if (last === undefined || statedUnit(words) !== null || POINT_IN_TIME.has(last)) return false;
  return SECONDS_BY_DEFAULT.test(words.join('_'));
}
/** What the evidence says when a value was read as seconds because its name has no unit. */
export const SECONDS_NOTE = 'read as seconds: the name has no unit';
/**
 * The time unit of a name, in seconds: the unit it ends with (`CHAT_TTL_DAYS`, `ttlMs`, `retention_hours`), or 1 for
 * a ttl/expire/max_age with no unit (readsAsSeconds); null when none.
 */
export function nameUnit(name: string): number | null {
  const stated = statedUnit(wordsOf(name));
  if (stated !== null) return stated;
  return readsAsSeconds(name) ? 1 : null;
}
/** The note for a value of `name` compared in `unit`: SECONDS_NOTE when the program assumed seconds, else null. */
export function unitNote(name: string, unit: string | null | undefined): string | null {
  const to = unitSeconds(unit);
  return to !== null && to !== 1 && readsAsSeconds(name) ? SECONDS_NOTE : null;
}
/** `days` -> 86400; null for a unit that is not a time unit. */
export function unitSeconds(unit: string | null | undefined): number | null {
  return unit ? (SECONDS[unit.trim().toLowerCase()] ?? null) : null;
}
/** `value` of a constant called `name`, in the constraint's unit when both units are known time units. */
export function inUnit(value: number, name: string, unit: string | null | undefined): number {
  const from = nameUnit(name);
  const to = unitSeconds(unit);
  return from !== null && to !== null && from !== to ? (value * from) / to : value;
}

export interface ValueConstraint {
  readonly op: '<=' | '>=' | '==';
  readonly value: number;
  readonly unit: string | null;
}
export const keeps = (c: ValueConstraint, v: number): boolean =>
  c.op === '<=' ? v <= c.value : c.op === '>=' ? v >= c.value : Math.abs(v - c.value) < 1e-9;
export const describeLimit = (c: ValueConstraint): string =>
  `${c.op === '<=' ? 'at most' : c.op === '>=' ? 'at least' : 'exactly'} ${c.value}${c.unit ? ` ${c.unit}` : ''}`;
export const describeOp = (c: ValueConstraint): string => `${c.op} ${c.value}${c.unit ? ` ${c.unit}` : ''}`;
const show = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

/**
 * Judges one assigned value against a constraint: null when it keeps it, else the plain reason it does not
 * ("CHAT_TTL_DAYS is 90 (30 * 3); the policy allows at most 30 days" or "... is not a literal; cannot prove <= 30").
 */
export function valueProblem(name: string, read: ValueRead, c: ValueConstraint): string | null {
  if (read.kind === 'expression') return `the value of ${name} (${read.text}) is not a literal; cannot prove ${describeOp(c)}`;
  const v = inUnit(read.value, name, c.unit);
  if (keeps(c, v)) return null;
  const literal = /^\d[\d_]*(?:\.\d+)?$/u.test(read.text) ? '' : ` (${read.text})`;
  const note = unitNote(name, c.unit);
  const converted = v !== read.value ? `, which is ${show(v)} ${c.unit}${note ? ` (${note})` : ''}` : '';
  return `${name} is ${show(read.value)}${literal}${converted}; the policy allows ${describeLimit(c)}`;
}
