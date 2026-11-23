# Setting up a deployment

Everything here is done by a person with admin rights on the GitHub
organization and the AWS account. Nothing in this repository creates a GitHub
App or an AWS resource on its own. The deploy workflow is skipped until you
set `AWS_DEPLOY_ROLE_ARN`.

Placeholders: `<ORG>` is your GitHub organization or user, `<REPO>` a
repository to queue, `<AWS_ACCOUNT_ID>` and `<AWS_REGION>` your AWS account
and region. Record the real values in your own private notes (see
[`docs/agent.md`](../agent.md)), never in this public repository.

1. [Register the GitHub App](./github-app.md)
2. [Prepare AWS and deploy](./aws.md)
3. [Turn the queue on for a repository](./repository.md), in shadow mode first

The order matters in one place. The app's webhook URL comes from the first
deploy, so register the app with its webhook **inactive**, deploy, then paste
the URL in and activate it.

## Rolling back

- Stop acting on a repository: set `mode: shadow` or `enabled: false` in its
  `.github/merge-queue.yml`, or delete the file.
- Stop the service: deactivate the app's webhook. The 10-minute sweep still
  reconciles stored queues. To stop that too, disable the `Sweep` EventBridge
  rule, or uninstall the app.
- Enforcement only: put back the ruleset you replaced (`strict` required
  checks) and remove the `merge-queue` requirement.
