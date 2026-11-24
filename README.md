# merge-queue-diy

A self-hosted GitHub App that gives private repositories a batched merge
queue on plans where GitHub's own is not available.

**Status: running.** Deployed to AWS and enforcing on a real private
repository. Start with [`docs/DESIGN.md`](./docs/DESIGN.md) and
[ADR-0026](./docs/adr/0026-merge-queue-service-architecture.md); to run your
own, [`docs/setup/`](./docs/setup/README.md).

## Why

With "Require branches to be up to date before merging" (`strict`) on, every
merge to `main` leaves each open PR behind. Each one is updated (by hand, or by
a workflow calling update-branch) and that new commit reruns its full CI. To
land n concurrent PRs costs about n²/2 CI runs. With AI agents opening many
overlapping PRs, that exhausts a month of Actions minutes in days.

Turning `strict` off stops the reruns, but then nothing ever tests PRs
*together*: two PRs that pass on their own can break `main` once both land.

The queue gives you both, the way GitHub's own merge queue does:

- A PR runs CI once, on its own commits. It reruns only when its author pushes.
- Waiting PRs are squashed onto the latest `main` on a separate batch branch,
  `mq/<base>/<id>`, and CI runs **once for the whole batch** (up to
  `batch_size` PRs).
- On green, each PR is merged at the exact commit that was tested, and the
  queue checks that `main`'s tree equals the tested tree (it freezes if not).
- **PR branches are never updated.** When `main` moves, open PRs are left
  alone; only the next batch is built on the new `main`.

So the cost is about one run per PR plus one per batch, instead of n²/2. If
your repositories already run with `strict` off, the queue costs slightly
*more* CI than today (the batch run), and what it buys is a tested `main`.

## Requirements

What a repository needs for the queue to work. Each is checked or explained in
[`docs/setup/repository.md`](./docs/setup/repository.md).

| Requirement | Why | If it is wrong |
| --- | --- | --- |
| **"Require branches to be up to date before merging" (`strict`) is OFF** on the base branch, in every ruleset that applies to it, including organization rulesets. | The queue lands a batch's PRs one after another through the merge API. With `strict` on, GitHub refuses every PR after the first, because it is now behind. The batch test is what replaces `strict`. GitHub's own merge queue replaces it in the same way. | Enforce mode **pauses**: no batches are built, every queued PR's `merge-queue` check says why, and every reconcile logs a `warn` line. It resumes by itself once `strict` is off. The dry run prints a warning. Classic branch protection is not visible to the app; check it by hand. |
| **Nothing updates PR branches or auto-merges PRs.** Remove auto-merge workflows and any update-branch automation. | Either would merge or rerun CI around the queue. | Untested merges, and the reruns the queue exists to remove. |
| **CI runs on pushes to `mq/**`** for every check in `required_checks`. | Batches are tested on those branches. | Batches wait for checks that never come. |
| **`.github/merge-queue.yml`** on the default branch, starting with `mode: shadow`. | Opt-in per repository; shadow reports what would happen and changes nothing. | No file: the queue is off. An invalid file: off, and each PR's check says why. |
| **Same-repository PRs.** | Fork PRs are never queued: a batch branch runs CI with the repository's secrets. | Fork PRs stay unqueued. |
| Optional: the ruleset requires the single check **`merge-queue`** (pinned to this app) instead of the CI checks. | Stops hand merges from going around the queue. Needs rulesets (a paid plan for private repositories). | Without it, the queue is the gate by convention; a hand merge is treated like any other move of `main`. |

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
| Decision core, reconcile loop, simulator scenarios | implemented, tested |
| GitHub REST adapter, webhook intake, DynamoDB store, Lambda handlers | implemented, tested; running in production |
| SST stack and OIDC deploy workflow | deployed |
| Dry-run CLI (`pnpm queue:plan`) | implemented, tested; run against live repositories |

Every scenario runs twice: against the in-memory simulator and against the
REST adapter over HTTP.

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
