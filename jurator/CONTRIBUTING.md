# Contributing

Thanks for helping. Jurator is an early prototype, so small, focused pull requests work best.

## Set up

Needs Node 22.12 or newer and git.

```sh
npm ci
npm run check      # typecheck + tests + build; must pass before you open a PR
```

Everything except `compile`, `rule propose` and the AI reads in `check` works offline. Tests never call the network:
they use scripted model answers in `fixtures/scripted/`.

## Before you change code

Read [`AGENTS.md`](AGENTS.md). It holds the product principles (only a rule may say BROKEN; model text never becomes
evidence), the tech rules (zod is the only runtime dependency, `src/contracts.ts` is append-only), and the areas of
the code. Coding agents follow the same file.

## Pull requests

- One change per PR, inside one area where possible, with tests for new behaviour.
- Say what changed and how you checked it. If you made live model calls, say which model and what they cost.
- Messages a user sees use plain words and end with a `Next:` hint when there is a next step.
- Never commit `.env` files, keys, tokens, or real customer policies or code. Use synthetic data in fixtures.

## Reporting bugs

Open an issue with the command, what you expected, what happened, and a small repro on synthetic data.
Security problems go through [`SECURITY.md`](SECURITY.md), not a public issue.

## Licence

By contributing you agree that your contribution is licensed under Apache-2.0, as the rest of the project is (see
[`LICENSE`](LICENSE), section 5).
