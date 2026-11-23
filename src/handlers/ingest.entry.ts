/**
 * Lambda entry point for the ingest function. Kept apart from the reconcile
 * entry so this bundle contains no GitHub client and never sees the private key.
 */

import { SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { loadIngestEnv } from "../env";
import { SqsOutbox } from "./aws";
import { createIngestHandler, type IngestResult } from "./ingest";
import { withLinkedSecrets } from "./secrets";

let handle: ((e: LambdaFunctionURLEvent) => Promise<IngestResult>) | undefined;

export async function handler(event: LambdaFunctionURLEvent): Promise<IngestResult> {
	if (!handle) {
		const env = loadIngestEnv(withLinkedSecrets({ GITHUB_WEBHOOK_SECRET: "GithubWebhookSecret" }));
		handle = createIngestHandler({ env, outbox: new SqsOutbox(new SQSClient({}), env.queueUrl) });
	}
	return handle(event);
}
