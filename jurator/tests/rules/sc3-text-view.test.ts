// AC-B (SC-3 fix 3): a must-not-match rule reads the `text` view. Docstrings and the words of messages are not code;
// the values a message carries ({…}, ${…}), keys ('uploading_files') and SQL are. Every false-alarm line SC-1 found
// for this cause (a real workspace, .09, .10, .27) is a case here, with the workspace's own rule.
import { describe, expect, it } from 'vitest';
import type { Rule } from '../../src/contracts.js';
import { codeView } from '../../src/rules/code-text.js';
import { proveRuleCanFail, runRule } from '../../src/rules/engine.js';

const C = 'c'.repeat(40);
const rule = (id: string, pattern: string, flags: string | null, globs: string[]): Rule =>
  ({ id, promiseId: id, description: id, mode: 'must-not-match', pattern, flags, globs, anchor: null, within: null }) as unknown as Rule;

// The rules as a real run saved them .
const R09 = rule(
  'R-document-handling.09-1',
  '(?:cache|redis|self\\.set|store_result)[^;]{0,120}clipboard|clipboard[^;]{0,120}(?:\\.set\\(|\\.setex\\(|store_result|cache\\.|redis\\.|cache\\[)',
  'i',
  ['backend-api/src/**/*.py'],
);
const R10 = rule(
  'R-document-handling.10-1',
  '\\bclipboard\\w*.{0,160}(?:upload|put_object|storage|s3|bucket)|(?:upload|put_object|storage|s3|bucket)\\w*.{0,160}\\bclipboard\\w*',
  'i',
  ['backend-api/src/**/*.py'],
);
const R27 = rule(
  'R-document-handling.27-1',
  '\\b(?:(?:console|logger|logging)\\.\\w+|print|log)\\s*\\([^)]{0,200}(?:extracted\\w*|document[_ ]?(?:text|content)|raw_text|full_text|page_text|ocr_text)',
  'i',
  ['chrome-extension/src/**', 'backend-api/src/**'],
);
const R15 = rule(
  'R-document-handling.15-1',
  '(?:localStorage|sessionStorage|chrome\\.storage\\.\\w+)\\s*\\.\\s*(?:set|setItem)\\s*\\(\\s*(?:[\'"][^\'"]*(?:documents|docs|files)|[^;]{0,200}?,\\s*[^;]{0,120}?(?:documents|\\w*docs?\\w*|files|uploads))',
  'im',
  ['chrome-extension/src/**/*.ts', 'chrome-extension/src/**/*.tsx'],
);

const B = 'backend-api/src/core';
const run = (r: Rule, path: string, text: string) => runRule(r, [{ path, text }], C);

describe('the text view (code-text.ts)', () => {
  it('blanks docstring lines and keeps the code and line numbers', () => {
    const src = 'class A:\n    """Caches the clipboard produced for an allowlisted document."""\n    x = 1\n';
    const v = codeView('a.py', src);
    expect(v.text).toEqual(['class A:', '', '    x = 1', '']);
    expect(v.code[1]).toContain('Caches the clipboard');
  });
  it('blanks a multi-line docstring, module docstrings included', () => {
    const src = '"""\nSeal a token.\n\nWorkers call the API (saving\nclipboard records, uploading filled forms).\n"""\nimport os\n';
    expect(codeView('s.py', src).text).toEqual(['', '', '', '', '', '', 'import os', '']);
  });
  it('blanks the words of a message, keeping {…} and the length of the line', () => {
    const line = '        logger.info(f"Extraction result cache stored: {key} ({len(clipboard)} fields)")';
    const t = codeView('r.py', line).text[0] as string;
    expect(t.length).toBe(line.length);
    expect(t).toContain('{key}');
    expect(t).toContain('{len(clipboard)}');
    expect(t).not.toMatch(/cache|stored|fields/u);
    expect(t.startsWith('        logger.info(f"')).toBe(true);
  });
  it('keeps ${…} in a template literal, also across lines', () => {
    const src = 'console.log(`saved docs for ${user.id} ok`);\nconst m = `line one\n  has ${token} here`;\n';
    const t = codeView('a.ts', src).text;
    expect(t[0]).toContain('${user.id}');
    expect(t[0]).not.toMatch(/saved|docs|ok/u);
    expect(t[1]).not.toMatch(/line|one/u);
    expect(t[2]).toContain('${token}');
    expect(t[2]).not.toMatch(/has|here/u);
  });
  it('keeps keys, paths and patterns (no space) and SQL whole', () => {
    const src = [
      "await localStorage.set('uploading_files', files);",
      'router.get("/api/export", h);',
      'db.query("SELECT text FROM clipboard WHERE id = $1", [id]);',
      "db.run('insert into clipboard_documents (body) values (?)', body);",
      "db.run(`UPDATE docs SET text = ${t}`);",
    ].join('\n');
    expect(codeView('a.ts', src).text).toEqual(codeView('a.ts', src).code);
  });
  it('blanks prose that only starts like SQL ("Update failed for clipboard")', () => {
    expect(codeView('a.ts', 'log("Update failed for clipboard");').text[0]).not.toContain('clipboard');
  });
  it('blanks a triple-quoted message that is not a docstring', () => {
    const src = 'PROMPT = """You read the clipboard\nand extract text."""\nx = PROMPT\n';
    const t = codeView('p.py', src).text;
    expect(t[0]).toMatch(/^PROMPT = """\s+$/u);
    expect(t[1]).toMatch(/^\s+"""$/u);
    expect(t[2]).toBe('x = PROMPT');
  });
  it('leaves files with no comment syntax (JSON, Markdown) as they are', () => {
    const src = '{ "note": "the clipboard text" }';
    expect(codeView('a.json', src).text).toEqual([src]);
  });
  it('leaves comments blank, as the code view does', () => {
    expect(codeView('a.ts', 'x(); // stores the clipboard').text[0]?.trim()).toBe('x();');
  });
});

describe("SC-1's false alarms for this cause pass now", () => {
  it('.09 result_cache.py:98 (docstring) and :158 (log text)', () => {
    const src = [
      'class ExtractionResultCache(CacheService[dict]):',
      '    """Caches the clipboard produced for an allowlisted document."""',
      '        await self.set(key, payload)',
      '        logger.info(f"Extraction result cache stored: {key} ({len(clipboard)} fields)")',
    ].join('\n');
    const r = run(R09, `${B}/extraction/general/result_cache.py`, src);
    expect(r.outcome, r.message).toBe('pass');
  });
  it('.10 valuables_collapse.py:408, sealed_token.py:5 (docstrings) and orchestrator.py:715 (log text)', () => {
    const files = [
      {
        path: `${B}/extraction/config/valuables_collapse.py`,
        text: [
          ') -> ClipboardReconciliation:',
          '    """',
          '    Sorts remapped valuables calls into new instances and field additions.',
          '',
          '    Augmentation re-extracts the whole document, so an article already on',
          '    the clipboard (an earlier upload of the same schedule) would come back',
          '    """',
        ].join('\n'),
      },
      {
        path: `${B}/queue/sealed_token.py`,
        text: '"""\nSeal a user\'s bearer token for the trip through the job queue.\n\nWorkers call the internal API as the user who queued the job (saving\nclipboard records, uploading filled forms), so the token has to reach them.\n"""\n',
      },
      {
        path: `${B}/extraction/general/orchestrator.py`,
        text: [
          '                                        logger.debug(',
          '                                            f"Using clipboard object_id: {object_id} for document: {uploaded_file.filename}"',
          '                                        )',
        ].join('\n'),
      },
    ];
    const r = runRule(R10, files, C);
    expect(r.outcome, r.message).toBe('pass');
  });
  it('.27: all five hits only count things', () => {
    const lines = [
      '    logger.info(f"field_extractor: extracted {len(fields)} fields")',
      '            logger.warning("No information extracted from content.")',
      '        logger.info(f"[{job_id}] Extracted {len(pdf_fields)} fields from PDF")',
      '        logger.info(f"Extracted {len(fields)} fields from PDF")',
    ];
    for (const line of lines) expect(run(R27, `${B}/x.py`, line).outcome, line).toBe('pass');
  });
});

describe('real breaks still fail', () => {
  it('a message that carries the data ({extracted_text}, ${documentText}) still breaks .27', () => {
    expect(run(R27, `${B}/x.py`, '    logger.info(f"result: {extracted_text}")').outcome).toBe('fail');
    expect(run(R27, `${B}/x.py`, '    logger.info("result %s", extracted_text)').outcome).toBe('fail');
    expect(run(R27, 'chrome-extension/src/a.ts', 'console.log(`got ${document_text} back`);').outcome).toBe('fail');
  });
  it(".15: the key 'uploading_files' is a key, not a message (useUploadFiles.ts:97)", () => {
    const r = run(R15, 'chrome-extension/src/hooks/useUploadFiles.ts', "    await localStorage.set('uploading_files', Array.from(map.values()));\n");
    expect(r.outcome).toBe('fail');
    expect(r.hits[0]?.startLine).toBe(1);
  });
  it('.09: the cache write that names the data still fails', () => {
    expect(run(R09, `${B}/a.py`, '        await self.cache.set(key, clipboard)').outcome).toBe('fail');
  });
  it('a proof whose bad line is only a message cannot prove the rule; one that passes the data can', () => {
    const files = [{ path: `${B}/x.py`, text: 'x = 1\n' }];
    expect(proveRuleCanFail(R27, files, C, { violationExample: 'logger.info(f"extracted {len(fields)} fields")' }).ok).toBe(false);
    expect(proveRuleCanFail(R27, files, C, { violationExample: 'logger.info(f"text: {extracted_text}")' }).ok).toBe(true);
  });
});
