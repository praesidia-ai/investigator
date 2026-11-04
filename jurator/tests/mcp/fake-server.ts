// Test entry: the real MCP server and the real check, over fakes (in-memory store and git). Spawned by mcp.test.ts.
// MCP_FAKE_SCENARIO: 'default' | 'no-workspace' | 'check-fails'.
import { createInterface } from 'node:readline';
import { runCheck } from '../../src/check/index.js';
import { createJuratorMcpServer, serveLines, type McpDeps } from '../../src/mcp/index.js';
import { FakeRepo, FakeStore } from './fakes.js';

const scenario = process.env.MCP_FAKE_SCENARIO ?? 'default';
const store = new FakeStore();
store.present = scenario !== 'no-workspace';
const repo = new FakeRepo();

const deps: McpDeps = {
  async open() {
    return { store, repo };
  },
  async runCheck(options) {
    if (scenario === 'check-fails') throw new Error('git exploded');
    if (options.model !== null || options.aiRead) throw new Error('check_change must never ask a model');
    return runCheck(options);
  },
  async listRuns(s) {
    return [...(s as FakeStore).runs];
  },
  now: () => new Date('2026-11-04T05:30:00.000Z'),
};

const server = createJuratorMcpServer(deps, (line) => process.stderr.write(`${line}\n`));
await serveLines(
  server,
  createInterface({ input: process.stdin, crlfDelay: Infinity }),
  (line) => process.stdout.write(`${line}\n`),
  (line) => process.stderr.write(`${line}\n`),
);
