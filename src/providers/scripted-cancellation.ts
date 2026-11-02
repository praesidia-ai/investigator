import { assessCancellationExperiments } from '../cancellation/assessment.js';
import type { CancellationFinding } from '../cancellation/client.js';
import { cancellationEvidenceId } from '../cancellation/tools.js';
import { CANCELLATION_PROFILE, type CancellationCapture } from '../cancellation/schemas.js';
import { CACHED_WORKER_SOURCE } from '../cancellation/recipe.js';
import type { Citation } from '../core/schemas.js';
import type {
  ModelCompletion,
  ModelInput,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
} from './model-provider.js';

/** Protocol/engineering reference only. It never substitutes for a failed live model. */
export class ScriptedCancellationProvider implements ModelProvider {
  readonly id = 'scripted-cancellation-reference';
  readonly model = 'deterministic-work-revocation-example';
  readonly mode = 'scripted';
  #turn = 0;
  #captures: CancellationCapture[] = [];
  #citations: Citation[] = [];
  #worker = '';

  #ingest(input: readonly ModelInput[]): void {
    for (const item of input) {
      if (
        item.type !== 'tool-result' ||
        !item.output ||
        typeof item.output !== 'object' ||
        Array.isArray(item.output)
      )
        continue;
      const output = item.output;
      if ('capture' in output)
        this.#captures.push(output.capture as unknown as CancellationCapture);
      if ('quote' in output && typeof output.quote === 'string') {
        const citation = output as unknown as Citation;
        this.#citations.push(citation);
        if (citation.evidenceId === 'worker-source') this.#worker = citation.quote;
      }
    }
  }
  #complete(text: string, toolCalls: ModelToolCall[] = []): ModelCompletion {
    return {
      text,
      toolCalls,
      state: [],
      finishReason: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  async complete(request: ModelRequest): Promise<ModelCompletion> {
    this.#ingest(request.input);
    this.#turn += 1;
    if (this.#turn === 1)
      return this.#complete('', [
        { id: 'inspect', name: 'inspect_workflow', arguments: {} },
        {
          id: 'policy',
          name: 'read_evidence',
          arguments: {
            evidenceId: 'revocation-policy',
            locator: { kind: 'lines', start: 2, end: 8 },
          },
        },
        {
          id: 'worker',
          name: 'read_evidence',
          arguments: { evidenceId: 'worker-source', locator: { kind: 'lines', start: 1, end: 3 } },
        },
      ]);
    if (this.#turn === 2)
      return this.#complete(
        '',
        CANCELLATION_PROFILE.requiredExperiments.map((experimentId, index) => ({
          id: `experiment-${index}`,
          name: 'run_experiment',
          arguments: { experimentId },
        })),
      );
    const assessment = assessCancellationExperiments(this.#captures);
    if (this.#turn === 3) {
      const checks =
        assessment.verdict === 'supported'
          ? assessment.checks
          : [
              assessment.checks.find(
                (check) =>
                  check.status === (assessment.verdict === 'contradicted' ? 'FAIL' : 'INCOMPLETE'),
              )!,
            ];
      const calls: ModelToolCall[] = [];
      for (const check of checks) {
        if (!check.experimentId) continue;
        for (const path of check.witnessPointers)
          calls.push({
            id: `witness-${calls.length}`,
            name: 'read_evidence',
            arguments: {
              evidenceId: cancellationEvidenceId(check.experimentId),
              locator: { kind: 'json-pointer', pointer: path },
            },
          });
      }
      return this.#complete('', calls);
    }
    const missing = assessment.verdict === 'insufficient_evidence';
    const finding: CancellationFinding = {
      verdict: assessment.verdict,
      statement: missing
        ? 'The acknowledged authority boundary or required effect capture is unavailable in this selected workload.'
        : assessment.verdict === 'contradicted'
          ? 'The captured workload contains a post-revocation acceptance or a failure to preserve permitted work.'
          : 'The four captured experiments support the selected revocation claim within the authored workflow.',
      workingHypothesis: 'A queued worker may rely on authority captured before revocation.',
      alternativeExplanation:
        'A recorded effect may have been accepted before revocation, or the required capture may be missing.',
      citations: this.#citations,
      missingEvidence: missing
        ? [
            'A trusted revocation acknowledgment and complete closed observation of the selected experiments.',
          ]
        : [],
      nextAction: missing
        ? 'collect-missing-capture'
        : assessment.verdict === 'contradicted' && this.#worker === CACHED_WORKER_SOURCE.trimEnd()
          ? 'check-current-root-authority.v1'
          : 'none',
    };
    return this.#complete(JSON.stringify(finding));
  }
}
