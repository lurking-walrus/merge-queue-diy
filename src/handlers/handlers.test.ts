import { createHmac } from "node:crypto";
import {
	ConflictException,
	CreateScheduleCommand,
	SchedulerClient,
	UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaFunctionURLEvent, SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../github/config";
import { FAKE_APP_ID, FAKE_OWNER, FAKE_REPO, FakeGitHub } from "../github/fake";
import { QueueOctokit } from "../github/octokit";
import { interceptGitHub } from "../github/testing";
import { DynamoQueueTable } from "../store/dynamo";
import { memoryDynamo } from "../store/testing";
import { atExpression, SchedulerWaker, SqsOutbox, scheduleName } from "./aws";
import { createIngestHandler } from "./ingest";
import { deduplicationId, messageGroupId, type QueueMessage } from "./messages";
import { createReconcileHandler, handleMessage, type ReconcileDeps, sweep } from "./reconcile";

const github = interceptGitHub();
beforeAll(() => github.server.listen({ onUnhandledFrame: "error" }));
afterEach(() => github.server.resetHandlers());
afterAll(() => github.server.close());

const SECRET = "test-only-webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

// --- Ingest -----------------------------------------------------------------

function urlEvent(o: {
	body: string;
	headers?: Record<string, string>;
	method?: string;
	base64?: boolean;
}): LambdaFunctionURLEvent {
	return {
		body: o.base64 ? Buffer.from(o.body).toString("base64") : o.body,
		isBase64Encoded: o.base64 ?? false,
		headers: o.headers ?? {},
		requestContext: { http: { method: o.method ?? "POST" } },
	} as unknown as LambdaFunctionURLEvent;
}

describe("ingest handler", () => {
	const payload = JSON.stringify({
		installation: { id: 42 },
		repository: { name: FAKE_REPO, owner: { login: FAKE_OWNER } },
		pull_request: { base: { ref: "main" } },
	});
	const headers = (body: string) => ({
		"x-hub-signature-256": sign(body),
		"x-github-event": "pull_request",
		"x-github-delivery": "delivery-1",
	});
	const setup = () => {
		const sent: QueueMessage[] = [];
		const handle = createIngestHandler({
			env: {
				webhookSecret: SECRET,
				allowedOwners: [FAKE_OWNER],
				queueUrl: "https://sqs.example.test/q",
			},
			outbox: { send: async (m) => void sent.push(m) },
		});
		return { sent, handle };
	};

	it("verifies the raw body, routes it and enqueues one poke keyed by delivery", async () => {
		const { sent, handle } = setup();
		const res = await handle(urlEvent({ body: payload, headers: headers(payload) }));
		expect(res.statusCode).toBe(202);
		expect(sent).toEqual([
			{
				installationId: 42,
				owner: FAKE_OWNER,
				repo: FAKE_REPO,
				base: "main",
				id: "webhook:delivery-1",
			},
		]);
	});

	it("accepts a base64-encoded body, verifying the decoded bytes", async () => {
		const { sent, handle } = setup();
		const res = await handle(urlEvent({ body: payload, headers: headers(payload), base64: true }));
		expect(res.statusCode).toBe(202);
		expect(sent).toHaveLength(1);
	});

	it("rejects anything unsigned or mis-signed with 401 and enqueues nothing", async () => {
		const { sent, handle } = setup();
		const { "x-hub-signature-256": _, ...unsigned } = headers(payload);
		expect((await handle(urlEvent({ body: payload, headers: unsigned }))).statusCode).toBe(401);
		const reformatted = JSON.stringify(JSON.parse(payload), null, 2);
		expect(
			(await handle(urlEvent({ body: reformatted, headers: headers(payload) }))).statusCode,
		).toBe(401);
		expect(sent).toEqual([]);
	});

	it("answers non-POST, non-JSON and ignorable events without enqueuing", async () => {
		const { sent, handle } = setup();
		expect((await handle(urlEvent({ body: payload, method: "GET" }))).statusCode).toBe(405);
		expect((await handle(urlEvent({ body: "nope", headers: headers("nope") }))).statusCode).toBe(
			400,
		);
		const star = JSON.stringify({
			installation: { id: 42 },
			repository: JSON.parse(payload).repository,
		});
		const res = await handle(
			urlEvent({ body: star, headers: { ...headers(star), "x-github-event": "star" } }),
		);
		expect(res.statusCode).toBe(202);
		expect(sent).toEqual([]);
	});
});

// --- Messages and AWS adapters ---------------------------------------------

describe("message grouping", () => {
	const m: QueueMessage = {
		installationId: 1,
		owner: "Example-Org",
		repo: "Widgets",
		base: "main",
		id: "x",
	};

	it("groups by repository and base, with one separate group for 'every base'", () => {
		expect(messageGroupId(m)).toBe("example-org/widgets#main");
		expect(messageGroupId({ ...m, base: null })).toBe("example-org/widgets#*");
		expect(messageGroupId({ ...m, base: "feature/ünïcode" })).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("deduplicates on the message id within a group", () => {
		expect(deduplicationId(m)).toBe(deduplicationId({ ...m }));
		expect(deduplicationId(m)).not.toBe(deduplicationId({ ...m, id: "y" }));
		expect(deduplicationId(m)).toHaveLength(64);
	});
});

describe("AWS adapters", () => {
	const m: QueueMessage = {
		installationId: 1,
		owner: "example-org",
		repo: "widgets",
		base: "main",
		id: "wake:1",
	};
	const sqs = mockClient(SQSClient);
	const scheduler = mockClient(SchedulerClient);
	afterEach(() => {
		sqs.reset();
		scheduler.reset();
	});

	it("sends to SQS FIFO with the queue's group and a dedup id", async () => {
		await new SqsOutbox(new SQSClient({ region: "us-east-1" }), "https://sqs.example.test/q").send(
			m,
		);
		expect(sqs.commandCalls(SendMessageCommand)[0]?.args[0].input).toEqual({
			QueueUrl: "https://sqs.example.test/q",
			MessageBody: JSON.stringify(m),
			MessageGroupId: "example-org/widgets#main",
			MessageDeduplicationId: deduplicationId(m),
		});
	});

	it("schedules one self-deleting wake-up per queue, replacing a pending one", async () => {
		const sent: QueueMessage[] = [];
		const waker = new SchedulerWaker(
			new SchedulerClient({ region: "us-east-1" }),
			{ send: async (x) => void sent.push(x) },
			{
				queueArn: "arn:aws:sqs:r:a:q.fifo",
				roleArn: "arn:aws:iam::a:role/r",
				group: "default",
				now: () => 1_000,
			},
		);
		await waker.wakeAt(m, 1_120);
		const input = scheduler.commandCalls(CreateScheduleCommand)[0]?.args[0].input;
		expect(input).toMatchObject({
			Name: scheduleName(m),
			ScheduleExpression: atExpression(1_120),
			ActionAfterCompletion: "DELETE",
			Target: {
				Arn: "arn:aws:sqs:r:a:q.fifo",
				SqsParameters: { MessageGroupId: "example-org/widgets#main" },
			},
		});

		scheduler
			.on(CreateScheduleCommand)
			.rejects(new ConflictException({ message: "exists", Message: "exists", $metadata: {} }));
		await waker.wakeAt(m, 1_010); // sooner than Scheduler can fire: rounded up to a minute
		expect(scheduler.commandCalls(UpdateScheduleCommand)[0]?.args[0].input.ScheduleExpression).toBe(
			atExpression(1_060),
		);

		await waker.wakeAt(m, 1_001); // "come straight back"
		expect(sent).toEqual([m]);
	});
});

// --- Reconcile ---------------------------------------------------------------

let db: ReturnType<typeof memoryDynamo> | undefined;
afterEach(() => {
	db?.restore();
	db = undefined;
});

function reconcileWorld(
	configText:
		| string
		| null = "mode: enforce\nrequired_checks: [ci]\nsettle_seconds: 0\nmax_wait_seconds: 0\n",
) {
	const fake = new FakeGitHub();
	github.use(fake);
	if (configText !== null) fake.files.set(CONFIG_PATH, configText);
	db = memoryDynamo();
	const sent: QueueMessage[] = [];
	const wakes: { m: QueueMessage; at: number }[] = [];
	const logs: Record<string, unknown>[] = [];
	const table = new DynamoQueueTable(db.client, "merge-queue");
	const deps: ReconcileDeps = {
		appId: FAKE_APP_ID,
		allowedOwners: [FAKE_OWNER],
		table,
		github: async () => new QueueOctokit({ auth: "test-token" }),
		outbox: { send: async (m) => void sent.push(m) },
		waker: { wakeAt: async (m, at) => void wakes.push({ m, at }) },
		now: () => fake.now,
		log: (l) => void logs.push(l),
	};
	const poke = (o: Partial<QueueMessage> = {}): QueueMessage => ({
		installationId: 42,
		owner: FAKE_OWNER,
		repo: FAKE_REPO,
		base: "main",
		id: "webhook:d1",
		...o,
	});
	return { fake, db, sent, wakes, logs, table, deps, poke };
}

describe("reconcile handler", () => {
	it("reconciles one queue end to end and stores its state", async () => {
		const w = reconcileWorld();
		w.fake.openPull({ "a.txt": "a" });
		w.fake.openPull({ "b.txt": "b" });
		w.fake.finishCi();

		expect(await handleMessage(w.deps, w.poke())).toEqual({
			kind: "reconciled",
			wakeAfterSeconds: null,
			batchId: 1,
			actions: { build: 1, report: 2 },
		});

		expect(w.fake.branchNames()).toEqual(["main", "mq/main/1"]);
		expect(
			(await w.table.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base: "main" }, 42).load()).batch
				?.status,
		).toBe("testing");
	});

	it("schedules the wake-up the core asks for", async () => {
		const w = reconcileWorld("mode: enforce\nrequired_checks: [ci]\nsettle_seconds: 120\n");
		w.fake.openPull({ "a.txt": "a" });
		w.fake.finishCi();

		await handleMessage(w.deps, w.poke());

		expect(w.wakes).toEqual([
			{ m: w.poke({ id: `wake:${w.fake.now + 120}` }), at: w.fake.now + 120 },
		]);
	});

	it("does nothing for a repository without a config file", async () => {
		const w = reconcileWorld(null);
		w.fake.openPull({ "a.txt": "a" });
		expect(await handleMessage(w.deps, w.poke())).toEqual({ kind: "disabled" });
		expect(w.db.items.size).toBe(0);
	});

	it("says why on each PR's check when the config file is invalid", async () => {
		const w = reconcileWorld("required_checks: [ci]\nbatch_sise: 3\n");
		const pr = w.fake.openPull({ "a.txt": "a" });
		expect(await handleMessage(w.deps, w.poke())).toEqual({ kind: "invalid-config" });
		expect(w.fake.queueChecks(w.fake.headOf(pr))[0]?.output.title).toContain("batch_sise");
		expect(w.db.items.size).toBe(0);
	});

	it("fans a poke for every base out to stored bases and bases with open PRs", async () => {
		const w = reconcileWorld();
		w.fake.openPull({ "a.txt": "a" });
		const release = w.table.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base: "release" }, 42);
		await release.save(await release.load());

		const out = await handleMessage(w.deps, w.poke({ base: null, id: "webhook:d2" }));

		expect(out.kind).toBe("fanned-out");
		expect(w.sent.map((m) => [m.base, m.id]).sort()).toEqual([
			["main", "webhook:d2>main"],
			["release", "webhook:d2>release"],
		]);
	});

	it("settles a poke for a branch no queue lives on with one read, forgetting a stale queue", async () => {
		const w = reconcileWorld();
		w.fake.openPull({ "a.txt": "a" }); // targets main, not the branch below
		const stale = w.table.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base: "backup/x" }, 42);
		await stale.save(await stale.load());
		w.fake.requests.length = 0;

		const out = await handleMessage(w.deps, w.poke({ base: "backup/x", id: "webhook:d3" }));

		expect(out).toEqual({ kind: "idle" });
		expect(w.fake.requests).toEqual(["GET /pulls"]);
		expect(await w.table.bases(FAKE_OWNER, FAKE_REPO)).toEqual([]);
	});

	it("routes a /dequeue to its PR's base, then applies it before reconciling", async () => {
		const w = reconcileWorld();
		const pr = w.fake.openPull({ "a.txt": "a" });
		w.fake.finishCi();
		const command = { kind: "dequeue" as const, number: pr };

		await handleMessage(w.deps, w.poke({ base: null, command }));
		expect(w.sent).toEqual([w.poke({ base: "main", command, id: "webhook:d1>main" })]);

		await handleMessage(w.deps, w.sent[0] as QueueMessage);
		const state = await w.table
			.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base: "main" }, 42)
			.load();
		expect(state.held).toEqual([pr]);
		expect(state.entries).toEqual([]);
		expect(w.fake.lastReport(pr)?.state).toBe("held");
	});

	it("on a version conflict reloads and decides again instead of overwriting", async () => {
		const w = reconcileWorld();
		w.fake.openPull({ "a.txt": "a" });
		w.fake.openPull({ "b.txt": "b" });
		w.fake.finishCi();
		// Another writer bumps the item between this reconcile's load and its first save.
		const other = w.table.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base: "main" }, 42);
		await other.save(await other.load());
		w.db.interleave(() => {
			const item = [...w.db.items.values()][0] as Record<string, unknown>;
			item.version = Number(item.version) + 1;
		});

		expect((await handleMessage(w.deps, w.poke())).kind).toBe("reconciled");
		expect(w.fake.branchNames()).toEqual(["main", "mq/main/1"]);
	});

	it("drops a message for an owner the deployment does not serve, without calling GitHub", async () => {
		const w = reconcileWorld();
		expect(await handleMessage(w.deps, w.poke({ owner: "someone-else" }))).toEqual({
			kind: "not-allowed",
		});
		expect(w.fake.requests).toEqual([]);
	});

	it("reports a failed message and every later one in the batch back to SQS", async () => {
		const w = reconcileWorld();
		const handler = createReconcileHandler({
			...w.deps,
			github: async () => {
				throw Object.assign(new Error("boom"), { status: 502 });
			},
		});
		const record = (id: string, body: string) =>
			({ messageId: id, body }) as SQSEvent["Records"][number];
		const res = await handler({
			Records: [
				record("bad-json", "{"),
				record("fails", JSON.stringify(w.poke())),
				record("after", JSON.stringify(w.poke({ id: "webhook:d9" }))),
			],
		});
		expect(res.batchItemFailures).toEqual([
			{ itemIdentifier: "fails" },
			{ itemIdentifier: "after" },
		]);
		expect(JSON.stringify(w.logs)).not.toContain("test-token");
	});

	it("sweeps every stored queue, and every repository once for new bases", async () => {
		const w = reconcileWorld();
		for (const base of ["main", "release"]) {
			const s = w.table.queue({ owner: FAKE_OWNER, repo: FAKE_REPO, base }, 42);
			await s.save(await s.load());
		}
		expect(await sweep(w.deps)).toBe(3);
		expect(w.sent.map((m) => m.base).sort()).toEqual(["main", "release", null].sort());
		expect(new Set(w.sent.map((m) => m.id))).toEqual(new Set([`sweep:${w.fake.now}`]));
	});
});

describe("linked secrets", () => {
	it("prefers a linked sst.Secret and falls back to the environment when unlinked", async () => {
		const { withLinkedSecrets } = await import("./secrets");
		const env = { GITHUB_WEBHOOK_SECRET: "from-env", OTHER: "kept" };
		expect(
			withLinkedSecrets({ GITHUB_WEBHOOK_SECRET: "GithubWebhookSecret" }, env, {
				GithubWebhookSecret: { value: "from-sst" },
			}),
		).toEqual({ GITHUB_WEBHOOK_SECRET: "from-sst", OTHER: "kept" });
		const unlinked = new Proxy(
			{},
			{
				get: () => {
					throw new Error("not linked");
				},
			},
		);
		expect(
			withLinkedSecrets({ GITHUB_WEBHOOK_SECRET: "GithubWebhookSecret" }, env, unlinked),
		).toEqual(env);
	});
});

describe("structured logs", () => {
	it("writes one line per reconciled message with repo, base, batch, actions and duration", async () => {
		const w = reconcileWorld();
		w.fake.openPull({ "a.txt": "a" });
		w.fake.openPull({ "b.txt": "b" });
		w.fake.finishCi();
		const handler = createReconcileHandler(w.deps);

		await handler({
			Records: [{ messageId: "m1", body: JSON.stringify(w.poke()) } as SQSEvent["Records"][number]],
		});

		expect(w.logs).toHaveLength(1);
		const line = w.logs[0] as Record<string, unknown>;
		expect(line).toMatchObject({
			level: "info",
			msg: "reconcile",
			repo: `${FAKE_OWNER}/${FAKE_REPO}`,
			base: "main",
			trigger: "webhook",
			outcome: "reconciled",
			batch: 1,
			actions: { build: 1, report: 2 },
			wakeAfterSeconds: null,
		});
		expect(typeof line.durationMs).toBe("number");
		expect(Object.keys(line).sort()).toEqual(
			[
				"actions",
				"base",
				"batch",
				"durationMs",
				"level",
				"msg",
				"outcome",
				"repo",
				"trigger",
				"wakeAfterSeconds",
			].sort(),
		);
		const text = JSON.stringify(w.logs);
		expect(text).not.toContain("test-token");
		expect(text).not.toContain("delivery");
	});

	it("warns on every reconcile while the base branch requires branches to be up to date", async () => {
		const w = reconcileWorld();
		w.fake.requireUpToDate(true);
		w.fake.openPull({ "a.txt": "a" });
		w.fake.finishCi();
		const handler = createReconcileHandler(w.deps);

		await handler({
			Records: [{ messageId: "m1", body: JSON.stringify(w.poke()) } as SQSEvent["Records"][number]],
		});

		const { STRICT_WARNING } = await import("./log");
		expect(w.logs[0]).toMatchObject({
			level: "warn",
			outcome: "reconciled",
			batch: null,
			warning: STRICT_WARNING,
		});
	});

	it("names only the kind of trigger, never its id", async () => {
		const { triggerKind } = await import("./log");
		expect(triggerKind("webhook:72d3162e-cc78>main")).toBe("webhook");
		expect(triggerKind("sweep:123")).toBe("sweep");
		expect(triggerKind("ghs_xxx")).toBe("unknown");
	});
});
