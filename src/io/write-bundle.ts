import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvestigatorError } from '../core/errors.js';

/** Create a new private directory and write the files; any failure removes the directory. */
export async function writeBundle(
  directory: string,
  messages: { readonly unavailable: string; readonly failed: string },
  buildFiles: () => Record<string, string>,
): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(() => {
    throw new InvestigatorError('OUTPUT_UNAVAILABLE', messages.unavailable);
  });
  try {
    for (const [name, content] of Object.entries(buildFiles()))
      await writeFile(join(directory, name), content, {
        flag: 'wx',
        mode: 0o600,
        encoding: 'utf8',
      });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new InvestigatorError('OUTPUT_UNAVAILABLE', messages.failed);
  }
}
