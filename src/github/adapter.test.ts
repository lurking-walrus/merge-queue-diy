import { generateKeyPairSync } from "node:crypto";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseRepoConfig } from "../core/config";
import type { Action } from "../core/types";
import { renderEjection } from "./adapter";
import { CONFIG_PATH, loadRepoConfig, parseConfigText } from "./config";
import { FAKE_OWNER, FAKE_REPO, FakeGitHub } from "./fake";
import { QueueOctokit, repositoryOctokit } from "./octokit";
import { API, adapterFor, interceptGitHub } from "./testing";

type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

const github = interceptGitHub();
beforeAll(() => github.server.listen({ onUnhandledFrame: "error" }));
afterEach(() => github.server.resetHandlers());
afterAll(() => github.server.close());

const REPO_URL = `${API}/repos/${FAKE_OWNER}/${FAKE_REPO}`;
const cfg = parseRepoConfig({ mode: "enforce", required_checks: ["ci"] });

function world(opts: ConstructorParameters<typeof FakeGitHub>[0] = {}) {
	const fake = new FakeGitHub(opts);
	github.use(fake);
	return { fake, gh: adapterFor(fake) };
}

function buildAction(
	fake: FakeGitHub,
	numbers: number[],
	mergeMethod: "squash" | "merge" = "squash",
): ActionOf<"build"> {
	return {
		type: "build",
		batchId: 7,
		baseSha: fake.mainSha(),
		members: numbers.map((number) => ({ number, headSha: fake.headOf(number) })),
		branch: "mq/main/7",
		scratchBranch: "mq-build/main/7",
		mergeMethod,
	};
}

function landAction(
	fake: FakeGitHub,
	numbers: number[],
	testedSha: string,
	mergeMethod: "squash" | "merge" = "squash",
): ActionOf<"land"> {
	return {
		type: "land",
		batchId: 7,
		baseSha: fake.mainSha(),
		members: numbers.map((number) => ({ number, headSha: fake.headOf(number) })),
		testedSha,
		mergeMethod,
	};
}

describe("authentication", () => {
	it("mints an installation token scoped to the one repository, signed with the app JWT", async () => {
		const { fake } = world();
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
		let seen: string | null = null;
		github.server.use(
			http.get(REPO_URL, ({ request }) => {
				seen = request.headers.get("authorization");
				return HttpResponse.json({
					full_name: `${FAKE_OWNER}/${FAKE_REPO}`,
					default_branch: "main",
				});
			}),
		);

		const kit = await repositoryOctokit({ appId: "12345", privateKey: pem }, 99, FAKE_REPO);
		await kit.rest.repos.get({ owner: FAKE_OWNER, repo: FAKE_REPO });

		expect(fake.tokenRequests).toHaveLength(1);
		expect(fake.tokenRequests[0]?.body).toEqual({ repositories: [FAKE_REPO] });
		// The token request is signed with a JWT (three base64url segments), not a token.
		expect(fake.tokenRequests[0]?.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
		expect(seen).toBe("token ghs_fake_installation_token");
	});
});

describe("readQueue", () => {
	it("reports each open PR's head, draft, fork, labels, checks, settle time and freshness", async () => {
		const { fake, gh } = world();
		fake.now = 2_000_000;
		const fresh = fake.openPull({ "a.txt": "a" }, { labels: ["queue"] });
		const draft = fake.openPull({ "b.txt": "b" }, { draft: true });
		const fork = fake.openPull({ "c.txt": "c" }, { fromFork: true });
		fake.finishCi();
		const stale = fake.openPull({ "d.txt": "d" });
		fake.pushToBase({ "e.txt": "e" });

		const { baseSha, pulls } = await gh.readQueue(cfg);
		const by = new Map(pulls.map((p) => [p.number, p]));

		expect(baseSha).toBe(fake.mainSha());
		expect(by.get(fresh)).toMatchObject({
			headSha: fake.headOf(fresh),
			headUpdatedAt: 2_000_000,
			draft: false,
			fromFork: false,
			labels: ["queue"],
			checks: { state: "success", failed: [] },
			// The base moved after this PR was opened.
			upToDate: false,
		});
		expect(by.get(draft)?.draft).toBe(true);
		expect(by.get(fork)?.fromFork).toBe(true);
		expect(by.get(stale)?.checks.state).toBe("pending");
	});

	it("knows a PR whose head contains the base tip is up to date", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		const { pulls } = await gh.readQueue(cfg);
		expect(pulls.find((p) => p.number === pr)?.upToDate).toBe(true);
	});

	it("follows pagination past 100 open PRs", async () => {
		const { fake, gh } = world();
		for (let i = 0; i < 130; i++) fake.openPull({ [`f${i}.txt`]: String(i) });

		const { pulls } = await gh.readQueue(
			parseRepoConfig({ required_checks: ["ci"], pr_checks: [] }),
		);

		expect(pulls).toHaveLength(130);
		expect(new Set(pulls.map((p) => p.number)).size).toBe(130);
		expect(fake.requests.filter((r) => r === "GET /pulls")).toHaveLength(2);
	});
});

describe("review requirements", () => {
	it("reads none, and asks GraphQL nothing, when the branch has no review rules", async () => {
		const { fake, gh } = world();
		fake.openPull({ "a.txt": "a" });

		const read = await gh.readQueue(cfg);

		expect(read.reviewRequirements).toEqual({ resolvedConversations: false, approvals: 0 });
		expect(read.pulls[0]?.reviews).toEqual({ unresolvedConversations: 0, approvals: 0 });
		expect(fake.requests).not.toContain("POST /graphql");
		expect(fake.requests).toContain("GET /rules/branches/main");
	});

	it("reads the ruleset's requirements and each PR's conversations and approvals", async () => {
		const { fake, gh } = world();
		fake.requireReviews({ resolvedConversations: true, approvals: 2 });
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });
		fake.openConversation(a);
		fake.openConversation(a);
		fake.resolveConversations(a);
		fake.openConversation(a);
		fake.approve(b, "reviewer-1");

		const read = await gh.readQueue(cfg);
		const by = new Map(read.pulls.map((p) => [p.number, p.reviews]));

		expect(read.reviewRequirements).toEqual({ resolvedConversations: true, approvals: 2 });
		expect(by.get(a)).toEqual({ unresolvedConversations: 1, approvals: 0 });
		expect(by.get(b)).toEqual({ unresolvedConversations: 0, approvals: 1 });
	});

	it("counts unreadable rules as none rather than failing the reconcile", async () => {
		const { fake, gh } = world();
		fake.requireReviews({ resolvedConversations: true });
		github.server.use(
			http.get(`${REPO_URL}/rules/branches/:branch`, () =>
				HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }),
			),
		);
		fake.openPull({ "a.txt": "a" });

		const read = await gh.readQueue(cfg);
		github.server.resetHandlers();

		expect(read.reviewRequirements).toEqual({ resolvedConversations: false, approvals: 0 });
	});

	it("reads neither rules nor reviews with review_requirements: none", async () => {
		const { fake, gh } = world();
		fake.requireReviews({ resolvedConversations: true });
		fake.openPull({ "a.txt": "a" });

		await gh.readQueue(parseRepoConfig({ required_checks: ["ci"], review_requirements: "none" }));

		expect(fake.requests.some((r) => r.includes("/rules/") || r.includes("graphql"))).toBe(false);
	});
});

describe("readChecks", () => {
	it("rolls up check runs and legacy statuses by name, newest result winning", async () => {
		const { fake, gh } = world({ ci: () => ({}) });
		const sha = fake.mainSha();
		fake.addCheckRun(sha, "lint", "failure");
		fake.now += 10;
		fake.addCheckRun(sha, "lint", "success"); // a re-run fixed it
		fake.addStatus(sha, "deploy-preview", "failure");
		fake.now += 10;
		fake.addStatus(sha, "deploy-preview", "success");
		fake.addCheckRun(sha, "skipped-job", "skipped");

		expect(await gh.readChecks(sha, ["lint", "deploy-preview", "skipped-job"])).toEqual({
			state: "success",
			failed: [],
		});
		expect(await gh.readChecks(sha, ["lint", "never-reported"])).toEqual({
			state: "pending",
			failed: [],
		});

		fake.now += 10;
		fake.addStatus(sha, "lint", "error"); // a legacy status of the same name, newer still
		expect(await gh.readChecks(sha, ["lint", "never-reported"])).toEqual({
			state: "failure",
			failed: ["lint"],
		});
	});

	it("treats an in-progress run as pending and finds a check past the first 100 runs", async () => {
		const { fake, gh } = world({ ci: () => ({}) });
		const sha = fake.mainSha();
		for (let i = 0; i < 120; i++) fake.addCheckRun(sha, `job-${i}`, "success");
		fake.addCheckRun(sha, "slow", null);
		fake.addCheckRun(sha, "late", "failure");

		expect(await gh.readChecks(sha, ["job-0", "job-119", "slow"])).toEqual({
			state: "pending",
			failed: [],
		});
		expect(await gh.readChecks(sha, ["job-119", "late"])).toEqual({
			state: "failure",
			failed: ["late"],
		});
		expect(
			fake.requests.filter((r) => r === `GET /commits/${sha}/check-runs`).length,
		).toBeGreaterThan(2);
	});
});

describe("build", () => {
	it("records a 409 as a conflict naming the earlier member it overlaps, and keeps going", async () => {
		const { fake, gh } = world();
		const first = fake.openPull({ "shared.txt": "one" });
		const second = fake.openPull({ "shared.txt": "two" });
		const third = fake.openPull({ "other.txt": "fine" });
		fake.finishCi();

		const res = await gh.build(buildAction(fake, [first, second, third]));

		expect(res.conflicts).toEqual([{ number: second, conflictsWith: [first] }]);
		expect(res.sha).toBe(fake.branchSha("mq/main/7"));
		expect(fake.branchNames()).toEqual(["main", "mq/main/7"]);
		expect(fake.batchRuns()).toBe(1);
		// Exactly one ref creation for the batch branch: one push, one CI run.
		expect(fake.requests.filter((r) => r === "POST /git/refs")).toHaveLength(2); // scratch + batch
	});

	it("builds a squash chain: single-parent commits whose final tree has every member", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });

		const res = await gh.build(buildAction(fake, [a, b]));
		const kit = new QueueOctokit({ auth: "x" });
		const at = { owner: FAKE_OWNER, repo: FAKE_REPO };
		const tip = (await kit.rest.git.getCommit({ ...at, commit_sha: res.sha ?? "" })).data;
		const parent = (await kit.rest.git.getCommit({ ...at, commit_sha: tip.parents[0]?.sha ?? "" }))
			.data;

		expect(tip.parents).toHaveLength(1);
		expect(parent.parents).toHaveLength(1);
		expect(parent.parents[0]?.sha).toBe(fake.mainSha());
		expect(tip.message).toContain(`Merge-Queue-Member: #${b} ${fake.headOf(b)}`);
	});

	it("is safe to repeat: an existing batch branch is returned, with its conflicts recovered", async () => {
		for (const method of ["squash", "merge"] as const) {
			const { fake, gh } = world();
			const first = fake.openPull({ "shared.txt": "one" });
			const second = fake.openPull({ "shared.txt": "two" });
			const action = buildAction(fake, [first, second], method);

			const once = await gh.build(action);
			const again = await adapterFor(fake).build(action);

			expect(again).toEqual(once);
			expect(again.conflicts).toEqual([{ number: second, conflictsWith: [first] }]);
			expect(fake.batchRuns()).toBe(1);
		}
	});

	it("replaces a stale scratch branch left by a crashed attempt", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const kit = new QueueOctokit({ auth: "x" });
		await kit.rest.git.createRef({
			owner: FAKE_OWNER,
			repo: FAKE_REPO,
			ref: "refs/heads/mq-build/main/7",
			sha: fake.headOf(a),
		});

		const res = await gh.build(buildAction(fake, [a]));

		expect(res.sha).not.toBeNull();
		expect(fake.branchNames()).toEqual(["main", "mq/main/7"]);
	});

	it("returns no commit, and leaves no branch, when every member conflicts with the base", async () => {
		const { fake, gh } = world({ initial: { "x.txt": "base" } });
		const pr = fake.openPull({ "x.txt": "mine" });
		fake.pushToBase({ "x.txt": "theirs" });

		const res = await gh.build(buildAction(fake, [pr]));

		expect(res).toEqual({ batchId: 7, sha: null, conflicts: [{ number: pr, conflictsWith: [] }] });
		expect(fake.branchNames()).toEqual(["main"]);
	});
});

describe("land", () => {
	it("refuses to touch anything when the base has moved", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		const action = landAction(fake, [pr], fake.headOf(pr));
		fake.pushToBase({ "hotfix.txt": "x" });

		expect(await gh.land(action)).toEqual({
			batchId: 7,
			baseMoved: true,
			merged: [],
			failed: null,
			treeMatches: null,
		});
		expect(fake.pullState(pr)).toBe("open");
	});

	it("turns merge-queue green on each head just before squash-merging it, and checks the tree", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });
		const built = await gh.build(buildAction(fake, [a, b]));

		const res = await gh.land(landAction(fake, [a, b], built.sha ?? ""));

		expect(res).toEqual({
			batchId: 7,
			baseMoved: false,
			merged: [a, b],
			failed: null,
			treeMatches: true,
		});
		expect(fake.queueChecks(fake.headOf(a)).at(-1)).toMatchObject({
			status: "completed",
			conclusion: "success",
		});
		const puts = fake.requests.filter((r) => r.startsWith("PUT /pulls/"));
		expect(puts).toEqual([`PUT /pulls/${a}/merge`, `PUT /pulls/${b}/merge`]);
	});

	it("stops at the first PR GitHub refuses with 405, reporting a partial landing", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });
		const c = fake.openPull({ "c.txt": "c" });
		const built = await gh.build(buildAction(fake, [a, b, c]));
		github.server.use(
			http.put(`${REPO_URL}/pulls/${b}/merge`, () =>
				HttpResponse.json({ message: "Pull Request is not mergeable" }, { status: 405 }),
			),
		);

		const res = await gh.land(landAction(fake, [a, b, c], built.sha ?? ""));

		expect(res).toEqual({
			batchId: 7,
			baseMoved: false,
			merged: [a],
			failed: { number: b, message: "Pull Request is not mergeable" },
			treeMatches: null,
		});
		expect(fake.pullState(c)).toBe("open");
	});

	it("skips members that are already merged, so a repeated land is harmless", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });
		const built = await gh.build(buildAction(fake, [a, b]));
		const first = await gh.land(landAction(fake, [a], fake.headOf(a)));
		expect(first.merged).toEqual([a]);

		// Re-issued for the whole batch against the base as it now is.
		const res = await gh.land(landAction(fake, [a, b], built.sha ?? ""));

		expect(res.merged).toEqual([a, b]);
		expect(res.treeMatches).toBe(true);
		expect(fake.requests.filter((r) => r === `PUT /pulls/${a}/merge`)).toHaveLength(1);
	});

	it("reports treeMatches false when the landed tree is not the tested tree", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const untested = fake.mainSha(); // a commit whose tree lacks a.txt

		const res = await gh.land(landAction(fake, [a], untested));

		expect(res.merged).toEqual([a]);
		expect(res.treeMatches).toBe(false);
	});

	it("in merge mode fast-forwards the base once, without force", async () => {
		const { fake, gh } = world();
		const a = fake.openPull({ "a.txt": "a" });
		const b = fake.openPull({ "b.txt": "b" });
		const built = await gh.build(buildAction(fake, [a, b], "merge"));

		const res = await gh.land(landAction(fake, [a, b], built.sha ?? "", "merge"));

		expect(res).toEqual({
			batchId: 7,
			baseMoved: false,
			merged: [a, b],
			failed: null,
			treeMatches: true,
		});
		expect(fake.mainSha()).toBe(built.sha);
		expect(fake.requests.filter((r) => r === "PATCH /git/refs/heads/main")).toHaveLength(1);
		expect(fake.pullState(a)).toBe("merged");
	});
});

describe("simple effects", () => {
	it("treats a branch that is already gone (404 or 422) as deleted, but surfaces other errors", async () => {
		const { gh } = world();
		await expect(gh.deleteBranch("never-existed")).resolves.toBeUndefined(); // fake answers 422
		github.server.use(
			http.delete(`${REPO_URL}/git/refs/heads/gone-404`, () =>
				HttpResponse.json({ message: "Not Found" }, { status: 404 }),
			),
			http.delete(`${REPO_URL}/git/refs/heads/broken`, () =>
				HttpResponse.json({ message: "Server Error" }, { status: 500 }),
			),
		);
		await expect(gh.deleteBranch("gone-404")).resolves.toBeUndefined();
		await expect(gh.deleteBranch("broken")).rejects.toMatchObject({ status: 500 });
	});

	it("cancels in-progress runs for a commit and ignores ones that already finished", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		const sha = fake.headOf(pr);
		github.server.use(
			http.post(`${REPO_URL}/actions/runs/:id/cancel`, () =>
				HttpResponse.json({ message: "Cannot cancel" }, { status: 409 }),
			),
		);
		await expect(gh.cancelRuns(sha)).resolves.toBeUndefined();
		github.server.resetHandlers();

		await gh.cancelRuns(sha);
		expect(fake.cancelled).toEqual([sha]);
	});

	it("keeps one merge-queue check run per head, reopening it with a new run after completion", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		const headSha = fake.headOf(pr);
		const report = (state: ActionOf<"report">["state"], summary: string) =>
			gh.report({ type: "report", number: pr, headSha, state, summary, shadow: false });

		await report("waiting", "waiting for own checks");
		await report("queued", "queued (#1 of 1)");
		expect(fake.queueChecks(headSha)).toHaveLength(1);
		expect(fake.queueChecks(headSha)[0]).toMatchObject({
			status: "in_progress",
			external_id: "queued",
			output: { title: "queued (#1 of 1)" },
		});

		await report("ejected", "ejected: conflict");
		expect(fake.queueChecks(headSha)).toHaveLength(1);
		expect(fake.queueChecks(headSha)[0]).toMatchObject({
			status: "completed",
			conclusion: "failure",
		});

		await report("queued", "queued (#1 of 1)");
		expect(fake.queueChecks(headSha)).toHaveLength(2);
		await report("held", "held by /dequeue");
		expect(fake.queueChecks(headSha).at(-1)).toMatchObject({
			status: "completed",
			conclusion: "neutral",
		});
	});

	it("shows shadow reports as finished, neutral checks, updated in place", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		const headSha = fake.headOf(pr);
		const report = (state: ActionOf<"report">["state"], summary: string) =>
			gh.report({ type: "report", number: pr, headSha, state, summary, shadow: true });

		await report("waiting", "[shadow] waiting for own checks");
		expect(fake.queueChecks(headSha)).toHaveLength(1);
		expect(fake.queueChecks(headSha)[0]).toMatchObject({
			status: "completed",
			conclusion: "neutral",
			output: { title: "[shadow] waiting for own checks" },
		});

		await report("queued", "[shadow] would be queued (#1 of 1)");
		await report("queued", "[shadow] would be queued (#1 of 1)");
		expect(fake.queueChecks(headSha)).toHaveLength(1);
		expect(fake.queueChecks(headSha)[0]).toMatchObject({
			status: "completed",
			conclusion: "neutral",
			external_id: "queued",
			output: { title: "[shadow] would be queued (#1 of 1)" },
		});

		// Switching to enforce opens a new run: a finished one cannot be reopened.
		await gh.report({
			type: "report",
			number: pr,
			headSha,
			state: "queued",
			summary: "queued (#1 of 1)",
			shadow: false,
		});
		expect(fake.queueChecks(headSha)).toHaveLength(2);
		expect(fake.queueChecks(headSha).at(-1)).toMatchObject({ status: "in_progress" });
	});

	it("posts one ejection comment per PR and edits it in place on repeat", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });

		await gh.comment({
			type: "comment",
			number: pr,
			payload: { reason: "conflict", conflicts_with: [3] },
		});
		await gh.comment({
			type: "comment",
			number: pr,
			payload: { reason: "checks_failed", failed_checks: ["ci"], batch: 4 },
		});

		const bodies = fake.commentBodies(pr);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("<!-- merge-queue:ejection -->");
		expect(bodies[0]).toContain(
			'```json\n{"reason":"checks_failed","failed_checks":["ci"],"batch":4}\n```',
		);
	});

	it("does not open a second issue with the same title", async () => {
		const { fake, gh } = world();
		const issue = { type: "openIssue" as const, title: "Merge queue frozen", body: "details" };
		await gh.openIssue(issue);
		await gh.openIssue(issue);
		expect(fake.openIssueTitles()).toEqual(["Merge queue frozen"]);
	});

	it("renders every ejection reason with its JSON payload", () => {
		for (const payload of [
			{ reason: "conflict" as const, conflicts_with: [] },
			{ reason: "checks_failed" as const, failed_checks: ["ci"] },
			{ reason: "merge_failed" as const, message: "not mergeable" },
		]) {
			const body = renderEjection(payload);
			expect(body.startsWith("<!-- merge-queue:ejection -->")).toBe(true);
			expect(body).toContain(JSON.stringify(payload));
		}
	});
});

describe("repository config", () => {
	const kit = () => new QueueOctokit({ auth: "x" });

	it("treats a missing file as disabled", async () => {
		world();
		expect(await loadRepoConfig(kit(), FAKE_OWNER, FAKE_REPO)).toEqual({ kind: "missing" });
	});

	it("parses a valid file from the default branch", async () => {
		const { fake } = world();
		fake.files.set(CONFIG_PATH, "mode: enforce\nrequired_checks: [ci, lint]\nbatch_size: 3\n");
		const res = await loadRepoConfig(kit(), FAKE_OWNER, FAKE_REPO);
		expect(res.kind === "ok" && res.config).toMatchObject({
			mode: "enforce",
			requiredChecks: ["ci", "lint"],
			batchSize: 3,
		});
	});

	it("explains an invalid file instead of throwing", async () => {
		const { fake } = world();
		fake.files.set(CONFIG_PATH, "required_checks: [ci]\nbatch_sise: 3\n");
		const res = await loadRepoConfig(kit(), FAKE_OWNER, FAKE_REPO);
		expect(res.kind).toBe("invalid");
		expect(res.kind === "invalid" && res.reason).toContain("batch_sise");

		expect(parseConfigText("required_checks: [ci").kind).toBe("invalid");
		expect(parseConfigText("").kind).toBe("invalid");
		expect(parseConfigText("required_checks: []").kind).toBe("invalid");
	});

	it("shows why the queue is disabled on every open PR's merge-queue check", async () => {
		const { fake, gh } = world();
		const pr = fake.openPull({ "a.txt": "a" });
		await gh.reportDisabled(".github/merge-queue.yml: batch_sise: unrecognized key");
		await gh.reportDisabled(".github/merge-queue.yml: batch_sise: unrecognized key");
		const runs = fake.queueChecks(fake.headOf(pr));
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
		expect(runs[0]?.output.title).toContain("merge queue disabled");
	});
});
