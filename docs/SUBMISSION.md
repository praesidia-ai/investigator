# Meta hackathon submission draft

Status: **not ready to submit**. Startup track is confirmed. Actual live Meta evidence, the final
release checks, reviewed source publication, monitored reporting routes, an independent setup trial
and authenticated portal fields remain pending. The selected repository is
[praesidia-ai/investigator](https://github.com/praesidia-ai/investigator). This worksheet is not a submitted entry.

The published deadline is **4 November 2026, 9:00 PM Eastern Time**, or **5 November, 4:00 AM in
Bucharest**. Recheck the official event page before submitting because dates may change.
[Meta event page](https://dev.meta.ai/events/global-hackathon).

## Title and short pitch

**Praesidia Investigator — prove whether revoked agent work still acts**

When companies delegate work to agents, stopping a conversation may leave queued jobs and retries
running. Praesidia Investigator examines one selected workflow across documents, agent, worker,
authority and destination. It chooses bounded experiments, checks independently observed business
effects and explains exactly which evidence supports its conclusion. A supported worker repair is
then tested against the same workload: retired work stops, independent work continues, and legitimate
work accepted before revocation is preserved.

The case retains exact citations, source revisions, the repair and uncertainty. The application is
Apache-2.0 licensed and standalone; it needs no Praesidia account, key or backend. A future Praesidia
API integration can supply authorized evidence without owning the investigation engine.

This is a finite, owned loopback demonstration with a source-bound recipe. It does not claim to
invent revocation, automatically discover every enterprise system or provide a universal distributed
cancellation protocol. The product hypothesis is that engineers need an actionable, portable
investigation connecting source claims, actual effects and utility-preserving remediation.

## Published judging criteria and our evidence

The published project rubric assigns the following weights across the event; it does not list a
separate Startup weighting. The event also describes Startup entries as real products assessed for
execution and production credibility. These are project criteria, distinct from application selection.
[Official event overview and waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver),
[track description](https://dev.meta.ai/events/global-hackathon).
The source review and implementation priorities are recorded in
[READINESS_RESEARCH_2026-11-02.md](READINESS_RESEARCH_2026-11-02.md).

| Criterion                   | Weight | What the demonstration should establish                                                                                                                                                  |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact                      | 30%    | A clear engineer/control-owner problem: an agent appears cancelled while its delegated work can still reach a business destination. Validate usefulness with an independent setup trial. |
| Use of Meta AI Tooling      | 25%    | Actual Meta-driven evidence selection, experiment choices and grounded structured findings; show the recorded model and tool trace. Transport fixtures alone do not establish this.      |
| Technical Depth & Execution | 20%    | A reproducible standalone install, independent effect capture, fixed verdict requirements, source-bound repair, positive controls and conservative uncertainty.                          |
| Demo                        | 25%    | One inspectable story: late effect, supporting evidence, exact patch, preserved business work and an incomplete-capture comparison. Record the actual successful run.                    |

## Problem, users and product boundary

The first users are platform engineers and control owners releasing agents with delegated business
tools. Their question is operational: did revocation reach the worker and prevent a new protected
acceptance after acknowledgment? A status row alone cannot answer it. The investigator must correlate
attempts and destination receipts, retain incomplete evidence honestly, identify a supported action
and ensure that legitimate work still happens.

The flagship control, `work-revocation.v1`, includes four experiments: queued work after revocation,
a retry, independently authorized work and work accepted before revocation. Source relationships are
selected declarations. Sequence numbers order the supervisor's acknowledgment/acceptance boundary;
they do not establish a global distributed clock. An authority read followed by dispatch is not
atomic fencing, and the example does not establish race freedom or production compliance.

Other implemented capabilities remain available: sourced client context, approval/request-binding
investigations, a separate authorization repair, producer-only evidence instrumentation, saved MCP
imports and dependency-aware change investigations. See [CANCELLATION.md](CANCELLATION.md),
[CLIENT-CONTEXT.md](CLIENT-CONTEXT.md), [ASSURANCE-CHANGES.md](ASSURANCE-CHANGES.md) and
[the market research](MARKET_STRATEGY_2026-11-01.md). They support the product; the demo should tell
one coherent flagship story.

## Architecture and division of responsibility

```text
Selected documents + source + configured workflow relationships
                         |
                         v
        Bounded Meta investigation and evidence tools
           inspect -> experiment -> exact saved reads
                         |
                         v
       Supervisor acknowledgment + attempted request commitment
                         |
                 authored HTTP worker
                         |
                         v
         Independent destination acceptance observations
                         |
                         v
       Host-owned criteria + grounded structured conclusion
                         |
                         v
     Exact supported worker recipe + unchanged workload retest
                         |
                         v
       Portable JSON/HTML case + supplied-record verification
```

The model chooses registered experiments, reads evidence and proposes a structured finding and next
action. It cannot select arbitrary endpoints, shell commands or credentials, change the mandatory
criteria or apply an arbitrary patch. The host validates citations and observed witnesses, completes
the fixed suite for repair/retest, checks the exact source preimage and applies
`check-current-root-authority.v1` only when eligible. Reports distinguish the model-selected
experiments from host validation experiments.

The default provider is explicitly scripted and still executes real synthetic HTTP effects. Live
mode uses the Meta Responses transport with strict schemas and bounded encrypted continuation.
**No successful real Meta run has yet been observed in this checkout.** Do not describe the submitted
product as a demonstrated live Meta investigation until the credentialed gate succeeds and is reviewed.

## Reproduce the standalone demonstration

From this component's source directory, with Node 22.12 or later:

```sh
npm ci
npm run check
mkdir -p artifacts
node dist/bin.js cancellation-demo --out artifacts/submission-cancellation
node dist/bin.js verify-cancellation artifacts/submission-cancellation/case.json
node dist/bin.js cancellation-trials --cases 3 --out artifacts/submission-trials
node dist/bin.js verify-cancellation artifacts/submission-trials/trials.json
npm run smoke:packed
```

Use new output directories. Inspect `artifacts/submission-cancellation/report.html`, `case.json`
and `repair.diff`. The three authored arrangements target `contradicted`, `supported` and
`insufficient_evidence`; a fourth optional `--cases 4` arrangement blocks legitimate work and must
be contradicted. Expected labels and operator variants are withheld from model requests. Authored
public cases are not an independent customer benchmark.

A successful default repaired pair exits 0. An unrepaired contradiction exits 1; incomplete/failed
investigations exit 2. Passing the trial command means its conclusions match the authored labels,
not that each arrangement passed its control. Review any actual execution failure rather than
substituting the intended result.

## Live Meta evidence gate

Configure `META_API_KEY` locally in an ignored `.env` based on `.env.example`. `MODEL_API_KEY` is
accepted for compatibility; if both exist their values must match. The default model is
`muse-wonder-1.0`, subject to actual account access and participant eligibility. Wonder Full is not
an API model. See [META-MODELS.md](META-MODELS.md) for the official references.

```sh
mkdir -p artifacts
node --env-file=.env dist/bin.js doctor --live
node --env-file=.env dist/bin.js smoke --out artifacts/submission-meta-smoke.json
node --env-file=.env dist/bin.js cancellation-demo --live --out artifacts/submission-live-cancellation
node --env-file=.env dist/bin.js cancellation-trials --live --cases 3 --out artifacts/submission-live-trials
node dist/bin.js verify-cancellation artifacts/submission-live-cancellation/case.json
node dist/bin.js verify-cancellation artifacts/submission-live-trials/trials.json
```

These are billed network calls and send selected evidence to the configured provider. Review the
actual model identity, completed/accepted findings, independent observations, utility checks, known
usage and limitations. A catalog request or transport smoke does not prove the full investigation
works. Provider failure never selects scripted mode or another model silently. Keep keys, account
identifiers and unrelated private material out of recordings and assets.

## Existing work, source and event requirements

The independent component owns its evidence contracts, model transport, investigations, authored
targets, repair recipes and portable reports. It has no runtime imports from private Praesidia.
Praesidia's hosted organization data, enforcement, approval workflows and signing infrastructure are
pre-existing separate platform capabilities; this demonstration does not claim those as new work.
Accurately record component development dates and additions in the final entry.

The published waiver permits open-source components when their licenses are followed and the entry
builds upon them. It requires original, owned work that respects others' rights. Review participant
acceptance and Startup representative authority against the rules. The public materials reviewed do
not establish a specific video duration, public-repository requirement or blanket ban on pre-existing
code; inspect the authenticated submission portal rather than invent those requirements.
[Official waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver).

The selected public repository is [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator).
Reviewed source publication and monitored private security/community reporting routes remain release
checks. `private: true` protects npm publishing and does not prevent an open-source GitHub repository. Prepare the source candidate using [RELEASING.md](RELEASING.md);
review the inventory before publishing. Preserve the separate distinction between reusable platform
work, new Investigator work and actual measured results.

## Submission checklist

- [ ] Verify participant acceptance, Startup representative authority, team members and model eligibility.
- [ ] Inspect authenticated portal fields and confirm source visibility, video/link format and submission procedure.
- [ ] Complete actual Meta smoke, flagship investigation and authored trials; review retained results.
- [ ] Run the final serial gate and isolated source/packed-consumer checks; record exact revision/runtime.
- [ ] Have another person follow setup and reproduce the investigation/repair without private siblings.
- [ ] Review source, licenses, notices and sample data; exclude local reports, credentials and client exports.
- [x] Select the public GitHub destination: https://github.com/praesidia-ai/investigator.
- [ ] Verify monitored reporting routes before the public launch.
- [ ] Publish the reviewed source and record its verified commit/tag.
- [ ] Record the actual successful demo using [DEMO_SCRIPT.md](DEMO_SCRIPT.md), with scripted/live labels intact.
- [ ] Add the real video link, final revision and observed results, then recheck the deadline and submit.

Repository URL: [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator).
Source publication and released revision: **not yet verified by this worksheet**. Demo URL: **not recorded**.
Final revision/runtime and measured results: **pending final gate**. No entry has been submitted by
preparing this document, and winning or market leadership is not established by the implementation.
