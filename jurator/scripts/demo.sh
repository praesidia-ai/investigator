#!/usr/bin/env bash
# Jurator demo on acme-notes: policies -> promises -> rules -> bindings -> checks on main, on two broken branches,
# after a policy-only change, on git push and in the coding agent. Checks are incremental: a check never rescans
# what it already verified (same code + same policies: nothing to do; code changed: only what the change touches;
# policy changed: only the changed promises).
#
#   bash scripts/demo.sh            scripted model answers: offline, free, same output every run
#   bash scripts/demo-live.sh       the same steps with live Meta model calls (see that file)
#
# Options: --pause (wait for Enter between steps, for recording) · --clean (delete the temp folder at the end)
#          --video (the recording cut, see docs/VIDEO.md: no step banners or self-check lines, a short work folder,
#          100-column output, the shots of the 3-minute video only; the agent step is labelled "simulated agent call")
#          --env-file <path> (live mode: the file node loads META_API_KEY from; see scripts/demo-live.sh)
# Env: JURATOR_SKIP_BUILD=1 (use dist/ as is) · JURATOR_DEMO_MODE=scripted|live · JURATOR_ENV_FILE (= --env-file)
#      ACME_NOTES (an existing demo repo to clone instead of building one from examples/acme-notes)
#
# Re-runnable: every run builds the demo repo from examples/acme-notes (scripts/make-demo-repo.sh) in a new temp
# folder, so nothing in this checkout is changed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACME="${ACME_NOTES:-}"
MODE="${JURATOR_DEMO_MODE:-scripted}"
ENV_FILE="${JURATOR_ENV_FILE:-}"
FIXTURES="$ROOT/fixtures/scripted/acme"
FIXTURES_POLICY_EDIT="$ROOT/fixtures/scripted/acme-policy-edit"
PAUSE=0
CLEAN=0
VIDEO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pause) PAUSE=1 ;;
    --clean) CLEAN=1 ;;
    --video) VIDEO=1 ;;
    --env-file) [ $# -ge 2 ] || { echo "--env-file needs a path" >&2; exit 2; }; ENV_FILE="$2"; shift ;;
    --env-file=*) ENV_FILE="${1#--env-file=}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'; else B=; D=; G=; R=; Y=; N=; fi
# Video mode: every jurator command (and the git hooks it starts) prints for a 100-column recording.
if [ "$VIDEO" = 1 ]; then export JURATOR_VIDEO=1; fi

STEP=0
PROBLEMS=0
SCRIPTED=()
SCRIPTED_POLICY_EDIT=()
if [ "$MODE" = scripted ]; then SCRIPTED=(--scripted "$FIXTURES"); SCRIPTED_POLICY_EDIT=(--scripted "$FIXTURES_POLICY_EDIT"); fi

jurator() { # live mode with an env file: node loads it into the jurator process (this script never reads it)
  if [ "$MODE" = live ] && [ -n "$ENV_FILE" ]; then
    node --env-file="$ENV_FILE" "$ROOT/dist/bin.js" "$@"
  else
    node "$ROOT/dist/bin.js" "$@"
  fi
}

shown() { # the command as a person would type it
  local d="$*"
  d="${d//$FIXTURES_POLICY_EDIT/fixtures/scripted/acme-policy-edit}"
  d="${d//$FIXTURES/fixtures/scripted/acme}"
  d="${d//$ROOT\//}"
  printf '%s' "$d"
}

banner() { # title, what it shows (video mode: no banner; --pause waits silently)
  STEP=$((STEP + 1))
  if [ "$VIDEO" = 1 ]; then
    if [ "$PAUSE" = 1 ] && [ "$STEP" -gt 1 ]; then read -r -s _ </dev/tty; fi
    echo
    return 0
  fi
  if [ "$PAUSE" = 1 ] && [ "$STEP" -gt 1 ]; then read -r -p "${D}(Enter for step $STEP)${N}" _ </dev/tty; fi
  printf '\n%s━━ Step %d · %s %s\n' "$B" "$STEP" "$1" "$N"
  [ -n "${2:-}" ] && printf '%s   %s%s\n' "$D" "$2" "$N"
  return 0
}

shape() { node "$ROOT/scripts/shape.mjs" "$ROOT"; } # video: short paths and shas, 100 columns

prompt() { # a command as typed at the prompt (video mode shows the commands it runs)
  printf '%s$ %s%s\n' "$B" "$*" "$N"
}

problem() {
  PROBLEMS=$((PROBLEMS + 1))
  if [ "$MODE" = live ]; then
    printf '%s   ! %s (live model output differs from the script; carrying on)%s\n' "$Y" "$1" "$N"
  else
    printf '%s   ✗ %s%s\n' "$R" "$1" "$N"
    printf '%sDemo stopped at step %d. Work folder: %s%s\n' "$R" "$STEP" "${WORK:-?}" "$N"
    exit 1
  fi
}

ok() { [ "$VIDEO" = 1 ] || printf '%s   ✓ %s%s\n' "$G" "$1" "$N"; } # video: self-checks stay silent unless they fail

step() { # title, what it shows, expected exit code ('any' to skip), command...
  local title="$1" why="$2" want="$3"
  shift 3
  banner "$title" "$why"
  local got
  if [ "$VIDEO" = 1 ]; then
    prompt "$(shown "$@")"
    # Through the shaper too, so output jurator does not shape itself (git hooks, hook install) fits 100 columns.
    if [ -t 1 ]; then FORCE_COLOR=1 "$@" 2>&1 | shape; got=${PIPESTATUS[0]}; else "$@" 2>&1 | shape; got=${PIPESTATUS[0]}; fi
  else
    printf '%s$ %s%s\n\n' "$B" "$(shown "$@")" "$N"
    "$@"
    got=$?
    echo
  fi
  if [ "$want" != any ] && [ "$got" != "$want" ]; then problem "expected exit code $want, got $got"; else ok "exit code $got"; fi
}

latest_run() { # newest .jurator/local/runs/*/run.json in the current repo (absolute path)
  node -e '
    const fs = require("fs"), p = require("path");
    const dir = ".jurator/local/runs";
    let best = null;
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const f = p.join(dir, id, "run.json");
      if (!fs.existsSync(f)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best[0]) best = [m, f];
    }
    if (best) console.log(p.resolve(best[1]));
  '
}

expect_run() { # 'broken <promise-id>' | 'none-broken'
  local run
  run="$(latest_run)"
  if [ -z "$run" ]; then problem "no saved run found under .jurator/local/runs"; return; fi
  if node -e '
    const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const [want, id] = process.argv.slice(2);
    const broken = run.results.filter((r) => r.verdict === "broken");
    if (want === "none-broken") process.exit(broken.length === 0 ? 0 : 1);
    const hit = broken.find((r) => r.promiseId === id && r.level === "rule");
    process.exit(hit ? 0 : 1);
  ' "$run" "$@"; then
    if [ "$1" = none-broken ]; then ok "no promise is broken in $(basename "$(dirname "$run")")"; else ok "$2 is BROKEN, proved by a rule (no AI)"; fi
  else
    if [ "$1" = none-broken ]; then problem "a promise is broken on main"; else problem "$2 is not BROKEN by a rule in $run"; fi
  fi
}

run_field() { # node expression over the newest run record `r`; prints its value
  local run
  run="$(latest_run)"
  [ -n "$run" ] || return 1
  # process.stdout.write, not console.log: console.log colours numbers when FORCE_COLOR is set.
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = ('"$1"'); if (v === undefined || v === false || v === null) process.exit(1); process.stdout.write(String(v) + "\n");' "$run"
}

expect_binding() { # promise-id symbol: .jurator/bindings.json binds the promise to that name
  if node -e '
    const b = JSON.parse(require("fs").readFileSync(".jurator/bindings.json", "utf8"));
    const [id, sym] = process.argv.slice(1);
    process.exit(b.items.some((x) => x.promiseId === id && JSON.stringify(x).includes(sym)) ? 0 : 1);
  ' "$1" "$2"; then ok "$1 is bound to $2"; else problem "$1 is not bound to $2 in .jurator/bindings.json"; fi
}

finish() { # the closing lines; exits
  if [ "$VIDEO" = 1 ]; then
    echo
    if [ "$PROBLEMS" -gt 0 ]; then printf '%s%d differences from the script%s\n' "$Y" "$PROBLEMS" "$N"; fi
    if [ "$CLEAN" = 1 ]; then rm -rf "$WORK"; fi
    exit 0
  fi
  printf '\n%s━━ Done%s · %d steps' "$B" "$N" "$STEP"
  if [ "$PROBLEMS" -gt 0 ]; then printf ' · %s%d differences from the script%s' "$Y" "$PROBLEMS" "$N"; fi
  printf '\n'
  if [ "$CLEAN" = 1 ]; then rm -rf "$WORK"; echo "Removed $WORK"; else echo "Work folder (kept): $WORK/acme-notes"; fi
  exit 0
}

show_answer() { # an agent hook's JSON answer on stdin -> its decision and reason; exit 0 when it denies
  node --input-type=module -e '
    const [video, root] = process.argv.slice(1);
    const { shape, rootSpellings } = await import(root + "/dist/render/video.js");
    let s = "";
    for await (const c of process.stdin) s += c;
    const a = JSON.parse(s).hookSpecificOutput;
    let text = "permissionDecision: " + a.permissionDecision + "\n\n" + a.permissionDecisionReason;
    if (video === "1") text = shape(text, rootSpellings(process.cwd()));
    process.stdout.write(text + "\n");
    process.exit(a.permissionDecision === "deny" ? 0 : 1);
  ' "$VIDEO" "$ROOT"
}

# The recording cut (docs/VIDEO.md): the shots of the 3-minute video, in order, with the same self-checks (silent
# unless one fails). The csv-export branch, the status screen and the policy-only change are left out.
video_flow() {
  step "Find the policies" "" 0 jurator init
  step "Compile policies into promises" "" 0 jurator compile --accept ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  step "Write rules" "" 0 jurator rule propose --all --accept ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  step "Bind promises to the code" "" 0 jurator bind --all ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  expect_binding privacy.01 CHAT_TTL_DAYS
  git add .jurator && git commit -q -m "Jurator: promises and rules" || problem "could not commit .jurator/"

  step "Check main" "" 0 jurator check ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  expect_run none-broken

  banner "The agent's branch"
  prompt "git checkout -q agent/retention && git rebase -q main"
  git checkout -q agent/retention && git rebase -q main || problem "could not switch to agent/retention"
  prompt "git diff main -- src/agent/chats.ts"
  git --no-pager diff main -- src/agent/chats.ts

  step "Check the agent's change" "" 1 jurator check --diff main ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  expect_run broken privacy.01
  local why rel
  why="$(run_field '(r.results.find((x) => x.promiseId === "privacy.01") || {}).trigger')"
  case "$why" in *"touched CHAT_TTL_DAYS"*"bound to privacy.01"*) ;; *) problem "privacy.01 was not triggered by its CHAT_TTL_DAYS binding" ;; esac
  rel=".jurator/local/runs/$(basename "$(dirname "$(latest_run)")")/run.json"
  step "Verify the record with no AI" "" 0 jurator verify "$rel"
  step "Check again" "" 1 jurator check --diff main ${SCRIPTED[@]+"${SCRIPTED[@]}"}
  run_field 'r.incremental && r.incremental.skippedUnchanged' >/dev/null || problem "the second check rechecked promises"

  step "Install the hooks" "" 0 jurator hook install pre-push claude
  git init -q --bare "$WORK/team.git" && git remote add team "$WORK/team.git"
  git push -q team main >/dev/null 2>&1 || problem "could not push main to the test remote"

  # No coding agent runs in this script: the hook gets the JSON event a Claude Code agent sends before its Bash tool
  # runs `git push`, typed here. The screen says so.
  banner "Simulated agent call"
  printf '%s# simulated agent call: no agent runs here; this is the JSON event Claude Code sends its%s\n' "$Y" "$N"
  printf '%s# PreToolUse hook before running "git push", typed by this script%s\n' "$Y" "$N"
  prompt "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push team agent/retention\"}}' \\"
  printf '%s    | jurator hook run claude%s\n' "$B" "$N"
  local payload
  payload="{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push team agent/retention\"},\"cwd\":\"$PWD\"}"
  printf '%s' "$payload" | jurator hook run claude | show_answer || problem "the agent hook did not deny the push"

  step "Push the agent's branch" "" 1 git push -q team agent/retention
  finish
}

# ---------------------------------------------------------------- setup
if [ "$VIDEO" = 1 ]; then
  if [ "$MODE" = live ]; then AI="AI steps: live Meta model calls"; else AI="AI steps: scripted answers (recorded, offline)"; fi
  printf '%sJurator demo on acme-notes · %s%s\n' "$D" "$AI" "$N"
else
  printf '%sJurator demo%s · mode: %s · demo app: %s\n' "$B" "$N" "$MODE" "${ACME:-examples/acme-notes}"
fi
# Live mode: the key comes from META_API_KEY (or MODEL_API_KEY) in the environment, or from an env file that node
# loads into the jurator process: --env-file <path>, else .env in the current folder. Never read or printed here.
if [ "$MODE" = live ]; then
  if [ -z "$ENV_FILE" ] && [ -z "${META_API_KEY:-}" ] && [ -z "${MODEL_API_KEY:-}" ] && [ -f .env ]; then ENV_FILE=.env; fi
  if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 2; }
    ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")" # absolute: the demo runs in a temp folder
    [ "$VIDEO" = 1 ] || printf '%sAPI key: loaded by node from %s%s\n' "$D" "$ENV_FILE" "$N"
  elif [ -n "${META_API_KEY:-}" ] || [ -n "${MODEL_API_KEY:-}" ]; then
    [ "$VIDEO" = 1 ] || printf '%sAPI key: from the environment%s\n' "$D" "$N"
  else
    echo "Live mode needs META_API_KEY: set it in the environment, or pass --env-file <path> (default: .env in the current folder)." >&2
    exit 2
  fi
fi
if [ -n "$ACME" ] && [ ! -d "$ACME/.git" ]; then echo "Demo repo not found: $ACME (ACME_NOTES)." >&2; exit 2; fi
if [ "${JURATOR_SKIP_BUILD:-0}" != 1 ]; then
  printf '%sBuilding jurator...%s\n' "$D" "$N"
  (cd "$ROOT" && npm run build --silent) || { echo "Build failed." >&2; exit 2; }
fi
[ -f "$ROOT/dist/bin.js" ] || { echo "Missing $ROOT/dist/bin.js; run npm run build." >&2; exit 2; }

if [ "$VIDEO" = 1 ]; then
  # A short work folder, so the few absolute paths on screen stay short.
  WORK="$(mktemp -d /tmp/kw.XXXXXX)"
  if [ -n "$ACME" ]; then
    git clone -q "$ACME" "$WORK/acme-notes" || { echo "Could not clone $ACME." >&2; exit 2; }
  else
    bash "$ROOT/scripts/make-demo-repo.sh" -q "$WORK/acme-notes" || { echo "Could not build the demo repo." >&2; exit 2; }
  fi
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/jurator-demo.XXXXXX")"
  if [ -n "$ACME" ]; then
    step "Clone the demo app" "Acme Notes: a small TypeScript app with a privacy policy, a security policy and a Praesidia agent policy." 0 \
      git clone -q "$ACME" "$WORK/acme-notes"
  else
    step "Create the demo app" "Acme Notes (examples/acme-notes): a small TypeScript app with a privacy policy, a security policy and a Praesidia agent policy; two branches carry planted breaks." 0 \
      bash "$ROOT/scripts/make-demo-repo.sh" "$WORK/acme-notes"
  fi
fi
cd "$WORK/acme-notes" || exit 2
git config user.email demo@example.com
git config user.name "Jurator demo"
git config commit.gpgsign false
if [ "$VIDEO" = 1 ]; then video_flow; fi
ls docs policies

# ---------------------------------------------------------------- policies -> promises -> rules
step "Find the policies" "Jurator finds docs/privacy.md, docs/security.md and the Praesidia export, and writes .jurator/config.json." 0 \
  jurator init

step "Compile policies into promises" "Each promise is one short sentence with the exact policy quote; the program finds every quote word for word." 0 \
  jurator compile --accept ${SCRIPTED[@]+"${SCRIPTED[@]}"}

step "Show contradictions" "Privacy says chats are deleted after 30 days; the Praesidia agent policy keeps data for 90 days." any \
  jurator conflicts

step "Write rules (the model writes, the program proves)" "Each rule must pass on main and is proven able to fail before it is saved." 0 \
  jurator rule propose --all --accept ${SCRIPTED[@]+"${SCRIPTED[@]}"}

step "Bind promises to the code" "Where each promise lives. Rules give the bound lines with no AI; the model points at the rest and the program checks each line in git." 0 \
  jurator bind --all ${SCRIPTED[@]+"${SCRIPTED[@]}"}
expect_binding privacy.01 CHAT_TTL_DAYS

step "Status" "Sources, promises, and how many code promises are covered by rules." any \
  jurator status

banner "Commit .jurator/" "Promises and rules live in the repo and are reviewed like code (run records in .jurator/local/ stay out)."
printf '%s$ git add .jurator && git commit -m "Jurator: promises and rules"%s\n\n' "$B" "$N"
if git add .jurator && git commit -q -m "Jurator: promises and rules"; then
  git --no-pager show --stat --format='%h %s' HEAD | sed 's/^/   /'
  ok "committed on main"
else
  problem "could not commit .jurator/"
fi

# ---------------------------------------------------------------- checks
step "Check main" "Every rule holds. Promises without a rule are read by AI and labelled 'looks kept', never 'holds'." 0 \
  jurator check ${SCRIPTED[@]+"${SCRIPTED[@]}"}
expect_run none-broken

step "Check main again" "Same code, same policies: nothing to recheck. No file is read, no rule runs, no AI is called." 0 \
  jurator check ${SCRIPTED[@]+"${SCRIPTED[@]}"}
if run_field 'r.incremental && r.incremental.skippedUnchanged' >/dev/null; then ok "nothing rechecked: $(run_field 'r.incremental.reused') results reused from the verified run"; else problem "the second check on main rechecked promises"; fi

banner "Switch to feature/csv-export" "A teammate adds GET /export.csv without requireAdmin."
git checkout -q feature/csv-export && git rebase -q main && git --no-pager diff main -- src/routes/export.ts
ok "on $(git branch --show-current)"

step "Check the change" "security.01 is BROKEN by a rule, with the exact line from git and the exact policy quote. Exit code 1." 1 \
  jurator check --diff main ${SCRIPTED[@]+"${SCRIPTED[@]}"}
expect_run broken security.01
RUN_JSON="$(latest_run)"

step "Verify the record with no AI" "Recomputes the digest and re-reads every quoted line from git at its commit." 0 \
  jurator verify "$RUN_JSON"

banner "Switch to agent/retention" "A coding agent changed chat retention from 30 to 90 days to match the agent policy."
git checkout -q agent/retention && git rebase -q main && git --no-pager diff main -- src/agent/chats.ts
ok "on $(git branch --show-current)"

step "Check the agent's change" "privacy.01 (chats deleted after 30 days) is BROKEN by a rule. Exit code 1." 1 \
  jurator check --diff main ${SCRIPTED[@]+"${SCRIPTED[@]}"}
expect_run broken privacy.01
WHY="$(run_field '(r.results.find((x) => x.promiseId === "privacy.01") || {}).trigger')"
case "$WHY" in *"touched CHAT_TTL_DAYS"*"bound to privacy.01"*) ok "triggered by the binding: $WHY" ;; *) problem "privacy.01 was not triggered by its CHAT_TTL_DAYS binding" ;; esac

# ---------------------------------------------------------------- policy changes, code does not
banner "Change only the policy" "Privacy now also rules out data brokers. The code is the same as main; only docs/privacy.md changes."
git checkout -q -b policy/no-brokers main
sed -i.bak 's/share them with advertisers\./share them with advertisers or data brokers./' docs/privacy.md && rm -f docs/privacy.md.bak
git commit -q -am "Privacy: never share notes with data brokers either"
git --no-pager diff main --stat | sed 's/^/   /'
if [ -z "$(git diff --name-only main -- . ':!docs/privacy.md')" ]; then ok "on $(git branch --show-current): only docs/privacy.md differs from main"; else problem "more than docs/privacy.md changed"; fi

step "Compile the changed policy" "Only privacy is compiled again; the reworded sentence becomes a new promise and the old one is retired." 0 \
  jurator compile --accept ${SCRIPTED_POLICY_EDIT[@]+"${SCRIPTED_POLICY_EDIT[@]}"}
git add .jurator && git commit -q -m "Jurator: privacy recompiled"

step "Check after the policy change" "Policies changed, code did not: only the changed promise is checked; every other result is reused." 0 \
  jurator check ${SCRIPTED[@]+"${SCRIPTED[@]}"}
expect_run none-broken
RECHECKED="$(run_field 'r.incremental && r.incremental.rechecked')"
REUSED="$(run_field 'r.incremental && r.incremental.reused')"
if [ -n "$REUSED" ] && [ "$REUSED" -gt 0 ] && [ -n "$RECHECKED" ] && [ "$RECHECKED" -lt "$REUSED" ]; then
  ok "rechecked $RECHECKED, reused $REUSED (policy state $(run_field 'r.policyState.slice(0, 7)'))"
else
  problem "the policy-only change did not reuse earlier results (rechecked ${RECHECKED:-?}, reused ${REUSED:-?})"
fi
git checkout -q agent/retention

# ---------------------------------------------------------------- hooks: git push and the coding agent
step "Install the hooks" "A git pre-push hook, and a Claude Code PreToolUse hook (Muse Code works the same: hook install muse)." 0 \
  jurator hook install pre-push claude
git init -q --bare "$WORK/team.git" && git remote add team "$WORK/team.git"

step "Push main" "The pre-push hook runs the rules on the pushed commits (no AI, offline): nothing broken, the push goes through." 0 \
  git push -q team main

step "Push the agent's branch" "The pre-push hook finds privacy.01 broken and blocks the push." 1 \
  git push -q team agent/retention

banner "The coding agent tries to push" "Claude Code sends its PreToolUse event to the hook; Jurator answers deny, with the evidence."
PAYLOAD="{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push team agent/retention\"},\"cwd\":\"$PWD\"}"
printf '%s$ echo %s | jurator hook run claude%s\n\n' "$B" "'{...\"command\":\"git push team agent/retention\"...}'" "$N"
ANSWER="$(printf '%s' "$PAYLOAD" | jurator hook run claude)"
if printf '%s' "$ANSWER" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const a = JSON.parse(s).hookSpecificOutput;
    console.log("permissionDecision: " + a.permissionDecision + "\n");
    console.log(a.permissionDecisionReason);
    process.exit(a.permissionDecision === "deny" ? 0 : 1);
  });'; then echo; ok "denied, with the evidence"; else echo; problem "the agent hook did not deny the push"; fi

banner "The agent tries to loosen a rule" "Edits to .jurator/ are denied: rules change through jurator commands and human review."
PAYLOAD="{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/.jurator/rules.json\",\"old_string\":\"30\",\"new_string\":\"90\"},\"cwd\":\"$PWD\"}"
ANSWER="$(printf '%s' "$PAYLOAD" | jurator hook run claude)"
case "$ANSWER" in *'"deny"'*) ok "denied: $(printf '%s' "$ANSWER" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>console.log(JSON.parse(s).hookSpecificOutput.permissionDecisionReason))')" ;; *) problem "the edit to .jurator/ was not denied" ;; esac

# ---------------------------------------------------------------- done
finish
