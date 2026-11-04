import { describe, expect, it } from 'vitest';
import { detectCaps } from '../../src/ui/caps.js';

const tty = { isTTY: true, columns: 100, rows: 30, write: () => true };
const pipe = { isTTY: false, write: () => true };

describe('detectCaps', () => {
  it('is live with colour on a terminal', () => {
    const c = detectCaps({ stream: tty, env: { TERM: 'xterm-256color' }, argv: [] });
    expect(c).toMatchObject({ live: true, color: '256', unicode: true, animate: true, width: 100, height: 30, verbose: false });
  });
  it('is plain with no colour in a pipe, CI, NO_COLOR, --json and JURATOR_PLAIN=1', () => {
    expect(detectCaps({ stream: pipe, env: {} })).toMatchObject({ live: false, color: 'none', width: 80 });
    for (const env of [{ CI: 'true' }, { NO_COLOR: '' }, { JURATOR_PLAIN: '1' }]) {
      expect(detectCaps({ stream: tty, env })).toMatchObject({ live: false, color: 'none' });
    }
    expect(detectCaps({ stream: tty, env: {}, argv: ['--json'] })).toMatchObject({ live: false, color: 'none' });
  });
  it('picks the colour depth: truecolor, 256, 16; FORCE_COLOR colours plain output', () => {
    expect(detectCaps({ stream: tty, env: { COLORTERM: 'truecolor' } }).color).toBe('truecolor');
    expect(detectCaps({ stream: tty, env: { TERM: 'xterm' } }).color).toBe('16');
    expect(detectCaps({ stream: pipe, env: { FORCE_COLOR: '3' } })).toMatchObject({ live: false, color: 'truecolor' });
    expect(detectCaps({ stream: pipe, env: { FORCE_COLOR: '1', NO_COLOR: '1' } }).color).toBe('none');
  });
  it('reduced motion, ASCII and verbose', () => {
    expect(detectCaps({ stream: tty, env: { JURATOR_NO_ANIMATION: '1' } })).toMatchObject({ live: true, animate: false });
    expect(detectCaps({ stream: tty, env: { JURATOR_ASCII: '1' } }).unicode).toBe(false);
    expect(detectCaps({ stream: tty, env: { TERM: 'linux' } }).unicode).toBe(false);
    expect(detectCaps({ stream: tty, env: {}, argv: ['--verbose'] }).verbose).toBe(true);
  });
});
