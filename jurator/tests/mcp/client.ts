// A tiny MCP client for tests: spawns a server process and matches answers to requests by id.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const TS_HOOK = join(HERE, 'ts-hook.mjs');
export const FAKE_SERVER = join(HERE, 'fake-server.ts');
export const BIN = join(REPO_ROOT, 'src', 'bin.ts');

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export class McpTestClient {
  readonly lines: RpcResponse[] = [];
  stderr = '';
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number | string, (r: RpcResponse) => void>();
  private readonly exited: Promise<number | null>;

  private constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcResponse; // stdout must carry JSON only: a stray log line fails here
        this.lines.push(msg);
        if (msg.id !== null && this.waiting.has(msg.id)) {
          this.waiting.get(msg.id)?.(msg);
          this.waiting.delete(msg.id);
        }
      }
    });
    proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => proc.on('close', (code) => resolve(code)));
  }

  /** Spawns `node --import ts-hook <entry> ...args` (the real sources, no build step). */
  static start(entry: string, args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): McpTestClient {
    const proc = spawn(process.execPath, ['--import', TS_HOOK, entry, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new McpTestClient(proc);
  }

  sendRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<RpcResponse> {
    const id = this.nextId++;
    const answer = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${method} (#${id}). stderr:\n${this.stderr}`)), timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    return answer;
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  async initialize(): Promise<RpcResponse> {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1' },
    });
    this.notify('notifications/initialized');
    return r;
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult> {
    const r = await this.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
    if (r.error) throw new Error(`tools/call ${name}: ${r.error.message}`);
    return r.result as unknown as ToolCallResult;
  }

  /** Ends stdin; the server finishes pending answers and exits. */
  async close(): Promise<number | null> {
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}

export function textOf(result: ToolCallResult): string {
  return result.content.map((c) => c.text).join('\n');
}
