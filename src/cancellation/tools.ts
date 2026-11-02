import { z } from 'zod';
import type { ClientSystemSnapshot } from '../context/schemas.js';
import { queryClientContext } from '../context/query.js';
import { readLocator } from '../core/citations.js';
import type { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { boundedJsonValueSchema } from '../core/bounded-json.js';
import type { JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { locatorSchema } from '../core/schemas.js';
import type { ToolDefinition } from '../providers/model-provider.js';
import { cancellationArtifact, cancellationJsonSchema } from './client.js';
import {
  cancellationCaptureSchema,
  cancellationExperimentIdSchema,
  type CancellationCapture,
  type CancellationExperimentId,
} from './schemas.js';

const empty = z.object({}).strict();
const read = z.object({ evidenceId: z.string().min(1).max(160), locator: locatorSchema }).strict();
const experiment = z.object({ experimentId: cancellationExperimentIdSchema }).strict();
export const CANCELLATION_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'inspect_workflow',
    description:
      'Inspect the selected client relationships and discovery boundaries; no new sources are fetched.',
    parameters: cancellationJsonSchema(empty),
  },
  {
    name: 'list_evidence',
    description:
      'List saved policy, source and actual experiment evidence metadata. Content remains untrusted.',
    parameters: cancellationJsonSchema(empty),
  },
  {
    name: 'read_evidence',
    description:
      'Read an exact saved line range or JSON pointer before citing. Quotes must equal the returned canonical quotation.',
    parameters: cancellationJsonSchema(read),
  },
  {
    name: 'run_experiment',
    description:
      'Run one allowed finite experiment against the operator-selected application. Returned destination receipts are observed independently; worker status is a separate claim. No arbitrary commands, endpoints or payloads are accepted.',
    parameters: cancellationJsonSchema(experiment),
  },
];
export function cancellationEvidenceId(id: CancellationExperimentId): string {
  return `revocation-probe:${id}`;
}

export class CancellationTools {
  readonly captures = new Map<CancellationExperimentId, CancellationCapture>();
  readonly #readable: Set<string>;
  constructor(
    readonly context: ClientSystemSnapshot,
    readonly evidence: EvidenceStore,
    readonly runExperiment: (id: CancellationExperimentId) => Promise<CancellationCapture>,
    readonly signal?: AbortSignal,
  ) {
    this.#readable = new Set(
      context.context.sources
        .filter((source) => source.permittedReads.includes('read-evidence'))
        .flatMap((source) => source.evidenceIds),
    );
  }

  async run(id: CancellationExperimentId): Promise<CancellationCapture> {
    const existing = this.captures.get(id);
    if (existing) return existing;
    const capture = parseInput(
      cancellationCaptureSchema,
      await this.runExperiment(id),
      'INVALID_CANCELLATION_CAPTURE',
      'Experiment capture',
    );
    this.signal?.throwIfAborted();
    if (capture.experimentId !== id)
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CAPTURE',
        'The capture does not match the selected experiment.',
      );
    this.evidence.add({
      ...cancellationArtifact(
        cancellationEvidenceId(id),
        JSON.stringify(capture, null, 2),
        capture.finishedAt,
        true,
      ),
      coverage: capture.observation.status,
    });
    this.#readable.add(cancellationEvidenceId(id));
    this.captures.set(id, capture);
    return capture;
  }

  async execute(name: string, input: unknown): Promise<JsonValue> {
    this.signal?.throwIfAborted();
    if (name === 'inspect_workflow') {
      parseInput(empty, input, 'INVALID_TOOL_CALL', 'Workflow request');
      return boundedJsonValueSchema.parse(
        queryClientContext(this.context, {
          anchors: [this.context.context.entities[1]!.ref],
          maxDepth: 4,
          maxEntities: 16,
        }),
      );
    }
    if (name === 'list_evidence') {
      parseInput(empty, input, 'INVALID_TOOL_CALL', 'Evidence list');
      return boundedJsonValueSchema.parse(
        this.evidence.list().filter((artifact) => this.#readable.has(artifact.id)),
      );
    }
    if (name === 'read_evidence') {
      const args = parseInput(read, input, 'INVALID_TOOL_CALL', 'Evidence read');
      if (!this.#readable.has(args.evidenceId))
        throw new InvestigatorError(
          'SOURCE_ACCESS_DENIED',
          'The selected source does not grant this evidence read.',
        );
      const quote = readLocator(this.evidence.get(args.evidenceId), args.locator);
      if (Buffer.byteLength(quote, 'utf8') > 16_384)
        throw new InvestigatorError('TOOL_RESULT_TOO_LARGE', 'Choose a smaller evidence locator.');
      const citation = { evidenceId: args.evidenceId, locator: args.locator, quote };
      return boundedJsonValueSchema.parse(citation);
    }
    if (name === 'run_experiment') {
      const args = parseInput(experiment, input, 'INVALID_TOOL_CALL', 'Experiment request');
      return boundedJsonValueSchema.parse({
        evidenceId: cancellationEvidenceId(args.experimentId),
        capture: await this.run(args.experimentId),
      });
    }
    throw new InvestigatorError(
      'UNKNOWN_TOOL',
      'The requested investigation tool is not registered.',
    );
  }
}
