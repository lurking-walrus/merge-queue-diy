/**
 * What travels on the SQS FIFO queue, and how it is grouped.
 *
 * A message is a poke (which queue to look at) plus an id saying why it was
 * sent. The id makes otherwise identical pokes distinct, so content-based
 * deduplication — which EventBridge Scheduler deliveries rely on — only ever
 * drops true duplicates: a redelivered webhook, a repeated fan-out.
 */

import { createHash } from "node:crypto";
import type { Poke } from "../ingest/route";

export interface QueueMessage extends Poke {
	/**
	 * Why this poke exists: `webhook:<delivery id>`, `wake:<epoch>`,
	 * `sweep:<epoch>`, or a parent id plus `>base` for a fan-out.
	 */
	id: string;
}

/**
 * One group per queue (repository + base branch), so at most one reconcile
 * runs per queue. A poke for "every base" gets its own group and is only
 * ever fanned out, never reconciled, so it cannot race a queue's own group.
 */
export function messageGroupId(m: Pick<Poke, "owner" | "repo" | "base">): string {
	const readable = `${m.owner}/${m.repo}#${m.base ?? "*"}`.toLowerCase();
	// SQS allows up to 128 printable ASCII characters; anything else is hashed.
	if (/^[\x21-\x7e]{1,128}$/.test(readable)) return readable;
	return `sha256:${createHash("sha256").update(readable).digest("hex")}`;
}

/** SQS allows 128 characters; a hash keeps long branch names and ids inside that. */
export function deduplicationId(m: QueueMessage): string {
	return createHash("sha256")
		.update(`${messageGroupId(m)}|${m.id}`)
		.digest("hex");
}

/** Where messages go. Sending must be safe to repeat; dedup ids make it so. */
export interface Outbox {
	send(m: QueueMessage): Promise<void>;
}

/** Deliver a poke later. One pending wake-up per queue; a newer one replaces it. */
export interface Waker {
	wakeAt(m: QueueMessage, atEpochSeconds: number): Promise<void>;
}
