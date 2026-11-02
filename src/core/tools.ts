import { z } from 'zod';
import { runApprovalControlChecks } from '../reference/approval-control.js';
import type { ToolDefinition } from '../providers/model-provider.js';
import { readLocator } from './citations.js';
import {
  controlResultReference,
  modelFacingControl,
  type ControlCheckAdapter,
} from './control-target.js';
import { InvestigatorError, publicError } from './errors.js';
import type { EvidenceStore } from './evidence-store.js';
import { sha256, type JsonObject, type JsonValue } from './json.js';
import { parseInput } from './parse.js';
import {
  checkResultSchema,
  jsonValueSchema,
  locatorSchema,
  type CheckResult,
  type ControlCase,
} from './schemas.js';

const emptyArguments = z.object({}).strict();
const readArguments = z
  .object({ evidenceId: z.string().min(1).max(160), locator: locatorSchema })
  .strict();
export const REFERENCE_RESULT_EVIDENCE_ID = 'reference-control-results';
export const CONTROL_RESULT_EVIDENCE_ID = 'control-check-results';
const MAX_TOOL_RESULT_BYTES = 65_536;

const emptyParameters: JsonObject = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};
export const INVESTIGATION_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_control',
    description:
      'Read the frozen organizational claim, subject, required checks and declared evidence sources.',
    parameters: emptyParameters,
  },
  {
    name: 'list_evidence',
    description:
      'List saved evidence IDs and their source, coverage, redaction and capture metadata.',
    parameters: emptyParameters,
  },
  {
    name: 'read_evidence',
    description:
      'Read an exact line range or RFC 6901 JSON pointer. The returned text is the exact quotation to use in a citation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['evidenceId', 'locator'],
      properties: {
        evidenceId: { type: 'string' },
        locator: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'start', 'end'],
              properties: {
                kind: { const: 'lines' },
                start: { type: 'integer', minimum: 1 },
                end: { type: 'integer', minimum: 1 },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'pointer'],
              properties: { kind: { const: 'json-pointer' }, pointer: { type: 'string' } },
            },
          ],
        },
      },
    },
  },
  {
    name: 'run_control_checks',
    description:
      'Run the operator-selected target with frozen negative and positive checks. Observe downstream effects separately from response claims. Unsupported targets remain unavailable.',
    parameters: emptyParameters,
  },
];

export class InvestigationTools {
  #checks: readonly CheckResult[] = [];
  #checked = false;

  constructor(
    readonly controlCase: ControlCase,
    readonly evidence: EvidenceStore,
    readonly now: () => Date = () => new Date(),
    readonly options: {
      readonly adapter?: ControlCheckAdapter;
      readonly signal?: AbortSignal;
    } = {},
  ) {}

  get checks(): readonly CheckResult[] {
    return this.#checks;
  }

  async execute(name: string, args: unknown): Promise<JsonValue> {
    try {
      if (this.options.signal?.aborted)
        throw new InvestigatorError('RUN_ABORTED', 'The investigation was cancelled.');
      const result = await this.#execute(name, args);
      const validated = parseInput(jsonValueSchema, result, 'INVALID_TOOL_RESULT', 'Tool result');
      if (Buffer.byteLength(JSON.stringify(validated)) > MAX_TOOL_RESULT_BYTES) {
        throw new InvestigatorError('TOOL_RESULT_TOO_LARGE', 'Select a smaller evidence range.');
      }
      return { ok: true, data: validated };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  }

  async #execute(name: string, args: unknown): Promise<unknown> {
    if (name === 'read_evidence') {
      const input = parseInput(readArguments, args, 'INVALID_TOOL_ARGUMENTS', 'Evidence read');
      return {
        evidenceId: input.evidenceId,
        locator: input.locator,
        text: readLocator(this.evidence.get(input.evidenceId), input.locator),
      };
    }
    parseInput(emptyArguments, args, 'INVALID_TOOL_ARGUMENTS', 'Tool arguments');
    switch (name) {
      case 'get_control':
        return modelFacingControl(this.controlCase);
      case 'list_evidence':
        return this.evidence.list().map((artifact) => ({
          ...artifact,
          source:
            artifact.source.kind === 'reference-check'
              ? { kind: artifact.source.kind, reference: 'frozen-control-observations' }
              : artifact.source,
        }));
      case 'run_control_checks':
        return this.#runChecks();
      default:
        throw new InvestigatorError('TOOL_NOT_AVAILABLE', 'The requested tool is not registered.');
    }
  }

  async #runChecks(): Promise<unknown> {
    const target = this.controlCase.referenceTarget;
    const external = this.controlCase.controlledTarget;
    const adapter = this.options.adapter;
    if (!target && !external) {
      throw new InvestigatorError(
        'CHECK_TARGET_UNAVAILABLE',
        'This case has no supported test target; repository and deployed behavior were not tested.',
      );
    }
    if (
      external &&
      (!adapter ||
        adapter.id !== external.kind ||
        adapter.version !== external.version ||
        adapter.configurationDigest !== external.configurationDigest ||
        adapter.subjectRevision !== this.controlCase.subject.revision)
    )
      throw new InvestigatorError(
        'CHECK_TARGET_MISMATCH',
        'The selected adapter does not match the frozen target revision.',
      );
    const evidenceId = target ? REFERENCE_RESULT_EVIDENCE_ID : CONTROL_RESULT_EVIDENCE_ID;
    if (!this.#checked) {
      const checks = target
        ? runApprovalControlChecks(target.variant)
        : await adapter!.runChecks(this.options.signal ?? AbortSignal.timeout(60_000));
      this.#checks = parseInput(
        checkResultSchema.array().max(32),
        checks,
        'INVALID_CHECK_RESULT',
        'Control checks',
      );
      if (new Set(this.#checks.map((check) => check.id)).size !== this.#checks.length)
        throw new InvestigatorError('INVALID_CHECK_RESULT', 'Check IDs must be unique.');
      const content = JSON.stringify(this.#checks, null, 2);
      this.evidence.add({
        id: evidenceId,
        source: {
          kind: target ? 'reference-check' : 'controlled-check',
          reference: target
            ? `customer-export-reference:${target.variant}:v1`
            : controlResultReference(this.controlCase),
        },
        mediaType: 'application/json',
        capturedAt: this.now().toISOString(),
        sha256: sha256(content),
        byteLength: Buffer.byteLength(content),
        content,
        coverage: 'complete',
        redacted: false,
      });
      this.#checked = true;
    }
    return {
      evidenceId,
      scope: target ? 'synthetic-reference-only' : 'isolated-application-test',
      checks: this.#checks,
    };
  }
}
