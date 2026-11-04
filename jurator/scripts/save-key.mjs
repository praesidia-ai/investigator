// Saves your Meta API key to ~/.jurator/credentials.json (mode 600) so `jurator` finds it in any shell.
// Run with the key in the environment, e.g.:  node --env-file=path/to/.env scripts/save-key.mjs
// The key is never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const key = process.env.META_API_KEY || process.env.MODEL_API_KEY;
if (!key) {
  console.error('No META_API_KEY (or MODEL_API_KEY) in the environment. Pass --env-file=<path to .env> to node.');
  process.exit(2);
}
const dir = process.env.JURATOR_HOME || join(homedir(), '.jurator');
const file = join(dir, 'credentials.json');
mkdirSync(dir, { recursive: true, mode: 0o700 });
let existing = {};
if (existsSync(file)) {
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    existing = {};
  }
}
writeFileSync(file, `${JSON.stringify({ ...existing, META_API_KEY: key }, null, 2)}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Saved the key to ${file} (only you can read it). Check it with: jurator doctor --live`);
