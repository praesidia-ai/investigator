// Owner: DS-C. The two proposal tools. Neither runs or writes anything: each asks the session to show a card (an action
// to confirm, a policy edit to /apply) and tells the agent that only the user can make it happen.
import { z } from 'zod';
import { BRAND } from '../../brand.js';
import { DISCUSS_ACTION_COMMANDS } from '../contract.js';
import { estimateText } from '../actions/catalog.js';
import { type DiscussTool, refused } from './types.js';

const cmd = BRAND.command;

const actionArgs = z.object({
  command: z
    .string()
    .min(1)
    .max(60)
    .describe(`One of: ${DISCUSS_ACTION_COMMANDS.join(', ')}. Decisions (accept, rule accept, waive, conflicts, policy edits) are never actions.`),
  promiseIds: z.array(z.string().min(1).max(80)).max(50).optional().describe('rule propose / bind / explain: the promise ids (default: all that need it).'),
  diffBase: z.string().min(1).max(100).optional().describe('check: only the changes since this git ref, e.g. "main".'),
  noAi: z.boolean().optional().describe('check: rules only, no AI reads (free).'),
  why: z.string().min(1).max(400).describe('One sentence for the user: why this step, now.'),
});

export const proposeAction: DiscussTool<z.infer<typeof actionArgs>> = {
  name: 'propose_action',
  description:
    `Proposes ONE ${BRAND.name} command for the user to run (compile, rule propose, bind, check, report, explain, pull, status). ` +
    'Nothing runs now: the program shows the user a card with the command, your reason, and its estimated cost and time, and runs it ' +
    'only if they confirm; then you get the result to discuss. A new proposal replaces the one waiting.',
  args: actionArgs,
  label: (a) => `propose_action ${a.command}${a.promiseIds?.length ? ` ${a.promiseIds.join(',')}` : ''}${a.diffBase && !/^\s*(null|none|undefined)?\s*$/iu.test(a.diffBase) ? ` --diff ${a.diffBase}` : ''}${a.noAi ? ' --no-ai' : ''}`,
  async run(a, ctx) {
    if (!ctx.proposals) return refused('actions are off', 'This session cannot run actions. Give the user the exact command to type instead.');
    const built = ctx.proposals.action({ command: a.command, promiseIds: a.promiseIds, diffBase: a.diffBase, noAi: a.noAi, why: a.why });
    if (!built.ok) return refused(built.summary, built.text);
    const c = built.card;
    return {
      ok: true,
      summary: `card shown: ${c.line} · ${estimateText(c)}`,
      text:
        `Shown to the user as a card: \`${c.line}\` (${estimateText(c)}; ${c.estimate.basis}). It runs only if the user confirms ` +
        '(Enter or y); you will then get the result. Do not say it ran. End your answer now in a sentence or two (what it does and why); ' +
        'do not ask the same question again in text.',
    };
  },
};

const editArgs = z.object({
  source: z.string().min(1).max(80).describe('The policy source alias (or its file path), as policy_text names it.'),
  start: z.number().int().min(1).describe('First line to replace (line numbers from policy_text).'),
  end: z.number().int().min(1).describe('Last line to replace.'),
  newText: z.string().max(8000).describe('The new wording for those lines (plain policy text, no line numbers).'),
  why: z.string().min(1).max(400).describe('One sentence for the user: what is clearer or more exact now.'),
});

export const proposePolicyEdit: DiscussTool<z.infer<typeof editArgs>> = {
  name: 'propose_policy_edit',
  description:
    'Drafts new policy wording as a diff of the policy file (the current lines are copied by the program). Nothing is written: the ' +
    `user applies it with /apply, then ${cmd} compile re-reads the policy. Read the lines with policy_text first.`,
  args: editArgs,
  label: (a) => `propose_policy_edit ${a.source}:${a.start}${a.end > a.start ? `-${a.end}` : ''}`,
  async run(a, ctx) {
    if (!ctx.proposals) return refused('edits are off', 'This session cannot draft policy edits.');
    const built = await ctx.proposals.edit({ source: a.source, start: a.start, end: a.end, newText: a.newText, why: a.why });
    if (!built.ok) return refused(built.summary, built.text);
    const e = built.card;
    return {
      ok: true,
      summary: `diff shown: ${e.path}:${e.startLine}${e.endLine > e.startLine ? `-${e.endLine}` : ''}`,
      text:
        `Shown to the user as a diff of ${e.path} lines ${e.startLine}-${e.endLine}. Nothing is written until they type /apply; after that the ` +
        `program offers ${cmd} compile. Do not say it was changed. End your answer briefly: what the new wording makes clearer.`,
    };
  },
};
