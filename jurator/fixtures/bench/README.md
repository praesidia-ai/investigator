# Bench cases (acme-notes)

`jurator bench` applies each case in `cases.json` to the baseline copy of acme-notes `main` in `acme-notes/`
(commit `3831872`), then asks each method whether a promise is broken. `promises.json` and `rules.json` are the
accepted promises and rules from the demo workspace. Breaks (B1-B5) name the promise they break; harmless changes
(H1-H3) break nothing. Two breaks are hard on purpose: B4 writes the chat lifetime as `30 * 3` (a regex value rule
passes it unless the engine evaluates simple arithmetic), and B5 breaks a promise that has no rule.

Every method also reads the unchanged code once, and flags it already raises there ("old flags") are not counted
against a change. `live/` holds the recorded live runs; only those numbers are quoted anywhere.

`promises.json` was first saved without typed facets. On 4 Nov (FX-I) each promise got the facets the current compile
gives it (same quotes, same ids), so value rules know privacy.01's "at most 30 days", as they do in `check`. With that,
`jurator bench --no-ai` gives Rules only 4/5 (B4 caught: "CHAT_TTL_DAYS is 90 (30 * 3)"). The live AI rows in `live/`
were recorded before this change and were not re-run.
