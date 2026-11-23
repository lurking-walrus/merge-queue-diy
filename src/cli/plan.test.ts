import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../github/config";
import { FAKE_OWNER, FAKE_REPO, FakeGitHub } from "../github/fake";
import { QueueOctokit } from "../github/octokit";
import { interceptGitHub } from "../github/testing";
import { formatPlan, plan, readOnly } from "./plan";

const github = interceptGitHub();
beforeAll(() => github.server.listen({ onUnhandledFrame: "error" }));
afterAll(() => github.server.close());

function setup(configText: string | null) {
	const fake = new FakeGitHub();
	github.use(fake);
	if (configText !== null) fake.files.set(CONFIG_PATH, configText);
	const kit = readOnly(new QueueOctokit({ auth: "test-token" }));
	const at = { kit, owner: FAKE_OWNER, repo: FAKE_REPO, base: "main" };
	return { fake, kit, at };
}

describe("queue:plan", () => {
	it("prints what a shadow-mode queue would report, sending only GETs", async () => {
		const { fake, at } = setup("required_checks: [ci]\nsettle_seconds: 0\n");
		fake.openPull({ "a.txt": "a" });
		fake.openPull({ "b.txt": "b" }, { draft: true });
		fake.finishCi();
		fake.openPull({ "c.txt": "c" });

		const result = await plan({ ...at, now: fake.now });
		const text = formatPlan(result, at);

		expect(text).toContain("mode shadow");
		expect(text).toContain("report #1: merge-queue = queued — [shadow] would be queued (#1 of 1)");
		expect(text).toContain("report #3: merge-queue = waiting");
		expect(text).toContain("#2 ");
		expect(text).toContain("draft");
		expect(text).not.toContain("build batch");
		expect(fake.requests.every((r) => r.startsWith("GET "))).toBe(true);
		expect(fake.queueChecks(fake.headOf(1))).toEqual([]);
	});

	it("with --enforce shows the batch it would build, and still builds nothing", async () => {
		const { fake, at } = setup("required_checks: [ci]\nsettle_seconds: 0\nmax_wait_seconds: 0\n");
		fake.openPull({ "a.txt": "a" });
		fake.openPull({ "b.txt": "b" });
		fake.finishCi();

		const text = formatPlan(await plan({ ...at, enforce: true, now: fake.now }), at);

		expect(text).toContain("build batch 1");
		expect(text).toContain("from #1, #2 → branch mq/main/1 (squash)");
		expect(fake.branchNames()).toEqual(["main"]);
		expect(fake.requests.every((r) => r.startsWith("GET "))).toBe(true);
	});

	it("can preview a local config file before it is committed", async () => {
		const { fake, at } = setup(null);
		fake.openPull({ "a.txt": "a" });
		const result = await plan({
			...at,
			configText: "required_checks: [ci]\nbatch_size: 2\n",
			now: fake.now,
		});
		expect(formatPlan(result, at)).toContain("batch 2");
	});

	it("says plainly when the queue is off", async () => {
		const missing = setup(null);
		expect(formatPlan(await plan({ ...missing.at, now: 0 }), missing.at)).toContain(
			"the queue is off",
		);
		const invalid = setup("required_checks: [ci]\ntypo: 1\n");
		expect(formatPlan(await plan({ ...invalid.at, now: 0 }), invalid.at)).toContain("typo");
	});

	it("refuses any request that could change something", async () => {
		const { fake, kit } = setup(null);
		await expect(
			kit.rest.git.createRef({
				owner: FAKE_OWNER,
				repo: FAKE_REPO,
				ref: "refs/heads/x",
				sha: fake.mainSha(),
			}),
		).rejects.toThrow(/dry run: refusing to send POST/);
		await expect(
			kit.rest.git.deleteRef({ owner: FAKE_OWNER, repo: FAKE_REPO, ref: "heads/main" }),
		).rejects.toThrow(/refusing to send DELETE/);
		expect(fake.requests).toEqual([]);
		expect(fake.branchNames()).toEqual(["main"]);
	});
});
