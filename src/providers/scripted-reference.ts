import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { checkResultSchema, locatorSchema, type Finding } from '../core/schemas.js';
import type { ModelCompletion, ModelProvider, ModelRequest } from './model-provider.js';

const stateSchema = z.object({
  step: z.number().int().min(1).max(2),
  policyQuote: z.string().optional(),
});
const policyResultSchema = z.object({
  ok: z.literal(true),
  data: z.object({ evidenceId: z.literal('policy'), locator: locatorSchema, text: z.string() }),
});
const checkResultEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({
    evidenceId: z.string(),
    checks: z.array(checkResultSchema).min(1),
    scope: z.enum(['synthetic-reference-only', 'isolated-application-test']),
  }),
});

function lastResult(request: ModelRequest): JsonValue {
  const input = request.input.at(-1);
  if (input?.type !== 'tool-result')
    throw new InvestigatorError(
      'INVALID_SCRIPTED_SEQUENCE',
      'The reference script expected a real tool result.',
    );
  return input.output;
}

/** Reproducible reference orchestration. It executes real tools and never represents live reasoning. */
export class ScriptedReferenceProvider implements ModelProvider {
  readonly id = 'scripted-reference';
  readonly model = 'reference-sequence-v1';
  readonly mode = 'scripted' as const;

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    if (request.signal.aborted)
      throw new InvestigatorError('RUN_ABORTED', 'The reference run was cancelled.');
    const role = request.instructions.includes('the skeptic') ? 'skeptic' : 'investigator';
    if (!request.state) {
      return {
        text: '',
        state: [{ step: 1 }],
        toolCalls: [
          {
            id: `${role}-read-policy`,
            name: 'read_evidence',
            arguments: { evidenceId: 'policy', locator: { kind: 'lines', start: 1, end: 1 } },
          },
        ],
      };
    }
    const state = parseInput(
      stateSchema,
      request.state[0],
      'INVALID_SCRIPTED_SEQUENCE',
      'Reference state',
    );
    if (state.step === 1) {
      const policy = parseInput(
        policyResultSchema,
        lastResult(request),
        'INVALID_SCRIPTED_SEQUENCE',
        'Reference policy result',
      );
      return {
        text: '',
        state: [{ step: 2, policyQuote: policy.data.text }],
        toolCalls: [{ id: `${role}-check-control`, name: 'run_control_checks', arguments: {} }],
      };
    }
    const result = parseInput(
      checkResultEnvelope,
      lastResult(request),
      'INVALID_SCRIPTED_SEQUENCE',
      'Reference checks',
    );
    if (!state.policyQuote)
      throw new InvestigatorError(
        'INVALID_SCRIPTED_SEQUENCE',
        'The reference policy quotation is missing.',
      );
    const failedIndex = result.data.checks.findIndex((check) => check.status === 'FAIL');
    const unresolved = result.data.checks.some(
      (check) => check.status === 'ERROR' || check.status === 'INCOMPLETE',
    );
    const verdict =
      failedIndex >= 0 ? 'contradicted' : unresolved ? 'insufficient_evidence' : 'supported';
    const index = failedIndex >= 0 ? failedIndex : 0;
    const finding: Finding = {
      verdict,
      statement:
        verdict === 'contradicted'
          ? 'The declared control fails in the synthetic reference target; independent effect checks include a failing invariant.'
          : verdict === 'supported'
            ? 'The declared checks support this control in the synthetic reference target, including permitted work.'
            : 'The synthetic target could not be assessed; test errors are not passing controls.',
      citations: [
        {
          evidenceId: 'policy',
          locator: { kind: 'lines', start: 1, end: 1 },
          quote: state.policyQuote,
        },
        ...(verdict === 'supported'
          ? result.data.checks.map((check, checkIndex) => ({
              evidenceId: result.data.evidenceId,
              locator: { kind: 'json-pointer' as const, pointer: `/${checkIndex}/status` },
              quote: JSON.stringify(check.status),
            }))
          : [
              {
                evidenceId: result.data.evidenceId,
                locator: { kind: 'json-pointer' as const, pointer: `/${index}/status` },
                quote: JSON.stringify(result.data.checks[index]!.status),
              },
            ]),
      ],
      missingEvidence: unresolved
        ? ['A ready reference target and independent effect observer are required.']
        : [],
    };
    return { text: JSON.stringify(finding), toolCalls: [], state: request.state };
  }
}
