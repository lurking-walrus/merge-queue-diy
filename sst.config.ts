/// <reference path="./.sst/platform/config.d.ts" />

/**
 * The merge queue's AWS footprint (docs/DESIGN.md §4, ADR-0026, ADR-0027).
 *
 *   GitHub ──webhook──► Ingest (Function URL) ──► Pokes (SQS FIFO) ──► Reconcile
 *                                                   ▲     ▲               │
 *                         EventBridge rule, 10 min ─┘     └── Scheduler ◄─┘ wake-ups
 *                                                         Reconcile ◄──► Queues (DynamoDB)
 *
 * Nothing here is created until someone runs `sst deploy`. Every resource is
 * pay-per-use: no VPC, no NAT gateway, no provisioned concurrency, and every
 * log group expires after 14 days.
 *
 * Deployment-specific values come from the environment of whoever deploys —
 * the deploy workflow passes them from GitHub Actions variables — never from
 * this file, because this repository is public:
 *
 *   AWS_REGION                   region to deploy into
 *   GITHUB_APP_ID                numeric id of YOUR GitHub App
 *   MERGE_QUEUE_ALLOWED_OWNERS   comma-separated org/user logins to serve
 *   RESOURCE_OWNER               value of the Owner tag (optional)
 *   MERGE_QUEUE_ROLE_BOUNDARY_ARN  permissions boundary put on EVERY IAM role this
 *                                stack creates (optional). Set it when the
 *                                deploy role may only create bounded roles.
 *
 * Resources a scoped deploy policy has to name are named here rather than
 * left to generated names: `<app>-<stage>-wakeups` (schedule group),
 * `<app>-<stage>-wakeup-delivery` (Scheduler's role) and `<app>-<stage>-sweep`
 * (EventBridge rule). Everything else carries the `Application` tag below.
 *
 * Secrets are `sst.Secret`, set once per stage, and each is linked only to the
 * function that needs it (DESIGN.md §12):
 *
 *   npx sst secret set GithubAppPrivateKey < app.private-key.pem --stage production
 *   npx sst secret set GithubWebhookSecret "$(openssl rand -hex 32)" --stage production
 *
 * TYPE-CHECKING: this file is excluded from tsconfig.json, as in ADR-0023 —
 * the reference above pulls in SST's generated platform sources, which do not
 * compile under this repo's `noUncheckedIndexedAccess`. Check it with
 *
 *   AWS_REGION=<AWS_REGION> pnpm sst:check   # sst install, then tsc -p tsconfig.sst.json
 */

// Must match package.json's `name`; SST rejects top-level imports here.
const APP_NAME = "merge-queue-diy";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} must be set to deploy (see sst.config.ts)`);
	return value;
}

export default $config({
	app(input) {
		const production = input?.stage === "production";
		return {
			name: APP_NAME,
			// A stack delete on production must never take the queue state with it.
			removal: production ? "retain" : "remove",
			protect: production,
			home: "aws",
			providers: {
				aws: {
					region: required("AWS_REGION") as aws.Region,
					defaultTags: {
						tags: {
							Application: APP_NAME,
							Environment: input?.stage ?? "unknown",
							Owner: process.env.RESOURCE_OWNER || "unspecified",
							ManagedBy: "sst",
							Lifecycle: production ? "persistent" : "ephemeral",
						},
					},
				},
			},
		};
	},

	async run() {
		const appId = required("GITHUB_APP_ID");
		const allowedOwners = required("MERGE_QUEUE_ALLOWED_OWNERS");
		const prefix = `${$app.name}-${$app.stage}`;

		// Registered before any resource, so it reaches the roles SST creates for
		// each function as well as the one created below.
		const boundary = process.env.MERGE_QUEUE_ROLE_BOUNDARY_ARN;
		if (boundary) {
			$transform(aws.iam.Role, (args) => {
				args.permissionsBoundary = boundary;
			});
		}

		// Every function SST creates gets bounded logs, small memory and arm64.
		$transform(sst.aws.Function, (args) => {
			args.logging = { retention: "2 weeks" };
			args.architecture ??= "arm64";
			args.runtime ??= "nodejs24.x";
		});

		/* ------------------------------- Secrets ------------------------------- */
		const privateKey = new sst.Secret("GithubAppPrivateKey");
		const webhookSecret = new sst.Secret("GithubWebhookSecret");

		/* -------------------------------- State --------------------------------- */
		// On-demand billing, one small item per queue (src/store/dynamo.ts).
		const table = new sst.aws.Dynamo("Queues", {
			fields: { pk: "string", sk: "string" },
			primaryIndex: { hashKey: "pk", rangeKey: "sk" },
		});

		/* -------------------------------- Queue --------------------------------- */
		// A message that keeps failing would block its queue's group forever, so
		// after five attempts it moves aside, where it waits for a human.
		const deadLetters = new sst.aws.Queue("PokesDeadLetter", {
			fifo: true,
			transform: { queue: { messageRetentionSeconds: 14 * 24 * 60 * 60 } },
		});
		// FIFO: one message group per queue (owner/repo#base) gives one reconciler
		// at a time. Content-based dedup is on for Scheduler's wake-up deliveries,
		// which cannot set a deduplication id (ADR-0027).
		const pokes = new sst.aws.Queue("Pokes", {
			fifo: { contentBasedDeduplication: true },
			// Longer than the reconcile timeout, so a message is not redelivered
			// while its first attempt is still running.
			visibilityTimeout: "3 minutes",
			dlq: { queue: deadLetters.arn, retry: 5 },
		});

		/* ------------------------------- Wake-ups ------------------------------- */
		const wakeups = new aws.scheduler.ScheduleGroup("Wakeups", {
			name: `${prefix}-wakeups`,
		});
		// The role EventBridge Scheduler assumes to deliver a wake-up to the queue.
		const schedulerRole = new aws.iam.Role("WakeupDelivery", {
			name: `${prefix}-wakeup-delivery`,
			assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
				Service: "scheduler.amazonaws.com",
			}),
			inlinePolicies: [
				{
					name: "send-to-pokes",
					policy: $jsonStringify({
						Version: "2012-10-17",
						Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: pokes.arn }],
					}),
				},
			],
		});
		const scheduleArns = wakeups.arn.apply(
			(arn) => `${arn.replace(":schedule-group/", ":schedule/")}/*`,
		);

		/* ------------------------------- Functions ------------------------------ */
		const reconcile = new sst.aws.Function("Reconcile", {
			handler: "src/handlers/reconcile.entry.handler",
			timeout: "90 seconds",
			memory: "512 MB",
			// The app private key is linked here and nowhere else.
			link: [privateKey, table, pokes],
			environment: {
				GITHUB_APP_ID: appId,
				MERGE_QUEUE_ALLOWED_OWNERS: allowedOwners,
				MERGE_QUEUE_TABLE: table.name,
				MERGE_QUEUE_QUEUE_URL: pokes.url,
				MERGE_QUEUE_QUEUE_ARN: pokes.arn,
				MERGE_QUEUE_SCHEDULER_ROLE_ARN: schedulerRole.arn,
				MERGE_QUEUE_SCHEDULE_GROUP: wakeups.name,
			},
			permissions: [
				{
					actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule"],
					resources: [scheduleArns],
				},
				{ actions: ["iam:PassRole"], resources: [schedulerRole.arn] },
			],
		});
		pokes.subscribe(reconcile.arn, { batch: { size: 10, partialResponses: true } });

		const ingest = new sst.aws.Function("Ingest", {
			handler: "src/handlers/ingest.entry.handler",
			timeout: "10 seconds",
			memory: "256 MB",
			// Anyone may POST; only signature-verified bodies are acted on.
			url: true,
			// The webhook secret is linked here and nowhere else.
			link: [webhookSecret, pokes],
			environment: {
				MERGE_QUEUE_ALLOWED_OWNERS: allowedOwners,
				MERGE_QUEUE_QUEUE_URL: pokes.url,
			},
		});

		/* -------------------------------- Sweep --------------------------------- */
		// Repairs anything a missed webhook left behind (DESIGN.md §4).
		const sweep = new aws.cloudwatch.EventRule("Sweep", {
			name: `${prefix}-sweep`,
			scheduleExpression: "rate(10 minutes)",
		});
		new aws.cloudwatch.EventTarget("SweepTarget", { rule: sweep.name, arn: reconcile.arn });
		new aws.lambda.Permission("SweepInvoke", {
			action: "lambda:InvokeFunction",
			function: reconcile.name,
			principal: "events.amazonaws.com",
			sourceArn: sweep.arn,
		});

		return {
			webhookUrl: ingest.url,
			table: table.name,
			queue: pokes.url,
			deadLetters: deadLetters.url,
		};
	},
});
