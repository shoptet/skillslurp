import { expect, test } from "bun:test";
import { freezeSurface, sealMap } from "../../config.js";
import type { ActivationKey, DialectId } from "../../dialects.js";
import { type Frontmatter, parseSource } from "../../document.js";
import { runCase, runRuleTests } from "../../testing/rule-tester.js";
import {
	type DialectActivation,
	valueShape,
	valueShapeReports,
} from "./value-shape.js";

/**
 * **(A) `runRuleTests`** drives the rule end to end through the engine, against the real
 * dialects: today the one contract that lists a shape is `cursor`'s rules `globs`.
 *
 * **(B) direct calls of `valueShapeReports`** with synthetic activations, because no built-in
 * can tell a rule that reads the data from one that hard-codes Cursor's `globs`: `RuleTester`'s
 * `surface.dialects` accepts built-in ids only, and only one of them lists a shape.
 *
 * **(C)** the data and the registry sit in `dialects.test.ts` and `index.test.ts`.
 */

/** Line 1 is the opening fence, so the first key is on line 2. */
const doc = (frontmatter: string): string =>
	`---\n${frontmatter}\n---\nBody.\n`;

const CURSOR_RULES = { kind: "rules", dialects: ["cursor"] } as const;

/** Written out, not built from the data: changing the text has to be done twice, on purpose. */
const M =
	'Frontmatter key "globs" is a list in brackets, which does not activate this document in "cursor"; write the patterns comma-separated instead, as in "globs: a, b", quoting the value if it starts with "*", "!" or "{"';

// --- (A) end to end, against the real cursor rules contract ---

runRuleTests(valueShape, {
	valid: [
		{
			name: "a block list is not reported (it attaches in Cursor 3.25.9)",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs:\n  - docs/**") },
		},
		{
			name: "a comma-separated scalar, quoted or bare, or one with a brace set, is not reported",
			surface: CURSOR_RULES,
			files: {
				"bare.mdc": doc("globs: docs/**, src/**"),
				"double.mdc": doc('globs: "docs/**, src/**"'),
				"single.mdc": doc("globs: 'docs/**'"),
				"braces.mdc": doc("globs: src/*.{ts,tsx}"),
			},
		},
		{
			name: "an alias to a flow list is not judged through the alias",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("description: &g [docs/**]\nglobs: *g") },
		},
		{
			name: "an empty flow list is left alone",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: []") },
		},
		{
			name: "a flow list of blank items is left alone",
			surface: CURSOR_RULES,
			files: {
				"empty-string.mdc": doc('globs: [""]'),
				"null.mdc": doc("globs: [~]"),
			},
		},
		{
			name: "a flow list with a non-string item is the type check's, not this rule's",
			surface: CURSOR_RULES,
			files: {
				"mixed.mdc": doc("globs: [1, docs/**]"),
				"number.mdc": doc("globs: [1]"),
			},
		},
		{
			name: "a flow mapping is not a sequence",
			surface: CURSOR_RULES,
			files: {
				"empty.mdc": doc("globs: {}"),
				"pair.mdc": doc("globs: {docs: x}"),
			},
		},
		{
			name: "a flow item inside a block list is not reported",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs:\n  - [docs/**]") },
		},
		{
			name: "a claude-code rules surface has no dialect with the data, so no report",
			surface: { kind: "rules", dialects: ["claude-code"] },
			files: { "x.md": doc("globs: [docs/**]\npaths: [docs/**]") },
		},
		{
			name: "a generic skills surface has no dialect with the data, so no report",
			surface: { kind: "skills", dialects: ["generic"] },
			files: {
				"widgets/SKILL.md": doc(
					"name: widgets\ndescription: A skill.\nglobs: [docs/**]",
				),
			},
		},
		{
			name: "cursor skills keys are untouched",
			surface: { kind: "skills", dialects: ["cursor"] },
			files: {
				"widgets/SKILL.md": doc(
					"name: widgets\ndescription: A skill.\npaths: [docs/**]\nglobs: [docs/**]",
				),
			},
		},
		{
			name: "copilot applyTo is untouched",
			surface: { kind: "instructions", dialects: ["copilot"] },
			files: { "x.instructions.md": doc('applyTo: ["**/*.ts"]') },
		},
		{
			name: "a non-activation key is never judged",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("description: [docs/**]") },
		},
		{
			name: "a document with no frontmatter block, or one that is not a mapping, is left to the schema rule",
			surface: CURSOR_RULES,
			files: {
				"none.mdc": "# Rule\n\nNo frontmatter here.\n",
				"list.mdc": doc("- a"),
			},
		},
	],
	invalid: [
		{
			name: "a one-item flow list of a quoted pattern is reported at the list",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc('globs: ["docs/**"]') },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 19 }],
		},
		{
			name: "a one-item flow list of a bare pattern is reported at the list",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: [docs/**]") },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 17 }],
		},
		{
			name: "a flow list of several patterns is reported over the whole list",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: [docs/**, src/**]") },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 25 }],
		},
		{
			name: "a flow list over several lines is reported over its whole span",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: [\n  docs/**,\n  src/**\n  ]") },
			errors: [{ message: M, line: 2, col: 8, endLine: 5, endCol: 4 }],
		},
		{
			name: "an anchor before the bracket does not hide the list",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: &g [docs/**]") },
			errors: [{ message: M, line: 2, col: 11, endLine: 2, endCol: 20 }],
		},
		{
			name: "a tag before the bracket does not hide the list",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("globs: !!seq [docs/**]") },
			errors: [{ message: M, line: 2, col: 14, endLine: 2, endCol: 23 }],
		},
		{
			name: "a negated pattern in a flow list is still reported",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc('globs: ["!docs/**"]') },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 20 }],
		},
		{
			name: "alwaysApply: true does not silence the report",
			surface: CURSOR_RULES,
			files: { "x.mdc": doc("alwaysApply: true\nglobs: [docs/**]") },
			errors: [{ message: M, line: 3, col: 8, endLine: 3, endCol: 17 }],
		},
		{
			name: "the dialect list, not the file extension, decides: a .md file on a cursor rules surface is reported",
			surface: { ...CURSOR_RULES, include: ["**/*.md"] },
			files: { "x.md": doc("globs: [docs/**]") },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 17 }],
		},
		{
			name: "only the key whose contract records the shape is reported: globs, not paths, on a claude-code + cursor surface",
			surface: { kind: "rules", dialects: ["claude-code", "cursor"] },
			files: { "x.md": doc("globs: [docs/**]\npaths: [docs/**]") },
			errors: [{ message: M, line: 2, col: 8, endLine: 2, endCol: 17 }],
		},
	],
});

/**
 * Both documents are on `runCase`, not `runRuleTests`: the expected diagnostics are the engine's
 * own, which `runRuleTests` refuses for an invalid case (nothing in it would assert the rule).
 * The clean companion keeps the rule invoked.
 */
test("a duplicate key never reaches the rule: the engine reports it and skips the document", async () => {
	await runCase(
		valueShape,
		{
			name: "duplicate globs key",
			surface: CURSOR_RULES,
			files: {
				"dup.mdc": doc("globs: [docs/**]\nglobs: docs/**"),
				"clean.mdc": doc("globs: docs/**"),
			},
			expectParseErrors: true,
		},
		[
			{
				message: "Map keys must be unique",
				line: 3,
				col: 1,
				endLine: 3,
				endCol: 2,
				file: "dup.mdc",
				ruleId: "parse/frontmatter",
				severity: "error",
				fixable: false,
			},
		],
	);
});

test("a bare leading * stays a parse error, and the rule does not see the document", async () => {
	await runCase(
		valueShape,
		{
			name: "unquoted globs starting with *",
			surface: CURSOR_RULES,
			files: {
				"star.mdc": doc("globs: **/*.ts"),
				"clean.mdc": doc("globs: docs/**"),
			},
			expectParseErrors: true,
		},
		[
			{
				message:
					"Unresolved alias (the anchor must be set before the alias): */*.ts",
				line: 1,
				col: 1,
				file: "star.mdc",
				ruleId: "parse/frontmatter",
				severity: "error",
				fixable: false,
			},
		],
	);
});

// --- (B) the pure core, against synthetic activations ---

const surfaceOf = () =>
	freezeSurface({
		root: ".",
		kind: "rules",
		dialects: ["cursor"],
		include: ["**/*.mdc"],
		ignore: [],
		spokes: [],
		rules: sealMap(new Map()),
	});

function frontmatterOf(source: string): Frontmatter {
	const { frontmatter } = parseSource(
		"x.mdc",
		"/nowhere/x.mdc",
		source,
		surfaceOf(),
	);
	if (frontmatter === null) {
		throw new Error("the fixture has no frontmatter block");
	}
	return frontmatter;
}

const activation = (
	dialect: DialectId,
	key: ActivationKey,
): DialectActivation => ({ dialect, activation: key });

const FLOW: ActivationKey = {
	key: "globs",
	splitter: "comma-scalar",
	nonActivatingShapes: ["flow-sequence"],
};

const listMessage = (key: string, dialects: string): string =>
	`Frontmatter key "${key}" is a list in brackets, which does not activate this document in ${dialects}; write the patterns comma-separated instead, as in "${key}: a, b", quoting the value if it starts with "*", "!" or "{"`;

test("the core reads the data, not Cursor's name: a synthetic copilot applyTo is reported under its own key and dialect", () => {
	const reports = valueShapeReports(frontmatterOf(doc("applyTo: [a]")), [
		activation("copilot", {
			key: "applyTo",
			splitter: "comma-scalar",
			nonActivatingShapes: ["flow-sequence"],
		}),
	]);
	expect(reports.map((r) => r.message)).toEqual([
		listMessage("applyTo", '"copilot"'),
	]);
});

/**
 * Not an end-to-end case: the engine drops an exact duplicate diagnostic, so a per-pattern report
 * (same message, same position) would be invisible through `runRuleTests`.
 */
test("several patterns are one report, not one per item", () => {
	const reports = valueShapeReports(
		frontmatterOf(doc("globs: [docs/**, src/**, lib/**]")),
		[activation("cursor", FLOW)],
	);
	expect(reports.map((r) => r.message)).toEqual([
		listMessage("globs", '"cursor"'),
	]);
});

test("a key whose contract lists no shape is not reported: no data, no report", () => {
	const reports = valueShapeReports(frontmatterOf(doc("globs: [a]")), [
		activation("cursor", { key: "globs", splitter: "comma-scalar" }),
	]);
	expect(reports).toEqual([]);
});

test("the shape is about the primary key only: a legacy key is not reported", () => {
	const reports = valueShapeReports(frontmatterOf(doc("globs: [a]")), [
		activation("cursor", {
			key: "paths",
			splitter: "list-or-string",
			legacyKeys: ["globs"],
			nonActivatingShapes: ["flow-sequence"],
		}),
	]);
	expect(reports).toEqual([]);
});

test("dialects are named once, sorted, whatever order they are given in", () => {
	const reports = valueShapeReports(frontmatterOf(doc("globs: [a]")), [
		activation("cursor", FLOW),
		activation("copilot", FLOW),
	]);
	expect(reports.map((r) => r.message)).toEqual([
		listMessage("globs", '"copilot", "cursor"'),
	]);
});

test("a dialect given twice is named once", () => {
	const reports = valueShapeReports(frontmatterOf(doc("globs: [a]")), [
		activation("cursor", FLOW),
		activation("copilot", FLOW),
		activation("cursor", FLOW),
	]);
	expect(reports.map((r) => r.message)).toEqual([
		listMessage("globs", '"copilot", "cursor"'),
	]);
});

test("a dialect that reads the key but lists no shape for it is not named", () => {
	const reports = valueShapeReports(frontmatterOf(doc("globs: [a]")), [
		activation("copilot", { key: "globs", splitter: "comma-scalar" }),
		activation("cursor", FLOW),
	]);
	expect(reports.map((r) => r.message)).toEqual([
		listMessage("globs", '"cursor"'),
	]);
});

test("two keys that each list the shape are reported in document order, one report each", () => {
	const reports = valueShapeReports(
		frontmatterOf(doc("applyTo: [b]\nglobs: [a]")),
		[
			activation("cursor", FLOW),
			activation("copilot", {
				key: "applyTo",
				splitter: "comma-scalar",
				nonActivatingShapes: ["flow-sequence"],
			}),
		],
	);
	expect(reports.map((r) => [r.message, r.loc?.line])).toEqual([
		[listMessage("applyTo", '"copilot"'), 2],
		[listMessage("globs", '"cursor"'), 3],
	]);
});
