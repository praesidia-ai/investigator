# Jurator: the 3-minute video

The shot list from the demo review (E-5), cut down to what exists today. Every terminal shot comes from one take of
`scripts/demo-live.sh --video`. Nothing on screen is staged: the AI steps are live Meta model calls, and the one step
that is not real (the agent's hook event) is labelled on screen as a **simulated agent call**.

## Record

```sh
npm run build
bash scripts/demo.sh --video --pause        # rehearsal: free, offline; the screen says "scripted answers"
bash scripts/demo-live.sh --video --pause   # the take: live model calls, about $0.66
```

The take needs `META_API_KEY`: in the environment, or in an env file (`--env-file <path>`, by default `.env` in the
current folder) that node loads into the jurator process. The demo app is built fresh from `examples/acme-notes`
for every take, with the same commit shas each time.

- Terminal: **100 columns** by about 32 rows, a large font, light theme. `--video` keeps every line within 100
  columns, shows repo-relative paths and 7-character shas, and prints no step banners or self-check lines.
- `--pause` waits for Enter before each shot and prints nothing, so each shot starts on a clean prompt.
- The script still checks every outcome. Scripted, a wrong outcome stops it with a red line. Live, it prints a
  yellow `!` line and carries on; re-take if you see one.
- The measured take (07:19, 4 Nov) cost **$0.66**: compile $0.13, rule propose $0.37, bind $0.12, `check` $0.02,
  `check --diff main` $0.02, the check after it $0.00. (Its transcript was kept with the sprint notes, outside
  this repo.)
- Live answers vary between takes. That take had 14 promises and 10 code promises; the scripted rehearsal has 11
  and 9. The voice lines below name no counts and only one id, `privacy.01`, which is the same in both.

## Shot list (3:00)

| Time | Shot | On screen (exact command) | Voice |
|---|---|---|---|
| 0:00 | Hero | The BROKEN box from shot 7, zoomed | "An agent just changed our code in a way that breaks our privacy policy. Jurator caught it, and no AI made that call." |
| 0:10 | Card | "Pre-existing work" slide (from Investigator: the quote checker and the Meta provider) | "Before this week: about 1,170 lines of Meta provider code from Praesidia's Investigator. Everything else was built this week." |
| 0:20 | Deck | The problem slide | "Companies write promises in their policies. Coding agents now change code faster than anyone checks it against them." |
| 0:35 | 1 | `jurator init` | "Jurator finds the policies in the repo: privacy, security, and the settings exported from Praesidia's agent platform." |
| 0:42 | 2 | `jurator compile --accept` | "Muse Wonder, live, turns each policy into numbered promises. The program finds every quote word for word. And with no AI, it sees that privacy says 30 days while the agent settings say 90." |
| 1:05 | 3 | `jurator rule propose --all --accept` | "The model writes a rule for each promise it can check in code. Jurator keeps a rule only after proving it can fail: it removes the guarding line, and the rule must fail." |
| 1:30 | 4 | `jurator bind --all` (speed up 2x) | "It also records where each promise lives. CHAT_TTL_DAYS, line 2, belongs to the 30-day promise." |
| 1:38 | 5 | `jurator check` | "On main, every rule holds. A promise with no rule is only read by the AI, it says so, and it never blocks." |
| 1:48 | 6 | `git checkout -q agent/retention && git rebase -q main`, then `git diff main -- src/agent/chats.ts` | "Now an agent changes CHAT_TTL_DAYS from 30 to 90, to match the agent settings. That is the wrong policy." |
| 1:58 | 7 | `jurator check --diff main` | "Broken, proved by a rule: the policy line, the code line, the old value, and why this promise was checked." |
| 2:15 | 8 | `jurator verify .jurator/local/runs/<run>/run.json`, then `jurator check --diff main` | "Anyone can re-check this record with no AI. Run the check again and there is nothing to recheck." |
| 2:28 | 9 | `jurator hook install pre-push claude`, then the yellow "simulated agent call" lines and `echo '{...}' \| jurator hook run claude` | "The same rules guard the coding agent. This is a simulated agent call: the event Claude Code sends before it runs git push. The hook answers deny, with the evidence." |
| 2:45 | 10 | `git push -q team agent/retention` | "And on every git push, by people too. Rules only, no AI, about a second." |
| 2:52 | End | Card: the cost line and the repo URL | "Measured: compile 13 cents, rules 37 cents, each check 2 cents. Checks after that are rules only and free." |

Shot numbers follow the order the script runs. The hero (0:00) reuses the box from shot 7.

## Not in this cut (and why)

- **A real Muse Code or Claude Code session** (E-5 shot 1:25). The hook has not run inside a real agent session
  yet, so the script sends the event itself and the screen says "simulated agent call". When a real session is
  recorded with `jurator hook install muse` (and it fails closed), it replaces shot 9.
- **The policy-only change** (`demo.sh` steps 16-18). Live, the reworded sentence can compile to a checklist item,
  and the check then shows "rechecked 0".
- **The csv-export branch, `jurator conflicts` and `jurator status`.** They work and are in `demo.sh`, but the
  video has no time for them. Shot 2 already shows the conflict.
- **The report page.** `jurator report <run.json>` writes `jurator-report.html`. It can be a 3-second insert in
  shot 7, but it is not part of the script.
- **Benchmark numbers and Muse Spark.** Use them only if the live bench run (FX-3) is saved, and only its numbers.

## Lines that must stay true

- Say "live" only for the live take. The screen says so too: `with muse-wonder-1.0 (live)` and
  `AI: muse-wonder-1.0 (live)` live, `scripted answers` in the rehearsal.
- HOLDS and BROKEN come only from rules. An AI read says LOOKS KEPT, LOOKS BROKEN or CAN'T TELL and never blocks.
- Do not claim a PR integration, Drata, Vanta or AWS connectors, or a waive command. None of them exists.
