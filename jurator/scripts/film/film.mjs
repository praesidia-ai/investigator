#!/usr/bin/env node
// Jurator film: one command from a real demo take to a finished 1920x1080 MP4 with narration and captions.
//
//   node scripts/film/film.mjs --out <new-dir>                      scripted take (offline, free, marked REHEARSAL)
//   node scripts/film/film.mjs --out <new-dir> --live --env-file ../.env   live Meta take (about $0.66), then film
//   node scripts/film/film.mjs --out <new-dir> --take <take.typescript>     re-film an earlier take (no model calls)
//   options: --voice kokoro|say|none (default say: a macOS scratch voice; kokoro: Kokoro-82M, free open weights,
//              local, see tts_kokoro.py; KOKORO_PY = its python, default ~/.cache/jurator-film/.venv/bin/python)
//            --narration <dir> (scene-01.wav ... scene-NN.wav recorded by a person; overrides --voice)
//            --voice-name Samantha|af_heart  --rate 182 (say)  --speed 1.0 (kokoro)  --no-investigator
//            --plan (narrate and time the scenes, then stop before rendering)
//   Writes youtube.md (title, description with chapters, tags) and thumbnail.jpg (1280x720) next to the MP4.
//
// Every terminal frame is the real output of scripts/demo.sh --video (captured through a pty, colours intact).
// Nothing is retyped or staged: the film only paces, scrolls and highlights what the take printed.
// Needs: macOS `script` and `say`, ffmpeg/ffprobe on PATH, and Playwright (PLAYWRIGHT_MODULE, default: the ui repo's).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JURATOR = resolve(HERE, '../..');
const INVESTIGATOR = resolve(JURATOR, '..');
const REPO_URL = 'github.com/praesidia-ai/investigator';
// shortcut: borrows the ui repo's Playwright install; set PLAYWRIGHT_MODULE when filming outside this workspace.
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE || resolve(INVESTIGATOR, '../ui/node_modules/playwright/index.mjs');
const REPORT = resolve(INVESTIGATOR, 'artifacts/meta-live-cancellation-4/report.html');

// ---------------------------------------------------------------- options
function parseArgs(argv) {
  const o = { live: false, voice: 'say', rate: 182, speed: 1.0, investigator: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v) fail(`${a} needs a value`); return v; };
    if (a === '--out') o.out = resolve(val());
    else if (a === '--live') o.live = true;
    else if (a === '--env-file') o.envFile = resolve(val());
    else if (a === '--take') o.take = resolve(val());
    else if (a === '--dogfood') o.dogfood = resolve(val()); // a second take: Jurator on Praesidia's own repos (+ discuss)
    else if (a === '--corvane') o.corvane = resolve(val()); // the whole film from one take on the fictional Corvane workspace
    else if (a === '--voice') o.voice = val();
    else if (a === '--voice-name') o.voiceName = val();
    else if (a === '--rate') o.rate = Number(val());
    else if (a === '--speed') o.speed = Number(val());
    else if (a === '--narration') o.narration = resolve(val());
    else if (a === '--no-investigator') o.investigator = false;
    else if (a === '--plan') o.plan = true;
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n')); process.exit(0); }
    else fail(`unknown option ${a}`);
  }
  if (!o.out) fail('--out <new-dir> is required');
  if (existsSync(o.out) && readdirSync(o.out).length) fail(`${o.out} exists and is not empty (takes are never overwritten)`);
  if (!['say', 'kokoro', 'none'].includes(o.voice)) fail('--voice is kokoro, say or none');
  o.voiceName ??= o.voice === 'kokoro' ? 'af_heart' : 'Samantha';
  return o;
}
function fail(msg) { console.error(`film: ${msg}`); process.exit(2); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}
const log = (m) => console.log(`\x1b[2m[film]\x1b[22m ${m}`);

// ---------------------------------------------------------------- 1. the take
function captureTake(o) {
  const take = join(o.out, 'take.typescript');
  const env = { ...process.env, JURATOR_SKIP_BUILD: '1', COLUMNS: '100', JURATOR_DEMO_MODE: o.live ? 'live' : 'scripted' };
  if (o.envFile) env.JURATOR_ENV_FILE = o.envFile; // demo.sh hands the file to node --env-file; never read here
  log(`recording the ${o.live ? 'LIVE' : 'scripted'} take (scripts/demo.sh --video) ...`);
  const t0 = Date.now();
  const r = run('script', ['-q', take, 'bash', join(JURATOR, 'scripts/demo.sh'), '--video', '--clean'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  log(`take finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${r.status}`);
  if (r.status !== 0) fail(`the demo take failed (exit ${r.status}); see ${take}`);
  return take;
}

// ---------------------------------------------------------------- 2. parse into command blocks
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
export function parseTake(raw) {
  const lines = raw.replace(/\r/g, '').replace(/\x04|\^D/g, '').split('\n');
  const header = strip(lines.find((l) => strip(l).startsWith('Jurator demo on')) || '');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const s = strip(line);
    if (s.startsWith('Jurator demo on')) continue;
    // demo.sh's own self-check lines compare the take to the scripted answers; they are not Jurator output.
    if (/^\s+! .*\(live model output differs from the script; carrying on\)$/.test(s) || /^\d+ differences from the script$/.test(s)) continue;
    const isPrompt = s.startsWith('$ ') && !(cur && cur.lines.length && strip(cur.lines.at(-1)).endsWith('\\'));
    const isComment = s.startsWith('# simulated');
    if (isPrompt || (isComment && !(cur && cur.comment))) {
      cur = { cmd: isPrompt ? s.slice(2) : '', comment: isComment, lines: [] };
      blocks.push(cur);
    }
    if (cur) cur.lines.push(line);
  }
  for (const b of blocks) while (b.lines.length && !strip(b.lines.at(-1)).trim()) b.lines.pop();
  const differences = /(\d+) differences from the script/.exec(strip(raw));
  return { header, blocks, differences: differences ? Number(differences[1]) : 0 };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
export function ansiToHtml(line) {
  let out = '', st = { b: 0, d: 0, fg: '', bg: '' }, open = false;
  const close = () => { if (open) { out += '</span>'; open = false; } };
  const openSpan = () => {
    const cls = [st.b && 'b', st.d && 'd', st.fg && 'f' + st.fg, st.bg && 'g' + st.bg].filter(Boolean);
    if (cls.length) { out += `<span class="${cls.join(' ')}">`; open = true; }
  };
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { out += esc(part); continue; }
    for (const c of (m[1] || '0').split(';').map(Number)) {
      if (c === 0) st = { b: 0, d: 0, fg: '', bg: '' };
      else if (c === 1) st.b = 1; else if (c === 2) st.d = 1; else if (c === 22) { st.b = 0; st.d = 0; }
      else if (c === 39) st.fg = ''; else if (c === 49) st.bg = '';
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = String(c);
      else if (c >= 40 && c <= 47) st.bg = String(c);
    }
    close(); openSpan();
  }
  close();
  return out || ' ';
}

// ---------------------------------------------------------------- 3. the story
// Voice lines stay true to what is on screen (docs/VIDEO.md "Lines that must stay true").
function story(take, o) {
  if (o.corvane) return corvaneStory(take);
  const live = o.live || /\(live\)|muse-wonder-1\.0 \(live\)/.test(take.blocks.map((b) => strip(b.lines.join('\n'))).join('\n'));
  const find = (re, from = 0) => {
    const i = take.blocks.findIndex((b, k) => k >= from && re.test(b.cmd));
    if (i < 0) fail(`the take has no block for ${re}`);
    return i;
  };
  const text = (i) => strip(take.blocks[i].lines.join('\n'));
  const money = (i, re) => { const m = re.exec(text(i)); return m ? `$${Number(m[1]).toFixed(2)}` : '$?'; };
  const iInit = find(/^jurator init/), iCompile = find(/^jurator compile/), iRules = find(/^jurator rule propose/);
  const iBind = find(/^jurator bind/), iCheck = find(/^jurator check(?! --diff)/), iCo = find(/^git checkout/);
  const iDiff = find(/^git diff/), iBroken = find(/^jurator check --diff/), iVerify = find(/^jurator verify/);
  const iAgain = find(/^jurator check --diff/, iVerify), iHooks = find(/^jurator hook install/);
  const iSim = take.blocks.findIndex((b) => b.comment), iRun = find(/^echo /), iPush = find(/^git push/);
  const cost = {
    compile: money(iCompile, /Cost \$(\d+\.\d+)/), rules: money(iRules, /\$(\d+\.\d+)\s+│[^\n]*\n[^\n]*of \$/),
    bind: money(iBind, /Cost \$(\d+\.\d+)/), check: money(iCheck, /cost \$(\d+\.\d+)/), diff: money(iBroken, /cost \$(\d+\.\d+)/),
  };
  // A live rule can already fail on main (the model wrote a rule the scripted answers leave to AI reads).
  // The narration then names it from the rules table instead of claiming main is clean.
  const nowBroken = [...text(iRules).matchAll(/^\s+([a-z]+\.\d+)\s+✗ BROKEN NOW\s+(.+)$/gm)].map((m) => ({ id: m[1], wording: m[2].trim() }));
  const mainBroken = /✗ BROKEN/.test(text(iCheck));
  if (mainBroken && !nowBroken.length) fail('main has a broken promise the rules table does not name; the narration cannot describe it');
  const speak = (w) => w.replace(/_/g, ' ').replace(/\.$/, '');
  const aiHints = /LOOKS KEPT|LOOKS BROKEN|CAN'T TELL/.test(text(iCheck));
  const promiseCount = /── Promises[─ ]+(\d+)/.exec(text(iCompile))?.[1];
  const ruleCount = /(\d+) of (\d+) written/.exec(text(iRules));
  const model = live ? 'Muse Wonder' : 'the model';

  // ai: the badge on the terminal bar says which step called a Meta model and which ran with no AI.
  const wonder = live ? 'Meta · muse-wonder-1.0' : 'model step · scripted answer';
  const explains = live ? 'rules decide · Meta Muse explains' : 'rules decide · scripted summaries';
  const noAI = 'no AI · rules only';
  const scenes = [
    { kind: 'hero', blocks: [iBroken], focus: ['BROKEN'], chip: 'The catch', chapter: 'The catch',
      voice: 'A coding agent just broke our privacy policy. Jurator caught it before the push, and no AI made that call.' },
    { kind: 'title', chip: 'Praesidia', chapter: 'The catch',
      voice: 'Coding agents now change code faster than anyone can check it. We built two open source tools on Meta Muse. Jurator checks every code change against the promises in your policies. Investigator tests whether revoked agent work really stops.' },
    { kind: 'meta', chip: 'Built on Meta', chapter: 'How we use Meta',
      voice: 'Both run on the Meta Responses API. Muse Wonder does the reasoning: it reads policies, writes rules, and drives Investigator\'s experiments, with tool calls and JSON schema outputs. Muse Spark writes the plain word summaries. The models propose. The program decides.' },
    { kind: 'term', blocks: [iInit], chip: '1 · Find the policies', chapter: 'Jurator: policies to rules', ai: 'no AI', focus: ['Found 3 policies', 'praesidia '],
      voice: 'Jurator finds the policies: privacy, security, and the agent settings exported from Praesidia.' },
    { kind: 'term', blocks: [iCompile], chip: `2 · Policies → ${promiseCount || ''} promises`, ai: wonder, focus: ['quotes found', 'quote not found', 'privacy.01 ', 'Found by comparing'],
      voice: `${live ? 'Live, Muse Wonder' : 'The model'} turns each policy into numbered promises. The program finds every quote word for word${/quote not found/.test(text(iCompile)) ? ', and drops one it cannot find' : ''}. With no AI, it sees that privacy says thirty days, while the agent settings say ninety.` },
    { kind: 'term', blocks: [iRules], chip: `3 · Rules${ruleCount ? ` · ${ruleCount[1]} of ${ruleCount[2]}` : ''}`, ai: wonder, focus: ['privacy.01 ', 'no rule possible', ...(nowBroken.length ? ['BROKEN NOW'] : []), 'rules accepted'],
      voice: `${live ? 'Muse Wonder' : 'The model'} writes a rule for each promise it can check in code. Jurator keeps a rule only if it breaks when the guarding line is removed.` +
        (nowBroken.length ? ` One rule already fails on today's code: ${speak(nowBroken[0].wording)}${/approval/.test(nowBroken[0].wording) ? ', and the rule finds no approval call next to it' : ''}.` : ' Where no rule is possible, it says so.') },
    { kind: 'term', blocks: [iBind], chip: '4 · Where each promise lives', ai: wonder, focus: ['privacy.01 '],
      voice: 'It also records where each promise lives: CHAT_TTL_DAYS, line two, belongs to the thirty day promise.' },
    { kind: 'term', blocks: [iCheck], chip: '5 · Check main', chapter: 'Jurator: catching the agent', ai: explains, focus: [...(mainBroken ? ['✗ BROKEN'] : []), 'HOLDS', ...(aiHints ? ['LOOKS KEPT'] : []), 'covered by rules'],
      voice: (mainBroken ? `On main, that rule still fails, so the check blocks until someone fixes the code or the policy. Every other rule holds.` : 'On main, every rule holds.') +
        (aiHints ? ' A promise with no rule is only read by the AI. It says so, and it never blocks.' : '') },
    { kind: 'term', blocks: [iCo, iDiff], chip: "6 · The agent's change", focus: ['+export const CHAT_TTL_DAYS'],
      voice: 'Now a coding agent changes CHAT_TTL_DAYS from thirty to ninety, to match the agent settings. That is the wrong policy.' },
    { kind: 'term', blocks: [iBroken], chip: '7 · Broken, proved by a rule', ai: explains, zoom: true, focus: ['privacy.01 ━', 'Was ', 'Checked ', 'Policy '],
      voice: 'Broken, proved by a rule, not by a model. The policy line, the code line, the old value, and exactly why this promise was checked.' },
    { kind: 'term', blocks: [iVerify, iAgain], chip: '8 · Verify with no AI', chapter: 'Jurator: verify and guard', ai: 'no AI', focus: ['Verified', 'Nothing to recheck'],
      voice: 'Anyone can re-check this record with no AI. Run the check again, and there is nothing to recheck.' },
    { kind: 'term', blocks: [iHooks, ...(iSim >= 0 ? [iSim] : []), iRun], chip: '9 · Guarding the coding agent', ai: noAI, focus: ['Claude Code PreToolUse', 'simulated agent call', 'permissionDecision: deny'],
      voice: 'The same rules guard the coding agent. In this simulated agent call, Claude Code or Muse Code asks to git push. The hook answers deny, with the evidence.' },
    { kind: 'term', blocks: [iPush], chip: '10 · …and every git push', ai: noAI, focus: ['rules only, no AI', 'BROKEN', 'push blocked'],
      voice: 'And on every git push, by people too. Rules only, no AI, in about a second.' },
  ];
  if (o.investigator && existsSync(REPORT)) scenes.push({ kind: 'investigator', chip: 'Praesidia Investigator · runtime proof', chapter: 'Investigator: runtime proof',
    voice: 'Some promises are about what happens at runtime. For those, Investigator runs the experiment. In this recorded live run, Muse Wonder drove the investigation through fifty five tool calls. A revoked agent job said cancelled, but the destination receipt shows the export still happened. Investigator applied one bounded repair, and four of four checks pass.' });
  scenes.push({ kind: 'end', chip: 'Jurator', chapter: 'Cost and code',
    voice: live
      ? `Measured on this take: compile ${say$(cost.compile)}, rules ${say$(cost.rules)}, first check ${say$(cost.check)}. Then rule checks cost nothing. Both tools are open source.`
      : 'Models propose. Rules decide. Every record can be verified with no AI. Both tools are open source.' });
  if (o.dogfood) return dogfoodStory(take, o, { live, find, text, money, iHooks, iSim, iRun, iPush, wonder, explains, noAI });
  return { scenes, live, cost };
}

// The Praesidia.ai cut: Jurator on Praesidia's own five repos (the --dogfood take), the chat, the agent guard from
// the demo take, then Investigator. The dogfood blocks come after the demo take's last block (its git push).
function dogfoodStory(take, o, d) {
  const { find, text } = d, at = d.iPush + 1;
  const all = (re) => take.blocks.map((b, i) => i).filter((i) => i >= at && re.test(take.blocks[i].cmd));
  const last = (re) => { const k = all(re).at(-1); if (k === undefined) fail(`the dogfood take has no block for ${re}`); return k; };
  const dInit = find(/^jurator init/, at), dCompile = find(/^jurator compile/, at), dRules = last(/^jurator rule propose/);
  const dCheck = last(/^jurator check(?! --diff)/), dDiff = find(/^git -C \S+ diff/, at), dBroken = find(/^jurator check --diff/, at);
  const dAsk = all(/^jurator discuss/);
  const num = (i, re) => re.exec(text(i))?.[1];
  const repos = num(dInit, /Repos \((\d+)\)/) || '5', policies = num(dInit, /Found (\d+) polic/) || '3';
  const promises = num(dCompile, /accepted (\d+) drafts/) || num(dCompile, /── Promises[─ ]+(\d+)/) || '?';
  const blockText = (i) => text(i);
  const rules = all(/^jurator rule propose/).reduce((n, i) => n + Number(/│ (\d+)\s+│[^\n]*\n[^\n]*rules accepted/.exec(blockText(i))?.[1] || 0), 0);
  const spent = (re) => all(re).reduce((n, i) => n + Number(/Cost \$(\d+\.\d+)/.exec(blockText(i))?.[1] || /\$(\d+\.\d+)\s+│[^\n]*\n[^\n]*of \$/.exec(blockText(i))?.[1] || 0), 0);
  const cost = { compile: `$${spent(/^jurator compile/).toFixed(2)}`, rules: `$${spent(/^jurator rule propose/).toFixed(2)}`,
    check: d.money(dCheck, /cost \$(\d+\.\d+)/), diff: d.money(dBroken, /cost \$(\d+\.\d+)/) };
  const mainBroken = /✗ BROKEN/.test(text(dCheck));
  const win = 'praesidia — be · ui · mcp · gateway · iac';
  // Display-only trims (counts and costs above are read first); each cut leaves a visible "…" line saying what is hidden.
  const more = (what) => `\x1b[2m  … ${what}\x1b[22m`;
  const cut = (i, at, what, tail = 0) => {
    const L = take.blocks[i].lines, k = L.findIndex((l, j) => j > 0 && at.test(strip(l)));
    if (k > 0) take.blocks[i].lines = [...L.slice(0, k), more(what), ...(tail ? L.slice(-tail) : [])];
  };
  const dropRows = (i, re, what) => {
    const out = []; let skip = false, n = 0;
    for (const l of take.blocks[i].lines) {
      const s = strip(l);
      if (/^ {0,4}\S/.test(s) || !s.trim()) { skip = re.test(s); if (skip) n++; }
      if (!skip) out.push(l);
    }
    const k = out.findIndex((l) => /Notes under|Details \(/.test(strip(l)));
    if (n) out.splice(k > 0 ? k : out.length, 0, more(`${n} rows for promises not asked this run are hidden`), '');
    take.blocks[i].lines = out;
  };
  dropRows(dRules, /not asked/, '');
  cut(dBroken, /^── Other results/, 'other results hidden: AI hints and CAN\'T TELL rows', 12);
  for (const i of dAsk) cut(i, /@ [0-9a-f]{7} \|/, 'cited source lines hidden');
  const scenes = [
    { kind: 'hero', blocks: [dBroken], chip: 'The catch', chapter: 'The catch',
      title: 'An agent switched off Stripe signature checks. <span>Caught before the push.</span>',
      voice: 'A coding agent just switched off Stripe webhook signature checks, in our own backend. Praesidia caught it before the push, and no AI made that call.' },
    { kind: 'title', chip: 'Praesidia.ai', chapter: 'The catch',
      voice: 'This is Praesidia dot A I: proof for what AI agents do. Jurator checks every code change against the promises in your policies. Investigator proves, at runtime, that revoked agent work really stops. Both run on Meta Muse.' },
    { kind: 'meta', chip: 'Built on Meta', chapter: 'How we use Meta',
      voice: "Everything runs on the Meta Responses API. Muse Wonder reads policies, writes rules, answers questions, and drives Investigator's experiments, with tool calls and JSON schema outputs. Muse Spark writes the plain word summaries. The models propose. The program decides." },
    { kind: 'stats', chip: 'Dogfood', chapter: 'Jurator on our own code', kicker: 'Live take · our own platform',
      h1: 'We pointed Jurator at <span class="grad">Praesidia</span> itself.',
      tiles: [[repos, 'code repos'], [policies, 'real policies'], [promises, 'promises'], [String(rules), 'proven rules']],
      h2: 'Privacy policy · security page · <em>the rules our AI coding agents must follow</em>',
      voice: `No toy app. We pointed Jurator at our own platform: ${repos} repositories, and ${policies} real policies. Our privacy policy, our security page, and the rules our AI coding agents must follow.` },
    { kind: 'term', blocks: [dInit, dCompile], win, chip: `Policies → ${promises} promises`, ai: d.wonder, focus: ['workspace · 5 repos', 'Found 3 policies', 'coding-agents.19', 'privacy.17', 'accepted'],
      voice: `Live, Muse Wonder turns them into ${promises} numbered promises. Each keeps its exact quote, and the program finds every quote word for word.` },
    { kind: 'term', blocks: [dRules], win, chip: `${rules} rules, each proven`, ai: d.wonder, focus: ['privacy.13', 'privacy.17', 'rules accepted'],
      voice: `Then it writes a rule for each promise it can check in code. A rule is kept only if it fails when the guarding line is removed. ${rules} proven rules, from Stripe signatures to where our data may live.` },
    { kind: 'term', blocks: [dCheck], win, chip: 'One check · five repos', ai: d.explains, focus: [...(mainBroken ? ['✗ BROKEN'] : []), 'HOLDS', 'covered by rules'],
      voice: mainBroken ? "One check covers all five repos. Where a rule fails on today's code, it blocks until someone fixes the code or the policy." : `One check covers all five repos. On main, all ${rules} rules hold and nothing is broken. What the model reads is a hint, and never blocks.` },
    { kind: 'term', blocks: [dDiff, dBroken], win, chip: "The agent's change", chapter: 'Catching the agent', ai: d.explains, zoom: true, focus: ['JSON.parse', 'BROKEN  ━', 'Policy '],
      voice: 'Now a coding agent "fixes" local webhook replays by skipping the Stripe signature check. Broken, proved by a rule, not by a model: the rule our agents must follow, the exact code line, and what changed.' },
    ...dAsk.map((i, k) => ({ kind: 'term', blocks: [i], win: 'praesidia — jurator discuss', chip: k ? 'Ask again' : 'Just ask', chapter: 'Ask Jurator', ai: 'Meta · muse-wonder-1.0 · read-only', focus: ['Why it broke', 'What the agent should have done'],
      voice: k ? 'Ask a follow-up, and it answers from the same records.' : 'And you can just ask why. Muse Wonder looks up the finding, the rule and the code with read only tools, then explains what broke and what the agent should have done. It never changes anything.' })),
    { kind: 'term', blocks: [d.iHooks, ...(d.iSim >= 0 ? [d.iSim] : []), d.iRun, d.iPush], chip: 'Guarding the agent', chapter: 'Guarding the agent', ai: d.noAI, focus: ['simulated agent call', 'permissionDecision: deny', 'push blocked'],
      voice: 'The same rules guard the agent itself. Here, on our demo notes app, a simulated Claude Code call asks to git push, and the hook answers deny, with the evidence. People get the same check on every push.' },
  ];
  if (o.investigator && existsSync(REPORT)) scenes.push({ kind: 'investigator', chip: 'Praesidia Investigator · runtime proof', chapter: 'Investigator: runtime proof',
    voice: 'Some promises are about what happens at runtime. For those, Investigator runs the experiment. In this recorded live run, Muse Wonder drove fifty five tool calls. A revoked agent job said cancelled, but the destination receipt shows the export still happened. One bounded repair later, four of four checks pass.' });
  scenes.push({ kind: 'end', chip: 'Praesidia.ai', chapter: 'Praesidia.ai',
    voice: `Measured live on our own code: compiling three policies cost ${say$(cost.compile)}, writing and proving ${rules} rules cost ${say$(cost.rules)}. After that, every check is rules only. Models propose. Rules decide. Praesidia dot A I.` });
  return { scenes, live: d.live, cost, tiles: [[cost.compile, 'compile 3 policies'], [cost.rules, `write + prove ${rules} rules`], [cost.check, 'check 5 repos'], ['$0', 'every rules-only re-check']] };
}
// The Corvane cut: one live take on a fictional fintech workspace (6 repos, 4 policies) built by
// make-demo-workspace.py, then a live Investigator run. Nothing from Praesidia's own code is on screen.
function corvaneStory(take) {
  const B = take.blocks, text = (i) => strip(B[i].lines.join('\n'));
  const find = (re, from = 0) => { const i = B.findIndex((b, k) => k >= from && re.test(b.cmd)); if (i < 0) fail(`the corvane take has no block for ${re}`); return i; };
  const all = (re) => B.map((b, i) => i).filter((i) => re.test(B[i].cmd));
  const num = (i, re) => re.exec(text(i))?.[1];
  const iInit = find(/^jurator init/), iCompile = find(/^jurator compile/), iConf = all(/^jurator conflicts/);
  const iRules = find(/^jurator rule propose/), iBind = find(/^jurator bind/), iMain = find(/^jurator check(?! --diff)/);
  const iDiff = find(/^git -C agents diff/), iBroken = find(/^jurator check --diff/), iExplain = find(/^jurator explain/);
  const iVerify = find(/^jurator verify/), iReport = find(/^jurator report/), iHooks = all(/^jurator hook install/);
  const iSim = B.findIndex((b) => b.comment), iRun = find(/^echo /), iPush = find(/^git -C api push/), iAsk = find(/^jurator discuss/);
  const iInv = [find(/^investigator cancellation-demo/), find(/^investigator show/), find(/^investigator verify-cancellation/)];
  // Optional tour blocks (take3.sh / take4.sh): more Jurator and Investigator commands, one quick scene each.
  const opt = (re) => B.findIndex((b) => re.test(b.cmd));
  const tPromises = opt(/^jurator promises --for/), tRuleTest = opt(/^jurator rule test/), tMcp = opt(/^jurator mcp/), tDoctor = opt(/^jurator doctor/);
  const tBench = opt(/^jurator bench/), tInvDemos = all(/^investigator (demo|repair-demo|evidence-demo|assurance-demo)/);
  const live = /muse-wonder-1\.0 \(live\)/.test(text(iCompile)) && /mode: live/.test(text(iInv[1]));
  if (!live) fail('the corvane take is not live; this cut only narrates live runs');
  const repos = num(iInit, /Repos \((\d+)\)/), policies = num(iInit, /Found (\d+) polic/), promises = num(iCompile, /accepted (\d+) drafts/);
  const rules = /(\d+) of (\d+) written · (\d+) broken now/.exec(text(iRules));
  const broken = num(iBroken, /│ (\d+)\s+│[^\n]*\n[^\n]*broken: blocks/);
  const cost = { compile: `$${num(iCompile, /Cost \$(\d+\.\d+)/)}`, rules: `$${num(iRules, /│ \$(\d+\.\d+)\s+│[^\n]*\n[^\n]*of \$/)}`,
    bind: `$${Number(num(iBind, /Cost \$(\d+\.\d+)/)).toFixed(2)}`, check: `$${num(iMain, /cost \$(\d+\.\d+)/)}`, diff: `$${num(iBroken, /cost \$(\d+\.\d+)/)}` };
  for (const [k, v] of Object.entries(cost)) if (v.includes('undefined') || v.includes('NaN')) fail(`could not read the ${k} cost from the take`);
  if (!repos || !policies || !promises || !rules || !broken) fail('could not read the counts from the take');
  // Display-only trims (counts and costs above are read first); each cut leaves a visible "…" line saying what is hidden.
  const more = (what) => `\x1b[2m  … ${what}\x1b[22m`;
  const cut = (i, at, what, tail = 0) => {
    const L = B[i].lines, k = L.findIndex((l, j) => j > 0 && at.test(strip(l)));
    if (k < 0) fail(`trim: block ${i} has no line ${at}`);
    B[i].lines = [...L.slice(0, k), more(what), ...(tail ? L.slice(-tail) : [])];
  };
  const drop = (i, from, to, what) => { // hide lines from the first match of `from` up to (not including) `to`
    const L = B[i].lines, a = L.findIndex((l) => from.test(strip(l))), z = L.findIndex((l, j) => j > a && to.test(strip(l)));
    if (a < 0 || z < 0) fail(`trim: block ${i} has no range ${from}..${to}`);
    B[i].lines = [...L.slice(0, a), more(what), ...L.slice(z)];
  };
  drop(iRules, /^\s+\[1\/\d+\]/, /^── Rules/, `${rules[2]} promises, 8 at a time: progress lines hidden`);
  drop(iRules, /^┏━  ✗ BROKEN NOW  ━ security\.16/, /^\s+Details \(/, 'one more BROKEN NOW box hidden: security.16, log retention');
  cut(iBind, /^\s+ai-agents\.04/, 'one row per promise, rest hidden', 4);
  cut(iBroken, /^── Other results/, 'other results hidden: 22 HOLDS, AI hints and before-merge rows', 9);
  cut(iRun, /^- payments\.02 BROKEN/, 'four more broken promises, same evidence (card number and CVC in a debug log)', 4);
  cut(iAsk, /@ [0-9a-f]{7} \|/, 'cited source lines hidden', 1);
  B[iReport].lines = [B[iReport].lines[0], `\x1b[32m✓\x1b[39m Wrote ../corvane-report.html: ${promises} promises, ${rules[1]} rules (full path shortened)`];
  drop(iInv[1], /^== Integrity/, /^== Scope/, 'integrity digests hidden (shown by verify-cancellation)');
  if (tPromises >= 0) cut(tPromises, /^ai-agents\.03/, 'more promises apply to this file', 0);
  if (tDoctor >= 0) B[tDoctor].lines = B[tDoctor].lines.filter((l) => !/Config|Next:/.test(strip(l)));
  const benchRow = (re) => { const m = tBench >= 0 && new RegExp(re.source + '\\s+(\\d)/(\\d)\\s+(\\d)/(\\d)').exec(text(tBench)); return m ? m.slice(1) : null; };
  const bRules = benchRow(/Rules only \(no AI\)/), bJur = benchRow(/Jurator: rules, else AI read \(muse-wonder-1\.0\)/);
  const benchLive = tBench >= 0 && /· live/.test(text(tBench));
  if (tBench >= 0 && (!bRules || !bJur)) fail('could not read the bench rows');
  if (tBench >= 0) { // display: the method table only, re-flowed to fit 100 columns (the take wrapped it)
    const t = text(tBench), rows = [];
    const re = /^((?:Rules only|AI read|Plain skill prompt|Jurator: rules)[^\n]*?)\s+(\d\/\d)\s+(\d\/\d)\s+(\d+)\s+(\d+)\s+(\d+)\s*\n?\s*(\$[\d.]+)/gm;
    for (const m of t.matchAll(re)) rows.push(m);
    if (rows.length < 4) fail('could not re-flow the bench table');
    const head = B[tBench].lines.find((l) => /^Bench:/.test(strip(l))), total = B[tBench].lines.find((l) => /^Cost: \$/.test(strip(l)));
    const row = (n, c, f, w, k, d) => `${n.padEnd(48)}${c.padEnd(9)}${f.padEnd(14)}${w.padEnd(13)}${k.padEnd(7)}${d}`;
    B[tBench].lines = [B[tBench].lines[0], '', head, '', `\x1b[1m${row('Method', 'Catches', 'False alarms', 'Wrong flags', 'Calls', 'Cost')}\x1b[22m`,
      ...rows.map((m) => { const r = row(m[1], m[2], m[3], m[4], m[6], m[7]); return /^Jurator/.test(m[1]) ? `\x1b[1;32m${r}\x1b[22;39m` : /^Rules only/.test(m[1]) ? `\x1b[1m${r}\x1b[22m` : r; }),
      '', more('per-case table hidden: 5 planted breaks, 3 harmless changes'), '', total.replace(/ · budget.*/, '')];
  }
  const invLive = tInvDemos.length && tInvDemos.every((i) => !/scripted/i.test(text(i)));

  const win = `corvane (fictional fintech) — ${repos} repos · ${policies} policies`;
  const wonder = 'Meta · muse-wonder-1.0', explains = 'rules decide · Meta Muse explains', noAI = 'no AI · rules only';
  const scenes = [
    { kind: 'intro', chip: 'Praesidia', chapter: 'Praesidia',
      voice: 'An AI agent changed your code. | Who signed off? | Praesidia. | Jurator, for the rules. Investigator, for the runtime.' },
    { kind: 'hero', blocks: [iBroken], heroId: 'ai-agents.11', chip: 'The catch', chapter: 'The catch',
      title: 'A coding agent removed refund approval. <span>Caught before the push.</span>',
      voice: 'Like this one: refund approval removed. Caught before the push, and no AI made that call.' },
    { kind: 'meta', chip: 'Built on Meta', chapter: 'How we use Meta',
      voice: 'Both run on the Meta Responses API. Muse Wonder reasons with tool calls and JSON schemas. Muse Spark summarizes. Models propose; the program decides.' },
    { kind: 'term', blocks: [iInit, iCompile], win, chip: `${policies} policies → ${promises} promises`, chapter: 'Jurator: policies to rules', ai: wonder,
      focus: ['Found 4 policies', 'quotes found', 'accepted 60 drafts'],
      voice: `Corvane, a fictional fintech: ${repos} repos, ${policies} policies. Muse Wonder turns them into ${promises} promises, every quote checked word for word.` },
    { kind: 'term', blocks: iConf.slice(0, 2), win, chip: 'Contradictions, found with no AI', ai: 'no AI · typed fields', focus: ['Found by comparing 90 days', 'C-1 ruled real'],
      voice: 'With no AI, it finds contradictions, like ninety days versus thirty. A person rules on each.' },
    { kind: 'term', blocks: [iRules, iBind], win, chip: `${rules[1]} rules, each proven`, ai: wonder, focus: ['BROKEN NOW  ━ privacy.14', 'rules accepted', 'Where each promise lives'],
      voice: `Then it writes rules, kept only if they fail when the guard is removed. ${rules[1]} rules. ${rules[3] === '4' ? 'Four' : rules[3]} already caught gaps in today's code.` },
    { kind: 'term', blocks: [iMain], win, chip: 'Main, after the fixes', ai: explains, focus: ["CAN'T TELL", 'covered by rules'],
      voice: 'Corvane fixed them. Main: zero broken. A promise with no rule gets an AI hint, which never blocks.' },
    { kind: 'term', blocks: [iDiff, iBroken], win, chip: `The agent's branch: ${broken} broken`, chapter: 'Jurator: catching the agent', ai: explains, zoom: true,
      focus: ['approved_by="penny-auto"', 'BROKEN  ━ ai-agents.11', 'BROKEN  ━ payments.02', 'broken: blocks'],
      voice: `An AI coding agent's branch: self-approving refunds, a stack in us-east-1, card numbers in a log. ${broken === '9' ? 'Nine' : broken} promises broken, each proved by a rule.` },
    { kind: 'term', blocks: [iExplain, iVerify, iReport], win, chip: 'Explain · verify · report', ai: 'no AI · rules + git', focus: ['Proof', 'Verified'],
      voice: 'Explain shows each rule\'s proof. Anyone can verify the record with no AI, and export a report.' },
    { kind: 'term', blocks: [...iHooks, iSim, iRun], win, chip: 'Guarding the coding agent', chapter: 'Jurator: guarding the agent', ai: noAI,
      focus: ['simulated agent call', 'permissionDecision: deny'],
      voice: 'The same rules guard the agent. In this simulated Muse Code call, Meta’s coding agent asks to git push. Denied, with the evidence.' },
    { kind: 'term', blocks: [iPush], win, chip: '…and every git push', ai: noAI, focus: ['BROKEN · ai-agents.10', 'push blocked'],
      voice: 'Every human git push too: a missing tenant guard, blocked offline, for zero dollars.' },
    { kind: 'term', blocks: [iAsk], win: 'corvane — jurator discuss', chip: 'Just ask', chapter: 'Ask Jurator', ai: 'Meta · muse-wonder-1.0 · read-only',
      focus: ['explain_promise ai-agents.11', 'What it should have done instead'],
      voice: 'Or just ask why. Muse Wonder reads the records with read only tools, and says what the agent should have done.' },
    ...(tPromises >= 0 && tRuleTest >= 0 ? [{ kind: 'term', blocks: [tPromises, tRuleTest], win, chip: 'Before the edit · any rule, any time', chapter: 'Jurator: more tools', ai: noAI,
      focus: ['Promises that apply to', 'FAIL  R-ai-agents.11-1'],
      voice: 'Before an edit, list the promises that apply to a file. Test any rule at any commit, offline.' }] : []),
    ...(tMcp >= 0 && tDoctor >= 0 ? [{ kind: 'term', blocks: [tMcp, tDoctor], win, chip: 'MCP for coding agents · doctor', ai: noAI,
      focus: ['promises_for_change', 'Price'],
      voice: 'Coding agents can ask Jurator over MCP, with read only tools. Doctor checks the Meta key, model and price.' }] : []),
    ...(tBench >= 0 ? [{ kind: 'term', blocks: [tBench], win: 'jurator bench — planted breaks', chip: `Bench${benchLive ? ' · live' : ''}: rules vs AI`, ai: benchLive ? 'Meta · muse-wonder-1.0 + muse-spark-1.3 · live' : noAI,
      focus: ['Rules only (no AI)', 'Plain skill prompt', 'Jurator: rules, else AI read'],
      voice: `Bench, on planted breaks: rules alone catch ${bRules[0]} of ${bRules[1]}. Rules, then Muse Wonder: ${bJur[0]} of ${bJur[1]}, ${bJur[2] === '0' ? 'no' : bJur[2]} false alarms.` }] : []),
    { kind: 'term', blocks: iInv, win: 'investigator — authored loopback workflow', product: 'Investigator', chip: 'Investigator · live runtime proof', chapter: 'Investigator: runtime proof',
      ai: 'Meta · muse-wonder-1.0 · live', focus: ['FAIL queued-after-revoke', '+  return job.authorizedAtEnqueue && currentRootActive', 'supported  4/4', 'yes independent root'],
      voice: 'For runtime promises, Investigator runs live experiments. Revoked work still landed downstream. One repair, a live re-test: four of four pass.' },
    ...(tInvDemos.length ? [{ kind: 'term', blocks: tInvDemos, win: `investigator — ${invLive ? 'live' : 'scripted'} demos on authored workloads`, product: 'Investigator', chip: `Investigator · more experiments${invLive ? '' : ' (scripted)'}`,
      ai: invLive ? 'Meta · muse-wonder-1.0 · live' : 'scripted · no model calls', focus: ['FAIL       exact-request-binding', 'Comparison never renews'],
      voice: 'Scripted demos show the rest: approvals not bound to the request, repair and re-test, evidence plans, and stale findings.' }] : []),
  ];
  // What the tools read and where answers go: only connectors and outputs that exist (README: init --source, hook, mcp, --json/--md).
  scenes.push({ kind: 'reach', chip: 'Beyond the code', chapter: 'Beyond the code', product: 'Jurator + Investigator',
    voice: 'Not just code. | Policies from files or Praesidia exports. Rules on code, config and infrastructure. Answers in git, Muse Code, MCP or JSON.' });
  scenes.push({ kind: 'end', chip: 'Praesidia', chapter: 'Praesidia',
    voice: `Measured live: policies, ${say$(cost.compile)}. Rules, ${say$(cost.rules)}. Every push check after that: zero. Models propose. Rules decide.` });
  const tiles = [[cost.compile, `compile ${policies} policies`], [cost.rules, `write + prove ${rules[1]} rules`], [cost.check, `check ${repos} repos`], ['$0.00', 'every git push']];
  return { scenes, live, cost, tiles, corvane: { repos, policies, promises, rules: rules[1], broken, invLive, bench: tBench >= 0 ? `${benchLive ? 'live' : 'offline'}: rules only ${bRules[0]}/${bRules[1]} caught, ${bRules[2]}/${bRules[3]} false alarms; Jurator rules then muse-wonder-1.0 ${bJur[0]}/${bJur[1]} caught, ${bJur[2]}/${bJur[3]} false alarms` : null } };
}
const say$ = (s) => { const n = Number(s.slice(1)); if (n < 1) return `${Math.round(n * 100)} cents`; const d = Math.floor(n), c = Math.round((n - d) * 100); return c ? `${d} dollars ${c}` : `${d} dollars`; }; // no decimal point: captions split sentences on '.'

// ---------------------------------------------------------------- 4. narration
function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(r.stdout.trim());
}
// What the synthetic voices read: identifiers spelled the way a person says them.
const spoken = (v) => v.replace(/CHAT_TTL_DAYS/g, 'chat T T L days').replace(/\bJSON\b/g, 'jason').replace(/\bAPI\b/g, 'A P I').replace(/us-east-1/g, 'U S east one');
const KOKORO_PY = process.env.KOKORO_PY || join(process.env.HOME || '', '.cache/jurator-film/.venv/bin/python');
function narrate(scenes, o) {
  const dir = join(o.out, 'voice'); mkdirSync(dir, { recursive: true });
  const kokoro = [];
  scenes.forEach((s, i) => {
    const name = `scene-${String(i + 1).padStart(2, '0')}`;
    const supplied = o.narration && ['wav', 'm4a', 'aiff', 'mp3'].map((e) => join(o.narration, `${name}.${e}`)).find(existsSync);
    if (supplied) s.audio = supplied;
    else if (o.voice === 'say') {
      s.audio = join(dir, `${name}.aiff`);
      run('say', ['-v', o.voiceName, '-r', String(o.rate), '-o', s.audio, spoken(s.voice).replace(/\s*\|\s*/g, ' ')]);
    } else if (o.voice === 'kokoro') { s.audio = join(dir, `${name}.wav`); kokoro.push({ text: spoken(s.voice), out: s.audio }); }
  });
  if (kokoro.length) {
    log(`kokoro: ${kokoro.length} lines, voice ${o.voiceName}, speed ${o.speed}`);
    const r = run(KOKORO_PY, [join(HERE, 'tts_kokoro.py'), o.voiceName, String(o.speed)], { input: JSON.stringify(kokoro) });
    if (r.status !== 0) fail(`kokoro failed (KOKORO_PY=${KOKORO_PY}):\n${r.stderr.slice(-2000)}`);
  }
  for (const s of scenes) {
    s.voiceSec = s.audio ? probe(s.audio) : s.voice.split(/\s+/).length / 2.7;
    // "|" in a line is a spoken pause: Kokoro writes each phrase's time, so captions and animation follow the phrases.
    const parts = s.voice.split('|').map((x) => x.trim()), mk = s.audio && `${s.audio}.marks.json`;
    if (parts.length > 1 && mk && existsSync(mk)) s.marks = JSON.parse(readFileSync(mk, 'utf8')).map((m, k) => ({ ...m, text: parts[k] }));
    s.voice = parts.join(' ');
  }
}

// ---------------------------------------------------------------- 5. investigator stills (real report, real browser)
async function investigatorStills(pw, o) {
  const b = await pw.chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(REPORT).href);
  const shots = [];
  for (const id of ['observations', 'repair']) {
    const file = join(o.out, `investigator-${id}.png`);
    await p.locator('#' + id).screenshot({ path: file });
    shots.push(`investigator-${id}.png`);
  }
  await b.close();
  return shots;
}

// YouTube thumbnail: thumbnail.html at 2x, scaled to 1280x720.
async function thumbnail(pw, o) {
  const b = await pw.chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(join(HERE, 'thumbnail.html')).href); await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: join(o.out, 'thumbnail@2x.png') }); await b.close();
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(o.out, 'thumbnail@2x.png'), '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', join(o.out, 'thumbnail.jpg')]);
}

// ---------------------------------------------------------------- 6. player + recording
function playerHtml(film) {
  return readFileSync(join(HERE, 'player.html'), 'utf8').replace('/*FILM*/null', JSON.stringify(film).replace(/</g, '\\u003c'));
}
// Frame by frame: render(t) for every 1/30 s, screenshot, pipe to ffmpeg. Exact timing, no screen-recorder blur.
async function record(pw, film, o) {
  writeFileSync(join(o.out, 'player.html'), playerHtml(film));
  const b = await pw.chromium.launch();
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(join(o.out, 'player.html')).href);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); });
  if (errors.length || !(await page.evaluate(() => typeof window.render === 'function'))) { await b.close(); fail(`player.html failed to load: ${errors.join('; ') || 'no render()'}`); }
  return { page, close: () => b.close() };
}

function srtTime(t) {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

async function assemble(film, rec, o) {
  const mp4 = join(o.out, 'jurator-demo.mp4'), fps = 30, frames = Math.ceil(film.total * fps);
  const inputs = ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
  const filters = [], labels = [];
  film.scenes.forEach((s, i) => {
    if (!s.audioPath) return;
    inputs.push('-i', s.audioPath);
    const ms = Math.round((s.start + film.voiceLead) * 1000);
    filters.push(`[${labels.length + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const args = ['-y', '-loglevel', 'error', ...inputs];
  if (labels.length) {
    // YouTube: 48 kHz stereo AAC, loudness near its -14 LUFS playback target.
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '320k', '-ac', '2', '-ar', '48000');
  }
  args.push('-t', film.total.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation', '-profile:v', 'high', '-g', '15', '-bf', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const exited = new Promise((ok) => ff.on('close', ok));
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    await rec.page.evaluate((t) => window.render(t), f / fps);
    const jpg = await rec.page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise((ok) => ff.stdin.once('drain', ok));
    if (f % 300 === 0) log(`frame ${f}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  const code = await exited;
  await rec.close();
  if (code !== 0) fail(`ffmpeg failed:\n${err}`);
  return mp4;
}

// ---------------------------------------------------------------- YouTube package
// Chapters: YouTube needs the first at 0:00, at least three, each 10 s or longer; short groups merge into the one before.
function chapters(film) {
  const out = [];
  for (const s of film.scenes) if (s.chapter && s.chapter !== out.at(-1)?.title) out.push({ title: s.chapter, start: s.start });
  out[0].start = 0;
  const end = (k) => out[k + 1]?.start ?? film.total;
  for (let k = out.length - 1; k > 0; k--) if (end(k) - out[k].start < 10) out.splice(k, 1);
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return out.map((c) => `${mmss(c.start)} ${c.title}`).join('\n');
}
function youtube(film) {
  const c = film.cost;
  if (film.corvane) return youtubeCorvane(film);
  return `# YouTube upload

Upload jurator-demo.mp4, set thumbnail.jpg as the thumbnail, and add captions.srt under Subtitles (English).
Not made for kids. Check the hackathon rules for the visibility it needs (public or unlisted).

## Title

Praesidia.ai: proof for what AI agents do (Jurator + Investigator on Meta Muse) | Meta AI Developer Hackathon

## Description

Coding agents change code and run work faster than anyone can check it. Praesidia.ai gives proof for what AI agents
do, built on Meta's Muse models (Meta Responses API):

- Jurator turns written policies into numbered promises with exact quotes. Muse Wonder writes a rule for each promise,
  and Jurator keeps a rule only after proving it can fail. The rules then check every change with no AI: in the
  coding agent and on git push. You can also ask it questions (jurator discuss, read-only).
- Investigator tests at runtime whether revoked agent work really stops, using destination receipts, a bounded
  repair and a re-test.

${film.tiles ? `In this film Jurator runs live (muse-wonder-1.0) on Praesidia's own five repositories and three real policies: our privacy policy, our security page, and the rules our AI coding agents follow. Measured: compile ${c.compile}, rules ${c.rules}, a check of all five repos ${c.check}. The agent's change in our backend was staged on a branch for the demo; it was never merged.` : film.live ? `Everything on screen is one live take with muse-wonder-1.0. Measured on this take: compile ${c.compile}, rules ${c.rules}, first check ${c.check}.` : 'This cut is a scripted rehearsal: the model answers are recorded, not live.'}
The agent's hook call is simulated and labelled so on screen. The Investigator segment is a previously recorded live run.

${chapters(film)}

https://praesidia.ai · code: https://${film.repo}
Built with Meta Muse models; not a Meta product.

## Tags

Meta AI, Muse, Meta Responses API, AI agents, coding agents, policy as code, compliance, privacy, AI safety, hackathon
`;
}

function youtubeCorvane(film) {
  const c = film.cost, v = film.corvane;
  return `# YouTube upload

Upload jurator-demo.mp4, set thumbnail.jpg as the thumbnail, and add captions.srt under Subtitles (English).
Not made for kids. Check the hackathon rules for the visibility it needs (public or unlisted).

## Title

Praesidia: Jurator + Investigator, proof for what AI agents do (on Meta Muse) | Meta AI Developer Hackathon

## Description

Coding agents change code and run work faster than anyone can check it. Praesidia gives proof for what AI agents do,
built on Meta's Muse models through the Meta Responses API.

- Jurator turns written policies into numbered promises with exact quotes, finds contradictions between policies with
  no AI, and has Muse Wonder write a rule for each promise. A rule is kept only after Jurator proves it fails when the
  guarded code is removed. The rules then check every change with no AI: in the coding agent's hook and on git push.
  Explain, verify, report, and a read-only discuss command show why.
- Investigator tests at runtime whether revoked agent work really stops: a live experiment, a bounded repair and a
  re-test, with the evidence saved.

In this film Jurator runs live (muse-wonder-1.0) on Corvane, a fictional fintech: ${v.repos} repositories and ${v.policies} written
policies, giving ${v.promises} promises and ${v.rules} proven rules. Measured on this take: compile ${c.compile}, writing and proving the
rules ${c.rules}, bind ${c.bind}, a check of all repositories ${c.check}; every git push check after that is rules only and costs $0.
The AI coding agent's branch was written for the demo. The Muse Code hook call is simulated (the JSON event is typed by the script) and labelled so on screen.
Also shown: jurator promises --for, rule test, the MCP server for coding agents (tools/list), doctor${v.bench ? `, and bench on planted breaks (${v.bench})` : ''}.
Beyond code: policy sources are files or a recorded Praesidia agent policy export; rules can check code, config and infrastructure-as-code in the repos; results go to the git pre-push hook, the Muse Code hook, the MCP server, or JSON/Markdown with exit codes for scripts.
The first Investigator segment is a live run against a small workflow it builds for the experiment; live runs can differ.
${v.invLive ? 'The other Investigator demos are live runs too.' : 'The other Investigator demos (demo, repair-demo, evidence-demo, assurance-demo) are scripted runs on authored workloads (no model calls), labelled so on screen.'}

${chapters(film)}

Code: https://${film.repo}
Built with Meta Muse models; not a Meta product. Corvane and its people are fictional.

## Tags

Meta AI, Muse, Meta Responses API, AI agents, coding agents, policy as code, compliance, privacy, AI safety, hackathon
`;
}

// ---------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  for (const bin of ['ffmpeg', 'ffprobe', ...(o.voice === 'say' && !o.narration ? ['say'] : [])]) if (run('which', [bin]).status !== 0) fail(`${bin} is not on PATH (brew install ffmpeg)`);
  if (!existsSync(join(JURATOR, 'dist/bin.js'))) fail('build jurator first: npm run build');
  mkdirSync(o.out, { recursive: true });
  const pw = await import(pathToFileURL(PLAYWRIGHT).href).catch(() => fail(`Playwright not found at ${PLAYWRIGHT} (set PLAYWRIGHT_MODULE)`));

  if (o.corvane) { o.take = o.corvane; o.investigator = false; }
  const takeFile = o.take || captureTake(o);
  if (o.take) copyFileSync(o.take, join(o.out, 'take.typescript'));
  if (o.dogfood) copyFileSync(o.dogfood, join(o.out, 'dogfood.typescript'));
  // The dogfood blocks follow the demo take's blocks; story() looks them up after the demo's last block.
  const take = parseTake(readFileSync(takeFile, 'utf8') + (o.dogfood ? '\n' + readFileSync(o.dogfood, 'utf8') : ''));
  if (o.live && take.differences) log(`\x1b[33mwarning: the live take printed ${take.differences} differences from the script; review before using it\x1b[39m`);
  const { scenes, live, cost, tiles, corvane } = story(take, o);
  narrate(scenes, o);

  // Timing: each scene lasts its narration plus room to read; terminal scenes get a beat for the typed command.
  const voiceLead = 0.35;
  let t = 0;
  for (const s of scenes) {
    const min = (corvane ? { intro: 9.5, hero: 5.5, title: 7, meta: 10, term: 5, reach: 9, end: 9 } : { hero: 7, title: 9, meta: 12, stats: 8, term: 6.5, investigator: 20, end: 9 })[s.kind];
    const tail = s.kind === 'end' ? 2.5 : s.kind === 'term' ? 1.4 : 1.0;
    s.duration = Math.max(min, voiceLead + s.voiceSec + tail);
    if (corvane && s.kind === 'term') { // let the focus walk finish: same schedule as buildTerm in player.html
      const rows = s.blocks.reduce((n, bi) => n + take.blocks[bi].lines.length + 1, 0);
      const typed = s.blocks.reduce((n, bi) => n + (take.blocks[bi].comment ? 0 : Math.min(1.6, take.blocks[bi].cmd.length / 42) + .25), .35);
      s.duration = Math.max(s.duration, typed + Math.min((3.2 + rows * .02) * .55, s.duration * .42) + .2 + (s.focus?.length || 0) * 1.1 + .9);
    }
    s.start = t; t += s.duration;
  }
  const blocks = take.blocks.map((b) => ({ cmd: b.cmd, comment: b.comment, html: b.lines.map(ansiToHtml), text: b.lines.map(strip) }));
  const film = {
    live, total: t, voiceLead, repo: REPO_URL, cost, tiles, corvane, plainBrand: Boolean(corvane), header: take.header,
    images: o.investigator && existsSync(REPORT) ? await investigatorStills(pw, o) : [],
    scenes: scenes.map(({ audio, ...s }) => ({ ...s, audio: Boolean(audio) })), blocks,
  };
  film.scenes.forEach((s, i) => { s.audioPath = scenes[i].audio; });
  writeFileSync(join(o.out, 'film.json'), JSON.stringify({ ...film, blocks: undefined, takeBlocks: blocks.length }, null, 2));
  if (process.env.FILM_FULL_JSON) writeFileSync(process.env.FILM_FULL_JSON, JSON.stringify(film)); // for frame previews of player.html
  writeFileSync(join(o.out, 'captions.srt'), film.scenes.map((s, i) =>
    `${i + 1}\n${srtTime(s.start + voiceLead)} --> ${srtTime(s.start + voiceLead + s.voiceSec)}\n${s.voice}\n`).join('\n'));
  writeFileSync(join(o.out, 'narration.md'), `# Narration (${live ? 'live take' : 'scripted rehearsal'})\n\nRecord each line as scene-NN.wav and re-run with --narration <dir> --take ${join(o.out, 'take.typescript')}.\n\n` +
    film.scenes.map((s, i) => `- **scene-${String(i + 1).padStart(2, '0')}** (${s.chip}, ${s.duration.toFixed(1)}s): ${s.voice}`).join('\n') + '\n');
  log(`${film.scenes.length} scenes, ${t.toFixed(1)}s total${t > 180 ? ' \x1b[31m(over 3:00 — shorten narration or raise --rate)\x1b[39m' : ''}`);

  if (o.plan) { film.scenes.forEach((s) => log(`${s.start.toFixed(1).padStart(6)} ${s.duration.toFixed(1).padStart(5)}  ${s.chip}`)); return; }
  const rec = await record(pw, { ...film, scenes: film.scenes.map(({ audioPath, ...s }) => s) }, o);
  const mp4 = await assemble(film, rec, o);
  run('ffmpeg', ['-y', '-ss', String(Math.min(4, scenes[0].duration - 1)), '-i', mp4, '-frames:v', '1', join(o.out, 'poster.png')]);
  if (o.corvane) await thumbnail(pw, o); // designed card; its strings come from the Corvane take
  else run('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(o.out, 'poster.png'), '-vf', 'scale=1280:720', '-q:v', '2', join(o.out, 'thumbnail.jpg')]);
  writeFileSync(join(o.out, 'youtube.md'), youtube(film));
  log(`done: ${mp4} (${probe(mp4).toFixed(1)}s) · captions.srt · narration.md · poster.png · thumbnail.jpg · youtube.md`);
  if (!live) log('\x1b[33mscripted rehearsal: the film says so on screen; re-run with --live for the submission take\x1b[39m');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => fail(e.stack || String(e)));
