# Jurator: rules for contributors and coding agents

Jurator is a linter for a company's promises. It turns written policies into numbered promises, each with an exact
quote, and checks code changes against them: in the coding agent, on `git push`, and on the PR. These rules apply to
every contributor, human or agent. `CLAUDE.md` points here.

**Never hard-code the name "Jurator".** User-visible text uses `BRAND.name`, commands use
`BRAND.command` and the folder uses `BRAND.folder`, all from `src/brand.ts`. A rename is that file, `package.json`
`bin`, and the text in `templates/`.

## Product principles (do not break)

1. **Read-only connectors in code.** Credentials never reach a model. Models only see text that was already fetched.
2. **Rules decide; the model maintains them.** A rule (no AI) is the only thing that says HOLDS or BROKEN. Without a
   rule, an AI read may only say LOOKS KEPT, LOOKS BROKEN or CAN'T TELL. The model writes rules
   (`jurator rule propose`), and the program proves each rule can fail before it is saved.
3. **The model proposes, the program decides.** The program finds every policy quote in the policy text and copies
   every code quote from git at a commit. Text written by a model never becomes evidence.
4. **For every engineer.** Jurator is an extra layer of sanity for professional teams. Never pitch it at
   "vibe coders" or "juniors".

## Tech rules

- TypeScript ESM with NodeNext (import paths end in `.js`), strict tsconfig, Node >= 22.12.
- **zod is the only runtime dependency.** Do not add dependencies; a new dev dependency needs a reason in the PR.
- `src/contracts.ts` is the shared surface between areas. It is **append-only**: add fields or types, never rename
  or remove one. For a one-off need, add a local type in your area instead.
- Shared files change only in their own PR: `src/contracts.ts`, `src/util/**`, `src/cli/main.ts`,
  `src/cli/registry.ts`, `src/bin.ts`, `src/brand.ts`, `package.json`.
- Output: colour only on a TTY (`src/util/term.ts`). Every command that prints records supports `--json`.
  Exit codes: `0` ok · `1` a promise is broken (block mode) or drift found · `2` the tool failed or bad input.
- Plain words in every message a user sees. A command's output ends with a `Next:` hint when there is a next step.
- Never open, print, copy or commit a `.env` file, a key or a token. Code sent to a model goes through the secret
  masker (`src/model/secrets.ts`), and `.env*`, `*.pem` and `*.key` files are never sent.

## Tests

- `npm run check` (typecheck, tests, build) must pass before every commit you push.
- **Tests never call the network.** Model calls in tests use the scripted client. Answers live in
  `fixtures/scripted/<suite>/<task>.json`, where `<task>` is the task key with `:` replaced by `__`.
- Code against the signatures in another area's `index.ts`. In tests, use your own fakes (see `tests/*/fakes.ts`).
- Live model calls are manual and opt-in: `META_API_KEY` in the environment, e.g.
  `node --env-file=.env dist/bin.js doctor --live`. Keep each live experiment small, and record its cost in the PR.

## Areas

Each change should stay inside one area where it can. Tests mirror the source folders (`tests/<area>/**`).

| Area | Source | Commands (`src/cli/commands/`) |
|---|---|---|
| Core: contracts, CLI, utilities, brand | `src/contracts.ts`, `src/cli/{main,registry,context}.ts`, `src/util/**`, `src/bin.ts`, `src/brand.ts` | |
| Model provider (Meta Muse) | `src/model/**` (`src/model/meta/` is ported, see NOTICE) | `doctor` |
| Workspace, git, connectors | `src/workspace/**`, `src/git/**`, `src/connectors/**` | `init`, `pull`, `status` |
| Policy: promises, quotes, contradictions | `src/policy/**` | `add`, `compile`, `promises`, `accept`, `conflicts` |
| Rules: writing, proving, red team | `src/rules/**` | `rule` |
| Bindings: where a promise lives in code | `src/bindings/**` | `bind` |
| Check, cache, rendering | `src/check/**`, `src/cache/**`, `src/render/**` | `check`, `verify` |
| Hooks and integrations | `src/integrations/**`, `templates/hooks/**` | `hook` |
| Agents (MCP server) | `src/mcp/**`, `templates/agents/**` | `mcp` |
| Report (HTML page) | `src/report/**` | `report` |
| Bench | `src/bench/**`, `fixtures/bench/**` | `bench` |
| Demo | `scripts/**`, `examples/**`, `docs/DEMO.md`, `docs/VIDEO.md` | |

## Demo app

The demo app is **acme-notes**, a small TypeScript app with its own git history. Its policies are `docs/privacy.md`,
`docs/security.md` and `policies/praesidia-support-agent.json`, a recorded agent-policy export whose
`dataRetentionDays: 90` contradicts privacy's 30 days. Two branches carry planted breaks: `feature/csv-export` (a new
`/export.csv` route without `requireAdmin`) and `agent/retention` (`CHAT_TTL_DAYS = 90`). Source aliases: `privacy`,
`security`, `praesidia`. Expected promise ids: `privacy.01`..`privacy.04`, `security.01`..`security.03`,
`praesidia.01`... `bash scripts/demo.sh` works on a throwaway copy, never on the original; see `docs/DEMO.md`.

## Working in parallel (git worktrees)

Agents working at the same time each use their own worktree and branch, never the main checkout:

```sh
git worktree add ../jurator-wt/<topic> -b <topic> main
cd ../jurator-wt/<topic>
ln -s "$(git worktree list | head -1 | cut -d' ' -f1)/node_modules" node_modules   # or: npm ci
npm run typecheck && npx vitest run tests/<area>
```

`.gitignore` covers the `node_modules` symlink; never commit it. Commit small steps with a message that says what
changed. Never push from an agent; a maintainer merges branches into `main` one at a time and runs `npm run check`
after each.
