# merge-queue-diy

A self-hosted GitHub App that gives private repositories a batched merge
queue on plans where GitHub's own is not available.

**Status: early.** The decision core is built and tested; the parts that talk
to GitHub and AWS are not, so it cannot be deployed yet. Start with
[`docs/DESIGN.md`](./docs/DESIGN.md) and
[ADR-0026](./docs/adr/0026-merge-queue-service-architecture.md).

## Why

Auto-merge plus "require branches up to date" retests every open pull request
each time any one of them lands — about n²/2 CI runs to land n concurrent PRs.
With AI agents opening many overlapping PRs, that exhausts a month of Actions
minutes in days.

The queue tests each PR once in a batch against the exact `main` it will land
on, finds conflicts before spending CI on them, and never updates a PR branch.

## Shape

- TypeScript on AWS Lambda, SQS FIFO for per-repo serialization, DynamoDB for
  queue state, deployed with SST. $0 at rest.
- Talks to GitHub through the REST API only. It never clones or runs
  repository code.
- A pure `decide(snapshot) -> actions` core, tested against an in-memory
  GitHub simulator.
- You register your own GitHub App and deploy to your own AWS account. Every
  secret and account-specific value is supplied at deploy time
  ([DESIGN.md §10](./docs/DESIGN.md#10-service-configuration-and-secrets));
  none is committed.

## Status

| Piece | State |
| --- | --- |
| Decision core (`src/core`) | implemented, tested |
| Reconcile loop and ports | implemented, tested against the simulator |
| In-memory GitHub simulator and end-to-end scenarios | implemented |
| Webhook signature check and event routing | implemented, tested |
| GitHub REST adapter (`src/github`) | implemented, tested against an HTTP-level fake GitHub; never run against live GitHub |
| DynamoDB store and Lambda handlers (`src/store`, `src/handlers`) | implemented, tested against mocked AWS clients; never run on AWS |
| SST config and deploy workflow | written and type-checked; never deployed |
| Dry-run CLI (`pnpm queue:plan`) and structured logs | implemented, tested; the CLI's read path has run against live GitHub |

Nothing has run against live GitHub or AWS. To deploy your own, follow
[`docs/setup/`](./docs/setup/README.md).

## Develop

```bash
corepack enable && pnpm install
pnpm check      # Biome
pnpm typecheck  # tsc
pnpm test       # Vitest — includes the simulator scenarios

# Read-only dry run against a real repository: prints what the queue would do.
GITHUB_TOKEN=$(gh auth token) pnpm queue:plan <owner>/<repo> main --enforce
```

The scenarios in [`src/sim/scenarios.test.ts`](./src/sim/scenarios.test.ts) are
the quickest way to see what the queue does: ten PRs landing in two CI runs, a
conflicting PR ejected before any CI is spent, a red batch bisected down to the
one PR that broke it.

## Licence

[MIT](./LICENSE).
