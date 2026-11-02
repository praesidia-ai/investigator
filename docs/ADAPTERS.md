# Connecting an independently implemented approval target

`ControlCheckAdapter` is the public boundary between an application-specific test driver and the investigation engine. A new adapter supplies identity, version, frozen subject revision, configuration digest and `runChecks(signal)`; it does not require changes to the control profile, model instructions or verdict engine. `runExternalApprovalChecks` runs the same frozen approval scenarios and expectations used by the reference suite.

The built-in `http-approval-target` adapter speaks the finite `approval-target-v1` **test-fixture protocol** below. It does not discover endpoints, run commands or execute an arbitrary repository. The operator chooses the configuration file. Evidence, model output and tool arguments cannot select a URL, credential or shell command. `/__investigator__/reset` deliberately replaces fixture grants; implement and enable it only on a dedicated authored test application with a separate administrative credential.

## Operator configuration

```json
{
  "kind": "http-approval-target",
  "schemaVersion": 1,
  "fixtureProtocol": "approval-target-v1",
  "subjectRevision": "<64 lowercase hexadecimal SHA-256 characters>",
  "target": {
    "baseUrl": "https://fixture.example.org",
    "credentialEnv": "EXPORT_TEST_API_KEY",
    "adminCredentialEnv": "EXPORT_TEST_ADMIN_KEY"
  },
  "observer": {
    "baseUrl": "https://independent-sink.example.org",
    "credentialEnv": "EXPORT_OBSERVER_KEY"
  },
  "allowLoopbackHttp": false,
  "timeoutMs": 5000,
  "maxResponseBytes": 262144
}
```

Replace the revision placeholder with the operator-pinned digest. The target and observer require distinct origins and three distinct credentials of at least 16 characters. Configuration holds environment **names**, never secret values. All other fields are rejected. HTTPS is required; explicit `allowLoopbackHttp: true` permits only literal `127.0.0.1` or `[::1]` HTTP origins. Redirects, URL credentials, query strings, URL fragments and non-root base paths are refused. Each request and response is bounded by time, bytes and the supplied abort signal. Defaults are shown above. Credential rotation does not change the digest of normalized configuration.

```ts
import { loadHttpApprovalTarget, loadLocalCase, investigate } from '@praesidia/investigator';

const adapter = await loadHttpApprovalTarget('/operator/config/target.json', process.env);
const bundle = await loadLocalCase('/operator/cases/export-control');
// Use an explicitly selected ModelProvider. Credentials remain in this adapter's transport.
const run = await investigate({ ...bundle, provider, checkAdapter: adapter });
```

The case must use the existing `customer-export-approval` version 1 control profile, `assessmentMode: "controlled-test"`, and all three required checks. Set `subject.revision` to the same SHA-256 and declare:

```json
"controlledTarget": {
  "kind": "http-approval-target",
  "version": 1,
  "configurationDigest": "<adapter.configurationDigest>"
}
```

There is no `referenceTarget` in this case. The digest binds the operator's transport selection; it is not a signature or proof of code authorship. A remote revision identity is a protocol assertion, not independently attested deployment provenance.

The CLI can scaffold that binding without credentials or network access:

```sh
node dist/bin.js init ./new-case --target-config /operator/config/target.json
# Edit the synthetic starter policy/request files and their declared coverage for your actual test.
node dist/bin.js investigate ./new-case --target-config /operator/config/target.json --scripted --out ./contract-case.json
# With a locally configured Meta key, omit --scripted for live model investigation.
```

The configuration points to a dedicated compatible fixture. Investigator does not add test-administration
routes to a production service or discover an uninstrumented application's effect destination.

## Fixed fixture protocol

All JSON bodies use `Content-Type: application/json`. API and administrative requests authenticate with their selected Bearer credential. The target never receives the observer read/admin credential.

1. **Identify both parties.** `GET /__investigator__/identity` returns `{protocol:"approval-target-v1", fixture:true, role:"target"|"observer", subjectRevision}`. Both must match before any reset and again after the suite.
2. **Create capture.** The observer accepts administrative `POST /__investigator__/sessions` with `{schemaVersion:1, runId, scenarioId, subjectRevision}` and returns those identifiers plus an unpredictable `captureToken`. A session must be unique; its capability authorizes only that scenario's actual effect sink.
3. **Install fixture grants.** Target administrative `POST /__investigator__/reset` receives `{schemaVersion:1,runId,scenarioId,subjectRevision,grants,grantsDigest,now,captureToken}`. It acknowledges `{runId,scenarioId,subjectRevision,grantsDigest,now,ready:true}`. The full grant set and clock come from the frozen runner, including malformed approval presentations, self-approval, expiry and reuse probes. The reset credential is distinct from ordinary target invocation.
4. **Register an attempt before invocation.** Observer administrative `POST /__investigator__/attempts` receives `{runId,scenarioId,attemptId,requestDigest}` and returns the same fields plus an unpredictable `challenge`. IDs are generated by the adapter, outside model control.
5. **Invoke the application.** Target `POST /export` receives `{runId,scenarioId,attemptId,challenge,request}`. `request` contains the fixed runner's `requestId`, `action`, `actorId`, `destination`, `payload`, and approval presentation. Approval authority comes from issued grants, not caller-supplied `claimedStatus`, `claimedApproverId` or `claimedRequestDigest`. Reply `{status:"executed"|"approval_required"|"denied"|"unavailable",reason,claimedEffectCount}`.
6. **Observe actual effects separately.** For allowed work the application calls the separately hosted synthetic sink's `POST /__investigator__/effects` with `{runId,scenarioId,attemptId,challenge,effect}` using `captureToken` as Bearer credential. `effect` is `{requestId,action,actorId,destination,payload,requestDigest}`. The supervisor-owned example sink actually materializes this synthetic write; it is not a projection of the target's returned status. The sink recomputes the effect digest and assigns its own sequence number.
7. **Close the capture.** The application calls observer `POST /__investigator__/settle` with `{runId,scenarioId,attemptId,challenge}` using the capability. Once settled, further effects for that attempt must be refused. A blocked request still settles without an effect. The application must synchronously finish effect submission and settlement before responding to `/export`.
8. **Read independent observation.** Observer administrative `GET /__investigator__/snapshot?runId=...&scenarioId=...` returns `{runId,scenarioId,subjectRevision,coverage:"complete",settledAttemptIds,effects:[{attemptId,effect:{sequence,...}}]}`. Only exact registered/settled attempts, continuous append-only effect sequences and matching content digests are accepted. Partial capture, unavailable services, stale/cross-run identifiers, changed identity, mutated history and secret-bearing responses never establish a passing control.
9. **Release captures.** Observer administrative `POST /__investigator__/cleanup` receives `{runId}` and removes that run's temporary sessions, returning `{removed}`. The adapter attempts this with its own bounded teardown deadline even after cancellation. A capture capability cannot clean up sessions. Failed cleanup does not turn a test error into prevention; the observer must bound retained state.

Request and grant digests use this package's stable sorted-key JSON representation of `{requestId,action,actorId,destination,payload}` or the complete grant array. This is a finite fixture convention, not a claim of RFC 8785 canonicalization. See the independently implemented Python example for cross-language encoding of the synthetic values.

The observer must be independent of application success/refusal responses. Supplying the application's own logs as the observer defeats this boundary. Real integrations must define an authoritative effect destination and capture closure for their environment; this adapter's fixture protocol alone does not establish absence of other destinations or production-wide data loss prevention.

## Second application demo

`examples/independent-export-service/service.py` is a Python standard-library application. It imports no Investigator code and independently implements approval authorization. `observer.mjs` runs in the supervising Node process and owns the actual synthetic effect destination. The application receives only an attempt-scoped sink capability. Neither process executes third-party checkout code, and this is not an OS sandbox.

After building, run:

```sh
node scripts/independent-demo.mjs /new/output/directory
# Explicit real Meta investigation, after configuring the ignored .env:
node --env-file=.env scripts/independent-demo.mjs --live /another/new/directory
```

The script requires `python3`. It copies only these authored fixtures, starts the target and independent observer, generates an operator config and matching case, and invokes the actual built CLI twice with `--target-config ... --scripted`. The first application configuration omits exact-request binding; the second enables it. The target revision changes. Scenarios, expectations, profile and engine do not change. The example checks the expected `PASS/FAIL/PASS` then `PASS/PASS/PASS`, stores the two reports, and stops owned processes. Configuration files contain credential names; ephemeral values are never saved. Saved endpoint ports are only valid during that execution.

The default demonstration uses explicit scripted orchestration. `--live` deliberately selects Meta,
and the saved summary records actual provider/mode/model; no live success is claimed until that run
passes. Both modes establish only the recorded synthetic application's behavior and preserved
permitted work, not arbitrary repair generation, external deployment attestation or production coverage.
