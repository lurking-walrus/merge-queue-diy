/**
 * Queue state in DynamoDB: one item per repository + base branch.
 *
 *   pk = "<owner>/<repo>" (lower case)   sk = "<base>"
 *
 * Writes are conditional on a `version` attribute. A write that loses the
 * race throws {@link VersionConflict}; the caller reloads and re-runs the
 * whole reconcile rather than overwriting (every effect is safe to repeat).
 * The SQS FIFO group already serializes reconciles per queue, so a conflict
 * means something unusual happened — a redelivery while the first attempt was
 * still running — and the version check is what keeps that harmless.
 *
 * The item holds queue state only: PR numbers, SHAs, batch ids, timestamps.
 * Never a token, a key or a payload.
 */

import { ConditionalCheckFailedException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { emptyState, type QueueState } from "../core/types";
import type { QueueStore } from "../ports";

export class VersionConflict extends Error {
	constructor(key: QueueKey) {
		super(`queue ${key.owner}/${key.repo}#${key.base} was written concurrently`);
		this.name = "VersionConflict";
	}
}

export interface QueueKey {
	owner: string;
	repo: string;
	base: string;
}

/** A stored queue, as listed for fan-out and the sweep. */
export interface StoredQueue extends QueueKey {
	installationId: number;
}

export function partitionKey(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

export class DynamoQueueTable {
	private readonly doc: DynamoDBDocumentClient;

	constructor(
		client: DynamoDBClient,
		readonly tableName: string,
	) {
		this.doc = DynamoDBDocumentClient.from(client);
	}

	/** A store bound to one queue. Load before saving: the load sets the expected version. */
	queue(key: QueueKey, installationId: number): DynamoQueueStore {
		return new DynamoQueueStore(this.doc, this.tableName, key, installationId);
	}

	/** Base branches of a repository that have stored state. */
	async bases(owner: string, repo: string): Promise<string[]> {
		const out: string[] = [];
		let start: Record<string, unknown> | undefined;
		do {
			const res = await this.doc.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk",
					ExpressionAttributeValues: { ":pk": partitionKey(owner, repo) },
					ProjectionExpression: "sk",
					ExclusiveStartKey: start,
				}),
			);
			for (const item of res.Items ?? []) out.push(String(item.sk));
			start = res.LastEvaluatedKey;
		} while (start);
		return out;
	}

	/** Every stored queue. The table holds one small item per queue, so a scan is cheap. */
	async all(): Promise<StoredQueue[]> {
		const out: StoredQueue[] = [];
		let start: Record<string, unknown> | undefined;
		do {
			const res = await this.doc.send(
				new ScanCommand({
					TableName: this.tableName,
					ProjectionExpression: "#o, #r, sk, installationId",
					ExpressionAttributeNames: { "#o": "owner", "#r": "repo" },
					ExclusiveStartKey: start,
				}),
			);
			for (const item of res.Items ?? []) {
				out.push({
					owner: String(item.owner),
					repo: String(item.repo),
					base: String(item.sk),
					installationId: Number(item.installationId),
				});
			}
			start = res.LastEvaluatedKey;
		} while (start);
		return out;
	}
}

export class DynamoQueueStore implements QueueStore {
	/** Version of the item as last read or written; 0 means "does not exist yet". */
	private version: number | null = null;

	constructor(
		private readonly doc: DynamoDBDocumentClient,
		private readonly tableName: string,
		private readonly key: QueueKey,
		private readonly installationId: number,
	) {}

	private get itemKey() {
		return { pk: partitionKey(this.key.owner, this.key.repo), sk: this.key.base };
	}

	async load(): Promise<QueueState> {
		const res = await this.doc.send(
			new GetCommand({ TableName: this.tableName, Key: this.itemKey, ConsistentRead: true }),
		);
		if (!res.Item) {
			this.version = 0;
			return emptyState();
		}
		this.version = Number(res.Item.version);
		return { ...emptyState(), ...(JSON.parse(String(res.Item.state)) as QueueState) };
	}

	async save(state: QueueState): Promise<void> {
		if (this.version === null) throw new Error("DynamoQueueStore.save called before load");
		const next = this.version + 1;
		try {
			await this.doc.send(
				new PutCommand({
					TableName: this.tableName,
					Item: {
						...this.itemKey,
						owner: this.key.owner,
						repo: this.key.repo,
						installationId: this.installationId,
						version: next,
						state: JSON.stringify(state),
						updatedAt: new Date().toISOString(),
					},
					ConditionExpression:
						this.version === 0 ? "attribute_not_exists(pk)" : "version = :expected",
					...(this.version === 0
						? {}
						: { ExpressionAttributeValues: { ":expected": this.version } }),
				}),
			);
		} catch (e) {
			if (e instanceof ConditionalCheckFailedException) throw new VersionConflict(this.key);
			throw e;
		}
		this.version = next;
	}
}
