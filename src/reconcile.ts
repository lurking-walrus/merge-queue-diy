/**
 * The imperative shell: read, decide, act, repeat until nothing more happens.
 *
 * State is saved before effects run, so a crash between "decided to build" and
 * "build finished" leaves a record the next reconcile picks up and repeats.
 */

import type { RepoConfig } from "./core/config";
import { applyBuildResult, applyLandResult, decide } from "./core/decide";
import { type Action, isIdle } from "./core/types";
import type { GitHubPort, QueueStore } from "./ports";

/** Builds and lands feed back into the state, so one poke can take several passes. */
const MAX_PASSES = 20;

export interface ReconcileResult {
	/** Reconcile again after this many seconds even if no webhook arrives. */
	wakeAfterSeconds: number | null;
	/** How many of each effect were executed, e.g. `{ report: 3, build: 1 }`. For logs. */
	actions: Partial<Record<Action["type"], number>>;
	/** The batch in flight when this reconcile ended, if any. */
	batchId: number | null;
}

export async function reconcile(
	port: GitHubPort,
	store: QueueStore,
	config: RepoConfig,
	now: number,
): Promise<ReconcileResult> {
	let state = await store.load();
	const actions: ReconcileResult["actions"] = {};
	const count = (a: Action) => {
		actions[a.type] = (actions[a.type] ?? 0) + 1;
	};
	const done = (wakeAfterSeconds: number | null): ReconcileResult => ({
		wakeAfterSeconds,
		actions,
		batchId: state.batch?.id ?? null,
	});

	const runSimple = async (list: Action[]) => {
		for (const a of list) {
			count(a);
			if (a.type === "deleteBranch") await port.deleteBranch(a.branch);
			else if (a.type === "cancelRuns") await port.cancelRuns(a.sha);
			else if (a.type === "report") await port.report(a);
			else if (a.type === "comment") await port.comment(a);
			else if (a.type === "openIssue") await port.openIssue(a);
		}
	};

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const { baseSha, pulls, reviewRequirements } = await port.readQueue(config);
		const testing = state.batch?.status === "testing" ? state.batch.sha : null;
		const batchChecks = testing ? await port.readChecks(testing, config.requiredChecks) : null;

		const step = decide({
			now,
			config,
			baseBranch: port.baseBranch,
			baseSha,
			pulls,
			reviewRequirements,
			state,
			batchChecks,
		});
		state = step.state;
		// Nothing to remember: forget the queue rather than store an empty one.
		if (isIdle(state)) await store.discard();
		else await store.save(state);

		let fedBack = false;
		for (const a of step.actions) {
			if (a.type === "build") {
				count(a);
				const applied = applyBuildResult(state, await port.build(a));
				state = applied.state;
				await store.save(state);
				await runSimple(applied.actions);
				fedBack = true;
			} else if (a.type === "land") {
				count(a);
				const applied = applyLandResult(state, await port.land(a));
				state = applied.state;
				await store.save(state);
				await runSimple(applied.actions);
				fedBack = true;
			} else {
				await runSimple([a]);
			}
		}
		if (!fedBack) return done(step.wakeAfterSeconds);
	}
	// Still moving after MAX_PASSES: yield and come straight back.
	return done(1);
}
