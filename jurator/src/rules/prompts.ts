// Owner: WP-R. The one model task of the rules package: `rule-propose:<promiseId>` (the model writes, the program proves).
// Research basis: see "Research basis" in docs/DESIGN.md (rule proof, prompt injection).
import { z } from 'zod';
import { CODE_RULES, DATA_RULES, OUTPUT_RULES, joinPrompt } from '../model/preamble.js';

/**
 * Every field is required (Meta strict structured output); unused values are null or [].
 * The break and keep examples come before the pattern, so the model commits to the break shapes first.
 */
export const ruleAnswerSchema = z.object({
  feasible: z.boolean(),
  reason: z.string(),
  violationExamples: z.array(z.string()),
  keptExamples: z.array(z.string()),
  mode: z.enum(['must-match', 'must-not-match', 'each-near']).nullable(),
  pattern: z.string().nullable(),
  flags: z.string().nullable(),
  anchor: z.string().nullable(),
  within: z.number().nullable(),
  globs: z.array(z.string()),
  description: z.string().nullable(),
});
export type RuleAnswer = z.infer<typeof ruleAnswerSchema>;

export const RULE_PROPOSE_SCHEMA_NAME = 'rule_proposal';

const ROLE = `You write one fixed check (a "rule") for a company promise. The rule runs on every future code change with no AI, so its job is to catch the NEXT change that breaks the promise, written by a teammate or a coding agent who never saw today's code. Catching today's exact line is not enough.`;

const HOW = `How a rule runs
A rule is one JavaScript regular expression, run over the repo files that match "globs".
- must-match: some line must match "pattern" (the code that keeps the promise must stay).
- must-not-match: no line may match "pattern" (code that breaks the promise must never appear).
- each-near: every line that matches "anchor" must have a line matching "pattern" on the same line or within "within" lines after it (0 = same line). Example: every export route calls requireAdmin( within 3 lines.
Patterns run one line at a time. With flags "m", a must-match or must-not-match pattern runs over the whole file instead, so it can see one call written over several lines; "." still stops at a line end, so cross lines with a bounded class such as [^;]{0,200}.

How the program tests your rule before anyone sees it
1. It must PASS on the code shown.
2. It must FAIL on every line in "violationExamples": the program adds each one to a file the rule covers and runs the rule again (must-not-match, each-near). For must-match and each-near it also deletes what your "pattern" matches, and the rule must fail.
3. "keptExamples" keep the promise: a must-match pattern must match each of them; a must-not-match pattern must match none of them.
4. If the promise sets a value (such as "at most 30 days"), the program changes the number on the matched line to one that breaks the promise, and the rule must fail.
A rejected answer comes back to you once, with the program's reason.`;

const STEPS = `Work in this order
1. Find what the promise is really about: the data (password, card number, deleted notes), the action (log, store, export, delete), and the guard, filter or setting that keeps it in this code (requireAdmin(, exportableNotes(, CHAT_TTL_DAYS).
2. Write violationExamples first: 3 new lines a teammate could plausibly add that break the promise, each in a DIFFERENT way: another call (log( and console.error(), another route or HTTP method, another file, other variable names, the bad value on the second line of one call (write the line break as \\n, only with flags "m"). The first example must use a call this repo already uses (the program checks it: if this repo logs with log(, write log(, not console.log(). Write them in this repo's style. For must-match: [].
3. Write keptExamples: 2 lines that keep the promise but differ from the code shown (other variable names, quotes, spacing, argument order), so a harmless edit does not break the rule. For must-not-match, make one of them a near miss that is fine, e.g. log('login', { userId }). For each-near: [].
4. Only then write the pattern: it must catch every violation example and pass every kept example.`;

const GENERAL = `General, not narrow
- Build the pattern from STABLE names: the guard or filter function, the exported constant or setting key, the sensitive field the promise names, the kind of call (any logger, any route).
- Never build it from INCIDENTAL text: local variable or parameter names (plain, all, notes), today's exact path ('/export'), argument order, spacing, quote style. Use \\s* for spaces, ['"\`] for quotes, \\w+ for a name that can vary, alternatives for synonyms (log|console\\.\\w+|logger\\.\\w+), and flag "i" when case can vary.
- Never match a comment: a rule that only finds "// retention: 30 days" proves nothing. Match the code.
- The forbidden thing is the target, not the line around it: for "never log card numbers", match any logging call that mentions a card-number field.
- For "never store, write, upload or cache X", the pattern must contain the write call (\\.set\\w*\\(, setItem\\(, put_object\\(, \\.upload\\w*\\(), never a bare noun (cache, storage, s3, bucket, indexedDB, session): that also matches reads, names and messages. Deleting, clearing and reading keep such a promise; make one keptExample a delete. Use this code's names; if a policy name (localStorage, S3) is a wrapper here, match what it calls; if the data's name is unclear, forbid the sink call itself.
- For "X must always go through Y", prefer each-near with the raw access as the anchor (every line that reads db.notes must call exportableNotes( on the same line: within 0) over a must-not-match on one misuse.
- For each-near, the anchor must match every line of its kind, including ones added later: any HTTP method (router\\.\\w+\\(), any path that names the thing (['"\`][^'"\`]*export), not only today's routes.
- For a value: must-match on the named constant or setting that holds it, in the file that sets it, checking the number in the unit the code counts in (a ttl is usually seconds: 24 hours = 86400; use the number pattern given below when there is one). No flag "m" for a value rule.
- globs: repo-relative; cover every folder where code of this kind could be added later (src/**/*.ts for "never log X", src/routes/**/*.ts for routes), but leave out files where the pattern would match on purpose.
- Stay precise: if a general pattern hits a legitimate line today, narrow the globs or the pattern; do not drop the variants.`;

const SAFETY = `Safety
- Escape regex characters such as ( ) . [ { with a backslash. No back-references. No group that repeats and has its own repeats or | inside, like (a+)+ or (a|b)*. Bounded repeats like [^;]{0,200} are fine.
- Keep the pattern under 200 characters (the program rejects more than 400). Prefer a few precise alternatives built from the stable names this code uses over a long list of every synonym, vendor or provider name: a long alternation is slow to read, easy to get wrong and still misses the next name.
- flags: "", "i", "m" or "im".`;

const FIELDS = `The fields, in this order
- feasible and reason: if no pattern in code can check this promise (it is about people, a process, or behaviour you cannot see in code), feasible=false with one plain sentence in "reason", the other fields null and the lists []. A promise that code acts when a request or event arrives is checkable: anchor on the handler (each-near) or require the route (must-match); if no handler exists, that is "Breaks now:", not feasible=false. If the code shown already breaks the promise, still write the rule as it would pass on code that keeps the promise (feasible=true), start "reason" with "Breaks now:" then every path:line that breaks it (as in the "=== " headers) and what is wrong. The program runs the rule on the whole scope; if it fails on a line you did not name, those lines come back to you: name them or narrow the rule. Put the fixed line (what that line should say) first in keptExamples, even for each-near. The program fixes the code in memory, proves the rule there, and reports the promise as broken today. Otherwise feasible=true and "reason" says in one sentence which future changes this rule catches.
- violationExamples, keptExamples: as in the steps above.
- mode, pattern, flags: the rule.
- anchor and within (0 to 10): each-near only, else null.
- globs: as above.
- description: one plain sentence saying what the rule checks in general terms, e.g. "Every route whose path mentions export calls requireAdmin( within 3 lines."`;

export const RULE_PROPOSE_INSTRUCTIONS = joinPrompt(
  ROLE,
  `${DATA_RULES}\n${CODE_RULES}`,
  HOW,
  STEPS,
  GENERAL,
  SAFETY,
  FIELDS,
  OUTPUT_RULES,
);

// FU-1: the repair task `rule-repair:<promiseId>` (round 2: `rule-repair:<promiseId>:2`). New text, added on top of the
// propose prompt (which is unchanged): the writer sees the red team's confirmed evasions and writes a stronger rule.
const REPAIR = `Repairing a rule after a red team
A red team changed the code so that it BREAKS the promise while the current rule still PASSES, and a judge that read the changed code confirmed each break. They are listed below as "Evasions", each with the lines it removes (-) and adds (+) and why it breaks the promise.
Write ONE stronger rule for the same promise. The program keeps it only if it:
1. passes on the code shown (today's code keeps the promise);
2. FAILS on every evasion: the program applies each change in memory and runs your rule;
3. still fails on the breaks the current rule caught (listed as "Breaks the current rule catches", plus its violation examples) and passes the listed harmless changes and kept examples;
4. passes all the usual tests above (it can fail when the guarding code is removed, and on a value that breaks the promise).
Catch the KIND of change, not the evasion's exact text: if the guard was wrapped in try/catch, require the guard to stand as its own statement; if a value was computed or moved, read the value where it is used; if a new route or file skipped the guard, widen the anchor or the globs. The rule may change mode, pattern, anchor and globs.
If one regular expression cannot catch an evasion without false alarms on today's code, answer feasible=false and start "reason" with "Cannot close:" and one plain sentence on why. Never weaken the rule to make it pass.`;

export const RULE_REPAIR_INSTRUCTIONS = joinPrompt(
  ROLE,
  `${DATA_RULES}\n${CODE_RULES}`,
  HOW,
  STEPS,
  GENERAL,
  SAFETY,
  REPAIR,
  FIELDS,
  OUTPUT_RULES,
);
