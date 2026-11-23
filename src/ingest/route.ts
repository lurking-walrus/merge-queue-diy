/**
 * Turn a verified webhook into a "poke": which queue should be reconciled.
 *
 * A poke carries no data from the event beyond that. The reconciler re-reads
 * the truth from GitHub, so a duplicated, reordered or forged-but-signed event
 * can make the queue look again, never make it act on stale information.
 */

import { z } from "zod";
import type { Command } from "../core/types";

export interface Poke {
	installationId: number;
	owner: string;
	repo: string;
	/** The base branch whose queue to reconcile; null means every queue in the repo. */
	base: string | null;
	command?: Command;
}

const envelope = z.object({
	installation: z.object({ id: z.number() }),
	repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

const pullRequestEvent = z.object({
	pull_request: z.object({ base: z.object({ ref: z.string() }) }),
});

const pushEvent = z.object({ ref: z.string(), deleted: z.boolean().optional() });

const commentEvent = z.object({
	action: z.literal("created"),
	issue: z.object({ number: z.number(), pull_request: z.object({}).loose() }),
	comment: z.object({ body: z.string(), author_association: z.string() }),
});

/** Only people with write-level standing in the repository may steer the queue. */
const MAY_COMMAND = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The queue's own check run (src/github/adapter.ts `CHECK_NAME`). Its events
 * are the queue talking to itself and are ignored.
 */
export const OWN_CHECK_NAME = "merge-queue";

const checkRunEvent = z.object({
	action: z.string(),
	check_run: z.object({ name: z.string() }),
});

const statusEvent = z.object({ state: z.string() });

/**
 * Whether a check event can change what the queue decides. Only a check that
 * finished can: one starting, queued or in progress leaves a PR exactly as
 * pending as before. A busy repository sends dozens of check events per push,
 * and each poke costs a reconcile's worth of API calls, so the rest are
 * dropped here. `check_suite` and `workflow_run` repeat what the completed
 * check runs already say. Anything missed is repaired by the sweep.
 */
function checkFinished(event: string, payload: unknown): boolean {
	if (event === "check_run") {
		const p = checkRunEvent.safeParse(payload);
		return p.success && p.data.action === "completed" && p.data.check_run.name !== OWN_CHECK_NAME;
	}
	if (event === "status") {
		const p = statusEvent.safeParse(payload);
		return p.success && p.data.state !== "pending";
	}
	return false;
}

export function parseCommand(body: string, number: number): Command | null {
	const first = body.trim().split(/\r?\n/, 1)[0]?.trim();
	if (first === "/queue") return { kind: "queue", number };
	if (first === "/dequeue") return { kind: "dequeue", number };
	if (first === "/queue unfreeze") return { kind: "unfreeze" };
	return null;
}

/**
 * @param allowedOwners lower-cased account logins this deployment serves. An
 *   empty list serves nobody: a deployment must opt in to each owner.
 */
export function routeEvent(event: string, payload: unknown, allowedOwners: string[]): Poke | null {
	const env = envelope.safeParse(payload);
	if (!env.success) return null;
	const owner = env.data.repository.owner.login;
	if (!allowedOwners.includes(owner.toLowerCase())) return null;
	const poke = {
		installationId: env.data.installation.id,
		owner,
		repo: env.data.repository.name,
	};

	if (event === "pull_request") {
		const p = pullRequestEvent.safeParse(payload);
		return p.success ? { ...poke, base: p.data.pull_request.base.ref } : null;
	}
	if (event === "push") {
		const p = pushEvent.safeParse(payload);
		if (!p.success || p.data.deleted || !p.data.ref.startsWith("refs/heads/")) return null;
		return { ...poke, base: p.data.ref.slice("refs/heads/".length) };
	}
	if (event === "check_run" || event === "status") {
		return checkFinished(event, payload) ? { ...poke, base: null } : null;
	}
	if (event === "issue_comment") {
		const p = commentEvent.safeParse(payload);
		if (!p.success || !MAY_COMMAND.has(p.data.comment.author_association)) return null;
		const command = parseCommand(p.data.comment.body, p.data.issue.number);
		return command ? { ...poke, base: null, command } : null;
	}
	return null;
}
