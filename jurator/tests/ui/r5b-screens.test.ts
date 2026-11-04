// R5-B: compact id lists (compile "new:", accept) and a live view that can clear without a summary (check).
import { describe, expect, it } from 'vitest';
import { createLive } from '../../src/ui/live.js';
import { idRange, stripAnsi } from '../../src/ui/text.js';

describe('idRange', () => {
  const docs = Array.from({ length: 32 }, (_, i) => `documents.${String(i + 1).padStart(2, '0')}`);
  it('32 consecutive ids become one range', () => {
    expect(idRange(docs)).toBe('documents.01 to documents.32');
  });
  it('short lists stay as they are; gaps and sources split the ranges', () => {
    expect(idRange(['privacy.01', 'security.01'])).toBe('privacy.01 security.01');
    expect(idRange(['privacy.01', 'privacy.02', 'privacy.03', 'privacy.04', 'security.01', 'security.03'])).toBe(
      'privacy.01 to privacy.04, security.01, security.03',
    );
    expect(idRange(['a.01', 'a.02', 'b.01', 'b.02'])).toBe('a.01 a.02, b.01 b.02');
  });
  it('many ranges: the first two and a count', () => {
    const odd = Array.from({ length: 10 }, (_, i) => `x.${String(i * 2 + 1).padStart(2, '0')}`);
    expect(idRange(odd)).toBe('x.01, x.03 and 8 more');
  });
});

describe('live finish quiet', () => {
  it('in plain mode prints nothing but still returns the summary', () => {
    const lines: string[] = [];
    const live = createLive({ title: 'check', unit: 'steps', env: { CI: 'true' }, write: (l) => lines.push(l) });
    live.add('rules');
    live.done('rules');
    const before = lines.length;
    const summary = live.finish({ keep: 'none', quiet: true });
    expect(lines.length).toBe(before);
    expect(stripAnsi(summary[0] ?? '')).toMatch(/check {2}1\/1 steps/u);
  });
  it('in live mode clears the area, shows the cursor again and prints no summary', () => {
    const chunks: string[] = [];
    const tty = { isTTY: true, columns: 80, rows: 24, write: (s: string) => chunks.push(s) };
    const live = createLive({ title: 'check', unit: 'steps', stream: tty as never, env: { TERM: 'xterm-256color' }, timer: false });
    live.add('rules');
    live.done('rules');
    live.render();
    chunks.length = 0;
    live.finish({ keep: 'none', quiet: true });
    const written = chunks.join('');
    expect(written).toContain('\u001b[?25h');
    expect(stripAnsi(written)).not.toMatch(/1\/1 steps/u);
  });
});
