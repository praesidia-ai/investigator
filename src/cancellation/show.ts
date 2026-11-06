import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { verifyCancellationCase, type CancellationCase } from './report.js';

type Run = CancellationCase['before'];
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Read-only terminal presentation of a saved cancellation case; every figure comes from the record. */
export async function showCancellationCase(path: string, color: boolean): Promise<string> {
  const file = (await stat(path)).isDirectory() ? join(path, 'case.json') : path;
  const raw = parseJson(
    decodeUtf8(await readBoundedFile(file, 20_971_520)),
    'INVALID_CANCELLATION_CASE',
  );
  let consistent = true;
  try {
    verifyCancellationCase(raw);
  } catch {
    consistent = false;
  }
  const c = raw as CancellationCase;
  const paint = (code: number) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const [bold, dim, red, green, yellow] = [1, 2, 31, 32, 33].map(paint) as [
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
  ];
  const verdict = (v: string | undefined) =>
    v === 'supported' ? green(v) : v === 'contradicted' ? red(v) : yellow(v ?? 'unresolved');
  const head = (t: string) => `\n${bold(`== ${t} ==`)}`;
  const secs = (r: Run) => ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1);
  const L: string[] = [];

  const b = c.before;
  const reads = b.events.filter((e) => e.tool === 'read_evidence').length;
  L.push(bold('Investigator: saved cancellation case'));
  L.push(`Subject  ${c.before.assessment.profileId}  revision ${b.subjectRevision.slice(0, 12)}`);
  L.push(`Model    ${b.provider.model} (${b.provider.id}), mode: ${b.provider.mode}`);
  L.push(
    `Run      ${b.events.length} tool calls, ${reads} file reads, ${b.captures.length} experiments, ${secs(b)} s wall`,
  );

  L.push(head('Model investigation (before repair)'));
  const picks = [...b.events.slice(0, 3), ...b.events.filter((e) => e.tool === 'run_experiment')];
  for (const e of picks.slice(0, 8))
    L.push(
      `  #${String(e.sequence).padStart(2)} ${e.tool}${e.experimentId ? ` ${e.experimentId}` : ''}${
        e.citation ? ` ${cut(e.citation.evidenceId, 50)}` : ''
      }`,
    );
  L.push(dim(`  … ${b.events.length - Math.min(picks.length, 8)} more`));

  L.push(head('Experiments (before)'));
  const status = new Map(b.assessment.checks.map((k) => [k.experimentId, k.status]));
  for (const x of b.captures) {
    const s = status.get(x.experimentId);
    const seq = [
      x.cut ? `revoke ack #${x.cut.ackSequence}` : null,
      ...x.attempts.map(
        (a) =>
          `enqueue #${a.enqueueSequence}${a.dispatchSequence ? `, dispatch #${a.dispatchSequence}` : ''}`,
      ),
      ...x.effects.map((f) => `accepted #${f.acceptSequence}`),
    ].filter(Boolean);
    L.push(
      `  ${s === 'PASS' ? green('PASS') : red(String(s))} ${x.experimentId} ${dim(`[${x.observation.status}]`)}`,
    );
    L.push(`       ${seq.join(' > ') || 'no destination activity'}`);
  }

  L.push(head('Verdict BEFORE'));
  L.push(`  ${verdict(b.finding?.verdict)}  ${cut(b.finding?.statement ?? 'no finding', 92)}`);
  const fail = b.assessment.checks.find((k) => k.status !== 'PASS');
  if (fail) L.push(`  ${dim(cut(fail.reason, 96))}`);

  L.push(head('Repair'));
  L.push(`  recipe ${c.change?.recipe ?? 'none'}  status ${c.repair.status}`);
  const diff = (c.change?.diff ?? '').trimEnd().split('\n');
  for (const l of diff.slice(0, 10))
    L.push(
      `  ${l.startsWith('+') && !l.startsWith('+++') ? green(l) : l.startsWith('-') && !l.startsWith('---') ? red(l) : dim(l)}`,
    );
  if (diff.length > 10) L.push(dim(`  … ${diff.length - 10} more diff lines`));

  L.push(head('Retest AFTER'));
  const a = c.after;
  if (a) {
    const ok = a.assessment.checks.filter((k) => k.status === 'PASS').length;
    L.push(
      `  ${verdict(a.finding?.verdict)}  ${ok}/${a.assessment.checks.length} checks passed, ${a.events.length} tool calls, ${secs(a)} s, mode: ${a.provider.mode}`,
    );
  } else L.push('  not assessed');

  L.push(head('Preserved work'));
  const v = c.verification;
  const flag = (ok: boolean, t: string) => `  ${ok ? green('yes') : red('NO ')} ${t}`;
  L.push(
    flag(v.independentWorkBefore && v.independentWorkAfter, 'independent root work still accepted'),
  );
  L.push(flag(v.preCutWorkPreserved, 'pre-revocation accepted work preserved'));
  L.push(flag(v.contentCanaryAbsent, 'content canary absent from destination'));
  L.push(flag(v.closedGap, 'gap closed after repair'));
  L.push(flag(v.unchangedWorkload, 'workload unchanged between runs'));

  L.push(head('Integrity'));
  L.push(
    `  case digest ${c.digest.slice(0, 16)}…  before ${b.digest.slice(0, 12)}…${a ? `  after ${a.digest.slice(0, 12)}…` : ''}`,
  );
  L.push(
    consistent
      ? `  ${green('records consistent')}; authorship not established, observations not re-executed`
      : `  ${red('RECORDS INCONSISTENT')}`,
  );
  L.push(dim('  re-check: investigator verify-cancellation <case.json>'));

  L.push(head('Scope'));
  L.push(`  ${v.scope}`);
  L.push(`  ${cut(c.limitations[0] ?? '', 96)}`);
  return `${L.join('\n')}\n`;
}
