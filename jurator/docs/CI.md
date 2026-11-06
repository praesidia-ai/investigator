# CI for your repository

`templates/ci/github-actions-jurator.yml` is a workflow for a team that uses Jurator on its own code. Copy it to
`.github/workflows/jurator.yml` and replace the placeholders (`<PIN-SHA>` for each action, `<INSTALL-STEP>`).

The workflow in this repository (`.github/workflows/jurator.yml`) tests Jurator itself. It is not a policy gate for
anyone's code.

## What it runs

1. `jurator check --diff origin/<base> --head HEAD --no-ai --md`: rules only. Exit `1` means a promise is broken.
2. `jurator report` and `jurator report --format sarif --out jurator.sarif` always run, then the artifact is uploaded.
3. An optional second job uploads the SARIF to GitHub code scanning. Only that job has `security-events: write`.

## SARIF meaning

- `error`: a rule (no AI) found a broken promise. Location is the exact cited line range copied from git.
- `note` with `properties.scope = "advisory-ai-read"`: an AI read says it looks broken. Not verified, never an error.
- `properties.detectorScope`, `openCounterexamples` and `detectorWarning` carry the rule's assurance when known
  (`limited-detector` means the rule misses some shapes).
- Not alerts, but listed in run `properties.notEvaluated`: can't-tell and not-checked promises.
- A dirty working tree sets `properties.dirty` and `reproducible: false`.
- Runtime or behavioral promises are not evaluated by this export. Only program-verified text and accepted promise wording appear in a result.
- Only citations at the run's head commit become locations; base-side citations go to `relatedLocations`. A result with no head citation is not an alert and is listed in `properties.notEvaluated`.
- Multi-repo workspace runs prefix paths with the repo name (`name/...`); those paths do not map to GitHub file paths.

Limits: the template is not run against a real GitHub runner by this repo's tests; SARIF structure is checked in
`tests/report/sarif.test.ts`.
