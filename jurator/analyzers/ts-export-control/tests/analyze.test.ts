import { describe, expect, it } from 'vitest';
import { analyze, adapter, parseConfig } from '../src/index.js';

const config = {
  guards: [
    { module: 'src/auth', symbol: 'assertAccess', subjectArg: 0, tenantArg: 1, resourceArg: 2, style: 'throws', async: false },
    { module: 'src/auth', symbol: 'canAccess', subjectArg: 0, tenantArg: 1, resourceArg: 2, style: 'boolean', async: false },
    { module: 'src/auth', symbol: 'requireAdmin', subjectArg: null, style: 'throws', async: false },
  ],
  effects: [{ module: 'src/export', symbol: 'exportData', tenantArg: 0, resourceArg: 1 }],
  routeRegistrars: ['get', 'post'],
  routeObjects: ['app', 'router'],
};
const AUTH = { path: 'src/auth.ts', text: 'export function assertAccess(req: any, t: string, r: string) {}\nexport function requireAdmin(req: any, res: any, next: any) {}\nexport function canAccess(req: any, t: string, r: string) { return false; }\n' };
const EXPORT = { path: 'src/export.ts', text: 'export function exportData(t: string, r: string) {}\n' };
const head = `import { assertAccess, canAccess, requireAdmin } from './auth';\nimport { exportData } from './export';\n`;
const run = (body: string, extra: Array<{ path: string; text: string }> = []) =>
  analyze([AUTH, EXPORT, { path: 'src/routes.ts', text: head + body }, ...extra], config);
const ok = (r: ReturnType<typeof run>) => {
  expect(r.findings).toEqual([]);
  expect(r.gaps).toEqual([]);
};

describe('ts-export-control', () => {
  it('passes guard before effect', () => {
    const r = run(`router.get('/x/:t/:id', async (req, res) => {
  const { t, id } = req.params;
  await assertAccess(req, t, id);
  res.json(exportData(t, id));
});`);
    ok(r);
    expect(r.assessedRoutes).toBe(1);
    expect(r.typescriptVersion).toBe('5.9.3');
  });
  it('does not credit a boolean guard whose result is discarded', () => {
    const r = run(`router.get('/x/:t/:id', async (req, res) => {
  const { t, id } = req.params;
  await canAccess(req, t, id);
  res.json(exportData(t, id));
});`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.detail).toMatch(/no guard/u);
  });
  it('credits a boolean guard used as a condition', () => {
    ok(run(`router.get('/x/:t/:id', async (req, res) => {
  const { t, id } = req.params;
  if (!(await canAccess(req, t, id))) return res.sendStatus(403);
  res.json(exportData(t, id));
});`));
  });
  it('rejects a guard with no stated style', () => {
    expect(() => parseConfig({ ...config, guards: [{ module: 'src/auth', symbol: 'assertAccess' }] })).toThrow(/style/u);
  });
  it('reports a configured effect that no supplied code refers to', () => {
    const r = analyze([AUTH, { path: 'src/routes.ts', text: `router.get('/x', (req, res) => { res.send('ok'); });` }], config);
    expect(r.findings).toEqual([]);
    expect(r.gaps.map((g) => g.kind)).toContain('unmatched-effect');
  });
  it('flags effect before guard', () => {
    const r = run(`router.get('/x', (req, res) => {
  exportData(req.params.t, req.params.id);
  assertAccess(req, req.params.t, req.params.id);
});`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ path: 'src/routes.ts', line: 4, route: 'GET /x' });
  });
  it('flags conditional bypass', () => {
    const r = run(`router.get('/x', (req, res) => {
  if (req.query.fast) { assertAccess(req, req.params.t, req.params.id); }
  exportData(req.params.t, req.params.id);
});`);
    expect(r.findings).toHaveLength(1);
  });
  it('accepts guard in a negated early-exit condition', () => {
    ok(run(`router.get('/x', (req, res) => {
  if (!req.user) return res.status(401).end();
  try { assertAccess(req, req.params.t, req.params.id); } catch (e) { throw e; }
  exportData(req.params.t, req.params.id);
});`));
  });
  it('flags a guard that only runs in a try with a swallowing catch', () => {
    const r = run(`router.get('/x', (req, res) => {
  try { assertAccess(req, req.params.t, req.params.id); } catch (e) { console.log(e); }
  exportData(req.params.t, req.params.id);
});`);
    expect(r.findings).toHaveLength(1);
  });
  it('resolves an aliased import', () => {
    const r = analyze(
      [AUTH, EXPORT, { path: 'src/routes.ts', text: `import { assertAccess as ag } from './auth';\nimport { exportData as ex } from './export';\nrouter.get('/x', (req, res) => { ag(req, req.params.t, req.params.id); ex(req.params.t, req.params.id); });\nrouter.get('/y', (req, res) => { ex(req.params.t, req.params.id); });` }],
      config,
    );
    expect(r.findings.map((f) => f.route)).toEqual(['GET /y']);
  });
  it('resolves a local alias const g = guard', () => {
    ok(run(`const g = assertAccess;
router.get('/x', (req, res) => {
  g(req, req.params.t, req.params.id);
  exportData(req.params.t, req.params.id);
});`));
  });
  it('flags the wrong tenant argument', () => {
    const r = run(`router.get('/x', (req, res) => {
  assertAccess(req, req.user.tenantId, req.params.id);
  exportData(req.params.tenantId, req.params.id);
});`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.detail).toContain('same tenant');
  });
  it('flags a new route without a guard and keeps guarded routes clean', () => {
    const r = run(`router.get('/a', (req, res) => { assertAccess(req, req.params.t, req.params.id); exportData(req.params.t, req.params.id); });
router.post('/csv', (req, res) => { exportData(req.params.t, req.params.id); });`);
    expect(r.findings.map((f) => f.route)).toEqual(['POST /csv']);
  });
  it('lets a middleware-chain guard count (bare guard binds req)', () => {
    const r = analyze(
      [AUTH, EXPORT, { path: 'src/routes.ts', text: head + `router.get('/x', requireAdmin, (req, res) => { exportData(req, 'k'); });` }],
      { ...config, effects: [{ module: 'src/export', symbol: 'exportData' }] },
    );
    expect(r.findings).toEqual([]);
  });
  it('survives harmless refactors: rename local, extract helper, reorder unrelated lines', () => {
    const helper = { path: 'src/helper.ts', text: `import { assertAccess } from './auth';\nexport async function check(r: any, tenant: string, id: string) { await assertAccess(r, tenant, id); }\n` };
    ok(run(`import { check } from './helper';
router.get('/x', async (request, res) => {
  const { t: tenant, id: item } = request.params;
  const startedAt = Date.now();
  await check(request, tenant, item);
  res.json({ startedAt, data: exportData(tenant, item) });
});`, [helper]));
  });
  it('follows an imported helper that guards, and catches an imported helper that does not', () => {
    const good = { path: 'src/helper.ts', text: `import { assertAccess } from './auth';\nexport function check(r: any, t: string, id: string) { assertAccess(r, t, id); }\nexport function noop(r: any, t: string, id: string) {}\n` };
    const r = run(`import { check, noop } from './helper';
router.get('/a', (req, res) => { check(req, req.params.t, req.params.id); exportData(req.params.t, req.params.id); });
router.get('/b', (req, res) => { noop(req, req.params.t, req.params.id); exportData(req.params.t, req.params.id); });`, [good]);
    expect(r.findings.map((f) => f.route)).toEqual(['GET /b']);
  });
  it('reports dynamic registration as a gap', () => {
    const r = run(`for (const m of ['get', 'post']) { router[m]('/x', (req, res) => {}); }
router.use(requireAdmin);
router.get(prefix + '/y', (req, res) => {});
router.get('/z', ...handlers);`);
    expect(r.gaps.map((g) => g.kind).sort()).toEqual(['dynamic-registration', 'dynamic-route-path', 'spread-middleware', 'unmodeled-registration']);
  });
  it('reports an unresolved call before any guard as a gap', () => {
    const r = analyze(
      [AUTH, EXPORT, { path: 'src/routes.ts', text: head + `import { dump } from 'some-lib';\nrouter.get('/x', (req, res) => { dump(req.params.id); });` }],
      config,
    );
    expect(r.gaps.map((g) => g.kind)).toEqual(['unresolved-call']);
    expect(r.findings).toEqual([]);
  });
  it('ignores a guard name that appears only in comments or strings', () => {
    const r = run(`router.get('/x', (req, res) => {
  // assertAccess(req, req.params.t, req.params.id);
  const s = "assertAccess(req)"; /* assertAccess(req, t, id) */
  exportData(req.params.t, req.params.id);
});`);
    expect(r.findings).toHaveLength(1);
  });
  it('rejects bad config and wrong control', () => {
    expect(() => parseConfig({ guards: 3 })).toThrow(/guards/u);
    expect(adapter.analyze({ files: [], control: 'other', config: config as never }).gaps[0]?.kind).toBe('unsupported-control');
  });
  it('rejects a guard with no stated async, and a relative or absolute module', () => {
    const entry = { module: 'src/auth', symbol: 'assertAccess', style: 'throws' };
    expect(() => parseConfig({ ...config, guards: [entry] })).toThrow(/async/u);
    for (const module of ['./auth', '../auth', '/abs/auth']) {
      expect(() => parseConfig({ ...config, guards: [{ ...entry, module, async: false }] })).toThrow(/root-relative/u);
    }
  });
});

const h = (body: string) => `router.post('/x', async (req, res) => {\n${body}\n});`;
// A guarded use of the effect, so a test about something else does not also trip the unmatched-effect gap.
const EFFECT_USED = `\nrouter.post('/used/:t/:id', async (req, res) => {\nconst { t, id } = req.params;\nawait assertAccess(req, t, id);\nres.json(exportData(t, id));\n});`;
const asyncConfig = { ...config, guards: config.guards.map((g) => (g.symbol === 'requireAdmin' ? g : { ...g, async: true })) };
const runAsync = (body: string) => analyze([AUTH, EXPORT, { path: 'src/routes.ts', text: head + body }], asyncConfig);
const kinds = (r: ReturnType<typeof run>) => r.gaps.map((g) => g.kind);
const noGuard = (r: ReturnType<typeof run>) => expect(r.findings.map((f) => f.detail).join()).toMatch(/no guard/u);

describe('finding 1: finally runs with no guard credit', () => {
  it('flags an effect in finally after a guard in try', () => {
    noGuard(run(h(`try { await assertAccess(req,t,r); } finally { await exportData(t,r); }`)));
  });
  it('flags it when catch returns', () => {
    noGuard(run(h(`try { await assertAccess(req,t,r); } catch { return; } finally { await exportData(t,r); }`)));
  });
  it('still credits the guard after try/finally on the normal path', () => {
    ok(run(h(`try { await assertAccess(req,t,r); } finally { console.log('done'); }\nawait exportData(t,r);`)));
  });
});

describe('finding 2: an async guard counts only under await', () => {
  it('does not credit a missing await', () => {
    noGuard(runAsync(h(`assertAccess(req,t,r); await exportData(t,r);`)));
  });
  it('does not credit an unawaited async boolean condition', () => {
    noGuard(runAsync(h(`if (canAccess(req,t,r)) { await exportData(t,r); }`)));
  });
  it('credits both forms when awaited', () => {
    ok(runAsync(h(`await assertAccess(req,t,r); await exportData(t,r);`)));
    ok(runAsync(h(`if (!(await canAccess(req,t,r))) return; await exportData(t,r);`)));
  });
  it('does not credit an unawaited async helper around the guard', () => {
    noGuard(runAsync(`async function check() { await assertAccess(req,t,r); }\n` + h(`check(); await exportData(t,r);`)));
  });
});

describe('finding 3: function values are analyzed', () => {
  it('let-bound arrow, then called', () => {
    noGuard(run(h(`let run = () => exportData(t,r); run();`)));
  });
  it('const arrow passed to setImmediate', () => {
    noGuard(run(h(`const run = () => exportData(t,r); setImmediate(run);`)));
  });
  it('const arrow passed to forEach', () => {
    noGuard(run(h(`const run = () => exportData(t,r); list.forEach(run);`)));
  });
  it('object method', () => {
    noGuard(run(h(`const o = { run() { exportData(t,r) } };`)));
  });
  it('a const arrow called after the guard stays clean', () => {
    ok(run(h(`const run = () => exportData(t,r); await assertAccess(req,t,r); run();`)));
  });
});

describe('finding 4: unresolved calls are gaps regardless of guard state', () => {
  const guarded = (line: string, imports = '') => run(imports + h(`await assertAccess(req,t,r);\n${line}`));
  it('imported sink with request data inside an object', () => {
    expect(kinds(guarded(`sink({tenant:req.params.t});`, `import {sink} from 'pkg';\n`))).toContain('unresolved-call');
  });
  it('call chain and this member', () => {
    expect(kinds(guarded(`getSvc().exportData(req);`))).toContain('unresolved-call');
    expect(kinds(guarded(`this.svc.exportData(req);`))).toContain('unresolved-call');
  });
  it('apply on the effect', () => {
    expect(kinds(guarded(`exportData.apply(null,[req]);`))).toContain('unresolved-call');
  });
  it('dynamic import after an unrelated guard', () => {
    expect(kinds(guarded(`const {exportData: run} = await import('./export'); run(a,b);`))).toContain('unresolved-call');
  });
  it('the effect passed as a value', () => {
    expect(kinds(guarded(`setImmediate(exportData);`))).toContain('effect-reference');
  });
  it('known pure calls and response calls stay clean', () => {
    ok(run(h(`console.log(req.params.t); const n = Date.now(); JSON.stringify({ n }); res.status(200).json({ n }); res.end();`) + EFFECT_USED));
  });
  it('a literal-only call into an unsupplied package stays clean', () => {
    ok(run(`import { count } from 'pkg';\n` + h(`count('hits');`) + EFFECT_USED));
  });
});

describe('finding 5: rebinding after the guard is never a match', () => {
  const after = (rest: string, decl = 'let t = req.params.t;') => run(h(`${decl}\nawait assertAccess(req,t,r);\n${rest}`));
  it('write through req.*', () => {
    expect(kinds(run(h(`await assertAccess(req,req.params.t,r);\nreq.params.t = req.query.t;\nawait exportData(req.params.t,r);`)))).toContain('unresolved-binding');
  });
  it('write through an alias of req.*', () => {
    expect(kinds(run(h(`const p = req.params;\nawait assertAccess(req,req.params.t,r);\np.t = req.query.t;\nawait exportData(req.params.t,r);`)))).toContain('unresolved-binding');
  });
  it('destructuring assignment', () => {
    expect(kinds(after(`({t} = req.query);\nawait exportData(t,r);`))).toContain('unresolved-binding');
    expect(kinds(after(`[t] = x;\nawait exportData(t,r);`))).toContain('unresolved-binding');
  });
  it('for-of over an existing binding', () => {
    expect(kinds(after(`for (t of req.body.ts) await exportData(t,r);`))).toContain('unresolved-binding');
  });
  it('switch clause, also for a binding declared outside the handler', () => {
    expect(kinds(after(`switch(x){case 1: t=req.query.t}\nawait exportData(t,r);`))).toContain('unresolved-binding');
    expect(kinds(run(h(`await assertAccess(req,t,r);\nswitch(x){case 1: t=req.query.t}\nawait exportData(t,r);`)))).toContain('unresolved-binding');
  });
  it('a write in try reaches catch', () => {
    expect(kinds(after(`try { t=req.query.t; risky(); } catch { exportData(t,r) }`))).toContain('unresolved-binding');
  });
  it('a write late in a loop body reaches an earlier read', () => {
    expect(kinds(after(`for (const i of [1, 2]) { await exportData(t,r); t=req.query.t; }`))).toContain('unresolved-binding');
  });
  it('a write in a callback', () => {
    expect(kinds(after(`[1].forEach(()=>{t=other});\nawait exportData(t,r);`))).toContain('unresolved-binding');
  });
  it('a write in a directly called closure', () => {
    expect(kinds(after(`const f = () => { t = req.query.t; }; f();\nawait exportData(t,r);`))).toContain('unresolved-binding');
  });
  it('a write in a nested or try-called closure', () => {
    expect(kinds(after(`const g = () => { t = req.query.t; }; const f = () => { g(); }; f();\nawait exportData(t,r);`))).toContain('unresolved-binding');
    expect(kinds(after(`const g = () => { t = req.query.t; };\ntry { g(); } catch { await exportData(t,r); }`))).toContain('unresolved-binding');
  });
  it('object-held request aliases and Object.assign are gaps', () => {
    expect(kinds(run(h(`const q = { a: req.params };\nawait assertAccess(req,req.params.t,r);\nq.a.t = 1;\nawait exportData(req.params.t,r);`)))).toContain('unmodeled-write');
    expect(kinds(run(h(`await assertAccess(req,req.params.t,r);\nObject.assign(req.params, req.query);\nawait exportData(req.params.t,r);`)))).toContain('unresolved-call');
  });
  it('a block-scoped shadow does not leak', () => {
    const r = run(h(`const t=req.query.t; { const t=req.params.t; await assertAccess(req,t,r); } await exportData(t,r);`));
    expect(r.findings.map((f) => f.detail).join()).toMatch(/same tenant/u);
  });
  it('an unrelated request write and an unrelated local stay clean', () => {
    ok(run(h(`const t = req.params.t; await assertAccess(req,t,r); req.user = 1; const o = {}; o.a = 1; await exportData(t,r);`)));
  });
});

describe('finding 6: next() is the continuation', () => {
  it('flags a guard after next()', () => {
    noGuard(run(`const mw = (req,res,next)=>{ next(); assertAccess(req,t,r); };\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`));
  });
  it('flags an inline guard after next() in an imported-style function', () => {
    noGuard(run(`function mw(req,res,next){ next(); assertAccess(req,t,r); }\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`));
  });
  it('credits a guard before next(); next(err) does not continue', () => {
    ok(run(`const mw = async (req,res,next)=>{ try { await assertAccess(req,t,r); next(); } catch (e) { next(e); } };\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`));
    ok(run(`const mw = (req,res,next)=>{ if (!canAccess(req,t,r)) return next(new Error('no')); next(); };\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`));
  });
  it('merges a branch that reaches next() without the guard', () => {
    noGuard(run(`const mw = (req,res,next)=>{ if (req.query.fast) return next(); assertAccess(req,t,r); next(); };\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`));
  });
  it('a middleware with no next() is a gap, not a pass', () => {
    const r = run(`const mw = (req,res)=>{ assertAccess(req,t,r); };\nrouter.post('/x', mw, (req,res)=>{ exportData(t,r); });`);
    expect(kinds(r)).toContain('middleware-chain-stops');
    expect(r.assessedRoutes).toBe(0);
  });
});

describe('finding 7: control flow', () => {
  it('evaluates a do-while condition', () => {
    noGuard(run(h(`do {} while (await exportData(t,r));`)));
  });
  it('merges a loop break into the exit', () => {
    noGuard(run(h(`while (!canAccess(req,t,r)) { break; } exportData(t,r);`)));
  });
  it('merges a labeled break into the label exit', () => {
    noGuard(run(h(`done: { if (x) break done; await assertAccess(req,t,r); } exportData(t,r);`)));
  });
  it('merges an outer-labeled break through an inner loop', () => {
    noGuard(run(h(`outer: for (const a of [1]) { for (const b of [2]) { if (x) break outer; } await assertAccess(req,t,r); }\nexportData(t,r);`)));
  });
  it('a guard on every path through a do-while or labeled block stays credited', () => {
    ok(run(h(`do { await assertAccess(req,t,r); } while (false);\nexportData(t,r);`)));
    ok(run(h(`done: { await assertAccess(req,t,r); break done; }\nexportData(t,r);`)));
    ok(run(h(`while (true) { await assertAccess(req,t,r); break; }\nexportData(t,r);`)));
  });
  it('switch credits a guard only when every path has it', () => {
    ok(run(h(`switch (x) { case 1: await assertAccess(req,t,r); break; default: await assertAccess(req,t,r); }\nexportData(t,r);`)));
    noGuard(run(h(`switch (x) { case 1: await assertAccess(req,t,r); break; }\nexportData(t,r);`)));
  });
});

describe('finding 8: routes cannot escape discovery', () => {
  const reg = (r: ReturnType<typeof run>) => kinds(r).filter((k) => k === 'unassessed-registration');
  it('chained registrar', () => {
    expect(reg(run(`const ok = (req,res) => {};\nconst h = (req,res) => {};\napp.get('/a',ok).post('/export',h);`))).toHaveLength(1);
  });
  it('registrar on a parameter', () => {
    expect(reg(run(`function mount(r){ r.post('/x',h) }`))).toHaveLength(1);
  });
  it('registrar on this.router', () => {
    expect(reg(run(`class C { m() { this.router.post('/x',h) } }`))).toHaveLength(1);
  });
  it('verb outside routeRegistrars', () => {
    expect(reg(run(`router.delete('/x',h)`))).toHaveLength(1);
  });
  it('a registrar taken as a value', () => {
    expect(kinds(run(`const post = router.post.bind(router);`))).toContain('unmodeled-registration');
  });
  it('map.get and app.get(setting) are not routes', () => {
    ok(run(`const v = cache.get('key', 1);\nconst s = app.get('setting');` + EFFECT_USED));
  });
});

describe('finding 9: guard identity is one resolved pair', () => {
  it('a local shadow is not the guard', () => {
    noGuard(run(`function mount(){ const assertAccess=()=>{}; router.post('/x',(req,res)=>{ assertAccess(req,t,r); exportData(t,r); }); }`));
  });
  it('a parameter shadow is not the guard', () => {
    const r = run(`function mount(assertAccess){ router.post('/x',(req,res)=>{ assertAccess(req,t,r); exportData(t,r); }); }`);
    noGuard(r);
    expect(kinds(r)).toContain('unresolved-call');
  });
  it('a relative specifier resolves from the importer', () => {
    const files = [
      { path: 'auth.ts', text: `export function assertAccess(req: any, t: string, r: string) {}\n` },
      { path: 'routes/auth.ts', text: `export function assertAccess(req: any, t: string, r: string) {}\n` },
      EXPORT,
      { path: 'routes/x.ts', text: `import { assertAccess } from './auth';\nimport { exportData } from '../src/export';\n` + h(`assertAccess(req,t,r); exportData(t,r);`) },
    ];
    const cfg = { ...config, guards: [{ module: 'auth', symbol: 'assertAccess', subjectArg: 0, tenantArg: 1, resourceArg: 2, style: 'throws', async: false }] };
    noGuard(analyze(files, cfg));
  });
  it('src/auth/index.ts is not the configured src/auth.ts', () => {
    const noop = { path: 'src/auth/index.ts', text: `export function assertAccess(req: any, t: string, r: string) {}\n` };
    const route = { path: 'src/routes.ts', text: `import { assertAccess } from './auth/index';\nimport { exportData } from './export';\n` + h(`assertAccess(req,t,r); exportData(t,r);`) };
    noGuard(analyze([AUTH, noop, EXPORT, route], config));
  });
  it('a re-export under the guard name is not the guard', () => {
    const auth = { path: 'src/auth.ts', text: AUTH.text + `export function audit(req: any, res: any, next: any) { next(); }\n` };
    const barrel = { path: 'src/barrel.ts', text: `export { audit as requireAdmin } from './auth';\n` };
    const route = { path: 'src/routes.ts', text: `import { requireAdmin } from './barrel';\nimport { exportData } from './export';\nrouter.post('/x', requireAdmin, (req, res) => { exportData(req, 'k'); });` };
    noGuard(analyze([auth, barrel, EXPORT, route], { ...config, effects: [{ module: 'src/export', symbol: 'exportData' }] }));
  });
  it('a plain re-export of the guard is still the guard', () => {
    const barrel = { path: 'src/barrel.ts', text: `export { assertAccess as check } from './auth';\n` };
    const route = { path: 'src/routes.ts', text: `import { check } from './barrel';\nimport { exportData } from './export';\n` + h(`check(req,t,r); exportData(t,r);`) };
    ok(analyze([AUTH, barrel, EXPORT, route], config));
  });
  it('a same-file exported effect is still the effect', () => {
    const route = { path: 'src/export.ts', text: `export function exportData(t: string, r: string) {}\n` + h(`exportData(t,r);`) };
    noGuard(analyze([AUTH, route], config));
  });
  it('a member access on the guard is not the guard', () => {
    const r = run(h(`assertAccess.toString(); exportData(t,r);`));
    noGuard(r);
    expect(kinds(r)).toContain('unresolved-call');
  });
  it('a namespace member is the guard', () => {
    ok(run(`import * as auth from './auth';\n` + h(`auth.assertAccess(req,t,r); exportData(t,r);`)));
  });
});

describe('finding 10: findExport is bounded', () => {
  it('a re-export cycle terminates as a gap', () => {
    const a = { path: 'src/a.ts', text: `export * from './b';\nexport { g } from './b';\n` };
    const b = { path: 'src/b.ts', text: `export * from './a';\nexport { g } from './a';\n` };
    const route = { path: 'src/routes.ts', text: `import { g } from './a';\n` + h(`g(req);`) };
    expect(analyze([a, b, route], config).gaps.map((x) => x.kind)).toContain('unresolved-call');
  });
  it('wide star re-exports stay within the step budget', () => {
    const star = Array.from({ length: 12 }, (_, i) => ({ path: `src/s${i}.ts`, text: `export * from './s${(i + 1) % 12}';\nexport * from './s${(i + 2) % 12}';\n` }));
    const route = { path: 'src/routes.ts', text: `import { g } from './s0';\n` + h(`g(req);`) };
    const r = analyze([...star, route], config);
    expect(r.gaps.map((x) => x.kind)).toEqual(['unresolved-call']);
  });
});

describe('false passes: writes after a deferred callback is defined', () => {
  it('a later write to a captured binding', () => {
    expect(kinds(run(h(`let t=req.params.t; const id=req.params.id; await assertAccess(req,t,id); setImmediate(()=>exportData(t,id)); t=req.query.t; res.end();`)))).toContain('unresolved-binding');
  });
  it('a later write to a request path', () => {
    expect(kinds(run(h(`const id=req.params.id; await assertAccess(req,req.params.t,id); res.on('finish',()=>exportData(req.params.t,id)); req.params.t=req.query.t;`)))).toContain('unresolved-binding');
  });
  it('a later write to a free binding', () => {
    expect(kinds(run(h(`await assertAccess(req,t,r); setImmediate(()=>exportData(t,r)); t=req.query.t;`)))).toContain('unresolved-binding');
  });
  it('a callback with no later write stays clean, and a route is counted once', () => {
    const r = run(h(`const t=req.params.t; const id=req.params.id; await assertAccess(req,t,id); setImmediate(()=>exportData(t,id)); req.user=1; res.end();`));
    ok(r);
    expect(r.assessedRoutes).toBe(1);
  });
  it('a violation on a route with writes is reported once', () => {
    const r = run(h(`let t=req.params.t; exportData(t,r); t=1;`));
    expect(r.findings).toHaveLength(1);
  });
});

describe('false passes: value and registration modeling', () => {
  const reg = (r: ReturnType<typeof run>) => kinds(r).filter((k) => k === 'unassessed-registration');
  it('a helper returning a request alias is not a new object', () => {
    expect(kinds(run(h(`const getP=()=>req.params; const p=getP(); await assertAccess(req,req.params.t,req.params.id); p.t=req.query.t; res.json(exportData(req.params.t,req.params.id));`)))).toContain('unmodeled-write');
  });
  it('a verb only http.METHODS knows', () => {
    expect(reg(run(`router.report('/export',(req,res)=>{exportData(req.params.t,req.params.id);});` + EFFECT_USED))).toHaveLength(1);
  });
  it('a dynamic path on an unknown object with a function or import handler', () => {
    expect(reg(run(`import {api} from './server'; const PATH='/export'; function hh(req,res){exportData(req.params.t,req.params.id);} api.post(PATH,hh);` + EFFECT_USED))).toHaveLength(1);
    expect(reg(run(`import {api} from './server'; import {hh} from './handlers'; const PATH='/export'; api.post(PATH,hh);` + EFFECT_USED))).toHaveLength(1);
  });
  it('a registrar with everything passed as parameters', () => {
    expect(reg(run(`function mount(r,p,hh){r.post(p,hh);}` + EFFECT_USED))).toHaveLength(1);
  });
  it('a dynamic key with a plain local second argument stays clean', () => {
    ok(run(`const key='k'; const fallback=1; const v=cache.get(key,fallback);` + EFFECT_USED));
  });
  it('a route registered only through a spread', () => {
    expect(kinds(run(`const route=['/export',(req,res)=>{exportData(req.params.t,req.params.id);}]; router.post(...route);` + EFFECT_USED))).toContain('spread-middleware');
  });
  it('a spread registration on an unknown object', () => {
    expect(reg(run(`import {api} from './server'; api.post(...route);` + EFFECT_USED))).toHaveLength(1);
  });
  it('a destructuring default has no request value', () => {
    expect(kinds(run(h(`const {t:gt='public',id}=req.params; const {t:et=req.query.t}=req.params; await assertAccess(req,gt,id); res.json(exportData(et,id));`)))).toContain('unresolved-binding');
  });
  it('a parameter default has no request value', () => {
    expect(kinds(run(`function check(q,t='public',i){assertAccess(q,t,i);}\n` + h(`check(req,req.params.t,req.params.id); exportData(req.params.t,req.params.id);`)))).toContain('unresolved-binding');
  });
  it('a mutator on a request path', () => {
    expect(kinds(run(h(`await assertAccess(req,req.params.t,req.body.ids); req.body.ids.push(req.query.extra); res.json(exportData(req.params.t,req.body.ids));`)))).toContain('unresolved-binding');
  });
  it('a mutator through an alias of a request path', () => {
    expect(kinds(run(h(`const ids=req.body.ids; await assertAccess(req,req.params.t,ids); ids.sort(); res.json(exportData(req.params.t,ids));`)))).toContain('unresolved-binding');
  });
  it('a non-mutating request call stays clean', () => {
    ok(run(h(`await assertAccess(req,req.params.t,req.body.ids); req.body.ids.slice(); res.set('a','b'); res.json(exportData(req.params.t,req.body.ids));`)));
  });
});

describe('false passes: the guard must be about this request', () => {
  it('a forged principal object', () => {
    noGuard(run(h(`await assertAccess({user:{role:'admin'}},req.params.t,req.params.id); res.json(exportData(req.params.t,req.params.id));`)));
  });
  it('a dims-free guard called with an empty object', () => {
    const effects = [{ module: 'src/export', symbol: 'exportData' }];
    const route = (body: string) => [AUTH, EXPORT, { path: 'src/routes.ts', text: head + h(body) }];
    noGuard(analyze(route(`await requireAdmin({}); exportData();`), { ...config, effects }));
    const guards = [{ module: 'src/auth', symbol: 'requireAdmin', subjectArg: 0, style: 'throws', async: false }];
    noGuard(analyze(route(`await requireAdmin({}); exportData();`), { ...config, guards, effects }));
    ok(analyze(route(`await requireAdmin(req); exportData();`), { ...config, guards, effects }));
    ok(analyze(route(`await requireAdmin(req.user); exportData();`), { ...config, guards, effects }));
  });
  it('a guard with subjectArg null counts only as route middleware', () => {
    const effects = [{ module: 'src/export', symbol: 'exportData' }];
    const route = (text: string) => [AUTH, EXPORT, { path: 'src/routes.ts', text: head + text }];
    noGuard(analyze(route(h(`requireAdmin(req); exportData();`)), { ...config, effects }));
    ok(analyze(route(`router.post('/x', requireAdmin(), (req,res)=>{ exportData(); });`), { ...config, effects }));
  });
  it('a chain guard called with a value that is not the request does not count', () => {
    noGuard(run(`router.post('/x', assertAccess(forged,t,r), (req,res)=>{ exportData(t,r); });`));
  });
  it('parseConfig requires subjectArg on every guard', () => {
    const entry = { module: 'src/auth', symbol: 'assertAccess', style: 'throws', async: false };
    expect(() => parseConfig({ ...config, guards: [entry] })).toThrow(/subjectArg/u);
    expect(() => parseConfig({ ...config, guards: [{ ...entry, subjectArg: -1 }] })).toThrow(/subjectArg/u);
    expect(() => parseConfig({ ...config, guards: [{ ...entry, subjectArg: 'req' }] })).toThrow(/subjectArg/u);
    expect(parseConfig({ ...config, guards: [{ ...entry, subjectArg: null }] }).guards[0]?.subjectArg).toBeNull();
  });
});

describe('false passes: effects behind constructors and unmatched specifiers', () => {
  const JOB = { path: 'src/job.ts', text: `import {exportData} from './export'; export class Job{constructor(){exportData('a','b');}}` };
  it('a no-argument constructor from a relative import', () => {
    expect(kinds(run(`import {Job} from './job';\n` + h(`new Job(); res.end();`) + EFFECT_USED, [JOB]))).toContain('unresolved-call');
  });
  it('the effect called with new', () => {
    noGuard(run(h(`new exportData('a','b');`) + EFFECT_USED));
  });
  const lib = (module: string, symbol: string, text: string) =>
    analyze([AUTH, { path: 'src/routes.ts', text: `import { requireAdmin } from './auth';\n` + text }], { ...config, effects: [{ module, symbol }] });
  const USED = `\nrouter.post('/used', requireAdmin, (req,res)=>{ exportAll(); });`;
  it('a default-import member of the effect package', () => {
    expect(kinds(lib('export-lib', 'exportAll', `import lib,{exportAll} from 'export-lib';\n` + h(`lib.exportAll(); res.end();`) + USED))).toContain('unresolved-call');
  });
  it('a subpath of the effect package', () => {
    expect(kinds(lib('export-lib', 'exportAll', `import {exportAll} from 'export-lib';\nimport {exportAll as sub} from 'export-lib/sub';\n` + h(`sub(); res.end();`) + USED))).toContain('unresolved-call');
  });
  it('a node: specifier that differs from the configured one', () => {
    expect(kinds(lib('fs', 'exportAll', `import {exportAll} from 'fs';\nimport {exportAll as other} from 'node:fs';\n` + h(`other(); res.end();`) + USED))).toContain('unresolved-call');
    expect(kinds(lib('node:fs', 'exportAll', `import {exportAll} from 'node:fs';\nimport {exportAll as other} from 'fs';\n` + h(`other(); res.end();`) + USED))).toContain('unresolved-call');
  });
  it('a literal-only call into a similarly named package stays clean', () => {
    ok(lib('export-lib', 'exportAll', `import {exportAll} from 'export-lib';\nimport {count} from 'export-lib-extra';\n` + h(`count('a'); res.end();`) + USED));
  });
});

describe('false passes: lower severity', () => {
  it('a var redeclared in try reaches catch', () => {
    expect(kinds(run(h(`var t=req.params.t; await assertAccess(req,t,r); try { var t=req.query.t; JSON.parse(x); } catch { exportData(t,r); }`)))).toContain('unresolved-binding');
  });
  it('rejects a config with no effects', () => {
    expect(() => parseConfig({ ...config, effects: [] })).toThrow(/effects/u);
  });
  it('a dotted key is not a nested path', () => {
    expect(kinds(run(h(`await assertAccess(req,req.body.a.b,r); exportData(req.body['a.b'],r);`)))).toContain('unresolved-binding');
    expect(kinds(run(h(`const {'a.b':k}=req.body; await assertAccess(req,req.body.a.b,r); exportData(k,r);`)))).toContain('unresolved-binding');
  });
  it('a spread shifts every later argument', () => {
    expect(kinds(run(h(`await assertAccess(req,t,ids); exportData(t,...ids);`)))).toContain('unresolved-binding');
    noGuard(run(h(`await assertAccess(...args,t,r); exportData(t,r);`)));
  });
  it('a namespace declaration shadows the guard', () => {
    noGuard(run(`namespace N { function assertAccess(req,t,i){} router.post('/x',(req,res)=>{ assertAccess(req,t,r); exportData(t,r); }); }`));
  });
});

describe('usability: real bindings that used to be gaps or violations', () => {
  it('an unwritten const holding a converted request value matches', () => {
    ok(run(h(`const t=req.params.t; const id=Number(req.params.id); await assertAccess(req,t,id); exportData(t,id);`)));
  });
  it('that match does not extend to a let, a later reassignment, or another const', () => {
    expect(kinds(run(h(`const t=req.params.t; let id=Number(req.params.id); await assertAccess(req,t,id); exportData(t,id);`)))).toContain('unresolved-binding');
    expect(kinds(run(h(`const t=req.params.t; const id=Number(req.params.id); const o=Number(req.query.id); await assertAccess(req,t,id); exportData(t,o);`)))).toContain('unresolved-binding');
    expect(kinds(run(h(`const t=req.params.t; const o=Object.keys(req.body); await assertAccess(req,t,o); o[0]=req.query.x; exportData(t,o);`)))).toContain('unmodeled-write');
  });
  it('that match does not extend to a request-free allocation', () => {
    expect(kinds(run(h(`const t=req.params.t; const o={}; await assertAccess(req,t,o); o.a=req.query.a; exportData(t,o);`)))).toContain('unresolved-binding');
  });
  it('a throwing guard returned from a helper or an arrow body counts', () => {
    ok(run(`function check(q,t,i){return assertAccess(q,t,i);}\n` + h(`check(req,t,r); exportData(t,r);`)));
    ok(run(`const check=(q,t,i)=>assertAccess(q,t,i);\n` + h(`check(req,t,r); exportData(t,r);`)));
  });
  it('a returned boolean guard or unawaited async guard still does not', () => {
    noGuard(run(`function check(q,t,i){return canAccess(q,t,i);}\n` + h(`check(req,t,r); exportData(t,r);`)));
    noGuard(runAsync(`function check(q,t,i){return assertAccess(q,t,i);}\n` + h(`check(req,t,r); await exportData(t,r);`)));
    ok(runAsync(`async function check(q,t,i){return await assertAccess(q,t,i);}\n` + h(`await check(req,t,r); await exportData(t,r);`)));
  });
});

describe('review round 3: subject, const identity, unset outer bindings, writes after next()', () => {
  it('a client-chosen request path is not the guard subject', () => {
    noGuard(run(h(`const t=req.params.t; const id=req.params.id; await assertAccess(req.query,t,id); exportData(t,id);`)));
    noGuard(run(h(`const t=req.params.t; const id=req.params.id; await assertAccess(req.body.user,t,id); exportData(t,id);`)));
    ok(run(h(`const t=req.params.t; const id=req.params.id; await assertAccess(req.user,t,id); exportData(t,id);`)));
  });
  it('a const aliasing a request object does not match after that object is mutated', () => {
    expect(kinds(run(h(`const t=req.params.t; const ids=req.body.ids ?? []; await assertAccess(req,t,ids); req.body.ids.push(req.query.extra); res.json(exportData(t,ids));`)))).toContain('unresolved-binding');
  });
  it('a const snapshot does not make a late-written let match', () => {
    expect(kinds(run(h(`const t=req.params.t; let id=Number(req.params.id); req.on('data',(c)=>{ id=Number(c); }); const orig=id; await assertAccess(req,t,id); exportData(t,id);`)))).toContain('unresolved-binding');
  });
  it('a shadowed converter gives no const identity', () => {
    expect(kinds(run(h(`const Number=(x)=>x; const t=req.params.t; const id=Number(req.body); await assertAccess(req,t,id); exportData(t,id);`)))).not.toEqual([]);
  });
  it('an unset outer let written after a deferred callback', () => {
    expect(kinds(run(`let tenant;\nrouter.post('/x',async(req,res)=>{ const id=req.params.id; await assertAccess(req,tenant,id); setImmediate(()=>exportData(tenant,id)); tenant=req.query.t; res.end(); });`))).toContain('unresolved-binding');
  });
  it('a write after next() reaches the rest of the chain', () => {
    expect(kinds(run(`let s;\nrouter.post('/x',(req,res,next)=>{ s=req.params.t; next(); s=req.query.t; },async(req,res)=>{ const id=req.params.id; await assertAccess(req,s,id); await exportData(s,id); });`))).toContain('unresolved-binding');
  });
});
