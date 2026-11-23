/**
 * Dry run: read a real repository, run `decide()` once, and describe the
 * actions it returns. Nothing is executed.
 *
 * This is the adapter's first contact with live GitHub, so it is made safe
 * structurally rather than by care: the client refuses every request that is
 * not a GET before it leaves the process, and no effect method is ever
 * called. There is no stored state either; the plan is what the queue would
 * do if it started from scratch now.
 */

import type { RepoConfig } from "../core/config";
import { decide } from "../core/decide";
import { type Action, emptyState, type PullState, type Step } from "../core/types";
import { RestGitHub } from "../github/adapter";
import { type ConfigResult, loadRepoConfig, parseConfigText } from "../github/config";
import type { Kit } from "../github/octokit";

/** Make a client unable to change anything: any non-GET request throws before it is sent. */
export function readOnly(kit: Kit): Kit {
	kit.hook.before("request", (options) => {
		const method = String(options.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			throw new Error(`dry run: refusing to send ${method} ${String(options.url)}`);
		}
	});
	return kit;
}

export interface PlanOptions {
	kit: Kit;
	owner: string;
	repo: string;
	base: string;
	/** Use this config text instead of the repository's `.github/merge-queue.yml`. */
	configText?: string;
	/** Plan as if `mode: enforce`, to see the batch a shadow-mode repo would build. */
	enforce?: boolean;
	/** Epoch seconds. */
	now: number;
}

export type PlanResult =
	| { config: Exclude<ConfigResult, { kind: "ok" }> }
	| { config: { kind: "ok"; config: RepoConfig }; baseSha: string; pulls: PullState[]; step: Step };

export async function plan(o: PlanOptions): Promise<PlanResult> {
	const loaded =
		o.configText !== undefined
			? parseConfigText(o.configText)
			: await loadRepoConfig(o.kit, o.owner, o.repo);
	if (loaded.kind !== "ok") return { config: loaded };
	const config: RepoConfig = o.enforce ? { ...loaded.config, mode: "enforce" } : loaded.config;

	const port = new RestGitHub({ octokit: o.kit, owner: o.owner, repo: o.repo, baseBranch: o.base });
	const { baseSha, pulls } = await port.readQueue(config);
	const step = decide({
		now: o.now,
		config,
		baseBranch: o.base,
		baseSha,
		pulls,
		state: emptyState(),
		batchChecks: null,
	});
	return { config: { kind: "ok", config }, baseSha, pulls, step };
}

function describe(a: Action): string {
	const refs = (ms: { number: number }[]) => ms.map((m) => `#${m.number}`).join(", ");
	switch (a.type) {
		case "build":
			return `build batch ${a.batchId} on ${a.baseSha.slice(0, 7)} from ${refs(a.members)} → branch ${a.branch} (${a.mergeMethod})`;
		case "land":
			return `land batch ${a.batchId}: ${refs(a.members)} (${a.mergeMethod}, tested ${a.testedSha.slice(0, 7)})`;
		case "report":
			return `report #${a.number}: merge-queue = ${a.state} — ${a.summary}`;
		case "comment":
			return `comment on #${a.number}: ${JSON.stringify(a.payload)}`;
		case "deleteBranch":
			return `delete branch ${a.branch}`;
		case "cancelRuns":
			return `cancel runs on ${a.sha.slice(0, 7)}`;
		case "openIssue":
			return `open issue: ${a.title}`;
	}
}

export function formatPlan(r: PlanResult, o: Pick<PlanOptions, "owner" | "repo" | "base">): string {
	const where = `${o.owner}/${o.repo}@${o.base}`;
	if (r.config.kind === "missing")
		return `${where}: no .github/merge-queue.yml on the default branch — the queue is off.`;
	if (r.config.kind === "invalid") return `${where}: the queue is off — ${r.config.reason}`;
	if (!("step" in r)) return where;

	const c = r.config.config;
	const lines = [
		`${where} at ${r.baseSha.slice(0, 7)} — mode ${c.mode}, enqueue ${c.enqueue}, ${c.mergeMethod}, batch ${c.batchSize}`,
		`required checks: ${c.requiredChecks.join(", ")}; PR checks: ${c.prChecks.join(", ") || "(none)"}`,
		"",
		`${r.pulls.length} open pull request(s):`,
	];
	for (const p of [...r.pulls].sort((a, b) => a.number - b.number)) {
		const flags = [
			p.draft && "draft",
			p.fromFork && "fork",
			p.upToDate && "up to date",
			p.labels.length > 0 && `labels: ${p.labels.join(", ")}`,
		].filter(Boolean);
		const checks =
			p.checks.state === "failure" ? `failure (${p.checks.failed.join(", ")})` : p.checks.state;
		lines.push(
			`  #${p.number} ${p.headSha.slice(0, 7)} checks ${checks}${flags.length ? `; ${flags.join("; ")}` : ""}`,
		);
	}
	lines.push("", `would do (${r.step.actions.length} action(s), none executed):`);
	for (const a of r.step.actions) lines.push(`  - ${describe(a)}`);
	if (r.step.actions.length === 0) lines.push("  (nothing)");
	if (r.step.wakeAfterSeconds !== null)
		lines.push("", `would look again in ${r.step.wakeAfterSeconds}s`);
	return lines.join("\n");
}
