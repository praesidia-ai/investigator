// Portable assessment bundles: what is known about a rule (tested mutants, open counterexamples, read set, analyzer),
// committed at <.jurator>/assessments/<ruleId>.json so the limits travel with the rule. The legacy
// local/rule-mutants.json is still read (never deleted) and imported when no bundle exists.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assessmentBundleSchema, type AssessmentBundle, type CheckResult, type GitRepo, type PromiseRecord, type Rule } from '../contracts.js';
import { blobIds, promiseDigest, ruleDigest } from '../cache/index.js';
import { sha256, stableJson } from '../util/json.js';
import { readMutants, type StoredEvasion } from './mutants.js';

export type Coverage = AssessmentBundle['coverage'];
export type Assurance = NonNullable<CheckResult['assurance']>;

export const ASSESSMENTS_DIR = 'assessments';
export const assessmentPath = (juratorDir: string, ruleId: string): string => join(juratorDir, ASSESSMENTS_DIR, `${ruleId}.json`);

/** The analyzer that decides: the semantic adapter, else the regex engine. */
export function analyzerOf(rule: Rule): { id: string; version: string } {
  return rule.semantic ? { id: rule.semantic.adapter, version: rule.semantic.adapterVersion } : { id: 'regex', version: '1' };
}

/**
 * Honest minimal coverage: 'strong-control' only for a semantic rule that was red-teamed, has no open counterexample
 * and passes at least one harmless control (and every one it has). Any other assessed rule is a limited detector.
 */
export function coverageOf(
  rule: Pick<Rule, 'mode'>,
  b: { mutants: readonly { closed: boolean }[]; harmlessControls: readonly { passed: boolean }[] },
): Coverage {
  const open = b.mutants.some((m) => !m.closed);
  const controls = b.harmlessControls.length > 0 && b.harmlessControls.every((c) => c.passed);
  return rule.mode === 'semantic' && b.mutants.length > 0 && !open && controls ? 'strong-control' : 'limited-detector';
}

export function bundleDigest(b: Omit<AssessmentBundle, 'digest'>): string {
  return sha256(stableJson(b));
}

export interface BuildInput {
  readonly rule: Rule;
  readonly promise: PromiseRecord;
  readonly commit: string;
  readonly readSet: AssessmentBundle['readSet'];
  readonly mutants: readonly StoredEvasion[];
  readonly harmlessControls?: AssessmentBundle['harmlessControls'];
  readonly adjudication?: AssessmentBundle['adjudication'];
  readonly createdAt: string;
}

export function buildBundle(i: BuildInput): AssessmentBundle {
  const harmlessControls = [...(i.harmlessControls ?? [])];
  const mutants = [...i.mutants].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const body: Omit<AssessmentBundle, 'digest'> = {
    schemaVersion: 1,
    ruleId: i.rule.id,
    promiseId: i.rule.promiseId,
    ruleDigest: ruleDigest(i.rule),
    promiseDigest: promiseDigest(i.promise),
    analyzer: analyzerOf(i.rule),
    sourceRevision: i.commit,
    readSet: [...i.readSet].sort((a, b) => a.path.localeCompare(b.path)),
    mutants,
    harmlessControls,
    adjudication: i.adjudication ?? { by: 'none', independent: false },
    coverage: coverageOf(i.rule, { mutants, harmlessControls }),
    createdAt: i.createdAt,
  };
  return { ...body, digest: bundleDigest(body) };
}

/**
 * Integrity check, not authenticity: the digest is an unkeyed sha256, so it catches accidents and naive edits only;
 * someone who recomputes it passes. The stored coverage must also follow from the content (mutants, controls, mode).
 * Checks schema, digest, and (when given) that it describes this rule and promise. */
export function verifyBundle(b: unknown, expect: { rule?: Rule; promise?: PromiseRecord } = {}): { ok: boolean; problems: string[] } {
  const parsed = assessmentBundleSchema.safeParse(b);
  if (!parsed.success) return { ok: false, problems: ['not a valid assessment bundle'] };
  const { digest, ...body } = parsed.data;
  const problems: string[] = [];
  if (bundleDigest(body) !== digest) problems.push('digest does not match the content (edited?)');
  if (body.coverage !== coverageOf(expect.rule ?? { mode: 'semantic' }, body)) problems.push('coverage does not follow from the recorded mutants and controls');
  if (expect.rule && ruleDigest(expect.rule) !== body.ruleDigest) problems.push('assessed an older version of the rule');
  if (expect.promise && promiseDigest(expect.promise) !== body.promiseDigest) problems.push('assessed an older wording of the promise');
  return { ok: problems.length === 0, problems };
}

/** Schema-valid bundle, tampered or not (use verifyBundle); null when missing or unreadable. */
export async function readBundle(juratorDir: string, ruleId: string): Promise<AssessmentBundle | null> {
  try {
    const parsed = assessmentBundleSchema.safeParse(JSON.parse(await readFile(assessmentPath(juratorDir, ruleId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Sorted, pretty, atomic. Never throws: false when it could not be written. */
export async function writeBundle(juratorDir: string, b: AssessmentBundle): Promise<boolean> {
  const path = assessmentPath(juratorDir, b.ruleId);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(b, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The tested evasions of a rule: its bundle's, else the legacy local file's (read only, never deleted). */
export async function loadEvasions(juratorDir: string, ruleId: string): Promise<{ evasions: StoredEvasion[]; source: 'bundle' | 'legacy' | 'none' }> {
  const bundle = await readBundle(juratorDir, ruleId);
  if (bundle && verifyBundle(bundle).ok) return { evasions: [...bundle.mutants], source: 'bundle' };
  const legacy = (await readMutants(juratorDir)).rules[ruleId];
  return legacy ? { evasions: [...legacy.evasions], source: 'legacy' } : { evasions: [], source: 'none' };
}

/** The files a rule reads at `commit`, with blob ids. */
export async function readSetOf(repo: GitRepo, commit: string, rule: Rule): Promise<AssessmentBundle['readSet']> {
  const paths = await repo.listFiles(commit, rule.globs);
  return (await blobIds(repo, commit, paths)).map(([path, blob]) => ({ path, blob }));
}

/**
 * Writes the bundle for `rule`; a legacy file is imported when no bundle exists. An existing bundle that already says
 * the same (same digests, mutants, read set) is left alone so committed files do not churn.
 */
export async function saveAssessment(
  juratorDir: string,
  repo: GitRepo,
  input: Omit<BuildInput, 'readSet' | 'mutants'> & { mutants?: readonly StoredEvasion[] },
): Promise<AssessmentBundle | null> {
  const mutants = input.mutants ?? (await loadEvasions(juratorDir, input.rule.id)).evasions;
  const readSet = await readSetOf(repo, input.commit, input.rule).catch(() => []);
  const next = buildBundle({ ...input, mutants, readSet });
  const old = await readBundle(juratorDir, input.rule.id);
  if (old && verifyBundle(old).ok) {
    const same = (b: AssessmentBundle): string => stableJson({ ...b, createdAt: '', sourceRevision: '', digest: '' });
    if (same(old) === same(next)) return old;
  }
  return (await writeBundle(juratorDir, next)) ? next : null;
}

const RANK: Record<Coverage, number> = { unassessed: 0, 'limited-detector': 1, 'strong-control': 2 };

/** Assurance for a promise's rules, read fresh each run (never cached). Open counterexamples add a warning. */
export async function assuranceFor(
  juratorDir: string,
  rules: readonly Rule[],
  now: { promise?: PromiseRecord | undefined; repo?: GitRepo; commit?: string } = {},
): Promise<Assurance | undefined> {
  if (rules.length === 0) return undefined;
  let open = 0;
  let coverage: Coverage = 'strong-control';
  const notes: string[] = [];
  for (const rule of rules) {
    const bundle = await readBundle(juratorDir, rule.id);
    const check = bundle ? verifyBundle(bundle, { rule, ...(now.promise ? { promise: now.promise } : {}) }) : null;
    let cov: Coverage;
    let evasions: StoredEvasion[];
    if (bundle && check?.ok) {
      cov = bundle.coverage;
      evasions = [...bundle.mutants];
      // Assessed against other code than this run reads: it no longer vouches as a strong control.
      if (cov === 'strong-control' && now.repo && now.commit) {
        const current = await readSetOf(now.repo, now.commit, rule).catch(() => null);
        if (current && stableJson(current) !== stableJson(bundle.readSet)) {
          cov = 'limited-detector';
          notes.push(`${rule.id}: assessed on different code than is read now`);
        }
      }
    } else {
      const legacy = bundle ? undefined : (await readMutants(juratorDir)).rules[rule.id];
      evasions = bundle ? [...bundle.mutants] : legacy ? [...legacy.evasions] : [];
      cov = legacy ? 'limited-detector' : 'unassessed';
      if (bundle && check) notes.push(`${rule.id}: assessment not trusted (${check.problems.join('; ')})`);
    }
    const openHere = evasions.filter((e) => !e.closed);
    if (openHere.length > 0 && cov === 'strong-control') cov = 'limited-detector';
    open += openHere.length;
    if (openHere.length > 0) {
      const shapes = openHere.slice(0, 3).map((e) => `${e.path}: ${e.why}`);
      notes.push(`${rule.id} misses ${openHere.length} known shape${openHere.length === 1 ? '' : 's'} (${shapes.join('; ')}${openHere.length > 3 ? '; ...' : ''})`);
    }
    if (RANK[cov] < RANK[coverage]) coverage = cov;
  }
  return { coverage, openCounterexamples: open, ...(notes.length > 0 ? { warning: `Limited detector: ${notes.join('. ')}` } : {}) };
}
