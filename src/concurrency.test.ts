import { expect, test } from "bun:test";
import { mapBounded } from "./concurrency.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("mapBounded: results come back in input order even when completion order is reversed", async () => {
	// item 0 finishes LAST (30ms), item 2 finishes FIRST (10ms) — a completion-order bug would
	// put item 2's result before item 0's.
	const delays = [30, 20, 10];
	const result = await mapBounded([0, 1, 2], 3, async (item) => {
		const ms = delays[item];
		if (ms === undefined) {
			throw new Error("unreachable");
		}
		await delay(ms);
		return `r${item}`;
	});
	expect(result).toEqual(["r0", "r1", "r2"]);
});

test("mapBounded: an empty list resolves to [] without calling fn", async () => {
	let calls = 0;
	const result = await mapBounded([], 4, async () => {
		calls++;
		return 1;
	});
	expect(result).toEqual([]);
	expect(calls).toBe(0);
});

test("mapBounded: each item is processed exactly once, whether the item count sits below, at, or above a multiple of the limit", async () => {
	const limit = 4;
	for (const count of [limit - 1, limit, limit * 3 + 1]) {
		const items = Array.from({ length: count }, (_, i) => i);
		const callCounts = new Map<number, number>();
		const result = await mapBounded(items, limit, async (item) => {
			callCounts.set(item, (callCounts.get(item) ?? 0) + 1);
			return item * 2;
		});
		expect(result).toEqual(items.map((i) => i * 2));
		expect(callCounts.size).toBe(count);
		expect([...callCounts.values()].every((c) => c === 1)).toBe(true);
	}
});

test("mapBounded: never runs more than limit calls at once, and does reach the limit (proving it actually runs concurrently)", async () => {
	const limit = 3;
	const items = Array.from({ length: 10 }, (_, i) => i);
	let inFlight = 0;
	let maxInFlight = 0;
	await mapBounded(items, limit, async () => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await delay(5);
		inFlight--;
		return null;
	});
	expect(maxInFlight).toBe(limit);
});

test("mapBounded: rejects with a RangeError for a non-positive or non-integer limit", async () => {
	await expect(mapBounded([1, 2], 0, async (x) => x)).rejects.toThrow(
		RangeError,
	);
	await expect(mapBounded([1, 2], -1, async (x) => x)).rejects.toThrow(
		RangeError,
	);
	await expect(mapBounded([1, 2], 1.5, async (x) => x)).rejects.toThrow(
		RangeError,
	);
});

test("mapBounded: an invalid limit rejects even for an empty list", async () => {
	await expect(mapBounded([], 0, async (x) => x)).rejects.toThrow(RangeError);
});

test("mapBounded: rejects with the error at the LOWEST failing index, even when a higher index fails first in time", async () => {
	const items = [0, 1, 2, 3, 4];
	const err1 = new Error("index 1 failed");
	const err3 = new Error("index 3 failed");
	await expect(
		mapBounded(items, items.length, async (item, index) => {
			if (index === 3) {
				// Rejects immediately — first in time.
				throw err3;
			}
			if (index === 1) {
				// Rejects only after a delay — later in time, but the lower index.
				await delay(20);
				throw err1;
			}
			await delay(50);
			return item;
		}),
	).rejects.toBe(err1);
});

test("mapBounded: one failing call does not stop the others from settling, and produces no unhandled rejection", async () => {
	const items = [0, 1, 2, 3, 4];
	let completed = 0;
	const promise = mapBounded(items, 2, async (item) => {
		if (item === 2) {
			throw new Error("boom");
		}
		await delay(5);
		completed++;
		return item;
	});
	await expect(promise).rejects.toThrow("boom");
	expect(completed).toBe(4);
});
