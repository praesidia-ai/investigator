# Market research and the next product advantage

Research date: 1 November 2026. This is a product decision and validation plan, not a market-leadership
or uniqueness claim. Sources describe published capabilities; competing products were not executed.

## Decision

Implement client-specific **change investigations**: identify which recorded control findings stop
describing the selected system when its agents, tools, permissions, policy, application or evidence
producer changes. Preserve the historical finding, explain the dependency, and distinguish a
supported retest from an obligation that first needs review.

Add a saved MCP tools/list importer. Requiring clients to hand-author every tool in a context manifest
is an adoption bottleneck. Standards-based input should improve the investigation while retaining
source identity and discovery limits. A tool listing must not become proof of safe behavior.

The product question is:

> Does this previous control finding still describe the system I am about to run? What changed,
> what evidence work is necessary, and what did a fresh test actually establish?

## Closest capabilities and prior work

| Source                                                                                                       | Published overlap                                                                                                                                                                       | Product consequence                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)                          | Version comparison, CI regression tests, backtesting and online evaluation.                                                                                                             | Testing after an agent changes is established functionality.                                                                                           |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix)                                                         | Open-source tracing, experiments, versioned datasets and prompts.                                                                                                                       | Open source and provider independence alone are insufficient differentiation.                                                                          |
| [Vanta Agentic Trust Controls](https://www.vanta.com/products/agentic-trust-controls)                        | Controls for identity, tools, memory and delegation, automated monitoring and remediation guidance.                                                                                     | Generic continuous agent compliance is already a product category.                                                                                     |
| [Noma Agent Control Plane](https://noma.security/solutions/agent-control-plane)                              | Agent discovery, owners, connections, permissions and runtime context compared with intent/baselines.                                                                                   | Another enterprise graph or runtime-policy dashboard is a weak next investment.                                                                        |
| [Reusing Assurance Evidence in AI Pipelines](https://arxiv.org/abs/2610.27672), submitted 20 October 2026    | Dependency-relative evidence reuse, release-gate checks and selective re-execution. Its evaluation concerns public DVC pipelines, not Investigator or representative enterprise agents. | Dependency invalidation is prior research. Its undeclared-dependency problem motivates challenging the map itself; signatures cannot repair omissions. |
| [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Interoperable definitions, listing/pagination and untrusted annotations.                                                                                                                | Import faithfully. A listing or read-only hint establishes neither permissions nor effects.                                                            |

This review did not establish an unoccupied market. It supports a narrower engineering hypothesis:
a portable connection from a client's control question, through missing or outdated evidence, to an
inspectable supported change and an independently observed business result can be useful. Neither
commercial demand nor superiority over the closest tools has yet been demonstrated.

## Why this matters as work moves to agents

A control owner needs to understand operations, authority and evidence across multiple systems.
The executable system can change when a tool definition or permission changes even if the agent's
repository is unchanged. A previous passing observation can remain historically correct while
being unsuitable for the next deployment.

A changed fingerprint is a reason to investigate, not proof of a violation. A policy or instruction
change can alter the obligation; repeating old tests cannot approve the new meaning. Missing sources
and new unmapped tools must remain visible rather than inheriting a green status.

## Implemented increment

- Import saved MCP definitions into the cited client context without connecting to a server. Preserve
  source/tenant/server/tool identities and full raw-definition fingerprints.
- Bind a checkpoint to the existing evidence-plan report and a fixed dependency/check map for the
  authored export workload. Compute fingerprints from selected bytes and configuration.
- Compare policy, agent configuration, tools, application, runtime setting and observer. Separate
  historical verdict, dependency applicability and actual fresh result.
- Require profile review for semantic changes; block reuse for missing, unmapped or incompletely
  captured dependencies. Explicit document exclusions remain declarations.
- Retest the supported fixture setting change using the unchanged batch and independent effect
  observer. Preserve the old finding and record the new counterexample separately.
- Export verifiable JSON and inert HTML. Comparison always leaves current behavioral verdict unset.

The authored dependency map is finite and code-owned. It does not establish real client dependency
closure, automatically discover every route, validate arbitrary schemas, authenticate an MCP server
or execute untrusted customer code. The adapter runs a full fixed batch; a narrower logical plan
does not yet mean lower execution cost. See [ASSURANCE-CHANGES.md](ASSURANCE-CHANGES.md).

## How to compete on demonstrated value

Start with a platform engineer and control owner releasing one agent with a sensitive business tool.
Use independently supplied changes and the same authorized inputs in three comparison arms:

1. A manifest diff followed by all existing checks.
2. A plain investigation/coding agent with the same total model/probe budget.
3. Investigator's dependency explanation and bounded evidence/revalidation workflow.

Have people review expected policy interpretations. Measure missed invalidations, unnecessary
invalidations, correct dependency explanations, unsupported conclusions, retained useful checks or
patches, operator time and known model usage. Report logical selection separately from actual
execution cost. The model must not be the sole judge of its own work.

The next customer-led work is a real read-only source adapter, an owner-reviewed dependency map, a
second business control and changes not written by the implementation team. Compare a commercial
evaluator when access is available. Preserve equivalent evidence and budgets.

Narrow or reject the advantage if omissions stay invisible, old tests approve changed obligations,
every integration requires bespoke consulting, or the plan does not improve useful work over the
baseline. Market leadership requires that evidence and adoption, not additional features alone.
