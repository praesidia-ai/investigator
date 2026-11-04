// Owner: X-FRONTEND. HTML report and promise-graph view (self-contained HTML, no network but Google Fonts).
export { renderReport } from './html.js';
export { buildGraph, renderGraphSvg, type Graph, type GraphEdge, type GraphNode } from './graph.js';
export { displayPath, loadReportInput, readRunFile, type LoadOptions } from './load.js';
export { headline, promiseViews, ruleViews, verdictView, type ReportInput, type PromiseView, type RuleView } from './model.js';
export { esc } from './escape.js';
