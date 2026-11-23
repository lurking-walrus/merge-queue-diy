/**
 * The merge queue's decision core. Pure functions only.
 *
 * `decide` looks at everything known about one queue and returns the next
 * state plus the side effects to perform. Two effects (`build`, `land`) produce
 * results the queue needs; the shell feeds those back through
 * `applyBuildResult` / `applyLandResult` and calls `decide` again.
 *
 * Every function here is safe to re-run on the same input: a reconcile that
 * crashes half-way is repaired by the next one. See docs/DESIGN.md §4–§6.
 */

import type { RepoConfig } from "./config";
import type {
	Action,
	Batch,
	BuildResult,
	Command,
	EjectionPayload,
	EjectReason,
	Entry,
	LandResult,
	Member,
	PullState,
	QueueState,
	ReportState,
	Snapshot,
	Step,
} from "./types";

export function batchBranch(cfg: RepoConfig, baseBranch: string, id: number): string {
	return `${cfg.branchPrefix}/${baseBranch}/${id}`;
}

/** Deliberately outside `<prefix>/**` so the CI trigger does not match it. */
export function scratchBranch(cfg: RepoConfig, baseBranch: string, id: number): string {
	return `${cfg.branchPrefix}-build/${baseBranch}/${id}`;
}

function eject(
	st: QueueState,
	actions: Action[],
	member: Member,
	reason: EjectReason,
	payload: Omit<EjectionPayload, "reason">,
): void {
	st.ejected[String(member.number)] = { headSha: member.headSha, reason };
	st.entries = st.entries.filter((e) => e.number !== member.number);
	actions.push({ type: "comment", number: member.number, payload: { reason, ...payload } });
}

function landAction(cfg: RepoConfig, b: Batch): Action {
	// A fast-path batch has no batch commit: what CI tested is the PR's own head.
	const testedSha = b.sha ?? b.members[0]?.headSha ?? b.baseSha;
	return {
		type: "land",
		batchId: b.id,
		baseSha: b.baseSha,
		members: b.members,
		testedSha,
		mergeMethod: cfg.mergeMethod,
	};
}

export function decide(snap: Snapshot): Step {
	const { config: cfg, now } = snap;
	const st = structuredClone(snap.state);
	const actions: Action[] = [];
	let wake: number | null = null;
	const wakeIn = (seconds: number) => {
		const s = Math.max(1, Math.ceil(seconds));
		wake = wake === null ? s : Math.min(wake, s);
	};

	if (!cfg.enabled) return { state: st, actions, wakeAfterSeconds: null };

	const pulls = new Map(snap.pulls.map((p) => [p.number, p]));

	// --- Forget what no longer applies -------------------------------------
	// An ejection is tied to a head commit: a new push gets a fresh attempt.
	for (const key of Object.keys(st.ejected)) {
		const p = pulls.get(Number(key));
		if (!p || p.headSha !== st.ejected[key]?.headSha) delete st.ejected[key];
	}
	st.held = st.held.filter((n) => pulls.has(n));
	st.requested = st.requested.filter((n) => pulls.has(n));

	const wanted = (p: PullState): boolean => {
		if (p.draft || p.fromFork || st.held.includes(p.number)) return false;
		if (cfg.enqueue === "label") return p.labels.includes(cfg.queueLabel);
		if (cfg.enqueue === "comment") return st.requested.includes(p.number);
		return true;
	};
	const isEjected = (n: number) => st.ejected[String(n)] !== undefined;

	// --- Sync the queue with the open pull requests ------------------------
	// Members of a landing batch are exempt: they disappear from the open list
	// one by one as they merge, and that must not look like a dequeue.
	const landing = new Set(
		st.batch?.status === "landing" ? st.batch.members.map((m) => m.number) : [],
	);
	st.entries = st.entries.filter((e) => {
		if (landing.has(e.number)) return true;
		const p = pulls.get(e.number);
		return p !== undefined && p.headSha === e.headSha && wanted(p);
	});
	const queued = new Set(st.entries.map((e) => e.number));
	const byNumber = [...pulls.values()].sort((a, b) => a.number - b.number);
	for (const p of byNumber) {
		if (queued.has(p.number) || !wanted(p) || isEjected(p.number)) continue;
		if (p.checks.state !== "success") continue;
		st.entries.push({ number: p.number, headSha: p.headSha, enqueuedAt: now });
		queued.add(p.number);
	}
	const jumps = (e: Entry) => pulls.get(e.number)?.labels.includes(cfg.jumpLabel) ?? false;
	st.entries = [...st.entries.filter(jumps), ...st.entries.filter((e) => !jumps(e))];

	const abandon = (b: Batch) => {
		if (b.sha) actions.push({ type: "cancelRuns", sha: b.sha });
		if (b.branch) actions.push({ type: "deleteBranch", branch: b.branch });
		st.batch = null;
	};

	const active = cfg.mode === "enforce" && st.frozen === null;

	// Switched to shadow, or frozen, with a batch in flight: stop paying for it.
	if (!active && st.batch && st.batch.status !== "landing") abandon(st.batch);

	// --- Advance the batch in flight ---------------------------------------
	if (active && st.batch) {
		const b = st.batch;
		const intact = b.members.every((m) =>
			st.entries.some((e) => e.number === m.number && e.headSha === m.headSha),
		);
		if (b.status === "landing") {
			// Re-emitted until a result comes back; the lander refuses a moved base.
			actions.push(landAction(cfg, b));
		} else if (!intact) {
			// A member was pushed to, closed or dequeued. What was tested no longer
			// describes what would land, and the split plan no longer applies.
			abandon(b);
			st.pending = [];
		} else if (snap.baseSha !== b.baseSha) {
			abandon(b);
		} else if (b.status === "building") {
			actions.push(buildAction(cfg, snap.baseBranch, b));
		} else if (snap.batchChecks?.state === "success") {
			b.status = "landing";
			actions.push(landAction(cfg, b));
		} else if (snap.batchChecks?.state === "failure") {
			const only = b.members.length === 1 ? b.members[0] : undefined;
			if (only) {
				eject(st, actions, only, "checks_failed", {
					failed_checks: snap.batchChecks.failed,
					batch: b.id,
				});
			} else {
				const numbers = b.members.map((m) => m.number);
				const mid = Math.ceil(numbers.length / 2);
				const groups =
					cfg.onFailure === "bisect"
						? [numbers.slice(0, mid), numbers.slice(mid)]
						: numbers.map((n) => [n]);
				st.pending = [...groups, ...st.pending];
			}
			// Other jobs on the batch commit may still be running; they are moot.
			abandon(b);
		}
	}

	// --- Start the next batch ----------------------------------------------
	if (active && !st.batch) {
		const settledAt = (e: Entry) => (pulls.get(e.number)?.headUpdatedAt ?? now) + cfg.settleSeconds;
		let group: Entry[] = [];

		// A failed batch's halves go first, in order, before anything new.
		while (group.length === 0 && st.pending.length > 0) {
			const numbers = st.pending.shift() ?? [];
			group = st.entries.filter((e) => numbers.includes(e.number));
		}

		if (group.length === 0) {
			const unsettled = st.entries.filter((e) => settledAt(e) > now);
			for (const e of unsettled) wakeIn(settledAt(e) - now);
			group = st.entries.filter((e) => settledAt(e) <= now).slice(0, cfg.batchSize);

			if (group.length > 0 && group.length < cfg.batchSize) {
				// Only wait for a fuller batch if something could actually join it.
				const incoming =
					unsettled.length > 0 ||
					byNumber.some(
						(p) =>
							!queued.has(p.number) &&
							wanted(p) &&
							!isEjected(p.number) &&
							p.checks.state === "pending",
					);
				const waited = now - Math.min(...group.map((e) => e.enqueuedAt));
				if (incoming && waited < cfg.maxWaitSeconds) {
					wakeIn(cfg.maxWaitSeconds - waited);
					group = [];
				}
			}
		}

		if (group.length > 0) {
			const id = st.nextBatchId++;
			const members = group.map((e) => ({ number: e.number, headSha: e.headSha }));
			const only = group.length === 1 ? pulls.get(members[0]?.number ?? -1) : undefined;
			const prCiCoversBatchCi = cfg.requiredChecks.every((c) => cfg.prChecks.includes(c));
			if (only?.upToDate && only.checks.state === "success" && prCiCoversBatchCi) {
				// Fast path: the PR's own CI already ran on exactly what would land.
				st.batch = {
					id,
					baseSha: snap.baseSha,
					members,
					sha: null,
					branch: null,
					status: "landing",
				};
				actions.push(landAction(cfg, st.batch));
			} else {
				st.batch = {
					id,
					baseSha: snap.baseSha,
					members,
					sha: null,
					branch: batchBranch(cfg, snap.baseBranch, id),
					status: "building",
				};
				actions.push(buildAction(cfg, snap.baseBranch, st.batch));
			}
		}
	}

	// --- Report each PR's status, only when it changed ---------------------
	const inBatch = new Set(st.batch?.members.map((m) => m.number) ?? []);
	const waitingLine = st.entries.filter((e) => !inBatch.has(e.number));
	const prefix = cfg.mode === "shadow" ? "[shadow] would be " : "";
	for (const key of Object.keys(st.reported)) {
		if (!pulls.has(Number(key))) delete st.reported[key];
	}
	for (const p of byNumber) {
		let report: { state: ReportState; summary: string } | null = null;
		const position = waitingLine.findIndex((e) => e.number === p.number);
		if (st.frozen !== null) {
			if (wanted(p)) report = { state: "waiting", summary: `queue frozen: ${st.frozen}` };
		} else if (inBatch.has(p.number) && st.batch) {
			report =
				st.batch.status === "landing"
					? { state: "landing", summary: `landing with batch ${st.batch.id}` }
					: { state: "testing", summary: `testing in batch ${st.batch.id}` };
		} else if (position >= 0) {
			report = {
				state: "queued",
				summary: `${prefix}queued (#${position + 1} of ${waitingLine.length})`,
			};
		} else if (isEjected(p.number)) {
			report = { state: "ejected", summary: `ejected: ${st.ejected[String(p.number)]?.reason}` };
		} else if (st.held.includes(p.number)) {
			report = { state: "held", summary: "held by /dequeue" };
		} else if (wanted(p)) {
			report = {
				state: "waiting",
				summary:
					p.checks.state === "failure"
						? `waiting: own checks failing (${p.checks.failed.join(", ")})`
						: "waiting for own checks",
			};
		}
		const key = String(p.number);
		if (!report) {
			delete st.reported[key];
			continue;
		}
		const shadow = cfg.mode === "shadow";
		// Every shadow report says so, not only "would be queued".
		if (shadow && !report.summary.startsWith("[shadow]")) {
			report.summary = `[shadow] ${report.summary}`;
		}
		const fingerprint = `${p.headSha}|${report.state}|${report.summary}`;
		if (st.reported[key] === fingerprint) continue;
		st.reported[key] = fingerprint;
		actions.push({ type: "report", number: p.number, headSha: p.headSha, ...report, shadow });
	}

	return { state: st, actions, wakeAfterSeconds: wake };
}

function buildAction(cfg: RepoConfig, baseBranch: string, b: Batch): Action {
	return {
		type: "build",
		batchId: b.id,
		baseSha: b.baseSha,
		members: b.members,
		branch: b.branch ?? batchBranch(cfg, baseBranch, b.id),
		scratchBranch: scratchBranch(cfg, baseBranch, b.id),
		mergeMethod: cfg.mergeMethod,
	};
}

/** Fold the outcome of a `build` action into the state. */
export function applyBuildResult(state: QueueState, res: BuildResult): Step {
	const st = structuredClone(state);
	const actions: Action[] = [];
	const b = st.batch;
	// A result for a batch that was abandoned meanwhile is simply stale.
	if (!b || b.id !== res.batchId || b.status !== "building") {
		return { state: st, actions, wakeAfterSeconds: null };
	}
	for (const c of res.conflicts) {
		const member = b.members.find((m) => m.number === c.number);
		if (!member) continue;
		eject(st, actions, member, "conflict", { conflicts_with: c.conflictsWith, batch: b.id });
	}
	const conflicted = new Set(res.conflicts.map((c) => c.number));
	b.members = b.members.filter((m) => !conflicted.has(m.number));
	if (b.members.length === 0 || res.sha === null) {
		if (b.branch) actions.push({ type: "deleteBranch", branch: b.branch });
		st.batch = null;
	} else {
		b.sha = res.sha;
		b.status = "testing";
	}
	return { state: st, actions, wakeAfterSeconds: null };
}

/** Fold the outcome of a `land` action into the state. */
export function applyLandResult(state: QueueState, res: LandResult): Step {
	const st = structuredClone(state);
	const actions: Action[] = [];
	const b = st.batch;
	if (!b || b.id !== res.batchId || b.status !== "landing") {
		return { state: st, actions, wakeAfterSeconds: null };
	}
	st.entries = st.entries.filter((e) => !res.merged.includes(e.number));
	if (b.branch) actions.push({ type: "deleteBranch", branch: b.branch });
	st.batch = null;

	// Whatever did not merge stays queued and is rebuilt on the new base, except
	// the PR GitHub refused: retrying the same commit would loop forever.
	const failed = res.failed;
	if (failed) {
		const member = b.members.find((m) => m.number === failed.number);
		if (member) {
			eject(st, actions, member, "merge_failed", { message: failed.message, batch: b.id });
		}
	}

	if (res.treeMatches === false) {
		// The one thing the queue promises did not hold. Stop rather than guess.
		st.frozen = `batch ${b.id} landed a tree that differs from the tree CI tested`;
		st.pending = [];
		actions.push({
			type: "openIssue",
			title: "Merge queue frozen: landed tree differs from tested tree",
			body: [
				`Batch ${b.id} (${res.merged.map((n) => `#${n}`).join(", ")}) was merged, but the`,
				"resulting tree on the base branch is not the tree CI passed on.",
				"",
				"The queue has stopped. Inspect the base branch, then comment",
				"`/queue unfreeze` on any pull request to resume.",
			].join("\n"),
		});
	}
	return { state: st, actions, wakeAfterSeconds: null };
}

/** Apply a `/queue`, `/dequeue` or `/queue unfreeze` comment. */
export function applyCommand(state: QueueState, cmd: Command): QueueState {
	const st = structuredClone(state);
	if (cmd.kind === "unfreeze") {
		st.frozen = null;
		return st;
	}
	const without = (xs: number[]) => xs.filter((n) => n !== cmd.number);
	if (cmd.kind === "queue") {
		st.held = without(st.held);
		st.requested = [...without(st.requested), cmd.number];
		// An explicit request retries a PR that was ejected at this same head.
		delete st.ejected[String(cmd.number)];
	} else {
		st.requested = without(st.requested);
		st.held = [...without(st.held), cmd.number];
	}
	return st;
}
