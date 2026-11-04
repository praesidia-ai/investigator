// Ported from praesidia-ai/investigator@d49aaea (Apache-2.0) plus the uncommitted parallel_tool_calls patch.
import type { JsonObject, JsonValue } from './json-types.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}
export type ModelInput =
  | { readonly type: 'message'; readonly role: 'user'; readonly content: string }
  | { readonly type: 'tool-result'; readonly callId: string; readonly output: JsonValue };
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelOutputFormat {
  readonly name: string;
  /** A provider-neutral JSON Schema; providers must request strict schema output. */
  readonly schema: JsonObject;
}
export interface ModelRequest {
  readonly instructions: string;
  readonly input: readonly ModelInput[];
  readonly tools: readonly ToolDefinition[];
  readonly state?: readonly JsonValue[];
  readonly signal: AbortSignal;
  readonly outputFormat?: ModelOutputFormat;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  /** Opt-in: allow several function calls in one model turn. The host still runs them in order. */
  readonly parallelToolCalls?: boolean;
}
export interface ModelCompletion {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  /** Opaque continuation items stay in memory and are never exported as evidence. */
  readonly state: readonly JsonValue[];
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Jurator: part of inputTokens served from the prompt cache, when the API reports it. */
    readonly cachedInputTokens?: number;
  };
  /** Truncation/refusal never becomes an assessed finding, even if text is present. */
  readonly finishReason?: 'completed' | 'output_limit' | 'refused';
}
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly mode: 'live' | 'scripted';
  readonly reasoningEffort?: ReasoningEffort;
  complete(request: ModelRequest): Promise<ModelCompletion>;
}
