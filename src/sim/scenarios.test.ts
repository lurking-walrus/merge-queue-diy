import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRepoConfig, type RepoConfig } from "../core/config";
import { strictSummary } from "../core/decide";
import type { Action, ReviewRequirements } from "../core/types";
import { FakeGitHub } from "../github/fake";
import { adapterFor, interceptGitHub } from "../github/testing";
import type { GitHubPort } from "../ports";
import { reconcile } from "../reconcile";
import type { Changes, CiFn, Tree } from "./github";
import { MemoryStore, SimGitHub } from "./github";

function config(overrides: Record<string, unknown> = {}): RepoConfig {
	return parseRepoConfig({
		mode: "enforce",
		required_checks: ["ci"],
		settle_seconds: 0,
		max_wait_seconds: 0,
		...overrides,
	});
}

/** What a scenario does to, and asserts on, the repository. Both worlds provide it. */
interface World {
	now: number;
	openPull(
		changes: Changes,
		o?: { draft?: boolean; fromFork?: boolean; labels?: string[] },
	): number;
	pushToPull(number: number, changes: Changes): void;
	pushToBase(changes: Changes): void;
	closePull(number: number): void;
	requireReviews(r: Partial<ReviewRequirements>): void;
	requireUpToDate(on: boolean): void;
	openConversation(number: number): void;
	resolveConversations(number: number): void;
	approve(number: number, reviewer: string): void;
	finishCi(): number;
	mainTree(): Tree;
	pullState(number: number): "open" | "merged" | "closed";
	branchNames(): string[];
	batchRuns(): number;
	lastReport(number: number): Extract<Action, { type: "report" }> | undefined;
	queueCheck(number: number): string | undefined;
	readonly reports: Extract<Action, { type: "report" }>[];
	readonly comments: Extract<Action, { type: "comment" }>[];
	readonly cancelled: string[];
}

const github = interceptGitHub();
beforeAll(() => github.server.listen({ onUnhandledFrame: "error" }));
afterAll(() => github.server.close());

/**
 * Every scenario runs twice: against the in-memory simulator, and against the
 * production REST adapter talking HTTP to a fake GitHub. The adapter must
 * behave like the simulator in all of them.
 */
const worlds: {
	name: string;
	make(cfg: RepoConfig, ci?: CiFn): { sim: World; port: GitHubPort };
}[] = [
	{
		name: "the simulator",
		make: (cfg, ci) => {
			const sim = new SimGitHub({ ci, branchPrefix: cfg.branchPrefix });
			return { sim, port: sim };
		},
	},
	{
		name: "the REST adapter over HTTP",
		make: (cfg, ci) => {
			const fake = new FakeGitHub({ ci, branchPrefix: cfg.branchPrefix });
			github.use(fake);
			return { sim: fake, port: adapterFor(fake) };
		},
	},
];

/** Reconcile, let CI finish, advance the clock when asked to, until nothing moves. */
async function drive(
	sim: World,
	port: GitHubPort,
	store: MemoryStore,
	cfg: RepoConfig,
): Promise<void> {
	for (let round = 0; round < 100; round++) {
		const { wakeAfterSeconds } = await reconcile(port, store, cfg, sim.now);
		if (sim.finishCi() > 0) continue;
		if (wakeAfterSeconds === null) return;
		sim.now += wakeAfterSeconds;
	}
	throw new Error("queue did not settle");
}

describe.each(worlds)("merge queue, end to end against $name", ({ make }) => {
	function setup(cfg: RepoConfig, ci?: CiFn) {
		const { sim, port } = make(cfg, ci);
		return { sim, port, store: new MemoryStore(), cfg };
	}

	it("lands ten independent PRs in two batch runs", async () => {
		const { sim, port, store, cfg } = setup(config());
		for (let i = 1; i <= 10; i++) sim.openPull({ [`file-${i}.txt`]: `v${i}` });

		await drive(sim, port, store, cfg);

		for (let i = 1; i <= 10; i++) {
			expect(sim.pullState(i)).toBe("merged");
			expect(sim.mainTree()[`file-${i}.txt`]).toBe(`v${i}`);
		}
		expect(sim.batchRuns()).toBe(2);
		expect(sim.branchNames()).toEqual(["main"]);
		expect(store.state.frozen).toBeNull();
	});

	it("leaves a landed PR's check reading landed, not landing", async () => {
		const { sim, port, store, cfg } = setup(config());
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("merged");
		expect(sim.queueCheck(a)).toBe("landed with batch 1");
		expect(sim.queueCheck(b)).toBe("landed with batch 1");
	});

	it("ejects a textual conflict before spending CI on it", async () => {
		const { sim, port, store, cfg } = setup(config());
		const first = sim.openPull({ "shared.txt": "from first" });
		const second = sim.openPull({ "shared.txt": "from second" });
		const third = sim.openPull({ "other.txt": "fine" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(first)).toBe("merged");
		expect(sim.pullState(third)).toBe("merged");
		expect(sim.pullState(second)).toBe("open");
		expect(sim.comments).toEqual([
			{
				type: "comment",
				number: second,
				payload: { reason: "conflict", conflicts_with: [first], batch: 1 },
			},
		]);
		expect(sim.lastReport(second)?.state).toBe("ejected");
		// One run for the batch of two; none for the conflicting PR.
		expect(sim.batchRuns()).toBe(1);
	});

	it("lets an ejected PR back in once its head changes", async () => {
		const { sim, port, store, cfg } = setup(config());
		sim.openPull({ "shared.txt": "from first" });
		const second = sim.openPull({ "shared.txt": "from second" });
		await drive(sim, port, store, cfg);
		expect(sim.pullState(second)).toBe("open");

		// Still conflicts: the fix has to actually resolve it.
		sim.pushToPull(second, { "unrelated.txt": "x" });
		await drive(sim, port, store, cfg);
		expect(sim.pullState(second)).toBe("open");
		expect(sim.comments).toHaveLength(2);
	});

	it("bisects a red batch down to the one PR that breaks the build", async () => {
		// Each PR is fine alone; `breaker.txt` fails CI whenever it is present.
		const ci: CiFn = (tree) => ({ ci: tree["breaker.txt"] ? "failure" : "success" });
		const { sim, port, store, cfg } = setup(config({ pr_checks: [] }), ci);
		const good = [
			sim.openPull({ "a.txt": "a" }),
			sim.openPull({ "b.txt": "b" }),
			sim.openPull({ "d.txt": "d" }),
		];
		const bad = sim.openPull({ "breaker.txt": "boom" });

		await drive(sim, port, store, cfg);

		for (const n of good) expect(sim.pullState(n)).toBe("merged");
		expect(sim.pullState(bad)).toBe("open");
		expect(sim.mainTree()["breaker.txt"]).toBeUndefined();
		expect(sim.comments.map((c) => [c.number, c.payload.reason, c.payload.failed_checks])).toEqual([
			[bad, "checks_failed", ["ci"]],
		]);
		// Batch of 4 (red), halves of 2 (green, red), then the two singles.
		expect(sim.batchRuns()).toBeLessThanOrEqual(5);
	});

	it("catches a semantic conflict that neither PR shows alone", async () => {
		// Both PRs pass their own CI; together they break it.
		const ci: CiFn = (tree) => ({
			ci: tree["rename.txt"] && tree["caller.txt"] ? "failure" : "success",
		});
		const { sim, port, store, cfg } = setup(config(), ci);
		const rename = sim.openPull({ "rename.txt": "renamed foo to bar" });
		const caller = sim.openPull({ "caller.txt": "calls foo" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(rename)).toBe("merged");
		expect(sim.pullState(caller)).toBe("open");
		expect(sim.mainTree()["caller.txt"]).toBeUndefined();
		expect(sim.comments.at(-1)?.payload.reason).toBe("checks_failed");
	});

	it("lands a lone up-to-date PR on its own CI, with no batch run", async () => {
		const { sim, port, store, cfg } = setup(config());
		const pr = sim.openPull({ "solo.txt": "x" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(pr)).toBe("merged");
		expect(sim.batchRuns()).toBe(0);
	});

	it("does not take the fast path when PR-level CI is thinner than batch CI", async () => {
		const { sim, port, store, cfg } = setup(config({ pr_checks: [] }));
		const pr = sim.openPull({ "solo.txt": "x" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(pr)).toBe("merged");
		expect(sim.batchRuns()).toBe(1);
	});

	it("abandons a batch when a member is pushed to, and cancels its run", async () => {
		const { sim, port, store, cfg } = setup(config());
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });
		sim.finishCi();
		await reconcile(port, store, cfg, sim.now);
		expect(store.state.batch?.status).toBe("testing");

		sim.pushToPull(b, { "b.txt": "b2" });
		await reconcile(port, store, cfg, sim.now);
		expect(sim.cancelled).toHaveLength(1);
		// `a` is now alone and up to date, so it lands on its own CI at once.
		expect(sim.pullState(a)).toBe("merged");
		expect(store.state.batch).toBeNull();

		await drive(sim, port, store, cfg);
		expect(sim.pullState(a)).toBe("merged");
		expect(sim.pullState(b)).toBe("merged");
		expect(sim.mainTree()["b.txt"]).toBe("b2");
	});

	it("rebuilds when someone pushes straight to the base branch", async () => {
		const { sim, port, store, cfg } = setup(config());
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });
		sim.finishCi();
		await reconcile(port, store, cfg, sim.now);
		const firstBatch = store.state.batch?.id;

		sim.pushToBase({ "hotfix.txt": "urgent" });
		await drive(sim, port, store, cfg);

		expect(store.state.nextBatchId).toBeGreaterThan((firstBatch ?? 0) + 1);
		expect(sim.pullState(a)).toBe("merged");
		expect(sim.pullState(b)).toBe("merged");
		expect(sim.mainTree()["hotfix.txt"]).toBe("urgent");
	});

	it("never queues drafts or fork PRs", async () => {
		const { sim, port, store, cfg } = setup(config());
		const draft = sim.openPull({ "a.txt": "a" }, { draft: true });
		const fork = sim.openPull({ "b.txt": "b" }, { fromFork: true });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(draft)).toBe("open");
		expect(sim.pullState(fork)).toBe("open");
		expect(sim.reports).toEqual([]);
	});

	it("in shadow mode reports what it would do and touches nothing", async () => {
		const { sim, port, store, cfg } = setup(config({ mode: "shadow" }));
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("open");
		expect(sim.pullState(b)).toBe("open");
		expect(sim.branchNames()).toEqual(["main"]);
		expect(sim.batchRuns()).toBe(0);
		expect(sim.lastReport(a)?.summary).toBe("[shadow] would be queued (#1 of 2)");
		// Informational only: shown as a finished, neutral check, never pending.
		expect(sim.lastReport(a)?.shadow).toBe(true);
	});

	it("in shadow mode marks every report as shadow, waiting ones included", async () => {
		const { sim, port, store, cfg } = setup(config({ mode: "shadow" }), () => ({ ci: "failure" }));
		const a = sim.openPull({ "a.txt": "a" });
		sim.finishCi();

		await drive(sim, port, store, cfg);

		expect(sim.lastReport(a)?.summary).toBe("[shadow] waiting: own checks failing (ci)");
		expect(sim.lastReport(a)?.shadow).toBe(true);
		expect(sim.pullState(a)).toBe("open");
	});

	it("pauses while the base branch requires branches to be up to date, then resumes", async () => {
		const { sim, port, store, cfg } = setup(config());
		sim.requireUpToDate(true);
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });

		const first = await reconcile(port, store, cfg, sim.now);
		await drive(sim, port, store, cfg);

		expect(first.strictChecks).toBe(true);
		expect(sim.batchRuns()).toBe(0);
		expect(sim.pullState(a)).toBe("open");
		expect(sim.lastReport(a)?.state).toBe("waiting");
		expect(sim.lastReport(b)?.summary).toBe(strictSummary("main"));

		sim.requireUpToDate(false);
		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("merged");
		expect(sim.pullState(b)).toBe("merged");
		expect(sim.batchRuns()).toBe(1);
	});

	it("only warns about strict in shadow mode", async () => {
		const { sim, port, store, cfg } = setup(config({ mode: "shadow" }));
		sim.requireUpToDate(true);
		const a = sim.openPull({ "a.txt": "a" });

		await drive(sim, port, store, cfg);
		const result = await reconcile(port, store, cfg, sim.now);

		expect(result.strictChecks).toBe(true);
		expect(sim.lastReport(a)?.summary).toBe("[shadow] would be queued (#1 of 1)");
	});

	it("holds a PR with unresolved conversations when the branch requires them resolved", async () => {
		const { sim, port, store, cfg } = setup(config());
		sim.requireReviews({ resolvedConversations: true });
		const discussed = sim.openPull({ "a.txt": "a" });
		const quiet = sim.openPull({ "b.txt": "b" });
		sim.openConversation(discussed);
		sim.openConversation(discussed);

		await drive(sim, port, store, cfg);

		expect(sim.pullState(quiet)).toBe("merged");
		expect(sim.pullState(discussed)).toBe("open");
		expect(sim.lastReport(discussed)?.summary).toBe("waiting: 2 unresolved review conversations");

		sim.resolveConversations(discussed);
		await drive(sim, port, store, cfg);

		expect(sim.pullState(discussed)).toBe("merged");
		expect(sim.mainTree()["a.txt"]).toBe("a");
	});

	it("holds a PR until it has the approvals the branch requires", async () => {
		const { sim, port, store, cfg } = setup(config());
		sim.requireReviews({ approvals: 2 });
		const a = sim.openPull({ "a.txt": "a" });
		sim.approve(a, "reviewer-1");

		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("open");
		expect(sim.lastReport(a)?.summary).toBe("waiting: 1 of 2 required approvals");
		expect(sim.batchRuns()).toBe(0);

		sim.approve(a, "reviewer-2");
		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("merged");
	});

	it("ignores the branch's review rules with review_requirements: none", async () => {
		const { sim, port, store, cfg } = setup(config({ review_requirements: "none" }));
		sim.requireReviews({ resolvedConversations: true, approvals: 1 });
		const a = sim.openPull({ "a.txt": "a" });
		sim.openConversation(a);

		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("merged");
	});

	it("forgets a queue once nothing is left in it", async () => {
		const { sim, port, store, cfg } = setup(config({ mode: "shadow" }));
		const a = sim.openPull({ "a.txt": "a" });
		await drive(sim, port, store, cfg);
		expect(store.stored).toBe(true);

		sim.closePull(a);
		await drive(sim, port, store, cfg);

		// A repository with many branches must not keep one stored queue per branch.
		expect(store.stored).toBe(false);
	});

	it("lands a whole batch as one fast-forward in merge mode", async () => {
		const { sim, port, store, cfg } = setup(config({ merge_method: "merge" }));
		const a = sim.openPull({ "a.txt": "a" });
		const b = sim.openPull({ "b.txt": "b" });

		await drive(sim, port, store, cfg);

		expect(sim.pullState(a)).toBe("merged");
		expect(sim.pullState(b)).toBe("merged");
		expect(sim.mainTree()).toMatchObject({ "a.txt": "a", "b.txt": "b" });
		expect(store.state.frozen).toBeNull();
	});

	it("waits for the settle period before batching a freshly pushed PR", async () => {
		const { sim, port, store, cfg } = setup(config({ settle_seconds: 120 }));
		const pr = sim.openPull({ "a.txt": "a" });
		sim.finishCi();

		const first = await reconcile(port, store, cfg, sim.now);
		expect(first.wakeAfterSeconds).toBe(120);
		expect(sim.pullState(pr)).toBe("open");

		sim.now += 120;
		await drive(sim, port, store, cfg);
		expect(sim.pullState(pr)).toBe("merged");
	});

	it("holds a short batch open while another PR's checks are still running", async () => {
		const { sim, port, store, cfg } = setup(config({ max_wait_seconds: 300 }));
		const a = sim.openPull({ "a.txt": "a" });
		sim.finishCi();
		const b = sim.openPull({ "b.txt": "b" }); // CI still running

		const first = await reconcile(port, store, cfg, sim.now);
		expect(store.state.batch).toBeNull();
		expect(first.wakeAfterSeconds).toBe(300);

		await drive(sim, port, store, cfg);
		expect(sim.pullState(a)).toBe("merged");
		expect(sim.pullState(b)).toBe("merged");
		expect(sim.batchRuns()).toBe(1);
	});
});
