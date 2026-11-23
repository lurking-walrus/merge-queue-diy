/**
 * Lambda entry point for the reconcile function: SQS FIFO batches, and the
 * EventBridge sweep schedule.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { loadReconcileEnv } from "../env";
import { repositoryOctokit } from "../github/octokit";
import { DynamoQueueTable } from "../store/dynamo";
import { SchedulerWaker, SqsOutbox } from "./aws";
import { createReconcileHandler, type ReconcileDeps, sweep } from "./reconcile";
import { withLinkedSecrets } from "./secrets";

let deps: ReconcileDeps | undefined;

function build(): ReconcileDeps {
	const env = loadReconcileEnv(
		withLinkedSecrets({ GITHUB_APP_PRIVATE_KEY: "GithubAppPrivateKey" }),
	);
	const now = () => Math.floor(Date.now() / 1000);
	const outbox = new SqsOutbox(new SQSClient({}), env.queueUrl);
	return {
		appId: Number(env.appId),
		allowedOwners: env.allowedOwners,
		table: new DynamoQueueTable(new DynamoDBClient({}), env.table),
		github: (installationId, repo) =>
			repositoryOctokit({ appId: env.appId, privateKey: env.privateKey }, installationId, repo),
		outbox,
		waker: new SchedulerWaker(new SchedulerClient({}), outbox, {
			queueArn: env.queueArn,
			roleArn: env.schedulerRoleArn,
			group: env.scheduleGroup,
			now,
		}),
		now,
		log: (line) => console.log(JSON.stringify(line)),
	};
}

type ScheduledEvent = { "detail-type": "Scheduled Event" };

export async function handler(
	event: SQSEvent | ScheduledEvent,
): Promise<SQSBatchResponse | { swept: number }> {
	deps ??= build();
	if ("Records" in event) return createReconcileHandler(deps)(event);
	return { swept: await sweep(deps) };
}
