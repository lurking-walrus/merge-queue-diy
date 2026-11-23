/**
 * A fake GitHub REST API, served over intercepted HTTP in tests.
 *
 * It models the same repository as `src/sim/github.ts` — commits with trees,
 * three-way merges that can conflict, pull requests, CI that starts when a PR
 * head or a batch branch appears — but behind the real endpoints, status
 * codes and pagination that `RestGitHub` calls. That lets the end-to-end
 * scenarios run against the production adapter, not only the simulator.
 *
 * Test support only; it is never deployed. Where real GitHub's behaviour is
 * richer than this, the fake follows the documented behaviour of the parts
 * the adapter depends on and nothing more.
 */

import { createHash } from "node:crypto";
import type { Action, EjectionPayload, ReportState, ReviewRequirements } from "../core/types";
import { NO_REVIEW_REQUIREMENTS } from "../core/types";
import {
	apply,
	type Changes,
	type CiFn,
	type CiRun,
	merge3,
	type Tree,
	treeId,
} from "../sim/github";

type ActionOf<T extends Action["type"]> = Extract<Action, { type: T }>;

export const FAKE_OWNER = "example-org";
export const FAKE_REPO = "widgets";
export const FAKE_APP_ID = 4242;
const ACTIONS_APP_ID = 15368;
const FULL_NAME = `${FAKE_OWNER}/${FAKE_REPO}`;
const REPORT_STATES = new Set<string>([
	"waiting",
	"queued",
	"testing",
	"landing",
	"ejected",
	"held",
]);
const MARKER = "<!-- merge-queue:ejection -->";

interface FakeCommit {
	tree: Tree;
	treeSha: string;
	parents: string[];
	message: string;
	/** Epoch seconds. */
	date: number;
}

interface FakePull {
	number: number;
	headSha: string;
	draft: boolean;
	fromFork: boolean;
	labels: string[];
	updatedAt: number;
	state: "open" | "merged" | "closed";
	/** One entry per review thread: true once resolved. */
	conversations: boolean[];
	approvers: Set<string>;
}

interface CheckRun {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion: string | null;
	external_id: string | null;
	output: { title: string | null; summary: string | null };
	app: { id: number };
	started_at: string;
	completed_at: string | null;
}

interface WorkflowRun {
	id: number;
	head_sha: string;
	status: "in_progress" | "completed";
	conclusion: string | null;
}

interface Json {
	[key: string]: unknown;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export class FakeGitHub {
	readonly baseBranch = "main";
	/** Epoch seconds; tests advance it. New commits are dated with it. */
	now = 1_000_000;
	/** Like a ruleset requiring `merge-queue`: refuse PR merges until it is green. */
	requireQueueCheck = true;
	/** Files on the default branch served by the contents API, path → text. */
	readonly files = new Map<string, string>();

	// What the scenarios assert on, in the simulator's shapes.
	readonly ciRuns: CiRun[] = [];
	readonly cancelled: string[] = [];
	readonly reports: ActionOf<"report">[] = [];
	readonly comments: ActionOf<"comment">[] = [];
	readonly issues: ActionOf<"openIssue">[] = [];
	/** Every request, as `METHOD /path` relative to the repository. */
	readonly requests: string[] = [];
	readonly tokenRequests: { authorization: string | null; body: Json }[] = [];

	private readonly commits = new Map<string, FakeCommit>();
	private readonly trees = new Map<string, Tree>();
	private readonly refs = new Map<string, string>();
	private readonly pulls = new Map<number, FakePull>();
	private readonly checkRuns: CheckRun[] = [];
	private readonly statuses: {
		id: number;
		sha: string;
		context: string;
		state: string;
		at: number;
	}[] = [];
	private readonly issueComments: { id: number; issue: number; body: string }[] = [];
	private readonly openIssues: { number: number; title: string; body: string; state: string }[] =
		[];
	private readonly workflowRuns: WorkflowRun[] = [];
	private readonly pendingCi = new Set<string>();
	private reviewRules: ReviewRequirements = { ...NO_REVIEW_REQUIREMENTS };
	private ids = 0;
	private counter = 0;

	constructor(private readonly opts: { ci?: CiFn; branchPrefix?: string; initial?: Tree } = {}) {
		this.refs.set("main", this.commit(opts.initial ?? { "README.md": "hello" }, [], "initial"));
	}

	// --- What a test does to the repository ---------------------------------

	openPull(
		changes: Changes,
		o: { draft?: boolean; fromFork?: boolean; labels?: string[] } = {},
	): number {
		const base = this.main();
		const number = this.pulls.size + 1;
		const headSha = this.commit(apply(this.tree(base), changes), [base], `pr ${number}`);
		this.pulls.set(number, {
			number,
			headSha,
			draft: o.draft ?? false,
			fromFork: o.fromFork ?? false,
			labels: o.labels ?? [],
			updatedAt: this.now,
			state: "open",
			conversations: [],
			approvers: new Set(),
		});
		this.startCi(headSha, "pr");
		return number;
	}

	pushToPull(number: number, changes: Changes): void {
		const p = this.pull(number);
		p.headSha = this.commit(apply(this.tree(p.headSha), changes), [p.headSha], `pr ${number}`);
		p.updatedAt = this.now;
		this.startCi(p.headSha, "pr");
	}

	/** Served as the base branch's ruleset `pull_request` rule. */
	requireReviews(r: Partial<ReviewRequirements>): void {
		this.reviewRules = { ...this.reviewRules, ...r };
	}

	openConversation(number: number): void {
		this.pull(number).conversations.push(false);
	}

	resolveConversations(number: number): void {
		const p = this.pull(number);
		p.conversations = p.conversations.map(() => true);
	}

	approve(number: number, reviewer: string): void {
		this.pull(number).approvers.add(reviewer);
	}

	pushToBase(changes: Changes): void {
		const base = this.main();
		this.setRef("main", this.commit(apply(this.tree(base), changes), [base], "direct push"));
	}

	closePull(number: number): void {
		this.pull(number).state = "closed";
	}

	/** A legacy commit status, as an external CI would post. */
	addStatus(
		sha: string,
		context: string,
		state: "pending" | "success" | "failure" | "error",
	): void {
		this.statuses.push({ id: ++this.ids, sha, context, state, at: this.now });
	}

	/** A check run from some other app, e.g. GitHub Actions. */
	addCheckRun(sha: string, name: string, conclusion: string | null): void {
		this.checkRuns.push({
			id: ++this.ids,
			name,
			head_sha: sha,
			status: conclusion === null ? "in_progress" : "completed",
			conclusion,
			external_id: null,
			output: { title: null, summary: null },
			app: { id: ACTIONS_APP_ID },
			started_at: iso(this.now),
			completed_at: conclusion === null ? null : iso(this.now),
		});
	}

	finishCi(): number {
		const ci: CiFn = this.opts.ci ?? (() => ({ ci: "success" }));
		const n = this.pendingCi.size;
		for (const sha of this.pendingCi) {
			const results = ci(this.tree(sha));
			for (const run of this.checkRuns) {
				const result = results[run.name];
				if (run.head_sha === sha && run.status !== "completed" && result) {
					run.status = "completed";
					run.conclusion = result;
					run.completed_at = iso(this.now);
				}
			}
			for (const w of this.workflowRuns) {
				if (w.head_sha === sha && w.status !== "completed") {
					w.status = "completed";
					w.conclusion = "success";
				}
			}
		}
		this.pendingCi.clear();
		return n;
	}

	// --- What a test asserts on ---------------------------------------------

	mainTree(): Tree {
		return this.tree(this.main());
	}

	mainSha(): string {
		return this.main();
	}

	headOf(number: number): string {
		return this.pull(number).headSha;
	}

	pullState(number: number): FakePull["state"] {
		return this.pull(number).state;
	}

	branchNames(): string[] {
		return [...this.refs.keys()];
	}

	branchSha(branch: string): string | undefined {
		return this.refs.get(branch);
	}

	batchRuns(): number {
		return this.ciRuns.filter((r) => r.kind === "batch").length;
	}

	lastReport(number: number): ActionOf<"report"> | undefined {
		return this.reports.findLast((r) => r.number === number);
	}

	commentBodies(number: number): string[] {
		return this.issueComments.filter((c) => c.issue === number).map((c) => c.body);
	}

	queueChecks(sha: string): CheckRun[] {
		return this.checkRuns.filter((r) => r.head_sha === sha && r.app.id === FAKE_APP_ID);
	}

	openIssueTitles(): string[] {
		return this.openIssues.filter((i) => i.state === "open").map((i) => i.title);
	}

	// --- HTTP ---------------------------------------------------------------

	async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = decodeURIComponent(url.pathname);
		const body = (
			req.method === "GET" || req.method === "DELETE" ? {} : await req.json().catch(() => ({}))
		) as Json;
		try {
			const token = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
			if (token && req.method === "POST") {
				this.tokenRequests.push({ authorization: req.headers.get("authorization"), body });
				return json(201, {
					token: "ghs_fake_installation_token",
					expires_at: iso(this.now + 3600),
				});
			}
			if (path === "/graphql" && req.method === "POST") {
				this.requests.push("POST /graphql");
				return this.graphql(body);
			}
			const prefix = `/repos/${FULL_NAME}`;
			if (!path.startsWith(prefix)) throw new HttpError(404, "Not Found");
			const rest = path.slice(prefix.length) || "/";
			this.requests.push(`${req.method} ${rest}`);
			return this.route(req.method, rest, url, body);
		} catch (e) {
			if (e instanceof HttpError) return json(e.status, { message: e.message });
			throw e;
		}
	}

	private route(method: string, path: string, url: URL, body: Json): Response {
		const q = url.searchParams;
		let m: RegExpMatchArray | null = null;
		const match = (re: RegExp): boolean => {
			m = path.match(re);
			return m !== null;
		};

		if (method === "GET" && path === "/") {
			return json(200, { full_name: FULL_NAME, default_branch: "main" });
		}
		if (method === "GET" && match(/^\/contents\/(.+)$/)) {
			const text = this.files.get(m?.[1] ?? "");
			if (text === undefined) throw new HttpError(404, "Not Found");
			return json(200, {
				type: "file",
				encoding: "base64",
				path: m?.[1],
				content: Buffer.from(text).toString("base64"),
			});
		}

		// Refs
		if (match(/^\/git\/ref\/heads\/(.+)$/) && method === "GET") {
			const sha = this.refs.get(m?.[1] ?? "");
			if (!sha) throw new HttpError(404, "Not Found");
			return json(200, { ref: `refs/heads/${m?.[1]}`, object: { sha, type: "commit" } });
		}
		if (method === "POST" && path === "/git/refs") {
			const ref = String(body.ref ?? "");
			const sha = String(body.sha ?? "");
			if (!ref.startsWith("refs/heads/")) throw new HttpError(422, "Reference name is invalid");
			const name = ref.slice("refs/heads/".length);
			if (this.refs.has(name)) throw new HttpError(422, "Reference already exists");
			if (!this.commits.has(sha)) throw new HttpError(422, "Object does not exist");
			this.setRef(name, sha);
			return json(201, { ref, object: { sha, type: "commit" } });
		}
		if (match(/^\/git\/refs\/heads\/(.+)$/)) {
			const name = m?.[1] ?? "";
			const current = this.refs.get(name);
			if (method === "DELETE") {
				if (!current) throw new HttpError(422, "Reference does not exist");
				this.refs.delete(name);
				return new Response(null, { status: 204 });
			}
			if (method === "PATCH") {
				const sha = String(body.sha ?? "");
				if (!current) throw new HttpError(422, "Reference does not exist");
				if (!this.commits.has(sha)) throw new HttpError(422, "Object does not exist");
				if (body.force !== true && !this.isAncestor(current, sha)) {
					throw new HttpError(422, "Update is not a fast forward");
				}
				this.setRef(name, sha);
				return json(200, { ref: `refs/heads/${name}`, object: { sha, type: "commit" } });
			}
		}

		// Commits
		if (method === "GET" && match(/^\/git\/commits\/([0-9a-f]+)$/)) {
			return json(200, this.commitJson(m?.[1] ?? ""));
		}
		if (method === "POST" && path === "/git/commits") {
			const treeSha = String(body.tree ?? "");
			const tree = this.trees.get(treeSha);
			const parents = (body.parents as string[] | undefined) ?? [];
			if (!tree || parents.some((p) => !this.commits.has(p))) {
				throw new HttpError(422, "Tree or parent does not exist");
			}
			const sha = this.commit(tree, parents, String(body.message ?? ""));
			return json(201, this.commitJson(sha));
		}
		if (method === "POST" && path === "/merges") {
			return this.mergeIntoBranch(
				String(body.base),
				String(body.head),
				String(body.commit_message),
			);
		}
		if (method === "GET" && match(/^\/compare\/(.+)\.\.\.(.+)$/)) {
			return json(200, this.compare(this.resolve(m?.[1] ?? ""), this.resolve(m?.[2] ?? "")));
		}

		// Pull requests
		if (method === "GET" && match(/^\/rules\/branches\/(.+)$/)) {
			const r = this.reviewRules;
			const rules =
				m?.[1] === "main" && (r.resolvedConversations || r.approvals > 0)
					? [
							{
								type: "pull_request",
								parameters: {
									required_approving_review_count: r.approvals,
									required_review_thread_resolution: r.resolvedConversations,
									dismiss_stale_reviews_on_push: false,
									require_code_owner_review: false,
									require_last_push_approval: false,
								},
							},
						]
					: [];
			return page(url, [{ type: "deletion" }, ...rules]);
		}
		if (method === "GET" && path === "/pulls") {
			const open = [...this.pulls.values()]
				.filter((p) => p.state === "open" && (!q.get("base") || q.get("base") === "main"))
				.sort((a, b) => b.number - a.number)
				.map((p) => this.pullJson(p));
			return page(url, open);
		}
		if (match(/^\/pulls\/(\d+)$/) && method === "GET") {
			return json(200, this.pullJson(this.pull(Number(m?.[1]))));
		}
		if (match(/^\/pulls\/(\d+)\/files$/) && method === "GET") {
			return page(
				url,
				this.changedPaths(this.pull(Number(m?.[1]))).map((filename) => ({ filename })),
			);
		}
		if (match(/^\/pulls\/(\d+)\/merge$/) && method === "PUT") {
			return this.mergePull(this.pull(Number(m?.[1])), body);
		}

		// Checks and statuses
		if (method === "GET" && match(/^\/commits\/([^/]+)\/check-runs$/)) {
			const sha = this.resolve(m?.[1] ?? "");
			const runs = this.checkRuns.filter(
				(r) =>
					r.head_sha === sha &&
					(!q.get("check_name") || r.name === q.get("check_name")) &&
					(!q.get("app_id") || r.app.id === Number(q.get("app_id"))),
			);
			return page(url, runs, "check_runs");
		}
		if (method === "GET" && match(/^\/commits\/([^/]+)\/statuses$/)) {
			const sha = this.resolve(m?.[1] ?? "");
			const list = this.statuses
				.filter((s) => s.sha === sha)
				.sort((a, b) => b.id - a.id)
				.map((s) => ({
					id: s.id,
					context: s.context,
					state: s.state,
					created_at: iso(s.at),
					updated_at: iso(s.at),
				}));
			return page(url, list);
		}
		if (method === "POST" && path === "/check-runs") {
			const run: CheckRun = {
				id: ++this.ids,
				name: String(body.name),
				head_sha: String(body.head_sha),
				status: "queued",
				conclusion: null,
				external_id: null,
				output: { title: null, summary: null },
				app: { id: FAKE_APP_ID },
				started_at: iso(this.now),
				completed_at: null,
			};
			this.applyCheckFields(run, body);
			this.checkRuns.push(run);
			return json(201, run);
		}
		if (method === "PATCH" && match(/^\/check-runs\/(\d+)$/)) {
			const run = this.checkRuns.find((r) => r.id === Number(m?.[1]));
			if (!run) throw new HttpError(404, "Not Found");
			if (run.app.id !== FAKE_APP_ID)
				throw new HttpError(403, "Resource not accessible by integration");
			this.applyCheckFields(run, body);
			return json(200, run);
		}

		// Issues and comments
		if (match(/^\/issues\/(\d+)\/comments$/)) {
			const issue = Number(m?.[1]);
			if (method === "GET") {
				return page(
					url,
					this.issueComments
						.filter((c) => c.issue === issue)
						.map((c) => ({
							id: c.id,
							body: c.body,
							user: { login: "merge-queue[bot]", type: "Bot" },
						})),
				);
			}
			if (method === "POST") {
				const c = { id: ++this.ids, issue, body: String(body.body) };
				this.issueComments.push(c);
				this.recordComment(issue, c.body);
				return json(201, { id: c.id, body: c.body });
			}
		}
		if (method === "PATCH" && match(/^\/issues\/comments\/(\d+)$/)) {
			const c = this.issueComments.find((x) => x.id === Number(m?.[1]));
			if (!c) throw new HttpError(404, "Not Found");
			c.body = String(body.body);
			this.recordComment(c.issue, c.body);
			return json(200, { id: c.id, body: c.body });
		}
		if (path === "/issues" && method === "GET") {
			const asIssues = [
				...[...this.pulls.values()]
					.filter((p) => p.state === "open")
					.map((p) => ({ number: p.number, title: `PR ${p.number}`, pull_request: {} })),
				...this.openIssues.filter((i) => i.state === "open"),
			];
			return page(url, asIssues);
		}
		if (path === "/issues" && method === "POST") {
			const issue = {
				number: 1000 + this.openIssues.length,
				title: String(body.title),
				body: String(body.body),
				state: "open",
			};
			this.openIssues.push(issue);
			this.issues.push({ type: "openIssue", title: issue.title, body: issue.body });
			return json(201, issue);
		}

		// Actions
		if (method === "GET" && path === "/actions/runs") {
			const runs = this.workflowRuns.filter(
				(w) =>
					(!q.get("head_sha") || w.head_sha === q.get("head_sha")) &&
					(!q.get("status") || w.status === q.get("status")),
			);
			return page(url, runs, "workflow_runs");
		}
		if (method === "POST" && match(/^\/actions\/runs\/(\d+)\/cancel$/)) {
			const run = this.workflowRuns.find((w) => w.id === Number(m?.[1]));
			if (!run) throw new HttpError(404, "Not Found");
			if (run.status === "completed")
				throw new HttpError(409, "Cannot cancel a workflow run that is completed.");
			run.status = "completed";
			run.conclusion = "cancelled";
			for (const r of this.checkRuns) {
				if (r.head_sha === run.head_sha && r.status !== "completed") {
					r.status = "completed";
					r.conclusion = "cancelled";
				}
			}
			if (this.pendingCi.delete(run.head_sha)) this.cancelled.push(run.head_sha);
			return json(202, {});
		}

		throw new HttpError(404, `fake GitHub has no route for ${method} ${path}`);
	}

	// --- Behaviour ----------------------------------------------------------

	private mergeIntoBranch(base: string, head: string, message: string): Response {
		const baseSha = this.refs.get(base);
		if (!baseSha) throw new HttpError(404, "Base does not exist");
		const headSha = this.resolve(head);
		if (this.isAncestor(headSha, baseSha)) return new Response(null, { status: 204 });
		const ancestor = this.mergeBase(baseSha, headSha);
		const tree = merge3(this.tree(ancestor), this.tree(baseSha), this.tree(headSha));
		if (tree === null) throw new HttpError(409, "Merge conflict");
		const sha = this.commit(tree, [baseSha, headSha], message);
		this.setRef(base, sha);
		return json(201, this.commitJson(sha));
	}

	private mergePull(p: FakePull, body: Json): Response {
		if (p.state !== "open") throw new HttpError(405, "Pull Request is not mergeable");
		if (body.sha !== undefined && body.sha !== p.headSha) {
			throw new HttpError(409, "Head branch was modified. Review and try the merge again.");
		}
		if (this.requireQueueCheck) {
			const latest = this.queueChecks(p.headSha).sort((a, b) => b.id - a.id)[0];
			if (latest?.status !== "completed" || latest.conclusion !== "success") {
				throw new HttpError(405, 'Required status check "merge-queue" is expected.');
			}
		}
		const main = this.main();
		const tree = merge3(
			this.tree(this.mergeBase(main, p.headSha)),
			this.tree(main),
			this.tree(p.headSha),
		);
		if (tree === null) throw new HttpError(405, "Pull Request is not mergeable");
		const parents = body.merge_method === "merge" ? [main, p.headSha] : [main];
		const sha = this.commit(tree, parents, `PR ${p.number} (#${p.number})`);
		p.state = "merged";
		this.setRef("main", sha);
		return json(200, { sha, merged: true, message: "Pull Request successfully merged" });
	}

	private setRef(name: string, sha: string): void {
		this.refs.set(name, sha);
		// Every push to a batch branch would trigger the `mq/**` CI workflow.
		if (name.startsWith(`${this.opts.branchPrefix ?? "mq"}/`)) this.startCi(sha, "batch");
		if (name === "main") {
			// GitHub marks a PR merged once its head is reachable from the base.
			for (const p of this.pulls.values()) {
				if (p.state === "open" && this.isAncestor(p.headSha, sha)) p.state = "merged";
			}
		}
	}

	private applyCheckFields(run: CheckRun, body: Json): void {
		if (typeof body.status === "string") run.status = body.status;
		if (typeof body.conclusion === "string") {
			run.conclusion = body.conclusion;
			run.status = "completed";
		}
		if (run.status === "completed") run.completed_at ??= iso(this.now);
		else {
			run.conclusion = null;
			run.completed_at = null;
		}
		if (typeof body.external_id === "string") run.external_id = body.external_id;
		const output = body.output as { title?: string; summary?: string } | undefined;
		if (output) run.output = { title: output.title ?? null, summary: output.summary ?? null };

		if (run.name === "merge-queue" && run.external_id && REPORT_STATES.has(run.external_id)) {
			const pull = [...this.pulls.values()].find((p) => p.headSha === run.head_sha);
			if (pull) {
				this.reports.push({
					type: "report",
					number: pull.number,
					headSha: run.head_sha,
					state: run.external_id as ReportState,
					summary: run.output.title ?? "",
					// Only what GitHub would show: a finished, neutral [shadow] check.
					shadow:
						run.status === "completed" &&
						run.conclusion === "neutral" &&
						(run.output.title ?? "").startsWith("[shadow]"),
				});
			}
		}
	}

	private recordComment(issue: number, body: string): void {
		if (!body.includes(MARKER)) return;
		const block = body.match(/```json\n([\s\S]*?)\n```/);
		if (!block?.[1]) return;
		this.comments.push({
			type: "comment",
			number: issue,
			payload: JSON.parse(block[1]) as EjectionPayload,
		});
	}

	private compare(base: string, head: string): Json {
		const fromBase = this.ancestors(base);
		const fromHead = this.ancestors(head);
		const ahead = [...fromHead].filter((s) => !fromBase.has(s));
		const behind = [...fromBase].filter((s) => !fromHead.has(s));
		const status =
			ahead.length === 0 && behind.length === 0
				? "identical"
				: behind.length === 0
					? "ahead"
					: ahead.length === 0
						? "behind"
						: "diverged";
		return {
			status,
			ahead_by: ahead.length,
			behind_by: behind.length,
			merge_base_commit: { sha: this.mergeBase(base, head) },
			commits: ahead
				.sort((a, b) => this.generation(a) - this.generation(b))
				.map((sha) => this.commitJson(sha)),
		};
	}

	private pullJson(p: FakePull): Json {
		return {
			number: p.number,
			state: p.state === "open" ? "open" : "closed",
			merged: p.state === "merged",
			draft: p.draft,
			title: `PR ${p.number}`,
			updated_at: iso(p.updatedAt),
			labels: p.labels.map((name) => ({ name })),
			head: {
				sha: p.headSha,
				ref: `pr-${p.number}`,
				repo: p.fromFork ? { full_name: `someone-else/${FAKE_REPO}` } : { full_name: FULL_NAME },
			},
			base: { ref: "main", sha: this.main(), repo: { full_name: FULL_NAME } },
		};
	}

	private commitJson(sha: string): Json {
		const c = this.commits.get(sha);
		if (!c) throw new HttpError(404, "No commit found for SHA");
		const person = { name: "fake", email: "fake@example.com", date: iso(c.date) };
		return {
			sha,
			message: c.message,
			tree: { sha: c.treeSha },
			parents: c.parents.map((p) => ({ sha: p })),
			committer: person,
			author: person,
			commit: { message: c.message, tree: { sha: c.treeSha }, committer: person },
		};
	}

	private changedPaths(p: FakePull): string[] {
		const before = this.tree(this.mergeBase(this.main(), p.headSha));
		const after = this.tree(p.headSha);
		return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
			(path) => before[path] !== after[path],
		);
	}

	private startCi(sha: string, kind: CiRun["kind"]): void {
		const ci: CiFn = this.opts.ci ?? (() => ({ ci: "success" }));
		this.pendingCi.add(sha);
		this.ciRuns.push({ sha, kind });
		this.workflowRuns.push({
			id: ++this.ids,
			head_sha: sha,
			status: "in_progress",
			conclusion: null,
		});
		for (const name of Object.keys(ci(this.tree(sha)))) this.addCheckRun(sha, name, null);
	}

	// --- Git graph ----------------------------------------------------------

	private commit(tree: Tree, parents: string[], message: string): string {
		const treeSha = treeId(tree);
		this.trees.set(treeSha, tree);
		const sha = createHash("sha1")
			.update(`${treeSha}|${parents.join(",")}|${message}|${this.counter++}`)
			.digest("hex");
		this.commits.set(sha, { tree, treeSha, parents, message, date: this.now });
		return sha;
	}

	private resolve(ref: string): string {
		const branch = this.refs.get(ref.replace(/^refs\/heads\//, ""));
		if (branch) return branch;
		if (this.commits.has(ref)) return ref;
		throw new HttpError(404, "No commit found");
	}

	private ancestors(sha: string): Set<string> {
		const seen = new Set<string>();
		const stack = [sha];
		while (stack.length > 0) {
			const s = stack.pop() as string;
			if (seen.has(s)) continue;
			seen.add(s);
			stack.push(...(this.commits.get(s)?.parents ?? []));
		}
		return seen;
	}

	private isAncestor(ancestor: string, of: string): boolean {
		return this.ancestors(of).has(ancestor);
	}

	private readonly generations = new Map<string, number>();

	private generation(sha: string): number {
		const known = this.generations.get(sha);
		if (known !== undefined) return known;
		const parents = this.commits.get(sha)?.parents ?? [];
		const g = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => this.generation(p)));
		this.generations.set(sha, g);
		return g;
	}

	private mergeBase(a: string, b: string): string {
		const fromB = this.ancestors(b);
		const common = [...this.ancestors(a)].filter((s) => fromB.has(s));
		const best = common.sort((x, y) => this.generation(y) - this.generation(x))[0];
		if (!best) throw new HttpError(422, "No common ancestor");
		return best;
	}

	private tree(sha: string): Tree {
		const c = this.commits.get(sha);
		if (!c) throw new Error(`fake: unknown commit ${sha}`);
		return c.tree;
	}

	private main(): string {
		const sha = this.refs.get("main");
		if (!sha) throw new Error("fake: no main branch");
		return sha;
	}

	/** Only the adapter's review query; anything else is a test bug. */
	private graphql(body: Json): Response {
		const query = String(body.query ?? "");
		const v = (body.variables ?? {}) as Record<string, unknown>;
		if (!query.includes("query MergeQueueReviews")) {
			throw new HttpError(400, "fake GitHub only answers the MergeQueueReviews query");
		}
		if (v.owner !== FAKE_OWNER || v.repo !== FAKE_REPO) {
			return json(200, { data: { repository: null } });
		}
		const open = [...this.pulls.values()]
			.filter((p) => p.state === "open" && v.base === "main")
			.sort((a, b) => a.number - b.number);
		// Pages of one, so the adapter's pagination is exercised.
		const start = typeof v.after === "string" ? Number(v.after) : 0;
		const slice = open.slice(start, start + 1);
		const next = start + 1 < open.length;
		return json(200, {
			data: {
				repository: {
					pullRequests: {
						pageInfo: { hasNextPage: next, endCursor: next ? String(start + 1) : null },
						nodes: slice.map((p) => ({
							number: p.number,
							reviewThreads: { nodes: p.conversations.map((isResolved) => ({ isResolved })) },
							latestOpinionatedReviews: {
								nodes: [...p.approvers].map(() => ({ state: "APPROVED" })),
							},
						})),
					},
				},
			},
		});
	}

	private pull(number: number): FakePull {
		const p = this.pulls.get(number);
		if (!p) throw new HttpError(404, "Not Found");
		return p;
	}
}

function iso(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/** GitHub-style pagination: `per_page` (max 100), `page`, and a `Link` header. */
function page(url: URL, items: unknown[], wrap?: string): Response {
	const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
	const n = Number(url.searchParams.get("page") ?? 1);
	const slice = items.slice((n - 1) * perPage, n * perPage);
	const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
	if (n * perPage < items.length) {
		const next = new URL(url);
		next.searchParams.set("page", String(n + 1));
		headers.link = `<${next.toString()}>; rel="next"`;
	}
	const data = wrap ? { total_count: items.length, [wrap]: slice } : slice;
	return new Response(JSON.stringify(data), { status: 200, headers });
}
