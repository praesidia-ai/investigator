// Video mode filter for the demo scripts: each line of stdin -> repo-relative paths, 7-character shas, folded to 100
// columns (the same shaping `--video` applies inside jurator). Lines pass through as they arrive (live progress).
// Usage: <command> 2>&1 | node scripts/shape.mjs <jurator root>
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? process.cwd();
const { shape, rootSpellings } = await import(pathToFileURL(join(root, 'dist/render/video.js')).href);
const roots = rootSpellings(process.cwd());
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) process.stdout.write(`${shape(line, roots)}\n`);
