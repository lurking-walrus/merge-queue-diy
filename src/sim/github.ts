/**
 * An in-memory GitHub, just detailed enough to exercise the queue end to end:
 * commits with trees, three-way merges that can conflict, pull requests, and a
 * CI that runs when a PR head or a batch branch appears.
 *
 * It implements the same {@link GitHubPort} as the production adapter, so the
 * scenarios in `scenarios.test.ts` run the real core and the real reconcile
 * loop. It is test support, not a GitHub emulator: only what the queue touches
 * is modelled.
 */

import { createHash } from "node:crypto";
import type { RepoConfig } from "../core/config";
import type { Action, BuildResult, LandResult, PullState, QueueState, Rollup } from "../core/types";
import { emptyState } from "../core/types";
import type { GitHubPort, QueueStore } from "../ports";

type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

/** Path → content. A `null` in a change set deletes the path. */
export type Tree = Record<string, string>;
export type Changes = Record<string, string | null>;
export type CiFn = (tree: Tree) => Record<string, "success" | "failure">;

interface SimCommit {
	tree: Tree;
	parents: string[];
}

interface SimPull {
	number: number;
	headSha: string;
	/** The base-branch commit the PR branched from; the merge base for every merge. */
	forkBase: string;
	draft: boolean;
	fromFork: boolean;
	labels: string[];
	headUpdatedAt: number;
	state: "open" | "merged" | "closed";
}

export interface CiRun {
	sha: string;
	kind: "pr" | "batch";
}

function apply(tree: Tree, changes: Changes): Tree {
	const next = { ...tree };
	for (const [path, content] of Object.entries(changes)) {
		if (content === null) delete next[path];
		else next[path] = content;
	}
	return next;
}

function treeId(tree: Tree): string {
	const sorted = Object.keys(tree)
		.sort()
		.map((k) => [k, tree[k]]);
	return createHash("sha1").update(JSON.stringify(sorted)).digest("hex");
}

/** Per-path three-way merge. Returns null when both sides changed a path differently. */
function merge3(ancestor: Tree, ours: Tree, theirs: Tree): Tree | null {
	const out: Tree = {};
	for (const path of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
		const a = ancestor[path];
		const o = ours[path];
		const t = theirs[path];
		let pick: string | undefined;
		if (o === t) pick = o;
		else if (o === a) pick = t;
		else if (t === a) pick = o;
		else return null;
		if (pick !== undefined) out[path] = pick;
	}
	return out;
}

export class SimGitHub implements GitHubPort {
	readonly baseBranch = "main";
	/** Epoch seconds; tests advance it. */
	now = 1_000_000;

	readonly ciRuns: CiRun[] = [];
	readonly cancelled: string[] = [];
	readonly reports: ActionOf<"report">[] = [];
	readonly comments: ActionOf<"comment">[] = [];
	readonly issues: ActionOf<"openIssue">[] = [];

	private readonly commits = new Map<string, SimCommit>();
	private readonly branches = new Map<string, string>();
	private readonly pulls = new Map<number, SimPull>();
	private readonly results = new Map<string, Record<string, "success" | "failure">>();
	private readonly pendingCi = new Set<string>();
	private counter = 0;

	constructor(private readonly opts: { ci?: CiFn; branchPrefix?: string; initial?: Tree } = {}) {
		this.branches.set("main", this.commit(opts.initial ?? { "README.md": "hello" }, []));
	}

	// --- What a test does to the repository ---------------------------------

	openPull(
		changes: Changes,
		o: { draft?: boolean; fromFork?: boolean; labels?: string[] } = {},
	): number {
		const base = this.main();
		const number = this.pulls.size + 1;
		const headSha = this.commit(apply(this.tree(base), changes), [base]);
		this.pulls.set(number, {
			number,
			headSha,
			forkBase: base,
			draft: o.draft ?? false,
			fromFork: o.fromFork ?? false,
			labels: o.labels ?? [],
			headUpdatedAt: this.now,
			state: "open",
		});
		this.startCi(headSha, "pr");
		return number;
	}

	pushToPull(number: number, changes: Changes): void {
		const p = this.pull(number);
		p.headSha = this.commit(apply(this.tree(p.headSha), changes), [p.headSha]);
		p.headUpdatedAt = this.now;
		this.startCi(p.headSha, "pr");
	}

	/** A direct push to the base branch, bypassing the queue. */
	pushToBase(changes: Changes): void {
		const base = this.main();
		this.branches.set("main", this.commit(apply(this.tree(base), changes), [base]));
	}

	closePull(number: number): void {
		this.pull(number).state = "closed";
	}

	/** Complete every running CI run. Returns how many finished. */
	finishCi(): number {
		const ci = this.opts.ci ?? (() => ({ ci: "success" as const }));
		const n = this.pendingCi.size;
		for (const sha of this.pendingCi) this.results.set(sha, ci(this.tree(sha)));
		this.pendingCi.clear();
		return n;
	}

	// --- What a test asserts on ---------------------------------------------

	mainTree(): Tree {
		return this.tree(this.main());
	}

	pullState(number: number): SimPull["state"] {
		return this.pull(number).state;
	}

	branchNames(): string[] {
		return [...this.branches.keys()];
	}

	batchRuns(): number {
		return this.ciRuns.filter((r) => r.kind === "batch").length;
	}

	lastReport(number: number): ActionOf<"report"> | undefined {
		return this.reports.findLast((r) => r.number === number);
	}

	// --- GitHubPort ---------------------------------------------------------

	async readQueue(config: RepoConfig): Promise<{ baseSha: string; pulls: PullState[] }> {
		const baseSha = this.main();
		const pulls: PullState[] = [];
		for (const p of this.pulls.values()) {
			if (p.state !== "open") continue;
			pulls.push({
				number: p.number,
				headSha: p.headSha,
				headUpdatedAt: p.headUpdatedAt,
				draft: p.draft,
				fromFork: p.fromFork,
				labels: [...p.labels],
				checks: await this.readChecks(p.headSha, config.prChecks),
				upToDate: p.forkBase === baseSha,
			});
		}
		return { baseSha, pulls };
	}

	async readChecks(sha: string, names: string[]): Promise<Rollup> {
		const results = this.results.get(sha) ?? {};
		const failed = names.filter((n) => results[n] === "failure");
		if (failed.length > 0) return { state: "failure", failed };
		if (names.some((n) => results[n] === undefined)) return { state: "pending", failed: [] };
		return { state: "success", failed: [] };
	}

	async build(a: ActionOf<"build">): Promise<BuildResult> {
		const existing = this.branches.get(a.branch);
		if (existing) return { batchId: a.batchId, sha: existing, conflicts: [] };

		let tip = a.baseSha;
		const merged: SimPull[] = [];
		const conflicts: BuildResult["conflicts"] = [];
		for (const m of a.members) {
			const p = this.pull(m.number);
			const tree = merge3(this.tree(p.forkBase), this.tree(tip), this.tree(m.headSha));
			if (tree === null) {
				const mine = this.changedPaths(p);
				conflicts.push({
					number: m.number,
					conflictsWith: merged
						.filter((other) => this.changedPaths(other).some((path) => mine.includes(path)))
						.map((other) => other.number),
				});
				continue;
			}
			tip = this.commit(tree, a.mergeMethod === "merge" ? [tip, m.headSha] : [tip]);
			merged.push(p);
		}
		if (merged.length === 0) return { batchId: a.batchId, sha: null, conflicts };

		// One ref creation at the final commit: exactly one CI run per batch.
		this.branches.set(a.branch, tip);
		if (a.branch.startsWith(`${this.opts.branchPrefix ?? "mq"}/`)) this.startCi(tip, "batch");
		return { batchId: a.batchId, sha: tip, conflicts };
	}

	async land(a: ActionOf<"land">): Promise<LandResult> {
		const none = { batchId: a.batchId, merged: [], failed: null, treeMatches: null };
		if (this.main() !== a.baseSha) return { ...none, baseMoved: true };

		const merged: number[] = [];
		let failed: LandResult["failed"] = null;
		for (const m of a.members) {
			const p = this.pull(m.number);
			if (p.state !== "open" || p.headSha !== m.headSha) {
				failed = { number: m.number, message: "head changed or pull request closed" };
				break;
			}
			if (a.mergeMethod === "squash") {
				const tree = merge3(this.tree(p.forkBase), this.mainTree(), this.tree(p.headSha));
				if (tree === null) {
					failed = { number: m.number, message: "merge conflict" };
					break;
				}
				this.branches.set("main", this.commit(tree, [this.main()]));
			}
			p.state = "merged";
			merged.push(m.number);
		}
		// Merge mode is one fast-forward to the tested commit, all or nothing.
		if (a.mergeMethod === "merge" && failed === null) this.branches.set("main", a.testedSha);

		const treeMatches =
			failed === null ? treeId(this.mainTree()) === treeId(this.tree(a.testedSha)) : null;
		return { batchId: a.batchId, baseMoved: false, merged, failed, treeMatches };
	}

	async deleteBranch(branch: string): Promise<void> {
		this.branches.delete(branch);
	}

	async cancelRuns(sha: string): Promise<void> {
		if (this.pendingCi.delete(sha)) this.cancelled.push(sha);
	}

	async report(a: ActionOf<"report">): Promise<void> {
		this.reports.push(a);
	}

	async comment(a: ActionOf<"comment">): Promise<void> {
		this.comments.push(a);
	}

	async openIssue(a: ActionOf<"openIssue">): Promise<void> {
		this.issues.push(a);
	}

	// --- Internals ----------------------------------------------------------

	private commit(tree: Tree, parents: string[]): string {
		const sha = createHash("sha1")
			.update(`${treeId(tree)}|${parents.join(",")}|${this.counter++}`)
			.digest("hex");
		this.commits.set(sha, { tree, parents });
		return sha;
	}

	private tree(sha: string): Tree {
		const c = this.commits.get(sha);
		if (!c) throw new Error(`sim: unknown commit ${sha}`);
		return c.tree;
	}

	private main(): string {
		const sha = this.branches.get("main");
		if (!sha) throw new Error("sim: no main branch");
		return sha;
	}

	private pull(number: number): SimPull {
		const p = this.pulls.get(number);
		if (!p) throw new Error(`sim: unknown pull request #${number}`);
		return p;
	}

	private changedPaths(p: SimPull): string[] {
		const before = this.tree(p.forkBase);
		const after = this.tree(p.headSha);
		return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
			(path) => before[path] !== after[path],
		);
	}

	private startCi(sha: string, kind: CiRun["kind"]): void {
		this.pendingCi.add(sha);
		this.ciRuns.push({ sha, kind });
	}
}

export class MemoryStore implements QueueStore {
	state: QueueState = emptyState();

	async load(): Promise<QueueState> {
		return structuredClone(this.state);
	}

	async save(state: QueueState): Promise<void> {
		this.state = structuredClone(state);
	}
}
