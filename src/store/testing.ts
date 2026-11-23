/**
 * An in-memory DynamoDB for tests: intercepts the document client and
 * implements the four commands the store uses, including its two condition
 * expressions. Test support only.
 */

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

type Item = Record<string, unknown>;

export function memoryDynamo() {
	const items = new Map<string, Item>();
	const key = (pk: unknown, sk: unknown) => `${String(pk)}\u0000${String(sk)}`;
	const mock = mockClient(DynamoDBDocumentClient);
	/** Called before each Put; lets a test slip in a concurrent write. */
	let beforePut: (() => void) | null = null;

	mock.on(GetCommand).callsFake((input) => {
		const item = items.get(key(input.Key.pk, input.Key.sk));
		return { Item: item ? structuredClone(item) : undefined };
	});
	mock.on(PutCommand).callsFake((input) => {
		const hook = beforePut;
		beforePut = null;
		hook?.();
		const k = key(input.Item.pk, input.Item.sk);
		const current = items.get(k);
		const cond: string | undefined = input.ConditionExpression;
		const ok =
			cond === undefined ||
			(cond === "attribute_not_exists(pk)" && !current) ||
			(cond === "version = :expected" &&
				current?.version === input.ExpressionAttributeValues?.[":expected"]);
		if (!ok) {
			throw new ConditionalCheckFailedException({
				message: "The conditional request failed",
				$metadata: {},
			});
		}
		items.set(k, structuredClone(input.Item));
		return {};
	});
	mock.on(QueryCommand).callsFake((input) => ({
		Items: [...items.values()].filter((i) => i.pk === input.ExpressionAttributeValues[":pk"]),
	}));
	mock.on(ScanCommand).callsFake(() => ({ Items: [...items.values()] }));

	return {
		client: new DynamoDBClient({ region: "us-east-1" }),
		items,
		mock,
		/** Run `fn` just before the next Put, as if another writer got there first. */
		interleave(fn: () => void) {
			beforePut = fn;
		},
		restore: () => mock.restore(),
	};
}
