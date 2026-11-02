# Client understanding and evidence planning

The standalone application can project selected client documents, agent definitions, systems,
identities and relationships into a cited, versioned snapshot. A separate evidence-planning workflow
diagnoses a missing approval/execution witness and tests one supported collection change.

This increment does not crawl a company or automatically extract a complete model from arbitrary
documents. The context manifest supplies candidate entities and assertions; runtime validation checks
their references, exact quotations, revisions, observation windows and declared source capabilities.
A valid citation establishes that a passage exists, not that the asserted relationship is true.

Saved MCP tool listings can now populate part of the model without manually declaring every tool.
Change investigations preserve the resulting evidence's dependency context and explain when a
recorded finding needs review or retesting. See [ASSURANCE-CHANGES.md](ASSURANCE-CHANGES.md).

## Run the supported workflow

From the standalone component after `npm ci` and `npm run check`:

```sh
mkdir -p artifacts

# Project the selected client's declarations; no model key or Praesidia account is used.
node dist/bin.js understand examples/client-evidence-gap --json

# Explicit deterministic planner with real HTTP execution and independent sink observations.
node dist/bin.js evidence-demo --out artifacts/client-evidence-case
node dist/bin.js verify-evidence artifacts/client-evidence-case/evidence-plan.json

# Explicit live Meta planning after configuring the key locally.
node --env-file=.env dist/bin.js evidence-demo --live --out artifacts/client-evidence-live
```

`evidence-demo` creates a new directory containing `context.json`, `evidence-plan.json`,
`instrumentation.diff` and the self-contained `report.html`. Output directories must not already
exist. The workflow cleans up its temporary source copies, child processes and observer.
Live failure never switches to scripted mode. The live planning loop has five model turns, eight
tool calls, a 90-second default deadline and an 8,192-token generated-output budget. Missing usage
consumes the requested token allowance. The model can only inspect the selected context and read
bounded saved evidence; it cannot run shell commands, expand access or apply changes itself.

The expected demonstration is:

| Authorization configuration | Legacy capture        | Bound capture                            | Business behavior               |
| --------------------------- | --------------------- | ---------------------------------------- | ------------------------------- |
| Safe                        | Insufficient evidence | Supported in the finite workload         | Preserved                       |
| Unsafe request binding      | Insufficient evidence | Contradicted by the wrong-request effect | Preserved, including the defect |

Keeping the defect in the unsafe configuration is deliberate: better logging must expose it rather
than silently changing authorization. The existing `repair-demo` separately demonstrates a supported
authorization repair. Neither example modifies a customer checkout or production service.

## Describe a client

Start from `examples/client-evidence-gap/` and prepare a separate selected case directory:

1. `case.json` lists the UTF-8 Markdown/text/JSON sources the operator wants to expose. The existing
   local loader snapshots those files with size limits, digests and safe scoped paths.
2. `context.json` declares the workflow scope, source catalog, entities, sourced assertions and
   unresolved questions. It is a structured input manifest, not instructions to the model.
3. Every entity uses `(sourceId, tenant, kind, nativeId)`. Same-named agents in different tenants or
   integrations remain different entities. Display-name similarity never joins identities.
4. Every assertion cites exact saved evidence, carries its source revision and capture/effective
   times, and distinguishes declared, configured, observed and derived knowledge. Conflicting
   assertions remain separate records. Observed relationships need observation times within scope.
5. Each source lists permitted reads, exposed entity kinds, selected evidence, capture window,
   pagination status and unexplored boundaries. These declarations describe the selected input;
   they do not grant remote access. Partial source evidence cannot be upgraded to complete coverage.

See [the runtime schemas](../src/context/schemas.ts) and the example manifest for the complete
contract. PDF/Office extraction, autonomous repository discovery and live SaaS adapters are not
implemented. Source exports or a custom integration can construct the same contracts without
Praesidia. Keep credentials outside manifests, source contents and reports. Reading another agent's
prompt or tool description treats it as data; it cannot alter permissions or fixed assessment rules.

## Query the selected model

```js
import { loadClientContext, queryClientContext } from '@praesidia/investigator';

const { snapshot } = await loadClientContext('./examples/client-evidence-gap');
const result = queryClientContext(snapshot, {
  anchors: [snapshot.context.entities[0].ref],
  maxDepth: 2,
  maxEntities: 12,
});
console.log(result.entities, result.assertions, result.frontier);
```

Queries retain all selected matching relationships rather than a shortest-hop tree. Depth, entity
and relationship filters expose their excluded frontier. Every result remains scoped to selected
sources, with overall completeness not established. Snapshot verification detects supplied content
or manifest changes; imported provenance labels do not authenticate an issuer or establish truth.

## Evidence verification boundary

The code-owned customer-export evidence profile fixes four attempts: permitted work, a wrong-request
approval, self approval and no approval. Supervisor-owned attempt commitments establish the actual
scenario preconditions. Execution witnesses must join the work, grant, principal, request commitment,
policy/deployment revision and independent destination receipt. Negative checks need closed capture.
A response message alone cannot establish either an effect or its absence.

The supported `observe-approval-execution.v1` recipe replaces only the exact shipped
`instrumentation.mjs` preimage. The service source remains identical. Only the shipped service and
supported producers run in the owned example; a child process is not an OS sandbox for untrusted code.

The report compares before/after attempts, issued approval semantics, response outcomes and
independently observed effects. It also removes 20 declared witness fields one at a time and checks
that the safe assessment becomes unresolved. These are schema/workload necessity checks, not proof
of globally minimal telemetry. Synthetic raw customer content is excluded from emitted records,
planning inputs and report exports in the authored tests. Commitments and identifiers may still be
sensitive; this is not a formal privacy guarantee.

`verify-evidence` recomputes the source change, scope commitments, exact producer-read binding,
chronology, assessments and validation results. It verifies consistency of supplied records; it
does not authenticate their author or reexecute the workload. Fresh instrumentation never rewrites
uncertainty about events that occurred before collection existed.

## Praesidia integration

The current workflow has no platform dependency or implemented Praesidia connector. A future adapter
can import selected assets, relationships and proof records through permitted public SDK reads.
Credentials and permissions remain operator-controlled. A platform API key is not universal access
to every topology or organization endpoint. Importing findings/plans back into Praesidia requires a
new bounded contract and authorization; it is not silently performed by this application.
