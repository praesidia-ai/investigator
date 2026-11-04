# Examples

`acme-notes/` is the demo app: a small TypeScript notes app with a privacy policy (`docs/privacy.md`), a security
policy (`docs/security.md`) and a recorded agent-settings export (`policies/praesidia-support-agent.json`, whose
`dataRetentionDays: 90` contradicts privacy's 30 days). `acme-notes/branches/` holds the two planted breaks as
`git format-patch` files.

```sh
bash scripts/make-demo-repo.sh /tmp/acme-notes   # a fresh git repo: main, feature/csv-export, agent/retention
```

The demo scripts (`scripts/demo.sh`, `scripts/demo-live.sh`) build this repo in a temp folder on every run, so these
files are never changed. Authors and dates are fixed, so every build has the same commit shas. `.gitattributes` keeps
the files byte for byte (no line-ending conversion), so the patches apply and the shas stay the same on every OS.
