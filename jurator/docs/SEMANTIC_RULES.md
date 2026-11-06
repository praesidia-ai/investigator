# Semantic rules

A semantic rule (`"mode": "semantic"`) is decided by an optional, versioned analyzer instead of a regex. Today there is one:
`ts-export-control`, control `guard-before-effect` (TypeScript + Express). It lives in `analyzers/ts-export-control/`
(its own package; Jurator itself stays zod-only).

What it checks: on every modeled path of every route, a recognized guard call runs before a protected effect, bound to the
same request-derived tenant and resource. It reads the code's imports and data flow, not nearby names. Anything it cannot
model is a coverage gap: computed or chained route registration, a verb outside `routeRegistrars`, `router.use`, spread
middleware, a middleware that reaches no `next()`, a call it cannot resolve that may carry request data, a function or effect
it cannot follow, a write it cannot tie to a value. A gap is never a pass: the rule reports "not assessed" (outcome `error`). A missing analyzer or a version
mismatch is also "not assessed".

## Writing one in `.jurator/rules.json`

```json
{
  "id": "R-security.01-export-guard",
  "promiseId": "security.01",
  "description": "Every export route checks access for the same tenant before exporting",
  "mode": "semantic",
  "pattern": "guard-before-effect",
  "globs": ["src/**/*.ts"],
  "provenBy": null,
  "status": "proposed",
  "author": "human",
  "createdAt": "2026-11-05T00:00:00.000Z",
  "semantic": {
    "adapter": "ts-export-control",
    "adapterVersion": "0.1.0",
    "control": "guard-before-effect",
    "config": {
      "guards": [{ "module": "src/auth/access", "symbol": "assertAccess", "subjectArg": 0, "tenantArg": 1, "resourceArg": 2, "style": "throws", "async": true }],
      "effects": [{ "module": "src/export/service", "symbol": "exportData", "tenantArg": 0, "resourceArg": 1 }],
      "routeRegistrars": ["get", "post", "put", "delete"],
      "routeObjects": ["app", "router"]
    }
  }
}
```

- `adapterVersion` must equal the installed analyzer's version exactly.
- `module` is the path of the defining file relative to the repository root (extension optional), or a package name.
  `./`, `../` and absolute paths are rejected. `effects` must not be empty. `symbol` is the name that module exports (`default` for a default export).
  Imports resolve from the importing file and through re-exports to one (module, exported symbol) pair, and only that
  pair matches, so point `module` at the defining file rather than a barrel. A local declaration that shadows the name,
  or a member access such as `guard.toString()`, is not the guard. `tenantArg` / `resourceArg` are zero-based argument positions. When an effect names one, the guard must
  bind the same value at its own position; a guard with no such arg does not cover it.
- `globs` must include the route files and every helper they import: the analyzer reads only the files it is given.
- A bare guard used as middleware (`router.get(p, requireAdmin, h)`) binds `(req, res, next)`.
- Every guard must state how it denies. `"style": "throws"` counts as a statement (`await guard(req, t, id)`), as
  middleware, or in a condition. `"style": "boolean"` counts only in a condition (`if (!guard(...)) return`), because a
  discarded boolean stops nothing.
- Every guard must state `"subjectArg"`: the zero-based position of the argument holding the request. A call counts only when
  that argument is `req`, `req.user` or a path under `req.user` (client-chosen paths such as `req.query` or `req.body` never count), so `guard({ user: { role: "admin" } }, t, id)` counts for
  nothing, and neither does `guard(getUser(req), t, id)`, which the analyzer cannot tell apart from a forged value. Use `null`
  only for a guard that appears solely as route middleware, which Express hands the request implicitly (`requireAdmin`,
  `requireRole("admin")`): with `null`, a call in a handler or helper does not count.
- Every guard must also state `"async"`. With `"async": true` a call counts only directly under `await`: an unawaited call
  stops nothing, and an unawaited boolean is an always-truthy Promise. The analyzer takes this from the config and does not
  compare it with the guard's declaration, so state it correctly. Middleware use is not affected.
- A guard returned from a helper or an arrow body (`return guard(req, t, id)`) counts under the same `style` and `async` rules.
- A destructuring or parameter default, a spread argument (and every position after it), and a key containing a dot have no
  known value, so they do not match a guard. A `const` holding a computed value (`const id = Number(req.params.id)`) matches
  itself and nothing else; a `let` holding one does not match.
- Writes are tracked per route, regardless of order. A write to a binding or request path anywhere on the route can turn a
  match into `unresolved-binding`, even if it comes after the effect, and a function that runs later (a callback, an unawaited
  async helper) sees every write on the route. Mutating methods on a request path count as writes: `push`, `pop`, `shift`,
  `unshift`, `splice`, `sort`, `reverse`, `fill`, `set`, `delete`, `clear`. Writing through the result of a local helper is the
  gap `unmodeled-write`, because that result may alias the request.
- A member of, or call into, a specifier that is the module of a configured effect, a subpath of it, or the same name with or
  without `node:` is the gap `unresolved-call` unless it matches the exact pair, even with only literal arguments. So is `new`
  on a class from a relative import: its constructor is not followed. `new` on the effect itself is checked as a call.
- A middleware passes on only the state at its `next()` calls, so a guard after `next()` does not count. `next(err)` with a
  `new` expression, a caught error or a truthy literal does not continue the chain. A middleware that reaches no `next()`
  is the gap `middleware-chain-stops`, and later handlers are not assessed.
- Calls that may carry request data must be resolved or are the gap `unresolved-call`, even after a guard. Excepted: calls on
  `req`, `res` or `next`, and a small list of known calls (`console.*`, `Math.*`, `JSON.parse`/`stringify`, `Date.now`,
  `Object.keys`/`values`/`entries`, `Array.isArray`, `Promise.*`, timers, number and string conversions). A call into an
  unsupplied package with only literal arguments is not a gap.
- `<expr>.<verb>(path, handler)` that is not a plain configured object and a configured registrar is the gap
  `unassessed-registration`. `<verb>` is every HTTP method Node knows (`report`, `search`, `lock`, ...) and `all`. With a
  non-literal path, a later argument that is a function, an import, a local alias or a parameter also matches, as does any
  spread. Other calls with the same shape also match, such as `axios.post('/x', body)`, `logger.trace('/x', detail)` and
  `cache.get(key, fallback)` where `fallback` is a parameter. `router.post(...route)` is the gap `spread-middleware`.
- `pattern` only describes the control; it is not run.

## Proof and wiring

`rule add` cannot remove a guard line to prove a semantic rule, so it is proven by supplied mutants (code that breaks the
control). Callers must run `await loadSemanticAdapters(rules)` once before `runRule`, which is synchronous.
Adapters load only from a fixed allowlist in `src/rules/semantic.ts`.
