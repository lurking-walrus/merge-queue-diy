# ADR-0027: Wake-ups through EventBridge Scheduler; "every base" pokes are only fanned out

- Status: Accepted
- Date: 2026-11-23

## Context

`reconcile()` can return `wakeAfterSeconds`: the settle timer or
`max_wait_seconds` will expire with no webhook to announce it. Something has
to deliver a poke for that queue later.

Pokes travel on an SQS FIFO queue whose message group is the queue
(`owner/repo#base`), which is what guarantees one reconciler at a time per
queue. SQS FIFO does not support a per-message delay (`DelaySeconds` is
queue-wide on FIFO), so "send this poke in 120 seconds" cannot be done on the
queue itself.

Separately, check, status and comment events name no base branch, so ingest
produces a poke with `base: null`. Reconciling such a poke directly would run
outside the queue's own message group, alongside a reconcile of the same
queue from its group: two writers, which is exactly what FIFO grouping was
chosen to prevent.

## Decision

**Wake-ups are one-off EventBridge Scheduler schedules** that target the FIFO
queue directly (`at(...)`, `ActionAfterCompletion: DELETE`, the queue's
`MessageGroupId` in `SqsParameters`).

- One schedule per queue, named from a hash of the group id. A newer wake-up
  replaces a pending one (`CreateSchedule`, then `UpdateSchedule` on
  conflict): the latest reconcile's answer reflects the latest state.
- Scheduler fires with roughly one-minute precision, so wake-ups are rounded
  up to at least 60 seconds out. A wake-up due within a second (the reconcile
  loop's "come straight back") is sent to the queue at once instead.
- Scheduler cannot set a deduplication id, so the queue has content-based
  deduplication on. Every message carries an `id` saying why it was sent
  (`webhook:<delivery>`, `wake:<epoch>`, `sweep:<epoch>`), which keeps
  distinct pokes distinct. Messages the service sends itself also set an
  explicit `MessageDeduplicationId` derived from that id.

**A `base: null` poke is never reconciled.** The reconcile function resolves
it to base branches and sends one poke per base into that base's group:

- `/queue` or `/dequeue`: the base of the PR the comment was on;
- `/queue unfreeze`: every base with stored state;
- anything else: every base with stored state or an open PR.

The `base: null` poke has its own group (`owner/repo#*`) and only ever sends
messages, so it cannot race a queue's state.

The 10-minute sweep pokes every stored queue, and every stored repository once
with `base: null` so that bases with new PRs are found.

## Alternatives

- **A standard SQS queue with per-message `DelaySeconds`** (up to 15 minutes),
  plus a small forwarder Lambda moving due messages into the FIFO queue. It
  works, but adds a queue, a function and a hop, and caps the delay at 15
  minutes. Scheduler needs one IAM role and no code beyond the client call.
- **Step Functions wait states.** Per-execution cost and far more machinery
  than a delayed message needs.
- **Rely on the sweep alone.** Correct, since the sweep repairs everything,
  but it would make every settle period up to 10 minutes long.
- **One message group per repository.** Removes the fan-out but serializes
  every base branch of a repository behind each other.

## Consequences

- The reconcile function needs `scheduler:CreateSchedule` and
  `scheduler:UpdateSchedule`, plus `iam:PassRole` on a role that Scheduler
  assumes to call `sqs:SendMessage` on the queue. PR 3's infrastructure
  creates that role.
- A wake-up can arrive up to about a minute late. That only lengthens a
  settle or wait period.
- A schedule that fails to be created only delays the queue: the next webhook
  or the sweep reconciles it anyway.
