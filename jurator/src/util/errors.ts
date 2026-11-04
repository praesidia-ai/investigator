/** Expected failures carry a stable code and a plain message; the CLI prints `CODE: message` and exits 2. */
export class JuratorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JuratorError';
    this.code = code;
  }
}
