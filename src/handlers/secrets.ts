/**
 * Read an `sst.Secret` linked to this function, falling back to the plain
 * environment (local development, tests). SST delivers linked values
 * encrypted alongside the bundle; only the function they are linked to can
 * read them.
 */

import { Resource } from "sst/resource";

export type Source = Record<string, string | undefined>;

/** `process.env` plus each linked secret under its environment-variable name. */
export function withLinkedSecrets(
	names: Record<string, string>,
	env: Source = process.env,
	linked: unknown = Resource,
): Source {
	const out: Source = { ...env };
	for (const [envName, resourceName] of Object.entries(names)) {
		try {
			const value = (linked as Record<string, { value?: unknown } | undefined>)[resourceName]
				?.value;
			if (typeof value === "string" && value.length > 0) out[envName] = value;
		} catch {
			// Not linked here (local run): keep whatever the environment has.
		}
	}
	return out;
}
