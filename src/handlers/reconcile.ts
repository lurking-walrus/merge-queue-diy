/**
 * The reconcile function: an SQS FIFO consumer, plus the 10-minute sweep.
 *
 * A poke for one base branch is reconciled. A poke for "every base" (check
 * events and comments name no base) is only fanned out into per-base pokes,
 * each in its own message group, so state for a queue is only ever touched
 * from that queue's group.
 *
 * Failure handling is the core's: state is saved before effects run and
 * every effect is safe to repeat, so a message that throws is simply left for
 * SQS to redeliver. Nothing here retries GitHub calls.
 */

import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { applyCommand } from "../core/decide";
import { type Command, isIdle, type QueueState } from "../core/types";
import { RestGitHub } from "../github/adapter";
import { loadRepoConfig } from "../github/config";
import type { Kit } from "../github/octokit";
import type { QueueStore } from "../ports";
import { reconcile } from "../reconcile";
import { type QueueKey, type StoredQueue, VersionConflict } from "../store/dynamo";
import { reconcileLogLine } from "./log";
import type { Outbox, QueueMessage, Waker } from "./messages";

/** A version conflict means a concurrent attempt; re-running a couple of times settles it. */
const MAX_ATTEMPTS = 3;

export interface QueueTable {
	queue(key: QueueKey, installationId: number): QueueStore;
	bases(owner: string, repo: string): Promise<string[]>;
	all(): Promise<StoredQueue[]>;
}

export interface ReconcileDeps {
	appId: number;
	allowedOwners: string[];
	table: QueueTable;
	/** A client authenticated for exactly this repository. */
	github(installationId: number, repo: string): Promise<Kit>;
	outbox: Outbox;
	waker: Waker;
	/** Epoch seconds. */
	now(): number;
	log(line: Record<string, unknown>): void;
}

export interface Outcome {
	kind: "reconciled" | "fanned-out" | "idle" | "disabled" | "invalid-config" | "not-allowed";
	wakeAfterSeconds?: number | null;
	bases?: string[];
	/** Effects executed, by type. */
	actions?: Partial<Record<string, number>>;
	batchId?: number | null;
}

export async function handleMessage(deps: ReconcileDeps, m: QueueMessage): Promise<Outcome> {
	// Ingest already filtered owners; a scheduled or hand-sent message gets the same check.
	if (!deps.allowedOwners.includes(m.owner.toLowerCase())) return { kind: "not-allowed" };
	const kit = await deps.github(m.installationId, m.repo);
	if (m.base === null) return fanOut(deps, kit, m);

	const base = m.base;
	const key = { owner: m.owner, repo: m.repo, base };

	// Most pokes name a branch no queue lives on: every push to every branch
	// is one. With nothing stored and no open PR targeting it, one cheap read
	// settles it, and a stale stored queue for it is forgotten.
	if (!m.command) {
		const store = deps.table.queue(key, m.installationId);
		if (isIdle(await store.load())) {
			const { data: open } = await kit.rest.pulls.list({
				owner: m.owner,
				repo: m.repo,
				state: "open",
				base,
				per_page: 1,
			});
			if (open.length === 0) {
				await store.discard();
				return { kind: "idle" };
			}
		}
	}

	const config = await loadRepoConfig(kit, m.owner, m.repo);
	if (config.kind === "missing") return { kind: "disabled" };
	const port = new RestGitHub({
		octokit: kit,
		owner: m.owner,
		repo: m.repo,
		baseBranch: base,
		appId: deps.appId,
	});
	if (config.kind === "invalid") {
		await port.reportDisabled(config.reason);
		return { kind: "invalid-config" };
	}

	for (let attempt = 1; ; attempt++) {
		const store = deps.table.queue(key, m.installationId);
		try {
			if (m.command) await applyStoredCommand(store, m.command);
			const { wakeAfterSeconds, actions, batchId } = await reconcile(
				port,
				store,
				config.config,
				deps.now(),
			);
			if (wakeAfterSeconds !== null) {
				await deps.waker.wakeAt(
					{ ...m, command: undefined, id: `wake:${deps.now() + wakeAfterSeconds}` },
					deps.now() + wakeAfterSeconds,
				);
			}
			return { kind: "reconciled", wakeAfterSeconds, actions, batchId };
		} catch (e) {
			// Someone else wrote this queue meanwhile: reload and decide again, never overwrite.
			if (e instanceof VersionConflict && attempt < MAX_ATTEMPTS) continue;
			throw e;
		}
	}
}

async function applyStoredCommand(store: QueueStore, command: Command): Promise<void> {
	const state: QueueState = await store.load();
	await store.save(applyCommand(state, command));
}

async function fanOut(deps: ReconcileDeps, kit: Kit, m: QueueMessage): Promise<Outcome> {
	const at = { owner: m.owner, repo: m.repo };
	const bases = new Set<string>();
	if (m.command && m.command.kind !== "unfreeze") {
		// `/queue` and `/dequeue` belong to the queue of the PR they were posted on.
		const { data: pull } = await kit.rest.pulls.get({ ...at, pull_number: m.command.number });
		bases.add(pull.base.ref);
	} else {
		for (const b of await deps.table.bases(m.owner, m.repo)) bases.add(b);
		if (!m.command) {
			const open = await kit.paginate(kit.rest.pulls.list, { ...at, state: "open", per_page: 100 });
			for (const p of open) bases.add(p.base.ref);
		}
	}
	for (const base of bases) await deps.outbox.send({ ...m, base, id: `${m.id}>${base}` });
	return { kind: "fanned-out", bases: [...bases] };
}

/** Every 10 minutes: look at every known queue, in case a webhook was missed. */
export async function sweep(deps: ReconcileDeps): Promise<number> {
	const id = `sweep:${deps.now()}`;
	const queues = await deps.table.all();
	const repos = new Map<string, StoredQueue>();
	for (const q of queues) {
		await deps.outbox.send({
			installationId: q.installationId,
			owner: q.owner,
			repo: q.repo,
			base: q.base,
			id,
		});
		repos.set(`${q.owner}/${q.repo}`.toLowerCase(), q);
	}
	// And once per repository for "every base", which also finds bases with new PRs.
	for (const q of repos.values()) {
		await deps.outbox.send({
			installationId: q.installationId,
			owner: q.owner,
			repo: q.repo,
			base: null,
			id,
		});
	}
	return queues.length + repos.size;
}

/**
 * Process a batch in order. On a failure, that message and every later one
 * are reported back to SQS, which FIFO requires to keep ordering.
 */
export function createReconcileHandler(deps: ReconcileDeps) {
	return async (event: SQSEvent): Promise<SQSBatchResponse> => {
		const failures: SQSBatchResponse["batchItemFailures"] = [];
		for (const record of event.Records) {
			if (failures.length > 0) {
				failures.push({ itemIdentifier: record.messageId });
				continue;
			}
			let m: QueueMessage;
			try {
				m = JSON.parse(record.body) as QueueMessage;
			} catch {
				// Unparseable can never succeed; dropping it is the only way forward.
				deps.log({
					level: "error",
					msg: "dropping malformed message",
					messageId: record.messageId,
				});
				continue;
			}
			const started = performance.now();
			try {
				const outcome = await handleMessage(deps, m);
				deps.log({ ...reconcileLogLine(m, outcome, performance.now() - started) });
			} catch (e) {
				deps.log({
					level: "error",
					msg: "reconcile failed; SQS will redeliver",
					repo: `${m.owner}/${m.repo}`,
					base: m.base,
					error: e instanceof Error ? e.name : "unknown",
					status: typeof e === "object" && e !== null && "status" in e ? e.status : undefined,
					durationMs: Math.round(performance.now() - started),
				});
				failures.push({ itemIdentifier: record.messageId });
			}
		}
		return { batchItemFailures: failures };
	};
}
