import { expect, test } from "bun:test";
import { z } from "zod";
import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import { json, jsonRules } from "./json.js";

/** Builds a `Diagnostic` with sensible defaults, overridable per test. */
function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		ruleId: "rule/id",
		severity: "error",
		message: "message",
		file: "file.md",
		fixable: false,
		docsUrl: "https://example.invalid/docs",
		...overrides,
	};
}

// Mirrors reporters/stylish.test.ts's FIXTURE: two files, mixed severities, one diagnostic
// without line/col/endLine/endCol (rule/c) to prove those keys are omitted entirely rather
// than serialized as null/undefined.
const FIXTURE: Diagnostic[] = [
	makeDiagnostic({
		ruleId: "rule/a",
		severity: "error",
		message: "short",
		file: "a.md",
		line: 1,
		col: 1,
	}),
	makeDiagnostic({
		ruleId: "rule/bb",
		severity: "warn",
		message: "a much longer message here",
		file: "a.md",
		line: 22,
		col: 3,
		fixable: true,
	}),
	makeDiagnostic({
		ruleId: "rule/c",
		severity: "error",
		message: "mid message",
		file: "b.md",
	}),
];

const FIXTURE_JSON =
	'{"version":1,"summary":{"problems":3,"errors":2,"warnings":1},"diagnostics":[{"ruleId":"rule/a","severity":"error","message":"short","file":"a.md","line":1,"col":1,"fixable":false,"docsUrl":"https://example.invalid/docs"},{"ruleId":"rule/bb","severity":"warn","message":"a much longer message here","file":"a.md","line":22,"col":3,"fixable":true,"docsUrl":"https://example.invalid/docs"},{"ruleId":"rule/c","severity":"error","message":"mid message","file":"b.md","fixable":false,"docsUrl":"https://example.invalid/docs"}]}\n';

test("json renders a pinned compact object with explicit key order, omitting undefined position keys", () => {
	expect(json(FIXTURE, { color: false })).toBe(FIXTURE_JSON);
});

test("json output ends with a trailing newline", () => {
	expect(json(FIXTURE, { color: false }).endsWith("\n")).toBe(true);
	expect(json([], { color: false }).endsWith("\n")).toBe(true);
});

test("json output parses back to the expected shape via JSON.parse", () => {
	const parsed = JSON.parse(json(FIXTURE, { color: false }));

	expect(parsed).toEqual({
		version: 1,
		summary: { problems: 3, errors: 2, warnings: 1 },
		diagnostics: [
			{
				ruleId: "rule/a",
				severity: "error",
				message: "short",
				file: "a.md",
				line: 1,
				col: 1,
				fixable: false,
				docsUrl: "https://example.invalid/docs",
			},
			{
				ruleId: "rule/bb",
				severity: "warn",
				message: "a much longer message here",
				file: "a.md",
				line: 22,
				col: 3,
				fixable: true,
				docsUrl: "https://example.invalid/docs",
			},
			{
				ruleId: "rule/c",
				severity: "error",
				message: "mid message",
				file: "b.md",
				fixable: false,
				docsUrl: "https://example.invalid/docs",
			},
		],
	});
	// Explicitly confirm the undefined position keys never became own keys on the object
	// (JSON.parse would keep them if the serializer had written `"line":null` etc, and
	// `toEqual` above would fail too, but this pins the exact failure mode).
	expect("line" in parsed.diagnostics[2]).toBe(false);
	expect("col" in parsed.diagnostics[2]).toBe(false);
	expect("endLine" in parsed.diagnostics[2]).toBe(false);
	expect("endCol" in parsed.diagnostics[2]).toBe(false);
});

test("a legacy ##[ command never appears raw in the json line, and parsing restores it", () => {
	const file = "x ##[warning]f.md";
	const message = "##[error]m ###[n";
	const out = json([makeDiagnostic({ file, message })], { color: false });
	expect(out).not.toContain("##[");
	const parsed: unknown = JSON.parse(out);
	expect(parsed).toMatchObject({ diagnostics: [{ file, message }] });
});

test("zero diagnostics renders a pinned empty-array, zero-count object", () => {
	expect(json([], { color: false })).toBe(
		'{"version":1,"summary":{"problems":0,"errors":0,"warnings":0},"diagnostics":[]}\n',
	);
});

test("the color option is ignored: color: true and color: false produce identical output", () => {
	expect(json(FIXTURE, { color: true })).toBe(json(FIXTURE, { color: false }));
});

test("a diagnostic with endLine/endCol pins the full explicit key order, including them", () => {
	const withEnd: Diagnostic[] = [
		makeDiagnostic({
			ruleId: "rule/range",
			severity: "error",
			message: "spans a range",
			file: "r.md",
			line: 5,
			col: 2,
			endLine: 6,
			endCol: 9,
		}),
	];

	expect(json(withEnd, { color: false })).toBe(
		'{"version":1,"summary":{"problems":1,"errors":1,"warnings":0},"diagnostics":[{"ruleId":"rule/range","severity":"error","message":"spans a range","file":"r.md","line":5,"col":2,"endLine":6,"endCol":9,"fixable":false,"docsUrl":"https://example.invalid/docs"}]}\n',
	);
});

// ---------------------------------------------------------------------------------------------
// `jsonRules` — the `--list-rules` renderer.
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors reporters/stylish.test.ts's RULE_FIXTURE and, like it, is synthetic on purpose: this
 * block pins the listing's key order and value types, not which rules exist. `builtinRules`
 * coverage is derived from `builtinRules` in run.test.ts and cli.test.ts.
 *
 * The `optionsSchema` on the first rule is load-bearing rather than decoration. It is the only
 * thing that lets the key-order assertion below SEE a `serializeRule` that spread `rule.meta`
 * instead of naming its fields: without a rule that actually carries one, a spread would produce
 * the right seven keys anyway and the test would pass for the wrong reason. Five of today's
 * built-ins carry one.
 */
const RULE_FIXTURE: readonly Rule[] = [
	{
		kind: "file",
		meta: {
			id: "a/short",
			description: "short",
			docsUrl: "https://example.invalid/a",
			tiers: ["recommended", "strict"],
			defaultSeverity: "warn",
			fixable: true,
			optionsSchema: z.strictObject({ max: z.number().default(12) }),
		},
		check: () => [],
	},
	{
		kind: "project",
		meta: {
			id: "b/medium-id",
			description: "a much longer description",
			docsUrl: "https://example.invalid/b",
			tiers: [],
			defaultSeverity: "error",
			fixable: false,
		},
		check: () => [],
	},
];

test("jsonRules: a bare array, one compact object per rule, in the pinned key order", () => {
	expect(jsonRules(RULE_FIXTURE, { color: false })).toBe(
		'[{"id":"a/short","kind":"file","tiers":["recommended","strict"],"defaultSeverity":"warn","fixable":true,"description":"short","docsUrl":"https://example.invalid/a"},{"id":"b/medium-id","kind":"project","tiers":[],"defaultSeverity":"error","fixable":false,"description":"a much longer description","docsUrl":"https://example.invalid/b"}]\n',
	);
});

/**
 * The key order restated as a list rather than as a substring of the pin above, so a reader can
 * see the seven fields without counting quotes — and so `optionsSchema` is named as
 * an absence rather than merely not mentioned.
 */
test("jsonRules: exactly the seven listed fields, and never the rule's optionsSchema", () => {
	const parsed = JSON.parse(
		jsonRules(RULE_FIXTURE, { color: false }),
	) as Record<string, unknown>[];

	expect(Object.keys(parsed[0] as Record<string, unknown>)).toEqual([
		"id",
		"kind",
		"tiers",
		"defaultSeverity",
		"fixable",
		"description",
		"docsUrl",
	]);
	expect(parsed[0]).not.toHaveProperty("optionsSchema");
	expect(parsed[1]).not.toHaveProperty("optionsSchema");
});

/**
 * A bare top-level array, deliberately unlike the `{ version, summary, diagnostics }` envelope a
 * lint run emits: a listing is a static dump with no summary to carry, and `jq '.[].id'` is the
 * whole reason to ask for it in json. Pinned so the difference is a decision on the record rather
 * than something a future change quietly "fixes".
 */
test("jsonRules: the payload is an array, not the diagnostics envelope", () => {
	const parsed: unknown = JSON.parse(jsonRules(RULE_FIXTURE, { color: false }));

	expect(Array.isArray(parsed)).toBe(true);
	expect(parsed).not.toHaveProperty("version");
});

test("jsonRules: color is ignored — the two renderings are byte-identical", () => {
	expect(jsonRules(RULE_FIXTURE, { color: true })).toBe(
		jsonRules(RULE_FIXTURE, { color: false }),
	);
});

test("jsonRules: an empty rule list is still a parseable empty array", () => {
	expect(jsonRules([], { color: false })).toBe("[]\n");
});

// U+2028/U+2029 reached all three reporters raw, and the fix
// widened `sanitizeControlChars` to cover them — but the json reporter does not call that
// function, so the fix stopped one reporter short of the claim made for it. `JSON.stringify`
// escapes every C0 control character and deliberately leaves these two, which is legal JSON;
// escaped here so the invariant is true of every reporter rather than two out of three.
//
// Mutation check: drop the `.replace` in `serialize` and both assertions fail.
test("json: U+2028 and U+2029 are escaped, and the document still parses to the same string", () => {
	const message = `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`;
	const out = json(
		[
			{
				ruleId: "rule/a",
				severity: "error",
				message,
				file: "file.md",
				fixable: false,
				docsUrl: "https://example.invalid/docs",
			},
		],
		{ color: false },
	);

	expect(out).toContain("a\\u2028b\\u2029c");
	expect(/[\u2028\u2029]/u.test(out)).toBe(false);
	// Escaping is a rendering choice, never a change of value: a consumer parses back what the
	// rule actually said.
	const parsed: unknown = JSON.parse(out);
	expect(
		(parsed as { diagnostics: { message: string }[] }).diagnostics[0]?.message,
	).toBe(message);
});
