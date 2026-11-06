# Jurator demo (for the video)

Jurator is a linter for your company's promises. It turns written policies into numbered promises with exact
quotes, keeps a rule for each promise it can check in code, and runs those rules wherever code changes: in the
coding agent, on `git push`, and on the PR.

## Run it

```sh
npm run build
bash scripts/demo.sh            # scripted model answers: offline, free, same output every time
bash scripts/demo.sh --pause    # waits for Enter between steps (for recording)
bash scripts/demo-live.sh       # the same steps with live Meta model calls (about $0.80; needs META_API_KEY)
bash scripts/demo.sh --video    # the recording cut (shots of the 3-minute video only): add --pause to record
bash scripts/demo-live.sh --video --pause   # the take for the video: AI steps live, about $0.66
```

`--video` is the cut for the screen recording; [VIDEO.md](VIDEO.md) has the shot list with the command and the voice
line for each shot. It prints no step banners or self-check lines, keeps every line within 100 columns, shows
repo-relative paths and 7-character shas, and leaves out the csv-export branch, `status`, `conflicts` and the
policy-only change. Any jurator command takes `--video` (or `JURATOR_VIDEO=1`) for the same output.

Every run builds the demo app as a fresh git repo in a new temp folder: `scripts/make-demo-repo.sh` turns
[`examples/acme-notes/`](../examples/acme-notes) into `main` and its two patches into the branches `feature/csv-export`
and `agent/retention`, with fixed authors and dates, so every build has the same commit shas. The demo can be re-run
as often as needed and nothing in the checkout changes (`ACME_NOTES=<path>` clones an existing demo repo instead).
The script checks every expected outcome and stops with a red ✗ if one is wrong. `--clean` deletes the temp folder
at the end.

The live script takes the API key from `META_API_KEY` in the environment, or from an env file that `node --env-file`
loads into the jurator process: `--env-file <path>`, by default `.env` in the current folder. The scripts never
read, print or copy the key or the file.

## The steps and what each one shows

| # | Command | What to point at |
|---|---|---|
| 1 | `scripts/make-demo-repo.sh` | A small TypeScript app with `docs/privacy.md`, `docs/security.md` and a Praesidia agent policy export. |
| 2 | `jurator init` | Jurator finds the three policies on its own: `privacy`, `security`, `praesidia`. |
| 3 | `jurator compile --accept` | Policies become numbered promises (`privacy.01`, `security.01`, ...), each with its exact quote. The program finds every quote word for word and **drops** a draft whose quote is not in the policy. The Praesidia settings become promises with no AI. |
| 4 | `jurator conflicts` | A real configuration violation with a concrete example: privacy deletes chats after 30 days, the Praesidia agent is configured to keep them 90. Found by the program comparing typed promises ("30 days with 90 days, no AI"), live too. |
| 5 | `jurator rule propose --all --accept` | The model writes rules; the program decides. Each rule must pass on main and is **proven able to fail** (the program removes the guarding line in memory and the rule fails). Promises with no possible rule stay on AI reads, and the output says why. |
| 6 | `jurator bind --all` | **Where each promise lives in the code**: `privacy.01 -> src/agent/chats.ts:2 CHAT_TTL_DAYS (expects <= 30 days)`. Rules give these lines with no AI; the model points at the rest and the program checks every line in git (scripted: 9 of 9 bound, 6 from rules). Saved in `.jurator/bindings.json`. |
| 7 | `jurator status` | Coverage: "Covered by rules: 7 of 9 code promises" (live: 9 of 10). |
| 8 | `git commit .jurator/` | Promises, rules and bindings live in the repo and are reviewed like code. |
| 9 | `jurator check` | On main every rule **HOLDS**. Promises without a rule were read by AI and say **LOOKS KEPT**, never "holds". The run records the pair it verified: (code commit, policy state). |
| 10 | `jurator check` again | **Nothing to recheck: code and policies unchanged since run ...** No file read, no rule run, no AI call; 9 results reused. |
| 11 | `git checkout feature/csv-export` | The diff: a new `GET /export.csv` route with no `requireAdmin`. |
| 12 | `jurator check --diff main` | `security.01` **BROKEN (rule, no AI)**, with the exact line from git and the exact policy quote. Exit code 1. Promises whose files did not change are reused. |
| 13 | `jurator verify <run.json>` | The saved record is re-checked with no AI: digest, and every quoted line re-read from git at its commit. |
| 14 | `git checkout agent/retention` | A coding agent changed `CHAT_TTL_DAYS` from 30 to 90 "to match the agent policy". |
| 15 | `jurator check --diff main` | `privacy.01` **BROKEN**: the agent quietly broke a promise to customers. The `Why` row: **touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to privacy.01)**. Exit code 1. |
| 16 | edit `docs/privacy.md` only | A policy change with no code change: item 3 now also rules out data brokers. |
| 17 | `jurator compile --accept` | Only privacy is compiled again: the reworded sentence becomes `privacy.05`, `privacy.03` is retired. |
| 18 | `jurator check` | **Policies changed (9a980a3 -> ...)**: rechecked 1 of 9 promises (the new one), reused 8. Never a full rescan. |
| 19 | `jurator hook install pre-push claude` | One command adds a git pre-push hook and a Claude Code PreToolUse hook (`muse` does the same for Muse Code). |
| 20 | `git push team main` | The pre-push hook runs the rules on the pushed commits (no AI, offline, about a second): nothing broken, the push goes through. |
| 21 | `git push team agent/retention` | The pre-push hook blocks the push: `privacy.01` broken. |
| 22 | agent runs `git push` | Claude Code's hook answers **deny** with the evidence (promise, policy quote, rule message, record path). The agent sees why and can fix the code. No agent session runs here: the script sends the hook the event Claude Code sends before `git push` (`--video` labels it "simulated agent call"). |
| 23 | agent edits `.jurator/rules.json` | Denied: agents cannot loosen the rules; rules change through `jurator` commands and human review. |

## Incremental checks: the four cases

Every check records the pair it verified: the code commit and the **policy state** (a digest of the accepted promises
and rules). The next check compares against it, so nothing is ever rescanned from the start:

| Code | Policies | What the check does | Demo step |
|---|---|---|---|
| same | same | Nothing: "Nothing to recheck", the earlier answers are copied. | 10 |
| changed | same | Only promises whose files or bound lines changed; the rest are reused by content (cited lines re-copied from git). A touched bound line names its promise in `Why`. | 12, 15 |
| same | changed | Only the promises that changed (new or reworded); every other result is reused. | 18 |
| any | any | `jurator check --full` rechecks everything. | - |

## Lines worth saying

- "A rule is the only thing that may say *holds* or *broken*. An AI read may only say *looks kept*."
- "The model proposes, the program decides: every quote is found in the policy by the program, every code line is
  copied from git by the program."
- "The same check runs in the agent, on push and on the PR, from one record you can verify with no AI."
- "Jurator remembers where each promise lives. Touch `CHAT_TTL_DAYS` and it knows which promise to recheck."
- "Same code and same policies: nothing to recheck. It never rescans everything from the start."

## The hooks in your own repo

```sh
jurator hook install pre-push          # .git/hooks/pre-push (never replaces an existing hook; prints the line to add)
jurator hook install claude [--local]  # .claude/settings.json (or settings.local.json), merged, never clobbered
jurator hook install muse              # .muse/hooks.json (Muse Code runs project hooks in a trusted folder)
```

- The hooks run rules only: no AI, no network. They block only when a rule says BROKEN and the fail mode is `block`.
- The agent hooks also deny `git push --no-verify` (and `-c core.hooksPath=...`) and any edit to `.jurator/`.
- If Jurator itself fails (a rule error, a timeout, a crash), the hooks let the action through with a loud `WARNING`.
  `--fail-closed` (or `JURATOR_FAIL_CLOSED=1`) blocks it instead, exit 2.
- The agent hooks also read through `bash -c`, `eval`, `$(...)`, `xargs` and `python -c`, and deny an agent running
  `accept`, `rule accept` or `decide`.
