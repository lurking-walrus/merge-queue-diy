/**
 * Octokit construction and authentication.
 *
 * Automatic retries are off. A reconcile that fails half-way is repaired by
 * the next one (docs/DESIGN.md §4), whereas a blind retry of a non-idempotent
 * call — a squash merge whose response was lost, say — would act twice. The
 * queue's own redelivery is the only retry.
 */

import { App, Octokit } from "octokit";

export const QueueOctokit = Octokit.defaults({
	retry: { enabled: false },
	throttle: { enabled: false },
});

export type Kit = InstanceType<typeof QueueOctokit>;

export interface AppCredentials {
	appId: string;
	/** PEM. Never logged, never passed anywhere but the JWT signer. */
	privateKey: string;
}

/**
 * Mint an installation token scoped to exactly one repository and return a
 * client that uses it. The token lives only in the returned client, for the
 * length of one reconcile; it is never stored or logged.
 */
export async function repositoryOctokit(
	creds: AppCredentials,
	installationId: number,
	repo: string,
): Promise<Kit> {
	const app = new App({ appId: creds.appId, privateKey: creds.privateKey, Octokit: QueueOctokit });
	const { data } = await app.octokit.request(
		"POST /app/installations/{installation_id}/access_tokens",
		{ installation_id: installationId, repositories: [repo] },
	);
	return new QueueOctokit({ auth: data.token });
}

/** HTTP status of an Octokit `RequestError`, or undefined for anything else. */
export function httpStatus(e: unknown): number | undefined {
	if (typeof e === "object" && e !== null && "status" in e && typeof e.status === "number") {
		return e.status;
	}
	return undefined;
}

/** GitHub's own error message, without request details (which can include headers). */
export function httpMessage(e: unknown): string {
	if (typeof e === "object" && e !== null && "response" in e) {
		const data = (e as { response?: { data?: { message?: unknown } } }).response?.data;
		if (typeof data?.message === "string") return data.message;
	}
	return httpStatus(e) !== undefined ? `HTTP ${httpStatus(e)}` : "request failed";
}
