# Flagship demo preparation and recording script

Recommended edit: **2–3 minutes**, subject to the authenticated portal's actual fields. This is a
presentation recommendation, not a verified event video requirement. See [SUBMISSION.md](SUBMISSION.md)
for the deadline and official judging weights.

The story is: **the client revoked an agent's work, the queued worker still acted, and the investigator
proved it with a downstream receipt before testing a supported repair.** Show one concrete workflow
and the legitimate work that must survive the fix.

## Prepare inspectable artifacts

Run the maintainer's final serial checks before recording. Use synthetic data and new output paths.
The offline rehearsal requires no model key:

```sh
mkdir -p artifacts
node dist/bin.js cancellation-demo --out artifacts/cancellation-rehearsal
node dist/bin.js verify-cancellation artifacts/cancellation-rehearsal/case.json
node dist/bin.js cancellation-trials --cases 4 --out artifacts/cancellation-rehearsal-trials
node dist/bin.js verify-cancellation artifacts/cancellation-rehearsal-trials/trials.json
```

This is scripted orchestration with actual synthetic HTTP effects, not a replay or live Meta run.
Open `artifacts/cancellation-rehearsal/report.html`, `repair.diff`, and the trial HTML files.
`trial-03.html` is the incomplete-capture comparison; `trial-04.html` is the blocked-work comparison.
Review the actual findings before using either in the recording.

For the final Meta demonstration, enter `META_API_KEY` locally in an ignored `.env` based on
`.env.example`. `MODEL_API_KEY` is the compatibility alias; both aliases must match if set.
The default API model is `muse-wonder-1.0`; confirm account access and event eligibility.
[META-MODELS.md](META-MODELS.md) explains the model choice and protocol checks.

```sh
mkdir -p artifacts/recording-01
node --env-file=.env dist/bin.js doctor --live
node --env-file=.env dist/bin.js smoke --out artifacts/recording-01/meta-smoke.json
node --env-file=.env dist/bin.js cancellation-demo --live --out artifacts/recording-01/live-cancellation
node --env-file=.env dist/bin.js cancellation-trials --live --cases 3 --out artifacts/recording-01/live-trials
node dist/bin.js verify-cancellation artifacts/recording-01/live-cancellation/case.json
node dist/bin.js verify-cancellation artifacts/recording-01/live-trials/trials.json
```

Live commands are billed provider calls that expose selected evidence to that provider. No successful
real Meta call has yet been observed in this checkout. Record the final live demonstration only after
the actual smoke, flagship investigation and authored trials succeed and are reviewed. A configured
key or model-list response alone does not satisfy that gate. Failures do not trigger scripted fallback.
Retain failed or incomplete evidence honestly; use another new output directory for a subsequent run.

Open these reviewed artifacts before recording:

- `artifacts/recording-01/live-cancellation/report.html`
- `artifacts/recording-01/live-cancellation/repair.diff`
- `artifacts/recording-01/live-trials/trial-03.html`
- `artifacts/cancellation-rehearsal-trials/trial-04.html`, visibly labeled scripted

## Shot list and narration

| Time      | On screen                                                      | Suggested narration                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | Client context in the flagship report                          | “When a company revokes an agent's work, its queued workers and retries may still run. This selected workflow connects the agent, authority, worker and destination.”                                                                   |
| 0:20–0:50 | Baseline observed effects and worker status                    | “The worker reports cancellation. The independently observed destination receipt shows what actually happened after the supervisor acknowledged revocation. The request and attempt commitments correlate the effect.”                  |
| 0:50–1:15 | Investigation, real provider metadata and exact evidence reads | “In this completed run, Meta chose registered experiments and read the supporting evidence. The host validates the structured conclusion against fixed requirements and actual effects.”                                                |
| 1:15–1:45 | Worker diff and repair/retest checks                           | “The supported recipe changes only this worker's authority check. The same attempted workload now blocks retired work, while independent work and pre-revocation acceptances remain legitimate.”                                        |
| 1:45–2:05 | Actual incomplete-capture trial                                | “Missing acknowledgment or an incomplete observation window cannot prove nothing happened. The investigator retains insufficient evidence.”                                                                                             |
| 2:05–2:20 | Blocked-work trial, labeled scripted                           | “Blocking every job also fails: independent authorized work must continue.”                                                                                                                                                             |
| 2:20–2:45 | Verification output, source/setup and scope                    | “The client keeps the evidence, exact patch and portable case. Verification checks supplied consistency, not trusted authorship or fresh execution. Investigator runs without Praesidia; the current target is an owned test workflow.” |

Use the Meta narration only when the saved run actually records live mode and an accepted completed
finding. For a scripted rehearsal, explicitly say that orchestration is scripted throughout. The
report labels model-selected and host validation experiments; preserve that distinction on screen.

Adjust timing to the portal and actual latency. A cut to a completed run should be labeled; retained
artifacts are evidence from a completed run, not a new execution while the viewer watches. Do not
imply an unmeasured response time, a real customer deployment or a universal distributed cancellation
solution. Current authority-read followed by dispatch is not atomic fencing.

## Final recording checks

- Show the actual acknowledgment, correlated receipt and legitimate-work result, not only a summary.
- Keep model/provider identity, scripted/live mode, incomplete outcomes and scope visible.
- Describe the patch as a supported source-bound recipe, not arbitrary autonomous repository repair.
- Do not turn authored trial scores into customer accuracy, market leadership or a unique-invention claim.
- Use [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator) and verify the published source revision before recording.
- Keep API keys, account identifiers, private reports and unrelated browser/terminal content off screen.

The earlier [client-evidence](CLIENT-CONTEXT.md), [change-investigation](ASSURANCE-CHANGES.md) and
[external adapter](ADAPTERS.md) workflows remain available for technical follow-up. Keep the short
recording focused on the revocation investigation. This file does not record, upload or submit a demo.
