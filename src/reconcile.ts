/**
 * The imperative shell: read, decide, act, repeat until nothing more happens.
 *
 * State is saved before effects run, so a crash between "decided to build" and
 * "build finished" leaves a record the next reconcile picks up and repeats.
 */

import type { RepoConfig } from "./core/config";
import { applyBuildResult, applyLandResult, decide } from "./core/decide";
import type { Action } from "./core/types";
import type { GitHubPort, QueueStore } from "./ports";

/** Builds and lands feed back into the state, so one poke can take several passes. */
const MAX_PASSES = 20;

export interface ReconcileResult {
	/** Reconcile again after this many seconds even if no webhook arrives. */
	wakeAfterSeconds: number | null;
}

export async function reconcile(
	port: GitHubPort,
	store: QueueStore,
	config: RepoConfig,
	now: number,
): Promise<ReconcileResult> {
	let state = await store.load();

	const runSimple = async (actions: Action[]) => {
		for (const a of actions) {
			if (a.type === "deleteBranch") await port.deleteBranch(a.branch);
			else if (a.type === "cancelRuns") await port.cancelRuns(a.sha);
			else if (a.type === "report") await port.report(a);
			else if (a.type === "comment") await port.comment(a);
			else if (a.type === "openIssue") await port.openIssue(a);
		}
	};

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const { baseSha, pulls } = await port.readQueue(config);
		const testing = state.batch?.status === "testing" ? state.batch.sha : null;
		const batchChecks = testing ? await port.readChecks(testing, config.requiredChecks) : null;

		const step = decide({
			now,
			config,
			baseBranch: port.baseBranch,
			baseSha,
			pulls,
			state,
			batchChecks,
		});
		state = step.state;
		await store.save(state);

		let fedBack = false;
		for (const a of step.actions) {
			if (a.type === "build") {
				const applied = applyBuildResult(state, await port.build(a));
				state = applied.state;
				await store.save(state);
				await runSimple(applied.actions);
				fedBack = true;
			} else if (a.type === "land") {
				const applied = applyLandResult(state, await port.land(a));
				state = applied.state;
				await store.save(state);
				await runSimple(applied.actions);
				fedBack = true;
			} else {
				await runSimple([a]);
			}
		}
		if (!fedBack) return { wakeAfterSeconds: step.wakeAfterSeconds };
	}
	// Still moving after MAX_PASSES: yield and come straight back.
	return { wakeAfterSeconds: 1 };
}
