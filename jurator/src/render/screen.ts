// Owner: R4-UI2. How commands use the interface library (src/ui): when a screen is drawn in the new look, the live
// view while a model works, and a model wrapper that reports each call (stage + cost) to that view.
//
// Rules: --json output, exit codes and plain (non-terminal) output stay as they were. The new look is drawn when the
// command's style has colour (a terminal, or FORCE_COLOR) or JURATOR_UI=1 asks for it without colour. The live view
// goes to stderr and only on a terminal (JURATOR_PLAIN=1 or JURATOR_PROGRESS=1 prints one line per event instead).
import { basename } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import type { Config, ModelClient, ModelJsonRequest, ModelJsonResult } from '../contracts.js';
import { createLive, createUi, uiForContext, type Live, type LiveOptions, type Ui } from '../ui/index.js';
import { isVideo, VIDEO_WIDTH } from './video.js';

const on = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

/** True when a command draws its screen in the new look (never for --json). */
export function fancy(ctx: Pick<CommandContext, 'style' | 'env' | 'argv'>): boolean {
  if (ctx.argv.includes('--json') || ctx.argv.includes('--md')) return false;
  if (on(ctx.env.JURATOR_CLASSIC)) return false;
  return ctx.style.color || on(ctx.env.JURATOR_UI);
}

/** The Ui a command's final screen is drawn with (stdout). */
export function screenUi(ctx: Pick<CommandContext, 'style' | 'env' | 'argv'>, width0?: number): Ui {
  const ui = uiForContext(ctx, process.stdout);
  // Video mode (--video / JURATOR_VIDEO=1): the recording terminal is VIDEO_WIDTH columns.
  const width = width0 ?? (isVideo(ctx.env, ctx.argv) ? Math.min(VIDEO_WIDTH, ui.width) : undefined);
  if (width === undefined) return ui;
  return createUi({ stream: process.stdout, env: ctx.env, argv: ctx.argv, caps: { color: ui.caps.color, width } });
}

/** A live view that does nothing (no terminal, --json, tests). */
function quietLive(ui: Ui): Live {
  const noop = (): void => undefined;
  return {
    ui,
    mode: 'plain',
    add: noop,
    start: noop,
    detail: noop,
    done: noop,
    fail: noop,
    skip: noop,
    cost: noop,
    addCost: noop,
    progress: noop,
    eta: noop,
    log: noop,
    finish: () => [],
    snapshot: () => ({ title: '', unit: '', steps: [], startedAt: 0, now: 0, done: 0, total: 0, costUsd: 0, etaMs: null, finished: true }),
    render: () => [],
  };
}

/**
 * The live view for a command's model work: redrawn on stderr when stderr is a terminal, else quiet (or one line per
 * event with JURATOR_PLAIN=1 / JURATOR_PROGRESS=1, written through ctx.err). Always call finish() (in a finally).
 */
export function liveFor(ctx: Pick<CommandContext, 'style' | 'env' | 'argv' | 'err'>, options: Omit<LiveOptions, 'stream' | 'write' | 'env' | 'argv'>): Live {
  const json = ctx.argv.includes('--json');
  const stream = process.stderr;
  const inTests = on(process.env.VITEST);
  const ui = createUi({ stream, env: ctx.env, argv: ctx.argv });
  if (!json && !inTests && ui.caps.live && !on(ctx.env.JURATOR_CLASSIC)) return createLive({ ...options, stream, env: ctx.env, argv: ctx.argv, ui });
  if (!json && (on(ctx.env.JURATOR_PLAIN) || on(ctx.env.JURATOR_PROGRESS))) {
    return createLive({ ...options, stream, env: ctx.env, argv: ctx.argv, write: (l) => ctx.err(l) });
  }
  return quietLive(ui);
}

export interface ModelHooks {
  /** A call starts (its task key, e.g. "rule-propose:privacy.01"). */
  onStart?(task: string): void;
  /** A call ended; usd is what it cost (0 when unknown). */
  onEnd?(task: string, usd: number, ok: boolean): void;
}

/** The same model client, reporting each call to the hooks (stage and cost for the live view). */
export function trackModel<M extends ModelClient | null>(model: M, hooks: ModelHooks): M {
  if (!model) return model;
  const inner = model as ModelClient;
  const json = async <T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> => {
    hooks.onStart?.(request.task);
    try {
      const result = await inner.json(request);
      hooks.onEnd?.(request.task, result.usage?.usd ?? 0, true);
      return result;
    } catch (error) {
      const usd = (error as { usage?: { usd?: number } }).usage?.usd ?? 0;
      hooks.onEnd?.(request.task, usd, false);
      throw error;
    }
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'json') return json;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as M;
}

/** "acme-notes", or "investigator workspace · 2 repos" in a multi-repo workspace. */
export function workspaceLabel(root: string, config: Pick<Config, 'repos'> | null | undefined): string {
  const repos = (config as { repos?: readonly unknown[] } | null | undefined)?.repos ?? [];
  const name = basename(root) || root;
  return repos.length > 0 ? `${name} workspace · ${repos.length} repo${repos.length === 1 ? '' : 's'}` : name;
}

/** "muse-wonder (live)" or "scripted answers (no network)". */
export function modelLabel(model: Pick<ModelClient, 'id' | 'mode'> | null | undefined): string | undefined {
  if (!model) return undefined;
  return model.mode === 'live' ? `${model.id} (live)` : 'scripted answers (no network)';
}

/** Prints lines through ctx.out. */
export function print(ctx: Pick<CommandContext, 'out'>, lines: readonly string[]): void {
  for (const l of lines) ctx.out(l);
}

/** A command context whose output gets the new look: a header first, then the lines, "Next:" drawn as one clear hint. */
export interface DressedContext extends CommandContext {
  /** The workspace line for the header ("acme-notes", "investigator workspace · 2 repos"), once it is known. */
  setWorkspace(label: string | undefined): void;
  /** More header facts (["model", "..."]). */
  addFact(label: string, value: string): void;
}

/**
 * Wraps a command's context: in the new look the first line printed is preceded by the header, and a line starting
 * "Next:" (or ending in "Next: ...") becomes the arrow hint. Otherwise (plain, --json) the context is unchanged.
 */
export function dressed(ctx: CommandContext, command: string): DressedContext {
  if (!fancy(ctx)) return { ...ctx, setWorkspace: () => undefined, addFact: () => undefined };
  const ui = screenUi(ctx);
  let workspace: string | undefined;
  const facts: Array<readonly [string, string]> = [];
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    for (const l of ui.header({ command, workspace, facts })) ctx.out(l);
    ctx.out('');
  };
  const out = (line: string): void => {
    start();
    const at = line.search(/(?:^|[.;]\s)Next: /u);
    if (at < 0) {
      ctx.out(line);
      return;
    }
    const idx = line.indexOf('Next: ', at);
    const before = line.slice(0, idx).trim();
    if (before) ctx.out(before);
    for (const l of ui.next(line.slice(idx + 'Next: '.length))) ctx.out(l);
  };
  return {
    ...ctx,
    out,
    setWorkspace: (label) => {
      workspace = label;
    },
    addFact: (label, value) => {
      facts.push([label, value]);
    },
  };
}
