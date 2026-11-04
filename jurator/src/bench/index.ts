// Owner: FX-3. Public entry of the bench: planted breaks vs rules, AI reads, a plain skill prompt, and a rule red team.
export { DEFAULT_BENCH_DIR, loadBench, applyCase, benchCaseSchema, benchFileSchema } from './cases.js';
export type { BenchCase, BenchData, BenchPolicy, AppliedCase } from './cases.js';
export { runBench, touchedPromises, promisesForSentence, aiReadTaskKey, plainTaskKey } from './run.js';
export type { BenchOptions, BenchReport, BenchMethod, MethodScore, CaseOutcome, PromiseOutcome, LabelledModel } from './run.js';
export { renderBenchText } from './render.js';
export { unifiedDiff } from './diff.js';
export { PLAIN_REVIEW_INSTRUCTIONS, plainReviewInput, plainReviewSchema } from './prompts.js';
