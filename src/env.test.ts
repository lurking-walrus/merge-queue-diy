import { describe, expect, it } from "vitest";
import { loadIngestEnv, loadReconcileEnv } from "./env";

const QUEUE = "https://sqs.<AWS_REGION>.amazonaws.com/<AWS_ACCOUNT_ID>/merge-queue.fifo";

describe("loadIngestEnv", () => {
	const good = {
		GITHUB_WEBHOOK_SECRET: "test-only-webhook-secret",
		MERGE_QUEUE_ALLOWED_OWNERS: " Example-Org, another ",
		MERGE_QUEUE_QUEUE_URL: "https://sqs.example.test/000000000000/merge-queue.fifo",
	};

	it("normalizes the owner allowlist", () => {
		expect(loadIngestEnv(good).allowedOwners).toEqual(["example-org", "another"]);
	});

	it("names what is missing without echoing any value", () => {
		const attempt = () =>
			loadIngestEnv({ ...good, GITHUB_WEBHOOK_SECRET: "short", MERGE_QUEUE_ALLOWED_OWNERS: "" });
		expect(attempt).toThrow(/GITHUB_WEBHOOK_SECRET, MERGE_QUEUE_ALLOWED_OWNERS/);
		expect(attempt).not.toThrow(/short/);
	});

	it("does not need, or read, the app private key", () => {
		expect(() => loadIngestEnv(good)).not.toThrow();
	});
});

describe("loadReconcileEnv", () => {
	const good = {
		GITHUB_APP_ID: "12345",
		GITHUB_APP_PRIVATE_KEY: "test-only-not-a-real-key",
		MERGE_QUEUE_ALLOWED_OWNERS: "example-org",
		MERGE_QUEUE_TABLE: "merge-queue",
		MERGE_QUEUE_QUEUE_URL: "https://sqs.example.test/000000000000/merge-queue.fifo",
		MERGE_QUEUE_QUEUE_ARN: "arn:aws:sqs:<AWS_REGION>:<AWS_ACCOUNT_ID>:merge-queue.fifo",
		MERGE_QUEUE_SCHEDULER_ROLE_ARN: "arn:aws:iam::<AWS_ACCOUNT_ID>:role/scheduler",
	};

	it("does not need, or read, the webhook secret, and defaults the schedule group", () => {
		expect(loadReconcileEnv(good).scheduleGroup).toBe("default");
	});

	it("rejects a malformed app id or queue address by name", () => {
		const attempt = () =>
			loadReconcileEnv({ ...good, GITHUB_APP_ID: "abc", MERGE_QUEUE_QUEUE_URL: QUEUE.slice(8) });
		expect(attempt).toThrow(/GITHUB_APP_ID, MERGE_QUEUE_QUEUE_URL/);
		expect(attempt).not.toThrow(/test-only-not-a-real-key/);
	});
});
