# Security policy

## Report privately

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/praesidia-ai/investigator/security/advisories/new),
or open the repository's **Security → Advisories → Report a vulnerability** form while signed in.
Private vulnerability reporting is enabled for this repository. Reports are handled by repository
maintainers with advisory access; no response-time commitment or bug-bounty program is established.

Do not disclose exploits, credentials, customer evidence or personal information in public issues
or pull requests. Ordinary bug reports can use the public issue tracker after sensitive details
have been removed. If the private form is unavailable, contact a known maintainer through an existing
private channel and withhold sensitive details until a secure reporting route is restored.

Maintainers must review incoming reports and keep the reporting route available. Enabling the route
does not by itself verify human monitoring, notification delivery or a response time.

## What to include

Send the component version or source revision, affected command or API, expected and observed
behavior, a minimal reproduction using synthetic data, and the relevant environment. Explain the
security impact and any source-access or execution assumptions. Redact model keys, provider account
details and customer artifacts. Request a secure transfer method before sending sensitive evidence.

## Component scope

Relevant boundaries include evidence loading, path and size limits, tool authority, provider
credential handling, report rendering and verification, target provenance, and the supported repair
workflow. A result that improperly turns missing evidence or an execution error into a conclusive
finding is also relevant.

This component does not grant permission to test Praesidia's hosted platform, another person's
repository, provider accounts or third-party services. Use owned synthetic cases and authorized
targets. Do not access or retain another user's data to demonstrate an issue.

## Current operating boundaries

- Selected evidence can be sent to the configured model provider during an explicit live run. Keys
  belong in the process environment, outside evidence and exported cases.
- Reports retain selected evidence. Review and redact them before sharing.
- The authored external application is a separate process, not an OS security sandbox for arbitrary
  untrusted repository code.
- Report verification checks consistency against supplied manifests and recorded observations. It
  does not establish independently trusted authorship or rerun the target.
- Only the current development version is under active maintenance. There are no published release
  branches or promised support periods yet.

See [README.md](README.md) for the supported execution and evidence semantics.
