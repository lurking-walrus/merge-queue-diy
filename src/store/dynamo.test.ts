import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../core/types";
import { DynamoQueueTable, VersionConflict } from "./dynamo";
import { memoryDynamo } from "./testing";

let db: ReturnType<typeof memoryDynamo>;
afterEach(() => db.restore());

const key = { owner: "Example-Org", repo: "widgets", base: "main" };

function table() {
	db = memoryDynamo();
	return new DynamoQueueTable(db.client, "merge-queue");
}

describe("DynamoQueueStore", () => {
	it("starts empty and round-trips state through one item per queue", async () => {
		const t = table();
		const store = t.queue(key, 42);
		expect(await store.load()).toEqual(emptyState());

		const state = { ...emptyState(), nextBatchId: 3, held: [7] };
		await store.save(state);
		await store.save({ ...state, nextBatchId: 4 });

		expect(await t.queue(key, 42).load()).toEqual({ ...state, nextBatchId: 4 });
		expect(db.items.size).toBe(1);
		const item = [...db.items.values()][0];
		expect(item).toMatchObject({
			pk: "example-org/widgets",
			sk: "main",
			version: 2,
			installationId: 42,
		});
		// Queue state and its address only: no token, key or payload.
		expect(Object.keys(item ?? {}).sort()).toEqual(
			["installationId", "owner", "pk", "repo", "sk", "state", "updatedAt", "version"].sort(),
		);
	});

	it("refuses to overwrite a concurrent write, for a new item and an existing one", async () => {
		const t = table();
		const a = t.queue(key, 42);
		const b = t.queue(key, 42);
		await a.load();
		await b.load();
		await a.save(emptyState());
		await expect(b.save(emptyState())).rejects.toBeInstanceOf(VersionConflict);

		const c = t.queue(key, 42);
		await c.load();
		await a.save({ ...emptyState(), nextBatchId: 9 });
		await expect(c.save(emptyState())).rejects.toBeInstanceOf(VersionConflict);
		expect((await t.queue(key, 42).load()).nextBatchId).toBe(9);
	});

	it("discards a queue's item, refusing if someone wrote it since the load", async () => {
		const t = table();
		const store = t.queue(key, 42);
		await store.load();
		await store.discard(); // nothing stored yet: a no-op
		await store.save({ ...emptyState(), held: [1] });
		await store.discard();
		expect(db.items.size).toBe(0);
		expect(await t.queue(key, 42).load()).toEqual(emptyState());

		const a = t.queue(key, 42);
		await a.save((await a.load(), { ...emptyState(), held: [1] }));
		const b = t.queue(key, 42);
		await b.load();
		await a.save({ ...emptyState(), held: [2] });
		await expect(b.discard()).rejects.toBeInstanceOf(VersionConflict);
		expect(db.items.size).toBe(1);
	});

	it("will not save without loading first", async () => {
		await expect(table().queue(key, 42).save(emptyState())).rejects.toThrow(/before load/);
	});

	it("lists a repository's stored bases and every stored queue", async () => {
		const t = table();
		for (const base of ["main", "release"]) {
			const s = t.queue({ ...key, base }, 42);
			await s.load();
			await s.save(emptyState());
		}
		const other = t.queue({ owner: "example-org", repo: "gadgets", base: "main" }, 43);
		await other.load();
		await other.save(emptyState());

		expect((await t.bases("example-org", "WIDGETS")).sort()).toEqual(["main", "release"]);
		expect(await t.all()).toHaveLength(3);
		expect(await t.all()).toContainEqual({
			owner: "example-org",
			repo: "gadgets",
			base: "main",
			installationId: 43,
		});
	});
});
