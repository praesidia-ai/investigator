# Readiness research — 2 November 2026

This review narrows the submission around one observable problem: delegated agent work can outlive
revocation, and an engineer needs evidence of the actual downstream outcome plus a repair that
preserves legitimate work. It does not establish market uniqueness or predict winning.

## Official event findings

The official event deadline is 4 November at 9:00 PM Eastern Time, equivalent to 5 November at
4:00 AM in Bucharest. Startup is the selected track. The weighted project rubric and required evidence
are recorded in [SUBMISSION.md](SUBMISSION.md), using the published waiver rather than inferring
weights from the track's short marketing description. Check the authenticated portal for its actual
video/source fields and recheck the deadline before submitting.
[Meta event page](https://dev.meta.ai/events/global-hackathon),
[official overview and waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver).

## Model and protocol findings

Meta's current model page lists `muse-wonder-1.0` on Model API; Wonder Full is not available there.
The framework guide uses Wonder for the main agent loop. This supports the configured default as a
documented candidate, subject to participant/account access and actual evaluation.
[Model availability](https://dev.meta.ai/docs/models),
[agent framework guide](https://dev.meta.ai/docs/agent-frameworks).

Responses supports multi-step reasoning continuity and developer-executed function tools. Strict
schema compatibility is an integration requirement, separate from whether a finding is supported by
evidence. The provider now checks its structural schema subset locally; real service compatibility
still requires the credentialed smoke and actual investigation. Reasoning consumes the generated
output budget, so total workflow usage must include both baseline and after-change investigations.
[Responses](https://dev.meta.ai/docs/protocols/responses),
[tool calling](https://dev.meta.ai/docs/tool-calling),
[structured output](https://dev.meta.ai/docs/structured-output),
[reasoning controls](https://dev.meta.ai/docs/reasoning).

## Product and delivery decisions

- Lead with the work-revocation investigation, not a generic compliance dashboard or a list of agents.
- Show an acknowledged revocation, a correlated actual receipt and independent legitimate work.
- Preserve pre-revocation acceptances; cancellation is not rollback.
- Distinguish model-selected experiments from the host's fixed validation suite.
- Require exact source eligibility and a proposal before the supported worker change; retest the same
  attempted workload and show incomplete capture as uncertainty.
- Keep the engine independent of Praesidia and document the adapter boundary without claiming
  arbitrary enterprise integration is implemented.
- Prepare a reproducible public source release while keeping generated reports and local planning
  archives ignored. The selected public repository is
  [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator); reviewed source publication,
  monitored contacts, hosted CI and independent setup evidence remain external gates.

The detailed shipped scope is in [CANCELLATION.md](CANCELLATION.md). Prior-art and market hypotheses
remain in [MARKET_STRATEGY_2026-11-01.md](MARKET_STRATEGY_2026-11-01.md); cancellation, distributed
authorization and evidence-based testing are established areas. Differentiation must be demonstrated
through a useful workflow and customer trials, not a claim that these primitives are new.

No successful real Meta call has been observed in this checkout yet. Scripted success checks
engineering contracts; live model behavior, customer usefulness, production safety and superiority
remain unproven. The next decisive step is credentialed execution and review of retained artifacts,
followed by a separate person's setup trial and the final source/packed release checks.
