// Test-only (R5-B): a process waiting on a model call (event loop free), with a live view that spent $0.1234.
import { createLive } from '../../../src/ui/live.js';

const live = createLive({ title: 'bind', unit: 'promises', env: { CI: 'true' }, write: (l) => process.stderr.write(`${l}\n`) });
live.add('a');
live.start('a');
live.addCost(0.1234);
process.stdout.write('waiting\n');
setTimeout(() => process.stdout.write('finished\n'), 20_000);
