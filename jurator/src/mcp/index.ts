// Owner: X-AGENTS. MCP server over stdio (hand-written JSON-RPC, no new dependency): promises and checks for coding agents.
import { runCheck } from '../check/index.js';
import { openRepo } from '../git/index.js';
import { findRepoRoot, listRuns, openStore } from '../workspace/index.js';
import { createMcpServer, type McpServer } from './protocol.js';
import { createTools, SERVER_INSTRUCTIONS, type McpDeps } from './tools.js';

export {
  createMcpServer,
  negotiateVersion,
  serveLines,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  RPC_ERRORS,
} from './protocol.js';
export type { McpServer, McpServerOptions, ToolDefinition, ToolResult } from './protocol.js';
export { createTools, toRepoPath, SERVER_INSTRUCTIONS } from './tools.js';
export type { McpDeps, McpWorkspace } from './tools.js';

/** The real wiring: the repo that contains `cwd`, its .jurator/ store, git, and the real check. */
export function realMcpDeps(cwd: string, now: () => Date = () => new Date()): McpDeps {
  return {
    async open() {
      const root = await findRepoRoot(cwd);
      return { store: openStore(root), repo: await openRepo(root) };
    },
    runCheck: (options) => runCheck(options),
    listRuns,
    now,
  };
}

/** The Jurator MCP server over the given deps (tests pass fakes). */
export function createJuratorMcpServer(deps: McpDeps, log?: (line: string) => void): McpServer {
  return createMcpServer({ tools: createTools(deps), instructions: SERVER_INSTRUCTIONS, ...(log ? { log } : {}) });
}
