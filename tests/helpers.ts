import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalCase } from '../src/connectors/local-bundle.js';
import { controlCaseSchema, type ReferenceVariant } from '../src/core/schemas.js';

export const EXAMPLE_DIRECTORY = fileURLToPath(
  new URL('../examples/customer-export/', import.meta.url),
);

export async function referenceCase(variant: ReferenceVariant = 'request-unbound') {
  const bundle = await loadLocalCase(EXAMPLE_DIRECTORY);
  bundle.controlCase.referenceTarget = { kind: 'customer-export-reference', variant };
  return bundle;
}

export async function temporaryCase() {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-case-'));
  const manifest = controlCaseSchema.parse(
    JSON.parse(await readFile(join(EXAMPLE_DIRECTORY, 'case.json'), 'utf8')) as unknown,
  );
  for (const source of manifest.sources)
    await writeFile(
      join(directory, source.path),
      await readFile(join(EXAMPLE_DIRECTORY, source.path)),
    );
  const save = async () => writeFile(join(directory, 'case.json'), JSON.stringify(manifest));
  await save();
  return { directory, manifest, save };
}

/** Test-only: CLI io that captures stdout and stderr chunks separately. */
export function output() {
  const stdout: string[] = [],
    stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}
