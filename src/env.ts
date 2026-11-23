import { z } from "zod";

/**
 * Deployment configuration (docs/DESIGN.md §10). Read once per cold start.
 *
 * Nothing here has a default that names a real account, org or host: this
 * repository is public, and every deployment supplies its own values. The two
 * secrets arrive from `sst.Secret` in deployed stages and from an untracked
 * `.env` locally. Never log the parsed object.
 */
const schema = z.object({
	GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be the numeric App ID"),
	GITHUB_APP_PRIVATE_KEY: z.string().min(1),
	GITHUB_WEBHOOK_SECRET: z.string().min(16, "use at least 16 characters"),
	MERGE_QUEUE_ALLOWED_OWNERS: z
		.string()
		.transform((s) =>
			s
				.split(",")
				.map((o) => o.trim().toLowerCase())
				.filter(Boolean),
		)
		.refine((owners) => owners.length > 0, "list at least one org or user login"),
});

export interface Env {
	appId: string;
	privateKey: string;
	webhookSecret: string;
	allowedOwners: string[];
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
	const parsed = schema.safeParse(source);
	if (!parsed.success) {
		// Name the variables, never their values.
		const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
		throw new Error(`Invalid or missing environment: ${names}`);
	}
	return {
		appId: parsed.data.GITHUB_APP_ID,
		privateKey: parsed.data.GITHUB_APP_PRIVATE_KEY,
		webhookSecret: parsed.data.GITHUB_WEBHOOK_SECRET,
		allowedOwners: parsed.data.MERGE_QUEUE_ALLOWED_OWNERS,
	};
}
