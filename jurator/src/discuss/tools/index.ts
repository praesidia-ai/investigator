// Owner: DS-A. The discuss tools: read-only, bounded, results cut at a size limit before the model reads them.
import type { z } from 'zod';
import type { ToolDefinition } from '../../model/meta/model-provider.js';
import { stripOptionalNulls, toStrictJsonSchema, type StrictSchema } from '../../model/strict.js';
import { DISCUSS_LIMITS, DISCUSS_TOOL_NAMES, type DiscussToolName } from '../contract.js';
import { listFiles, readLines, searchCode } from './code.js';
import { comparePolicies, explainPromise, lastCheck, listPromises, listRules, policyText, showFinding } from './promises.js';
import { proposeAction, proposePolicyEdit } from './actions.js';
import type { DiscussTool, ToolContext, ToolOutcome } from './types.js';

export { CodeReader } from './code-reader.js';
export type { DiscussTool, ProposalHost, ToolContext, ToolOutcome } from './types.js';

const ALL = [
  listPromises,
  explainPromise,
  lastCheck,
  showFinding,
  listRules,
  searchCode,
  readLines,
  listFiles,
  policyText,
  comparePolicies,
  proposeAction,
  proposePolicyEdit,
] as unknown as DiscussTool[];

const BY_NAME = new Map<string, { tool: DiscussTool; strict: StrictSchema }>(
  ALL.map((tool) => [tool.name, { tool, strict: toStrictJsonSchema(tool.args as z.ZodType, tool.name) }] as const),
);

export function isDiscussTool(name: string): name is DiscussToolName {
  return (DISCUSS_TOOL_NAMES as readonly string[]).includes(name);
}

/** The tool list sent to the model (strict JSON Schema parameters), in DISCUSS_TOOL_NAMES order. */
export function toolDefinitions(): ToolDefinition[] {
  return DISCUSS_TOOL_NAMES.map((name) => {
    const entry = BY_NAME.get(name);
    if (!entry) throw new Error(`discuss tool ${name} is missing`);
    return { name, description: entry.tool.description, parameters: entry.strict.schema };
  });
}

export interface ToolRun {
  readonly label: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: ToolOutcome;
  /** What the model reads: the outcome's text, cut at the limit. */
  readonly modelText: string;
  /** True when the tool or the size limit cut the result. */
  readonly truncated: boolean;
}

/** The label of a call before it runs (args not yet checked: a plain fallback). */
export function labelFor(name: DiscussToolName, raw: unknown): string {
  const entry = BY_NAME.get(name);
  if (!entry) return name;
  const parsed = entry.tool.args.safeParse(stripOptionalNulls(raw, entry.strict));
  return parsed.success ? entry.tool.label(parsed.data as Record<string, unknown>) : name;
}

/** Cuts text for the model at the result limit and says so. */
export function capForModel(text: string, max: number = DISCUSS_LIMITS.maxToolResultChars): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const note = `\n[result cut at ${max} characters: ask for less, e.g. a narrower query or fewer lines]`;
  return { text: text.slice(0, Math.max(0, max - note.length)) + note, cut: true };
}

/** Runs one tool call. Bad arguments and failures come back as ok:false outcomes; it never throws. */
export async function runTool(name: DiscussToolName, raw: unknown, ctx: ToolContext): Promise<ToolRun> {
  const entry = BY_NAME.get(name);
  const args = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (!entry) {
    const outcome: ToolOutcome = { ok: false, summary: 'no such tool', text: `There is no tool "${name}".` };
    return { label: name, args, outcome, modelText: outcome.text, truncated: false };
  }
  const parsed = entry.tool.args.safeParse(stripOptionalNulls(args, entry.strict));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join('.')}: ` : '';
    const outcome: ToolOutcome = { ok: false, summary: `bad input: ${where}${issue?.message ?? 'invalid arguments'}`, text: `Bad arguments for ${name}: ${where}${issue?.message ?? 'invalid'}.` };
    return { label: name, args, outcome, modelText: outcome.text, truncated: false };
  }
  const label = entry.tool.label(parsed.data as Record<string, unknown>);
  let outcome: ToolOutcome;
  try {
    outcome = await entry.tool.run(parsed.data as Record<string, unknown>, ctx);
  } catch (error) {
    const message = error instanceof Error && 'code' in error ? error.message : 'the tool failed';
    outcome = { ok: false, summary: `failed: ${message.slice(0, 120)}`, text: `${name} failed: ${message}` };
  }
  const capped = capForModel(outcome.text);
  return { label, args, outcome, modelText: capped.text, truncated: capped.cut || outcome.truncated === true };
}
