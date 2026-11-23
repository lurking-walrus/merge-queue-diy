import { z } from "zod";

/**
 * Per-repository configuration, read from `.github/merge-queue.yml` on the
 * default branch (docs/DESIGN.md §9). Keys are snake_case in the file and
 * camelCase in code.
 */
const fileSchema = z
	.object({
		enabled: z.boolean().default(true),
		// `shadow` computes and reports what it would do, and changes nothing.
		mode: z.enum(["enforce", "shadow"]).default("shadow"),
		enqueue: z.enum(["auto", "label", "comment"]).default("auto"),
		merge_method: z.enum(["squash", "merge"]).default("squash"),
		// Checks that must pass on the batch commit before it lands.
		required_checks: z.array(z.string().min(1)).min(1),
		// Checks that must pass on a PR's own head before it is queued. Defaults
		// to `required_checks`; set to [] when PR-level CI is deliberately thin.
		pr_checks: z.array(z.string().min(1)).optional(),
		batch_size: z.number().int().min(1).max(50).default(5),
		settle_seconds: z.number().int().min(0).default(120),
		max_wait_seconds: z.number().int().min(0).default(300),
		on_failure: z.enum(["bisect", "serial"]).default("bisect"),
		branch_prefix: z
			.string()
			.regex(/^[A-Za-z0-9._-]+$/)
			.default("mq"),
		queue_label: z.string().min(1).default("queue"),
		jump_label: z.string().min(1).default("queue:jump"),
		// `auto`: hold a PR back until it meets the review requirements the base
		// branch's rules set (resolved conversations, required approvals), since
		// GitHub would refuse to merge it. `none`: ignore them.
		review_requirements: z.enum(["auto", "none"]).default("auto"),
	})
	.strict();

export interface RepoConfig {
	enabled: boolean;
	mode: "enforce" | "shadow";
	enqueue: "auto" | "label" | "comment";
	mergeMethod: "squash" | "merge";
	requiredChecks: string[];
	prChecks: string[];
	batchSize: number;
	settleSeconds: number;
	maxWaitSeconds: number;
	onFailure: "bisect" | "serial";
	branchPrefix: string;
	queueLabel: string;
	jumpLabel: string;
	reviewRequirements: "auto" | "none";
}

/**
 * Validate an already-parsed config document. Throws a `ZodError` naming the
 * offending key; unknown keys are rejected so a typo cannot silently disable
 * a setting.
 */
export function parseRepoConfig(input: unknown): RepoConfig {
	const f = fileSchema.parse(input);
	return {
		enabled: f.enabled,
		mode: f.mode,
		enqueue: f.enqueue,
		mergeMethod: f.merge_method,
		requiredChecks: f.required_checks,
		prChecks: f.pr_checks ?? f.required_checks,
		batchSize: f.batch_size,
		settleSeconds: f.settle_seconds,
		maxWaitSeconds: f.max_wait_seconds,
		onFailure: f.on_failure,
		branchPrefix: f.branch_prefix,
		queueLabel: f.queue_label,
		jumpLabel: f.jump_label,
		reviewRequirements: f.review_requirements,
	};
}
