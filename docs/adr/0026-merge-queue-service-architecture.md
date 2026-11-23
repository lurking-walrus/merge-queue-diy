# ADR-0026: Merge queue as an event-driven Lambda service, not a Next.js app

- Status: Accepted
- Date: 2026-11-23

## Context

This repository was created from the Next.js application template, but what it
builds is a GitHub App: a merge queue for private repositories on plans
without GitHub's native one. The full design is in
[`docs/DESIGN.md`](../DESIGN.md).

The service has no pages, users, sessions, billing or relational data. It
receives webhooks, must process them strictly one at a time per repository and
base branch, and holds a credential with write access to every repository it
is installed on.

## Decision

- **TypeScript** on the template's existing toolchain (pnpm, Biome, Vitest,
  TypeScript 7) — ADRs 0002–0004, 0010 and 0025 continue to apply.
- **AWS Lambda behind a Function URL**, **SQS FIFO** (message group =
  repository + base branch) for serialization, **DynamoDB** on-demand for
  queue state, deployed with **SST** (ADR-0023's tool, different components).
- **`octokit`'s `App` directly**, not Probot; GitHub is reached through the
  REST API only and repository content is never cloned or executed.
- **A pure decision core** (`decide(snapshot) -> Action[]`) behind a thin I/O
  shell, tested against an in-memory GitHub simulator.
- **Secrets are `sst.Secret`** (app private key, webhook secret), each linked
  only to the function that needs it. Non-secret, deployment-specific values
  are environment variables. No account id, org name, domain or key is
  committed; see DESIGN.md §10.

## Consequences

- The template's web application — Next.js, better-auth, Stripe, Drizzle/Neon,
  the legal pages, the design system, Playwright and the render smoke — has no
  role in this service and is removed. This ADR supersedes 0005–0007, 0009,
  0011–0016, 0019–0022 and 0024. Environment validation (0006) survives as a
  plain Zod schema in `src/env.ts`, without the Next.js-specific wrapper.
- The deploy configuration is rewritten rather than adapted: one
  `sst.aws.Nextjs` becomes functions, a queue, a table and a schedule, with no
  CloudFront, certificate or DNS record. ADR-0023's choice of SST stands.
- Idle cost is zero and there is no server to patch, at the price of cold
  starts on the first webhook after a quiet period — irrelevant here, since
  ingest only has to acknowledge within GitHub's ten-second limit.
- Correctness lives in the pure core, so it can be developed and tested with
  no AWS account and no live repository.
