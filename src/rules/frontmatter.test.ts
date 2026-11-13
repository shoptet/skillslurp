import { describe, expect, test } from "bun:test";
import { freezeSurface, type ResolvedSurface, sealMap } from "../config.js";
import { DEFAULT_INCLUDE } from "../dialects.js";
import { type Frontmatter, parseSource } from "../document.js";
import {
	blockLoc,
	collectScalarPairs,
	describeType,
	FENCE_LOC,
	findScalarPair,
	isEmptyValue,
	locOf,
	readStringField,
	readStringValue,
	resolveValueAndLoc,
	START_LOC,
} from "./frontmatter.js";

/**
 * Why this file exists: `rules/frontmatter.ts` is shared by several file rules (directly, or
 * through `rules/activation.ts`) and had no test of its own — every helper was covered only
 * indirectly, through whichever rule happened to exercise it. That is thin cover for a module
 * whose whole job is to make those rules answer one question identically, and it was not even
 * complete: `isNullValue`'s `value === null` branch (a structurally absent value, `? name`) was
 * reachable and user-visible with nothing pinning it. Dropping that branch flips a real
 * diagnostic — `skill/frontmatter-schema` stops saying `name` is empty and says it "must be a
 * string, got unknown", at the block start instead of at the key — on a document with zero yaml
 * errors.
 *
 * The tests below go through the real `parseSource` (and therefore the real processor from
 * document.ts), never a locally-configured yaml parse, so a fixture here is the same
 * `Frontmatter` a rule receives at runtime.
 */

/** The surface `RuleTester` synthesizes, built the same way — through config.ts's own passes. */
const SURFACE: ResolvedSurface = freezeSurface({
	root: ".",
	kind: "skills",
	dialects: ["generic"],
	include: DEFAULT_INCLUDE.skills,
	ignore: [],
	spokes: [],
	rules: sealMap(new Map()),
});

function fmOf(source: string): Frontmatter {
	const { frontmatter } = parseSource(
		"widgets/SKILL.md",
		"/nowhere/widgets/SKILL.md",
		source,
		SURFACE,
	);
	if (frontmatter === null) {
		throw new Error("fixture has no frontmatter block");
	}
	return frontmatter;
}

/** The pair under `key`, or a thrown error — a fixture that lost its key is a broken fixture. */
function pairOf(fm: Frontmatter, key: string) {
	const pair = findScalarPair(fm, key);
	if (pair === undefined) {
		throw new Error(`fixture has no "${key}" key`);
	}
	return pair;
}

// --- the two shapes of "no value was given", which are NOT the same node ---

describe("a null value: both spellings, and the loc each one blames", () => {
	/**
	 * `? name` is yaml's explicit-key form with no `:` line under it, so the pair's `value` is
	 * literally `null` — not a Scalar holding null, no node at all. This is the branch
	 * `isNullValue` covers with `value === null`, and the only one of the two that a
	 * `isScalar(value) && value.value === null` test alone would miss.
	 */
	test("a structurally absent value (`? name`) is empty, has no node, and blames the key's own range", () => {
		const fm = fmOf("---\n? name\ndescription: A probe.\n---\nBody.\n");
		const pair = pairOf(fm, "name");
		const { value, locNode } = resolveValueAndLoc(fm, pair);

		expect(value).toBeNull();
		expect(isEmptyValue(value)).toBe(true);
		// No node to describe: this is what the rule's message says when the branch is missing.
		expect(describeType(value)).toBe("unknown");
		// The key, not the (nonexistent) value — `name` starts at column 3, after the `? `.
		expect(locNode).toBe(pair.key);
		expect(locOf(fm, locNode)).toEqual({
			line: 2,
			col: 3,
			endLine: 2,
			endCol: 7,
		});
		expect(readStringValue(fm, pair)).toBeUndefined();
	});

	/**
	 * The common spelling: a Scalar node that resolves to yaml null. It HAS a node, but a
	 * zero-width one right after the colon, which is why it falls back to the key's range too.
	 */
	test("a null scalar (`name:`) is empty, and also blames the key's own range", () => {
		const fm = fmOf("---\nname:\ndescription: A probe.\n---\nBody.\n");
		const pair = pairOf(fm, "name");
		const { value, locNode } = resolveValueAndLoc(fm, pair);

		expect(isEmptyValue(value)).toBe(true);
		expect(locNode).toBe(pair.key);
		expect(locOf(fm, locNode)).toEqual({
			line: 2,
			col: 1,
			endLine: 2,
			endCol: 5,
		});
		expect(readStringValue(fm, pair)).toBeUndefined();
	});

	test("isEmptyValue accepts a bare null but not undefined — absent and unset are different questions", () => {
		expect(isEmptyValue(null)).toBe(true);
		expect(isEmptyValue(undefined)).toBe(false);
	});
});

// --- emptiness of a string that IS there ---

describe("isEmptyValue on a present string", () => {
	test.each([
		['an empty string (`name: ""`)', '---\nname: ""\n---\nBody.\n', true],
		[
			"a whitespace-only string, which trims to nothing",
			'---\nname: "   "\n---\nBody.\n',
			true,
		],
		["a real string", "---\nname: widgets\n---\nBody.\n", false],
		[
			"a number, which is not a string at all",
			"---\nname: 42\n---\nBody.\n",
			false,
		],
	])("%s → %p", (_label, source, expected) => {
		const fm = fmOf(source);
		const { value } = resolveValueAndLoc(fm, pairOf(fm, "name"));

		expect(isEmptyValue(value)).toBe(expected);
	});

	test("an empty string still blames its OWN range, unlike a null — the quotes are real text", () => {
		const fm = fmOf('---\nname: ""\n---\nBody.\n');
		const pair = pairOf(fm, "name");
		const { locNode } = resolveValueAndLoc(fm, pair);

		expect(locNode).not.toBe(pair.key);
		expect(locOf(fm, locNode)).toEqual({
			line: 2,
			col: 7,
			endLine: 2,
			endCol: 9,
		});
	});
});

// --- describeType: the words two rules must not disagree on ---

describe("describeType", () => {
	test.each([
		["list", "---\nname: [a, b]\n---\nBody.\n"],
		["mapping", "---\nname: {a: 1}\n---\nBody.\n"],
		["number", "---\nname: 42\n---\nBody.\n"],
		["boolean", "---\nname: true\n---\nBody.\n"],
		// Tagged, not bare: a bare `2001-12-14` stays a plain string under yaml's core schema,
		// which is exactly why this branch is narrow (see the function's own comment).
		["date", "---\nname: !!timestamp 2001-12-14\n---\nBody.\n"],
		["string", "---\nname: widgets\n---\nBody.\n"],
	])("names a %s", (expected, source) => {
		const fm = fmOf(source);
		const { value } = resolveValueAndLoc(fm, pairOf(fm, "name"));

		expect(describeType(value)).toBe(expected);
	});

	test("a bare ISO-looking date is a string, not a date — the tag is what makes it a Date", () => {
		const fm = fmOf("---\nname: 2001-12-14\n---\nBody.\n");
		const { value } = resolveValueAndLoc(fm, pairOf(fm, "name"));

		expect(describeType(value)).toBe("string");
	});

	test("a null scalar falls through to the honest typeof fallback rather than crashing", () => {
		const fm = fmOf("---\nname:\n---\nBody.\n");
		const { value } = resolveValueAndLoc(fm, pairOf(fm, "name"));

		// `typeof null === "object"`. Never reached by a rule in practice — every caller checks
		// `isEmptyValue` first — but pinned so the fallback stays a fallback and not a throw.
		expect(describeType(value)).toBe("object");
	});

	test("anything that is not a yaml node at all is `unknown`", () => {
		expect(describeType(null)).toBe("unknown");
		expect(describeType(undefined)).toBe("unknown");
	});
});

// --- aliases: judge the resolved node, blame the reference ---

describe("an aliased value", () => {
	const ALIASED = "---\nname: &n widgets\ndescription: *n\n---\nBody.\n";

	test("resolves to the anchored value, so a rule judges a real string rather than an Alias wrapper", () => {
		const fm = fmOf(ALIASED);
		const { value } = resolveValueAndLoc(fm, pairOf(fm, "description"));

		expect(describeType(value)).toBe("string");
		expect(readStringField(fm, "description")?.value).toBe("widgets");
	});

	test("blames the alias reference's own range, never the anchor's — that is someone else's text", () => {
		const fm = fmOf(ALIASED);
		const pair = pairOf(fm, "description");
		const { locNode } = resolveValueAndLoc(fm, pair);

		// `*n` on line 3, columns 14–15. The anchored `widgets` sits on line 2.
		expect(locNode).not.toBe(pair.key);
		expect(locOf(fm, locNode)).toEqual({
			line: 3,
			col: 14,
			endLine: 3,
			endCol: 16,
		});
	});
});

// --- collectScalarPairs: which keys a rule can see at all ---

describe("collectScalarPairs", () => {
	test.each([
		["a bare scalar", "---\nhello\n---\nBody.\n"],
		["a list", "---\n- one\n---\nBody.\n"],
		["an empty block", "---\n---\nBody.\n"],
	])(
		"returns an empty map for %s, so every key reads as absent",
		(_l, source) => {
			const fm = fmOf(source);

			expect(collectScalarPairs(fm).size).toBe(0);
			expect(findScalarPair(fm, "name")).toBeUndefined();
			expect(readStringField(fm, "name")).toBeUndefined();
		},
	);

	/**
	 * `1:` and `"1":` are two genuinely distinct yaml keys — a number and a string — so yaml
	 * reports no DUPLICATE_KEY and the document parses clean. They collapse onto the same string
	 * here, and the FIRST one wins. Pinned because the alternative (last wins) is equally
	 * plausible-looking and would silently change which value five rules read.
	 */
	test("two keys that stringify alike collapse, first occurrence winning", () => {
		const fm = fmOf('---\n1: first\n"1": second\n---\nBody.\n');

		expect([...collectScalarPairs(fm).keys()]).toEqual(["1"]);
		expect(readStringField(fm, "1")?.value).toBe("first");
	});

	test("a non-scalar (collection) key is skipped, and does not hide the scalar keys after it", () => {
		const fm = fmOf("---\n[a]: v\nname: widgets\n---\nBody.\n");

		expect([...collectScalarPairs(fm).keys()]).toEqual(["name"]);
		expect(readStringField(fm, "name")?.value).toBe("widgets");
	});
});

// --- readStringValue / readStringField: "a usable string, or nothing" ---

describe("readStringField", () => {
	test("returns the string and the span of the value it came from", () => {
		const fm = fmOf("---\nname: widgets\ndescription: A probe.\n---\nBody.\n");

		expect(readStringField(fm, "name")).toEqual({
			value: "widgets",
			loc: { line: 2, col: 7, endLine: 2, endCol: 14 },
		});
	});

	test.each([
		["an absent key", "---\ndescription: A probe.\n---\nBody.\n"],
		["an empty string", '---\nname: ""\n---\nBody.\n'],
		["a whitespace-only string", '---\nname: "   "\n---\nBody.\n'],
		["a null scalar", "---\nname:\n---\nBody.\n"],
		["a structurally absent value", "---\n? name\n---\nBody.\n"],
		["a list", "---\nname: [a, b]\n---\nBody.\n"],
		["a mapping", "---\nname: {a: 1}\n---\nBody.\n"],
		["a number", "---\nname: 42\n---\nBody.\n"],
		["a boolean", "---\nname: true\n---\nBody.\n"],
	])(
		"is undefined for %s, so a downstream rule adds no second diagnostic about it",
		(_label, source) => {
			expect(readStringField(fmOf(source), "name")).toBeUndefined();
		},
	);
});

// --- the block-level locs ---

describe("blockLoc and locOf", () => {
	test("blockLoc spans the whole frontmatter block, fences included", () => {
		const fm = fmOf("---\nname: widgets\ndescription: A probe.\n---\nBody.\n");

		expect(blockLoc(fm)).toEqual({
			line: 1,
			col: 1,
			endLine: 4,
			endCol: 4,
		});
	});

	test("locOf falls back to the whole block when there is no node to point at", () => {
		const fm = fmOf("---\nname: widgets\n---\nBody.\n");
		const whole = blockLoc(fm);

		expect(locOf(fm, null)).toEqual(whole);
		expect(locOf(fm, undefined)).toEqual(whole);
	});
});

// --- the two shared constants ---

describe("START_LOC and FENCE_LOC", () => {
	test("are the 1-based values every rule points at when there is nothing else to blame", () => {
		expect(START_LOC).toEqual({ line: 1, col: 1 });
		expect(FENCE_LOC).toEqual({ line: 1, col: 1, endLine: 1, endCol: 4 });
	});

	/**
	 * Module-level constants handed to every rule: one rule writing into the object it was given
	 * would move every other rule's fallback position. `Readonly<T>` is a type, not a lock, so
	 * both are frozen — and `Loc`'s own fields are `readonly` now too, which is the compile-time
	 * half of the same statement.
	 */
	test("are frozen, so a rule cannot move another rule's fallback position", () => {
		expect(Object.isFrozen(START_LOC)).toBe(true);
		expect(Object.isFrozen(FENCE_LOC)).toBe(true);
		expect(() => {
			(START_LOC as { line: number }).line = 2;
		}).toThrow(TypeError);
		expect(() => {
			(FENCE_LOC as { col: number }).col = 9;
		}).toThrow(TypeError);

		expect(START_LOC.line).toBe(1);
		expect(FENCE_LOC.col).toBe(1);
	});
});
