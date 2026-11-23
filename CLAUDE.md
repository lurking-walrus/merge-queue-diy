# CLAUDE.md

## Project overview

A self-hosted GitHub App that gives private repositories a batched merge queue
on plans without GitHub's native one. Design: [`docs/DESIGN.md`](./docs/DESIGN.md).
Architecture decision: [ADR-0026](./docs/adr/0026-merge-queue-service-architecture.md).

**This repository is public.** Never commit an account id, org or repository
name, domain, key or token. Deployment-specific values are environment
variables or `sst.Secret`s; docs and tests use placeholders such as
`<AWS_ACCOUNT_ID>` and `example-org` (DESIGN.md §10).

## What exists today

| Path | What it is | State |
| --- | --- | --- |
| `src/core/` | Pure decision logic: `decide`, `applyBuildResult`, `applyLandResult`, `applyCommand`, config schema | implemented, tested |
| `src/reconcile.ts` | Read → decide → act loop over the ports | implemented, tested |
| `src/ports.ts` | `GitHubPort` and `QueueStore` interfaces | implemented |
| `src/sim/` | In-memory GitHub implementing `GitHubPort`, plus end-to-end scenarios | implemented |
| `src/ingest/` | Webhook signature check and event → poke routing | implemented, tested |
| `src/env.ts` | Deployment environment schema | implemented, tested |
| `src/github/` | REST adapter implementing `GitHubPort` (`adapter.ts`), config loader, Octokit auth; `fake.ts` is an HTTP-level fake GitHub for tests | implemented, tested against the fake |
| `src/store/` | DynamoDB `QueueStore`, one item per queue, version-conditional writes | implemented, tested against a mocked client |
| `src/handlers/` | Lambda handlers: ingest (Function URL), reconcile (SQS FIFO + sweep), wake-ups via EventBridge Scheduler ([ADR-0027](./docs/adr/0027-wake-ups-and-queue-fan-out.md)) | implemented, tested |
| `sst.config.ts`, `.github/workflows/deploy.yml` | SST v4 stack and OIDC deploy on push to `main`; skipped until `AWS_DEPLOY_ROLE_ARN` is set | written, type-checked with `pnpm sst:check`; **never deployed** |
| `src/cli/` | `pnpm queue:plan <owner>/<repo> <base>`: read-only dry run, `decide()` once, prints actions, executes none (non-GET requests are refused in the client) | implemented, tested; run live read-only |
| `docs/setup/` | What a human does to go live: App registration, AWS/OIDC, secrets, per-repo config, ruleset | written |

Nothing has been deployed or has written to live GitHub or AWS. The adapter
is tested against `src/github/fake.ts` over intercepted HTTP (msw), and its
read path has run against live GitHub only through the read-only
`queue:plan` CLI. The AWS clients are tested only against
`aws-sdk-client-mock`. The reconcile handler logs one JSON line per message
(`src/handlers/log.ts`), built from an allowlist of fields.

## Rules that keep this correct

- **`src/core` is pure.** No I/O, no `Date.now()`, no randomness, no imports
  from outside `src/core`. Time arrives as `snapshot.now`. This is what makes
  the queue testable without GitHub; do not erode it.
- **Events are hints, never data.** A webhook only says which queue to look
  at. Decisions are made from what `GitHubPort` reads back.
- **A queue's state is only touched from its own SQS message group.** A
  `base: null` poke is fanned out into per-base pokes, never reconciled
  directly (ADR-0027).
- **Every effect must be safe to repeat.** A reconcile can crash between
  saving state and finishing an effect; the next one re-emits it.
- **The landed tree must equal the tested tree.** If it does not, the queue
  freezes. Never weaken that check to make something pass.
- **New behaviour gets a scenario** in `src/sim/scenarios.test.ts` driving the
  real `reconcile` loop, not only a unit test of `decide`. Every scenario runs
  twice — against the simulator and against the REST adapter over HTTP — so a
  change to either must keep both passing.
- Fork pull requests are never queued; only OWNER/MEMBER/COLLABORATOR comments
  are commands. Both are security boundaries.

## Commands

```bash
pnpm check[:fix]   # Biome lint + format
pnpm typecheck     # tsc --noEmit (also what `pnpm build` runs for now)
pnpm test          # Vitest
AWS_REGION=<AWS_REGION> pnpm sst:check   # evaluate + type-check sst.config.ts (no AWS calls)
GITHUB_TOKEN=… pnpm queue:plan <owner>/<repo> <base> [--config f] [--enforce]   # read-only dry run
```

A PreToolUse hook (`.claude/settings.json`) blocks `git commit` unless
`pnpm check && pnpm test` pass.

## Conventions

- Biome only; tabs; line width 100; double quotes; semicolons.
- TypeScript 7, strict, `noUncheckedIndexedAccess`
  ([ADR-0025](./docs/adr/0025-typescript-7.md)). pnpm pinned via
  `packageManager` ([ADR-0002](./docs/adr/0002-package-manager-pnpm-pinned.md)).
- Tests live beside the source as `*.test.ts`.
- Environment variables are declared in `src/env.ts` **and** `.env.example`.
  Read them through `loadEnv()`, not `process.env`. Error messages name the
  variable, never its value.
- Read the relevant ADR before changing foundational tooling; add a
  superseding ADR to change a decision. `docs/archive/` is historical only.
- CI comes from reusable workflows in `kornsour/gh-automation`
  ([ADR-0018](./docs/adr/0018-reusable-ci-workflows.md)) and runs on
  GitHub-hosted runners, which are free for a public repository.

## Infrastructure

Read [`docs/agent.md`](./docs/agent.md) before adding cloud resources. Do not
provision external or billable resources without explicit authority.
