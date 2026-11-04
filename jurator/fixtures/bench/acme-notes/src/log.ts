const SECRET_KEYS = ['password', 'cardNumber', 'cvc'];

/** Structured logger that drops secret fields before writing. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => !SECRET_KEYS.includes(key)));
  process.stdout.write(`${JSON.stringify({ event, ...safe })}\n`);
}
