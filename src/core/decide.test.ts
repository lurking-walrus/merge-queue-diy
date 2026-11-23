import { describe, expect, it } from "vitest";
import { parseRepoConfig } from "./config";
import { applyBuildResult, applyCommand, applyLandResult, decide } from "./decide";
import {
	emptyState,
	NO_REVIEW_REQUIREMENTS,
	type PullState,
	type QueueState,
	type Snapshot,
} from "./types";

const cfg = parseRepoConfig({
	mode: "enforce",
	required_checks: ["ci"],
	settle_seconds: 0,
	max_wait_seconds: 0,
});

function pull(number: number, over: Partial<PullState> = {}): PullState {
	return {
		number,
		headSha: `head-${number}`,
		headUpdatedAt: 0,
		draft: false,
		fromFork: false,
		labels: [],
		checks: { state: "success", failed: [] },
		upToDate: false,
		reviews: { unresolvedConversations: 0, approvals: 0 },
		...over,
	};
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
	return {
		now: 1000,
		config: cfg,
		baseBranch: "main",
		baseSha: "base-1",
		pulls: [],
		reviewRequirements: NO_REVIEW_REQUIREMENTS,
		state: emptyState(),
		batchChecks: null,
		...over,
	};
}

function landing(): QueueState {
	return {
		...emptyState(),
		entries: [
			{ number: 1, headSha: "head-1", enqueuedAt: 0 },
			{ number: 2, headSha: "head-2", enqueuedAt: 0 },
		],
		batch: {
			id: 7,
			baseSha: "base-1",
			members: [
				{ number: 1, headSha: "head-1" },
				{ number: 2, headSha: "head-2" },
			],
			sha: "batch-7",
			branch: "mq/main/7",
			status: "landing",
		},
		nextBatchId: 8,
	};
}

describe("decide", () => {
	it("is a no-op when the queue is disabled", () => {
		const step = decide(snap({ config: { ...cfg, enabled: false }, pulls: [pull(1)] }));
		expect(step.actions).toEqual([]);
		expect(step.state).toEqual(emptyState());
	});

	it("does not mutate the state it was given", () => {
		const state = emptyState();
		decide(snap({ pulls: [pull(1)], state }));
		expect(state).toEqual(emptyState());
	});

	it("builds a batch in queue order on a branch CI triggers on", () => {
		const step = decide(snap({ pulls: [pull(2), pull(1)] }));
		expect(step.actions[0]).toEqual({
			type: "build",
			batchId: 1,
			baseSha: "base-1",
			members: [
				{ number: 1, headSha: "head-1" },
				{ number: 2, headSha: "head-2" },
			],
			branch: "mq/main/1",
			scratchBranch: "mq-build/main/1",
			mergeMethod: "squash",
		});
	});

	it("puts a jump-labelled PR at the front", () => {
		const step = decide(snap({ pulls: [pull(1), pull(2), pull(3, { labels: ["queue:jump"] })] }));
		expect(step.state.entries.map((e) => e.number)).toEqual([3, 1, 2]);
	});

	it("only queues labelled PRs when enqueue is `label`", () => {
		const step = decide(
			snap({
				config: { ...cfg, enqueue: "label" },
				pulls: [pull(1), pull(2, { labels: ["queue"] })],
			}),
		);
		expect(step.state.entries.map((e) => e.number)).toEqual([2]);
	});

	it("repeats the same build when re-run before the result arrived", () => {
		const first = decide(snap({ pulls: [pull(1), pull(2)] }));
		const second = decide(snap({ pulls: [pull(1), pull(2)], state: first.state }));
		expect(second.actions.filter((a) => a.type === "build")).toEqual(
			first.actions.filter((a) => a.type === "build"),
		);
		expect(second.state.nextBatchId).toBe(first.state.nextBatchId);
	});

	it("reports a status once, not on every pass", () => {
		const first = decide(snap({ pulls: [pull(1, { checks: { state: "pending", failed: [] } })] }));
		expect(first.actions.map((a) => a.type)).toEqual(["report"]);
		const second = decide(
			snap({
				pulls: [pull(1, { checks: { state: "pending", failed: [] } })],
				state: first.state,
			}),
		);
		expect(second.actions).toEqual([]);
	});

	it("keeps landing members queued while they vanish from the open list", () => {
		// PR 1 has already merged and is no longer open; PR 2 is next.
		const step = decide(snap({ pulls: [pull(2)], state: landing() }));
		expect(step.state.batch?.status).toBe("landing");
		expect(step.actions.find((a) => a.type === "land")).toMatchObject({ testedSha: "batch-7" });
	});
});

describe("applyBuildResult", () => {
	it("ignores a result for a batch that is no longer building", () => {
		const step = applyBuildResult(landing(), { batchId: 7, sha: "x", conflicts: [] });
		expect(step.state).toEqual(landing());
	});
});

describe("applyLandResult", () => {
	it("freezes the queue and raises an issue when the landed tree differs", () => {
		const step = applyLandResult(landing(), {
			batchId: 7,
			baseMoved: false,
			merged: [1, 2],
			failed: null,
			treeMatches: false,
		});
		expect(step.state.frozen).toMatch(/batch 7/);
		expect(step.actions.map((a) => a.type)).toEqual(["deleteBranch", "openIssue"]);

		// Frozen means frozen: a new PR is told why and nothing is built.
		const next = decide(snap({ pulls: [pull(3)], state: step.state }));
		expect(next.actions.map((a) => a.type)).toEqual(["report"]);
		expect(next.state.batch).toBeNull();

		const thawed = applyCommand(next.state, { kind: "unfreeze" });
		expect(decide(snap({ pulls: [pull(3)], state: thawed })).state.batch).not.toBeNull();
	});

	it("requeues the rest when the base moved under a landing", () => {
		const step = applyLandResult(landing(), {
			batchId: 7,
			baseMoved: true,
			merged: [],
			failed: null,
			treeMatches: null,
		});
		expect(step.state.batch).toBeNull();
		expect(step.state.entries.map((e) => e.number)).toEqual([1, 2]);
	});

	it("ejects the PR GitHub refused instead of retrying it forever", () => {
		const step = applyLandResult(landing(), {
			batchId: 7,
			baseMoved: false,
			merged: [1],
			failed: { number: 2, message: "405 not mergeable" },
			treeMatches: null,
		});
		expect(step.state.entries).toEqual([]);
		expect(step.state.ejected["2"]).toEqual({ headSha: "head-2", reason: "merge_failed" });
		expect(step.state.frozen).toBeNull();
	});
});

describe("applyCommand", () => {
	it("/dequeue holds a PR out and /queue brings it back", () => {
		const held = applyCommand(emptyState(), { kind: "dequeue", number: 1 });
		expect(decide(snap({ pulls: [pull(1)], state: held })).state.entries).toEqual([]);
		const back = applyCommand(held, { kind: "queue", number: 1 });
		expect(decide(snap({ pulls: [pull(1)], state: back })).state.entries).toHaveLength(1);
	});
});

describe("parseRepoConfig", () => {
	it("defaults to shadow mode, so a new install changes nothing", () => {
		expect(parseRepoConfig({ required_checks: ["ci"] }).mode).toBe("shadow");
	});

	it("rejects unknown keys rather than ignoring a typo", () => {
		expect(() => parseRepoConfig({ required_checks: ["ci"], batchsize: 3 })).toThrow();
	});

	it("requires at least one check to gate on", () => {
		expect(() => parseRepoConfig({ required_checks: [] })).toThrow();
	});
});

describe("shadow reports", () => {
	const shadowCfg = parseRepoConfig({
		mode: "shadow",
		required_checks: ["ci"],
		settle_seconds: 0,
		max_wait_seconds: 0,
	});

	it("are flagged as shadow and sent once per change", () => {
		const first = decide(snap({ config: shadowCfg, pulls: [pull(1)] }));
		const report = first.actions.find((a) => a.type === "report");
		expect(report).toMatchObject({ shadow: true, summary: "[shadow] would be queued (#1 of 1)" });

		const again = decide(snap({ config: shadowCfg, pulls: [pull(1)], state: first.state }));
		expect(again.actions.filter((a) => a.type === "report")).toEqual([]);
	});

	it("are sent again when the last one predates the shadow flag", () => {
		const first = decide(snap({ config: shadowCfg, pulls: [pull(1)] }));
		const legacy = structuredClone(first.state);
		legacy.reported["1"] = "head-1|queued|[shadow] would be queued (#1 of 1)";

		const step = decide(snap({ config: shadowCfg, pulls: [pull(1)], state: legacy }));
		expect(step.actions.filter((a) => a.type === "report")).toMatchObject([{ shadow: true }]);
	});
});
