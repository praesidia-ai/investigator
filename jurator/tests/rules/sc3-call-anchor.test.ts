// AC-B (SC-3 fix 8): an each-near anchor that ends in a call (`get_job_status\s*\(`) skips the lines that define the
// called name. SC-1's .23 false alarm cited two definitions (queue.py:284, jobs.py:181); they are cases here, with
// the workspace's own rule.
import { describe, expect, it } from 'vitest';
import type { Rule } from '../../src/contracts.js';
import { definesCalledName, NOTHING_TO_CHECK, proveRuleCanFail, runRule } from '../../src/rules/engine.js';

const C = 'c'.repeat(40);
const R23 = {
  id: 'R-document-handling.23-1',
  promiseId: 'document-handling.23',
  description: 'each get_job_status call checks the owner',
  mode: 'each-near',
  pattern: '(?:user_id|organization_id|agency_id|owner_id)\\w*\\s*(?:=|!=|==)',
  anchor: 'get_job_status\\s*\\(',
  within: 10,
  globs: ['backend-api/src/api/**/*.py'],
  flags: null,
} as unknown as Rule;

const QUEUE = [
  '@router.get(',
  '    "/status/{job_id}",',
  '    response_model=APIResponse[dict],',
  ')',
  'async def get_job_status(',
  '    job_id: str,',
  '    token: str = Depends(get_raw_token),',
  '):',
  '    """Get status and results for a queued extraction job.',
  '',
  '    Accepts job IDs with `doc_`, `note_`, or `gen_` prefix.',
  '    """',
].join('\n');
const JOBS = [
  '    summary="Get a mapping job\'s status and, once completed, its mappings",',
  ')',
  'async def get_job_status(',
  '    job_id: str, user_id: str = Depends(get_current_user_id)',
  ') -> APIResponse[JobStatusResponse]:',
  '    """Poll a mapping job; ``result.mappings`` is set once it is completed."""',
  '    meta = _owned_job_meta(job_id, user_id)',
  '    return APIResponse(status=status.HTTP_200_OK, data=_job_status(job_id, meta))',
].join('\n');
const CALL_GUARDED = ['    job_status = job_manager.get_job_status(job_id)', '    if job_status.user_id != user_id:', '        raise HTTPException(404)'].join('\n');
const CALL_BARE = '    job_status = job_manager.get_job_status(job_id)\n    return job_status\n';

describe("SC-1's .23 false alarm: the anchor's own definitions", () => {
  it('queue.py:284 and jobs.py:181 (async def get_job_status) are not calls to check', () => {
    const r = runRule(
      R23,
      [
        { path: 'backend-api/src/api/extract/queue.py', text: QUEUE },
        { path: 'backend-api/src/api/pdf_mapping/jobs.py', text: JOBS },
        { path: 'backend-api/src/api/extract/polling.py', text: CALL_GUARDED },
      ],
      C,
    );
    expect(r.outcome, r.message).toBe('pass');
    expect(r.message).toContain('all 1 line with');
  });
  it('a call with no owner check still fails, and only the call is cited', () => {
    const r = runRule(
      R23,
      [
        { path: 'backend-api/src/api/extract/queue.py', text: QUEUE },
        { path: 'backend-api/src/api/extract/polling.py', text: CALL_BARE },
      ],
      C,
    );
    expect(r.outcome).toBe('fail');
    expect(r.hits.map((h) => `${h.path}:${h.startLine}`)).toEqual(['backend-api/src/api/extract/polling.py:1']);
  });
  it('only definitions: nothing to check (an error, never a pass)', () => {
    const r = runRule(R23, [{ path: 'backend-api/src/api/extract/queue.py', text: QUEUE }], C);
    expect(r.outcome).toBe('error');
    expect(r.message.startsWith(NOTHING_TO_CHECK)).toBe(true);
    expect(r.message).toContain('define the function it calls (backend-api/src/api/extract/queue.py:5)');
  });
  it('the proof still works: removing the guard makes the call fail', () => {
    const files = [
      { path: 'backend-api/src/api/extract/queue.py', text: QUEUE },
      { path: 'backend-api/src/api/extract/polling.py', text: CALL_GUARDED },
    ];
    const proof = proveRuleCanFail(R23, files, C, { violationExample: 'status = get_job_status(job_id)' });
    expect(proof.ok, proof.mutation).toBe(true);
  });
});

describe('definesCalledName', () => {
  const defines = (line: string, matched = 'save('): boolean => definesCalledName(line, matched);
  it('definitions in Python, JS/TS, Go, Kotlin, Rust, Java', () => {
    for (const line of [
      'def save(self, x):',
      '    async def save(',
      'function save(a) {',
      'export async function save(a: string): Promise<void> {',
      'export default function* save(',
      'func (s *Store) save(ctx context.Context) error {',
      'fun Store.save(x: Int): Unit {',
      'pub fn save(&self) -> Result<()> {',
      '  async save(id: string) {',
      '  private static save(',
      '  save(id: string): Promise<void> {',
      '  save(x) {',
      '  public void save(String id) {',
      '  Status save(String id);',
      '  public JobStatus save(',
      '  void save(String id);',
    ]) {
      expect(defines(line), line).toBe(true);
    }
  });
  it('calls are not definitions', () => {
    for (const line of [
      '    job = JobManager().save(job_id)',
      '    save(x)',
      '  await save(x);',
      '  return save(x);',
      '  save(x).then(() => {',
      "  it('save', () => save({ a: 1 }));",
      '  if save(x):',
      '  const s = new save(x);',
      '  yield save(x)',
      '  x = save(',
      '  save(',
      '  void save(x);',
    ]) {
      expect(defines(line), line).toBe(false);
    }
  });
  it('an anchor that matches the keyword itself is about definitions: kept', () => {
    expect(definesCalledName('def export_handler(req):', 'def export_handler(')).toBe(false);
    expect(definesCalledName('async function handleExport(req) {', 'function handleExport(')).toBe(false);
  });
  it('statements are not calls or definitions (`if (`)', () => {
    expect(definesCalledName('  if (x) {', 'if (')).toBe(false);
  });
});
