import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHECK_NAME } from "../github/adapter";
import { OWN_CHECK_NAME, routeEvent } from "./route";
import { verifySignature } from "./signature";

const SECRET = "test-only-webhook-secret";
const sign = (body: string, secret = SECRET) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifySignature", () => {
	const body = JSON.stringify({ zen: "Keep it logically awesome." });

	it("accepts a correctly signed body", () => {
		expect(verifySignature(SECRET, body, sign(body))).toBe(true);
	});

	it("rejects a tampered body, a wrong secret, and a missing or malformed header", () => {
		expect(verifySignature(SECRET, `${body} `, sign(body))).toBe(false);
		expect(verifySignature(SECRET, body, sign(body, "another-secret"))).toBe(false);
		expect(verifySignature(SECRET, body, undefined)).toBe(false);
		expect(verifySignature(SECRET, body, "sha256=short")).toBe(false);
		expect(verifySignature("", body, sign(body, ""))).toBe(false);
	});
});

describe("routeEvent", () => {
	const base = {
		installation: { id: 42 },
		repository: { name: "widgets", owner: { login: "Example-Org" } },
	};
	const allowed = ["example-org"];
	const poke = { installationId: 42, owner: "Example-Org", repo: "widgets" };

	it("drops events from owners this deployment does not serve", () => {
		const payload = { ...base, pull_request: { base: { ref: "main" } } };
		expect(routeEvent("pull_request", payload, ["someone-else"])).toBeNull();
		expect(routeEvent("pull_request", payload, [])).toBeNull();
	});

	it("pokes the base branch's queue for pull request and push events", () => {
		expect(
			routeEvent("pull_request", { ...base, pull_request: { base: { ref: "main" } } }, allowed),
		).toEqual({ ...poke, base: "main" });
		expect(routeEvent("push", { ...base, ref: "refs/heads/main" }, allowed)).toEqual({
			...poke,
			base: "main",
		});
		expect(routeEvent("push", { ...base, ref: "refs/tags/v1" }, allowed)).toBeNull();
		expect(routeEvent("push", { ...base, ref: "refs/heads/x", deleted: true }, allowed)).toBeNull();
	});

	it("pokes every queue in the repo when a check finishes, and only then", () => {
		const run = (action: string, name = "ci") => ({ ...base, action, check_run: { name } });
		expect(routeEvent("check_run", run("completed"), allowed)).toEqual({ ...poke, base: null });
		expect(routeEvent("status", { ...base, state: "failure" }, allowed)).toEqual({
			...poke,
			base: null,
		});

		// Starting, queued or running changes nothing the queue decides on.
		for (const action of ["created", "requested_action", "rerequested"]) {
			expect(routeEvent("check_run", run(action), allowed)).toBeNull();
		}
		expect(routeEvent("status", { ...base, state: "pending" }, allowed)).toBeNull();
		// The queue's own check run is the queue talking to itself.
		expect(routeEvent("check_run", run("completed", OWN_CHECK_NAME), allowed)).toBeNull();
		// Repeats of what completed check runs already say.
		expect(routeEvent("check_suite", { ...base, action: "completed" }, allowed)).toBeNull();
		expect(routeEvent("workflow_run", { ...base, action: "completed" }, allowed)).toBeNull();
	});

	it("ignores its own check run under the name the adapter writes", () => {
		expect(OWN_CHECK_NAME).toBe(CHECK_NAME);
	});

	it("ignores events it has no use for, and malformed payloads", () => {
		expect(routeEvent("star", base, allowed)).toBeNull();
		expect(routeEvent("pull_request", { nonsense: true }, allowed)).toBeNull();
	});

	const comment = (body: string, author_association: string, onPull = true) => ({
		...base,
		action: "created",
		issue: { number: 9, ...(onPull ? { pull_request: { url: "x" } } : {}) },
		comment: { body, author_association },
	});

	it("turns a collaborator's command comment into a command", () => {
		expect(routeEvent("issue_comment", comment("/queue", "MEMBER"), allowed)?.command).toEqual({
			kind: "queue",
			number: 9,
		});
		expect(
			routeEvent("issue_comment", comment("  /dequeue\nthanks", "OWNER"), allowed)?.command,
		).toEqual({ kind: "dequeue", number: 9 });
		expect(
			routeEvent("issue_comment", comment("/queue unfreeze", "COLLABORATOR"), allowed)?.command,
		).toEqual({ kind: "unfreeze" });
	});

	it("ignores commands from outsiders, on plain issues, and inside prose", () => {
		expect(routeEvent("issue_comment", comment("/queue", "NONE"), allowed)).toBeNull();
		expect(routeEvent("issue_comment", comment("/queue", "CONTRIBUTOR"), allowed)).toBeNull();
		expect(routeEvent("issue_comment", comment("/queue", "MEMBER", false), allowed)).toBeNull();
		expect(
			routeEvent("issue_comment", comment("please /queue this", "MEMBER"), allowed),
		).toBeNull();
	});
});
