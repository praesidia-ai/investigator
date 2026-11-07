// Owner: X-AGENTS. `jurator mcp`: serves promises and checks to coding agents over MCP (stdio).
// stdout carries JSON-RPC messages only (through ctx.out, one per line); every log line goes to stderr.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { parseOrUsage } from '../usage-parse.js';
import { BRAND } from '../../brand.js';
import { createJuratorMcpServer, realMcpDeps, serveLines } from '../../mcp/index.js';
import type { Command } from '../context.js';

const USAGE = `${BRAND.command} mcp [--repo <path>]`;

const command: Command = {
  name: 'mcp',
  summary: 'Serve promises and checks to coding agents over MCP (stdio)',
  usage: `${USAGE}\n\nStarted by the coding agent (see templates/agents/README.md); read and check tools only.`,
  async run(ctx) {
    const parsed = parseOrUsage(ctx, USAGE, () =>
      parseArgs({ args: [...ctx.argv], options: { repo: { type: 'string' } }, allowPositionals: false, strict: true }),
    );
    if (!parsed) return 2;
    const repo = parsed.values.repo;
    const cwd = repo ? resolve(ctx.cwd, repo) : ctx.cwd;
    const server = createJuratorMcpServer(realMcpDeps(cwd, ctx.now), ctx.err);
    // The one place a command reads stdin: MCP's stdio transport is the process's own stdin/stdout.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    ctx.err(`${BRAND.name} MCP server ready (stdio, ${cwd}).`);
    await serveLines(server, lines, ctx.out, ctx.err);
    return 0;
  },
};
export default command;
