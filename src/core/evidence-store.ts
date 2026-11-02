import { InvestigatorError } from './errors.js';
import { sha256 } from './json.js';
import { parseInput } from './parse.js';
import { evidenceArtifactSchema, type EvidenceArtifact } from './schemas.js';

export type EvidenceMetadata = Omit<EvidenceArtifact, 'content'>;

/** Owns immutable snapshots; callers cannot edit the bytes a citation refers to. */
export class EvidenceStore {
  readonly #artifacts = new Map<string, EvidenceArtifact>();

  constructor(artifacts: readonly EvidenceArtifact[] = []) {
    for (const artifact of artifacts) this.add(artifact);
  }

  add(input: EvidenceArtifact): void {
    const artifact = parseInput(
      evidenceArtifactSchema,
      input,
      'INVALID_EVIDENCE',
      'Evidence artifact',
    );
    if (this.#artifacts.has(artifact.id))
      throw new InvestigatorError('DUPLICATE_EVIDENCE', 'Evidence IDs must be unique.');
    if (
      sha256(artifact.content) !== artifact.sha256 ||
      Buffer.byteLength(artifact.content, 'utf8') !== artifact.byteLength
    ) {
      throw new InvestigatorError(
        'EVIDENCE_CHANGED',
        'Evidence bytes do not match their recorded digest or length.',
      );
    }
    this.#artifacts.set(
      artifact.id,
      Object.freeze({ ...artifact, source: Object.freeze({ ...artifact.source }) }),
    );
  }

  get(id: string): EvidenceArtifact {
    const artifact = this.#artifacts.get(id);
    if (!artifact)
      throw new InvestigatorError(
        'EVIDENCE_NOT_FOUND',
        'The requested evidence is not part of this case.',
      );
    return artifact;
  }

  list(): EvidenceMetadata[] {
    return this.all().map(({ content: _content, ...metadata }) => metadata);
  }

  all(): EvidenceArtifact[] {
    return [...this.#artifacts.values()];
  }
}
