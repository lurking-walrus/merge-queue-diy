/**
 * `pnpm queue:plan <owner>/<repo> <base> [--config file] [--enforce] [--json]`
 *
 * Reads with GITHUB_TOKEN, prints what the queue would do, changes nothing.
 * See src/cli/plan.ts.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadCliEnv } from "../env";
import { QueueOctokit } from "../github/octokit";
import { formatPlan, plan, readOnly } from "./plan";

const USAGE = "usage: pnpm queue:plan <owner>/<repo> <base> [--config file] [--enforce] [--json]";

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			config: { type: "string" },
			enforce: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	const [target, base] = positionals;
	const [owner, repo] = (target ?? "").split("/");
	if (values.help || !owner || !repo || !base || positionals.length !== 2) {
		console.error(USAGE);
		return values.help ? 0 : 2;
	}

	const { token } = loadCliEnv();
	const kit = readOnly(new QueueOctokit({ auth: token }));
	const opts = {
		kit,
		owner,
		repo,
		base,
		enforce: values.enforce,
		now: Math.floor(Date.now() / 1000),
		...(values.config ? { configText: readFileSync(values.config, "utf8") } : {}),
	};
	const result = await plan(opts);
	console.log(values.json ? JSON.stringify(result, null, 2) : formatPlan(result, opts));
	return 0;
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		// GitHub's message only: request details can carry headers.
		const status =
			typeof e === "object" && e !== null && "status" in e ? ` (HTTP ${e.status})` : "";
		console.error(
			`queue:plan failed${status}: ${e instanceof Error ? e.message.split("\n", 1)[0] : "unknown error"}`,
		);
		process.exit(1);
	},
);
