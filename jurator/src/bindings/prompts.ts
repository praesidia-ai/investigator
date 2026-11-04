// Owner: WP-B. The one model task of the bindings package: `bind:<promiseId>` (the model points, the program copies).
// Research basis: see "Research basis" in docs/DESIGN.md.
import { z } from 'zod';
import { CODE_RULES, DATA_RULES, OUTPUT_RULES, joinPrompt } from '../model/preamble.js';

/** Every field is required (Meta strict structured output); a missing name is null. */
export const bindAnswerSchema = z.object({
  locations: z.array(
    z.object({
      name: z.string().nullable(),
      path: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      kind: z.enum(['constant', 'config', 'guard', 'allowlist', 'call', 'other']),
      why: z.string(),
    }),
  ),
});
export type BindAnswer = z.infer<typeof bindAnswerSchema>;

export const BIND_SCHEMA_NAME = 'promise_bindings';
export const MAX_LOCATIONS = 5;
export const bindTaskKey = (promiseId: string): string => `bind:${promiseId}`;

const ROLE = `You point at the lines of code where a company promise is decided, so that a change to those lines triggers a fresh check of that promise. You do not judge whether the promise is kept; another step does that.

Bind the lines that decide whether the promise is kept, whether the code keeps it today or breaks it. If the promise looks broken (for example a tool that should be guarded has no guard), still point at the line where it is decided: the definition of that tool, route or value.`;

const STEPS = `How to find them
1. Take the concrete words from the promise, the policy quote and the typed facets: identifiers (tool, route, field, role or key names), numbers with units, algorithm or vendor names. Look for those exact words in the code first.
2. For each hit, find the line that defines it (a constant, a config key, a list entry, a function or tool definition), not an import, a comment, a type or a test.
3. Follow it one step: the line that applies it (the guard call on that tool or route, the comparison that uses the constant, the filter that uses the list).
4. Keep at most ${MAX_LOCATIONS} locations, the most decisive first.

What to bind, by the shape of the promise
- A value ("at most 30 days", "hashed with argon2", "admins only"): the line that sets the value (kind "constant" or "config") and the line that applies it.
- A rule about one named thing ("tool X needs approval"): the definition line of X (kind "allowlist" when X is an entry in a list or map of allowed things) and the guard call on X if there is one (kind "guard").
- A rule about every thing of a kind ("every export route checks the role"): the guard line of each existing one, up to the limit.
- A "never" promise ("never logs passwords", "never shares with advertisers"): bind only a choke point that every path must pass through and that names the subject, such as a filter or denylist of those fields, or the one function through which the data leaves to a third party. If the code has no such place, answer {"locations": []}.

Answer {"locations": []} when
- the promise is about people, process, contracts or timing outside the code (training, telling users, legal review);
- none of the promise's concrete words or its subject appears in the code shown, and there is no choke point as above;
- the only candidates are generic plumbing that any feature uses (a route registration, a response send, a logger call, an HTTP helper) and the promise does not name that exact route or call.
An empty answer is safe: the check then reads every file in the promise's scope. A wrong or partial location is not: later checks may skip code that matters.

Kinds: "constant" (a named value in code), "config" (a key in a config file or object), "guard" (a call that allows or blocks, such as a role check or an approval), "allowlist" (a list, set or map of what is allowed or blocked, or one entry of it), "call" (the one call through which the data leaves), "other".

Examples from a different codebase (not the one below)
- "Sessions end after 15 idle minutes": SESSION_IDLE_MIN = 15 (constant) and if (idle > SESSION_IDLE_MIN) logout() (other).
- "Only owners can delete a project": requireRole(req, 'owner') in the delete route (guard).
- "The bot may call the weather tool only after approval": the weather entry in the bot's tool map (allowlist) and approve('weather', ...) inside it (guard); if approve is missing, the weather entry alone.
- "We never send emails to third parties": nothing sends to a third party and there is no single sender, so {"locations": []}.
- "Staff complete privacy training every year": {"locations": []}.`;

const FIELDS = `For each location, in this order
- name: the identifier written on those lines that the location is about (constant, key, list entry, tool, function or guard name); null only if the lines hold no identifier. The program drops a location whose lines do not contain the name.
- path: a file shown below, exactly as written after "=== ". Never a file listed under "Other files not shown".
- startLine, endLine: the numbers shown before "| " (endLine >= startLine, at most 20 lines, usually 1). Point at the line itself, not the whole function.
- kind: one of the kinds above.
- why: one plain sentence: what on this line decides the promise, and what change here would break it.`;

export const BIND_INSTRUCTIONS = joinPrompt(ROLE, `${DATA_RULES}\n${CODE_RULES}`, STEPS, FIELDS, OUTPUT_RULES);
