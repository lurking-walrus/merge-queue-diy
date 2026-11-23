import { z } from "zod";

/**
 * Deployment configuration (docs/DESIGN.md §10). Read once per cold start.
 *
 * Each function reads only what it needs, because each is given only what it
 * needs: the webhook secret exists in the ingest function alone and the app
 * private key in the reconcile function alone (§12). Nothing here has a
 * default that names a real account, org or host. Never log the parsed object.
 */

const allowedOwners = z
	.string()
	.transform((s) =>
		s
			.split(",")
			.map((o) => o.trim().toLowerCase())
			.filter(Boolean),
	)
	.refine((owners) => owners.length > 0, "list at least one org or user login");

const queueUrl = z.url();

const ingestSchema = z.object({
	GITHUB_WEBHOOK_SECRET: z.string().min(16, "use at least 16 characters"),
	MERGE_QUEUE_ALLOWED_OWNERS: allowedOwners,
	MERGE_QUEUE_QUEUE_URL: queueUrl,
});

const reconcileSchema = z.object({
	GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be the numeric App ID"),
	GITHUB_APP_PRIVATE_KEY: z.string().min(1),
	MERGE_QUEUE_ALLOWED_OWNERS: allowedOwners,
	MERGE_QUEUE_TABLE: z.string().min(1),
	MERGE_QUEUE_QUEUE_URL: queueUrl,
	MERGE_QUEUE_QUEUE_ARN: z.string().startsWith("arn:"),
	MERGE_QUEUE_SCHEDULER_ROLE_ARN: z.string().startsWith("arn:"),
	MERGE_QUEUE_SCHEDULE_GROUP: z
		.string()
		.optional()
		.transform((g) => g || "default"),
});

export interface IngestEnv {
	webhookSecret: string;
	allowedOwners: string[];
	queueUrl: string;
}

export interface ReconcileEnv {
	appId: string;
	privateKey: string;
	allowedOwners: string[];
	table: string;
	queueUrl: string;
	queueArn: string;
	schedulerRoleArn: string;
	scheduleGroup: string;
}

type Source = Record<string, string | undefined>;

function parse<T extends z.ZodType>(schema: T, source: Source): z.infer<T> {
	const parsed = schema.safeParse(source);
	if (!parsed.success) {
		// Name the variables, never their values.
		const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
		throw new Error(`Invalid or missing environment: ${names}`);
	}
	return parsed.data;
}

export function loadIngestEnv(source: Source = process.env): IngestEnv {
	const e = parse(ingestSchema, source);
	return {
		webhookSecret: e.GITHUB_WEBHOOK_SECRET,
		allowedOwners: e.MERGE_QUEUE_ALLOWED_OWNERS,
		queueUrl: e.MERGE_QUEUE_QUEUE_URL,
	};
}

export function loadReconcileEnv(source: Source = process.env): ReconcileEnv {
	const e = parse(reconcileSchema, source);
	return {
		appId: e.GITHUB_APP_ID,
		privateKey: e.GITHUB_APP_PRIVATE_KEY,
		allowedOwners: e.MERGE_QUEUE_ALLOWED_OWNERS,
		table: e.MERGE_QUEUE_TABLE,
		queueUrl: e.MERGE_QUEUE_QUEUE_URL,
		queueArn: e.MERGE_QUEUE_QUEUE_ARN,
		schedulerRoleArn: e.MERGE_QUEUE_SCHEDULER_ROLE_ARN,
		scheduleGroup: e.MERGE_QUEUE_SCHEDULE_GROUP,
	};
}

const cliSchema = z.object({
	GITHUB_TOKEN: z.string().min(1, "set a read-only token (e.g. `gh auth token`)"),
});

/** The dry-run CLI (`pnpm queue:plan`): a token that can read the repository. Nothing else. */
export function loadCliEnv(source: Source = process.env): { token: string } {
	return { token: parse(cliSchema, source).GITHUB_TOKEN };
}
