import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { InvestigatorError } from '../core/errors.js';

/** Bounded reads avoid following final symlinks or blocking on devices/FIFOs. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new InvestigatorError(
      'SOURCE_UNAVAILABLE',
      'The selected file could not be opened safely.',
    );
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new InvestigatorError('INVALID_SOURCE', 'Sources must be regular files.');
    if (stat.size > maxBytes)
      throw new InvestigatorError('SOURCE_TOO_LARGE', 'The selected file exceeds its size limit.');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes)
        throw new InvestigatorError(
          'SOURCE_TOO_LARGE',
          'The selected file exceeds its size limit.',
        );
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvestigatorError(
      'INVALID_ENCODING',
      'Evidence and case files must contain valid UTF-8 text.',
    );
  }
}
