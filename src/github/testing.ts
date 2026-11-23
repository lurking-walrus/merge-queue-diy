/**
 * Test wiring: route Octokit's HTTP calls to a {@link FakeGitHub} through msw.
 * Test support only.
 */

import { http } from "msw";
import { type SetupServer, setupServer } from "msw/node";
import { RestGitHub } from "./adapter";
import { FAKE_APP_ID, FAKE_OWNER, FAKE_REPO, type FakeGitHub } from "./fake";
import { QueueOctokit } from "./octokit";

export const API = "https://api.github.com";

/** One msw server for a test file; `current` picks which fake answers. */
export function interceptGitHub(): { server: SetupServer; use(fake: FakeGitHub): void } {
	let current: FakeGitHub | null = null;
	const server = setupServer(
		http.all(`${API}/*`, ({ request }) => {
			if (!current) throw new Error("no FakeGitHub is active");
			return current.handle(request);
		}),
	);
	return {
		server,
		use(fake) {
			current = fake;
		},
	};
}

export function adapterFor(fake: FakeGitHub): RestGitHub {
	return new RestGitHub({
		octokit: new QueueOctokit({ auth: "test-token" }),
		owner: FAKE_OWNER,
		repo: FAKE_REPO,
		baseBranch: fake.baseBranch,
		appId: FAKE_APP_ID,
	});
}
