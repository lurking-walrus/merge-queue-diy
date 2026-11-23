# Turn the queue on for a repository

Do these on each repository you want queued, in order. Steps 1 and 2 are
shadow mode: the app reports what it *would* do and changes nothing. Steps 3
and 4 make it act.

## 1. `.github/merge-queue.yml` on the default branch

Start in shadow mode. All keys are in DESIGN.md §9, and unknown keys are
rejected.

```yaml
enabled: true
mode: shadow
required_checks: [ci]   # the check-run (or status) names CI reports on a commit
# pr_checks: [ci]       # defaults to required_checks
# batch_size: 5
# settle_seconds: 120
# max_wait_seconds: 300
# merge_method: squash  # or merge (fast-forward; see DESIGN.md §6)
```

- No file means the queue is off for that repository.
- An invalid file turns it off too, and every open PR's `merge-queue` check
  says why.

Before merging the file, preview what the queue would do with the read-only
dry-run CLI:

```bash
GITHUB_TOKEN=<a read-only token> pnpm queue:plan <ORG>/<REPO> main
```

In shadow mode each open PR gets a `merge-queue` check such as
`[shadow] would be queued (#2 of 5)`. Compare it with what actually merges
for a while (DESIGN.md §13).

## 2. Let CI run on batch branches

Batches are tested on branches named `mq/<base>/<id>`. Add this trigger to
the workflow that reports your `required_checks`:

```yaml
on:
  pull_request:
  push:
    branches: ['mq/**']
```

Scratch branches (`mq-build/**`) deliberately do not match. If your workflow
has a `concurrency` group keyed on the ref, batch branches each get their own,
which is what you want.

Batch branches only appear in enforce mode, so this trigger can land at any
time.

## 3. Enforce

Set `mode: enforce`. From then on the app builds batches, waits for
`required_checks` on the batch commit, and merges.

Also remove whatever made PRs merge before: an auto-merge workflow, and any
automation that updates PR branches.

## 4. Change the ruleset on the base branch

This is DESIGN.md §7. It needs rulesets, which on private repositories
require a paid plan (Team or above). On a Free plan the queue still works,
but the gate is a convention.

On the default-branch ruleset:

1. Under **Require status checks to pass**, replace the list of CI checks
   with the single check **`merge-queue`**, and pin its source to this GitHub
   App so nothing else can satisfy it.
2. Turn **off** "Require branches to be up to date before merging"
   (`strict`).
3. Squash mode needs no bypass. Merge mode lands by fast-forwarding the base
   branch, so add the app as a **bypass actor** for the pull-request rule.
4. Keep your own admin bypass for emergencies. The queue treats a hand merge
   like any other move of the base branch.

To undo, restore the previous required checks and `strict`.
