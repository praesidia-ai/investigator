import type { IncomingMessage } from 'node:http';
import { decodeUtf8 } from '../io/read-file.js';
import { InvestigatorError } from './errors.js';

const MAX_BODY_BYTES = 65_536;

export async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('size');
    chunks.push(bytes);
  }
  return decodeUtf8(Buffer.concat(chunks));
}

export interface ResponseErrors {
  readonly unavailable: readonly [code: string, message: string];
  readonly tooLarge: readonly [code: string, message: string];
}

export async function readResponseText(
  response: Response,
  errors: ResponseErrors,
): Promise<string> {
  if (!response.ok || !response.body) throw new InvestigatorError(...errors.unavailable);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new InvestigatorError(...errors.tooLarge);
      chunks.push(item.value);
    }
    return decodeUtf8(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
