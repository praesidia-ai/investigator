# Meta model configuration

Checked against Meta's official documentation on 2026-11-02. These are documented capabilities;
account access and actual Investigator behavior remain unverified until explicit live checks succeed.
No successful real Meta call has yet been observed in this checkout.

| Purpose                                                       | Selection                                             |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Primary flagship investigation; existing investigator/skeptic | `muse-wonder-1.0`                                     |
| Explicit comparison candidate                                 | `muse-spark-1.3`                                      |
| Transport                                                     | `POST https://api.meta.ai/v1/responses`               |
| Default reasoning effort                                      | `medium`                                              |
| Final structure                                               | Responses `text.format`, JSON Schema, `strict: true`  |
| Function tool parameters                                      | Responses function tools with explicit `strict: true` |

Meta describes Wonder as its most capable model for extended agentic work. Its agent-framework
guide uses Wonder for the main loop and Spark 1.3 for lower-cost work. Wonder Full is a Muse Code
subscription variant, not a Model API model; `reasoning.effort=max` does not select it. Both API
candidates support tool use and structured output. These are documented capabilities, not measured
Investigator results. [Models](https://dev.meta.ai/docs/models),
[framework selection](https://dev.meta.ai/docs/agent-frameworks),
[Responses](https://dev.meta.ai/docs/protocols/responses).

The default IDs select Standard mode. Meta documents different data-use behavior for Contributor
variants. Select the exact model explicitly; Investigator never changes models after a failure.
[Meta pricing modes](https://dev.meta.ai/docs/pricing-rate-limits).

## Local configuration

Copy `.env.example` to the ignored `.env` file and enter the credential locally. The project accepts
`META_API_KEY` and the official documentation's `MODEL_API_KEY`. If both are set, their values must
match. Do not place keys in case evidence, target configuration, command arguments or submitted assets.

```sh
node --env-file=.env dist/bin.js doctor
node --env-file=.env dist/bin.js doctor --live
```

Offline `doctor` displays whether a key is configured without returning it. `doctor --live` queries
the authenticated model catalog and reports whether the selected ID is available. It does not
generate an answer or claim that tool calling has passed. Catalog failure never selects a substitute.

`MODEL_ID`, `MODEL_BASE_URL` and `MODEL_REASONING_EFFORT` are explicit configuration. HTTPS is required
for model endpoints; redirects, credentials embedded in URLs, query strings and fragments are refused.
Unknown model IDs may be configured, but their compatibility needs actual smoke verification.

## Protocol readiness

The native HTTP provider uses stateless Responses requests with `store: false`, encrypted reasoning
continuation and correlated function-call outputs. It does not export opaque continuation as evidence
or treat a successful transport response as a validated conclusion. Both tools and final schemas are
checked locally before a request; the strict-schema helper rejects unsupported structures and bounds
depth, properties and enum values. This checks a conservative structural subset, not every behavior
of the remote API's schema engine. Exact citation, capture and verdict checks remain separate.
[Responses protocol](https://dev.meta.ai/docs/protocols/responses),
[tool calling](https://dev.meta.ai/docs/tool-calling),
[structured output](https://dev.meta.ai/docs/structured-output).

## Actual verification after credentials are available

```sh
npm run build
mkdir -p artifacts

# Explicit flagship checks before the broader acceptance runner:
node --env-file=.env dist/bin.js smoke --out artifacts/meta-first-smoke.json
node --env-file=.env dist/bin.js cancellation-demo --live --out artifacts/meta-first-cancellation
node --env-file=.env dist/bin.js cancellation-trials --live --cases 3 --out artifacts/meta-first-trials
node dist/bin.js verify-cancellation artifacts/meta-first-cancellation/case.json
node dist/bin.js verify-cancellation artifacts/meta-first-trials/trials.json

# Broader acceptance runner; use fresh paths and inspect its actual stages/results:
node --env-file=.env scripts/verify-meta.mjs --out artifacts/meta-wonder-first --cases 5

# A larger authored evaluation, after inspecting the first run's usage and outcomes:
node --env-file=.env scripts/verify-meta.mjs --out artifacts/meta-wonder-full --cases 12 --repetitions 3

# A separate, deliberate comparison; never an automatic fallback:
MODEL_ID=muse-spark-1.3 node --env-file=.env scripts/verify-meta.mjs --out artifacts/meta-spark-comparison --cases 5
```

The complete runner requires `python3` for the independent HTTP application's two live configurations.
It checks account access, tool continuation, the flagship cancellation pair and authored trials,
the existing evidence/change/repair workflows, that second application and the chosen authored
evaluation cases. It stops on failure, retains available cases and a checksummed manifest, and does
not print credentials or raw provider responses. The output directory must be new. Live commands
make billed provider calls; ordinary tests and packed smoke do not call Meta.

Each ordinary approval-control investigation permits 8 model turns, 12 tool calls, 32,768 generated tokens total and
4,096 per call. The smaller smoke permits 16,384 generated tokens total and 2,048 per call. These
limits include reasoning output and are not monetary-cost guarantees; input also incurs usage.
Unknown usage stays unknown. [Reasoning controls](https://dev.meta.ai/docs/reasoning).

Each cancellation investigation permits 28 model turns, 40 tool calls (several per turn), 65,536 generated tokens
total, 4,096 per call and a 180-second deadline for exact witness reads and four finite experiments.
The workflow may run a separate after-change investigation, and trials run
multiple baseline investigations; do not treat a per-investigation token limit as the total cost cap.

Compare correct findings, false accusations, abstention, resolvable citations, utility preservation,
latency, known tokens and actual exposure to adversarial evidence. A passing unread injection is not
injection-resistance evidence. A small authored suite cannot guarantee model correctness on future
client data. Keep the deterministic verdict prerequisites, citation checks and fixed test expectations
active for every model choice.
