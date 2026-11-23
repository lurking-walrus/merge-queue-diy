/**
 * The one log line written per handled message.
 *
 * Built from an allowlist of fields, so nothing can leak in by accident: no
 * secrets, no token fragments, no PR titles or bodies, no comment text. Only
 * names, numbers, counts and timings.
 */

import type { QueueMessage } from "./messages";
import type { Outcome } from "./reconcile";

export interface ReconcileLogLine {
	level: "info";
	msg: "reconcile";
	repo: string;
	base: string | null;
	/** Why the message was sent: webhook, wake, sweep. Never the payload. */
	trigger: string;
	outcome: Outcome["kind"];
	batch: number | null;
	actions: Record<string, number>;
	wakeAfterSeconds: number | null;
	fannedOutTo?: string[];
	durationMs: number;
}

export function triggerKind(id: string): string {
	const kind = id.split(":", 1)[0] ?? "";
	return /^[a-z]+$/.test(kind) ? kind : "unknown";
}

export function reconcileLogLine(
	m: QueueMessage,
	outcome: Outcome,
	durationMs: number,
): ReconcileLogLine {
	return {
		level: "info",
		msg: "reconcile",
		repo: `${m.owner}/${m.repo}`,
		base: m.base,
		trigger: triggerKind(m.id),
		outcome: outcome.kind,
		batch: outcome.batchId ?? null,
		actions: Object.fromEntries(
			Object.entries(outcome.actions ?? {}).filter(
				(e): e is [string, number] => e[1] !== undefined,
			),
		),
		wakeAfterSeconds: outcome.wakeAfterSeconds ?? null,
		...(outcome.bases ? { fannedOutTo: outcome.bases } : {}),
		durationMs: Math.round(durationMs),
	};
}
