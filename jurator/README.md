# Jurator

**Checks that your code keeps the promises your company writes down.** Jurator reads your policies (a privacy policy,
a security policy, an agent policy export) and turns every sentence into a numbered promise with its exact quote. The
model writes a rule for each promise that can be checked in code, and the program proves each rule can fail before
keeping it. Rules then run with no AI on every check: by hand, on `git push`, and inside your coding agent.

Built with Meta Muse models (`muse-wonder-1.0` by default); not a Meta product. How it decides, what it was measured on
and the research behind it: [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

Needs Node 22.12 or newer and git.

```sh
npm ci
npm run build          # writes dist/
npm link               # puts `jurator` on your PATH (or run: node dist/bin.js <command>)
npm run check          # typecheck, tests and build
```

Commands that call a model need a Meta API key, either in `~/.jurator/credentials.json` (written by
`node scripts/save-key.mjs`, which never prints the key) or in `META_API_KEY`. Check it with `jurator doctor --live`.
`init`, `promises`, `status`, `verify`, `report`, the hooks and `check --no-ai` never call a model.

## Quick start

In your repo, or in a folder that holds several repos:

```sh
jurator init                       # find your policies, write .jurator/config.json
jurator compile --accept           # policies -> numbered promises with exact quotes
jurator conflicts                  # promises that contradict each other (a requirement vs a configured value, or two requirements that cannot both hold)
jurator rule propose --all         # the model writes rules, the program proves each one can fail
jurator rule accept --all          # after you read .jurator/rules.json
jurator bind --all                 # where each promise lives in the code
jurator check                      # check the code against every promise
jurator explain privacy.01         # everything about one promise, in plain words
jurator discuss                    # ask questions about the results in a chat
jurator hook install pre-push      # run the check on every git push
```

Commit `.jurator/`: promises, rules and bindings are reviewed like code. `.jurator/local/` (runs, caches, chat
transcripts) stays out of git.

## What the results mean

| Word | Who decided | Blocks a push? |
|---|---|---|
| **HOLDS** / **BROKEN** | An accepted rule, with no AI | Yes, BROKEN blocks |
| LOOKS KEPT / LOOKS BROKEN / CAN'T TELL | A model read the code (no rule yet); every quoted line is copied from git | No, a hint only |
| TOUCHED, NOT CHECKED | The change touches the promise's files; nothing judged | No |

**BROKEN NOW** after `rule propose` means today's code already breaks that promise; Jurator shows the small fix that
makes the rule pass.

## Commands

Run `jurator --help` for the list and `jurator <command> --help` for one command.

| Step | Commands |
|---|---|
| Set up | [`init`](#init) · [`add`](#add) · [`pull`](#pull) |
| Policies to promises | [`compile`](#compile) · [`promises`](#promises) · [`accept`](#accept) · [`conflicts`](#conflicts) |
| Promises to code | [`rule`](#rule) · [`bind`](#bind) |
| Check | [`check`](#check) · [`explain`](#explain) · [`verify`](#verify) · [`report`](#report) · [`status`](#status) · [`discuss`](#discuss) |
| Where code changes | [`hook`](#hook) · [`mcp`](#mcp) |
| Tools | [`bench`](#bench) · [`doctor`](#doctor) |

**Options many commands share**

| Option | What it does |
|---|---|
| `--json` | Print machine-readable JSON instead of the screen view. |
| `--budget <usd>` | Stop before the run spends more than this on model calls. Default $10 per run ($3 for `discuss`, $6 for `bench`). When the budget stops a run, Jurator prints the command to continue. |
| `--scripted <dir>` | Use recorded model answers from a folder instead of live calls (offline and free; the demo and tests use it). |
| `--video` | Fit the output to 100 columns for a screen recording (or set `JURATOR_VIDEO=1`). |

**Exit codes:** `0` ok · `1` a rule found a promise BROKEN (or, for `pull --check`, a source changed) · `2` the tool
failed or the arguments were wrong.

### init

Create `.jurator/` and find your policies.

```
jurator init [--source alias=connector:locator]... [--repo name=path]... [--json]
```

| Argument | What it does |
|---|---|
| (none) | In a repo: finds policy files (privacy, security, terms...) and picks the code folders to check. In a folder that holds several git repos: makes a workspace (see below). |
| `--source alias=connector:locator` | Add a policy source by hand. Can repeat. Connectors: `file` (a path in the repo, e.g. `privacy=file:docs/privacy.md`) and `praesidia` (a recorded Praesidia agent policy export). |
| `--repo name=path` | Name a code repo for a workspace. Can repeat. Without it, `init` finds the git repos in the folder. |

**Workspace:** the folder becomes its own git repo for `.jurator/` and `policies/`; the code repos stay separate, and
every code path is shown with its repo name in front (`backend-api/app/config.py:89`).

### add

Add a policy file as a source, or add one promise sentence.

```
jurator add <file> [--alias name]
jurator add --promise "sentence"
```

| Argument | What it does |
|---|---|
| `<file>` | A policy file to add as a source. |
| `--alias name` | The short name for the source (it becomes the promise id prefix, e.g. `privacy.01`). |
| `--promise "sentence"` | Add one sentence to `.jurator/sources/local.md`, your own promises. Run `compile` afterwards. |

### pull

Re-read every policy source (read-only) and update the lock (`.jurator/sources.lock.json`).

```
jurator pull [--check] [--json]
```

| Argument | What it does |
|---|---|
| `--check` | Only report; exit `1` if a source changed since the lock. |

### compile

Turn policies into numbered promises. Each promise keeps its exact quote, found word for word in the policy, and
typed fields such as "at most 30 days". It also finds contradictions between promises.

```
jurator compile [--accept] [--force] [--budget <usd>] [--scripted <dir>] [--json] [--video]
```

| Argument | What it does |
|---|---|
| `--accept` | Accept the new promises at once (otherwise they stay drafts until `jurator accept`). |
| `--force` | Recompile sources that have not changed since the last compile. |

A draft whose quote is not in the policy is dropped and the reason is shown.

### promises

List the promises.

```
jurator promises [--for <file>...] [--all] [--json]
```

| Argument | What it does |
|---|---|
| `--for <file>...` | Only the promises that apply to these files. |
| `--all` | Include retired promises (their sentence was removed from the policy). |

### accept

Accept draft promises.

```
jurator accept <id>... | --all [--json]
```

| Argument | What it does |
|---|---|
| `<id>...` | The promises to accept, e.g. `privacy.01 security.02`. |
| `--all` | Accept every draft. |

### conflicts

Show promises that contradict each other, and record your decision on one.

```
jurator conflicts [--find [--scripted <dir>]] [--json]
jurator conflicts --rule <C-n> --as real|not-a-conflict --why "<reason>" [--by <name>]
```

| Argument | What it does |
|---|---|
| (none) | List the contradictions found so far. Typed fields are compared with no AI: a requirement against a configured value (30 days vs a setting of 90) is a configuration violation; two limits that can both hold are compatible. |
| `--find` | Ask the model to look for contradictions again. |
| `--rule <C-n>` | The contradiction to decide, e.g. `C-1`. |
| `--as real\|not-a-conflict` | Your decision. |
| `--why "<reason>"` | Why, saved with the decision. |
| `--by <name>` | Who decided (default: `$JURATOR_USER`, else `$USER`). |

### rule

Write, test and list rules. A rule is a plain pattern that runs with no AI. It is the only thing that can say HOLDS
or BROKEN.

```
jurator rule propose <promise-id>[,<promise-id>...] | --all [--accept] [--redteam] [--budget <usd>] [--concurrency <n>] [--scripted <dir>] [--json]
jurator rule test [<rule-id>] [--at <ref>] [--json]
jurator rule list [--json]
jurator rule accept <rule-id> | --all
```

| Subcommand or argument | What it does |
|---|---|
| `propose <ids> \| --all` | The model writes a rule for each promise. The program keeps a rule only if it passes on today's code and fails when the guarding line is removed. Rules read code, not comments. If today's code already breaks the promise, it says BROKEN NOW and shows a small fix. A promise that cannot be checked in code says "no rule" and is checked by an AI read instead. |
| `--accept` | Accept every proven rule at once (and save the bindings it found). |
| `--redteam` | Muse Spark tries to break each promise while the rule still passes; each evasion goes back for a repair (up to 2 rounds). Each rule ends "evasion closed" or "still evadable: how". |
| `--concurrency <n>` | How many promises to work on at once (default 8, at most 16). |
| `test [<rule-id>] [--at <ref>]` | Re-run the rules, and the evasions the red team found, on the code at a commit (default `HEAD`). |
| `list` | Show every rule and whether it is accepted. |
| `accept <rule-id> \| --all` | Accept a proposed rule after you read it in `.jurator/rules.json`. |

### bind

Record where in the code each promise lives: a constant, a guard call, a config key or an allowlist. Rules give
bindings with no AI; the model finds the rest, and the program checks every location in git.

```
jurator bind [<promise-id> | --all] [--at <ref>] [--no-model] [--budget <usd>] [--scripted <dir>] [--json]
jurator bind list [--at <ref>] [--json]
```

| Subcommand or argument | What it does |
|---|---|
| `<promise-id> \| --all` | Bind one promise or all of them. |
| `--at <ref>` | Use the code at this commit (default `HEAD`). |
| `--no-model` | Only the bindings rules give; no model call. |
| `list` | Show each binding as unchanged, moved, changed (with the new value) or lost. |

### check

Check the code against your promises. Rules run with no AI; promises with no rule get an AI read. Checks are
incremental: the same code and the same policies means nothing to recheck.

```
jurator check [--diff <base>] [--head <ref>] [--full] [--no-ai] [--no-ai-summary] [--budget <usd>] [--verbose] [--json] [--md] [--scripted <dir>] [--video]
```

| Argument | What it does |
|---|---|
| (none) | Check the whole repo (or workspace) at `HEAD`. |
| `--diff <base>` | Check only what changed between `<base>` and the head, e.g. `--diff main` on a branch. |
| `--head <ref>` | The commit to check (default `HEAD`). |
| `--full` | Recheck every promise, even ones whose code and policy did not change. |
| `--no-ai` | Rules only; no model calls. |
| `--no-ai-summary` | Skip the plain-words summaries of each finding (the verdicts do not change). |
| `--verbose` | Show the rule, its pattern and every line it found. |
| `--md` | Print the result as a Markdown comment ready to post on a PR. |

Every check saves a record in `.jurator/local/runs/<id>/run.json`, which `verify` and `report` read. Exit `1` when a
rule finds a promise BROKEN.

### explain

Everything about one promise: the policy quote, its rule, the code evidence, the last check, and a plain summary
written by the model.

```
jurator explain <promise-id> [--at <ref>] [--no-ai] [--budget <usd>] [--scripted <dir>] [--json]
```

| Argument | What it does |
|---|---|
| `<promise-id>` | The promise, e.g. `privacy.01`. Short ids from the check screen work too. |
| `--at <ref>` | Show the code at this commit (default `HEAD`). |
| `--no-ai` | Skip the plain summary; everything else is copied from git and `.jurator/`. |

### verify

Re-check a saved check record with no AI: recompute its digest, re-read every quoted line from git, and re-run every
recorded rule at the record's commit. A record edited by hand does not verify.

```
jurator verify <run.json> [--json]
```

Example: `jurator verify $(ls -t .jurator/local/runs/*/run.json | head -1)` verifies the latest check.

### report

Write one self-contained HTML page with the promises, rules, the last check and a graph of the promises.

```
jurator report [<run.json>] [--out jurator-report.html] [--json]
```

| Argument | What it does |
|---|---|
| `<run.json>` | The check to show (default: the latest). |
| `--out <file>` | Where to write the page (default `jurator-report.html`). |

### status

Show the sources, the promises, the rules and the last check (the code commit and policy state it verified).

```
jurator status [--json]
```

### discuss

A chat about your promises, rules, checks and code. It looks things up and explains, with code lines copied from git.
When a next step would help (check again, explain a promise, write a rule), it shows an action card with its cost and
you confirm. It can draft a policy edit, which `/apply` writes. It never accepts, rejects or changes anything by itself.

```
jurator discuss ["<goal>"] [--model wonder|spark] [--budget <usd>] [--plain] [--json] [--no-save] [--scripted <dir>]
```

| Argument | What it does |
|---|---|
| `"<goal>"` | Start from a goal, e.g. `"check that uploaded documents stay in memory"`; it plans the steps. |
| `--model wonder\|spark` | The model to talk to (default `wonder`, Muse Wonder). |
| `--budget <usd>` | Spending limit for the chat (default $3). |
| `--plain` | Plain lines instead of the full-screen view (also used when not in a terminal). |
| `--json` | One JSON event per line, for scripts. |
| `--no-save` | Do not save the transcript (saved by default in `.jurator/local/discuss/`). |

In the chat: **Enter** sends · **Enter** or **y** runs an action card, **n** or **Esc** skips it · **Esc** stops an
answer · **Ctrl-D** exits. Commands: `/help`, `/promises`, `/findings`, `/explain <id>`, `/rule <id>`,
`/model wonder|spark`, `/cost`, `/budget <usd>`, `/save`, `/clear`, `/exit`. Decisions run only when you type them:
`/accept <ids>|--all`, `/rule accept <id>|--all`, `/apply`.

### hook

Run the check where code changes: on `git push` and inside coding agents.

```
jurator hook install pre-push|claude|muse... [--local] [--fail-closed]
jurator hook run pre-push|claude|muse [--fail-closed]
```

| Subcommand or argument | What it does |
|---|---|
| `install pre-push` | A git pre-push hook: a push with a BROKEN promise is blocked. It uses the rules committed at the push base, so a branch cannot weaken its own rules. |
| `install claude` | A Claude Code hook (`.claude/settings.json`): denies a push with a BROKEN promise, and denies the agent editing `.jurator/` or accepting its own rules. |
| `install muse` | The same hook for Muse Code (`.muse/hooks.json`). Not yet tried in a live Muse session. |
| `--local` | Claude Code only: write `.claude/settings.local.json` (not committed) instead. |
| `--fail-closed` | Block when the check cannot run (a rule error or a timeout). By default the push goes through with a warning. `JURATOR_FAIL_CLOSED=1` does the same. |
| `run <kind>` | What the installed hooks call; reads the git or agent event on stdin. |

### mcp

Serve promises and checks to coding agents over MCP (stdio), so an agent can ask which promises a change touches and
run the check. Read and check tools only. The coding agent starts it; see
[`templates/agents/README.md`](templates/agents/README.md).

```
jurator mcp [--repo <path>]
```

| Argument | What it does |
|---|---|
| `--repo <path>` | The repo to serve (default: the current folder). |

### bench

Measure how well each way of checking works: it plants 5 breaks and 3 harmless changes in a copy of the demo app
and scores rules only, an AI read of every promise, a plain prompt, and Jurator.

```
jurator bench [--models <m1,m2>] [--plain <model>] [--no-plain] [--no-redteam] [--attacker <model>] [--judge <model>] [--no-ai] [--cases B1,H1] [--budget 6] [--concurrency 6] [--dir <bench dir>] [--scripted <dir>] [--json]
```

| Argument | What it does |
|---|---|
| `--models <m1,m2>` | The models for the AI-read rows (default `muse-wonder-1.0,muse-spark-1.3`). |
| `--plain <model>` / `--no-plain` | The model for the plain-prompt row, or skip that row. |
| `--no-redteam` | Skip the red-team attack on the rules. |
| `--attacker <model>` / `--judge <model>` | The models that attack rules and judge the attacks. |
| `--no-ai` | Rules only. |
| `--cases B1,H1` | Run only these cases (`B` = a planted break, `H` = a harmless change). |
| `--concurrency <n>` | Model calls at once (default 6, at most 16). |
| `--dir <bench dir>` | Where to build the copy of the demo app. |

Results and live runs: [`docs/DESIGN.md`](docs/DESIGN.md#bench-and-real-repos).

### doctor

Check the Meta API key and model access.

```
jurator doctor [--live] [--json]
```

| Argument | What it does |
|---|---|
| `--live` | Make one small model call and print the model, the latency and the cost. |

## Files

| Path | What it holds | In git? |
|---|---|---|
| `.jurator/config.json` | Sources, code scope, model, budget, `failMode` (`block` makes BROKEN exit `1`) | Yes |
| `.jurator/sources/` | A copy of each policy as it was compiled | Yes |
| `.jurator/sources.lock.json` | The digest of each source, for `pull` | Yes |
| `.jurator/promises/<source>.json` | The promises with their quotes and typed fields | Yes |
| `.jurator/contradictions.json` | Contradictions and the decisions on them | Yes |
| `.jurator/rules.json` | The rules and whether each is accepted | Yes |
| `.jurator/bindings.json` | Where each promise lives in the code | Yes |
| `.jurator/local/` | Check records, caches, chat transcripts | No |

## Demo

The demo app `acme-notes` (in `examples/`) has three policies and two branches with planted breaks.

```sh
bash scripts/demo.sh             # recorded model answers: offline, free, the same every run (23 steps)
bash scripts/demo.sh --pause     # waits for Enter between steps, for recording
bash scripts/demo-live.sh        # the same steps with live model calls (about $0.80)
```

Step-by-step notes: [`docs/DEMO.md`](docs/DEMO.md).

## Credits and licence

Built on [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator): the Meta model provider in
`src/model/meta/` is ported from it, and its core idea (the model proposes, the program decides) runs through all of
Jurator. Details: [`docs/DESIGN.md`](docs/DESIGN.md#what-was-pre-existing).

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
