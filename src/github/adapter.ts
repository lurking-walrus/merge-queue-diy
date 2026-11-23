/**
 * The production {@link GitHubPort}: GitHub's REST API through Octokit.
 *
 * It must behave like `src/sim/github.ts` for every scenario in
 * `src/sim/scenarios.test.ts`; those scenarios also run against this adapter
 * over HTTP (see `fake.ts`). The repository is never cloned: batches are
 * built with `POST /merges` and the Git Data API (docs/DESIGN.md §5–§6).
 *
 * Every method is safe to repeat, because a reconcile can crash between
 * saving state and finishing an effect and the next one re-emits it.
 */

import type { RepoConfig } from "../core/config";
import type {
	Action,
	BuildResult,
	EjectionPayload,
	LandResult,
	Member,
	PullState,
	ReportState,
	ReviewCounts,
	ReviewRequirements,
	Rollup,
} from "../core/types";
import { NO_REVIEW_REQUIREMENTS } from "../core/types";
import type { GitHubPort, QueueRead } from "../ports";
import { httpMessage, httpStatus, type Kit } from "./octokit";

type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

/** The one check run this app owns. A ruleset can require it (docs/DESIGN.md §7). */
export const CHECK_NAME = "merge-queue";
/** Finds the ejection comment again so a repeat edits it instead of adding another. */
export const COMMENT_MARKER = "<!-- merge-queue:ejection -->";
/** One page of open PRs with what review rules can require of them. */
export const REVIEW_QUERY = `query MergeQueueReviews($owner: String!, $repo: String!, $base: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, baseRefName: $base, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        reviewThreads(first: 100) { nodes { isResolved } }
        latestOpinionatedReviews(first: 100) { nodes { state } }
      }
    }
  }
}`;

interface ReviewQuery {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: Array<{
				number: number;
				reviewThreads: { nodes: Array<{ isResolved: boolean } | null> | null };
				latestOpinionatedReviews: { nodes: Array<{ state: string } | null> | null } | null;
			} | null> | null;
		};
	} | null;
}

/** Records which member a batch commit came from, so a repeated build can recover it. */
const MEMBER_TRAILER = "Merge-Queue-Member:";

type CheckState = "pending" | "success" | "failure";

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function checkRunState(status: string, conclusion: string | null | undefined): CheckState {
	if (status !== "completed") return "pending";
	return PASSING_CONCLUSIONS.has(conclusion ?? "") ? "success" : "failure";
}

function statusState(state: string): CheckState {
	if (state === "success") return "success";
	if (state === "pending") return "pending";
	return "failure";
}

function epochSeconds(iso: string | null | undefined): number {
	const ms = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function reportCheck(
	state: ReportState,
	shadow: boolean,
): {
	status: "in_progress" | "completed";
	conclusion?: string;
} {
	// Shadow mode only describes what the queue would do. A check left in
	// progress looks like stuck CI on every PR, so it is shown as finished.
	if (shadow) return { status: "completed", conclusion: "neutral" };
	if (state === "ejected") return { status: "completed", conclusion: "failure" };
	if (state === "held") return { status: "completed", conclusion: "neutral" };
	return { status: "in_progress" };
}

export function renderEjection(payload: EjectionPayload): string {
	const refs = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");
	let why: string;
	if (payload.reason === "conflict") {
		why = payload.conflicts_with?.length
			? `It conflicts with ${refs(payload.conflicts_with)}, which merged ahead of it in the batch.`
			: "It does not merge cleanly onto the base branch.";
	} else if (payload.reason === "checks_failed") {
		why = `Required checks failed on its batch: ${(payload.failed_checks ?? []).join(", ") || "unknown"}.`;
	} else {
		why = "GitHub refused to merge it.";
	}
	return [
		COMMENT_MARKER,
		"**Merge queue: removed from the queue.**",
		"",
		why,
		"Push a new commit to re-enter the queue.",
		"",
		"```json",
		JSON.stringify(payload),
		"```",
	].join("\n");
}

function memberMessage(batchId: number, m: Member): string {
	return `merge-queue: batch ${batchId}, #${m.number}\n\n${MEMBER_TRAILER} #${m.number} ${m.headSha}`;
}

function membersNamedIn(message: string): Set<string> {
	const found = new Set<string>();
	for (const line of message.split("\n")) {
		const match = line.match(/^Merge-Queue-Member: #(\d+) ([0-9a-f]+)$/);
		if (match) found.add(`${match[1]}@${match[2]}`);
	}
	return found;
}

export interface RestGitHubOptions {
	octokit: Kit;
	owner: string;
	repo: string;
	baseBranch: string;
	/** This app's id. Scopes check-run lookups to runs the app itself created. */
	appId?: number;
}

export class RestGitHub implements GitHubPort {
	readonly baseBranch: string;
	private readonly kit: Kit;
	private readonly owner: string;
	private readonly repo: string;
	private readonly appId: number | undefined;
	/** Commits are immutable, so these are safe to keep for the adapter's lifetime. */
	private readonly commitInfo = new Map<string, { date: number; tree: string }>();
	private readonly changedFiles = new Map<string, string[]>();

	constructor(opts: RestGitHubOptions) {
		this.kit = opts.octokit;
		this.owner = opts.owner;
		this.repo = opts.repo;
		this.baseBranch = opts.baseBranch;
		this.appId = opts.appId;
	}

	private get at() {
		return { owner: this.owner, repo: this.repo };
	}

	// --- Reads --------------------------------------------------------------

	async readQueue(config: RepoConfig): Promise<QueueRead> {
		const baseSha = await this.branchSha(this.baseBranch);
		if (!baseSha) throw new Error(`base branch ${this.baseBranch} does not exist`);
		const reviewRequirements =
			config.reviewRequirements === "none"
				? NO_REVIEW_REQUIREMENTS
				: await this.readReviewRequirements();
		const needReviews =
			reviewRequirements.resolvedConversations || reviewRequirements.approvals > 0;
		const reviews = needReviews ? await this.readReviewCounts() : new Map<number, ReviewCounts>();
		const reviewsOf = (n: number): ReviewCounts =>
			reviews.get(n) ?? { unresolvedConversations: 0, approvals: 0 };
		const open = await this.kit.paginate(this.kit.rest.pulls.list, {
			...this.at,
			state: "open",
			base: this.baseBranch,
			per_page: 100,
		});
		const pulls: PullState[] = [];
		for (const p of open) {
			// A deleted fork leaves `head.repo` null; that is still not this repository.
			const fromFork = p.head.repo?.full_name !== p.base.repo.full_name;
			const draft = p.draft ?? false;
			const labels = p.labels.map((l) => l.name);
			if (fromFork || draft) {
				// Never queued, so do not spend API calls on them.
				pulls.push({
					number: p.number,
					headSha: p.head.sha,
					headUpdatedAt: epochSeconds(p.updated_at),
					draft,
					fromFork,
					labels,
					checks: { state: "pending", failed: [] },
					upToDate: false,
					reviews: reviewsOf(p.number),
				});
				continue;
			}
			const { data: cmp } = await this.kit.rest.repos.compareCommitsWithBasehead({
				...this.at,
				basehead: `${baseSha}...${p.head.sha}`,
				per_page: 1,
			});
			pulls.push({
				number: p.number,
				headSha: p.head.sha,
				headUpdatedAt: (await this.commit(p.head.sha)).date,
				draft,
				fromFork,
				labels,
				checks: await this.readChecks(p.head.sha, config.prChecks),
				upToDate: cmp.behind_by === 0,
				reviews: reviewsOf(p.number),
			});
		}
		return { baseSha, pulls, reviewRequirements };
	}

	/**
	 * The review requirements of the rules that apply to the base branch
	 * (repository and organization rulesets). Classic branch protection is not
	 * readable without the Administration permission; set
	 * `review_requirements` explicitly there. Unreadable rules count as none.
	 */
	private async readReviewRequirements(): Promise<ReviewRequirements> {
		let rules: { type: string; parameters?: unknown }[];
		try {
			rules = await this.kit.paginate(this.kit.rest.repos.getBranchRules, {
				...this.at,
				branch: this.baseBranch,
				per_page: 100,
			});
		} catch (e) {
			if (httpStatus(e) === 403 || httpStatus(e) === 404) return NO_REVIEW_REQUIREMENTS;
			throw e;
		}
		const out = { ...NO_REVIEW_REQUIREMENTS };
		for (const rule of rules) {
			if (rule.type !== "pull_request") continue;
			const p = (rule.parameters ?? {}) as {
				required_review_thread_resolution?: boolean;
				required_approving_review_count?: number;
			};
			out.resolvedConversations ||= p.required_review_thread_resolution === true;
			out.approvals = Math.max(out.approvals, p.required_approving_review_count ?? 0);
		}
		return out;
	}

	/**
	 * Unresolved conversations and approvals of every open PR on the base
	 * branch. REST has no resolution state for review threads, so this is one
	 * GraphQL query per 50 PRs (a read: the dry run's read-only client allows it).
	 */
	private async readReviewCounts(): Promise<Map<number, ReviewCounts>> {
		const out = new Map<number, ReviewCounts>();
		let after: string | null = null;
		do {
			const res: ReviewQuery = await this.kit.graphql<ReviewQuery>(REVIEW_QUERY, {
				owner: this.owner,
				repo: this.repo,
				base: this.baseBranch,
				after,
			});
			const prs = res.repository?.pullRequests;
			for (const pr of prs?.nodes ?? []) {
				if (!pr) continue;
				out.set(pr.number, {
					unresolvedConversations: (pr.reviewThreads.nodes ?? []).filter((t) => t && !t.isResolved)
						.length,
					approvals: (pr.latestOpinionatedReviews?.nodes ?? []).filter(
						(r) => r?.state === "APPROVED",
					).length,
				});
			}
			after = prs?.pageInfo.hasNextPage ? prs.pageInfo.endCursor : null;
		} while (after);
		return out;
	}

	async readChecks(sha: string, names: string[]): Promise<Rollup> {
		if (names.length === 0) return { state: "success", failed: [] };
		// Latest result per name across check runs and legacy commit statuses.
		const latest = new Map<string, { at: number; id: number; state: CheckState }>();
		const offer = (name: string, at: number, id: number, state: CheckState) => {
			const prev = latest.get(name);
			if (!prev || at > prev.at || (at === prev.at && id > prev.id)) {
				latest.set(name, { at, id, state });
			}
		};
		const runs = await this.kit.paginate(this.kit.rest.checks.listForRef, {
			...this.at,
			ref: sha,
			filter: "all",
			per_page: 100,
		});
		for (const r of runs) {
			const at = epochSeconds(r.completed_at ?? r.started_at);
			offer(r.name, at, r.id, checkRunState(r.status, r.conclusion));
		}
		const statuses = await this.kit.paginate(this.kit.rest.repos.listCommitStatusesForRef, {
			...this.at,
			ref: sha,
			per_page: 100,
		});
		for (const s of statuses) {
			offer(s.context, epochSeconds(s.updated_at ?? s.created_at), s.id, statusState(s.state));
		}

		const failed = names.filter((n) => latest.get(n)?.state === "failure");
		if (failed.length > 0) return { state: "failure", failed };
		if (names.some((n) => latest.get(n)?.state !== "success")) {
			return { state: "pending", failed: [] };
		}
		return { state: "success", failed: [] };
	}

	// --- Build --------------------------------------------------------------

	async build(a: ActionOf<"build">): Promise<BuildResult> {
		const existing = await this.branchSha(a.branch);
		if (existing) {
			return {
				batchId: a.batchId,
				sha: existing,
				conflicts: await this.recoverConflicts(a, existing),
			};
		}

		await this.deleteBranch(a.scratchBranch);
		await this.kit.rest.git.createRef({
			...this.at,
			ref: `refs/heads/${a.scratchBranch}`,
			sha: a.baseSha,
		});

		let tip = a.baseSha;
		const merged: Member[] = [];
		const conflicts: BuildResult["conflicts"] = [];
		for (const m of a.members) {
			const message = memberMessage(a.batchId, m);
			let mergeSha: string | null = null;
			let mergeTree: string | null = null;
			try {
				const res = await this.kit.rest.repos.merge({
					...this.at,
					base: a.scratchBranch,
					head: m.headSha,
					commit_message: message,
				});
				// 204: the head is already contained in the scratch branch.
				if (res.status === 201) {
					mergeSha = res.data.sha;
					mergeTree = res.data.commit.tree.sha;
				}
			} catch (e) {
				if (httpStatus(e) !== 409) throw e;
				conflicts.push({ number: m.number, conflictsWith: await this.overlapping(m, merged) });
				continue;
			}

			if (a.mergeMethod === "merge") {
				if (mergeSha) tip = mergeSha;
			} else {
				// Rewrite the merge as a single-parent commit with the same tree, so the
				// batch is the chain of squash commits that landing will reproduce.
				const { data: squash } = await this.kit.rest.git.createCommit({
					...this.at,
					message,
					tree: mergeTree ?? (await this.commit(tip)).tree,
					parents: [tip],
				});
				await this.kit.rest.git.updateRef({
					...this.at,
					ref: `heads/${a.scratchBranch}`,
					sha: squash.sha,
					force: true,
				});
				tip = squash.sha;
			}
			merged.push(m);
		}

		if (merged.length === 0) {
			await this.deleteBranch(a.scratchBranch);
			return { batchId: a.batchId, sha: null, conflicts };
		}

		// One ref creation at the final commit: one push event, one CI run.
		try {
			await this.kit.rest.git.createRef({ ...this.at, ref: `refs/heads/${a.branch}`, sha: tip });
		} catch (e) {
			const raced = httpStatus(e) === 422 ? await this.branchSha(a.branch) : null;
			if (!raced) throw e;
			tip = raced;
		}
		await this.deleteBranch(a.scratchBranch);
		return { batchId: a.batchId, sha: tip, conflicts };
	}

	/**
	 * The batch branch already exists, so an earlier attempt got as far as
	 * creating it. Work out from the branch itself which members made it in.
	 */
	private async recoverConflicts(
		a: ActionOf<"build">,
		tip: string,
	): Promise<BuildResult["conflicts"]> {
		const included = new Set<number>();
		if (a.mergeMethod === "merge") {
			for (const m of a.members) {
				const { data } = await this.kit.rest.repos.compareCommitsWithBasehead({
					...this.at,
					basehead: `${m.headSha}...${tip}`,
					per_page: 1,
				});
				if (data.behind_by === 0) included.add(m.number);
			}
		} else {
			const named = new Set<string>();
			let sha = tip;
			for (let i = 0; i <= a.members.length && sha !== a.baseSha; i++) {
				const { data } = await this.kit.rest.git.getCommit({ ...this.at, commit_sha: sha });
				for (const key of membersNamedIn(data.message)) named.add(key);
				const parent = data.parents[0]?.sha;
				if (!parent) break;
				sha = parent;
			}
			for (const m of a.members) if (named.has(`${m.number}@${m.headSha}`)) included.add(m.number);
		}
		const conflicts: BuildResult["conflicts"] = [];
		for (const [i, m] of a.members.entries()) {
			if (included.has(m.number)) continue;
			const earlier = a.members.slice(0, i).filter((e) => included.has(e.number));
			conflicts.push({ number: m.number, conflictsWith: await this.overlapping(m, earlier) });
		}
		return conflicts;
	}

	/** Earlier merged members whose changed files overlap this one's. */
	private async overlapping(m: Member, earlier: Member[]): Promise<number[]> {
		const mine = new Set(await this.files(m));
		const out: number[] = [];
		for (const e of earlier) {
			if ((await this.files(e)).some((f) => mine.has(f))) out.push(e.number);
		}
		return out;
	}

	private async files(m: Member): Promise<string[]> {
		const key = `${m.number}@${m.headSha}`;
		const cached = this.changedFiles.get(key);
		if (cached) return cached;
		const files = await this.kit.paginate(this.kit.rest.pulls.listFiles, {
			...this.at,
			pull_number: m.number,
			per_page: 100,
		});
		const names = files.flatMap((f) =>
			f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
		);
		this.changedFiles.set(key, names);
		return names;
	}

	// --- Land ---------------------------------------------------------------

	async land(a: ActionOf<"land">): Promise<LandResult> {
		const none = { batchId: a.batchId, merged: [], failed: null, treeMatches: null };
		if ((await this.branchSha(this.baseBranch)) !== a.baseSha) return { ...none, baseMoved: true };

		const merged: number[] = [];
		let failed: LandResult["failed"] = null;

		if (a.mergeMethod === "squash") {
			for (const m of a.members) {
				const { data: p } = await this.kit.rest.pulls.get({ ...this.at, pull_number: m.number });
				if (p.merged) {
					merged.push(m.number);
					continue;
				}
				if (p.state !== "open" || p.head.sha !== m.headSha) {
					failed = { number: m.number, message: "head changed or pull request closed" };
					break;
				}
				// The ruleset requires this check; it turns green only as the PR lands.
				await this.upsertCheck(m.headSha, "landed", `landed with batch ${a.batchId}`, {
					status: "completed",
					conclusion: "success",
				});
				try {
					await this.kit.rest.pulls.merge({
						...this.at,
						pull_number: m.number,
						merge_method: "squash",
						sha: m.headSha,
					});
					merged.push(m.number);
				} catch (e) {
					const s = httpStatus(e);
					if (s !== 405 && s !== 409 && s !== 422) throw e;
					failed = { number: m.number, message: httpMessage(e) };
					break;
				}
			}
		} else {
			// One non-forced fast-forward: atomic, all or nothing.
			try {
				await this.kit.rest.git.updateRef({
					...this.at,
					ref: `heads/${this.baseBranch}`,
					sha: a.testedSha,
					force: false,
				});
			} catch (e) {
				if (httpStatus(e) !== 422) throw e;
				if ((await this.branchSha(this.baseBranch)) !== a.baseSha) {
					return { ...none, baseMoved: true };
				}
				const first = a.members[0];
				if (!first) throw e;
				return {
					...none,
					baseMoved: false,
					failed: { number: first.number, message: httpMessage(e) },
				};
			}
			for (const m of a.members) {
				merged.push(m.number);
				await this.upsertCheck(m.headSha, "landed", `landed with batch ${a.batchId}`, {
					status: "completed",
					conclusion: "success",
				});
			}
		}

		let treeMatches: boolean | null = null;
		if (failed === null) {
			const landed = await this.branchSha(this.baseBranch);
			treeMatches =
				landed !== null &&
				(await this.commit(landed)).tree === (await this.commit(a.testedSha)).tree;
		}
		return { batchId: a.batchId, baseMoved: false, merged, failed, treeMatches };
	}

	// --- Simple effects -----------------------------------------------------

	async deleteBranch(branch: string): Promise<void> {
		try {
			await this.kit.rest.git.deleteRef({ ...this.at, ref: `heads/${branch}` });
		} catch (e) {
			// Already gone is the outcome we wanted.
			const s = httpStatus(e);
			if (s !== 404 && s !== 422) throw e;
		}
	}

	async cancelRuns(sha: string): Promise<void> {
		for (const status of ["in_progress", "queued"] as const) {
			const runs = await this.kit.paginate(this.kit.rest.actions.listWorkflowRunsForRepo, {
				...this.at,
				head_sha: sha,
				status,
				per_page: 100,
			});
			for (const run of runs) {
				try {
					await this.kit.rest.actions.cancelWorkflowRun({ ...this.at, run_id: run.id });
				} catch (e) {
					// 409: it finished in the meantime.
					if (httpStatus(e) !== 409) throw e;
				}
			}
		}
	}

	async report(a: ActionOf<"report">): Promise<void> {
		await this.upsertCheck(a.headSha, a.state, a.summary, reportCheck(a.state, a.shadow));
	}

	async comment(a: ActionOf<"comment">): Promise<void> {
		const body = renderEjection(a.payload);
		const comments = await this.kit.paginate(this.kit.rest.issues.listComments, {
			...this.at,
			issue_number: a.number,
			per_page: 100,
		});
		const mine = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(COMMENT_MARKER));
		if (mine) {
			await this.kit.rest.issues.updateComment({ ...this.at, comment_id: mine.id, body });
		} else {
			await this.kit.rest.issues.createComment({ ...this.at, issue_number: a.number, body });
		}
	}

	async openIssue(a: ActionOf<"openIssue">): Promise<void> {
		const open = await this.kit.paginate(this.kit.rest.issues.listForRepo, {
			...this.at,
			state: "open",
			per_page: 100,
		});
		if (open.some((i) => !i.pull_request && i.title === a.title)) return;
		await this.kit.rest.issues.create({ ...this.at, title: a.title, body: a.body });
	}

	/**
	 * Mark every open PR on this base with why the queue is not running, e.g.
	 * an invalid `.github/merge-queue.yml`. Not part of the port: the core never
	 * sees a config it could not parse.
	 */
	async reportDisabled(reason: string): Promise<void> {
		const open = await this.kit.paginate(this.kit.rest.pulls.list, {
			...this.at,
			state: "open",
			base: this.baseBranch,
			per_page: 100,
		});
		const title = `merge queue disabled: ${reason}`.slice(0, 250);
		for (const p of open) {
			await this.upsertCheck(p.head.sha, "disabled", title, {
				status: "completed",
				conclusion: "neutral",
			});
		}
	}

	// --- Internals ----------------------------------------------------------

	/** Create or update this app's `merge-queue` check run on a commit. */
	private async upsertCheck(
		headSha: string,
		state: string,
		title: string,
		check: { status: "in_progress" | "completed"; conclusion?: string },
	): Promise<void> {
		const runs = await this.kit.paginate(this.kit.rest.checks.listForRef, {
			...this.at,
			ref: headSha,
			check_name: CHECK_NAME,
			filter: "all",
			per_page: 100,
			...(this.appId === undefined ? {} : { app_id: this.appId }),
		});
		const mine = runs
			.filter(
				(r) => r.name === CHECK_NAME && (this.appId === undefined || r.app?.id === this.appId),
			)
			.sort((x, y) => y.id - x.id)[0];
		const output = { title, summary: `${title}\n\nState: \`${state}\`` };
		if (
			mine?.output?.title === title &&
			mine.external_id === state &&
			mine.status === check.status &&
			(mine.conclusion ?? undefined) === check.conclusion
		) {
			return;
		}
		const fields = {
			...this.at,
			status: check.status,
			...(check.conclusion ? { conclusion: check.conclusion as "success" } : {}),
			external_id: state,
			output,
		};
		// A completed run cannot be reopened; a new run supersedes it instead.
		if (mine && !(mine.status === "completed" && check.status !== "completed")) {
			await this.kit.rest.checks.update({ ...fields, check_run_id: mine.id });
		} else {
			await this.kit.rest.checks.create({ ...fields, name: CHECK_NAME, head_sha: headSha });
		}
	}

	private async branchSha(branch: string): Promise<string | null> {
		try {
			const { data } = await this.kit.rest.git.getRef({ ...this.at, ref: `heads/${branch}` });
			return data.object.sha;
		} catch (e) {
			if (httpStatus(e) === 404) return null;
			throw e;
		}
	}

	private async commit(sha: string): Promise<{ date: number; tree: string }> {
		const cached = this.commitInfo.get(sha);
		if (cached) return cached;
		const { data } = await this.kit.rest.git.getCommit({ ...this.at, commit_sha: sha });
		const info = { date: epochSeconds(data.committer.date), tree: data.tree.sha };
		this.commitInfo.set(sha, info);
		return info;
	}
}
