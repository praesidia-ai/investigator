#!/usr/bin/env bash
# Builds the demo app as a fresh git repo in <dir>: the files in examples/acme-notes/ become `main`, and each patch in
# examples/acme-notes/branches/ becomes a branch off main with that one commit (the planted breaks):
#   feature/csv-export   a teammate adds GET /export.csv without requireAdmin    (branches/feature-csv-export.patch)
#   agent/retention      a coding agent sets CHAT_TTL_DAYS = 90                  (branches/agent-retention.patch)
# A patch file name becomes a branch name by turning its first '-' into '/'.
#
# Authors, dates and git settings are fixed for these commits, so every build has the same commit shas.
# Nothing outside <dir> is changed; the user's git config is not used for the commits.
#
#   bash scripts/make-demo-repo.sh <dir>     <dir> must not exist yet, or be empty
#   bash scripts/make-demo-repo.sh -q <dir>  the same, printing nothing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/examples/acme-notes"
QUIET=0
DIR=
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) QUIET=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    *) if [ -n "$DIR" ]; then echo "One folder only (try --help)" >&2; exit 2; fi; DIR="$arg" ;;
  esac
done
if [ -z "$DIR" ]; then echo "Usage: bash scripts/make-demo-repo.sh [-q] <dir>" >&2; exit 2; fi
if [ ! -d "$SRC" ]; then echo "Demo app files not found: $SRC" >&2; exit 2; fi
if [ -e "$DIR" ] && { [ ! -d "$DIR" ] || [ -n "$(ls -A "$DIR")" ]; }; then
  echo "Not an empty folder: $DIR (the demo repo needs a new or empty folder)" >&2
  exit 2
fi
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

# The app's files, without branches/ (dotfiles such as .gitignore included).
shopt -s dotglob nullglob
for f in "$SRC"/*; do
  [ "$(basename "$f")" = branches ] && continue
  cp -R "$f" "$DIR/"
done
shopt -u dotglob

# Fixed committer and dates; settings that could change a commit (signing, hooks, line endings, ignore files) are off.
export GIT_COMMITTER_NAME="Acme Notes demo" GIT_COMMITTER_EMAIL="demo@example.com" GIT_COMMITTER_DATE="2026-11-04T05:01:27+02:00"
g() {
  git -C "$DIR" -c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.autocrlf=false -c core.safecrlf=false \
    -c core.excludesFile=/dev/null -c apply.whitespace=nowarn -c am.messageid=false -c am.threeWay=false "$@"
}

g init -q
g symbolic-ref HEAD refs/heads/main
g add -A
GIT_AUTHOR_NAME="Acme team" GIT_AUTHOR_EMAIL="team@example.com" GIT_AUTHOR_DATE="$GIT_COMMITTER_DATE" \
  g commit -q -m "Acme Notes 1.3.0 (demo app)"

for patch in "$SRC"/branches/*.patch; do
  name="$(basename "$patch" .patch)"
  branch="${name/-//}"
  g checkout -q -b "$branch" main
  g am -q "$patch" # author and date come from the patch
done
g checkout -q main

if [ "$QUIET" = 0 ]; then
  echo "Demo repo: $DIR"
  g for-each-ref --sort=-refname --format='%(refname:short)|%(objectname:short=7)|%(subject)' refs/heads |
    while IFS='|' read -r ref sha subject; do printf '  %-20s %s %s\n' "$ref" "$sha" "$subject"; done
fi
