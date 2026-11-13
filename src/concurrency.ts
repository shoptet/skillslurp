/**
 * Runs `fn` over every item in `items`, at most `limit` calls in flight at once, and resolves
 * with the results in INPUT order regardless of the order the calls actually settle in — a
 * worker pool (`limit` workers, each pulling the next unclaimed index off one shared counter)
 * rather than chunking `items` into batches of `limit`, so a slow call at the front of the list
 * does not stall workers that could otherwise already be moving on to later items.
 *
 * Every call is awaited to completion (success or failure) before this function settles at
 * all — a rejection is recorded, not thrown immediately, so one failing call can never cut the
 * others off mid-flight or leave a `fn(...)` promise unhandled. If one or more calls rejected,
 * the returned promise rejects with the rejection at the LOWEST index — the same error a plain
 * sequential `for` loop over `items` would have thrown first — not whichever rejection happened
 * to occur first in time, which is a property of the scheduler, not of `items` itself, and would
 * make the result depend on how fast unrelated calls happened to run.
 *
 * `limit` must be a positive integer; a bad `limit` rejects with a `RangeError` before `fn` is
 * ever called (checked before the empty-list short circuit below, so it is refused even for an
 * empty `items`). An empty `items` resolves to `[]` without calling `fn` at all.
 */
export async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(
			`mapBounded: limit must be a positive integer, got ${limit}`,
		);
	}
	if (items.length === 0) {
		return [];
	}

	const results: R[] = new Array(items.length);
	const errors = new Map<number, unknown>();
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) {
				return;
			}
			// Cast justified by the guard just above: `index < items.length` already proves
			// this slot exists, which noUncheckedIndexedAccess cannot see from the type alone.
			const item = items[index] as T;
			try {
				results[index] = await fn(item, index);
			} catch (err) {
				errors.set(index, err);
			}
		}
	}

	const workerCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

	let lowestFailedIndex: number | undefined;
	for (const index of errors.keys()) {
		if (lowestFailedIndex === undefined || index < lowestFailedIndex) {
			lowestFailedIndex = index;
		}
	}
	if (lowestFailedIndex !== undefined) {
		throw errors.get(lowestFailedIndex);
	}

	return results;
}
