// Owner: WP-0. Lists every command; owners edit only their own command file.
import type { Command } from './context.js';
import accept from './commands/accept.js';
import add from './commands/add.js';
import bench from './commands/bench.js';
import bind from './commands/bind.js';
import check from './commands/check.js';
import compile from './commands/compile.js';
import conflicts from './commands/conflicts.js';
import discuss from './commands/discuss.js';
import doctor from './commands/doctor.js';
import explain from './commands/explain.js';
import hook from './commands/hook.js';
import init from './commands/init.js';
import promises from './commands/promises.js';
import mcp from './commands/mcp.js';
import pull from './commands/pull.js';
import report from './commands/report.js';
import rule from './commands/rule.js';
import status from './commands/status.js';
import verify from './commands/verify.js';

/** Order = order shown in --help (the flow a new user follows). */
export const COMMANDS: readonly Command[] = [
  init, add, pull, compile, promises, accept, conflicts, rule, bind, check, explain, verify, report, status, discuss, hook, mcp, bench, doctor,
];
