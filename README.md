# Praesidia Investigator

Investigate whether revoked AI-agent work still reaches a business system, explain the evidence,
and test a supported repair without breaking legitimate work.

Praesidia Investigator is an independent, open-source application for evidence-driven investigations
of AI-agent controls. Its flagship example follows a selected workflow from agent to queued worker to
destination: the worker reports cancellation, but a separately observed effect can show that the
retired work root still acted after revocation was acknowledged.

Praesidia is an optional future integration; the standalone application does not require an account,
platform key, backend, database, gateway or sibling checkout.

The application provides versioned control profiles, frozen evidence, observed-effect checks,
a bounded investigator/skeptic loop, Meta Responses transport, a supported repair workflow, and
portable HTML/JSON/JUnit reports. It is Apache-2.0 licensed and has no runtime imports from the
private Praesidia platform.

It also provides a sourced client-context snapshot and a control-specific evidence planner: explain
why a selected workflow cannot be assessed, propose a supported collection change, and test that
the new evidence makes safe behavior assessable while still exposing an unsafe implementation.

Change investigations keep findings tied to the system that was tested. Selected MCP exports can
populate the client model; dependency comparisons explain stale evidence, profile-review requirements
and unmapped tools without converting a historical finding into a new behavioral verdict.

## Quick start

Requires Node.js **22.12 or later** and npm. Development is currently verified on Node 26.

```sh
git clone https://github.com/praesidia-ai/investigator.git
cd investigator
npm ci
npm run check
mkdir -p artifacts

# Reproduce the late effect, apply the supported worker repair and retest legitimate work.
node dist/bin.js cancellation-demo --out artifacts/cancellation-case
node dist/bin.js verify-cancellation artifacts/cancellation-case/case.json

# Exercise unsafe, safe and incomplete-capture arrangements without a model key.
node dist/bin.js cancellation-trials --cases 3 --out artifacts/cancellation-trials
node dist/bin.js verify-cancellation artifacts/cancellation-trials/trials.json
```

Open `artifacts/cancellation-case/report.html`: client context, investigation, observed effects,
the exact repair and before/after utility checks are kept together. Default orchestration is
**scripted**, with actual synthetic HTTP effects. Add `--live` only after configuring the Meta key;
no successful real Meta investigation has been observed in this checkout yet. See
[CANCELLATION.md](docs/CANCELLATION.md) for the profile, commands and limits.

## Other supported workflows

After the same build, choose new output paths for the existing examples:

```sh
# Investigate changes after a supported finding; inspect artifacts/assurance-case/runtime-setting.html.
node dist/bin.js assurance-demo --out artifacts/assurance-case
node dist/bin.js verify-assurance artifacts/assurance-case/demo.json

# Import a saved MCP tools/list export without invoking tools.
node dist/bin.js import-mcp examples/mcp-export --json

# Understand selected client systems, documents, agents and configured relationships.
node dist/bin.js understand examples/client-evidence-gap --json

# Diagnose missing evidence and test a producer-only instrumentation change.
node dist/bin.js evidence-demo --out artifacts/client-evidence-case
node dist/bin.js verify-evidence artifacts/client-evidence-case/evidence-plan.json
# Inspect artifacts/client-evidence-case/report.html, context.json and instrumentation.diff.

# The intended reference defect: an approval exists but does not bind the final request.
node dist/bin.js demo

# Compare with the corrected reference target.
node dist/bin.js demo --variant request-bound

# Run a separate HTTP application, reproduce its defect, patch real code and retest.
node dist/bin.js repair-demo --out artifacts/repair-case
node dist/bin.js verify-repair artifacts/repair-case/repair.json
# Open artifacts/repair-case/before.html and artifacts/repair-case/after.html locally.

# Exercise the same CLI against an independently implemented Python HTTP target.
# python3 is needed for this extra example, not for the Investigator runtime.
npm run demo:independent -- artifacts/independent-case
```

The approval-control `demo` uses **scripted orchestration**, with real synthetic control execution and sink
observations. It is not a recorded/live Meta conversation. The vulnerable reference returns exit
code **1** because the claim is contradicted; the corrected reference returns **0**. This does not
establish behavior in any customer repository or production system.

| Command                                                             | Behavior                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `cancellation-demo [--live] [--out new-directory]`                  | Investigate a retired work root, apply a supported worker change and retest actual effects      |
| `cancellation-trials [--cases 1..4] [--live] [--out new-directory]` | Score authored unsafe, safe, incomplete-capture and blocked-work arrangements                   |
| `verify-cancellation <case.json\|trials.json>`                      | Recompute supplied cancellation records; no issuer authentication or fresh execution            |
| `demo`                                                              | Run the synthetic approval-control example with scripted investigator and skeptic roles         |
| `demo --variant request-bound`                                      | Check the corrected reference behavior                                                          |
| `demo --variant block-all`                                          | Show that disabling permitted work fails the positive controls                                  |
| `demo --variant false-refusal`                                      | Detect a refusal response that still dispatches to the sink                                     |
| `demo --variant unavailable`                                        | Record test errors and insufficient evidence instead of passing                                 |
| `investigate <directory>`                                           | Run the live Meta investigator/skeptic against an explicit case bundle                          |
| `init <new-directory> --target-config target.json`                  | Scaffold the supported control with a bound operator-selected HTTP target                       |
| `investigate <directory> --target-config target.json --scripted`    | Exercise that application with explicit deterministic orchestration                             |
| `doctor [--live]`                                                   | Inspect safe configuration; optionally check authenticated model availability                   |
| `verify <report.json>`                                              | Check a saved case's supplied manifest, frozen scope and exact citations                        |
| `verify <report.json> --against <directory>`                        | Additionally compare the declared local dependencies                                            |
| `repair-demo [--out new-directory]`                                 | Investigate and repair a temporary copy of the authored HTTP application                        |
| `repair-demo --live`                                                | Use Meta for the two investigations; the same bounded repair recipe applies                     |
| `verify-repair <repair.json>`                                       | Check paired reports, exact code change, source revisions and unchanged expectations            |
| `understand <directory>`                                            | Project a context manifest with exact citations, source capabilities and unknown boundaries     |
| `evidence-demo [--live] [--out new-directory]`                      | Test a producer-only evidence change with safe and unsafe authorization configurations          |
| `verify-evidence <evidence-plan.json>`                              | Recompute supplied evidence-plan records, chronology, source change and witness-removal results |
| `render <report.json> --out artifacts/case.html`                    | Create a self-contained, escaped, script-free HTML viewer                                       |
| `render <report.json> --out artifacts/checks.xml --format junit`    | Export CI check failures separately from execution errors                                       |
| `schema`                                                            | Print the structural portable-case JSON Schema                                                  |
| `evaluate [--live] [--cases 1..12]`                                 | Run authored cases; scripted regression by default, explicit Meta use with --live               |
| `smoke`                                                             | Explicit live Meta tool/continuation smoke on synthetic evidence                                |

Use `--json` for a machine-readable result and `--out <new-file.json>` to save the full case.
Existing files are never overwritten. Keep generated reports under the ignored `artifacts/`
directory; reports can retain the selected evidence and should be reviewed before sharing.

```sh
mkdir -p artifacts
node dist/bin.js demo --out artifacts/case-report.json
node dist/bin.js verify artifacts/case-report.json
node dist/bin.js verify artifacts/case-report.json --against examples/customer-export
```

Investigation exit codes are **0** supported, **1** contradicted, **2** incomplete/failed.
Verification returns **0** for consistency with the supplied manifest, **2** for invalid/stale or
unavailable evidence. A successful investigation, passing control, evidence integrity and human
acceptance are different facts.

## Live Meta investigations

Set `META_API_KEY` (or compatible `MODEL_API_KEY`) in the environment, not command arguments or case files. The application does not
automatically load `.env` files. Node can explicitly load a local file when desired:

```sh
# Create .env from .env.example and enter the model key locally.
mkdir -p artifacts
node --env-file=.env dist/bin.js cancellation-demo --live --out artifacts/live-cancellation
node --env-file=.env dist/bin.js cancellation-trials --live --cases 3 --out artifacts/live-cancellation-trials
node --env-file=.env dist/bin.js investigate examples/customer-export --out artifacts/live-case.json
node --env-file=.env dist/bin.js smoke --out artifacts/meta-smoke.json
node --env-file=.env dist/bin.js repair-demo --live --out artifacts/live-repair
node --env-file=.env dist/bin.js evidence-demo --live --out artifacts/live-evidence
node --env-file=.env dist/bin.js doctor --live
# Full, explicitly billed verification after reviewing configuration:
node --env-file=.env scripts/verify-meta.mjs --out artifacts/live-verification --cases 5
```

| Environment variable             | Default                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `META_API_KEY` / `MODEL_API_KEY` | One required for live investigations; if both are set they must match |
| `MODEL_ID`                       | `muse-wonder-1.0`; select a model available to your account/event     |
| `MODEL_BASE_URL`                 | `https://api.meta.ai/v1`                                              |
| `MODEL_REASONING_EFFORT`         | `medium`; configurable within supported reasoning levels              |

See [META-MODELS.md](docs/META-MODELS.md) for the verified documentation sources, chosen API model,
account-access check, exact live verification stages and deliberate Spark comparison. Wonder Full
is not a Model API model. The default remains `muse-wonder-1.0`; no model switch happens on failure.

The Responses adapter uses native HTTP, strict Responses `text.format` structured output,
explicit output-token/reasoning limits, `store: false`, opaque encrypted continuation, bounded
responses, timeouts and redirect refusal. Runtime validation still checks evidence and verdicts.
Provider failures never switch to scripted mode or
another model. Only the explicitly selected evidence read through tools is added to model context;
those selected records can contain sensitive data. Case exports contain the chosen evidence and
should be handled according to its source permissions.

Implementation follows [Meta's Responses protocol](https://dev.meta.ai/docs/protocols/responses).
Tests include injected protocol fixtures and a real local HTTP tool-call round trip. A real Meta
service call has **not** been verified in this checkout because no model key was configured.

## Work revocation investigation

The versioned `work-revocation.v1` profile tests one finite, owned loopback workflow. It asks whether
the selected root can create a new protected destination acceptance after the supervisor acknowledges
revocation. Worker status is a separate claim. The host records the acknowledgment/acceptance sequence,
attempt identity, request commitment and bounded observation window.

Four experiments cover queued work, retries, an independently authorized root and work accepted before
revocation. Independent work must continue, and an earlier acceptance is allowed; cancellation does
not imply rollback. Missing required capture cannot establish that no effect occurred.

The investigator can inspect the selected context, read exact evidence and choose registered
experiments. The host validates the finding and completes the fixed four-experiment suite for repair
eligibility and retesting. The report distinguishes model-selected experiments from host validation.
One source-bound recipe changes the worker to check current root authority while keeping the service
and attempted business workload unchanged. It changes a temporary example, not a customer checkout.

This demonstrates an actionable investigation of a specific control. It does not establish global
quiescence, a race-free distributed revocation protocol, arbitrary-agent discovery or production
compliance. The three default trials are scripted engineering regressions; their labels are withheld
from model requests, but they are authored arrangements rather than an independent customer benchmark.
See [CANCELLATION.md](docs/CANCELLATION.md) for the retained proof and integration boundaries.

## Case bundles and evidence

A directory contains `case.json` plus its explicitly selected UTF-8 text/Markdown/JSON evidence.
See [`examples/customer-export/`](examples/customer-export/). Cases include:

- A claim, subject/environment/revision, and a nonempty list of required checks.
- An explicit assessment mode: documentary, recorded-behavior or controlled-test. Currently only
  the known controlled-test profile can produce conclusive behavioral findings; the other modes
  remain unresolved until a corresponding criterion verifier is implemented.
- For the known control, a versioned `controlProfile` with its exact canonical claim and mandatory
  checks, plus `criterionEvidence` mapping each check to its required input sources. A case cannot
  replace the claim or remove checks while retaining that profile.
- Unique evidence IDs, relative file paths, media type and declared coverage/redaction.
- Optional vendor-neutral work context: objective, accountable party and parent work reference.
- An optional synthetic reference target, allowed only in `reference-test` scope.

The local reader bounds file and bundle sizes and rejects absolute/traversal paths, links resolving
outside the case, nonregular files and invalid UTF-8. It snapshots and hashes original bytes before
reasoning. Inputs should be stable while being captured; this path validation is not an OS sandbox
against another local process actively replacing parent directories.

Citations name a saved evidence ID and an exact one-based line range or RFC 6901 JSON pointer. The
quotation must equal the selected text. For a JSON string the exact quotation includes JSON quotes.
No model-created evidence ID or unresolved quotation can support a conclusive finding. Matching
quotes establish that the passage exists, not that the interpretation is legally correct.
JSON-pointer citation parsing is bounded to 32 nesting levels and 20,000 JSON values; reserved own
JSON keys remain present in exact quotations and fingerprints.

Default run limits are eight model turns, twelve tool calls, three minutes, 32,768 generated tokens
per run and 4,096 per call at medium reasoning effort. Three turns and two tool calls are reserved
for the skeptic. These are generation limits, not a monetary-cost guarantee. Unknown usage consumes
its requested allowance; reported token counts remain available as lower bounds after a later
failure. Fixture variant labels stay outside model context. The skeptic receives the candidate,
validated check summaries and evidence metadata, and can read the retained evidence.

The trace includes tool-input digests and start/finish times without raw arguments or private model
continuation. It is an observation journal, not a replayable model transcript. SIGINT/SIGTERM cancel
an ordinary investigation; when `--out` was selected its incomplete case is saved after cancellation.

## Changes after an investigation

`assurance-demo` starts from a supported recorded export control, changes a binding setting, and
withdraws applicability for the affected checks. A new independently observed workload exposes the
unsafe result. Historical findings stay unchanged. Separate cases cover changed tools/policies,
unmapped tool additions and an explicitly excluded document.

`checkpoint` binds the existing evidence-plan report to a fixed dependency/check map for the authored
workload. `assurance-diff` compares selected candidate bytes/configuration without executing them.
`verify-assurance` recomputes recorded consistency. These operations do not authenticate a deployment,
authorize a release or prove dependency completeness. The current adapter runs its full fixed batch
even when the logical impact plan names fewer checks.

`import-mcp` reads an operator-selected saved MCP 2025-11-25 tools/list result. It creates cited,
source-qualified entities and raw-definition fingerprints. Annotations do not grant trust, schema
references are not resolved and overall source coverage remains partial. No server or tool is called.
See [ASSURANCE-CHANGES.md](docs/ASSURANCE-CHANGES.md) for the commands, input contracts and limits, and
[the market research](docs/MARKET_STRATEGY_2026-11-01.md) for the prior art and validation plan.

## Client understanding and evidence planning

`understand` projects the selected `context.json` manifest and existing case evidence into a
source-linked model of documents, agents, systems, tools, identities and relationships. Source
identities, tenant boundaries, revisions, capture windows and exact citations are checked. Declared,
configured, observed and derived assertions remain distinct, including conflicts and unknown paths.
This is a projection of supplied declarations, not autonomous whole-company discovery.

`evidence-demo` connects that model to an explicit read-only planning loop and the authored HTTP
example. The legacy execution record lacks a reliable approval/request join. One supported
instrumentation recipe adds the necessary metadata without changing authorization or collecting raw
synthetic customer content. Independent downstream observations then establish the safe result and
expose the unsafe configuration. Before/after business work and approval semantics must match.

The new report retains source context, the exact producer read and patch, four controlled attempts
per run, remaining uncertainty and 20 witness-removal checks. Those checks concern a fixed schema
and workload; they do not establish globally minimal telemetry or legal compliance. This separate
evidence profile does not enable arbitrary historical cases to produce conclusive findings.
See [CLIENT-CONTEXT.md](docs/CLIENT-CONTEXT.md) for input contracts, library queries and limits.

## Reference control and assessment

The reference profile executes against a controlled in-memory export target and an independent
sink. It tests three fixed families:

1. Independent approval: absent, fabricated, self-approved or untrusted approval cannot dispatch.
2. Exact action binding: changing request, actor, destination or payload, expiry and grant reuse
   cannot authorize a new effect.
3. Permitted work: the exact approved action and harmless operations still succeed.

A target's response and its actual sink effects remain separate observations. The model can invoke
registered checks and select evidence; it cannot edit expectations. A supported finding must cite
the observed PASS result for every mandatory criterion and satisfy that criterion's input coverage.
An observed FAIL citation can establish a bounded counterexample despite unrelated incomplete
history. A policy quotation alone cannot establish a behavioral violation. Unrelated optional
partial/redacted artifacts do not invalidate otherwise complete criterion evidence. Conclusive
statements are rendered by the host with the exact subject, revision and test scope.

Imported historical evidence and controlled tests have different scope. These checks do not
establish legal applicability or deployed controls. The scripted provider supports only the known
customer-export control and is explicitly labeled as a test provider.

## External application and supported repair

`repair-demo` copies `examples/export-service` into an owned temporary directory. Its Node HTTP
process is separate from Investigator. A supervisor-owned loopback sink records actual effects;
application status text and effect counts are distinct. All customer data and destinations are
synthetic; the service dispatches only to that local sink. The identical frozen reference scenarios
and expectations run against HTTP before and after the change.

The supported recipe changes `authorization.mjs` from an unconditional binding check to comparing
the trusted grant's request digest with the actual request digest. It is a deterministic repair
recipe, not a claim of general autonomous code repair. A confirmed binding failure is required;
the source preimage is checked before applying the change. No customer checkout is modified.

`--out` creates a new directory with before/after JSON cases and HTML viewers, `repair.diff`, and
`repair.json`. The repair report retains both application source manifests, exact change digests,
and a digest of the unchanged scenario expectations. Verification recomputes these bindings; it
does not rerun the application or establish independently trusted authorship. The temporary service
and source copy are cleaned up. This separate process is **not an OS security sandbox**; the adapter
is only for the explicitly selected authored fixture, not arbitrary untrusted repository code.

`ControlCheckAdapter` is the host-selected extension seam. Controlled targets carry an adapter ID,
version, source revision and operator configuration digest. Host applications can supply another
adapter identity without modifying core schemas; the versioned control's criteria remain fixed.
The CLI supports the built-in HTTP approval protocol through `--target-config`, with separate target,
fixture-administration and observer credentials read from operator-selected environment names.
Model tools cannot supply commands, endpoints or credentials. Only the customer-export control is
currently implemented; a new control profile still needs an explicit criterion verifier.

Follow [ADAPTERS.md](docs/ADAPTERS.md) to connect a compatible test harness using `init` and
`investigate`. The worked example independently implements the target in Python and the effect
observer in Node. It records actual HTTP sink effects, pins code/configuration revisions, rejects
incomplete or cross-run capture, and cleans up per-run observer sessions. It modifies only the
example's authorization configuration between the two demonstrations; it does not claim to
autonomously repair arbitrary client applications.

## Evaluation

```sh
mkdir -p artifacts
node dist/bin.js evaluate --out artifacts/regression-results.json
node --env-file=.env dist/bin.js evaluate --live --cases 5 --out artifacts/live-evaluation.json
```

The authored suite keeps expected labels outside model context and covers approval binding,
blocked legitimate work, false refusal, unavailable execution, partial/unknown/redacted dependencies,
unrelated incomplete material and injected evidence instructions. Scripted runs validate the
engineering contracts; they do not measure model investigation quality. Reports flag whether the
adversarial source was actually read. An unread injection is not evidence of injection resistance.
Live evaluations are explicit paid provider calls and are not part of ordinary CI. Results report
grounded verdicts, abstention, resolvable citations, check/utility outcomes, duration and known tokens;
monetary cost remains unknown. These are authored regression cases, not a representative customer
benchmark or independent proof of the skeptic's benefit.

## Portable reports

`investigator-case-v1` includes the case, original snapshots, role/tool trace, check observations,
usage availability, finding and limitations. A run is committed to the exact case and initial
evidence metadata. Reference observations are bound to their declared target variant. Reports have
a SHA-256 integrity manifest and an 8 MiB serialized size limit.

Verification establishes consistency **relative to the supplied manifest**. A party able to replace
both report and manifest can create a different consistent document. This is not an independently
trusted signature, Praesidia attestation or universal proof of the business outcome. Praesidia's
public verifier may be integrated later for authentic platform-signed bundles, with separate trust
configuration.

Freshness compares only manifest-declared local inputs; unrelated files do not invalidate the case.
Undeclared runtime/deployment changes remain outside that check. Historical reports stay unchanged.

## Structure and development

```text
src/
  core/          Runtime schemas, evidence, citations, commitments, assessment and coordinator
  connectors/    Scoped local bundle loading; future authorized platform adapters
  context/       Sourced client model, capability catalog and bounded graph queries
  assurance/     Recorded dependency validity, review boundaries and supported revalidation
  cancellation/  Bounded work-revocation investigation, observed effects, repair and authored trials
  evidence-plans/ Read-only planning, fixed witness requirements and supplied-record verification
  providers/     Model contract, live Meta Responses and explicit scripted reference
  reference/     Frozen synthetic control scenarios and effect observations
  targets/       Operator-selected external application test adapter
  remediation/   Supported isolated repair and paired-case verification
  evaluation/    Authored cases with host-side expected labels
  reports/       Portable JSON, inert HTML, JUnit and JSON Schema
  io/            Bounded file reads
  cli.ts         Testable command interface
  bin.ts         Executable entry point
  index.ts       Narrow public library surface
tests/           Boundary, control, transport, coordinator, report and CLI checks
examples/        Synthetic case plus separately runnable HTTP export application
```

```sh
npm run format
npm run check
npm run smoke:packed
npm run release:readiness
```

The canonical gate checks formatting, all source/test types, tests and the production ESM build.
The selected public source repository is [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator).
Verify the published revision as part of each release. The package's `private: true` prevents npm
registry publication and does not prevent an open-source GitHub repository. No packages are published by the build. Prepare local runtime/source archives
with the commands in [RELEASING.md](docs/RELEASING.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for boundaries and extension guidance. Optional
scoped Praesidia ingestion, additional external applications, criterion verifiers for historical
records, and independently evaluated skeptical challenges remain future increments.
