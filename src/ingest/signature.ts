import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub's `X-Hub-Signature-256` header against the raw request body.
 *
 * The body must be the exact bytes received — verifying a re-serialized JSON
 * object fails on any difference in whitespace or key order. A missing secret
 * or header is a rejection, never a pass.
 */
export function verifySignature(
	secret: string,
	rawBody: string | Uint8Array,
	header: string | undefined,
): boolean {
	if (!secret || !header) return false;
	const expected = Buffer.from(
		`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
	);
	const given = Buffer.from(header);
	// timingSafeEqual throws on a length mismatch; the length itself is not secret.
	return given.length === expected.length && timingSafeEqual(given, expected);
}
