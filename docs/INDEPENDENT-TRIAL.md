# Independent installation trial

This is an unexecuted acceptance procedure for a developer who did not implement Investigator.
Automated clean-consumer testing does not count as a separate human's trial. Use a source archive or
the eventual pinned public source revision, without sibling Praesidia repositories or accounts.

## Procedure

1. Record the supplied source revision/archive digest, operating system, Node version and npm version.
2. Follow the README using `npm ci` and `npm run check`; record actual exit codes and any missing steps.
3. Run `node dist/bin.js repair-demo --out ./trial-repair` and verify its `repair.json` using the CLI.
4. Explain the difference between the claim verdict, execution status, report integrity and human acceptance.
5. With `python3` available, run `npm run demo:independent -- ./trial-independent`. Inspect both case
   reports and explain what the external observer established and what remains outside its scope.
6. Follow [ADAPTERS.md](ADAPTERS.md) to locate the configuration/driver seam. Confirm that target
   credentials remain outside the case/model context and that an unavailable observer cannot pass.
7. If separately authorized and given a local key, follow [META-MODELS.md](META-MODELS.md). Record
   the actual model and manifest; do not substitute scripted output for live evidence.
8. Send ordinary usability feedback through the maintainer's existing channel. Keep credentials and
   sensitive observations private. No submission or publication is part of this trial.

## Result record

Fill this only after performing the steps:

| Field                                                          | Actual observation |
| -------------------------------------------------------------- | ------------------ |
| Tester / date                                                  | Pending            |
| Source revision or archive SHA-256                             | Pending            |
| Operating system / Node / npm / Python                         | Pending            |
| Commands and actual exit codes                                 | Pending            |
| Defect reproduced / repair verified / permitted work preserved | Pending            |
| Independent Python target outcomes                             | Pending            |
| Time to first useful result                                    | Pending            |
| Instructions that needed help                                  | Pending            |
| Scope/uncertainty understood                                   | Pending            |
| Live Meta verification, if attempted                           | Not attempted      |
| Blocking issues                                                | Pending            |

Acceptance means the tester reproduces the declared supported workflow, understands its limits and
does not need undisclosed platform access or implementation help. It is not a production-readiness
certification or a guarantee about other applications.
