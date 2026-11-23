/**
 * Webhook intake, behind a Lambda Function URL.
 *
 * Verify the signature over the exact bytes received, route the event to a
 * poke, enqueue it, answer. No GitHub calls, no private key, nothing slow:
 * GitHub gives a webhook ten seconds, and this should take milliseconds.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { IngestEnv } from "../env";
import { routeEvent } from "../ingest/route";
import { verifySignature } from "../ingest/signature";
import type { Outbox } from "./messages";

export interface IngestDeps {
	env: IngestEnv;
	outbox: Outbox;
}

/** Always the structured form of a Function URL result. */
export interface IngestResult {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}

function reply(statusCode: number, message: string): IngestResult {
	return {
		statusCode,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message }),
	};
}

export function createIngestHandler(deps: IngestDeps) {
	return async (event: LambdaFunctionURLEvent): Promise<IngestResult> => {
		if (event.requestContext.http.method !== "POST") return reply(405, "POST only");
		const raw = event.body
			? event.isBase64Encoded
				? Buffer.from(event.body, "base64")
				: Buffer.from(event.body, "utf8")
			: Buffer.alloc(0);
		const headers = event.headers ?? {};
		if (!verifySignature(deps.env.webhookSecret, raw, headers["x-hub-signature-256"])) {
			return reply(401, "invalid or missing signature");
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw.toString("utf8"));
		} catch {
			return reply(400, "body is not JSON");
		}
		const delivery = headers["x-github-delivery"];
		const name = headers["x-github-event"];
		if (!delivery || !name) return reply(400, "missing X-GitHub-Event or X-GitHub-Delivery");

		const poke = routeEvent(name, payload, deps.env.allowedOwners);
		if (!poke) return reply(202, "ignored");
		await deps.outbox.send({ ...poke, id: `webhook:${delivery}` });
		return reply(202, "queued");
	};
}
