# How Jurator works

The command reference is in the [README](../README.md). This page explains how Jurator decides, what it was measured on,
the research behind each design choice, what is not built yet, and what came from Investigator.

## How it decides

1. **A rule is the only thing that says HOLDS or BROKEN.** Rules are plain patterns that run with no AI. The model
   writes them (`jurator rule propose`); the program proves each rule passes today and fails when the guarding line
   is removed, before saving it. Rules read code, not comments. A rule on a number reads the value the constant is set
   to: `CHAT_TTL_DAYS = 30 * 3` is 90 and BROKEN, and a value it cannot compute (a call, another name) fails as "not a
   literal". An each-near rule that finds nothing to check is an error, not a pass. Every pattern runs in a worker
   with a 2-second budget per scan. `rule propose --redteam` asks Muse Spark to break each new rule's promise while the
   rule still passes, and Muse Wonder judges each edit the rule missed. Each confirmed evasion goes back to the rule
   writer for a repair (up to 2 rounds). The program re-proves the repair: it must still pass today, fail on the old
   breaks and on every evasion, and keep passing the harmless edits. Then Spark attacks it again. Each rule ends with
   "evasion closed" or "still evadable: <how>". `rule test` re-runs the stored evasions
   (`.jurator/local/rule-mutants.json`), and `--budget <usd>` (default $10 for the whole run) caps the spend.
2. **An AI read is a hint, and it needs evidence.** A LOOKS KEPT that cites only comments or strings becomes CAN'T
   TELL. A LOOKS BROKEN needs 2 of 3 separate answers that agree, otherwise it becomes CAN'T TELL ("answers
   disagreed"). Before code goes to the model, secrets in it (API keys, tokens, private keys, passwords) are masked
   with line counts unchanged, and `.env*`, `*.pem` and `*.key` files are never sent.
3. **The model proposes, the program decides.** The program finds every policy quote in the policy text, word for
   word, and copies every code quote from git at a commit. Text written by the model never becomes evidence.
4. **Read-only connectors.** Credentials stay in code; the model only sees text that was already fetched.

### Levels

| Level | Who decides | Words it may use | Blocks a push? |
|---|---|---|---|
| `rule` | An accepted rule, no AI | **HOLDS** / **BROKEN** | Yes, BROKEN blocks in `block` mode |
| `ai-read` | A model read the changed code (no rule exists yet) | LOOKS KEPT / LOOKS BROKEN / CAN'T TELL | No, a hint only |
| `quick` | The change touches the promise's files; nothing judged | TOUCHED, NOT CHECKED | No |
| (process) | A person, before merge | PR checklist item ("Before merge: ...") | No |

Every check saves a record (`.jurator/local/runs/<id>/run.json`). `jurator verify <run.json>` re-checks it with no
AI: it recomputes the digest, re-reads every quoted line from git, and re-runs every recorded rule at the record's
commit, so a record edited by hand (BROKEN turned into HOLDS, digest recomputed) does not verify. The pre-push and
agent hooks run the rules committed at the push base, so a branch cannot weaken its own rule.

Exit codes: `0` ok · `1` a promise is broken (block mode) or drift found · `2` the tool failed or bad input.

## Bindings and incremental checks

**Bindings** (`.jurator/bindings.json`) record where each promise lives in the code: a constant
(`privacy.01 -> src/agent/chats.ts:2 CHAT_TTL_DAYS, expects <= 30 days`), a guard call (`requireAdmin`), a config key
or an allowlist. Rules give bindings with no AI (`rule propose --accept` saves them); `jurator bind` asks the model for
the rest, and the program checks every location and copies its lines from git. `jurator bind list` shows each one as
unchanged, moved, changed (with the new value) or lost. In `check --diff`, a change to a bound line selects its promise
and says why: `touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to privacy.01)`.

**Incremental checks.** Every check records the pair it verified, (code commit, policy state), where the policy state
is a digest of the accepted promises and rules. Results are cached by content (promise + rules + the code they read),
so a check never rescans everything from the start:

- same code, same policies: "Nothing to recheck" (no file read, no rule run, no AI call);
- code changed: only promises whose files or bound lines changed; reused results have their cited lines re-copied
  from git at the new commit, so `verify` still passes;
- policies changed, code did not: only the new or changed promises;
- `jurator check --full` rechecks everything. `jurator status` shows the last verified pair.

## Bench and real repos

`jurator bench` applies 5 planted breaks and 3 harmless changes to a copy of acme-notes and scores each way of
checking. The fresh live run on today's `main` (`fixtures/bench/live/2026-11-04-live-v2.txt`, 4 Nov 08:11, $2.79):

| Method | Catches | False alarms | Wrong flags | Cost |
|---|---|---|---|---|
| Rules only (no AI) | 4/5 | 0/3 | 0 | $0 |
| AI read of every promise, Muse Wonder | 5/5 | 1/3 | 4 | $1.70 |
| AI read of every promise, Muse Spark | 5/5 | 2/3 | 7 | $0.54 |
| Plain skill-style prompt, Muse Wonder | 5/5 | 0/3 | 0 | $0.11 |
| Jurator (rules, else a Wonder read) | 5/5 | 0/3 | 0 | $0.60 |

On this small app a plain skill prompt catches as much as Jurator, for less. Jurator's edge is what a prompt cannot
give: a rule's verdict is the same on every run and costs $0, `verify` re-checks a record with no AI, and checks are
incremental. Reading every promise with AI raises false alarms (1 to 2 of 3 harmless changes flagged, and 4 to 7 flags
on promises the change does not break). AI reads vary between runs: in the earlier run
(`2026-11-04-live.txt`, before the rule-engine fixes) Spark had 0/3 false alarms and the rules caught 3/5. The bench AI
rows make one call per read; they do not use the check's 2-of-3 vote.

**Red team.** In the bench run, Muse Spark found an edit that breaks the promise and passes the rule for **6 of 6
rules** (for example `if (workspaceId.length > 0) void 0; else await approvalGate(...)`), and Muse Wonder confirmed each one: a
HOLDS covers the break shapes the rule was proven on, not every way to break a promise. The repair loop
(`rule propose --all --redteam`, live on an acme-notes clone,
`fixtures/bench/live/2026-11-04-redteam-loop.txt`):

| Rules written | Evasions confirmed | Closed by a proven repair | Still open | Cost |
|---|---|---|---|---|
| 8 of 9 | 24 (all 8 rules weak on the first attack) | 7 (privacy.02 3/3, privacy.01 2/2, praesidia.01 2/5) | 17 | $2.16 |

The run went $0.16 over its $2 cap (4 rules ran at once); the cap now also gates the first attack, but calls already
running can still pass it. Most repairs were skipped at the cap. Repairs tend to fit the exact evasion: Spark broke
the repaired praesidia.01 rule again at once. One privacy.01 repair was found after the run to pass if the constant is
deleted; repairs must now also fail on each older version's simulated break, so 5 of the 7 are certain under today's
check (not re-run).

[`docs/REAL-REPOS.md`](REAL-REPOS.md) has live runs on GoatCounter (Go, 484 files) and Documenso (TypeScript
monorepo, 3,008 files): every policy quote found word for word, 8 rules accepted on each after review (9 of 25
rejected, most as too broad), and two real gaps between a policy and the code, each confirmed by reading the code.

## Research basis

Where research says models fail, the program checks. Each line below is true in the code today.

| What the code does | Why (research) |
|---|---|
| The AI never fails a build; only a rule's BROKEN exits 1. | On realistic vulnerability data GPT-4 does about as well as random guessing ([PrimeVul, ICSE 2025](https://arxiv.org/abs/2403.18624)). |
| AI verdicts are only LOOKS KEPT / LOOKS BROKEN / CAN'T TELL, and must cite real lines. | Renaming variables changes GPT-4's security answer in 17% of cases ([Ullah et al., IEEE S&P 2024](https://arxiv.org/abs/2312.12575)). |
| Every cited line is copied from git by the program; a kept that cites only comments or strings becomes CAN'T TELL. | The best models leave citations without full support half the time ([ALCE, EMNLP 2023](https://arxiv.org/abs/2305.14627)). |
| A LOOKS BROKEN needs 2 of 3 answers that agree. | A majority vote over separate answers beats one answer ([Self-Consistency, ICLR 2023](https://arxiv.org/abs/2203.11171)). |
| Policy quotes are found word for word; prose is not turned into logic. | The best models reach 44.4% on DeonticBench's hard rule tasks ([2026](https://arxiv.org/abs/2604.04443)). |
| A rule is kept only if it passes today and fails on a simulated break (and, with `--redteam`, on each confirmed evasion). | The before/after check behind KNighter's 92 Linux bugs ([SOSP 2025](https://arxiv.org/abs/2503.09002)) and the mutation idea behind Meta's ACH ([2025](https://arxiv.org/abs/2501.12862)). |
| No vector search: the model points to code, the program verifies the location. | Embedding retrieval found under 7% of true doc-to-code links on the largest projects ([LiSSA, ICSE 2025](https://publikationen.bibliothek.kit.edu/1000179816/164563088)). |
| The model gets no tools; secrets are masked before code is sent; `.env*`, `*.pem`, `*.key` are never sent. | Adaptive attacks bypassed 12 prompt-injection defences ([Nasr et al., 2025](https://arxiv.org/abs/2510.09023)); 35% of private repos hold a plaintext secret ([GitGuardian 2025](https://www.gitguardian.com/state-of-secrets-sprawl-report-2025)). |

Every prompt was A/B-tested live before it was kept (Muse Wonder, fixed cases from the demo app, mostly single runs,
$2.95):

| Prompt | Old | New |
|---|---|---|
| Promise extraction (compile) | 7/10 | 10/10 |
| Rule writing | 4/10 | 9/10 |
| Code linking (bind) | 8/10 | 10/10 |
| AI read | 17/18 | 18/18 |
| Conflicts | 9/12 | 9/12 (a tie: each version finds a clash the other misses) |

## Not built yet

Named in plans or in the output, but not in the code today:

- **PR comment from CI.** `jurator check --md` prints the comment; there is no GitHub Action or other CI step that
  posts it.
- **Muse Spark beyond the red team.** Spark attacks rules (`rule propose --redteam`, `bench`) and has live bench runs
  as an AI reader; every other step uses Muse Wonder.
- **Muse Code.** `hook install muse` writes a `PreToolUse` hook to `.muse/hooks.json`, and
  `templates/agents/muse/` holds an MCP config; neither has run in a live Muse session.
- **Connectors.** Local files and a recorded Praesidia export in the repo. Live Praesidia API reads stop with "not
  built yet"; Drata, Vanta and AWS are on the roadmap.
- **`waive`.** There is no waive command: fix the code, or change the policy and compile again.
- **Hooks fail open by default.** A rule error, a timeout or an internal error lets the push through with a loud
  `WARNING`. `--fail-closed` (`hook install pre-push claude --fail-closed`) or `JURATOR_FAIL_CLOSED=1` blocks it
  instead (exit 2, "could not be checked").
- **The agent hook reads commands; it is not a shell.** It sees a push inside `bash -c`, `eval`, `$(...)`, `xargs`,
  `python -c`, `&&`/`;` chains and env prefixes, and denies an agent that runs `accept`, `rule accept` or `decide`,
  edits `.jurator/` or changes the hooks. It does not see a push from a script file (`python3 push.py`,
  `npm run deploy`), a git alias or `gh`; the pre-push hook still runs then, with the rules committed at the push base.
- **A "ran it" level** (running the code, as Investigator does). Today only a rule can say BROKEN and fail a build.

## What was pre-existing

Built during the hackathon sprint (4 Nov 2026), except the Meta model provider, ported from
[praesidia-ai/investigator](https://github.com/praesidia-ai/investigator) at `d49aaea` (Apache-2.0), plus its
uncommitted `parallel_tool_calls` patch:

| File here | Ported from (investigator) | Changes |
|---|---|---|
| `src/model/meta/meta-responses.ts` | `src/providers/meta-responses.ts` | `JuratorError`; cached input tokens in usage; error codes by HTTP status (429, 5xx); an empty tool list omits `tools`, `tool_choice` and `parallel_tool_calls` |
| `src/model/meta/strict-schema.ts` | `src/providers/strict-schema.ts` | `JuratorError`, imports |
| `src/model/meta/meta-config.ts` | `src/providers/meta-config.ts` | `JuratorError`; model and reasoning defaults from `.jurator/config.json`; injectable fetch and timeout; a local UTF-8 decoder |
| `src/model/meta/model-provider.ts` | `src/providers/model-provider.ts` | optional `cachedInputTokens` in usage, imports |
| `src/model/meta/json-types.ts` | `src/core/json.ts` (types only) | types only |

Each ported file starts with a `Ported from ...` header. Everything else (`src/**`, `tests/**`, `scripts/**`,
`templates/**`, `fixtures/**`) is new.

One idea also came from Investigator, as a design rather than code: its citation check (`src/core/citations.ts`
there) re-reads every cited line from the evidence before the line counts. Jurator's quote finder
(`src/policy/quote.ts`) and its code quotes copied from git follow the same rule, written new here.
