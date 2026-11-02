export class InvestigatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InvestigatorError';
  }
}

/** Do not expose upstream response bodies, URLs, headers or arbitrary thrown values. */
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof InvestigatorError
    ? { code: error.code, message: error.message }
    : {
        code: 'UNEXPECTED_ERROR',
        message: 'The operation failed; no successful result was recorded.',
      };
}
