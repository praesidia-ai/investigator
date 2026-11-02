import type { EvidenceStore } from './evidence-store.js';
import { jsonDigest } from './json.js';
import { parseInput } from './parse.js';
import { jsonValueSchema, type ControlCase } from './schemas.js';

export function controlCaseCommitment(controlCase: ControlCase): string {
  return jsonDigest(parseInput(jsonValueSchema, controlCase, 'INVALID_CASE', 'Control case'));
}

/** Commits the declared input snapshots, including capture/coverage metadata, before tools run. */
export function inputEvidenceCommitment(controlCase: ControlCase, evidence: EvidenceStore): string {
  const metadata = controlCase.sources.map((source) => {
    const { content: _content, ...artifact } = evidence.get(source.id);
    return artifact;
  });
  return jsonDigest(parseInput(jsonValueSchema, metadata, 'INVALID_EVIDENCE', 'Input evidence'));
}
