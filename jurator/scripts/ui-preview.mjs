#!/usr/bin/env node
// Owner: R4-UI. Animates every interface component with made-up data, so the look can be judged before it is wired
// into the commands. Needs a build first (npm run build). Nothing here reads a repo, a key or the network.
//
//   node scripts/ui-preview.mjs              live on a terminal, plain lines when piped
//   node scripts/ui-preview.mjs --fast       four times faster
//   node scripts/ui-preview.mjs --verbose    also shows the proof blocks
//   JURATOR_PLAIN=1 / NO_COLOR=1 / JURATOR_NO_ANIMATION=1 / JURATOR_ASCII=1 / FORCE_COLOR=3   other looks
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'dist', 'ui', 'index.js');
if (!existsSync(lib)) {
  process.stderr.write('The preview reads the built library: run npm run build first.\n');
  process.exit(2);
}
const { createUi, createLive } = await import(pathToFileURL(lib).href);
const { BRAND } = await import(pathToFileURL(join(root, 'dist', 'brand.js')).href);

const argv = process.argv.slice(2);
const speed = argv.includes('--fast') ? 4 : Number(argv[argv.indexOf('--speed') + 1]) || 1;
const stream = process.stdout;
const ui = createUi({ stream, env: process.env, argv });
const print = (lines) => {
  for (const l of [lines].flat()) stream.write(`${l}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms / speed)));
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/* ------------------------------------------------------------------ header */
print(
  ui.header({
    command: 'rule propose --all --accept',
    workspace: 'investigator workspace · 2 repos',
    model: 'muse-wonder (live)',
    budgetUsd: 10,
  }),
);

/* ------------------------------------------------------------ compile view */
print(ui.section('Compile', 'policies/document-handling.md'));
{
  const live = createLive({ title: 'compile', unit: 'stages', budgetUsd: 10, stream, env: process.env, argv });
  const stages = [
    ['fetch', 'Fetch sources', ['policies/document-handling.md', 'policies/retention.md']],
    ['draft', 'Draft promises', ['drafting promises for documents', 'drafting promises for retention']],
    ['quotes', 'Verify quotes word for word', ['14 of 19 quotes found', '19 of 19 quotes found']],
    ['ids', 'Assign ids', ['documents.01 .. documents.12, retention.01 .. retention.07']],
    ['compare', 'Compare typed fields (no AI)', ['171 pairs compared', '2 conflicts found']],
    ['model', 'Ask the model on undecided pairs', ['3 pairs left', '1 pair left']],
  ];
  for (const [id, label] of stages) live.add(id, label);
  for (const [id, , details] of stages) {
    live.start(id, details[0]);
    for (const d of details) {
      await sleep(500 + rand() * 500);
      live.detail(id, d);
      if (id === 'draft' || id === 'model') live.addCost(0.06 + rand() * 0.05);
    }
    await sleep(300);
    live.done(id, id === 'compare' ? '2 conflicts' : id === 'quotes' ? 'all found' : undefined);
  }
  live.finish({ summary: '19 promises in 2 sources, 2 conflicts' });
}

/* ------------------------------------------------------- rule propose view */
print(ui.section('Rules', '19 promises'));
const ids = [
  ...Array.from({ length: 12 }, (_, i) => `documents.${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, i) => `retention.${String(i + 1).padStart(2, '0')}`),
];
const outcome = (id) =>
  id === 'retention.03' || id === 'documents.05'
    ? 'broken-now'
    : id === 'documents.09' || id === 'retention.06'
      ? 'no-rule'
      : id === 'documents.12'
        ? 'skipped'
        : 'written';
{
  const live = createLive({
    title: 'rule propose',
    unit: 'rules',
    budgetUsd: 10,
    words: { done: 'written', failed: 'no rule possible' },
    stream,
    env: process.env,
    argv,
  });
  for (const id of ids) live.add(id);
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const o = outcome(id);
      if (o === 'skipped') {
        live.skip(id, 'a rule already covers it');
        continue;
      }
      live.start(id, 'writing the rule');
      await sleep(700 + rand() * 900);
      live.addCost(0.04 + rand() * 0.05);
      live.detail(id, o === 'broken-now' ? 'proving: the rule fails on today\'s code' : 'proving: 6 mutants, 1 clean commit');
      await sleep(500 + rand() * 700);
      if (o === 'no-rule') {
        live.fail(id, 'no rule possible: the promise is about staff, not code');
        continue;
      }
      live.detail(id, o === 'broken-now' ? 'checking a fixed copy passes' : 'red team: 3 edits tried');
      await sleep(500 + rand() * 600);
      live.addCost(0.03 + rand() * 0.04);
      if (id === 'documents.04') live.log(ui.line('  note: documents.04 shares a rule with documents.02', 'muted'));
      live.done(id, o === 'broken-now' ? 'BROKEN NOW' : 'rule written');
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  live.finish({ ok: true, summary: '2 promises are broken today: the rules stay, and check shows them as BROKEN' });
}

/* ----------------------------------------------------------- final screen */
print(ui.section('Findings', '2 broken now'));
print('');
print(
  ui.finding({
    kind: 'broken-now',
    id: 'retention.03',
    title: 'found while writing the rule, no AI',
    rows: [
      { label: 'Promise', text: 'Cached documents expire within 24 hours' },
      { label: 'Policy', text: '"Cached copies of a document are deleted within 24 hours."', where: 'policies/retention.md:18' },
      { label: 'Code', text: 'backend-api/app/services/cache_service.py:19' },
      { label: '', text: 'CACHE_TTL_SECONDS = 172800  # 2 days', tone: 'code', lineNo: 19 },
      { label: 'Actual', text: '172800 seconds (2 days); allowed at most 24 hours', tone: 'broken' },
      { label: 'Rule', text: 'retention.03-r1 passes on a fixed copy (ttl 86400) and fails on today\'s code.', tone: 'muted' },
    ],
  }),
);
print('');
print(
  ui.finding({
    kind: 'broken',
    id: 'documents.05',
    title: 'proved by a rule, no AI',
    rows: [
      { label: 'Policy', text: '"Document text is kept only in the extension\'s memory and is never written to disk."', where: 'policies/document-handling.md:9' },
      { label: 'Code', text: 'chrome-extension/src/background/store.ts:42' },
      { label: '', text: "await chrome.storage.local.set({ lastDocument: doc.text });", tone: 'code', lineNo: 42 },
      { label: 'Why', text: 'chrome.storage.local writes to disk; the promise allows memory only (cleared when the user clears the clipboard).' },
    ],
  }),
);

print(ui.section('Results'));
const reason = {
  'broken-now': 'cache_service.py:19 ttl 172800s, allowed 24h',
  'no-rule': 'about staff behaviour, not code',
  skipped: 'a rule already covers it',
  written: 'regex rule, 6 mutants caught, red team held',
};
const rows = ids.map((id) => {
  const o = outcome(id);
  const badge =
    o === 'broken-now' ? ui.badge('broken-now') : o === 'no-rule' ? ui.badge('cant-tell') : o === 'skipped' ? ui.badge('not-checked') : ui.badge('holds');
  const what = o === 'broken-now' ? 'BROKEN NOW' : o === 'no-rule' ? 'no rule possible' : o === 'skipped' ? 'skipped' : 'written';
  return [id, what, badge, id === 'documents.05' ? 'chrome.storage.local in store.ts:42 (memory only promised)' : reason[o]];
});
print(
  ui.table({
    columns: [{ header: 'Promise' }, { header: 'Rule' }, { header: 'Today' }, { header: 'Reason', flex: true }],
    rows,
  }),
);

print(ui.section('Every badge'));
const kinds = ['holds', 'broken', 'broken-now', 'looks-kept', 'looks-broken', 'cant-tell', 'not-checked'];
print(
  ui.table({
    header: false,
    columns: [{ header: '' }, { header: '' }],
    rows: kinds.map((k) => [ui.badge(k), ui.tone(k === 'not-checked' ? 'no rule ran and no AI read' : k.startsWith('looks') || k === 'cant-tell' ? 'read by AI: a hint, never blocks' : 'proved by a rule, no AI', 'muted')]),
  }),
);

print(ui.section('Summary'));
print(
  ui.cards([
    { value: '16', label: 'rules written', sub: '6 mutants each', tone: 'kept' },
    { value: '2', label: 'broken now', sub: 'found by rules', tone: 'broken' },
    { value: '2', label: 'without a rule', sub: 'staff, not code' },
    { value: '$2.44', label: 'of $10.00 budget', sub: '4m 02s', tone: 'accent' },
  ]),
);

const proofs = ui.verbose('proof · retention.03-r1', [
  { label: 'pattern', text: String.raw`(?i)CACHE_TTL(?:_SECONDS)?\s*=\s*(?<seconds>\d+)` },
  { label: 'allowed', text: 'seconds <= 86400 (24 hours, from policies/retention.md:18)' },
  { label: 'mutants', text: '6 of 6 caught: ttl 86401, ttl 172800, ttl = 2 * DAY, setex(..., 90000), redis.expire(..., 1e6), ttl from env' },
  { label: 'models', text: String.raw`(?i)\b(openai|anthropic|cohere|mistral|groq|together|fireworks|perplexity|deepseek|gemini|vertex|bedrock|azure-openai|replicate|huggingface)\b` },
]);
if (proofs.length > 0) {
  print('');
  print(proofs);
} else {
  print('');
  print(ui.hint('  Proofs, patterns and mutants: run again with --verbose.'));
}
print(ui.next([`${BRAND.command} check  (BROKEN NOW promises show as BROKEN by their rule)`, `${BRAND.command} rule list --verbose`]));
