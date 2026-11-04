// Owner: DS-A. What a discuss session reads: the .jurator/ store, the code at the session snapshot, the last check.
// Read-only: nothing here writes to the store or to a repo (the transcript lives in transcript.ts).
import { basename } from 'node:path';
import { BRAND } from '../../brand.js';
import { readBindings } from '../../bindings/index.js';
import type {
  Binding,
  CheckRun,
  CodeSnapshot,
  Config,
  Contradiction,
  GitRepo,
  LockEntry,
  PromiseRecord,
  Rule,
  Store,
} from '../../contracts.js';
import { openRepo, rememberRepoCommits } from '../../git/index.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, listRuns, openStore } from '../../workspace/index.js';

export interface WorkspaceData {
  readonly config: Config;
  /** Source alias -> locator (e.g. 'privacy' -> 'docs/privacy.md'). */
  readonly sources: Readonly<Record<string, string>>;
  readonly lock: readonly LockEntry[];
  readonly promises: readonly PromiseRecord[];
  readonly rules: readonly Rule[];
  readonly bindings: readonly Binding[];
  readonly contradictions: readonly Contradiction[];
  /** The newest saved check run, or null. */
  readonly lastRun: CheckRun | null;
}

export class DiscussWorkspace {
  readonly root: string;
  readonly name: string;
  readonly store: Store;
  readonly repo: GitRepo;
  /** Fixed when the session opens: every tool reads the code at this commit, never the working tree. */
  readonly snapshot: CodeSnapshot;
  #data: WorkspaceData;
  readonly #policyCache = new Map<string, string>();

  private constructor(root: string, store: Store, repo: GitRepo, snapshot: CodeSnapshot, data: WorkspaceData) {
    this.root = root;
    this.name = basename(root);
    this.store = store;
    this.repo = repo;
    this.snapshot = snapshot;
    this.#data = data;
  }

  /** Throws NO_WORKSPACE when there is no .jurator/ (before any screen is drawn). */
  static async open(cwd: string): Promise<DiscussWorkspace> {
    const root = await findRepoRoot(cwd);
    const store = openStore(root);
    if (!(await store.exists())) {
      throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ folder here yet. Run ${BRAND.command} init first.`);
    }
    const repo = await openRepo(root);
    const snapshot = await repo.snapshot();
    const data = await DiscussWorkspace.#load(store, repo);
    return new DiscussWorkspace(root, store, repo, snapshot, data);
  }

  static async #load(store: Store, repo: GitRepo): Promise<WorkspaceData> {
    const config = await store.readConfig();
    const runs = await listRuns(store).catch(() => [] as CheckRun[]);
    const lastRun = runs[runs.length - 1] ?? null;
    // A workspace run's composite commits are taught to the repo so its citations can be re-read.
    if (lastRun) await rememberRepoCommits(repo, lastRun.repoCommits).catch(() => undefined);
    return {
      config,
      sources: Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const)),
      lock: await store.readLock(),
      promises: await store.readPromises(),
      rules: await store.readRules(),
      bindings: await readBindings(store).catch(() => [] as Binding[]),
      contradictions: await store.readContradictions().catch(() => [] as Contradiction[]),
      lastRun,
    };
  }

  get data(): WorkspaceData {
    return this.#data;
  }

  /** Re-reads the store (promises accepted or checks run meanwhile are seen). The snapshot stays fixed. */
  async reload(): Promise<void> {
    try {
      this.#data = await DiscussWorkspace.#load(this.store, this.repo);
    } catch {
      // keep what we had: a half-written file during a concurrent command should not end the session
    }
  }

  accepted(): PromiseRecord[] {
    return this.#data.promises.filter((p) => p.status === 'accepted');
  }

  /** True when the last run's code is not the session snapshot. */
  isStale(run: CheckRun): boolean {
    return run.snapshot.commit !== this.snapshot.commit;
  }

  /** The locked policy text of a source alias (from .jurator/sources/), or null. */
  async policyText(alias: string): Promise<{ entry: LockEntry; text: string } | null> {
    const entry = this.#data.lock.find((e) => e.alias === alias);
    if (!entry) return null;
    let text = this.#policyCache.get(`${alias}:${entry.sha256}`);
    if (text === undefined) {
      try {
        text = await this.store.readSourceText(entry);
      } catch {
        return null;
      }
      this.#policyCache.set(`${alias}:${entry.sha256}`, text);
    }
    return { entry, text };
  }

  /** A source alias named by its alias or its locator ('privacy' or 'docs/privacy.md'). */
  sourceAlias(name: string): string | null {
    const n = name.trim().replace(/^\.\//u, '');
    if (this.#data.sources[n] !== undefined) return n;
    for (const [alias, locator] of Object.entries(this.#data.sources)) if (locator === n) return alias;
    return null;
  }
}
