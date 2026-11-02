# Contributing

Use Node 22.12 or later, install with `npm ci`, and run `npm run check`. That gate covers formatting,
strict source/test types, deterministic tests and the ESM production build. Live Meta commands
require an explicitly configured local key and are never paid CI prerequisites.

Keep the Apache-2.0 runtime independent of private sibling repositories. New dependencies and
redistributed control packs need their own reviewed license and attribution. Use authored synthetic
records in examples and tests; do not commit credentials, customer data or platform exports.

## A control profile

Start from `src/core/control-profiles.ts` and `tests/control-profiles.test.ts`. A profile defines one
finite proposition, versioned mandatory criteria and evidence prerequisites. Keep documentary,
recorded-behavior and controlled-test claims distinct. Add explicit schema and assessment support
for a new profile; a free-text prompt is not a criterion verifier.

Include bypasses, valid work, unavailable capture and misleading source data. Every conclusive
finding needs resolvable observations that establish the specific criterion. Missing data and
test errors must remain uncertainty, and unrelated incomplete evidence must not poison an otherwise
complete criterion. A changed expectation is a new test/profile version, not a successful repair.

## An execution adapter

Implement the small host-selected `ControlCheckAdapter` contract. Its identity, version, subject
revision and configuration digest bind generated evidence; no core schema edit is needed for another
operator-supplied adapter identity. The shipped CLI uses the documented HTTP approval protocol;
see [ADAPTERS.md](docs/ADAPTERS.md). Keep endpoint selection and credentials in the
transport, outside model arguments and reports. Preserve request identity, relevant time, source
revision/configuration, coverage, action response and downstream effect observations separately.

The authored local HTTP adapter is a worked example, not a production execution sandbox. Supporting
arbitrary repository execution requires a separate isolation design. Read access to evidence does
not authorize production changes. Supported repair recipes need an exact preimage, bounded file
scope, a reviewable diff and unchanged negative plus permitted-work retests.

## Review and compatibility

Test a change at its actual seam. Use deterministic fixtures for transport/contract failures and
separate process/effect observations for execution claims. Keep model-quality evaluation separate
from unit-test success. The generated JSON Schema describes structure; `verifyCaseReport` checks
semantic and digest invariants. The current pre-release format may evolve before publication.

Do not run the private Praesidia stack for standalone changes. The selected public repository is
[praesidia-ai/investigator](https://github.com/praesidia-ai/investigator). The package's `private: true`
prevents npm registry publication and is compatible with a public source repository. Pushes and
registry releases remain separate maintainer actions.
