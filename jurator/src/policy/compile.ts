// Owner: WP-P. Policy -> promises. The model drafts; the program locates every quote and assigns stable ids.
import type {
  CompileResult,
  Connector,
  ModelClient,
  ModelUsage,
  PolicyDocument,
  PromiseDraft,
  PromiseRecord,
} from '../contracts.js';
import { getConnector } from '../connectors/index.js';
import { JuratorError } from '../util/errors.js';
import { matchesAny } from '../util/glob.js';
import { COMPILE_INSTRUCTIONS, compileInput, compileOutputSchema, repoCodeFolders, type CompileDraft } from './prompts.js';
import { normaliseFacets, requireUnit } from './facets.js';
import { copySpan, jsonPointerLine, jsonValueMatches, locateQuote, quoteKey, resolveJsonPointer } from './quote.js';

/** Alias of the source that holds sentences added with `jurator add --promise` (compiled word for word, no AI). */
export const LOCAL_ALIAS = 'local';

interface Candidate {
  readonly draft: PromiseDraft;
  /** Model hint: id of an existing promise this one rewords. */
  readonly sameAs: string | null;
}

export function promiseNumber(id: string): number {
  const n = Number(id.slice(id.lastIndexOf('.') + 1));
  return Number.isFinite(n) ? n : 0;
}
export function byPromiseId(a: { id: string }, b: { id: string }): number {
  const pa = a.id.slice(0, a.id.lastIndexOf('.'));
  const pb = b.id.slice(0, b.id.lastIndexOf('.'));
  if (pa !== pb) return pa < pb ? -1 : 1;
  return promiseNumber(a.id) - promiseNumber(b.id);
}
function formatId(alias: string, n: number): string {
  return `${alias}.${String(n).padStart(2, '0')}`;
}

function connectorFor(id: string): Connector | null {
  try {
    return getConnector(id);
  } catch {
    return null;
  }
}

/** True when the document's connector turns it into promises with no AI (e.g. Praesidia settings). */
export function isStructured(doc: PolicyDocument): boolean {
  return Boolean(connectorFor(doc.connector)?.toPromises);
}

function guessKind(sentence: string): PromiseDraft['kind'] {
  if (/\b(never|must not|do not|don't|does not|cannot|can't|no one|nobody)\b/iu.test(sentence)) return 'must-not';
  if (/\bmay\b/iu.test(sentence)) return 'may';
  return 'must';
}

/** `add --promise` sentences: one list item per promise, kept word for word. */
function localDrafts(doc: PolicyDocument): Candidate[] {
  const out: Candidate[] = [];
  for (const line of doc.text.split('\n')) {
    const m = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+?)\s*$/u.exec(line);
    if (!m || !m[1]) continue;
    const sentence = m[1];
    out.push({
      sameAs: null,
      draft: {
        wording: sentence.slice(0, 400),
        quote: { alias: doc.alias, policySha256: doc.sha256, text: sentence },
        kind: guessKind(sentence),
        checkable: 'code',
        scope: [],
        foundBy: 'human',
      },
    });
  }
  return out;
}

function modelDraftToCandidate(doc: PolicyDocument, d: CompileDraft): Candidate {
  const params = d.params.map((p) => ({ name: p.name, value: p.value, ...(p.unit ? { unit: p.unit } : {}) }));
  const facets = normaliseFacets(d.facets);
  return {
    sameAs: d.sameAs,
    draft: {
      wording: d.wording,
      quote: { alias: doc.alias, policySha256: doc.sha256, text: d.quote },
      kind: d.kind,
      checkable: d.checkable,
      scope: d.scope,
      ...(params.length ? { params } : {}),
      foundBy: 'model',
      ...(facets ? { facets } : {}),
    },
  };
}

/** R5-A: what compile knows about a multi-repo workspace (absent or one repo: a single repo). */
export interface WorkspaceHints {
  readonly repos: readonly string[];
  readonly codeScope: readonly string[];
}

/** Words that name a repo's role, and the repo names that play it. */
const ROLES: ReadonlyArray<{ readonly words: RegExp; readonly repo: RegExp }> = [
  { words: /\b(?:backend|back-end|server|servers|api|apis|service)\b/iu, repo: /api|backend|server|service|django|flask|rails/iu },
  { words: /\b(?:extension|extensions|browser|chrome)\b/iu, repo: /extension|chrome|browser|addon/iu },
  { words: /\b(?:frontend|front-end|web app|website|dashboard)\b/iu, repo: /web|frontend|front|dashboard|site/iu },
  { words: /\b(?:mobile|ios|android)\b/iu, repo: /mobile|ios|android/iu },
];

/** The one repo a promise's wording points at ("The backend ..."), or null when none or several. */
export function repoFromWording(wording: string, repos: readonly string[]): string | null {
  const hits = new Set<string>();
  for (const repo of repos) {
    // The repo's own name or a 4+ letter part of it ("extension" in chrome-extension).
    const parts = repo.toLowerCase().split(/[-_.]/u).filter((x) => x.length >= 4);
    const lower = wording.toLowerCase();
    if (lower.includes(repo.toLowerCase()) || parts.some((x) => new RegExp(`\\b${x}\\b`, 'u').test(lower))) hits.add(repo);
  }
  for (const role of ROLES) {
    if (!role.words.test(wording)) continue;
    for (const repo of repos) if (role.repo.test(repo)) hits.add(repo);
  }
  return hits.size === 1 ? ([...hits][0] as string) : null;
}

/** AC-C: at most this many scope globs from the model (was 3, so "the backend" never reached workers/ or pipeline/). */
export const MAX_SCOPE_GLOBS = 6;

/** Last words of a subject that name a part of the product itself. */
const PART_HEAD = /^(?:backend|back-end|server|servers|api|apis|service|services|extension|extensions|frontend|front-end|website|dashboard|app|mobile)$/u;

/**
 * AC-C: the repo a promise is about as a whole part of the product: its subject (the words before the verb) is that
 * part ("The backend must ...", "The backend never ...", "The browser extension keeps ..."), not a thing inside it
 * ("Every backend API request must ..."). Null when the subject is something else, or names several repos.
 */
export function wholePartRepo(wording: string, repos: readonly string[]): string | null {
  const m = /^(.*?)\s+(?:must|may|never|should|shall|can|cannot|will|does|do|is|are|only|always|keeps?|sends?|writes?|stores?|deletes?|asks?)\b/iu.exec(wording.trim());
  if (!m || !m[1]) return null;
  const words = m[1].toLowerCase().replace(/[^a-z0-9\s-]/gu, ' ').split(/\s+/u).filter(Boolean);
  while (words.length > 0 && /^(?:the|our|its|their|a|an)$/u.test(words[0] as string)) words.shift();
  const head = words[words.length - 1];
  if (!head || words.length > 3) return null;
  const repoWords = (r: string): string[] => [r.toLowerCase(), ...r.toLowerCase().split(/[-_.]/u).filter((x) => x.length >= 4)];
  if (!PART_HEAD.test(head) && !repos.some((r) => repoWords(r).includes(head))) return null;
  return repoFromWording(words.join(' '), repos);
}

/** True when `outer` takes in every file `inner` does (the same glob, or a `dir/**` that `inner` sits inside). */
function covers(outer: string, inner: string): boolean {
  return outer === inner || (outer.endsWith('/**') && inner.startsWith(outer.slice(0, -2)));
}

/**
 * AC-C (SC-3 fix 7): in a workspace, a code promise covers every code folder of a repo (its code-scope globs: src,
 * workers, pipeline, ai-mode ...) when (a) its subject is that repo's part ("The backend must ..."), or (b) its scope
 * already takes a whole code folder of that repo (`api/src/**` means the backend, not only src/). The program adds the
 * missing folders; a narrower glob inside an added folder is dropped. Narrow scopes of anything else are kept
 * (`api/src/routes/**` for "Every backend API request ...").
 */
export function widenToRepoFolders(
  scope: readonly string[],
  wording: string,
  hints: WorkspaceHints,
  codeFiles: readonly string[],
): { scope: string[]; added: string[] } {
  if (hints.repos.length < 2) return { scope: [...scope], added: [] };
  const fill = new Set<string>();
  const whole = wholePartRepo(wording, hints.repos);
  if (whole) fill.add(whole);
  for (const repo of hints.repos) {
    const folders = repoCodeFolders(repo, hints.codeScope, codeFiles);
    if (scope.some((g) => folders.some((f) => covers(g, f)))) fill.add(repo);
  }
  let out = [...scope];
  const added: string[] = [];
  for (const repo of hints.repos.filter((r) => fill.has(r))) {
    for (const folder of repoCodeFolders(repo, hints.codeScope, codeFiles)) {
      if (out.some((g) => covers(g, folder))) continue;
      out = out.filter((g) => !covers(folder, g));
      out.push(folder);
      added.push(folder);
    }
  }
  return { scope: out, added };
}

const widenNote = (added: readonly string[]): string => `scope covers every code folder of the repo: added ${added.join(', ')}`;

/**
 * Scope globs the program keeps: inside the repo, matching listed code, at most MAX_SCOPE_GLOBS from the model. R5-A,
 * in a workspace: a glob that names no repo is repaired by putting the repo in front (when that matches code), and a
 * code promise left with no scope gets the code scope of the one repo its wording names ("The backend ..."). AC-C:
 * then the missing code folders of the repo it is about are added (widenToRepoFolders).
 */
function cleanScope(
  scope: readonly string[],
  codeFiles: readonly string[],
  ws?: { readonly hints: WorkspaceHints; readonly wording: string; readonly code: boolean },
): { scope: string[]; note: string | null } {
  const out: string[] = [];
  const repaired: string[] = [];
  const repos = ws && ws.hints.repos.length > 1 ? ws.hints.repos : [];
  const matches = (glob: string): boolean => codeFiles.length === 0 || codeFiles.some((f) => matchesAny(f, [glob]));
  for (const raw of scope) {
    const glob = raw.trim().replace(/^\.\//u, '');
    if (!glob || glob.startsWith('/') || glob.includes('..')) continue;
    let globs = [glob];
    if (repos.length > 0 && !repos.includes(glob.split('/')[0] ?? '')) {
      // Names no repo: try it inside each repo; the wording breaks a tie.
      const fits = repos.map((r) => `${r}/${glob}`).filter(matches);
      const named = ws ? repoFromWording(ws.wording, repos) : null;
      globs = fits.length > 1 && named && fits.includes(`${named}/${glob}`) ? [`${named}/${glob}`] : fits;
      if (globs.length > 0) repaired.push(`${glob} -> ${globs.join(', ')}`);
    } else if (!matches(glob)) continue;
    for (const g of globs) if (!out.includes(g) && out.length < MAX_SCOPE_GLOBS) out.push(g);
  }
  if (repos.length > 0 && ws?.code && out.length === 0) {
    const named = repoFromWording(ws.wording, repos);
    const own = named ? repoCodeFolders(named, ws.hints.codeScope, codeFiles) : [];
    const globs = own.length > 0 ? own : named ? [`${named}/**`] : [];
    if (globs.length > 0) {
      out.push(...globs);
      repaired.push(`no scope -> ${globs.join(', ')} (the promise names ${named})`);
    }
  }
  const notes = repaired.length > 0 ? [`scope repaired to name its repo: ${repaired.join('; ')}`] : [];
  if (repos.length > 0 && ws?.code && out.length > 0) {
    const widened = widenToRepoFolders(out, ws.wording, ws.hints, codeFiles);
    if (widened.added.length > 0) {
      out.splice(0, out.length, ...widened.scope);
      notes.push(widenNote(widened.added));
    }
  }
  return { scope: out, note: notes.length > 0 ? notes.join('; ') : null };
}

type Verified = { ok: true; draft: PromiseDraft; note?: string } | { ok: false; reason: string };

/** Principle 3: the program finds the quote itself; model text never becomes the evidence. */
function verifyDraft(doc: PolicyDocument, draft: PromiseDraft, codeFiles: readonly string[], ws?: WorkspaceHints): Verified {
  const wording = draft.wording.replace(/\s+/gu, ' ').trim();
  if (wording.length < 3) return { ok: false, reason: 'no wording' };
  const { facets: rawFacets, ...rest } = draft;
  // R4-FIX: a number in a text policy's facets needs its unit (repaired from the quote, else dropped with a note).
  const united = draft.quote.jsonPointer === undefined ? requireUnit(normaliseFacets(rawFacets), draft.quote.text) : { facets: normaliseFacets(rawFacets), note: null };
  const facets = united.facets;
  const scoped = cleanScope(draft.scope, codeFiles, ws ? { hints: ws, wording, code: draft.checkable === 'code' } : undefined);
  const base = {
    ...rest,
    wording: wording.length > 400 ? `${wording.slice(0, 397)}...` : wording,
    scope: scoped.scope,
    ...(facets ? { facets } : {}),
  };
  const notes = [united.note, scoped.note].filter((n): n is string => Boolean(n));
  const pointer = draft.quote.jsonPointer;
  if (pointer !== undefined) {
    let root: unknown;
    try {
      root = JSON.parse(doc.text);
    } catch {
      return { ok: false, reason: `${doc.locator} is not valid JSON` };
    }
    const hit = resolveJsonPointer(root, pointer);
    if (!hit.found) return { ok: false, reason: `setting ${pointer} not found in ${doc.locator}` };
    if (!jsonValueMatches(hit.value, draft.quote.text)) {
      return { ok: false, reason: `setting ${pointer} is not ${draft.quote.text} in ${doc.locator}` };
    }
    const line = jsonPointerLine(doc.text, pointer);
    return {
      ok: true,
      draft: {
        ...base,
        quote: {
          alias: doc.alias,
          policySha256: doc.sha256,
          text: draft.quote.text,
          jsonPointer: pointer,
          ...(line ? { line } : {}),
        },
      },
    };
  }
  const at = locateQuote(doc.text, draft.quote.text);
  if (!at) return { ok: false, reason: `quote not found word for word in ${doc.locator}` };
  return {
    ok: true,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    draft: {
      ...base,
      quote: {
        alias: doc.alias,
        policySha256: doc.sha256,
        text: copySpan(doc.text, at.start, at.end),
        start: at.start,
        end: at.end,
        line: at.line,
      },
    },
  };
}

const ARRAY_ITEM = /^(.*)\/\d+$/u;

/** Array items (e.g. /allowedTools/1) match by list + value, so reordering a list keeps every id. */
function matchKey(draft: { quote: { text: string; jsonPointer?: string | undefined } }): string {
  const pointer = draft.quote.jsonPointer;
  if (pointer === undefined) return `text:${quoteKey(draft.quote.text)}`;
  const item = ARRAY_ITEM.exec(pointer);
  return item ? `json:${item[1]}/[]#${draft.quote.text.trim()}` : `json:${pointer}#${draft.quote.text.trim()}`;
}

/**
 * Stable ids: the same quote (spacing ignored) keeps its id, status and firstSeen. A rewording (model `sameAs`, or a
 * changed value at the same JSON setting) keeps the id, records the old quote in `rewordedFrom` and goes back to
 * draft. New promises get the next number (never reusing a retired one); unmatched existing promises retire.
 */
export function assignIds(
  alias: string,
  drafts: ReadonlyArray<Candidate>,
  existingAll: readonly PromiseRecord[],
  now: Date,
): PromiseRecord[] {
  const existing = existingAll.filter((p) => p.id.startsWith(`${alias}.`));
  const used = new Set<string>();
  const matched: Array<{ prev: PromiseRecord; how: 'same' | 'reworded' } | null> = drafts.map(() => null);

  // Pass 1: same quote. Prefer active over retired, then the same wording.
  drafts.forEach((c, i) => {
    const key = matchKey(c.draft);
    const pool = existing.filter((p) => !used.has(p.id) && matchKey(p) === key);
    const wording = c.draft.wording.toLowerCase();
    const pick =
      pool.find((p) => p.status !== 'retired' && p.wording.toLowerCase() === wording) ??
      pool.find((p) => p.status !== 'retired') ??
      pool[0];
    if (pick) {
      used.add(pick.id);
      matched[i] = { prev: pick, how: 'same' };
    }
  });
  // Pass 2: same JSON setting with a changed value (only when unambiguous on both sides; never list items).
  drafts.forEach((c, i) => {
    const pointer = c.draft.quote.jsonPointer;
    if (matched[i] || pointer === undefined || ARRAY_ITEM.test(pointer)) return;
    if (drafts.filter((d) => d.draft.quote.jsonPointer === pointer).length !== 1) return;
    const pool = existing.filter((p) => !used.has(p.id) && p.quote.jsonPointer === pointer && p.status !== 'retired');
    if (pool.length === 1 && pool[0]) {
      used.add(pool[0].id);
      matched[i] = { prev: pool[0], how: 'reworded' };
    }
  });
  // Pass 3: the model says this rewords an existing promise of this source.
  drafts.forEach((c, i) => {
    if (matched[i] || !c.sameAs) return;
    const prev = existing.find((p) => p.id === c.sameAs && !used.has(p.id));
    if (prev) {
      used.add(prev.id);
      matched[i] = { prev, how: 'reworded' };
    }
  });

  let next = existing.reduce((max, p) => Math.max(max, promiseNumber(p.id)), 0) + 1;
  const out: PromiseRecord[] = [];
  drafts.forEach((c, i) => {
    const m = matched[i];
    const d = c.draft;
    if (!m) {
      out.push({ ...d, id: formatId(alias, next), status: 'draft', firstSeen: now.toISOString() });
      next += 1;
      return;
    }
    const { prev } = m;
    const keep = {
      id: prev.id,
      firstSeen: prev.firstSeen,
      ...(prev.rewordedFrom ? { rewordedFrom: prev.rewordedFrom } : {}),
    };
    if (m.how === 'reworded') {
      out.push({ ...d, ...keep, status: 'draft', rewordedFrom: [...(prev.rewordedFrom ?? []), prev.quote.text] });
    } else if (prev.status === 'accepted') {
      // A reviewed promise keeps its reviewed fields; only the located quote is refreshed. Facets fill in when the
      // promise has none yet; settings-based (structured) facets come from the program, so they always refresh.
      const facets = d.foundBy === 'structured' ? (d.facets ?? prev.facets) : (prev.facets ?? d.facets);
      out.push({ ...prev, quote: d.quote, ...(facets ? { facets } : {}) });
    } else {
      out.push({ ...d, ...keep, status: 'draft' });
    }
  });
  for (const p of existing) if (!used.has(p.id)) out.push(p.status === 'retired' ? p : { ...p, status: 'retired' });
  return out.sort(byPromiseId);
}

export async function compilePolicy(
  doc: PolicyDocument,
  existing: readonly PromiseRecord[],
  model: ModelClient | null,
  now: Date,
  hints?: { readonly codeFiles: readonly string[]; readonly workspace?: WorkspaceHints | undefined },
): Promise<CompileResult & { readonly notes?: string[] }> {
  const codeFiles = hints?.codeFiles ?? [];
  const ws = hints?.workspace && hints.workspace.repos.length > 1 ? hints.workspace : undefined;
  const usage: ModelUsage[] = [];
  const mine = existing.filter((p) => p.id.startsWith(`${doc.alias}.`));
  let candidates: Candidate[];
  const connector = connectorFor(doc.connector);
  if (connector?.toPromises) {
    candidates = connector.toPromises(doc).map((draft) => ({ draft, sameAs: null }));
  } else if (doc.alias === LOCAL_ALIAS) {
    candidates = localDrafts(doc);
  } else {
    if (!model) {
      throw new JuratorError(
        'MODEL_KEY_REQUIRED',
        `Compiling ${doc.locator} needs a model. Set META_API_KEY, or pass --scripted <dir>.`,
      );
    }
    const result = await model.json({
      task: `compile:${doc.alias}`,
      instructions: COMPILE_INSTRUCTIONS,
      input: compileInput({
        alias: doc.alias,
        locator: doc.locator,
        text: doc.text,
        codeFiles,
        repos: ws?.repos,
        codeScope: ws?.codeScope,
        existing: mine
          .filter((p) => p.status !== 'retired')
          .map((p) => ({
            id: p.id,
            wording: p.wording,
            quote: p.quote.text,
            quoteFound: p.quote.jsonPointer !== undefined || locateQuote(doc.text, p.quote.text) !== null,
          })),
      }),
      schemaName: 'policy_promises',
      schema: compileOutputSchema,
      maxOutputTokens: 8000,
    });
    usage.push(result.usage);
    candidates = result.value.promises.map((d) => modelDraftToCandidate(doc, d));
  }

  const dropped: Array<{ wording: string; reason: string }> = [];
  const notes: string[] = [];
  const kept: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const v = verifyDraft(doc, c.draft, codeFiles, ws);
    if (!v.ok) {
      dropped.push({ wording: c.draft.wording, reason: v.reason });
      continue;
    }
    if (v.note) notes.push(`"${v.draft.wording}": ${v.note}`);
    const dupKey = `${matchKey(v.draft)}|${v.draft.wording.toLowerCase()}`;
    if (seen.has(dupKey)) {
      dropped.push({ wording: c.draft.wording, reason: 'same promise listed twice' });
      continue;
    }
    seen.add(dupKey);
    kept.push({ draft: v.draft, sameAs: c.sameAs });
  }
  const promises = assignIds(doc.alias, kept, mine, now);
  // AC-C: an accepted promise keeps its reviewed scope on recompile, but in a workspace the program still adds the code
  // folders of the repo it is about (only additions), so promises accepted under the 3-glob cap reach workers/ too.
  if (ws) {
    for (const [i, p] of promises.entries()) {
      if (p.status !== 'accepted' || p.checkable !== 'code' || p.scope.length === 0) continue;
      const widened = widenToRepoFolders(p.scope, p.wording, ws, codeFiles);
      if (widened.added.length === 0) continue;
      promises[i] = { ...p, scope: widened.scope };
      notes.push(`"${p.wording}" (${p.id}, accepted): ${widenNote(widened.added)}`);
    }
  }
  return { promises, dropped, usage, ...(notes.length > 0 ? { notes } : {}) };
}
