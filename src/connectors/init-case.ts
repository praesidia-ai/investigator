import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import { controlCaseSchema } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { httpApprovalTargetConfigSchema } from '../targets/http-approval-target.js';
import { loadLocalCase } from './local-bundle.js';

/** Scaffolding reads configuration only; it never contacts or executes a target. */
export async function initializeControlCase(directory: string, targetConfigPath: string) {
  const config = parseInput(
    httpApprovalTargetConfigSchema,
    parseJson(decodeUtf8(await readBoundedFile(targetConfigPath, 65_536))),
    'INVALID_TARGET_CONFIG',
    'HTTP target configuration',
  );
  const example = fileURLToPath(new URL('../../examples/customer-export/', import.meta.url));
  const bundle = await loadLocalCase(example);
  const controlCase = structuredClone(bundle.controlCase);
  delete controlCase.referenceTarget;
  controlCase.id = `case-${randomUUID()}`;
  controlCase.subject = {
    id: 'operator-selected-export-service',
    environment: 'repository',
    revision: config.subjectRevision,
  };
  controlCase.controlledTarget = {
    kind: config.kind,
    version: 1,
    configurationDigest: jsonDigest(config),
  };
  const parsed = parseInput(controlCaseSchema, controlCase, 'INVALID_CASE', 'Initialized case');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new InvestigatorError('OUTPUT_UNAVAILABLE', 'Choose a new available case directory.');
  }
  for (const source of parsed.sources)
    await copyFile(join(example, source.path), join(directory, source.path));
  await writeFile(join(directory, 'case.json'), `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return parsed;
}
