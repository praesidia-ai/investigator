// Owner: WP-K. The one prompt the check sends: an AI read of code against one promise (fallback when no rule exists).
// Research basis: see "Research basis" in README.md (judging, prompt injection).
import { z } from 'zod';
import type { PromiseRecord } from '../contracts.js';
import { CODE_RULES, DATA_RULES, OUTPUT_RULES, joinPrompt } from '../model/preamble.js';
import { facetsLine } from '../policy/facets.js';

/**
 * Every field required (Meta strict structured output). The program re-checks every citation.
 * Evidence first: strict JSON is written in key order, so the model cites and explains before it decides.
 */
export const aiReadSchema = z.object({
  citations: z.array(
    z.object({
      path: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
    }),
  ),
  explanation: z.string(),
  verdict: z.enum(['kept', 'broken', 'cant-tell']),
});
export type AiReadAnswer = z.infer<typeof aiReadSchema>;

const ROLE = [
  'You check whether code keeps one promise from a company policy. A wrong "kept" lets a broken promise ship; a wrong',
  '"broken" wastes an engineer\'s time; "cant-tell" is the honest answer when the code shown cannot decide it.',
  '',
  'What you get: the promise, its kind (must, must-not or may), its facets (subject, action, constraint) when known,',
  'the exact policy text it came from, how many files in its scope were left out, and the code files in its scope.',
].join('\n');

const STEPS = [
  'How to decide (work through these steps before you write anything)',
  '1. State what the code must do, or must never do, to keep this promise. Apply the constraint exactly: "<= 30 days"',
  '   is kept by 30 or less and broken by 31 or 90.',
  '2. Find every place in the files shown where that happens or should happen: the value or the check itself, and every',
  '   route, tool or function that reaches it, plus any shared wrapper, middleware or filter that could cover it.',
  '3. Choose the verdict:',
  '   - "broken": lines shown clearly break the promise. Either they do the forbidden thing or set a different value',
  '     than promised, or a path whose whole function is shown skips the required step and nothing shown (a wrapper,',
  '     a caller, middleware) adds it back.',
  '   - "kept": lines shown carry out the promise (the value, the guard, the filter) and every path you found in step 2',
  '     goes through them. For a must-not promise, "kept" needs either a mechanism that prevents the forbidden thing,',
  '     or no files left out and no shown code that could do it; then cite where the data leaves (the send, the log',
  '     call).',
  '   - "cant-tell": the deciding code is not shown (the code calls, imports or reads something that decides the answer',
  '     but is not in the files, or files were left out and the answer could depend on them), or the promise is about',
  '     something code cannot show (a contract, a staff process), or your only evidence is a comment or a name. Do not',
  '     answer "cant-tell" only because unseen code might in theory change the answer: if every path in the files',
  '     shown keeps or breaks the promise, say so.',
].join('\n');

const FIELDS = [
  'What to write, in this order',
  '- citations: the lines that prove your answer, using the path exactly as given and the line numbers printed on the',
  '  left; at most 5 ranges, each at most 15 lines, most important first. Cite lines that run, not comments. For',
  '  "broken", cite only the lines that break the promise, not lines that keep something else. For "kept", cite the',
  '  lines that carry it out. For "cant-tell", cite the line that calls or reads the missing code, or nothing.',
  '- explanation: one or two plain sentences an engineer can act on. Name the file and the function, route or',
  '  constant. For "broken", say what to change. For "cant-tell", name exactly what is missing (a file, a function, a',
  '  setting).',
  '- verdict: "kept", "broken" or "cant-tell"; it must agree with the citations and explanation you wrote.',
].join('\n');

export const AI_READ_INSTRUCTIONS = joinPrompt(ROLE, `${DATA_RULES}\n${CODE_RULES}`, STEPS, FIELDS, OUTPUT_RULES);

export interface AiReadFile {
  readonly path: string;
  readonly text: string;
}

export function numbered(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join('\n');
}

export function aiReadInput(promise: PromiseRecord, files: readonly AiReadFile[], omitted: number): string {
  const where = promise.quote.jsonPointer ? ` ${promise.quote.jsonPointer}` : '';
  const parts = [
    `Promise ${promise.id} (${promise.kind}): ${promise.wording}`,
    ...(promise.facets ? [`Facets: ${facetsLine(promise.facets)}`] : []),
    `Policy text (${promise.quote.alias}${where}): "${promise.quote.text}"`,
    '',
    omitted > 0
      ? `Files in scope: ${files.length + omitted}; shown below: ${files.length}; left out for size: ${omitted}.`
      : `Files in scope: ${files.length}; all shown below.`,
  ];
  for (const file of files) parts.push('', `=== ${file.path}`, numbered(file.text));
  return parts.join('\n');
}
