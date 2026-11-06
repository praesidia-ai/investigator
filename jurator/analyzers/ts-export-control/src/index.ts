// Jurator semantic analyzer 'ts-export-control' (control 'guard-before-effect').
// On every modeled path of an Express route (middleware chain, handler, same-file and imported helpers within the
// supplied files), a recognized guard call must run before a protected effect, bound to the same request-derived
// tenant/resource. The analyzer parses supplied text with the TypeScript 5.9.3 compiler API (no program, no disk, no
// execution). Anything it cannot model becomes a coverage gap; it never passes by default.
//
// Known limits (documented, not hidden): a guard counts only as a bare statement (`await guard(req)`), a middleware,
// or the condition of an `if`/`&&`/`||`/ternary (truthy = allowed); guard results stored in a variable do not count.
// Each guard's config states how it denies: `style: 'throws'` counts in all three forms, while `style: 'boolean'` counts
// only in a condition, because a discarded boolean stops nothing. Each guard also states `async`: an async guard counts
// only directly under `await`, because an unawaited Promise stops nothing and is always truthy.
// A guard/effect is identified by one resolved (root-relative module or package, exported symbol) pair.
// Function values that escape are checked as callbacks from the state where they escape; they credit nothing.
// Writes to request paths are tracked per route, flow-insensitively, so they can only turn a match into a gap.
// A route with writes is walked twice: the first walk collects them, so a function that runs later sees writes made after its definition.
// A guard's `subjectArg` names the argument holding the request; a guard handed anything else (a forged principal) credits nothing.
import ts from 'typescript';
import { posix } from 'node:path';

export const ADAPTER_ID = 'ts-export-control';
export const ADAPTER_VERSION = '0.1.0';
export const CONTROL = 'guard-before-effect';

export interface SourceFileInput { readonly path: string; readonly text: string }
export type GuardStyle = 'throws' | 'boolean';
export interface SymbolSpec { readonly module: string; readonly symbol: string; readonly subjectArg?: number | null; readonly tenantArg?: number; readonly resourceArg?: number; readonly style?: GuardStyle; readonly async?: boolean }
export interface AnalyzerConfig {
  readonly guards: readonly SymbolSpec[];
  readonly effects: readonly SymbolSpec[];
  readonly routeRegistrars: readonly string[];
  readonly routeObjects: readonly string[];
}
export interface Finding { readonly kind: 'violation'; readonly path: string; readonly line: number; readonly detail: string; readonly route: string }
export interface Gap { readonly kind: string; readonly detail: string; readonly path: string; readonly line: number }
export interface AnalysisResult {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly typescriptVersion: string;
  readonly control: typeof CONTROL;
  readonly findings: Finding[];
  readonly gaps: Gap[];
  readonly assessedRoutes: number;
  readonly readSet: string[];
}

export const LIMITS = { files: 500, fileBytes: 1_000_000, steps: 300_000, depth: 5 } as const;

/** Validates untrusted rule config. Throws a plain Error when malformed. */
export function parseConfig(raw: unknown): AnalyzerConfig {
  const bad = (m: string): never => { throw new Error(`ts-export-control config: ${m}`); };
  if (typeof raw !== 'object' || raw === null) return bad('not an object');
  const o = raw as Record<string, unknown>;
  const specs = (k: string): SymbolSpec[] => {
    const a = o[k];
    if (!Array.isArray(a)) return bad(`${k} must be an array`);
    if (k === 'effects' && a.length === 0) return bad('effects must not be empty');
    return a.map((e: unknown) => {
      const s = e as Record<string, unknown> | null;
      if (!s || typeof s.module !== 'string' || typeof s.symbol !== 'string') return bad(`${k} entries need string module and symbol`);
      if (/^(?:\.|\/|[A-Za-z]:)/u.test(s.module)) return bad(`${k} entry ${s.symbol}: module ${s.module} must be a root-relative path or a package name`);
      for (const f of ['tenantArg', 'resourceArg']) if (s[f] !== undefined && !(Number.isInteger(s[f]) && (s[f] as number) >= 0)) return bad(`${k}.${f} must be a non-negative integer`);
      if (k === 'guards' && s.style !== 'throws' && s.style !== 'boolean') return bad(`guards entry ${s.symbol} needs style 'throws' or 'boolean'`);
      if (k === 'guards' && typeof s.async !== 'boolean') return bad(`guards entry ${s.symbol} needs boolean async`);
      if (k === 'guards' && s.subjectArg !== null && !(Number.isInteger(s.subjectArg) && (s.subjectArg as number) >= 0)) return bad(`guards entry ${s.symbol} needs subjectArg: a non-negative integer, or null for a guard used only as route middleware`);
      return {
        module: s.module, symbol: s.symbol,
        ...(k === 'guards' ? { subjectArg: s.subjectArg as number | null, style: s.style as GuardStyle, async: s.async as boolean } : {}),
        ...(s.tenantArg !== undefined ? { tenantArg: s.tenantArg as number } : {}),
        ...(s.resourceArg !== undefined ? { resourceArg: s.resourceArg as number } : {}),
      };
    });
  };
  const strs = (k: string): string[] => {
    const a = o[k];
    return Array.isArray(a) && a.every((x) => typeof x === 'string') ? (a as string[]) : bad(`${k} must be an array of strings`);
  };
  return { guards: specs('guards'), effects: specs('effects'), routeRegistrars: strs('routeRegistrars'), routeObjects: strs('routeObjects') };
}

/* ------------------------------------------------------------------ model ------------------------------------------------------------------ */

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
interface Scope {
  readonly id: string;
  readonly parent: Scope | null;
  readonly file: FileInfo;
  readonly names: Set<string>;
  readonly fns: Map<string, FnLike>;
  readonly aliases: Map<string, ts.Expression>;
}
interface ImportInfo { readonly spec: string; readonly name: string }
interface Reexport { readonly spec: string; readonly names: Map<string, string> | null }
interface FileInfo {
  readonly path: string;
  readonly sf: ts.SourceFile;
  readonly imports: Map<string, ImportInfo>;
  readonly exports: Map<string, string>;
  readonly reexports: Reexport[];
  readonly root: Scope;
}
interface Guard { readonly name: string; readonly tenant: string | undefined; readonly resource: string | undefined }
interface State { guards: Map<string, Guard>; env: Map<string, string>; dead: boolean }
interface Jump { readonly kind: 'break' | 'continue'; readonly label: string | undefined; readonly st: State }
interface Ctx { returns: State[]; jumps: Jump[]; readonly file: FileInfo }
type Callee =
  | { k: 'guard'; spec: SymbolSpec }
  | { k: 'effect'; spec: SymbolSpec }
  | { k: 'fn'; node: FnLike; scope: Scope }
  | { k: 'unresolved'; why: string; closure: boolean }
  | { k: 'ignore' };

class Budget extends Error {}

const EXT = /\.(?:d\.)?(?:tsx?|jsx?|mjs|mts|cjs|cts)$/u;
const norm = (m: string): string => posix.normalize(m).replace(/^\.\//u, '').replace(EXT, '').replace(/\/index$/u, '');
const isReq = (v: string): boolean => v === 'req' || v.startsWith('req.');
const isHttp = (v: string): boolean => isReq(v) || v === 'next' || v === 'res' || v.startsWith('res.');
// req.query, req.body and req.headers are attacker-chosen, so they never stand for the authenticated principal.
const isPrincipal = (v: string): boolean => v === 'req' || v === 'req.user' || v.startsWith('req.user.');
// These return primitives: the value cannot alias a request object or be mutated through another name.
const PRIMITIVE_CONVERTERS = new Set(['Number', 'String', 'Boolean', 'parseInt', 'parseFloat']);
const isUnk = (v: string): boolean => v.startsWith('unk#');
/** Whether a value passed to an unknown callee could hold request data: literals and request-free new objects cannot. */
const mayCarry = (v: string): boolean => !v.startsWith('lit:') && !v.startsWith('unk#alloc');

// http.METHODS lowercased plus Express's `all`, written out because that list varies with the Node version and results must not.
const HTTP_VERBS = new Set(['acl', 'all', 'bind', 'checkout', 'connect', 'copy', 'delete', 'get', 'head', 'link', 'lock', 'm-search', 'merge', 'mkactivity', 'mkcalendar', 'mkcol', 'move', 'notify', 'options', 'patch', 'post', 'propfind', 'proppatch', 'purge', 'put', 'query', 'rebind', 'report', 'search', 'source', 'subscribe', 'trace', 'unbind', 'unlink', 'unlock', 'unsubscribe']);
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'set', 'delete', 'clear']);
// Known calls that run no protected effect; only used when the name is neither declared nor imported.
const PURE_CALLS = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setImmediate', 'queueMicrotask']);
const PURE_MEMBERS = /^(?:console\.\w+|Math\.\w+|JSON\.(?:parse|stringify)|Date\.now|Object\.(?:keys|values|entries)|Array\.isArray|Number\.\w+|Promise\.(?:all|allSettled|race|resolve|reject))$/u;
const PURE_NEW = new Set(['Date', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'URL', 'Promise']);

function unwrap(e: ts.Node): ts.Node {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
}
function isAwaited(e: ts.Node): boolean {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n) || ts.isSatisfiesExpression(n)) {
    if (ts.isAwaitExpression(n)) return true;
    n = n.expression;
  }
  return false;
}
function chainRoot(e: ts.Node): ts.Node {
  let n = unwrap(e);
  while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) n = unwrap(n.expression);
  return n;
}
const hasExport = (n: ts.Node): boolean => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
const isDefault = (n: ts.Node): boolean => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Default) !== 0;
const isFn = (n: ts.Node): n is FnLike => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
const isAssignOp = (k: ts.SyntaxKind): boolean => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
const isIncDec = (n: ts.Node): n is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
  (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken);
const isConstTrue = (e: ts.Node | undefined): boolean => e === undefined || unwrap(e).kind === ts.SyntaxKind.TrueKeyword;

function addNames(p: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(p)) into.add(p.text);
  else for (const el of p.elements) if (!ts.isOmittedExpression(el)) addNames(el.name, into);
}
const cloneState = (s: State): State => ({ guards: new Map(s.guards), env: new Map(s.env), dead: s.dead });
const deadOf = (s: State): State => ({ ...cloneState(s), dead: true });
let unkCounter = 0;
const fresh = (): string => `unk#${(unkCounter += 1)}`;
const alloc = (): string => `unk#alloc${(unkCounter += 1)}`;
const caught = (): string => `unk#err${(unkCounter += 1)}`;
function merge(a: State, b: State): State {
  if (a.dead) return cloneState(b);
  if (b.dead) return cloneState(a);
  const guards = new Map<string, Guard>();
  for (const [k, g] of a.guards) if (b.guards.has(k)) guards.set(k, g);
  const env = new Map<string, string>();
  // A binding written on only one side has no single value afterwards.
  for (const k of new Set([...a.env.keys(), ...b.env.keys()])) {
    const v = a.env.get(k);
    env.set(k, v !== undefined && b.env.get(k) === v ? v : fresh());
  }
  return { guards, env, dead: false };
}
function assign(into: State, from: State): void {
  into.guards = from.guards;
  into.env = from.env;
  into.dead = from.dead;
}

/* ------------------------------------------------------------------ analyzer ------------------------------------------------------------------ */

export function analyze(inputFiles: readonly SourceFileInput[], rawConfig: unknown): AnalysisResult {
  const cfg = parseConfig(rawConfig);
  const findings: Finding[] = [];
  const gaps: Gap[] = [];
  const seen = new Set<string>();
  const files = new Map<string, FileInfo>();
  let assessed = 0;
  let steps = 0;
  let route = '';
  let downgrade = false;
  const stack: ts.Node[] = [];
  let scopeIds = 0;
  const scopeMemo = new Map<ts.Node, Scope>();
  // Value paths written during this route; a guard binding that touches one can no longer be tied to an effect.
  const tainted = new Set<string>();
  let nexts: State[] = [];
  const matchedSpecs = new Set<SymbolSpec>();
  // Every binding written so far on this route, on any branch: a write in a try or a callee may have happened on any exit.
  const writeLog: string[] = [];
  let nextMark: number | null = null;
  // Names assigned anywhere on this route. Names, because scope ids differ between walks; a same-named binding can only turn a match into a gap.
  const assignedNames = new Set<string>();
  let secondWalk = false;
  // Values of const declarations. Each write makes a new value, so two equal ones are the same unwritten binding.
  const constVals = new Set<string>();
  const clobberSince = (mark: number, st: State): void => {
    for (const key of writeLog.slice(mark)) st.env.set(key, fresh());
  };

  const newScope = (parent: Scope | null, file: FileInfo): Scope => ({ id: String((scopeIds += 1)), parent, file, names: new Set(), fns: new Map(), aliases: new Map() });
  const lineOf = (f: FileInfo, n: ts.Node): number => f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1;
  const gap = (f: FileInfo, n: ts.Node | null, kind: string, detail: string): void => {
    const line = n ? lineOf(f, n) : 1;
    const key = `${kind}|${f.path}|${line}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push({ kind, detail, path: f.path, line });
  };
  const violation = (f: FileInfo, n: ts.Node, raw: string): void => {
    // Internal value ids differ between loop passes; they must not split one finding into two.
    const detail = raw.replace(/unk#\w+/gu, 'unknown').replace(/free:[^\s,;)]*:/gu, '');
    if (downgrade) return gap(f, n, 'unverifiable-chain', `${route}: ${detail} (middleware chain has a spread, so a guard may exist)`);
    const line = lineOf(f, n);
    // The second walk's values differ, so its detail for a line the first walk reported is the same finding.
    if (secondWalk && findings.some((x) => x.path === f.path && x.line === line && x.route === route)) return;
    const key = `v|${f.path}|${line}|${route}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind: 'violation', path: f.path, line, detail, route });
  };
  const tick = (): void => {
    steps += 1;
    if (steps > LIMITS.steps) throw new Budget('step limit');
  };

  /* ---- parse ---- */
  const readOrder: string[] = [];
  const sorted = [...inputFiles].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const [i, input] of sorted.entries()) {
    const path = posix.normalize(input.path.replace(/\\/gu, '/'));
    if (i >= LIMITS.files) {
      gaps.push({ kind: 'too-many-files', detail: `more than ${LIMITS.files} files supplied; ${path} not read`, path, line: 1 });
      continue;
    }
    if (!EXT.test(path) || path.endsWith('.d.ts')) continue;
    if (input.text.length > LIMITS.fileBytes) {
      gaps.push({ kind: 'file-too-large', detail: `${path} is over ${LIMITS.fileBytes} characters; not read`, path, line: 1 });
      continue;
    }
    const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, input.text, ts.ScriptTarget.Latest, true, kind);
    const info = indexFile(path, sf);
    files.set(path, info);
    readOrder.push(path);
    const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    if (diags && diags.length > 0) gap(info, null, 'parse-error', `${path} has syntax errors; results for it may be incomplete`);
  }

  function indexFile(path: string, sf: ts.SourceFile): FileInfo {
    const imports = new Map<string, ImportInfo>();
    const exports = new Map<string, string>();
    const reexports: Reexport[] = [];
    const info: FileInfo = { path, sf, imports, exports, reexports, root: null as unknown as Scope };
    (info as { root: Scope }).root = newScope(null, info);
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const c = st.importClause;
        if (!c) continue;
        if (c.name) imports.set(c.name.text, { spec, name: 'default' });
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { spec, name: '*' });
        else if (c.namedBindings) for (const el of c.namedBindings.elements) imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      } else if (ts.isExportDeclaration(st)) {
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        if (spec === null) {
          if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) exports.set(el.name.text, (el.propertyName ?? el.name).text);
        } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          reexports.push({ spec, names: new Map(st.exportClause.elements.map((el) => [el.name.text, (el.propertyName ?? el.name).text])) });
        } else reexports.push({ spec, names: null });
      } else if (ts.isExportAssignment(st)) {
        const e = unwrap(st.expression);
        if (ts.isIdentifier(e)) exports.set('default', e.text);
        else if (isFn(e)) {
          info.root.fns.set('default', e);
          exports.set('default', 'default');
        }
      } else if (ts.isFunctionDeclaration(st) && st.name && hasExport(st)) {
        exports.set(isDefault(st) ? 'default' : st.name.text, st.name.text);
      } else if (ts.isFunctionDeclaration(st) && isDefault(st)) {
        info.root.fns.set('default', st);
        exports.set('default', 'default');
      } else if (ts.isVariableStatement(st) && hasExport(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) exports.set(d.name.text, d.name.text);
      }
    }
    prescan(sf.statements, info.root, true);
    return info;
  }

  /** Registers what a statement list declares. `fnLevel` also hoists every nested `var` to this scope. */
  function prescan(stmts: readonly ts.Statement[], scope: Scope, fnLevel: boolean): void {
    for (const st of stmts) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        scope.names.add(st.name.text);
        if (st.body) scope.fns.set(st.name.text, st);
      } else if (ts.isClassDeclaration(st) && st.name) scope.names.add(st.name.text);
      else if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
        for (const d of st.declarationList.declarations) {
          addNames(d.name, scope.names);
          if ((st.declarationList.flags & ts.NodeFlags.Const) === 0 || !ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = unwrap(d.initializer);
          if (isFn(init)) scope.fns.set(d.name.text, init);
          else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) scope.aliases.set(d.name.text, init);
        }
      }
    }
    if (!fnLevel) return;
    const hoist = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return;
      if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0) for (const d of n.declarations) addNames(d.name, scope.names);
      ts.forEachChild(n, hoist);
    };
    stmts.forEach(hoist);
  }

  /** The lexical scope at a node, so a registration inside a function sees that function's shadowing declarations. */
  function scopeAt(n: ts.Node, file: FileInfo): Scope {
    if (ts.isSourceFile(n)) return file.root;
    const hit = scopeMemo.get(n);
    if (hit) return hit;
    const up = scopeAt(n.parent, file);
    let s = up;
    if (ts.isFunctionLike(n)) {
      s = newScope(up, file);
      for (const p of n.parameters) addNames(p.name, s.names);
      const body = (n as ts.FunctionLikeDeclaration).body;
      if (body && ts.isBlock(body)) prescan(body.statements, s, true);
    } else if (ts.isBlock(n) && !ts.isFunctionLike(n.parent)) {
      s = newScope(up, file);
      prescan(n.statements, s, false);
    } else if (ts.isModuleBlock(n)) {
      s = newScope(up, file);
      prescan(n.statements, s, true);
    } else if (ts.isCaseBlock(n)) {
      s = newScope(up, file);
      prescan(n.clauses.flatMap((c) => [...c.statements]), s, false);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      s = newScope(up, file);
      addNames(n.variableDeclaration.name, s.names);
    } else if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      s = newScope(up, file);
      for (const d of n.initializer.declarations) addNames(d.name, s.names);
    }
    scopeMemo.set(n, s);
    return s;
  }

  /* ---- module / symbol resolution ---- */
  function resolveFile(from: string, spec: string): FileInfo | null {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const stem = base.replace(/\.(?:jsx?|mjs|cjs)$/u, '');
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      const f = files.get(c);
      if (f) return f;
    }
    return null;
  }
  /** Root-relative module path of a relative specifier; a package name stays as written. */
  const moduleOf = (from: string, spec: string): string => (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec)) : spec);
  type Export = { file: FileInfo; local: string; name: string } | { spec: string; name: string; from: string } | null;
  function findExport(f: FileInfo, name: string, depth = 0, visited = new Set<string>()): Export {
    tick();
    const id = `${f.path}#${name}`;
    if (depth > 6 || visited.has(id)) return null;
    visited.add(id);
    const local = f.exports.get(name);
    if (local !== undefined) {
      const imp = f.imports.get(local);
      if (imp && !f.root.fns.has(local)) {
        const t = resolveFile(f.path, imp.spec);
        return t ? findExport(t, imp.name, depth + 1, visited) : { spec: imp.spec, name: imp.name, from: f.path };
      }
      return { file: f, local, name };
    }
    for (const r of f.reexports) {
      const orig = r.names === null ? name : r.names.get(name);
      if (orig === undefined || (r.names === null && name === 'default')) continue;
      const t = resolveFile(f.path, r.spec);
      if (!t) {
        if (r.names !== null) return { spec: r.spec, name: orig, from: f.path };
        continue;
      }
      const e = findExport(t, orig, depth + 1, visited);
      if (e) return e;
    }
    return null;
  }
  /** The single (module, exported symbol) a reference resolves to, after following re-exports. */
  interface Ref { module: string; file: FileInfo | null; symbol: string; fn: { file: FileInfo; local: string } | null }
  function refOf(f: FileInfo, imp: ImportInfo, member?: string): Ref | null {
    const wanted = imp.name === '*' ? member : imp.name;
    if (wanted === undefined) return null;
    const t = resolveFile(f.path, imp.spec);
    if (!t) return { module: moduleOf(f.path, imp.spec), file: null, symbol: wanted, fn: null };
    const e = findExport(t, wanted);
    if (!e) return null;
    if ('file' in e) return { module: e.file.path, file: e.file, symbol: e.name, fn: { file: e.file, local: e.local } };
    return { module: moduleOf(e.from, e.spec), file: null, symbol: e.name, fn: null };
  }
  function matchSpec(list: readonly SymbolSpec[], r: Ref): SymbolSpec | undefined {
    const hit = list.find((s) => {
      if (s.symbol !== r.symbol) return false;
      const target = resolveFile('', `./${s.module}`);
      return r.file && target ? r.file === target : norm(r.module) === norm(s.module);
    });
    if (hit) matchedSpecs.add(hit);
    return hit;
  }
  /** An import that could reach a configured effect without matching its exact (module, symbol) pair. */
  function nearEffect(spec: string): boolean {
    const bare = (m: string): string => m.replace(/^node:/u, '');
    return cfg.effects.some((e) => bare(spec) === bare(e.module) || bare(spec).startsWith(`${bare(e.module)}/`));
  }
  function matchRef(r: Ref): Callee | null {
    const g = matchSpec(cfg.guards, r);
    if (g) return { k: 'guard', spec: g };
    const ef = matchSpec(cfg.effects, r);
    return ef ? { k: 'effect', spec: ef } : null;
  }
  /** A file's own exported function can itself be the configured guard or effect. */
  function matchLocal(f: FileInfo, local: string): Callee | null {
    for (const [name, l] of f.exports) {
      if (l !== local) continue;
      const m = matchRef({ module: f.path, file: f, symbol: name, fn: null });
      if (m) return m;
    }
    return null;
  }

  type Hit = { fn: FnLike; scope: Scope } | { alias: ts.Expression; scope: Scope } | { local: true; scope: Scope };
  function lookup(scope: Scope | null, name: string): Hit | null {
    for (let s = scope; s; s = s.parent) {
      const fn = s.fns.get(name);
      if (fn) return { fn, scope: s };
      const alias = s.aliases.get(name);
      if (alias) return { alias, scope: s };
      if (s.names.has(name)) return { local: true, scope: s };
    }
    return null;
  }
  function keyOf(scope: Scope, name: string): string {
    for (let s: Scope | null = scope; s; s = s.parent) if (s.names.has(name)) return `${s.id}:${name}`;
    return `g:${scope.file.path}:${name}`;
  }
  function setVar(name: string, v: string, scope: Scope, st: State): void {
    const hit = lookup(scope, name);
    // A reassigned function name no longer has a known body.
    if (hit && 'fn' in hit) hit.scope.fns.delete(name);
    const key = keyOf(scope, name);
    writeLog.push(key);
    assignedNames.add(name);
    st.env.set(key, v);
  }

  function classify(expr: ts.Node, scope: Scope, st: State, depth = 0): Callee {
    if (depth > 6) return { k: 'unresolved', why: 'alias chain too deep', closure: true };
    const e = unwrap(expr);
    const f = scope.file;
    if (isFn(e)) return { k: 'fn', node: e, scope };
    if (ts.isIdentifier(e)) {
      const hit = lookup(scope, e.text);
      if (hit) {
        const own = hit.scope.parent === null ? matchLocal(f, e.text) : null;
        if (own) return own;
        if ('fn' in hit) return { k: 'fn', node: hit.fn, scope: hit.scope };
        if ('alias' in hit) return classify(hit.alias, hit.scope, st, depth + 1);
        return { k: 'unresolved', why: `${e.text} is a local variable or parameter`, closure: true };
      }
      const imp = f.imports.get(e.text);
      if (!imp) {
        if (PURE_CALLS.has(e.text)) return { k: 'ignore' };
        return { k: 'unresolved', why: `${e.text} is not declared in the supplied files`, closure: true };
      }
      const r = refOf(f, imp);
      if (!r) return { k: 'unresolved', why: `${e.text} is not exported by the supplied ${imp.spec}`, closure: true };
      const m = matchRef(r);
      if (m) return m;
      if (r.fn) {
        const t = r.fn.file;
        const h = lookup(t.root, r.fn.local);
        if (h && 'fn' in h) return { k: 'fn', node: h.fn, scope: h.scope };
        if (h && 'alias' in h) return classify(h.alias, h.scope, st, depth + 1);
        return { k: 'unresolved', why: `${r.fn.local} in ${t.path} is not a function declaration`, closure: true };
      }
      return { k: 'unresolved', why: `${e.text} is imported from ${imp.spec} which is not supplied`, closure: imp.spec.startsWith('.') || nearEffect(imp.spec) };
    }
    if (ts.isPropertyAccessExpression(e)) {
      const root = unwrap(e.expression);
      const m = e.name.text;
      if (ts.isIdentifier(root) && !lookup(scope, root.text)) {
        const imp = f.imports.get(root.text);
        if (imp) {
          // Only a namespace member is the exported symbol; a member of a matched symbol (.apply, .toString) is not a call to it.
          const r = imp.name === '*' ? refOf(f, imp, m) : null;
          const hit = r && matchRef(r);
          if (hit) return hit;
          if (r?.fn) {
            const h = lookup(r.fn.file.root, r.fn.local);
            if (h && 'fn' in h) return { k: 'fn', node: h.fn, scope: h.scope };
          }
          return { k: 'unresolved', why: `${root.text}.${m} comes from ${imp.spec}`, closure: imp.spec.startsWith('.') || nearEffect(imp.spec) };
        }
        if (PURE_MEMBERS.test(`${root.text}.${m}`)) return { k: 'ignore' };
      }
      const base = chainRoot(e);
      const v = ts.isIdentifier(base) ? st.env.get(keyOf(scope, base.text)) : undefined;
      if (v !== undefined && isHttp(v)) return { k: 'ignore' };
      return { k: 'unresolved', why: `method call ${e.getText(f.sf).slice(0, 60)} is not on req, res or next`, closure: true };
    }
    if (ts.isElementAccessExpression(e)) return { k: 'unresolved', why: 'computed call', closure: true };
    return { k: 'unresolved', why: 'call target is not a name', closure: true };
  }

  /* ---- values ---- */
  function bindPattern(p: ts.BindingName, v: string, ctx: Ctx, scope: Scope, st: State): void {
    if (ts.isIdentifier(p)) {
      // Logged because a `var` declaration can rebind a name that already holds a value.
      writeLog.push(keyOf(scope, p.text));
      st.env.set(keyOf(scope, p.text), v);
      return;
    }
    for (const el of p.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (el.initializer) evalExpr(el.initializer, ctx, scope, st);
      if (ts.isObjectBindingPattern(p) && !el.dotDotDotToken) {
        const key = el.propertyName ?? el.name;
        const k = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
        // A default may replace the property, and a dotted key would collide with a nested path.
        bindPattern(el.name, k !== null && !k.includes('.') && !el.initializer && !isUnk(v) ? `${v}.${k}` : fresh(), ctx, scope, st);
      } else bindPattern(el.name, fresh(), ctx, scope, st);
    }
  }
  const litOf = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return `lit:${n.text}`;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return 'lit:true';
    if (n.kind === ts.SyntaxKind.FalseKeyword) return 'lit:false';
    return n.kind === ts.SyntaxKind.NullKeyword ? 'lit:null' : null;
  };
  /** Records a write. Identifiers take the value; member writes taint the path; a base that may alias request data is a gap. */
  function writeTarget(t: ts.Node, v: string | null, ctx: Ctx, scope: Scope, st: State): void {
    const u = unwrap(t);
    if (ts.isIdentifier(u)) setVar(u.text, v ?? fresh(), scope, st);
    else if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) {
      const base = evalExpr(u.expression, ctx, scope, st);
      let k: string | null = null;
      if (ts.isPropertyAccessExpression(u)) k = u.name.text;
      else if (ts.isStringLiteralLike(u.argumentExpression)) k = u.argumentExpression.text;
      else evalExpr(u.argumentExpression, ctx, scope, st);
      if (isUnk(base)) {
        if (!base.startsWith('unk#alloc')) gap(ctx.file, u, 'unmodeled-write', `${route}: write through a value that may alias request data`);
      } else tainted.add(k === null ? base : `${base}.${k}`);
    } else if (ts.isArrayLiteralExpression(u)) {
      for (const el of u.elements) if (!ts.isOmittedExpression(el)) writeTarget(el, null, ctx, scope, st);
    } else if (ts.isSpreadElement(u)) writeTarget(u.expression, null, ctx, scope, st);
    else if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      evalExpr(u.right, ctx, scope, st);
      writeTarget(u.left, null, ctx, scope, st);
    } else if (ts.isObjectLiteralExpression(u)) {
      for (const p of u.properties) {
        if (ts.isShorthandPropertyAssignment(p)) setVar(p.name.text, fresh(), scope, st);
        else if (ts.isPropertyAssignment(p)) writeTarget(p.initializer, null, ctx, scope, st);
        else if (ts.isSpreadAssignment(p)) writeTarget(p.expression, null, ctx, scope, st);
      }
    } else gap(ctx.file, u, 'unmodeled-write', `${route}: assignment target ${ts.SyntaxKind[u.kind]} is not modeled`);
  }
  function argVals(e: ts.CallExpression | ts.NewExpression, ctx: Ctx, scope: Scope, st: State): string[] {
    // A spread may hold any number of values, so no position from it on is known.
    let spread = false;
    return (e.arguments ?? []).map((a) => {
      const v = evalExpr(ts.isSpreadElement(a) ? a.expression : a, ctx, scope, st);
      spread ||= ts.isSpreadElement(a);
      return spread ? fresh() : v;
    });
  }

  /* ---- expression / statement evaluation ---- */
  function evalCond(expr: ts.Node, ctx: Ctx, scope: Scope, st: State): [State, State] {
    tick();
    const e = unwrap(expr);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const [t, f] = evalCond(e.operand, ctx, scope, st);
      return [f, t];
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const [tA, eA] = evalCond(e.left, ctx, scope, st);
      const [tB, eB] = evalCond(e.right, ctx, scope, tA);
      return [tB, merge(eA, eB)];
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const [tA, eA] = evalCond(e.left, ctx, scope, st);
      const [tB, eB] = evalCond(e.right, ctx, scope, eA);
      return [merge(tA, tB), eB];
    }
    if (ts.isCallExpression(e)) {
      const s0 = cloneState(st);
      const callee = classify(e.expression, scope, s0);
      if (callee.k === 'guard') {
        const vals = argVals(e, ctx, scope, s0);
        const allowed = cloneState(s0);
        // An unawaited async guard is a Promise: always truthy, so the condition proves nothing.
        if (!callee.spec.async || isAwaited(expr)) addGuard(allowed, callee.spec, vals);
        return [allowed, s0];
      }
    }
    const s = cloneState(st);
    evalExpr(expr, ctx, scope, s);
    return [s, cloneState(s)];
  }

  /** `asMiddleware`: the guard sits in a route's chain, so a null subjectArg means Express hands it the request. */
  function addGuard(st: State, spec: SymbolSpec, vals: readonly string[], asMiddleware = false): void {
    const subject = spec.subjectArg === null || spec.subjectArg === undefined ? (asMiddleware ? 'req' : undefined) : vals[spec.subjectArg];
    if (subject === undefined || !isPrincipal(subject)) return;
    const tenant = spec.tenantArg === undefined ? undefined : (vals[spec.tenantArg] ?? fresh());
    const resource = spec.resourceArg === undefined ? undefined : (vals[spec.resourceArg] ?? fresh());
    st.guards.set(`${spec.module}#${spec.symbol}|${tenant}|${resource}`, { name: spec.symbol, tenant, resource });
  }

  const touched = (v: string): boolean => [...tainted].some((p) => v === p || v.startsWith(`${p}.`) || p.startsWith(`${v}.`));
  function relate(a: string | undefined, b: string): 'match' | 'mismatch' | 'unknown' {
    if (a === undefined) return 'mismatch';
    if (a === b && constVals.has(a)) return 'match';
    if (isUnk(a) || isUnk(b) || touched(a) || touched(b)) return 'unknown';
    return a === b ? 'match' : 'mismatch';
  }
  function checkEffect(spec: SymbolSpec, vals: readonly string[], node: ts.Node, ctx: Ctx, st: State): void {
    const label = `${spec.symbol}(${spec.module})`;
    if (st.guards.size === 0) return violation(ctx.file, node, `effect ${label} runs on a path with no guard before it`);
    const dims = (g: Guard): Array<'match' | 'mismatch' | 'unknown'> => {
      const out: Array<'match' | 'mismatch' | 'unknown'> = [];
      if (spec.tenantArg !== undefined) out.push(relate(g.tenant, vals[spec.tenantArg] ?? fresh()));
      if (spec.resourceArg !== undefined) out.push(relate(g.resource, vals[spec.resourceArg] ?? fresh()));
      return out;
    };
    let unknown = false;
    const why: string[] = [];
    for (const g of st.guards.values()) {
      const d = dims(g);
      if (d.every((x) => x === 'match')) return;
      if (!d.includes('mismatch')) unknown = true;
      else why.push(`guard ${g.name} binds tenant ${g.tenant ?? 'none'} resource ${g.resource ?? 'none'}, effect uses tenant ${spec.tenantArg === undefined ? '-' : vals[spec.tenantArg]} resource ${spec.resourceArg === undefined ? '-' : vals[spec.resourceArg]}`);
    }
    if (unknown) return gap(ctx.file, node, 'unresolved-binding', `${route}: cannot tie the guard's tenant/resource to the arguments of ${label}`);
    violation(ctx.file, node, `effect ${label} is not covered by a guard for the same tenant/resource (${why.join('; ')})`);
  }

  function callFn(callee: Extract<Callee, { k: 'fn' }>, vals: readonly string[], node: ts.Node, ctx: Ctx, st: State): void {
    if (stack.includes(callee.node)) return gap(ctx.file, node, 'recursion', `${route}: recursive helper not followed`);
    if (stack.length >= LIMITS.depth) return gap(ctx.file, node, 'depth-limit', `${route}: helper chain deeper than ${LIMITS.depth}, not followed`);
    if (!callee.node.body) return gap(ctx.file, node, 'unresolved-call', `${route}: helper has no body`);
    stack.push(callee.node);
    const saved = st.env;
    const mark = writeLog.length;
    st.env = new Map(st.env);
    const inner: Ctx = { returns: [], jumps: [], file: callee.scope.file };
    const scope = newScope(callee.scope, callee.scope.file);
    for (const p of callee.node.parameters) addNames(p.name, scope.names);
    try {
      callee.node.parameters.forEach((p, i) => {
        if (p.initializer) evalExpr(p.initializer, inner, scope, st);
        // With a default, any passed value may be undefined and replaced, so the parameter has no single value.
        bindPattern(p.name, p.dotDotDotToken || p.initializer ? fresh() : (vals[i] ?? fresh()), inner, scope, st);
      });
      if (ts.isBlock(callee.node.body)) {
        prescan(callee.node.body.statements, scope, true);
        for (const s of callee.node.body.statements) {
          if (st.dead) break;
          execStmt(s, inner, scope, st);
        }
      } else evalExpr(callee.node.body, inner, scope, st, true);
    } finally {
      stack.pop();
    }
    const ends = [...inner.returns, ...(st.dead ? [] : [st])];
    st.env = saved;
    clobberSince(mark, st);
    if (ends.length === 0) {
      st.dead = true;
      return;
    }
    const m = ends.reduce((a, b) => merge(a, b));
    st.guards = m.guards;
    st.dead = false;
  }

  /** Checks a function that runs later or concurrently: its effects are assessed from `st`, its guards credit nothing, its writes still land. */
  function runDetached(callee: Extract<Callee, { k: 'fn' }>, vals: readonly string[], node: ts.Node, ctx: Ctx, st: State): void {
    const mark = writeLog.length;
    const later = cloneState(st);
    // It may run after any write on this route, including ones below this point. Free names have no env entry until set.
    for (const k of [...later.env.keys()]) if (assignedNames.has(k.slice(k.lastIndexOf(':') + 1))) later.env.set(k, fresh());
    for (const n of assignedNames) later.env.set(`g:${callee.scope.file.path}:${n}`, fresh());
    callFn(callee, vals, node, ctx, later);
    clobberSince(mark, st);
  }
  function escaped(c: Callee, node: ts.Node, ctx: Ctx, st: State): void {
    if (c.k === 'fn') runDetached(c, [], node, ctx, st);
    else if (c.k === 'effect') gap(ctx.file, node, 'effect-reference', `${route}: effect ${c.spec.symbol} is used as a value, so when it runs is not assessed`);
  }

  function readName(e: ts.Identifier, ctx: Ctx, scope: Scope, st: State): string {
    const hit = lookup(scope, e.text);
    if (hit && 'fn' in hit) escaped({ k: 'fn', node: hit.fn, scope: hit.scope }, e, ctx, st);
    else if (!hit || 'alias' in hit) escaped(classify(e, scope, st), e, ctx, st);
    const key = keyOf(scope, e.text);
    // An unset outer binding assigned anywhere on the route may hold that write by the time this reads it.
    return st.env.get(key) ?? (assignedNames.has(e.text) ? fresh() : `free:${key}`);
  }

  /** Evaluates an expression for effects and guards, returning an abstract value. `stmt` = result is discarded. */
  function evalExpr(node: ts.Node, ctx: Ctx, scope: Scope, st: State, stmt = false): string {
    tick();
    const e = unwrap(node);
    const lit = litOf(e);
    if (lit !== null) return lit;
    if (ts.isIdentifier(e)) return readName(e, ctx, scope, st);
    if (ts.isPropertyAccessExpression(e)) {
      const root = unwrap(e.expression);
      if (ts.isIdentifier(root) && !lookup(scope, root.text) && scope.file.imports.get(root.text)?.name === '*') escaped(classify(e, scope, st), e, ctx, st);
      const b = evalExpr(e.expression, ctx, scope, st);
      return isUnk(b) ? fresh() : `${b}.${e.name.text}`;
    }
    if (ts.isElementAccessExpression(e)) {
      const b = evalExpr(e.expression, ctx, scope, st);
      const k = ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : null;
      if (k === null) evalExpr(e.argumentExpression, ctx, scope, st);
      // A dotted key would collide with the nested path of the same spelling.
      return k !== null && !k.includes('.') && !isUnk(b) ? `${b}.${k}` : fresh();
    }
    if (isFn(e)) {
      // A callback runs later: check its body from the state at its definition; its effects do not change this state.
      runDetached({ k: 'fn', node: e, scope }, [], e, ctx, st);
      return fresh();
    }
    if (ts.isClassExpression(e)) {
      gap(ctx.file, e, 'unmodeled-expression', `${route}: class expression is not modeled`);
      return fresh();
    }
    if (ts.isObjectLiteralExpression(e)) {
      let carry = false;
      const note = (v: string): void => { if (mayCarry(v)) carry = true; };
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p)) {
          if (ts.isComputedPropertyName(p.name)) evalExpr(p.name.expression, ctx, scope, st);
          note(evalExpr(p.initializer, ctx, scope, st));
        } else if (ts.isShorthandPropertyAssignment(p)) note(readName(p.name, ctx, scope, st));
        else if (ts.isSpreadAssignment(p)) note(evalExpr(p.expression, ctx, scope, st));
        else note(evalExpr(p, ctx, scope, st));
      }
      return carry ? fresh() : alloc();
    }
    if (ts.isArrayLiteralExpression(e)) {
      const vals = e.elements.filter((x) => !ts.isOmittedExpression(x)).map((x) => evalExpr(ts.isSpreadElement(x) ? x.expression : x, ctx, scope, st));
      return vals.some(mayCarry) ? fresh() : alloc();
    }
    if (ts.isConditionalExpression(e)) {
      const [t, f] = evalCond(e.condition, ctx, scope, st);
      const a = evalExpr(e.whenTrue, ctx, scope, t);
      const b = evalExpr(e.whenFalse, ctx, scope, f);
      assign(st, merge(t, f));
      return a === b ? a : fresh();
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const [t, f] = evalCond(e, ctx, scope, st);
        assign(st, merge(t, f));
        return fresh();
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        evalExpr(e.left, ctx, scope, st);
        const r = cloneState(st);
        evalExpr(e.right, ctx, scope, r);
        assign(st, merge(st, r));
        return fresh();
      }
      if (op === ts.SyntaxKind.EqualsToken) {
        const v = evalExpr(e.right, ctx, scope, st);
        writeTarget(e.left, ts.isIdentifier(unwrap(e.left)) ? v : null, ctx, scope, st);
        return v;
      }
      if (isAssignOp(op)) {
        evalExpr(e.left, ctx, scope, st);
        evalExpr(e.right, ctx, scope, st);
        writeTarget(e.left, null, ctx, scope, st);
        return fresh();
      }
      evalExpr(e.left, ctx, scope, st);
      evalExpr(e.right, ctx, scope, st);
      return fresh();
    }
    if (isIncDec(e)) {
      writeTarget(e.operand, null, ctx, scope, st);
      return fresh();
    }
    if (ts.isDeleteExpression(e)) {
      writeTarget(e.expression, null, ctx, scope, st);
      return fresh();
    }
    if (ts.isCallExpression(e)) return evalCall(e, ctx, scope, st, stmt, isAwaited(node));
    if (ts.isNewExpression(e)) {
      const vals = argVals(e, ctx, scope, st);
      const c = unwrap(e.expression);
      const pure = ts.isIdentifier(c) && PURE_NEW.has(c.text) && !lookup(scope, c.text) && !scope.file.imports.has(c.text);
      const carry = vals.some(mayCarry);
      const made = classify(c, scope, st);
      const imported = ts.isIdentifier(c) && !lookup(scope, c.text) ? scope.file.imports.get(c.text) : undefined;
      if (made.k === 'effect') checkEffect(made.spec, vals, e, ctx, st);
      else if (!pure && (carry || !ts.isIdentifier(c) || lookup(scope, c.text) || imported?.spec.startsWith('.') || (imported && nearEffect(imported.spec)))) gap(ctx.file, e, 'unresolved-call', `${route}: constructor ${c.getText(ctx.file.sf).slice(0, 60)} may carry request data, so effects behind it are not assessed`);
      return carry ? fresh() : alloc();
    }
    if (ts.isTaggedTemplateExpression(e)) {
      evalExpr(e.template, ctx, scope, st);
      const tag = classify(e.tag, scope, st);
      if (tag.k === 'fn') runDetached(tag, [], e, ctx, st);
      else if (tag.k === 'effect') checkEffect(tag.spec, [], e, ctx, st);
      if (tag.k !== 'fn' && !ts.isNoSubstitutionTemplateLiteral(e.template)) gap(ctx.file, e, 'unresolved-call', `${route}: tagged template may carry request data, so effects behind it are not assessed`);
      return fresh();
    }
    ts.forEachChild(e, (c) => {
      if (!ts.isTypeNode(c)) evalExpr(c, ctx, scope, st);
    });
    return fresh();
  }

  function recordNext(e: ts.CallExpression, vals: readonly string[], st: State): void {
    const arg = e.arguments[0] && unwrap(e.arguments[0]);
    const v = vals[0] ?? '';
    // next(err) jumps to error handlers, so it does not continue the chain; a possibly-falsy value might, so it counts.
    const isError = arg !== undefined && (ts.isNewExpression(arg) || v.startsWith('unk#err') || /^lit:(?!null$|false$|0$|$)/u.test(v));
    if (!isError) {
      nextMark ??= writeLog.length;
      nexts.push(cloneState(st));
    }
  }

  function evalCall(e: ts.CallExpression, ctx: Ctx, scope: Scope, st: State, stmt: boolean, awaited: boolean): string {
    const target = unwrap(e.expression);
    let base: string | undefined;
    if (isFn(target)) { /* immediately invoked below */ }
    else if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target)) evalExpr(target, ctx, scope, st);
    else if (ts.isPropertyAccessExpression(target) && !ts.isIdentifier(unwrap(target.expression))) base = evalExpr(target.expression, ctx, scope, st);
    const vals = argVals(e, ctx, scope, st);
    if (ts.isPropertyAccessExpression(target) && MUTATORS.has(target.name.text)) {
      base ??= evalExpr(target.expression, ctx, scope, st);
      if (isReq(base)) tainted.add(base);
    }
    if (ts.isIdentifier(target) && st.env.get(keyOf(scope, target.text)) === 'next') {
      recordNext(e, vals, st);
      return fresh();
    }
    const callee = classify(target, scope, st);
    switch (callee.k) {
      case 'guard':
        if (stmt && callee.spec.style !== 'boolean' && (!callee.spec.async || awaited)) addGuard(st, callee.spec, vals);
        break;
      case 'effect':
        checkEffect(callee.spec, vals, e, ctx, st);
        break;
      case 'fn':
        // Unawaited async work and generator bodies do not finish before the next statement, so their guards stop nothing.
        if ((callee.node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) && !awaited) || (callee.node as ts.FunctionLikeDeclaration).asteriskToken) runDetached(callee, vals, e, ctx, st);
        else callFn(callee, vals, e, ctx, st);
        break;
      case 'unresolved':
        if (callee.closure || vals.some(mayCarry)) gap(ctx.file, e, 'unresolved-call', `${route}: ${callee.why}; it may carry request data, so effects behind it are not assessed`);
        break;
      case 'ignore':
        break;
    }
    // A followed helper can return a request alias from its closure, so only an unfollowed call may count as a new object.
    return ts.isIdentifier(target) && callee.k !== 'fn' && !vals.some(mayCarry) ? alloc() : fresh();
  }

  function execBlock(stmts: readonly ts.Statement[], ctx: Ctx, scope: Scope, st: State): void {
    const inner = newScope(scope, scope.file);
    prescan(stmts, inner, false);
    for (const s of stmts) {
      if (st.dead) return;
      execStmt(s, ctx, inner, st);
    }
  }
  function execSub(s: ts.Statement | undefined, ctx: Ctx, scope: Scope, st: State): void {
    if (!s) return;
    if (ts.isBlock(s)) execBlock(s.statements, ctx, scope, st);
    else execStmt(s, ctx, scope, st);
  }

  function execLoop(s: ts.WhileStatement | ts.ForStatement | ts.ForOfStatement | ts.ForInStatement | ts.DoStatement, ctx: Ctx, outer: Scope, st: State): void {
    const scope = newScope(outer, outer.file);
    const labels = new Set<string>();
    for (let p: ts.Node = s.parent; ts.isLabeledStatement(p); p = p.parent) labels.add(p.label.text);
    const mark = ctx.jumps.length;
    const decls = !ts.isWhileStatement(s) && !ts.isDoStatement(s) && s.initializer && ts.isVariableDeclarationList(s.initializer) ? s.initializer.declarations : null;
    if (decls) for (const d of decls) addNames(d.name, scope.names);
    if (ts.isForStatement(s) && s.initializer) {
      if (decls) for (const d of decls) bindPattern(d.name, d.initializer ? evalExpr(d.initializer, ctx, scope, st) : fresh(), ctx, scope, st);
      else evalExpr(s.initializer, ctx, scope, st);
    } else if (ts.isForOfStatement(s) || ts.isForInStatement(s)) evalExpr(s.expression, ctx, scope, st);
    const entry = cloneState(st);
    const exits: State[] = [];
    let head = cloneState(st);
    // Two passes: the second starts from the merge with the back edge, so writes later in the body reach reads earlier in it.
    for (let pass = 0; pass < 2; pass += 1) {
      let body = cloneState(head);
      if (ts.isWhileStatement(s) || ts.isForStatement(s)) {
        const cond = ts.isWhileStatement(s) ? s.expression : s.condition;
        if (cond) {
          const [t, f] = evalCond(cond, ctx, scope, body);
          body = t;
          if (!isConstTrue(cond)) exits.push(f);
        }
      } else if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
        exits.push(cloneState(body));
        if (decls) for (const d of decls) bindPattern(d.name, fresh(), ctx, scope, body);
        else writeTarget(s.initializer, null, ctx, scope, body);
      }
      execSub(s.statement, ctx, scope, body);
      let end = body;
      const others: Jump[] = [];
      for (const j of ctx.jumps.splice(mark)) {
        if (j.label !== undefined && !labels.has(j.label)) others.push(j);
        else if (j.kind === 'break') exits.push(j.st);
        else end = merge(end, j.st);
      }
      ctx.jumps.push(...others);
      if (ts.isDoStatement(s) && !end.dead) {
        const [t, f] = evalCond(s.expression, ctx, scope, end);
        if (!isConstTrue(s.expression)) exits.push(f);
        end = t;
      }
      if (ts.isForStatement(s) && s.incrementor && !end.dead) evalExpr(s.incrementor, ctx, scope, end);
      if (end.dead) break;
      head = merge(entry, end);
    }
    assign(st, exits.reduce((a, b) => merge(a, b), deadOf(st)));
  }

  function execStmt(s: ts.Statement, ctx: Ctx, scope: Scope, st: State): void {
    tick();
    if (ts.isExpressionStatement(s)) {
      evalExpr(s.expression, ctx, scope, st, true);
    } else if (ts.isVariableStatement(s)) {
      const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of s.declarationList.declarations) {
        const init = d.initializer && unwrap(d.initializer);
        // A const function (or an alias of one) is checked where it is called or escapes, not where it is named.
        const callable = isConst && init && (isFn(init) || (ts.isIdentifier(init) && ['fn', 'guard', 'effect'].includes(classify(init, scope, st).k)));
        const v = d.initializer && !callable ? evalExpr(d.initializer, ctx, scope, st) : fresh();
        if (isConst && ts.isIdentifier(d.name) && init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && PRIMITIVE_CONVERTERS.has(init.expression.text) && !lookup(scope, init.expression.text) && isUnk(v)) constVals.add(v);
        // Unlike let and const, a repeated `var` is a write to the same binding.
        if ((s.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) addNames(d.name, assignedNames);
        bindPattern(d.name, v, ctx, scope, st);
      }
    } else if (ts.isReturnStatement(s)) {
      if (s.expression) evalExpr(s.expression, ctx, scope, st, true);
      ctx.returns.push(cloneState(st));
      st.dead = true;
    } else if (ts.isThrowStatement(s)) {
      evalExpr(s.expression, ctx, scope, st);
      st.dead = true;
    } else if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      ctx.jumps.push({ kind: ts.isBreakStatement(s) ? 'break' : 'continue', label: s.label?.text, st: cloneState(st) });
      st.dead = true;
    } else if (ts.isBlock(s)) {
      execBlock(s.statements, ctx, scope, st);
    } else if (ts.isIfStatement(s)) {
      const [t, f] = evalCond(s.expression, ctx, scope, st);
      execSub(s.thenStatement, ctx, scope, t);
      execSub(s.elseStatement, ctx, scope, f);
      assign(st, merge(t, f));
    } else if (ts.isWhileStatement(s) || ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isDoStatement(s)) {
      execLoop(s, ctx, scope, st);
    } else if (ts.isTryStatement(s)) {
      const mark = writeLog.length;
      const thrown = cloneState(st);
      const t = cloneState(st);
      execBlock(s.tryBlock.statements, ctx, scope, t);
      // The try block may stop anywhere: its guards do not hold on the throw path, and any write in it may have happened.
      clobberSince(mark, thrown);
      let end = t;
      if (s.catchClause) {
        const c = cloneState(thrown);
        const cs = newScope(scope, scope.file);
        if (s.catchClause.variableDeclaration) {
          addNames(s.catchClause.variableDeclaration.name, cs.names);
          bindPattern(s.catchClause.variableDeclaration.name, caught(), ctx, cs, c);
        }
        execBlock(s.catchClause.block.statements, ctx, cs, c);
        end = merge(t, c);
        clobberSince(mark, thrown);
      }
      if (s.finallyBlock) {
        // finally also runs when the guard threw, so it is checked from the throw path merged with the normal end.
        const fin = merge(thrown, end);
        execBlock(s.finallyBlock.statements, ctx, scope, fin);
        if (fin.dead) end = fin;
        else if (!end.dead) {
          const after = cloneState(end);
          execBlock(s.finallyBlock.statements, ctx, scope, after);
          end = after;
        }
      }
      assign(st, end);
    } else if (ts.isSwitchStatement(s)) {
      evalExpr(s.expression, ctx, scope, st);
      const sw = newScope(scope, scope.file);
      prescan(s.caseBlock.clauses.flatMap((c) => [...c.statements]), sw, false);
      const mark = ctx.jumps.length;
      let fall = deadOf(st);
      let hasDefault = false;
      for (const clause of s.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) evalExpr(clause.expression, ctx, sw, st);
        else hasDefault = true;
        const c = merge(st, fall);
        for (const x of clause.statements) {
          if (c.dead) break;
          execStmt(x, ctx, sw, c);
        }
        fall = c;
      }
      let after = hasDefault ? fall : merge(fall, st);
      const others: Jump[] = [];
      for (const j of ctx.jumps.splice(mark)) {
        if (j.kind === 'break' && j.label === undefined) after = merge(after, j.st);
        else others.push(j);
      }
      ctx.jumps.push(...others);
      assign(st, after);
    } else if (ts.isLabeledStatement(s)) {
      const mark = ctx.jumps.length;
      execStmt(s.statement, ctx, scope, st);
      const others: Jump[] = [];
      for (const j of ctx.jumps.splice(mark)) {
        if (j.kind === 'break' && j.label === s.label.text) assign(st, merge(st, j.st));
        else others.push(j);
      }
      ctx.jumps.push(...others);
    } else if (ts.isClassDeclaration(s)) {
      gap(ctx.file, s, 'unmodeled-statement', `${route}: a class declared on a route path is not modeled`);
    } else if (
      ts.isFunctionDeclaration(s) || ts.isEmptyStatement(s) || ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s) || ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isModuleDeclaration(s)
    ) {
      // declarations are registered by prescan and only run when called
    } else {
      gap(ctx.file, s, 'unmodeled-statement', `${route}: ${ts.SyntaxKind[s.kind]} is not modeled`);
    }
  }

  /* ---- routes ---- */
  const registrars = new Set(cfg.routeRegistrars);
  const mountish = new Set(['use', 'route', 'all', 'param']);

  // shortcut: a client call such as axios.post('/x', body) also matches and becomes a gap; narrow it if real rules drown in these.
  function mayBeHandler(a: ts.Node, at: ts.Node, info: FileInfo): boolean {
    if (!ts.isIdentifier(a)) return false;
    const hit = lookup(scopeAt(at, info), a.text);
    if (!hit) return info.imports.has(a.text);
    if (!('local' in hit)) return true;
    for (let p: ts.Node = at; !ts.isSourceFile(p); p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      const names = new Set<string>();
      for (const q of p.parameters) addNames(q.name, names);
      if (names.has(a.text)) return true;
    }
    return false;
  }
  function looksLikeRoute(n: ts.CallExpression, obj: ts.Node, info: FileInfo): boolean {
    if (n.arguments.some(ts.isSpreadElement)) return true;
    if (n.arguments.length < 2) return false;
    const p = unwrap(n.arguments[0] as ts.Expression);
    if (ts.isStringLiteralLike(p)) return p.text.startsWith('/') || p.text.startsWith('*');
    if (ts.isRegularExpressionLiteral(p) || ts.isArrayLiteralExpression(p)) return true;
    return n.arguments.slice(1).some((a) => isFn(unwrap(a)) || mayBeHandler(unwrap(a), n, info)) || /\b(?:app|router)\b/iu.test(obj.getText(info.sf));
  }

  function middleware(arg: ts.Expression, info: FileInfo, ctx: Ctx, rscope: Scope, st: State, last: boolean): void {
    const e = unwrap(arg);
    const reqVals = ['req', 'res', 'next'];
    if (ts.isCallExpression(e) && !last) {
      const callee = classify(e.expression, rscope, st);
      if (callee.k === 'guard') {
        const vals = argVals(e, ctx, rscope, st);
        if (callee.spec.style !== 'boolean') addGuard(st, callee.spec, vals, true);
      } else if (callee.k === 'fn') gap(info, e, 'middleware-factory', `${route}: middleware factory ${ts.isIdentifier(e.expression) ? e.expression.text : 'call'} is not modeled`);
      else {
        const vals = argVals(e, ctx, rscope, st);
        if (callee.k === 'effect') checkEffect(callee.spec, vals, e, ctx, st);
        else if (callee.k === 'unresolved' && (callee.closure || vals.some(isReq))) gap(info, e, 'unresolved-middleware', `${route}: ${callee.why}`);
      }
      return;
    }
    const callee = classify(e, rscope, st);
    if (callee.k === 'guard') { if (callee.spec.style !== 'boolean') addGuard(st, callee.spec, reqVals, true); }
    else if (callee.k === 'fn') {
      nexts = [];
      nextMark = null;
      callFn(callee, reqVals, e, ctx, st);
      if (last) assessed += secondWalk ? 0 : 1;
      // The rest of the chain runs at next(), so only the state there carries on.
      else if (nexts.length > 0) {
        assign(st, nexts.reduce((a, b) => merge(a, b)));
        // The handler goes on after next(), so its later writes can land before the rest of the chain reads them.
        clobberSince(nextMark ?? writeLog.length, st);
      }
      else {
        gap(info, e, 'middleware-chain-stops', `${route}: this middleware reaches no next() call, so later handlers are not assessed`);
        st.dead = true;
      }
    } else if (callee.k === 'effect') checkEffect(callee.spec, reqVals, e, ctx, st);
    else if (last) gap(info, e, 'unresolved-handler', `${route}: ${callee.k === 'unresolved' ? callee.why : 'handler is not a function'}`);
    else gap(info, e, 'unresolved-middleware', `${route}: ${callee.k === 'unresolved' ? callee.why : 'middleware is not a function'}`);
  }

  function analyzeRoute(info: FileInfo, call: ts.CallExpression, method: string): void {
    const args = [...call.arguments];
    const path0 = args[0] && unwrap(args[0]);
    const pathLit = path0 && litOf(path0);
    const pathText = path0 && (pathLit?.startsWith('lit:') ? pathLit.slice(4) : ts.isRegularExpressionLiteral(path0) ? path0.text : null);
    route = `${method.toUpperCase()} ${pathText ?? '<dynamic>'}`;
    if (pathText === null || pathText === undefined) gap(info, call, 'dynamic-route-path', `${route} at ${info.path}:${lineOf(info, call)}: route path is not a literal`);
    const chain: ts.Expression[] = [];
    downgrade = false;
    for (const a of args.slice(1)) {
      const u = unwrap(a);
      if (ts.isSpreadElement(a)) {
        downgrade = true;
        gap(info, a, 'spread-middleware', `${route}: spread middleware cannot be resolved`);
      } else if (ts.isArrayLiteralExpression(u)) {
        for (const el of u.elements) {
          if (ts.isSpreadElement(el)) {
            downgrade = true;
            gap(info, el, 'spread-middleware', `${route}: spread middleware cannot be resolved`);
          } else chain.push(el);
        }
      } else chain.push(a);
    }
    if (chain.length === 0) return;
    const rscope = scopeAt(call, info);
    tainted.clear();
    assignedNames.clear();
    const walk = (): void => {
      const st: State = { guards: new Map(), env: new Map(), dead: false };
      const ctx: Ctx = { returns: [], jumps: [], file: info };
      writeLog.length = 0;
      nexts = [];
      chain.forEach((m, i) => {
        if (!st.dead) middleware(m, info, ctx, rscope, st, i === chain.length - 1);
      });
    };
    try {
      walk();
      // Findings of the first walk stand: more taint could only downgrade a real violation to a gap.
      secondWalk = tainted.size > 0 || assignedNames.size > 0;
      if (secondWalk) walk();
    } catch (err) {
      if (!(err instanceof Budget)) throw err;
      gap(info, call, 'step-limit', `${route}: analysis step limit reached; route not fully assessed`);
      throw err;
    } finally {
      stack.length = 0;
      downgrade = false;
      secondWalk = false;
    }
  }

  let aborted = false;
  for (const info of files.values()) {
    const objects = new Set(cfg.routeObjects);
    const walkAliases = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = unwrap(n.initializer);
        if (ts.isIdentifier(init) && objects.has(init.text)) objects.add(n.name.text);
      }
      ts.forEachChild(n, walkAliases);
    };
    walkAliases(info.sf);
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !objects.has(n.name.text)) {
        const init = unwrap(n.initializer);
        const c = ts.isCallExpression(init) ? unwrap(init.expression) : null;
        const cname = c && (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null);
        if (cname === 'Router' || (c && ts.isIdentifier(c) && c.text === 'express')) {
          route = '';
          gap(info, n, 'unconfigured-route-object', `${n.name.text} looks like an Express router but is not in routeObjects, so its routes are not assessed`);
        }
      }
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const obj = unwrap(callee.expression);
          const m = callee.name.text;
          const known = ts.isIdentifier(obj) && objects.has(obj.text);
          if (known && registrars.has(m)) {
            if (n.arguments.length < 2 && n.arguments.some(ts.isSpreadElement)) {
              route = '';
              gap(info, n, 'spread-middleware', `${obj.getText(info.sf)}.${m}(...) takes its path and handlers from a spread, so its routes are not assessed`);
            } else if (n.arguments.length >= 2 && !aborted) {
              try {
                analyzeRoute(info, n, m);
              } catch (err) {
                if (!(err instanceof Budget)) throw err;
                aborted = true;
              }
            }
          } else if (known && mountish.has(m)) {
            route = '';
            gap(info, n, 'unmodeled-registration', `${obj.getText(info.sf)}.${m}(...) mounts or groups routes in a way that is not modeled`);
          } else if ((HTTP_VERBS.has(m) || registrars.has(m)) && looksLikeRoute(n, obj, info)) {
            route = '';
            gap(info, n, 'unassessed-registration', `${m.toUpperCase()} registration on ${obj.getText(info.sf).slice(0, 60)} is not analyzed (not a plain configured object, a chained call, or a verb outside routeRegistrars)`);
          }
        } else if (ts.isElementAccessExpression(callee)) {
          const obj = unwrap(callee.expression);
          const k = callee.argumentExpression;
          if (ts.isIdentifier(obj) && objects.has(obj.text)) {
            route = '';
            gap(info, n, 'dynamic-registration', `${obj.text}[...](...) registers routes by a computed name`);
          } else if (ts.isStringLiteralLike(k) && HTTP_VERBS.has(k.text) && looksLikeRoute(n, obj, info)) {
            route = '';
            gap(info, n, 'dynamic-registration', `${obj.getText(info.sf).slice(0, 60)}[...](...) registers routes by a computed name`);
          }
        }
      }
      if (ts.isPropertyAccessExpression(n) && (HTTP_VERBS.has(n.name.text) || registrars.has(n.name.text))) {
        const obj = unwrap(n.expression);
        const called = ts.isCallExpression(n.parent) && unwrap(n.parent.expression) === n;
        if (!called && ts.isIdentifier(obj) && objects.has(obj.text)) {
          route = '';
          gap(info, n, 'unmodeled-registration', `${obj.text}.${n.name.text} is used as a value, so routes it registers are not assessed`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(info.sf);
  }
  // A configured effect nothing refers to makes a pass vacuous: it may have been renamed or moved out of the globs.
  for (const e of findings.length === 0 && gaps.length === 0 ? cfg.effects : []) {
    if (!matchedSpecs.has(e)) gaps.push({ kind: 'unmatched-effect', detail: `configured effect ${e.module}#${e.symbol} was not found in the supplied files`, path: e.module, line: 1 });
  }
  if (aborted) gaps.push({ kind: 'step-limit', detail: 'analysis stopped at the step limit; remaining routes not assessed', path: readOrder[0] ?? '', line: 1 });

  return {
    adapter: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    typescriptVersion: ts.version,
    control: CONTROL,
    findings,
    gaps,
    assessedRoutes: assessed,
    readSet: readOrder,
  };
}

/** The shape jurator's semantic registry expects (src/rules/semantic.ts). */
export const adapter = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  analyze(input: { files: readonly SourceFileInput[]; control: string; config: Record<string, unknown> }): AnalysisResult {
    if (input.control !== CONTROL) {
      return {
        adapter: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, typescriptVersion: ts.version, control: CONTROL,
        findings: [], gaps: [{ kind: 'unsupported-control', detail: `control ${input.control} is not supported`, path: '', line: 1 }],
        assessedRoutes: 0, readSet: [],
      };
    }
    return analyze(input.files, input.config);
  },
};
export default adapter;
