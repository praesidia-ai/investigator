import type { CliOutput } from '../cli.js';

/** Print the shared outcome of a record verification that found the supplied records consistent. */
export function printRecordsConsistent(
  io: CliOutput,
  json: boolean | undefined,
  text: string,
): void {
  const result = {
    integrity: 'consistent-with-supplied-records',
    authenticity: 'not-established',
    execution: 'not-reexecuted',
  };
  io.stdout(json ? `${JSON.stringify(result)}\n` : text);
}
