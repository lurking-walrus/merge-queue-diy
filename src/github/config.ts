/**
 * Load `.github/merge-queue.yml` from a repository's default branch.
 *
 * Never throws for a bad file: a missing file means the queue is off, and an
 * invalid one means the queue is off *and* the reason is shown on each PR's
 * `merge-queue` check (see `RestGitHub.reportDisabled`).
 */

import { parse } from "yaml";
import { ZodError } from "zod";
import { parseRepoConfig, type RepoConfig } from "../core/config";
import { httpStatus, type Kit } from "./octokit";

export const CONFIG_PATH = ".github/merge-queue.yml";

export type ConfigResult =
	| { kind: "ok"; config: RepoConfig }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string };

/** Validate the text of a config file. Exposed for tests and the dry-run CLI. */
export function parseConfigText(text: string): ConfigResult {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (e) {
		const first = (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];
		return { kind: "invalid", reason: `${CONFIG_PATH} is not valid YAML: ${first}` };
	}
	try {
		return { kind: "ok", config: parseRepoConfig(doc ?? {}) };
	} catch (e) {
		if (!(e instanceof ZodError)) throw e;
		// Name the key and the rule it broke; never echo the value back.
		const issues = e.issues
			.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(file)"}: ${i.message}`)
			.join("; ");
		return { kind: "invalid", reason: `${CONFIG_PATH}: ${issues}` };
	}
}

export async function loadRepoConfig(kit: Kit, owner: string, repo: string): Promise<ConfigResult> {
	const { data: info } = await kit.rest.repos.get({ owner, repo });
	let content: string;
	try {
		const { data } = await kit.rest.repos.getContent({
			owner,
			repo,
			path: CONFIG_PATH,
			ref: info.default_branch,
		});
		if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
			return { kind: "invalid", reason: `${CONFIG_PATH} is not a file` };
		}
		content = Buffer.from(data.content, "base64").toString("utf8");
	} catch (e) {
		if (httpStatus(e) === 404) return { kind: "missing" };
		throw e;
	}
	return parseConfigText(content);
}
