// Owner: HZ-1. Plain summaries of findings (AI-written from the program's evidence, or a template), short ids for
// screens, and plain words for rules and reasons.
export { aliasMap, shortIds, shortIdsFor, SHORT_ALIAS_MAX, type ShortIds } from './alias.js';
export { genericActual, modeWords, plainFix, plainReason, ruleLine, type PlainReason } from './plain.js';
export {
  EXPLAIN_VERSION,
  SUMMARY_CAP_USD,
  SUMMARY_CONCURRENCY,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_MODEL,
  explainTask,
  fileSummaryCache,
  memorySummaryCache,
  summarize,
  summarizeAll,
  summaryInput,
  summaryKey,
  summaryLabel,
  summarySchema,
  templateSummary,
  type Finding,
  type FindingEvidence,
  type FindingKind,
  type Summary,
  type SummaryAnswer,
  type SummaryCache,
  type SummarizeOptions,
} from './summary.js';
export { citationEvidence, fromBrokenNow, fromCheckResult, fromNoRule, fromRuleRun } from './finding.js';
export { summariesOff, summaryModel, type SummaryModel, type SummaryModelInput } from './model.js';
export { findingRows, quoted, repoFacts, type FindingView } from './view.js';
