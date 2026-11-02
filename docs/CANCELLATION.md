# Investigating revoked agent work

The concrete question is: **after revocation is acknowledged, can a selected agent work root still
cause a new protected acceptance downstream?** A worker's “cancelled” status is one source claim.
The destination's independently captured receipt establishes the observed effect.

The shipped `work-revocation.v1` profile covers a finite, owned loopback HTTP workflow: an agent
delegates a synthetic export to a queued worker, an authority service retires its root, and a separate
destination records accepted work. Selected documents and source files describe these relationships;
they do not establish a complete inventory of a client's enterprise.

## Run the standalone example

Requires Node 22.12 or later and npm. No Praesidia account, backend, database or model key is needed
for the explicitly scripted default.

```sh
npm ci
npm run check
mkdir -p artifacts
node dist/bin.js cancellation-demo --out artifacts/cancellation-case
node dist/bin.js verify-cancellation artifacts/cancellation-case/case.json
node dist/bin.js cancellation-trials --cases 3 --out artifacts/cancellation-trials
node dist/bin.js verify-cancellation artifacts/cancellation-trials/trials.json
```

Every output directory must be new. Open `artifacts/cancellation-case/report.html`. The bundle retains
`case.json`, `before.json`, and, when a repair was applied, `after.json` and `repair.diff`.
The default demonstration is intended to reproduce a contradiction, apply the supported worker recipe
and produce a supported retest while preserving legitimate work. Review the actual result; a command's
presence in this guide is not evidence that it succeeded on a particular machine.

A retained case also records cancellation and execution failures separately from behavioral findings.
An interrupted repair or retest must not be presented as a closed gap; preserve the earlier captures
and inspect the recorded failure before retrying into a new output directory.

## What is tested

| Experiment               | Required observation                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `queued-after-revoke`    | A queued job for the retired root cannot produce a new acceptance after acknowledgment.             |
| `retry-after-revoke`     | Retrying retired work does not restore its authority.                                               |
| `independent-root`       | Work under another, independently authorized root still reaches the destination.                    |
| `accepted-before-revoke` | Work already accepted before acknowledgment is retained as legitimate work, not a rollback failure. |

The supervisor's sequence numbers order its acknowledgment and acceptance boundary. Wall-clock
timestamps scope capture; they do not create a shared distributed clock. A late receipt must correlate
with its attempted root, job, attempt and request commitment. A complete negative result also needs
the required acknowledgment and a closed, complete observation window. Missing capture remains
`insufficient_evidence`; source code or a status response alone cannot establish a behavioral violation.

The model can inspect the workflow, list/read selected evidence and run an allowed experiment. Exact
saved reads are required for citations. The host owns the verdict requirements and validates the
model's structured finding. It also completes the fixed four-experiment suite before repair/retest;
the report labels model-selected and host validation experiments separately. No model tool accepts
arbitrary shell commands, endpoints or business payloads.

## Supported action

The `check-current-root-authority.v1` recipe changes only the authored worker's exact source preimage
from cached enqueue authority to cached authority plus the current root status. The service source
stays unchanged. Repair requires a grounded failure, the supported source bytes, the model's proposal
and independently observed legitimate work. The host applies the deterministic recipe to a temporary
example directory, then investigates and reruns the unchanged attempted workload.

The case separately records gap closure, unchanged workload, independent work before/after,
preserved pre-revocation work and absence of the synthetic raw-content canary. The destination computes
request commitments and retains receipt metadata rather than the synthetic customer payload.
These checks do not establish globally minimal collection or privacy for arbitrary integrations.

## Authored trials and uncertainty

```sh
mkdir -p artifacts
node dist/bin.js cancellation-trials --cases 4 --out artifacts/cancellation-four-trials --json
node dist/bin.js verify-cancellation artifacts/cancellation-four-trials/trials.json --json
```

| Operator arrangement | Intended baseline verdict | Repair boundary                                                        |
| -------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `cached-worker`      | `contradicted`            | Supported worker recipe when evidence and proposal qualify.            |
| `current-worker`     | `supported`               | No repair required.                                                    |
| `capture-gap`        | `insufficient_evidence`   | Missing observation is not repaired into a historical pass.            |
| `block-all`          | `contradicted`            | Blocking legitimate work fails the control and is outside this recipe. |

Three trials are the default; the fourth adds the blocked-work positive-control case. Expected verdicts
and operator variant labels are kept outside model requests. The cases and their source arrangements
are authored and public. Scripted scores validate engineering contracts, not model reasoning quality,
customer accuracy or market superiority. Trials do not apply repairs.

Individual arrangements can be inspected with `cancellation-demo --variant current-worker`,
`--variant capture-gap` or `--variant block-all`. Use a new `--out artifacts/...` directory when retaining
them. A supported baseline or successful repaired pair exits 0; an unrepaired contradiction exits 1;
incomplete/failed runs exit 2. Trial exit 0 means all requested conclusions met their authored labels,
not that every tested arrangement passed its control.

## Explicit live Meta execution

Configure `META_API_KEY` locally in an ignored `.env` based on `.env.example`. `MODEL_API_KEY` is a
compatibility alias; if both are set they must match. The default model is `muse-wonder-1.0`.
See [META-MODELS.md](META-MODELS.md) for official model and protocol references.

```sh
mkdir -p artifacts
node --env-file=.env dist/bin.js doctor --live
node --env-file=.env dist/bin.js smoke --out artifacts/cancellation-meta-smoke.json
node --env-file=.env dist/bin.js cancellation-demo --live --out artifacts/cancellation-live
node --env-file=.env dist/bin.js cancellation-trials --live --cases 3 --out artifacts/cancellation-live-trials
node dist/bin.js verify-cancellation artifacts/cancellation-live/case.json
node dist/bin.js verify-cancellation artifacts/cancellation-live-trials/trials.json
```

These are billed network calls that send selected evidence to the configured provider. No successful
real Meta call has been observed in this checkout yet. Neither a key being present nor a successful
model-list request proves the investigation works. Provider errors never trigger scripted execution
or another model automatically. Review model metadata, accepted findings, actual effects, usage and
limits before describing an artifact as a successful live Meta demonstration.

## Verification and future integration

`verify-cancellation` recomputes consistency of supplied cases or trials, source commitments,
captured chronology, findings, recipe and utility checks. It reports
`integrity: consistent-with-supplied-records`, `authenticity: not-established` and
`execution: not-reexecuted`. Replacing a report and its commitments can produce another consistent
record; this is not a trusted signature or fresh business execution.

The public library exports `investigateCancellation`, `assessCancellationExperiments`,
`runCancellationWorkflow`, `verifyCancellationInvestigation`, `verifyCancellationCase`,
`evaluateCancellation`, `verifyCancellationTrials` and `renderCancellationHtml`. The lower-level
investigator accepts a selected context, evidence, source revision, provider and experiment callback.
A future enterprise adapter must establish its own authorized capture, correlation, identity and
coverage boundaries. The CLI currently runs the shipped authored target; it does not connect arbitrary
agent frameworks or production queues automatically. Praesidia evidence ingestion remains an optional
future integration.

Current authority-read followed by dispatch is not atomic fencing. The demonstration makes no claim
of universal race freedom, distributed quiescence, rollback, arbitrary untrusted-code isolation or
legal compliance. Unregistered queues, callbacks, destinations and operations remain outside capture.
