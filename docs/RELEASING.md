# Preparing a release candidate

The selected public repository is [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator).
A verified private reporting channel is still pending. These commands prepare and verify local
artifacts; they do not commit, push, publish, deploy or submit to the hackathon.

## Local acceptance

```sh
npm ci
npm run check
mkdir -p artifacts
npm run release:artifact -- --independent --out artifacts/release-candidate
npm run release:source -- --out artifacts/source-candidate
npm run release:readiness
```

Use new output paths. The independent example requires `python3` and uses only the Python standard
library. The application runtime itself requires Node 22.12 or later, without Python or Praesidia.
The hosted workflow is configured for Node 22, 24 and 26 on Linux; a workflow file is not evidence
that those hosted jobs have passed. Verify the exact supported floor before advertising it as tested.

Packed smoke checks npm's actual file inventory, rejects private/generated paths and sibling checkout
dependencies, installs into an isolated consumer, and runs the cancellation repair, three authored
cancellation trials, evidence/approval/change examples, saved-record verification and public imports.
The `--independent` option additionally runs the Python target. It strips model/platform/registry
credentials and Node preloads. Installing its
public dependency may require internet access; the investigations themselves are offline fixtures.

The retained runtime artifact directory contains a package tarball, `release-artifact.json` and `SHA256SUMS`.
Checksums establish consistency with this supplied manifest, not independently trusted authorship.
Keep source and tests available with the eventual public source release; the npm runtime tarball
is not a substitute for the TypeScript source repository. `release:source` uses the Python standard
library to create a separate bounded archive of TypeScript source, tests, public fixtures, scripts,
documentation and lockfile. Its whitelist excludes `.env`, installed dependencies, generated reports,
Git internals and private sibling projects. It retains a source inventory and checksums and requires
a new output directory. Review its inventory before sharing it or preparing the public repository.

## Evidence and review still needed

- Actual live Meta verification described in [META-MODELS.md](META-MODELS.md).
- A separate person's completed [installation trial](INDEPENDENT-TRIAL.md).
- Reviewed source publication to the selected repository, a pinned commit/tag and successful hosted CI.
- A verified private reporting channel before public launch; see [SECURITY.md](../SECURITY.md).
- Authenticated Startup-track submission requirements, including any video/source fields.

`release:readiness` inspects local preparation and leaves unobserved execution/external gates
`PENDING`. A file's existence is not proof that its instructions were performed. `--strict` exits
nonzero while those gates remain pending. It never issues a release approval.

## GitHub source publication

Before publishing to [praesidia-ai/investigator](https://github.com/praesidia-ai/investigator), verify
the complete candidate against the selected source revision, check dependency licenses and exported
sample data, replace provisional contact guidance, and review the final source inventory. Keep generated reports and local
planning archives under ignored `artifacts/`; they are not public source inputs.

A public GitHub source release can precede npm publication. The package's `private: true` prevents
npm registry publishing and does not prevent a public source repository. Keep that protection until
a separate registry release is configured, and record the exact released commit/tag and digest.
