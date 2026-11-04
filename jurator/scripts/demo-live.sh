#!/usr/bin/env bash
# Jurator demo with LIVE Meta model calls: the same steps as demo.sh, without --scripted.
# compile, rule propose, bind and the AI reads in check call the model; the hooks and verify never do (rules only).
# Expected cost: about $0.80 (the original steps about $0.60; bind, the policy-only recompile and its check about $0.20).
# Live, the reworded privacy sentence may compile to a process promise (a checklist item), so its check rechecks 0.
#
# The API key: META_API_KEY (or MODEL_API_KEY) from the environment, or an env file holding it:
# --env-file <path>, default .env in the current folder (also JURATOR_ENV_FILE). node loads the file into the
# jurator process (node --env-file); this script never reads, prints or copies the key or the file.
# Live output can differ from the script (other promise wording, other rules): differences are reported, not fatal.
#
#   META_API_KEY=... bash scripts/demo-live.sh [--pause] [--clean] [--video]
#   bash scripts/demo-live.sh --env-file ~/keys/meta.env [--pause] [--clean] [--video]
#
# --video is the recording cut (docs/VIDEO.md): the AI steps run live on screen (compile, rule propose, bind and the
# AI reads in check; about $0.60 per take), the labels say "(live)" because they are, and the agent step is shown as
# a "simulated agent call" (no agent session runs in this script).
export JURATOR_DEMO_MODE=live
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/demo.sh" "$@"
