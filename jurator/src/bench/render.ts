// Owner: FX-3. Text table for `jurator bench` (the JSON is the BenchReport itself).
import { formatUsd } from '../model/cost.js';
import { showEdit } from '../rules/redteam.js';
import { BRAND } from '../brand.js';
import type { BenchReport, MethodScore } from './run.js';

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function cell(m: MethodScore, caseId: string, kind: 'break' | 'harmless'): string {
  const c = m.cases.find((x) => x.caseId === caseId);
  if (!c) return '-';
  const mark = c.errors > 0 ? '*' : '';
  if (kind === 'break') return `${c.caught ? 'caught' : 'missed'}${c.wrongFlags.length > 0 ? '+' : ''}${mark}`;
  return `${c.falseAlarm ? 'FALSE ALARM' : 'quiet'}${mark}`;
}

function colName(m: MethodScore): string {
  if (m.method.kind === 'rules') return 'Rules';
  const model = (m.method.model ?? '').replace(/^muse-/u, '').replace(/-[0-9.]+$/u, '');
  const name = model ? model[0]?.toUpperCase() + model.slice(1) : '';
  if (m.method.kind === 'ai-read') return `AI ${name}`;
  if (m.method.kind === 'plain') return `Plain ${name}`;
  return `${BRAND.name}`;
}

export function renderBenchText(report: BenchReport): string {
  const breaks = report.cases.filter((c) => c.kind === 'break').length;
  const harmless = report.cases.length - breaks;
  const out: string[] = [];
  out.push(
    `Bench: ${report.repo} @ ${report.commit.slice(0, 7)} · ${breaks} planted break${breaks === 1 ? '' : 's'}, ${harmless} harmless change${harmless === 1 ? '' : 's'} · ${report.mode}`,
    '',
  );
  const w = Math.max(28, ...report.methods.map((m) => m.method.label.length + 2));
  out.push(
    `${pad('Method', w)}${pad('Catches', 9)}${pad('False alarms', 14)}${pad('Wrong flags', 13)}${pad('Old flags', 11)}${pad('Calls', 7)}Cost`,
  );
  for (const m of report.methods) {
    out.push(
      `${pad(m.method.label, w)}${pad(`${m.catches}/${m.breaks}`, 9)}${pad(`${m.falseAlarms}/${m.harmless}`, 14)}${pad(String(m.wrongFlags), 13)}${pad(String(m.baselineFlags.length), 11)}${pad(String(m.calls), 7)}${formatUsd(m.usd)}${m.errors > 0 ? ` (${m.errors} failed or skipped)` : ''}`,
    );
  }
  out.push(
    '  Catches: planted breaks flagged on the right promise. False alarms: harmless changes with any new flag.',
    '  Wrong flags: new flags on promises the change does not break. Old flags: promises already flagged on the',
    '  unchanged code; they are not counted against a change.',
  );
  for (const m of report.methods.filter((x) => x.baselineFlags.length > 0)) {
    out.push(`  Old flags, ${m.method.label}: ${m.baselineFlags.join(', ')}`);
  }
  out.push('');
  const cols = report.methods.map((m) => colName(m));
  const cw = Math.max(13, ...cols.map((c) => c.length + 2));
  const labels = report.cases.map((c) => short(`${c.id} ${c.title}`, 52));
  const lw = Math.max(6, ...labels.map((l) => l.length + 2));
  out.push(`${pad('Case', lw)}${cols.map((c) => pad(c, cw)).join('')}`.trimEnd());
  report.cases.forEach((c, i) => {
    out.push(`${pad(labels[i] ?? c.id, lw)}${report.methods.map((m) => pad(cell(m, c.id, c.kind), cw)).join('')}`.trimEnd());
  });
  out.push("  caught = flagged the promise the change breaks · + = also a new flag on a promise it doesn't break · * = a call failed or was skipped");

  if (report.redteam) {
    const reps = report.redteam.reports;
    const weak = reps.filter((r) => r.verdict === 'weak');
    out.push(
      '',
      `Red team (attacker ${report.redteam.attacker}${report.redteam.judge ? `, judge ${report.redteam.judge}` : ', no judge'}): ${weak.length} of ${reps.length} rule${reps.length === 1 ? '' : 's'} weak`,
    );
    for (const r of reps) {
      out.push(`  ${pad(r.verdict, 7)}${pad(r.ruleId, 18)}${short(r.message.replace(`${r.ruleId} `, ''), 150)}`);
      for (const a of r.attempts.filter((x) => x.rule === 'missed' && x.judge === 'breaks')) {
        out.push(`         evasion: ${short(showEdit(a.edit, 100), 140)}`);
        if (a.judgeNote) out.push(`         judge: ${short(a.judgeNote, 140)}`);
      }
    }
  }

  out.push('');
  const by = report.costByModel.map((m) => `${m.model} ${formatUsd(m.usd)} in ${m.calls} call${m.calls === 1 ? '' : 's'}`).join(' · ');
  out.push(
    `Cost: ${formatUsd(report.costUsd)}${by ? ` (${by})` : ''} · budget ${formatUsd(report.budgetUsd)}${report.skippedForBudget > 0 ? ` · ${report.skippedForBudget} skipped for budget` : ''}`,
  );
  if (report.mode === 'offline') out.push(`Next: set META_API_KEY (or pass --scripted <dir>) to add the AI rows.`);
  else out.push(`Next: ${BRAND.command} bench --json > bench.json to keep the full record.`);
  return out.join('\n');
}
