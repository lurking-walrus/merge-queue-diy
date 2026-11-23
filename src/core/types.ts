/**
 * Data model for the merge queue's decision core.
 *
 * Everything in `src/core` is pure: no I/O, no clock, no randomness. The shell
 * reads GitHub and the store into a {@link Snapshot}, calls `decide`, and
 * executes the {@link Action}s it returns. See docs/DESIGN.md §4.
 */

import type { RepoConfig } from "./config";

/** Rolled-up result of a set of named checks on one commit. */
export interface Rollup {
	state: "pending" | "success" | "failure";
	/** Names of the checks that failed; empty unless `state` is `failure`. */
	failed: string[];
}

/** An open pull request targeting the queue's base branch, as GitHub reports it. */
export interface PullState {
	number: number;
	headSha: string;
	/** Epoch seconds of the last push to the head branch. Drives the settle timer. */
	headUpdatedAt: number;
	draft: boolean;
	/** Fork pull requests are never queued: a batch branch runs with repository secrets. */
	fromFork: boolean;
	labels: string[];
	/** Rollup of `config.prChecks` on the head commit. */
	checks: Rollup;
	/** True when the head already contains the current tip of the base branch. */
	upToDate: boolean;
	/** Review state that the base branch's rules can require. */
	reviews: ReviewCounts;
}

export interface ReviewCounts {
	/** Review conversations not yet marked resolved. */
	unresolvedConversations: number;
	/** Reviewers whose latest review approves. */
	approvals: number;
}

/**
 * What the base branch's rules require of a pull request's reviews before it
 * may merge. A PR that does not meet them cannot land, so it is not queued.
 */
export interface ReviewRequirements {
	resolvedConversations: boolean;
	approvals: number;
}

export const NO_REVIEW_REQUIREMENTS: ReviewRequirements = {
	resolvedConversations: false,
	approvals: 0,
};

export interface Entry {
	number: number;
	headSha: string;
	/** Epoch seconds. Drives `maxWaitSeconds`. */
	enqueuedAt: number;
}

export interface Member {
	number: number;
	headSha: string;
}

export type BatchStatus = "building" | "testing" | "landing";

export interface Batch {
	id: number;
	/** Tip of the base branch this batch was built on. */
	baseSha: string;
	members: Member[];
	/** Head of the batch branch. Null while building, and for a fast-path landing. */
	sha: string | null;
	/** The branch CI runs on. Null for a fast-path landing, which has none. */
	branch: string | null;
	status: BatchStatus;
}

export type EjectReason = "conflict" | "checks_failed" | "merge_failed";

export interface Ejection {
	headSha: string;
	reason: EjectReason;
}

/** The persisted state of one queue (one repository + base branch). */
export interface QueueState {
	/** In queue order. Members of the active batch stay here until they land. */
	entries: Entry[];
	batch: Batch | null;
	/** Groups left to test after a failed batch was split, in order. */
	pending: number[][];
	nextBatchId: number;
	/** Keyed by PR number. Cleared when the PR's head changes. */
	ejected: Record<string, Ejection>;
	/** PRs queued by a `/queue` comment (`enqueue: comment`). */
	requested: number[];
	/** PRs taken out by a `/dequeue` comment. */
	held: number[];
	/** Last status reported per PR, so unchanged statuses are not re-sent. */
	reported: Record<string, string>;
	/** Set when landed and tested trees differ. Nothing moves until a human clears it. */
	frozen: string | null;
}

export function emptyState(): QueueState {
	return {
		entries: [],
		batch: null,
		pending: [],
		nextBatchId: 1,
		ejected: {},
		requested: [],
		held: [],
		reported: {},
		frozen: null,
	};
}

export interface Snapshot {
	/** Epoch seconds. */
	now: number;
	config: RepoConfig;
	/** Name of the base branch, e.g. `main`. */
	baseBranch: string;
	/** Current tip of the base branch. */
	baseSha: string;
	pulls: PullState[];
	/** What the base branch's rules require of reviews, as GitHub reports them. */
	reviewRequirements: ReviewRequirements;
	state: QueueState;
	/** Rollup of `config.requiredChecks` on the active batch's commit, when it is testing. */
	batchChecks: Rollup | null;
}

export type ReportState = "waiting" | "queued" | "testing" | "landing" | "ejected" | "held";

export type Action =
	| {
			type: "build";
			batchId: number;
			baseSha: string;
			members: Member[];
			/** Created once, at the final commit, so CI runs exactly once. */
			branch: string;
			/** Where the merges happen; no workflow triggers on it. */
			scratchBranch: string;
			mergeMethod: RepoConfig["mergeMethod"];
	  }
	| {
			type: "land";
			batchId: number;
			/** Landing is refused if the base branch is no longer here. */
			baseSha: string;
			members: Member[];
			/** The commit CI passed on. The landed tree must equal this commit's tree. */
			testedSha: string;
			mergeMethod: RepoConfig["mergeMethod"];
	  }
	| { type: "deleteBranch"; branch: string }
	| { type: "cancelRuns"; sha: string }
	| {
			type: "report";
			number: number;
			headSha: string;
			state: ReportState;
			summary: string;
			/** Shadow mode: informational only, so the check is shown as finished. */
			shadow: boolean;
	  }
	| { type: "comment"; number: number; payload: EjectionPayload }
	| { type: "openIssue"; title: string; body: string };

/** Machine-readable body of an ejection comment (docs/DESIGN.md §8). */
export interface EjectionPayload {
	reason: EjectReason;
	conflicts_with?: number[];
	failed_checks?: string[];
	batch?: number;
	message?: string;
}

export interface BuildResult {
	batchId: number;
	/** Head of the batch branch, or null when no member could be merged. */
	sha: string | null;
	/** Members that did not merge cleanly. Empty `conflictsWith` means the base itself. */
	conflicts: { number: number; conflictsWith: number[] }[];
}

export interface LandResult {
	batchId: number;
	/** The base branch had moved, so nothing was attempted. */
	baseMoved: boolean;
	/** PRs merged, in order. May be a prefix of the batch. */
	merged: number[];
	/** The first PR that could not be merged, if any. */
	failed: { number: number; message: string } | null;
	/** Whether the landed tree equals the tested tree. Null when landing was partial. */
	treeMatches: boolean | null;
}

export interface Step {
	state: QueueState;
	actions: Action[];
	/** Reconcile again after this many seconds even if no webhook arrives. */
	wakeAfterSeconds: number | null;
}

export type Command = { kind: "queue" | "dequeue"; number: number } | { kind: "unfreeze" };
