// Test-only (R5-B): a process that keeps the main thread busy with hostile rule scans, with the Ctrl-C handler on.
import { registerInterrupt } from '../../../src/ui/interrupt.js';
import { scanLines } from '../../../src/rules/sandbox.js';

registerInterrupt({ cleanup: () => undefined, costUsd: () => 0.25 });
const line = 'a'.repeat(2000);
process.stdout.write('busy\n');
for (let i = 0; i < 50; i += 1) {
  try {
    scanLines('.*.*.*.*.*x', '', [[line]]);
  } catch {
    /* RULE_TIMEOUT: the next scan starts */
  }
}
process.stdout.write('finished\n');
