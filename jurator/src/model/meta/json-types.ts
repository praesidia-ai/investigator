// Ported from praesidia-ai/investigator@d49aaea (Apache-2.0) plus the uncommitted parallel_tool_calls patch.
// Source: investigator/src/core/json.ts (types only).
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
