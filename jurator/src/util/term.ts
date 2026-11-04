/** Terminal styling: colour only on a real terminal, never in CI logs, pipes or --json output. */
export interface Style {
  readonly color: boolean;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}
export function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    color,
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}
export function wantsColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined || env.CI !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return Boolean(stream.isTTY);
}
