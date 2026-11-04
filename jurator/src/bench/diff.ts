// Owner: FX-3. A small unified diff (line LCS) so the plain-prompt baseline sees what a reviewer sees. No dependency.

function lines(text: string): string[] {
  const out = text.split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

function ops(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]; files in the bench are small.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as number[];
    const below = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] as string, a: i, b: j });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) {
      // Deletions before insertions, like git.
      out.push({ kind: '-', text: a[i] as string, a: i, b: j });
      i += 1;
    } else {
      out.push({ kind: '+', text: b[j] as string, a: i, b: j });
      j += 1;
    }
  }
  return out;
}

/** `git diff`-style text for one file; '' when nothing changed. `before` null = a new file. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  if (before === after) return '';
  const all = ops(lines(before ?? ''), lines(after));
  const changed = all.map((o, k) => (o.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const header = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  const hunks: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, (changed[k] as number) - context);
    let end = Math.min(all.length - 1, (changed[k] as number) + context);
    while (k + 1 < changed.length && (changed[k + 1] as number) - context <= end + 1) {
      k += 1;
      end = Math.min(all.length - 1, (changed[k] as number) + context);
    }
    k += 1;
    const slice = all.slice(start, end + 1);
    const first = slice[0] as Op;
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...slice.map((o) => `${o.kind}${o.text}`));
  }
  return [...header, ...hunks].join('\n');
}
