import { join } from 'node:path';
import { loadLocalCase } from '../connectors/local-bundle.js';
import { parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { createClientSystemSnapshot } from './project.js';

/** Load an operator-selected context manifest and the case's existing scoped evidence bundle. */
export async function loadClientContext(directory: string) {
  const bundle = await loadLocalCase(directory);
  const input = parseJson(
    decodeUtf8(await readBoundedFile(join(directory, 'context.json'), 1_048_576)),
    'INVALID_CLIENT_CONTEXT',
  );
  return { ...bundle, snapshot: createClientSystemSnapshot(input, bundle.evidence) };
}
