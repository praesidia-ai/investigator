// Owner: FX-2. Video mode (`--video` on a command, or JURATOR_VIDEO=1): output that reads well in a screen recording.
// Same facts, shorter lines: repo-relative paths, 7-character shas, no run ids in the bookkeeping lines, and every line
// within VIDEO_WIDTH columns (long lines fold at a space; nothing is cut off). --json and --md output is never changed.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { CommandContext } from '../cli/context.js';

/** The recording terminal: 100 columns. */
export const VIDEO_WIDTH = 100;

/** True for `--video` in argv or JURATOR_VIDEO=1 in the environment. */
export function isVideo(env: NodeJS.ProcessEnv, argv: readonly string[] = []): boolean {
  return env.JURATOR_VIDEO === '1' || argv.includes('--video');
}

/** The process-wide default for renderers that are not handed a context (hooks print through them too). */
export function videoFromEnv(): boolean {
  return process.env.JURATOR_VIDEO === '1';
}

const ANSI = /\u001b\[[0-9;]*m/gu;
/** Columns a line takes on screen (colour codes take none). */
export function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The spellings of a folder a command may print: as given, resolved, and without macOS's /private prefix. */
export function rootSpellings(dir: string): string[] {
  const out = new Set<string>([dir]);
  try {
    out.add(realpathSync(dir));
  } catch {
    // a folder that does not exist (tests) has one spelling
  }
  for (const d of [...out]) {
    if (d.startsWith('/private/')) out.add(d.slice('/private'.length));
    else if (/^\/(?:var|tmp)\//u.test(d)) out.add(`/private${d}`);
  }
  return [...out].filter((d) => d.length > 1).sort((a, b) => b.length - a.length);
}

/**
 * Repo-relative paths and 7-character shas: "<root>/src/a.ts" -> "src/a.ts", "<root>" alone -> its folder name,
 * a 40-character git sha (or a 64-character one) -> its first 7 characters.
 */
export function tidy(line: string, roots: readonly string[]): string {
  let out = line;
  for (const root of roots) {
    const r = escape(root.replace(/\/+$/u, ''));
    out = out.replace(new RegExp(`${r}/+`, 'gu'), '');
    out = out.replace(new RegExp(`${r}(?![\\w./-])`, 'gu'), basename(root));
  }
  return out.replace(/\b([0-9a-f]{7})(?:[0-9a-f]{33}|[0-9a-f]{57})\b/gu, '$1');
}

/**
 * One line as lines of at most `width` columns, broken at spaces. Continuation lines keep the line's own indent plus
 * two spaces (box rows "┃ " keep their bar). A word longer than a whole line is split.
 */
export function fold(line: string, width = VIDEO_WIDTH): string[] {
  if (visibleLength(line) <= width) return [line];
  const plainLead = /^(\s*(?:┃\s+)?(?:[-•]\s)?)/u.exec(line.replace(ANSI, ''))?.[1] ?? '';
  const lead = plainLead.includes('┃') ? `┃ ${' '.repeat(Math.max(0, plainLead.length - 2))}` : `${' '.repeat(plainLead.length)}  `;
  const out: string[] = [];
  const words = line.split(' ');
  let cur = words[0] ?? '';
  let curLen = visibleLength(cur);
  let fresh = false; // cur holds only the continuation indent
  const breakLine = (): void => {
    out.push(cur.trimEnd());
    cur = lead;
    curLen = lead.length;
    fresh = true;
  };
  for (const word of words.slice(1)) {
    const len = visibleLength(word);
    if (len > width - lead.length) {
      // A word too long for any line: split it (its colour codes are dropped).
      let rest = word.replace(ANSI, '');
      while (rest.length > 0) {
        const sep = fresh ? '' : ' ';
        const space = width - curLen - sep.length;
        if (space < 1) {
          breakLine();
          continue;
        }
        const piece = rest.slice(0, space);
        cur = `${cur}${sep}${piece}`;
        curLen += sep.length + piece.length;
        fresh = false;
        rest = rest.slice(piece.length);
        if (rest.length > 0) breakLine();
      }
      continue;
    }
    if (word !== '' && !fresh && curLen + 1 + len > width && cur.trim() !== '') breakLine();
    if (fresh) {
      if (word === '') continue; // no spaces at the start of a continuation line
      cur = `${cur}${word}`;
      curLen += len;
      fresh = false;
    } else {
      cur = `${cur} ${word}`;
      curLen += 1 + len;
    }
  }
  if (!fresh) out.push(cur.trimEnd());
  return out;
}

/** Tidy and fold a block of text (several lines). */
export function shape(text: string, roots: readonly string[], width = VIDEO_WIDTH): string {
  return text
    .split('\n')
    .flatMap((l) => fold(tidy(l, roots), width))
    .join('\n');
}

/**
 * The command context in video mode: `--video` taken out of argv, JURATOR_VIDEO=1 passed on, and out/err shaped for
 * a 100-column recording. Outside video mode, and for --json or --md output, the context is returned as it is
 * (apart from dropping `--video`).
 */
export function withVideo(ctx: CommandContext): CommandContext {
  if (!isVideo(ctx.env, ctx.argv)) return ctx;
  const argv = ctx.argv.filter((a) => a !== '--video');
  const env = { ...ctx.env, JURATOR_VIDEO: '1' };
  if (argv.includes('--json') || argv.includes('--md')) return { ...ctx, argv, env };
  const roots = rootSpellings(ctx.cwd);
  return {
    ...ctx,
    argv,
    env,
    out: (line) => ctx.out(shape(line, roots)),
    err: (line) => ctx.err(shape(line, roots)),
  };
}

/** "AI: muse-wonder-1.0 (live)" only for a live client; scripted answers and no model say so. */
export function modelLabel(model: { readonly id: string; readonly mode: 'live' | 'scripted' } | null): string {
  if (!model) return 'AI: off';
  return model.mode === 'live' ? `AI: ${model.id} (live)` : 'AI: scripted answers (offline)';
}
