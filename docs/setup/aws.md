# Prepare AWS and deploy

What gets created ([`sst.config.ts`](../../sst.config.ts)), all pay-per-use
with no fixed monthly charge:

- two Lambda functions: `Ingest`, behind a public Function URL, and
  `Reconcile`; arm64, no VPC, no provisioned concurrency;
- an SQS FIFO queue `Pokes` and its dead-letter queue;
- a DynamoDB table `Queues` (on-demand);
- an EventBridge rule running the sweep every 10 minutes;
- an EventBridge Scheduler group for wake-ups, plus the IAM role Scheduler
  uses to send them (ADR-0027);
- two SSM-backed `sst.Secret` values;
- CloudWatch log groups, each kept for 14 days.

Check [`docs/agent.md`](../agent.md) before provisioning: choose the account
and record it in your private notes, then tag and budget it.

## 1. A deploy role GitHub can assume (OIDC)

No long-lived AWS keys are used anywhere.

1. In IAM, add the identity provider `token.actions.githubusercontent.com`
   (audience `sts.amazonaws.com`) if the account does not have it.
2. Create a role whose trust policy admits only this repository's
   `production` environment:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:<DEPLOYING_ORG>/<DEPLOYING_REPO>:environment:production"
         }
       }
     }]
   }
   ```

3. Give it what SST needs to manage this stack: Lambda, SQS, DynamoDB,
   EventBridge, EventBridge Scheduler, IAM (the function and scheduler
   roles), SSM Parameter Store, CloudWatch Logs, and S3 for SST's state
   bucket. Use an account (or a boundary within one) for this service only.

   In an account shared with other applications, scope the role instead of
   granting those services broadly: resources are tagged
   `Application=merge-queue-diy`, and the three that a policy has to name are
   named `merge-queue-diy-<stage>-wakeups`, `-wakeup-delivery` and `-sweep`.
   If the role may only create roles that carry a permissions boundary, set
   `MERGE_QUEUE_ROLE_BOUNDARY_ARN` and every role the stack creates gets it.
   That boundary must still allow `iam:PassRole` on the `-wakeup-delivery`
   role to `scheduler.amazonaws.com`: Reconcile passes it when it schedules a
   wake-up.

## 2. GitHub settings on the repository that deploys

Create an environment named **`production`** (Settings → Environments),
ideally with required reviewers, then add:

| Name | Where | Value |
| --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | **repository** variable | the role above. It has to be a repository variable: the workflow's job-level `if` cannot see environment variables. |
| `AWS_REGION` | `production` variable | `<AWS_REGION>` |
| `MERGE_QUEUE_APP_ID` | `production` variable | from [github-app.md](./github-app.md). GitHub rejects variable names starting with `GITHUB_`; the workflow passes it to SST as `GITHUB_APP_ID`. |
| `MERGE_QUEUE_ALLOWED_OWNERS` | `production` variable | `<ORG>`, comma-separated if several |
| `RESOURCE_OWNER` | `production` variable | optional; the `Owner` tag |
| `MERGE_QUEUE_ROLE_BOUNDARY_ARN` | `production` variable | optional; a permissions boundary for every role the stack creates |
| `AUTOMERGE_TOKEN` | Actions **and** Dependabot secret | a fine-grained token (Contents, Pull requests, Workflows: read/write). The auto-merge workflows need it so a merge to `main` triggers the deploy. |

## 3. The two secrets

With credentials for the target account in your shell:

```bash
npx sst secret set GithubAppPrivateKey --stage production < path/to/app.private-key.pem
npx sst secret set GithubWebhookSecret "<the webhook secret>" --stage production
```

They are stored encrypted in SSM Parameter Store. The deploy links the
private key only to `Reconcile` and the webhook secret only to `Ingest`.

## 4. Deploy

Run the **Deploy** workflow (Actions → Deploy → Run workflow), or merge to
`main`. To check the config locally first:

```bash
AWS_REGION=<AWS_REGION> pnpm sst:check
```

The deploy prints `webhookUrl`. In the GitHub App's settings, set the
webhook URL to it, content type `application/json`, and tick **Active**.

## 5. Check it is alive

- **Advanced → Recent Deliveries** on the app shows `202` responses.
- Reconcile writes one JSON log line per reconcile to CloudWatch.
- A message that fails five times lands in `PokesDeadLetter`; check it now
  and then.
