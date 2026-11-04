// Owner: R4-UI. The interface library: live task views and the components every screen is built from.
// Zero dependencies: ANSI codes only, and none at all when colour is off (pipes, CI, NO_COLOR, --json).
export { detectCaps, plainReason, colorDepth, unicodeOk, type Caps, type CapsInput, type ColorDepth, type UiStream } from './caps.js';
export { makeTheme, UNICODE, ASCII, type Theme, type Symbols, type Box } from './theme.js';
export { stripAnsi, sanitize, width, charWidth, truncate, padEnd, padStart, fit, wrap, money, duration, idRange } from './text.js';
export {
  createUi,
  uiForContext,
  type UiContext,
  BADGE_WORDS,
  BOX_MAX,
  MAX_LAYOUT,
  type Ui,
  type UiInput,
  type BadgeKind,
  type Tone,
  type HeaderInput,
  type FindingInput,
  type FindingRow,
  type Column,
  type TableInput,
  type Card,
  type VerboseLine,
} from './components.js';
export {
  createLive,
  nextState,
  renderFrame,
  footerLine,
  LIVE_MAX,
  summaryLines,
  type Live,
  type LiveOptions,
  type LiveSnapshot,
  type FinishOptions,
  type StepState,
  type StepEvent,
  type StepView,
} from './live.js';
export { blockingWait, installInterrupt, registerInterrupt, simulateInterrupt, stoppedLine, QUICK_WAIT_MS, type InterruptClient } from './interrupt.js';
