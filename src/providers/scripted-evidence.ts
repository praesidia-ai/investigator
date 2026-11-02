import type { EvidenceRequest } from '../evidence-plans/requests.js';
import type { ModelCompletion, ModelProvider, ModelRequest } from './model-provider.js';

/** Explicit offline demonstration; never selected as a fallback for a failed live call. */
export class ScriptedEvidenceProvider implements ModelProvider {
  readonly id = 'scripted-evidence-planner';
  readonly model = 'deterministic-evidence-example';
  readonly mode = 'scripted';
  #turn = 0;
  constructor(readonly request: EvidenceRequest) {}

  async complete(_request: ModelRequest): Promise<ModelCompletion> {
    this.#turn += 1;
    if (this.#turn === 1)
      return {
        text: '',
        state: [],
        toolCalls: [
          {
            id: 'context-1',
            name: 'inspect_client_context',
            arguments: { entityIndex: 0, depth: 3, maxEntities: 16 },
          },
        ],
      };
    if (this.#turn === 2)
      return {
        text: '',
        state: [],
        toolCalls: [
          {
            id: 'producer-1',
            name: 'read_client_evidence',
            arguments: {
              evidenceId: this.request.producerCitation.evidenceId,
              locator: this.request.producerCitation.locator,
            },
          },
        ],
      };
    return {
      text: JSON.stringify(this.request),
      state: [],
      toolCalls: [],
      finishReason: 'completed',
    };
  }
}
