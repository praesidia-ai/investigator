#!/usr/bin/env node
import { runCli } from './cli.js';

const abort = new AbortController();
const cancel = () => abort.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
process.exitCode = await runCli(
  process.argv.slice(2),
  process.env,
  {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
  abort.signal,
);
process.removeListener('SIGINT', cancel);
process.removeListener('SIGTERM', cancel);
