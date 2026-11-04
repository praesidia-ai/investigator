import { describe, expect, it } from 'vitest';
import { duration, fit, money, sanitize, stripAnsi, truncate, width, wrap } from '../../src/ui/text.js';

const RED = (s: string): string => `\u001b[31m${s}\u001b[39m`;

describe('width', () => {
  it('ignores colour codes and counts wide characters as two', () => {
    expect(width(RED('abc'))).toBe(3);
    expect(width('日本')).toBe(4);
    expect(width('é')).toBe(1);
  });
});

describe('truncate', () => {
  it('cuts to the width with an ellipsis and keeps short text as is', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello', 8)).toBe('hello');
    expect(width(truncate('日本語のテキスト', 7))).toBeLessThanOrEqual(7);
  });
  it('keeps colour codes and closes a span it cut', () => {
    const cut = truncate(RED('hello world'), 6);
    expect(stripAnsi(cut)).toBe('hello…');
    expect(cut.endsWith('\u001b[0m…')).toBe(true);
  });
  it('fits exactly', () => {
    expect(fit('ab', 4)).toBe('ab  ');
    expect(fit('ab', 4, 'right')).toBe('  ab');
    expect(fit('abcdef', 4)).toBe('abc…');
  });
});

describe('wrap', () => {
  it('folds at spaces and breaks a long word hard', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('(?i)(openai|anthropic)', 10)).toEqual(['(?i)(opena', 'i|anthropi', 'c)']);
  });
  it('limits the number of lines, ending in an ellipsis', () => {
    const lines = wrap('a b c d e f g h i j k l m n o p', 5, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
  });
});

describe('sanitize', () => {
  it('drops cursor moves, titles, controls and bidi overrides but keeps colour', () => {
    const evil = `a\u001b[2Jb\u001b]0;title\u0007c\u0008d‮e${RED('f')}`;
    expect(sanitize(evil)).toBe(`abcde${RED('f')}`);
    expect(sanitize('x\ty\nz', true)).toBe('x  y z');
  });
});

describe('money and duration', () => {
  it('formats', () => {
    expect(money(1.3249)).toBe('$1.32');
    expect(money(0.0042)).toBe('$0.0042');
    expect(duration(850)).toBe('850ms');
    expect(duration(8250)).toBe('8.2s');
    expect(duration(72_000)).toBe('1m 12s');
    expect(duration(3_780_000)).toBe('1h 03m');
  });
});
