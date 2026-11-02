import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { InvestigatorError } from '../core/errors.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { sha256 } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import { controlCaseSchema, type ControlCase, type EvidenceArtifact } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';

const MAX_ARTIFACT_BYTES = 1_048_576;
const MAX_CASE_BYTES = 65_536;
const MAX_BUNDLE_BYTES = 4_194_304;

async function readScopedFile(
  root: string,
  declaredPath: string,
  maxBytes: number,
): Promise<Buffer> {
  if (
    isAbsolute(declaredPath) ||
    declaredPath.includes('\\') ||
    declaredPath.split('/').some((part) => part === '..')
  ) {
    throw new InvestigatorError(
      'PATH_OUTSIDE_CASE',
      'Evidence paths must stay inside the selected case directory.',
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(join(root, declaredPath));
  } catch {
    throw new InvestigatorError('SOURCE_UNAVAILABLE', 'A declared case file is unavailable.');
  }
  const within = relative(root, resolved);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new InvestigatorError(
      'PATH_OUTSIDE_CASE',
      'An evidence link resolves outside the selected case directory.',
    );
  }
  return readBoundedFile(resolved, maxBytes);
}

export interface LocalCase {
  readonly controlCase: ControlCase;
  readonly evidence: EvidenceStore;
}

export async function loadLocalCase(
  directory: string,
  now: () => Date = () => new Date(),
): Promise<LocalCase> {
  const root = await realpath(directory).catch(() => {
    throw new InvestigatorError('CASE_NOT_FOUND', 'The selected case directory does not exist.');
  });
  const manifest = decodeUtf8(await readScopedFile(root, 'case.json', MAX_CASE_BYTES));
  const controlCase = parseInput(
    controlCaseSchema,
    parseJson(manifest),
    'INVALID_CASE',
    'Control case',
  );
  const artifacts: EvidenceArtifact[] = [];
  let totalBytes = 0;
  for (const source of controlCase.sources) {
    const bytes = await readScopedFile(root, source.path, MAX_ARTIFACT_BYTES);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES)
      throw new InvestigatorError(
        'BUNDLE_TOO_LARGE',
        'The selected evidence exceeds the bundle limit.',
      );
    const content = decodeUtf8(bytes);
    if (source.mediaType === 'application/json') parseJson(content, 'INVALID_EVIDENCE');
    artifacts.push({
      id: source.id,
      source: { kind: 'local-file', reference: source.path },
      mediaType: source.mediaType,
      capturedAt: now().toISOString(),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      content,
      coverage: source.coverage,
      redacted: source.redacted,
    });
  }
  return { controlCase, evidence: new EvidenceStore(artifacts) };
}
