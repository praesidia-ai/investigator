# Security policy

## Report privately

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. Do not put exploits, keys, tokens or real
customer data in public issues or pull requests.

This is an early prototype maintained on a best-effort basis: there is no bug bounty and no response-time promise.
Only the latest `main` is supported.

## What to include

The commit you tested, the command, what you expected and what happened, and a minimal repro on synthetic data.
Redact model keys and provider account details.

## In scope

- A secret, or a `.env*`, `*.pem` or `*.key` file, reaching a model (the masker is `src/model/secrets.ts`).
- Text written by a model ending up as evidence: a policy quote not found in the policy, or a code quote not
  copied from git.
- A forged or edited run record that `jurator verify` accepts.
- A way for a branch or a coding agent to weaken the rules that its own push is checked against.
- A file in a checked repository that makes Jurator run code, or a rule pattern that escapes its time budget.

Known limits are documented in the README under "Not built yet". They are design limits, not vulnerabilities: hooks
fail open by default (`--fail-closed` changes that), and the agent hook reads commands but is not a shell.

Only test against repositories and accounts you own or are allowed to test.
