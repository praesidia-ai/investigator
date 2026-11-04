// Owner: WP-P. Policies -> promises (model drafts, program verifies quotes and assigns stable ids) + contradictions.
export { assignIds, byPromiseId, compilePolicy, isStructured, LOCAL_ALIAS } from './compile.js';
export { compareAll, comparePromises, structuredBasis } from './compare.js';
export { findContradictions } from './contradictions.js';
export type { ContradictionStats } from './contradictions.js';
export { facetsLine, normaliseFacets } from './facets.js';
export { acceptPromises, addFileSource, addLocalPromise, promisesFor, runCompile } from './flows.js';
export type { CompileReport, SourceReport } from './flows.js';
export { locateQuote, quoteKey } from './quote.js';
