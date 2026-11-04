// Owner: WP-B. Bindings: where in the code each promise lives (constants, config keys, guard calls, allowlists).
// A change that touches a bound line triggers a check of that promise. Rules give bindings with no AI; the model
// points at the rest, and the program checks every location and copies its lines from git (principle 3).
export { readBindings, writeBindings, bindingsPath, byBindingId, BINDINGS_FILE } from './store.js';
export {
  bindingsFromRule,
  bindingsFromRules,
  recordRuleBindings,
  mergeBindings,
  numberBindings,
  bindingId,
  makeBinding,
  MAX_BINDINGS_PER_RULE,
} from './from-rule.js';
export { proposeBindings, verifyLocations, buildBindPrompt, MAX_BINDING_LINES } from './propose.js';
export type { DroppedLocation } from './propose.js';
export { bindAnswerSchema, bindTaskKey, BIND_INSTRUCTIONS, MAX_LOCATIONS } from './prompts.js';
export type { BindAnswer } from './prompts.js';
export { changedLines, parseUnifiedDiff, touchedBindings, touchReason, overlaps, unquotePath } from './diff.js';
export type { LineChange } from './diff.js';
export { reanchor, anchorIn, anchorAll, movedTo } from './anchor.js';
export type { Anchored, AnchorStatus } from './anchor.js';
export { describeExpected, excerpt, patternNames, symbolFor, kindFor } from './symbols.js';
