// Owner: X-AGENTS. A minimal MCP server: hand-written JSON-RPC 2.0, no dependency.
// Transport-agnostic: `handleLine` takes one incoming line and returns the lines to send back. The stdio transport
// (one JSON message per line, UTF-8) is `serveLines`. stdout carries protocol messages only; logs go to `log`.
import { BRAND } from '../brand.js';

export interface ToolResult {
  /** Plain text for the agent (no colour). */
  readonly text: string;
  /** The same facts as JSON, for clients that read `structuredContent`. */
  readonly structured?: Record<string, unknown>;
  /** True when the tool could not do its job (bad input, no workspace, git failed). A BROKEN promise is not an error. */
  readonly isError?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  call(args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

export interface McpServerOptions {
  readonly tools: readonly ToolDefinition[];
  /** Sent in the initialize result; clients may add it to the agent's context. */
  readonly instructions?: string;
  readonly log?: (line: string) => void;
}

export interface McpServer {
  /** Handles one incoming line; returns zero or more response lines (each one JSON message, no newline). */
  handleLine(line: string): Promise<string[]>;
}

/** Versions this server knows. It uses only core features (tools/list, tools/call with text) that all of them share. */
export const PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
export const LATEST_PROTOCOL_VERSION = '2025-11-25';

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

type Id = string | number;
type Message = Record<string, unknown>;

/**
 * Echo the client's version when we know it, or when it is newer than ours (date-shaped): the tools surface we use
 * has not changed between versions, and refusing a newer client would only break the demo. Otherwise offer ours.
 */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LATEST_PROTOCOL_VERSION;
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(requested) && requested > LATEST_PROTOCOL_VERSION) return requested;
  return LATEST_PROTOCOL_VERSION;
}

function isObject(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is Id {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const log = options.log ?? (() => {});
  const tools = new Map(options.tools.map((t) => [t.name, t] as const));

  const ok = (id: Id, result: unknown): Message => ({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string): Message => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(id: Id, params: unknown): Promise<Message> {
    if (!isObject(params) || typeof params.name !== 'string') {
      return fail(id, RPC_ERRORS.invalidParams, 'tools/call needs params.name (a tool name).');
    }
    const tool = tools.get(params.name);
    if (!tool) {
      return fail(id, RPC_ERRORS.invalidParams, `Unknown tool: ${params.name}. Known tools: ${[...tools.keys()].join(', ')}.`);
    }
    const args = params.arguments ?? {};
    if (!isObject(args)) return fail(id, RPC_ERRORS.invalidParams, 'tools/call params.arguments must be an object.');
    let result: ToolResult;
    try {
      result = await tool.call(args);
    } catch (error) {
      log(`${BRAND.command} mcp: ${tool.name} failed: ${errorMessage(error)}`);
      result = { text: errorMessage(error), isError: true };
    }
    return ok(id, {
      content: [{ type: 'text', text: result.text }],
      ...(result.structured ? { structuredContent: result.structured } : {}),
      isError: result.isError === true,
    });
  }

  async function respond(method: string, id: Id, params: unknown): Promise<Message> {
    switch (method) {
      case 'initialize': {
        const requested = isObject(params) ? params.protocolVersion : undefined;
        return ok(id, {
          protocolVersion: negotiateVersion(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRAND.command, title: BRAND.name, version: BRAND.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: options.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            // Every tool reads; none can accept, waive or edit a promise. check_change writes only its local run record.
            annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          })),
        });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  async function handleMessage(message: unknown): Promise<Message | null> {
    if (!isObject(message)) {
      log(`${BRAND.command} mcp: ignored a message that is not a JSON object.`);
      return null;
    }
    const hasId = 'id' in message && message.id !== undefined;
    if (hasId && !isId(message.id)) {
      log(`${BRAND.command} mcp: ignored a message with an invalid id.`);
      return null;
    }
    const id = hasId ? (message.id as Id) : null;
    if (message.jsonrpc !== '2.0' || ('method' in message && typeof message.method !== 'string')) {
      if (id !== null) return fail(id, RPC_ERRORS.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 message.');
      log(`${BRAND.command} mcp: ignored an invalid notification.`);
      return null;
    }
    if (typeof message.method !== 'string') return null; // a response to a request we never sent: nothing to do
    if (id === null) return null; // notifications (initialized, cancelled, ...) need no answer
    try {
      return await respond(message.method, id, message.params);
    } catch (error) {
      log(`${BRAND.command} mcp: ${message.method} failed: ${errorMessage(error)}`);
      return fail(id, RPC_ERRORS.internalError, errorMessage(error));
    }
  }

  return {
    async handleLine(line) {
      const text = line.trim();
      if (!text) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A broken line has no id to answer to; say so on stderr and keep serving.
        log(`${BRAND.command} mcp: ignored a line that is not valid JSON (${text.length} characters).`);
        return [];
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const out: string[] = [];
      for (const response of await Promise.all(messages.map(handleMessage))) {
        if (response) out.push(JSON.stringify(response));
      }
      return out;
    },
  };
}

/**
 * The stdio transport: reads lines, answers each as soon as it is ready (a slow check never blocks a ping), and
 * resolves once input ends and every pending answer has been written.
 */
export async function serveLines(
  server: McpServer,
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  log: (line: string) => void = () => {},
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    const task: Promise<void> = server
      .handleLine(line)
      .then((out) => out.forEach(write))
      .catch((error: unknown) => log(`${BRAND.command} mcp: ${errorMessage(error)}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
