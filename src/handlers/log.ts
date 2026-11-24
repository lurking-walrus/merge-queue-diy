/**
 * The one log line written per handled message.
 *
 * Built from an allowlist of fields, so nothing can leak in by accident: no
 * secrets, no token fragments, no PR titles or bodies, no comment text. Only
 * names, numbers, counts and timings.
 */

import type { QueueMessage } from "./messages";
import type { Outcome } from "./reconcile";

/** Written on every reconcile of a base branch that has `strict` on, until it is off. */
export const STRICT_WARNING =
	"base branch requires branches to be up to date (strict): enforce mode is paused until it is turned off";

export interface ReconcileLogLine {
	/** `warn` when something needs a human, e.g. `strict` on the base branch. */
	level: "info" | "warn";
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
	/** A fixed sentence from this file, never data. */
	warning?: string;
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
		level: outcome.strictChecks ? "warn" : "info",
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
		...(outcome.strictChecks ? { warning: STRICT_WARNING } : {}),
		durationMs: Math.round(durationMs),
	};
}
