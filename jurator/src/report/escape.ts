// Owner: X-FRONTEND. Policy and code text are untrusted: everything that reaches the page goes through esc().
const MAP: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML/SVG element content and double- or single-quoted attributes. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/gu, (ch) => MAP[ch] ?? ch);
}

/** A safe fragment id from any string (promise and rule ids are already safe; this is belt and braces). */
export function anchor(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '-');
}
