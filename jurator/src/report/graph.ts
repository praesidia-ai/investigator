// Owner: X-FRONTEND. The promise graph: policies -> promises -> code -> rules, laid out by code as inline SVG (no library).
// Every node is a file or a record in .jurator/: the graph *is* the files.
import type { Contradiction } from '../contracts.js';
import { anchor, esc } from './escape.js';
import type { PromiseView, RuleView, Tone } from './model.js';

export type NodeKind = 'source' | 'promise' | 'file' | 'rule';

export interface GraphNode {
  readonly key: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly sub: string;
  readonly title: string;
  readonly tone: Tone;
  readonly href?: string;
  /** Glob nodes stand for "files under this pattern" (a rule found no line to cite). */
  readonly glob?: boolean;
}
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly tone: Tone;
}
export interface Graph {
  readonly columns: readonly (readonly GraphNode[])[];
  readonly edges: readonly GraphEdge[];
  readonly conflicts: ReadonlyArray<{ readonly a: string; readonly b: string; readonly title: string }>;
}

export function buildGraph(
  promises: readonly PromiseView[],
  rules: readonly RuleView[],
  contradictions: readonly Contradiction[],
  sources: Readonly<Record<string, string>>,
): Graph {
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, tone: Tone): void => {
    const k = `${from}>${to}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, tone });
  };

  // Policies, in config order, then any alias only promises mention.
  const aliases = [...Object.keys(sources)];
  for (const v of promises) if (!aliases.includes(v.promise.quote.alias)) aliases.push(v.promise.quote.alias);
  const used = new Set(promises.map((v) => v.promise.quote.alias));
  const sourceNodes: GraphNode[] = aliases
    .filter((a) => used.has(a))
    .map((a) => ({
      key: `s:${a}`,
      kind: 'source',
      label: sources[a] ?? a,
      sub: a,
      title: `Policy ${a}: ${sources[a] ?? a}`,
      tone: 'none',
    }));

  const order = new Map(aliases.map((a, i) => [a, i]));
  const sortedPromises = [...promises].sort(
    (x, y) => (order.get(x.promise.quote.alias) ?? 0) - (order.get(y.promise.quote.alias) ?? 0),
  );
  const promiseNodes: GraphNode[] = sortedPromises.map((v) => ({
    key: `p:${v.promise.id}`,
    kind: 'promise',
    label: v.promise.id,
    sub: v.promise.wording,
    title: `${v.promise.id}: ${v.promise.wording} (${v.verdict.word}, ${v.verdict.by})`,
    tone: v.verdict.tone,
    href: `#promise-${anchor(v.promise.id)}`,
  }));
  const promiseTone = new Map(sortedPromises.map((v) => [v.promise.id, v.verdict.tone]));
  for (const v of sortedPromises) {
    const t = v.verdict.tone;
    addEdge(`s:${v.promise.quote.alias}`, `p:${v.promise.id}`, t === 'broken' || t === 'looks-broken' ? t : 'none');
  }

  const files = new Map<string, GraphNode>();
  const addFile = (path: string, glob: boolean): string => {
    const key = glob ? `g:${path}` : `f:${path}`;
    if (!files.has(key)) {
      files.set(key, {
        key,
        kind: 'file',
        label: path,
        sub: glob ? 'files under this pattern' : '',
        title: glob ? `Files matching ${path}` : path,
        tone: 'none',
        glob,
      });
    }
    return key;
  };
  for (const v of sortedPromises) {
    for (const c of v.citations) addEdge(`p:${v.promise.id}`, addFile(c.path, false), v.verdict.tone);
  }

  const ruleNodes: GraphNode[] = rules.map((r) => {
    const tone: Tone =
      r.outcome === 'fail' ? 'broken' : r.outcome === 'pass' ? 'kept' : r.outcome === 'error' ? 'unsure' : 'none';
    return {
      key: `r:${r.rule.id}`,
      kind: 'rule',
      label: r.rule.id,
      sub: r.outcome === 'not run' ? `${r.rule.mode}, not run` : `${r.rule.mode}, ${r.outcome}`,
      title: `${r.rule.id}: ${r.rule.description}`,
      tone,
      href: `#rule-${anchor(r.rule.id)}`,
    };
  });
  for (const r of rules) {
    const tone: Tone = r.outcome === 'fail' ? 'broken' : 'none';
    const pTone = promiseTone.get(r.rule.promiseId);
    const hitPaths = [...new Set((r.result?.hits ?? []).map((h) => h.path))];
    const fileKeys = hitPaths.length > 0 ? hitPaths.map((p) => addFile(p, false)) : r.rule.globs.slice(0, 2).map((g) => addFile(g, true));
    for (const fk of fileKeys) {
      if (pTone !== undefined) addEdge(`p:${r.rule.promiseId}`, fk, pTone);
      addEdge(fk, `r:${r.rule.id}`, tone);
    }
  }

  // Order files and rules by the average row of what points at them, so edges cross less.
  const rowOf = new Map<string, number>();
  promiseNodes.forEach((n, i) => rowOf.set(n.key, i));
  const centre = (key: string, incoming: (e: GraphEdge) => boolean): number => {
    const rows = edges.filter((e) => e.to === key && incoming(e)).map((e) => rowOf.get(e.from) ?? 0);
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER;
  };
  const fileNodes = [...files.values()]
    .map((n) => ({ n, c: centre(n.key, (e) => e.from.startsWith('p:')) }))
    .sort((a, b) => a.c - b.c || a.n.label.localeCompare(b.n.label))
    .map((x) => x.n);
  fileNodes.forEach((n, i) => rowOf.set(n.key, i * (promiseNodes.length / Math.max(1, fileNodes.length))));
  const sortedRules = ruleNodes
    .map((n) => ({ n, c: centre(n.key, () => true) }))
    .sort((a, b) => a.c - b.c || a.n.label.localeCompare(b.n.label))
    .map((x) => x.n);

  const shown = new Set(promiseNodes.map((n) => n.key));
  const conflicts = contradictions
    .filter((c) => c.status !== 'not-a-conflict')
    .flatMap((c) => {
      const [a, b] = c.promiseIds;
      if (!a || !b || !shown.has(`p:${a}`) || !shown.has(`p:${b}`)) return [];
      return [{ a: `p:${a}`, b: `p:${b}`, title: `${c.id}: ${c.example}` }];
    });

  return { columns: [sourceNodes, promiseNodes, fileNodes, sortedRules], edges, conflicts };
}

/* ------------------------------ layout + SVG ------------------------------ */

const COLS = [
  { x: 40, w: 232, chars: 29, head: 'Policies' },
  { x: 334, w: 420, chars: 56, head: 'Promises' },
  { x: 830, w: 236, chars: 29, head: 'Code' },
  { x: 1136, w: 214, chars: 25, head: 'Rules' },
] as const;
const WIDTH = 1370;
const ROW = 50;
const NODE_H = 38;
const TOP = 52;

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** Paths keep their end: 'src/routes/export.ts' matters more than the folder it starts in. */
function clipPath(s: string, max: number): string {
  return s.length > max ? `…${s.slice(s.length - max + 1)}` : s;
}

interface Placed {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly col: number;
}

export function renderGraphSvg(graph: Graph): string {
  const rows = Math.max(1, ...graph.columns.map((c) => c.length));
  const height = TOP + rows * ROW + 16;
  const placed = new Map<string, Placed>();
  graph.columns.forEach((nodes, ci) => {
    const col = COLS[ci] ?? COLS[0];
    const offset = ((rows - nodes.length) * ROW) / 2;
    nodes.forEach((node, i) => {
      placed.set(node.key, { node, x: col.x, y: TOP + offset + i * ROW, w: col.w, col: ci });
    });
  });

  const heads = COLS.map(
    (c, i) =>
      `<text class="g-head" x="${c.x}" y="24">${esc(c.head)}<tspan class="g-count" dx="8">${graph.columns[i]?.length ?? 0}</tspan></text>`,
  ).join('');

  const edgeSvg = (e: GraphEdge): string => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + a.w;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const dx = (x2 - x1) / 2;
    return `<path class="g-edge e-${e.tone}" d="M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}"/>`;
  };
  const loud = (t: Tone): boolean => t === 'broken' || t === 'looks-broken';
  const edges = [...graph.edges.filter((e) => !loud(e.tone)), ...graph.edges.filter((e) => loud(e.tone))]
    .map(edgeSvg)
    .join('');

  const arcs = graph.conflicts
    .map((c) => {
      const a = placed.get(c.a);
      const b = placed.get(c.b);
      if (!a || !b) return '';
      const x = a.x;
      const y1 = a.y + NODE_H / 2;
      const y2 = b.y + NODE_H / 2;
      const bend = 28 + Math.min(40, Math.abs(y2 - y1) / 6);
      return `<path class="g-conflict" d="M${x} ${y1} C${x - bend} ${y1} ${x - bend} ${y2} ${x} ${y2}"><title>${esc(c.title)}</title></path>`;
    })
    .join('');

  const nodeSvg = (p: Placed): string => {
    const n = p.node;
    const col = COLS[p.col] ?? COLS[0];
    const cls = `g-node k-${n.kind} t-${n.tone}${n.glob ? ' is-glob' : ''}`;
    let text: string;
    if (n.kind === 'promise') {
      const idW = n.label.length * 7.4 + 10;
      text =
        `<text class="g-id" x="${p.x + 12}" y="${p.y + 24}">${esc(n.label)}</text>` +
        `<text class="g-label" x="${p.x + 12 + idW}" y="${p.y + 24}">${esc(clip(n.sub, Math.floor(col.chars - n.label.length * 0.9)))}</text>`;
    } else if (n.kind === 'file') {
      text = `<text class="g-path" x="${p.x + 12}" y="${p.y + 24}">${esc(clipPath(n.label, col.chars))}</text>`;
    } else if (n.kind === 'rule') {
      text =
        `<text class="g-id" x="${p.x + 12}" y="${p.y + 17}">${esc(clip(n.label, col.chars))}</text>` +
        `<text class="g-sub" x="${p.x + 12}" y="${p.y + 31}">${esc(n.sub)}</text>`;
    } else {
      text =
        `<text class="g-path" x="${p.x + 12}" y="${p.y + 17}">${esc(clipPath(n.label, col.chars))}</text>` +
        `<text class="g-sub" x="${p.x + 12}" y="${p.y + 31}">${esc(n.sub)}</text>`;
    }
    const body = `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${NODE_H}" rx="7"/>${text}<title>${esc(n.title)}</title>`;
    return n.href
      ? `<a class="${cls}" href="${esc(n.href)}">${body}</a>`
      : `<g class="${cls}">${body}</g>`;
  };
  const nodes = [...placed.values()].map(nodeSvg).join('');

  const label = `Promise graph: ${graph.columns[0]?.length ?? 0} policies, ${graph.columns[1]?.length ?? 0} promises, ${graph.columns[2]?.length ?? 0} code locations, ${graph.columns[3]?.length ?? 0} rules.`;
  return `<svg class="graph" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${heads}<g class="g-edges">${edges}</g><g class="g-arcs">${arcs}</g>${nodes}</svg>`;
}
