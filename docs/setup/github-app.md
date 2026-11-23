# Register the GitHub App

Each deployment registers **its own** private GitHub App (DESIGN.md §11).
There is no shared hosted instance.

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**, on
the organization that owns the repositories, and set:

| Field | Value |
| --- | --- |
| Name | anything, e.g. `<ORG>-merge-queue` |
| Homepage URL | this repository, or your own docs |
| Webhook | **Active: off** for now. You fill in the URL after the first deploy ([aws.md](./aws.md)). |
| Webhook secret | generate one: `openssl rand -hex 32`. Keep it for `sst secret set GithubWebhookSecret`. |
| Where can this GitHub App be installed? | **Only on this account** |

## Repository permissions

| Permission | Access | Used for |
| --- | --- | --- |
| Contents | Read and write | batch branches, merges, reading `.github/merge-queue.yml` |
| Pull requests | Read and write | listing, merging and commenting on PRs |
| Checks | Read and write | the `merge-queue` check run; reading CI check runs |
| Commit statuses | Read-only | CI that reports through legacy statuses |
| Actions | Read and write | cancelling superseded workflow runs |
| Workflows | Read and write | without it, a batch containing a `.github/workflows/**` change cannot be pushed |
| Issues | Read and write | the "queue frozen" issue; ejection comments go through the issues API |
| Metadata | Read-only | mandatory |

## Events

Subscribe to: **Pull request**, **Push**, **Check run**, **Status**,
**Issue comment**, **Installation repositories**. Only a check that *finished*
pokes the queue (a completed check run other than its own, a status that is no
longer pending); **Check suite** and **Workflow run** add nothing and can be
left off.

## After creating it

1. Note the numeric **App ID**. It becomes the `MERGE_QUEUE_APP_ID` Actions variable
   ([aws.md](./aws.md)), which the deploy passes to SST as `GITHUB_APP_ID`.
2. **Generate a private key** and download the `.pem`. It becomes
   `sst secret set GithubAppPrivateKey`. Do not commit it; `*.pem` is
   git-ignored. Delete the local file once the secret is set.
3. **Install** the app on the account and choose **only the repositories**
   you want queued. Installing on more is harmless: a repository without
   `.github/merge-queue.yml` is ignored.
4. The account login goes in `MERGE_QUEUE_ALLOWED_OWNERS`. Events from any
   other installation are dropped.
