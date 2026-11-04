---
name: jurator
description: Use when you edit code in a repo that has a .jurator/ folder. Before editing, ask Jurator which company promises (from the written policies) apply to the files; before pushing, run the Jurator check. Jurator decides whether a promise holds, never you.
metadata:
  display-name: Jurator
---

# Keep the company's promises

This repo's policies are compiled into numbered promises (e.g. `security.01`) in `.jurator/`. Jurator checks them; you do not.

1. **Before editing**, call `mcp__jurator__promises_for_change` with the files you plan to change. Respect each promise and its policy quote in your edit.
2. **Before pushing**, commit, then call `mcp__jurator__check_change` (or run `jurator check --diff main`). It reads committed code at HEAD.
3. If a promise is **BROKEN**, fix the cited lines and check again. If you think the promise or its rule is wrong, stop and tell the person.
4. **Never judge a promise yourself.** Only a check says HOLDS or BROKEN; NOT CHECKED means no rule covers it yet, so say that.
5. **Never edit `.jurator/`**, and never run `jurator accept`, `compile`, `rule` or `conflicts`: people decide those.
6. Call `mcp__jurator__explain_promise` with an id when you need its quote, rules or last verdict.
