/**
 * The boundary between the pure core and the outside world.
 *
 * A port instance is bound to one queue: one repository and one base branch.
 * The production adapter talks to GitHub's REST API; `src/sim` implements the
 * same interface in memory for tests.
 */

import type { RepoConfig } from "./core/config";
import type {
	Action,
	BuildResult,
	LandResult,
	PullState,
	QueueState,
	ReviewRequirements,
	Rollup,
} from "./core/types";

type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

export interface GitHubPort {
	readonly baseBranch: string;
	/**
	 * Tip of the base branch, every open PR targeting it, and what the base
	 * branch's rules require of reviews. With `reviewRequirements: "none"` an
	 * adapter may skip reading reviews and return none.
	 */
	readQueue(config: RepoConfig): Promise<QueueRead>;
	/** Rollup of the named checks on a commit. A check that has not reported is pending. */
	readChecks(sha: string, names: string[]): Promise<Rollup>;
	/**
	 * Merge the members, in order, onto `baseSha` on the scratch branch, then
	 * create `branch` at the result. Must be safe to repeat for the same batch.
	 */
	build(action: ActionOf<"build">): Promise<BuildResult>;
	/**
	 * Land the batch if the base branch is still at `baseSha`, then compare the
	 * landed tree with `testedSha`'s tree.
	 */
	land(action: ActionOf<"land">): Promise<LandResult>;
	deleteBranch(branch: string): Promise<void>;
	cancelRuns(sha: string): Promise<void>;
	report(action: ActionOf<"report">): Promise<void>;
	comment(action: ActionOf<"comment">): Promise<void>;
	openIssue(action: ActionOf<"openIssue">): Promise<void>;
}

export interface QueueRead {
	baseSha: string;
	pulls: PullState[];
	reviewRequirements: ReviewRequirements;
}

export interface QueueStore {
	load(): Promise<QueueState>;
	save(state: QueueState): Promise<void>;
}
