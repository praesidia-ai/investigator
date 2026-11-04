// Owner: WP-B. Small, deterministic readers of one code line: which name it is about and what kind of place it is.
import type { Binding, PromiseRecord } from '../contracts.js';

export type BindingKind = Binding['kind'];

const IDENT = /[A-Za-z_$][\w$]*/u;
const KEYWORDS = new Set(['null', 'true', 'false', 'undefined', 'return', 'const', 'let', 'var', 'export', 'await', 'async', 'function', 'new', 'this']);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A whole-word matcher for an identifier (`$` and `_` count as word characters). */
export function wordRe(name: string, flags = 'u'): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, flags);
}
export const hasWord = (line: string, name: string): boolean => wordRe(name).test(line);

/** `export const CHAT_TTL_DAYS = 30` -> CHAT_TTL_DAYS (also let/var/readonly/static/def and `#define`). */
export function declaredName(line: string): string | null {
  const m =
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|readonly|static|final|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/u.exec(line) ??
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)/u.exec(line) ??
    /^\s*#define\s+([A-Za-z_$][\w$]*)\s/u.exec(line);
  return m?.[1] ?? null;
}
/** `"dataRetentionDays": 90`, `type: 'argon2id'`, `ttl_days = 30` (YAML/TOML/env) -> the key. */
export function keyName(line: string): string | null {
  const m = /^\s*["']?([A-Za-z_$][\w$.-]*)["']?\s*:(?!:)/u.exec(line) ?? /(?:^|[{,]\s*)["']?([A-Za-z_$][\w$]*)["']?\s*:(?!:)/u.exec(line);
  return m?.[1] ?? null;
}
/** The first function called on the line, e.g. `requireAdmin(req)` -> requireAdmin; `a.b.c(` -> c. */
export function calledName(line: string): string | null {
  for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = m[1] as string;
    if (!/^(?:if|for|while|switch|return|function|catch|typeof|await|async|new)$/u.test(name)) return name;
  }
  return null;
}

/**
 * Identifier-like runs a regex pattern spells out literally (outside escapes and character classes), in pattern order,
 * e.g. `CHAT_TTL_DAYS\s*=\s*30` -> [CHAT_TTL_DAYS]; `approvalGate\(\s*['"]export_notes` -> [approvalGate, export_notes].
 */
export function patternNames(pattern: string): string[] {
  const cleaned = pattern
    .replace(/\\[pPu]\{[^}]*\}/gu, ' ')
    .replace(/\\./gu, ' ')
    .replace(/\[(?:\\.|[^\]\\])*\]/gu, ' ')
    .replace(/\{\d+(?:,\d*)?\}/gu, ' ')
    .replace(/\(\?(?:[:=!]|<[=!]|<[A-Za-z]\w*>)/gu, ' ');
  const names = new Set<string>();
  for (const m of cleaned.matchAll(new RegExp(IDENT.source, 'gu'))) {
    const n = m[0];
    if (n.length >= 3 && /[A-Za-z]/u.test(n) && !KEYWORDS.has(n)) names.add(n);
  }
  return [...names];
}

const GUARD_WORDS = /(?:require|assert|ensure|guard|gate|authori[sz]e|approv|permit|forbid|deny|check(?:Role|Admin|Access|Permission)|can[A-Z]|is[A-Z]\w*(?:Admin|Allowed|Authorized))/u;
const ALLOW_WORDS = /(?:allow|permit|whitelist|safelist|blocklist|denylist|allowed|tools|scopes|roles)/iu;
const CONFIG_FILE = /\.(?:json|ya?ml|toml|ini|env(?:\.[\w-]+)?|properties|conf|cfg)$/iu;
const LITERAL_VALUE = /=\s*(?:-?\d[\d_.]*|true|false|null|['"`][^'"`]*['"`]|\[|\{)/u;

/** Picks the name a binding is about: a declaration, then a name the rule spells out, then a key, then a call. */
export function symbolFor(line: string, preferred: readonly string[] = []): string | null {
  const declared = declaredName(line);
  if (declared && (preferred.length === 0 || preferred.includes(declared))) return declared;
  for (const name of preferred) if (hasWord(line, name)) return name;
  return declared ?? keyName(line) ?? calledName(line);
}

/** The kind of place a line is, given its name: guard call, constant, config key, allowlist or a plain call. */
export function kindFor(path: string, line: string, symbol: string | null): BindingKind {
  if (CONFIG_FILE.test(path)) return ALLOW_WORDS.test(symbol ?? '') || /\[/u.test(line) ? 'allowlist' : 'config';
  if (symbol) {
    const called = new RegExp(`${wordRe(symbol).source}\\s*\\(`, 'u').test(line);
    if (called) return GUARD_WORDS.test(symbol) ? 'guard' : 'call';
    if (declaredName(line) === symbol) {
      if (ALLOW_WORDS.test(symbol) && /[[{]|new Set/u.test(line)) return 'allowlist';
      return LITERAL_VALUE.test(line) ? 'constant' : 'other';
    }
    if (keyName(line) === symbol) return ALLOW_WORDS.test(symbol) && /\[/u.test(line) ? 'allowlist' : 'config';
  }
  return 'other';
}

/** Value bindings (constant, config, allowlist) carry what the policy expects, from the promise's typed facets. */
export function expectedFor(promise: Pick<PromiseRecord, 'facets'>, kind: BindingKind): Binding['expected'] {
  const c = promise.facets?.constraint;
  // Only a constraint with a value (<= 30 days, == argon2) says what the bound value should be; "always" alone does not.
  if (!c || c.value === null || (kind !== 'constant' && kind !== 'config' && kind !== 'allowlist')) return null;
  return { op: c.op, value: c.value, unit: c.unit };
}

/** "<= 30 days", "== admin", "never". */
export function describeExpected(e: NonNullable<Binding['expected']>): string {
  return [e.op, e.value ?? '', e.unit ?? ''].filter((s) => s !== '').join(' ');
}

/** A short excerpt of a binding for messages: from its symbol to the end of that line, e.g. `CHAT_TTL_DAYS = 30`. */
export function excerpt(binding: Pick<Binding, 'quote' | 'symbol'>, max = 60): string {
  const lines = binding.quote.split('\n');
  const line = (binding.symbol ? lines.find((l) => hasWord(l, binding.symbol as string)) : undefined) ?? lines[0] ?? '';
  let text = line.trim();
  if (binding.symbol) {
    const at = text.search(wordRe(binding.symbol));
    if (at > 0) text = text.slice(at);
  }
  text = text.replace(/[;,{]\s*$/u, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
