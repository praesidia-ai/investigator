# Jurator on two real open-source repos

Jurator (working name) ran live on two real products that publish their own privacy or security text in their repo.
Run on 4 Nov 2026 with `muse-wonder-1.0` (live). Both repos were shallow clones, treated as untrusted data: Jurator only
read files through git. We never ran their code, scripts or package installs. Total model cost: **$3.98** (cap $4).
Raw outputs and the `.jurator/` stores from these runs are not included in the repo.

| | GoatCounter | Documenso |
|---|---|---|
| Repo | [arp242/goatcounter](https://github.com/arp242/goatcounter) @ `c031008` | [documenso/documenso](https://github.com/documenso/documenso) @ `052aca2` |
| Licence | EUPL-1.2 (modified) | AGPL-3.0 |
| What it is | Go web analytics, code at the repo root | TypeScript monorepo (`apps/`, `packages/`) |
| Tracked files (code files) | 484 (178) | 3,008 (2,260) |
| Policies | `tpl/help/privacy.md` (5.6 KB), `tpl/help/gdpr.md` (3.5 KB): goatcounter.com's live policy | `apps/docs/content/docs/policies/security.mdx` (9.4 KB), `.../compliance/gdpr.mdx` (7.1 KB) |

## GoatCounter

| Step | Result | Time | Cost |
|---|---|---|---|
| `init` (before the fix) | found **no** policy, and the default code scope (`src/**`, `app/**`, `lib/**`) matched **no** code | 1 s | $0 |
| `compile --accept` | **29 promises** (23 code, 2 runtime, 4 process); 29/29 quotes found word for word; 0 conflicts (375 pairs) | 69 s | $0.23 |
| `rule propose --all` | 13 rules written; 1 failed on today's code (a test file matched); 9 not tried because the run hit its budget | 122 s | $1.63 |
| Human review | **8 accepted, 5 rejected** (see finding 2) | | |
| `bind --all --no-model` | 3 of 23 promises bound from rules (must-not-match rules give no location) | 4 s | $0 |
| `check --full` | **8 HOLDS** (rules); AI reads: **3 LOOKS BROKEN**, 4 CAN'T TELL, 1 LOOKS KEPT; 7 not read (run budget); 4 "Before merge" items | 34 s | $0.61 |
| Rule coverage | **8 of 23** code promises (35%) | | |

## Documenso

| Step | Result | Time | Cost |
|---|---|---|---|
| `init` (before the fix) | found only the root `SECURITY.md` (a disclosure page); missed the `.mdx` policies; scope matched no code | 1 s | $0 |
| `compile --accept` | **50 promises** (13 code, 19 runtime, 18 process); 50/50 quotes found word for word; 0 conflicts (1,225 pairs) | 58 s | $0.24 |
| `rule propose --all` | 12 rules written, 1 "no rule possible" (gdpr.16); about 90 s of it was spent reading files from git | 147 s | $0.83 |
| Human review | **8 accepted, 4 rejected** (see finding 2) | | |
| `rule test` (8 rules, about 2,200 files) | all pass. **62 s before the git fix, 1 s after**, same output | 1 s | $0 |
| `bind --all` | 10 of 13 bound (8 from rules, no AI; 2 from the model, checked by the program); 1 answer cut off at the output limit | 25 s | $0.20 |
| `check --full` | **8 HOLDS** (rules); AI reads: **1 LOOKS BROKEN**, 4 CAN'T TELL; 18 "Before merge" items | 17 s | $0.24 |
| Rule coverage | **8 of 13** code promises (62%) | | |
