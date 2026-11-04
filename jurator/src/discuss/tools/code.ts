// Owner: DS-A. search_code, read_lines, list_files: the code at the session snapshot, read-only and bounded.
import { z } from 'zod';
import { DISCUSS_LIMITS } from '../contract.js';
import { JuratorError } from '../../util/errors.js';
import { type DiscussTool, oneLine, plural, refused } from './types.js';

const L = DISCUSS_LIMITS;
const short = (sha: string): string => sha.slice(0, 7);

const searchArgs = z.object({
  query: z.string().min(1).max(200).describe('Text to find (plain text unless regex is true).'),
  regex: z.boolean().optional().describe('True: query is a regular expression (Perl style). Default false.'),
  glob: z.string().min(1).max(200).optional().describe('Only files matching this glob, e.g. "**/*.py" or "chrome-extension/src/**".'),
  caseSensitive: z.boolean().optional().describe('Default false.'),
});
type SearchArgs = z.infer<typeof searchArgs>;

export const searchCode: DiscussTool<SearchArgs> = {
  name: 'search_code',
  description:
    `Searches the tracked code at the session snapshot (git grep). Returns up to ${L.maxSearchHits} hits ` +
    `(${L.maxSearchHitsPerFile} per file) as path:line and the line. Secret files are never searched. ` +
    'Use it before saying something is absent, and say what you searched.',
  args: searchArgs,
  label: (a) => `search_code ${JSON.stringify(oneLine(a.query, 60))}${a.glob ? ` in ${a.glob}` : ''}`,
  async run(a, { ws, code }) {
    let found;
    try {
      found = await code.grep({
        query: a.query,
        regex: a.regex ?? false,
        caseSensitive: a.caseSensitive ?? false,
        glob: a.glob ?? null,
        maxHits: L.maxSearchHits,
        maxPerFile: L.maxSearchHitsPerFile,
        prefer: ws.data.config.codeScope,
      });
    } catch (error) {
      if (error instanceof JuratorError && error.code === 'BAD_INPUT') return refused(`bad input: ${error.message}`);
      throw error;
    }
    if (found.hits.length === 0) {
      return {
        ok: true,
        summary: 'no hits',
        text: `No hits for ${JSON.stringify(a.query)}${a.glob ? ` in ${a.glob}` : ''} at ${short(code.commit)} (tracked files only; secret files are never searched).`,
      };
    }
    const shown = new Set(found.hits.map((h) => h.path)).size;
    const summary = found.truncated
      ? `${found.total}+ hits in ${plural(found.files, 'file')}, first ${found.hits.length} shown`
      : `${plural(found.hits.length, 'hit')} in ${plural(shown, 'file')}`;
    const lines = [
      `${summary} for ${JSON.stringify(a.query)} at ${short(code.commit)} (at most ${L.maxSearchHitsPerFile} per file; code in the configured scope first, tests and docs last):`,
    ];
    for (const h of found.hits) lines.push(`${h.path}:${h.line}: ${oneLine(h.text, L.maxLineChars)}`);
    if (found.truncated) {
      lines.push(`[more hits not shown: narrow the query or pass a glob. Files with hits by folder: ${found.folders.map((f) => `${f.folder} (${f.files})`).join(', ')}]`);
    }
    return {
      ok: true,
      summary,
      text: lines.join('\n'),
      evidence: found.hits.map((h) => ({ path: h.path, commit: code.commit, startLine: h.line, endLine: h.line, quote: h.text })),
      truncated: found.truncated,
    };
  },
};

const readArgs = z.object({
  path: z.string().min(1).max(400).describe('Repo path as search_code or list_files print it.'),
  start: z.number().int().min(1).describe('First line (1-based).'),
  end: z.number().int().min(1).describe(`Last line; at most ${L.maxReadLines} lines per call.`),
});
type ReadArgs = z.infer<typeof readArgs>;

export const readLines: DiscussTool<ReadArgs> = {
  name: 'read_lines',
  description:
    `Reads lines of one tracked file at the session snapshot, numbered (at most ${L.maxReadLines} per call). ` +
    'Cite what you use as [[path:start-end]]. Secret files (.env, keys) are refused; secrets show as [masked].',
  args: readArgs,
  label: (a) => `read_lines ${a.path}:${a.start}-${a.end}`,
  async run(a, { code }) {
    let path: string;
    try {
      path = code.normalize(a.path);
    } catch (error) {
      return refused(`bad input: ${(error as Error).message}`);
    }
    let lines: string[];
    try {
      lines = await code.lines(path);
    } catch (error) {
      const c = (error as { code?: string }).code;
      if (c === 'SECRET_FILE') return refused('refused: secret files are never read', `${path} is a secret file (.env, key or certificate); it is never read.`);
      if (c === 'FILE_NOT_IN_COMMIT') return refused('not found', `${path} is not a tracked file at ${short(code.commit)}. Use list_files or search_code to find the path.`);
      throw error;
    }
    if (lines.length === 0) return { ok: true, summary: 'empty file', text: `${path} is empty at ${short(code.commit)}.` };
    if (a.start > lines.length) {
      return refused(`out of range (${plural(lines.length, 'line')})`, `${path} has ${plural(lines.length, 'line')} at ${short(code.commit)}; line ${a.start} does not exist.`);
    }
    const start = a.start;
    let end = Math.min(Math.max(a.end, start), lines.length);
    let truncated = false;
    if (end - start + 1 > L.maxReadLines) {
      end = start + L.maxReadLines - 1;
      truncated = true;
    }
    const quote = lines.slice(start - 1, end);
    const width = String(end).length;
    const body = quote.map((l, i) => `${String(start + i).padStart(width)}  ${l}`);
    const head = `${path}:${start}-${end} at ${short(code.commit)} (${plural(lines.length, 'line')} in the file)`;
    const tail = truncated ? [`[cut at ${L.maxReadLines} lines: read the rest from line ${end + 1}]`] : [];
    return {
      ok: true,
      summary: `${plural(quote.length, 'line')}${truncated ? ` (cut at ${L.maxReadLines})` : ''}`,
      text: [head, ...body, ...tail].join('\n'),
      evidence: [{ path, commit: code.commit, startLine: start, endLine: end, quote: quote.join('\n') }],
      truncated,
    };
  },
};

const listArgs = z.object({
  globs: z.array(z.string().min(1).max(200)).min(1).max(20).describe('Globs such as "**/*.py" or "backend/app/**". "*.py" means any .py file.'),
});
type ListArgs = z.infer<typeof listArgs>;

export const listFiles: DiscussTool<ListArgs> = {
  name: 'list_files',
  description: `Lists tracked files at the session snapshot matching any glob (at most ${L.maxListFiles}). Workspace paths start with the repo name.`,
  args: listArgs,
  label: (a) => `list_files ${a.globs.join(' ')}`,
  async run(a, { code }) {
    const files = await code.listFiles(a.globs);
    if (files.length === 0) return { ok: true, summary: 'no files', text: `No tracked file matches ${a.globs.join(', ')} at ${short(code.commit)}.` };
    const shown = files.slice(0, L.maxListFiles);
    const truncated = files.length > shown.length;
    const lines = [`${plural(files.length, 'file')} match ${a.globs.join(', ')} at ${short(code.commit)}:`, ...shown];
    if (truncated) lines.push(`[${files.length - shown.length} more not shown: narrow the globs]`);
    return { ok: true, summary: `${plural(files.length, 'file')}${truncated ? `, first ${shown.length} shown` : ''}`, text: lines.join('\n'), truncated };
  },
};
