# Jurator in your coding agent

`jurator mcp` is an MCP server over stdio. It gives the agent four tools, all read or check only:

| Tool | When the agent calls it | What it returns |
|---|---|---|
| `promises_for_change {files}` | before it edits | the accepted promises about those files, each with the exact policy quote and the rule that checks it |
| `check_change {base?}` | before it pushes | `jurator check` on `base...HEAD` (default `main`) with rules only, no AI: verdicts, code lines copied from git, the plain-text report |
| `explain_promise {id}` | when a promise id comes up | wording, policy quote and where it is, rules, contradictions, last verdict |
| `list_promises` | to get an overview | accepted promises with kind, scope and whether a rule checks them |

There is no write tool. The agent cannot accept, waive or edit a promise or a rule; people do that with the CLI.
`check_change` writes only its run record under `.jurator/local/runs/` (gitignored), so `jurator verify` can re-check it.

Requires `jurator` on your `PATH` (`npm link` in the Jurator checkout, or `npm i -g`) and a repo that already has
`.jurator/` (`jurator init`, `compile`, `accept`).

## Claude Code

1. MCP server: copy `claude/mcp.json` to `<repo>/.mcp.json` (merge into `mcpServers` if the file exists), or run
   `claude mcp add --scope project jurator -- jurator mcp`.
2. Skill: copy `claude/SKILL.md` to `<repo>/.claude/skills/jurator/SKILL.md`.
3. Optional: paste `AGENTS.snippet.md` into `CLAUDE.md`, so the rule is in every session, not only when the skill loads.
4. Check: start `claude` in the repo, run `/mcp`, and look for `jurator` with 4 tools.

Claude Code starts the server in the project folder. To point it elsewhere, add `"--repo", "/path/to/repo"` to `args`.

## Muse Code (Meta)

1. MCP server: Muse Code reads servers from the `mcp_servers` block of `~/.config/muse/settings.json`. Merge
   `muse/settings.json` into it (keep `"schema_version": 1`; Muse refuses a settings file without it).
   `mode: "optional"` makes Muse skip the server with a warning instead of aborting the run if `jurator` is missing.
   The tools are marked read-only, so under on-request approvals Muse runs them without a prompt.
2. Skill: copy `muse/SKILL.md` to `<repo>/.agents/skills/jurator/SKILL.md`, then `muse skills validate .agents/skills/jurator`.
   (Muse also scans `.claude/skills`, so the Claude copy works there too; the Muse copy names the tools as
   `mcp__jurator__*`, which is how Muse shows MCP tools.)
3. Recommended: paste `AGENTS.snippet.md` into `AGENTS.md`. Muse loads `AGENTS.md` every session; skills load on demand.
4. Check: start `muse` in the repo and run `/mcp`.

The settings file is per user, not per repo. If Muse starts servers outside the repo, add `"--repo", "${PWD}"` or a
fixed path to `args` (Muse interpolates `${VAR}` in server configs).

## Push and PR

The agent can skip a skill; a hook cannot be skipped by accident. Install them too:
`jurator hook install pre-push claude muse` (see `templates/hooks/`).

## Renaming

"Jurator" is a placeholder. The CLI reads its name from `src/brand.ts`; these templates spell it out, so a rename also
means replacing `jurator` in the files in this folder (server name, command, skill name).
