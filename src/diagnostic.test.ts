import { describe, expect, test } from "bun:test";
import { locFields } from "./diagnostic.js";

/**
 * The own-key behaviour is the whole contract: the json reporter's output shape depends on a
 * position-less diagnostic having no `line` key at all, not a `line` key holding `undefined`
 * (`reporters/json.test.ts` pins that end of it). `toEqual` treats the two as equal, so every
 * assertion here goes through `Object.keys` or `in` instead.
 */
describe("locFields", () => {
	test("no loc yields no keys at all", () => {
		const fields = locFields(undefined);

		expect(Object.keys(fields)).toEqual([]);
	});

	test("a point loc yields line and col only", () => {
		const fields = locFields({ line: 3, col: 7 });

		expect(Object.keys(fields).sort()).toEqual(["col", "line"]);
		expect(fields.line).toBe(3);
		expect(fields.col).toBe(7);
	});

	test("a range loc yields all four", () => {
		const fields = locFields({ line: 3, col: 7, endLine: 4, endCol: 2 });

		expect(Object.keys(fields).sort()).toEqual([
			"col",
			"endCol",
			"endLine",
			"line",
		]);
		expect(fields).toEqual({ line: 3, col: 7, endLine: 4, endCol: 2 });
	});

	test("a half-open range omits only the absent end", () => {
		expect(
			Object.keys(locFields({ line: 1, col: 1, endLine: 2 })).sort(),
		).toEqual(["col", "endLine", "line"]);
		expect(
			Object.keys(locFields({ line: 1, col: 1, endCol: 9 })).sort(),
		).toEqual(["col", "endCol", "line"]);
	});

	test("line and col of 0 are kept — falsy is not absent", () => {
		const fields = locFields({ line: 0, col: 0, endLine: 0, endCol: 0 });

		expect(Object.keys(fields).sort()).toEqual([
			"col",
			"endCol",
			"endLine",
			"line",
		]);
	});
});
