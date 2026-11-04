// Owner: DS-A. The shape of a discuss tool: read-only, bounded, and the program makes its label and summary.
import type { z } from 'zod';
import type { Citation } from '../../contracts.js';
import type { DiscussToolName, PolicyExcerpt } from '../contract.js';
import type { DiscussWorkspace } from '../core/workspace.js';
import type { ActionRequest, BuildResult } from '../actions/catalog.js';
import type { EditBuild, EditRequest } from '../actions/policy-edit.js';
import type { CodeReader } from './code-reader.js';

export interface ToolContext {
  readonly ws: DiscussWorkspace;
  readonly code: CodeReader;
  /** DS-C: where proposals go (the session shows the card). Absent: the proposal tools refuse. */
  readonly proposals?: ProposalHost | undefined;
}

/** DS-C: the session side of propose_action / propose_policy_edit. Builds and keeps the card; never runs anything. */
export interface ProposalHost {
  action(req: ActionRequest): BuildResult;
  edit(req: EditRequest): Promise<EditBuild>;
}

export interface ToolOutcome {
  readonly ok: boolean;
  /** One short line for the screen, made by the program. */
  readonly summary: string;
  /** What the model reads (plain text, cut at DISCUSS_LIMITS.maxToolResultChars by the runner). */
  readonly text: string;
  /** Code copied from git at the snapshot (or at a run's commit), masked. */
  readonly evidence?: readonly Citation[];
  readonly policy?: readonly PolicyExcerpt[];
  /** True when the tool itself cut its result at a limit (rows, hits, lines). */
  readonly truncated?: boolean;
}

export interface DiscussTool<A = Record<string, unknown>> {
  readonly name: DiscussToolName;
  readonly description: string;
  readonly args: z.ZodType<A>;
  /** One short line for the screen, e.g. `search_code "upload"`. */
  label(args: A): string;
  run(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

/** A failed tool call: the model reads `text`, the screen shows `summary`. */
export function refused(summary: string, text = summary): ToolOutcome {
  return { ok: false, summary, text };
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line, at most `max` characters (… at the end when cut). */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}
