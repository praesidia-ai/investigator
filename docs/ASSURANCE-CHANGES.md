# Change investigations and MCP imports

Investigator retains a historical control finding, compares its selected dependencies with a new
snapshot, and can record a separate fresh retest. A comparison never renews the historical behavioral
verdict or authorizes a production release.

## Run the demonstration

After `npm ci` and `npm run check`, choose a new output directory:

```sh
mkdir -p artifacts
node dist/bin.js assurance-demo --out artifacts/assurance-case
node dist/bin.js verify-assurance artifacts/assurance-case/demo.json
# Explicit live Meta evidence planning after configuring the key locally:
node --env-file=.env dist/bin.js assurance-demo --live --out artifacts/assurance-live
```

The default planner is scripted, with real synthetic HTTP effects and a separate observer. The
comparison is deterministic; Meta supplies the existing context/evidence collection plan. Provider
failure never falls back. A real Meta call remains pending credentialed verification.

The output includes `checkpoint.json`, `candidate-state.json`, `demo.json` and five JSON/HTML cases:

| Report                    | Outcome                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-setting.html`    | A setting changes; two mapped records become stale. Fresh execution exposes a wrong-request effect while preserving the original supported finding. |
| `tool-definition.html`    | A changed tool contract requires profile review; old tests cannot approve it.                                                                       |
| `unmapped-tool.html`      | A new tool is absent from the frozen map; applicability is unknown and reuse is blocked.                                                            |
| `policy-change.html`      | A changed obligation requires review before an old test suite can be considered suitable.                                                           |
| `unrelated-document.html` | An explicitly excluded document changes; mapped dependencies remain unchanged within declared scope, with no new behavioral verdict.                |

The plan identifies affected checks. The current adapter runs the full fixed four-attempt batch;
planned and executed lists remain separate. No globally minimal suite or execution savings are claimed.

## Import a saved MCP listing

Prepare `mcp-source.json` and `tools.json` in a selected directory. The source-selection file contains
operator-assigned `sourceId`, `tenant`, `serverId`, `revision`, `workflowRef` and a `window` with UTC
`from`/`to` timestamps. See [the example](../examples/mcp-export/mcp-source.json).

```sh
mkdir -p artifacts
node dist/bin.js import-mcp examples/mcp-export --out artifacts/mcp-import.json
```

The supported input is a bare tools/list result or JSON-RPC 2.0 result in the **MCP 2025-11-25** shape.
Latest-draft envelope additions are not silently assumed compatible. Records, nesting, bytes and
exact citations are bounded. The result retains original evidence, a context snapshot, stable
dependency IDs and full-definition fingerprints, including descriptions, annotations and metadata.

The importer creates source-qualified server/tool entities and configured `EXPOSES` relationships
with exact JSON-pointer citations. It never invokes tools, fetches icons, resolves schema references,
authenticates servers or grants runtime permissions. Embedded instructions remain untrusted data.
A `nextCursor` exposes missing pages. Even without a cursor, source coverage remains partial because
upstream discovery and runtime activity are not established. Similar display names do not merge IDs.

## Compare with an existing evidence result

The current CLI checkpoint builder supports the authored export evidence profile:

```sh
mkdir -p artifacts
node dist/bin.js checkpoint artifacts/client-evidence-case/evidence-plan.json --out artifacts/checkpoint.json
```

For the matching checkpoint and candidate produced by `assurance-demo`, compare and verify them:

```sh
node dist/bin.js assurance-diff artifacts/assurance-case/checkpoint.json artifacts/assurance-case/candidate-state.json --out artifacts/change-case
node dist/bin.js verify-assurance artifacts/change-case/change.json
```

Capture a candidate for the same checkpoint/workload. A demo candidate is not evidence of another
client's state. Its selected policy/configuration/source bytes, setting, tool definitions and coverage
declarations determine the fingerprints; editing a digest is not a replacement for collecting inputs.

`assurance-diff` is read-only. It never runs candidate code. Exit codes are `0` for unchanged mapped
dependencies, `1` for mapped changes needing evidence work, and `2` for blocked/unknown/invalid
comparison. These are comparison statuses, not control-pass or release-approval codes. Historical
contradicted/insufficient findings do not become supported when dependencies are unchanged.

Each check keeps historical verdict, dependency validity, required action and fresh observations
separate. Policy/instruction/tool/permission changes require explicit profile review. Missing sources,
changed identity kinds, unmapped tools and unresolved frontiers block reuse. Capture timestamps
alone do not change content; revisions remain material. Only documents may be explicitly excluded;
their exclusion is not proof of actual irrelevance.

## Integrate another client or framework

`compareAssurance` accepts validated `AssuranceInventory` snapshots and a fixed `AssuranceContract`
mapping historical checks to dependencies and supported retest IDs. An adapter can construct those
inputs from authorized exports or API reads, including `importMcpTools` output. Retain actual missing
sources and frontiers. The core cannot infer every real dependency or authenticate supplied hashes.

The CLI's `inventoryFromFixtureState` and checkpoint map concern the finite authored workload. Its
complete coverage describes those known inputs, not upstream MCP systems. Real integrations need
their own reviewed map and criterion verifier and must preserve actual discovery limits.

The local retest runs only the shipped application and supported producer, binding the candidate's
source, runtime setting, fixed attempts, approval semantics and new capture window. It does not run
arbitrary customer code or recover uncaptured history. No Praesidia account, private backend or API
key is required; these commands perform no Praesidia writes. Verification recomputes supplied
consistency, not issuer authenticity or live execution. See [the market research](MARKET_STRATEGY_2026-11-01.md).
