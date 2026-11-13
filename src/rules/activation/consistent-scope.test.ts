import { describe, expect, test } from "bun:test";
import type { ActivationSplitter, DialectId } from "../../dialects.js";
import {
	BUILTIN_DIALECT_IDS,
	BUILTIN_DIALECTS,
	defaultInclude,
	SURFACE_KINDS,
} from "../../dialects.js";
import { runRuleTests } from "../../testing/rule-tester.js";
import {
	type ActivationView,
	consistentScope,
	normalizeActivationPatterns,
	outOfSyncMessage,
	splitActivationScalar,
} from "./consistent-scope.js";

/**
 * The two halves of this file exist for different reasons, and the split is the point.
 *
 * **(A) `runRuleTests`** drives the rule end to end through the engine, against REAL dialects —
 * which is also the ceiling of what real dialects can prove. Two built-in surface kinds have two
 * dialects with an activation key, both as `claude-code` + `cursor`. On `skills` they name the
 * same primary key `paths`, so a document that sets `paths` is in sync by construction, and the
 * only divergence a skill can produce is a Cursor skill scoped by the legacy `globs` key that
 * Claude Code does not read at all — the case `dialects.ts`'s `legacyKeys` exists for. On `rules`
 * they name different primary keys, `paths` and `globs`, so a rule file scoped by one of them, or
 * by two different lists, is a real divergence between two tools the surface claims to serve.
 *
 * **(B) direct unit tests** of the exported pure helpers, because everything else the comparison
 * can do — two different primary key names, a three-way split, two `opaque` scopes on different
 * keys — is unreachable through `RuleTester`, whose `surface.dialects` only accepts built-in
 * `DialectId`s. Same reasoning `mergeContractList` (dialects.ts) is exported under.
 */

/** A skill body, so every fixture is a plausible file rather than bare frontmatter. */
const BODY = "\nBody.\n";

/**
 * The one built-in surface that pairs two activating dialects. `claude-code` reads `paths`;
 * `cursor` reads `paths` too, falling back to the legacy `globs` when `paths` is absent.
 */
const BOTH: { kind: "skills"; dialects: readonly DialectId[] } = {
	kind: "skills",
	dialects: ["claude-code", "cursor"],
};

/**
 * The built-in rules surface that pairs two activating dialects. `claude-code` reads `paths`;
 * `cursor` reads `globs`, written as bare comma-separated patterns. `include` is the real
 * default for these dialects, so both `.md` and `.mdc` files belong to the surface.
 */
const RULES = {
	kind: "rules",
	dialects: ["claude-code", "cursor"],
	include: defaultInclude("rules", ["claude-code", "cursor"]),
} as const;

const outOfSync = (groups: string): string =>
	`Activation is out of sync across this surface's dialects — ${groups}`;

const UNSCOPED = "unscoped (no activation key present)";
const legacyScope = (key: string): string =>
	`scoped by "${key}" (legacy key; its value shape is undocumented, so it cannot be compared)`;

/**
 * The compile-time half of the rule's "both splitters are handled identically" limitation (same
 * device `dialects.test.ts` uses for `SurfaceKind`): adding a third `ActivationSplitter` to
 * `dialects.ts` fails `tsc` right here, forcing whoever adds it to decide what this rule should
 * do with it instead of silently inheriting comma-splitting. There is no runtime assertion to
 * pair with it — the rule branches on the splitter nowhere, by design, so no input can make the
 * two behave differently. A shape a tool does not activate on is activation data
 * (`nonActivatingShapes`), not a splitter, so it does not belong in this record.
 */
const SPLITTERS_HANDLED_ALIKE: Readonly<Record<ActivationSplitter, true>> =
	Object.freeze({ "comma-scalar": true, "list-or-string": true });

test("every ActivationSplitter is covered by this rule's single, shared handling", () => {
	expect(Object.keys(SPLITTERS_HANDLED_ALIKE).sort()).toEqual([
		"comma-scalar",
		"list-or-string",
	]);
});

// --- (A) end to end, against the real claude-code + cursor skills contracts ---

runRuleTests(consistentScope, {
	valid: [
		{
			name: "no activation key at all: both dialects see an always-eligible skill",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Always eligible, in every tool on this surface.\n---${BODY}`,
			},
		},
		{
			// `skill/frontmatter-schema` owns "there is no frontmatter"; this rule has nothing to
			// add, and must not crash reaching for a block that is not there.
			name: "a document with no frontmatter at all is left to the schema rule",
			surface: BOTH,
			files: { "widgets/SKILL.md": "# Widgets\n\nNo frontmatter here.\n" },
		},
		{
			// Same ownership argument for a block that parses but is not a mapping. Silence here
			// is not a short-circuit that changes the answer — with no mapping there are no keys,
			// so every dialect would see an unscoped document anyway — it is this rule declining
			// to add a second diagnostic to a document already being reported on.
			name: "frontmatter that is not a mapping is left to the schema rule",
			surface: BOTH,
			files: { "widgets/SKILL.md": `---\n- one\n- two\n---${BODY}` },
		},
		{
			name: "a comma-separated paths scalar is read identically by both dialects",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Scoped by a comma-separated scalar.\npaths: "**/*.ts, **/*.tsx"\n---${BODY}`,
			},
		},
		{
			name: "a paths YAML list is read identically by both dialects, whatever its order",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Scoped by a list written out of order.\npaths:\n  - b/**\n  - a/**\n---${BODY}`,
			},
		},
		{
			// A list item can be an alias, and an alias to a string is valid yaml every tool
			// resolves before it ever sees a value — so the item has to be resolved here too,
			// not reported as an unreadable list item. (Both anchor and alias name the same
			// pattern, so the deduped result is a single-pattern scope.)
			name: "an alias item in a paths list resolves to its string, not to an unreadable item",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A list whose second item is an alias.\npaths:\n  - &shared docs/**\n  - *shared\n---${BODY}`,
			},
		},
		{
			// A trailing bare `-` is a common typo and perfectly legal yaml, so the item it creates
			// has to be DROPPED, exactly as an empty segment of a comma-separated scalar is
			// (`"a,,b"`). Without that drop it falls into the type-violation branch and an ordinary
			// list is reported as holding an unreadable item — a false positive on valid input,
			// which is the failure mode this repo weighs heaviest.
			name: "a trailing empty item in a paths list is dropped, not an unreadable item",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A list whose last item was left blank.\npaths:\n  - a/**\n  -\n---${BODY}`,
			},
		},
		{
			// The explicit spelling of the same thing, pinned separately because it is a separate
			// thing a user can write — not because it reaches different code: measured against yaml
			// 2.9.0, a bare `-` and a `- ~` both parse to a null Scalar (the bare one's range is
			// zero-width, the explicit one's is not), so `isEmptyValue` sees the same null either
			// way. A parser that ever stopped collapsing the two would break exactly one of these.
			name: "an explicit null item (~) in a paths list is dropped the same way",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A list with an explicit null item.\npaths:\n  - ~\n  - a/**\n---${BODY}`,
			},
		},
		{
			name: "a present-but-empty paths key is unscoped for both dialects, not a divergence",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An activation key with nothing after the colon.\npaths:\n---${BODY}`,
			},
		},
		{
			// The precedence decision, pinned: "fallback" is Cursor's own word, so `paths` wins
			// and `globs` is never consulted — by ANY dialect. Were the legacy key read while the
			// primary is present, cursor would see `y/**` and claude-code `x/**`, and this case
			// would report.
			name: "paths and globs together: the primary wins, so the legacy key is never consulted",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Carries both the current and the legacy key.\npaths: x/**\nglobs: y/**\n---${BODY}`,
			},
		},
		{
			// The undisclosed half of the precedence rule above, now disclosed and pinned (see the
			// rule's JSDoc): `chooseKey` keys off key PRESENCE, so an empty
			// `paths` is still the key cursor reads and its `globs` fallback is never consulted.
			// Both dialects see an unscoped document, they agree, and the populated `globs` is
			// silently ignored. Reporting would require assuming Cursor treats an empty `paths` as
			// absent, which Cursor documents nowhere.
			name: "an empty paths key silences the legacy fallback: a populated globs is not read",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An empty primary key above a populated legacy one.\npaths:\nglobs: "a/**"\n---${BODY}`,
			},
		},
		{
			// Same decision, second spelling: an empty STRING is `isEmptyValue`'s other branch.
			name: "an empty-string paths key silences the legacy fallback the same way",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An empty-string primary key above a populated legacy one.\npaths: ""\nglobs: "a/**"\n---${BODY}`,
			},
		},
		{
			// Same decision, third spelling: an empty SEQ, which `readScope` handles in its own
			// clause rather than through `isEmptyValue`. All three reach the same silence, and all
			// three reach it through `chooseKey` returning the primary before any of them is read.
			name: "an empty-list paths key silences the legacy fallback the same way",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An empty-list primary key above a populated legacy one.\npaths: []\nglobs: "a/**"\n---${BODY}`,
			},
		},
		{
			// cursor falls back to `globs`, finds it empty, and lands on the same "unscoped" as
			// claude-code's missing `paths` — an absent key and a present-but-empty one are the
			// same scope.
			name: "an empty legacy globs key is unscoped, the same as claude-code's missing paths",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A legacy key with nothing after the colon.\nglobs:\n---${BODY}`,
			},
		},
		{
			// An empty LIST is the case that needs its own clause: `isEmptyValue` only knows
			// nulls and blank strings, so without it an empty `globs: []` would become an
			// `opaque` scope — uncomparable, and therefore reported — instead of the plain
			// "nothing scopes this document" it plainly is.
			name: "an empty list under the legacy key is unscoped too, not an uncomparable value",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A legacy key holding an empty list.\nglobs: []\n---${BODY}`,
			},
		},
		{
			// The gate: the rule runs (the RuleTester's own "never invoked" guard proves that)
			// and reports nothing, because one activating dialect cannot be out of sync with
			// itself.
			name: "a single-dialect surface never reports, even with only the legacy key set",
			surface: { kind: "skills", dialects: ["cursor"] },
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Only Cursor reads this surface.\nglobs: "**/*.ts"\n---${BODY}`,
			},
		},
		{
			// The gate returns before any value is read, which is what makes it a gate rather
			// than a comparison that happens to find one view: the same unusable `paths` value
			// that is a type violation on a two-dialect surface says nothing at all here, because
			// there is no second dialect for this document to be out of sync with.
			name: "a single-dialect surface is not even type-checked — the gate returns first",
			surface: { kind: "skills", dialects: ["cursor"] },
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An unusable activation value on a single-dialect surface.\npaths: 42\n---${BODY}`,
			},
		},
		{
			// `generic` documents no activation key, and is EXCLUDED from the comparison rather
			// than counted as a dialect that sees the skill as always-eligible. The rejected
			// reading would make this extremely common pairing report on every path-scoped
			// skill (see the rule's JSDoc).
			name: "a dialect with no activation key is excluded, not treated as always-eligible",
			surface: { kind: "skills", dialects: ["claude-code", "generic"] },
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Path-scoped on a surface whose other dialect has no activation key.\npaths: "**/*.ts"\n---${BODY}`,
			},
		},
		{
			// The same list written three ways and a comma-separated string, in a different order
			// and with a repeat: Cursor's `globs` and Claude Code's `paths` mean one scope whatever
			// shape carries it, and the patterns are compared as a sorted, deduped set.
			name: "globs and paths naming the same patterns in different spellings are in sync",
			surface: RULES,
			files: {
				"flow.md": `---\nglobs: a/**, b/**\npaths: [b/**, a/**]\n---${BODY}`,
				"block.md": `---\nglobs: a/**, b/**\npaths:\n  - b/**\n  - a/**\n---${BODY}`,
				"repeat.md": `---\nglobs: a/**, b/**\npaths: [a/**, a/**, b/**]\n---${BODY}`,
				"string.md": `---\nglobs: a/**, b/**\npaths: "b/**, a/**"\n---${BODY}`,
			},
		},
		{
			// The comma inside the braces is part of one pattern in the scalar, so it equals the
			// same pattern written as a list item.
			name: "a brace group in a comma-separated globs equals the same pattern in a paths list",
			surface: RULES,
			files: {
				"braces.md": `---\nglobs: src/*.{ts,tsx}\npaths: ["src/*.{ts,tsx}"]\n---${BODY}`,
			},
		},
		{
			// Neither vendor requires its key: a rule with neither is always loaded in both tools,
			// which is a scope they agree on. Requiring a key is `skill/frontmatter-schema`'s option.
			name: "a rules document with neither globs nor paths is unscoped in both tools",
			surface: RULES,
			files: {
				"always.md": `---\ndescription: Applies everywhere.\n---${BODY}`,
			},
		},
		{
			name: "an empty paths list and no globs are both unscoped, so they agree",
			surface: RULES,
			files: { "empty.md": `---\npaths: []\n---${BODY}` },
		},
		{
			// The gate again, on a kind where a second activating dialect exists to be left out.
			// A value neither tool could read is what makes it observable: with one activating
			// dialect there is no comparison, so there is nothing to type-check either.
			name: "a rules surface naming only claude-code never reports, not even for an unreadable paths value",
			surface: {
				kind: "rules",
				dialects: ["claude-code"],
				include: defaultInclude("rules", ["claude-code"]),
			},
			files: { "ts.md": `---\npaths: 42\n---${BODY}` },
		},
	],
	invalid: [
		{
			// `paths` without `globs`: scoped in Claude Code, always loaded in Cursor. Reported
			// once, at the `paths` key, with the group that has no key named as unscoped.
			name: "paths without globs: scoped in claude-code, unscoped in cursor",
			surface: RULES,
			files: {
				"frontend/ts.md": `---\npaths: [src/**/*.ts]\n---${BODY}`,
			},
			errors: [
				{
					message: outOfSync(
						`claude-code: "paths" = src/**/*.ts; cursor: ${UNSCOPED}`,
					),
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 6,
				},
			],
		},
		{
			name: "globs without paths: unscoped in claude-code, scoped in cursor",
			surface: RULES,
			files: { "ts.md": `---\nglobs: src/**/*.ts\n---${BODY}` },
			errors: [
				{
					message: outOfSync(
						`claude-code: ${UNSCOPED}; cursor: "globs" = src/**/*.ts`,
					),
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 6,
				},
			],
		},
		{
			// Two scopes, one report naming both groups, blamed on the first activation key in the
			// file: `globs` here, and `paths` in the mirrored file.
			name: "paths and globs naming different patterns are one report naming both groups",
			surface: RULES,
			files: {
				"globs-first.md": `---\nglobs: a/**\npaths: [b/**]\n---${BODY}`,
				"paths-first.md": `---\npaths: [b/**]\nglobs: a/**\n---${BODY}`,
			},
			errors: [
				{
					file: "globs-first.md",
					message: outOfSync(
						`claude-code: "paths" = b/**; cursor: "globs" = a/**`,
					),
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 6,
				},
				{
					file: "paths-first.md",
					message: outOfSync(
						`claude-code: "paths" = b/**; cursor: "globs" = a/**`,
					),
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 6,
				},
			],
		},
		{
			// The default include for this pair is the union, so a Cursor-style `.mdc` file is
			// judged against Claude Code's reading of it as well.
			name: "a .mdc file on the union surface is compared the same way",
			surface: RULES,
			files: { "ts.mdc": `---\nglobs: src/**/*.ts\n---${BODY}` },
			errors: [
				{
					message: outOfSync(
						`claude-code: ${UNSCOPED}; cursor: "globs" = src/**/*.ts`,
					),
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 6,
				},
			],
		},
		{
			// The one divergence the skills built-ins can actually produce, and the whole reason
			// `legacyKeys` is on the cursor skills contract: Cursor honours `globs`, Claude Code
			// has never heard of it, so the same file is path-scoped in one tool and always
			// eligible in the other. Positioned on the KEY node, not the value.
			name: "a legacy globs key with no paths is out of sync, reported once at the globs key",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: Scoped only by Cursor's legacy key.\nglobs: "**/*.ts"\n---${BODY}`,
			},
			errors: [
				{
					message: outOfSync(
						`claude-code: ${UNSCOPED}; cursor: ${legacyScope("globs")}`,
					),
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 6,
				},
			],
		},
		{
			// Both dialects read `paths` and both find it unusable — one report, not two: the
			// violations are keyed by key name. Positioned on the VALUE, matching
			// `skill/frontmatter-schema`'s convention for a complaint about a value's shape.
			name: "a numeric paths value is one type violation, however many dialects read it",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An activation key holding a number.\npaths: 42\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "paths" must be a string or a list of strings, got number',
					line: 4,
					col: 8,
					endLine: 4,
					endCol: 10,
				},
			],
		},
		{
			name: "a mapping under paths is a type violation naming the mapping",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: An activation key holding a mapping.\npaths:\n  docs: "**/*.md"\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "paths" must be a string or a list of strings, got mapping',
					line: 5,
					col: 3,
					endLine: 5,
					endCol: 18,
				},
			],
		},
		{
			// A list is fine; a list with a non-string item is not, and the report names which
			// item (zero-based, like the yaml node's own index) and points straight at it.
			name: "a non-string item in a paths list is a type violation naming its index",
			surface: BOTH,
			files: {
				"widgets/SKILL.md": `---\nname: widgets\ndescription: A list with one non-string item.\npaths: [ok, 42]\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "paths" must be a list of strings, but item 1 is a number',
					line: 4,
					col: 13,
					endLine: 4,
					endCol: 15,
				},
			],
		},
	],
});

/**
 * Every file rule that claims no `doc.surface.kind` gate gets an
 * `invalid` case on a non-`skills` surface wherever one can be built, so that adding such a gate
 * to `check` breaks a test rather than passing silently. For this rule that case exists now:
 * the `rules` cases above run on a surface with two activating dialects, so
 * `if (doc.surface.kind !== "skills") return [];` fails them.
 *
 * What this assertion pins is where that stops. `instructions` is spoken by one built-in with an
 * activation key, so no `invalid` case can be written for it: a surface cannot list a second
 * dialect, since both `loadConfig` and `RuleTester`'s `buildSurface` reject a dialect with no
 * contract for the surface's kind, and `{ kind: "instructions", dialects: ["copilot", "cursor"] }`
 * throws before a document is ever parsed. It fails on the day another dialect speaks
 * `instructions` with an activation key, at which point that case becomes constructible and has
 * to be written.
 */
test("rules has two activating dialects, which is what lets this rule be proved to run on a non-`skills` kind; instructions has one", () => {
	const activatingPerKind: Record<string, string[]> = {};
	for (const kind of SURFACE_KINDS) {
		if (kind === "skills") {
			continue;
		}
		activatingPerKind[kind] = BUILTIN_DIALECT_IDS.filter(
			(id) => BUILTIN_DIALECTS[id].contracts[kind]?.activation !== undefined,
		);
	}

	expect(activatingPerKind).toEqual({
		rules: ["claude-code", "cursor"],
		instructions: ["copilot"],
	});
});

// --- (B) the exported comparison core, over inputs real dialects cannot produce ---

describe("splitActivationScalar", () => {
	test("splits on commas and trims every part", () => {
		expect(splitActivationScalar("docs/**, src/**")).toEqual([
			"docs/**",
			"src/**",
		]);
	});

	test("trims the whole value, not just the parts after a comma", () => {
		expect(splitActivationScalar("   docs/**   ")).toEqual(["docs/**"]);
	});

	test("drops empty segments, wherever they are", () => {
		expect(splitActivationScalar(",docs/**,, ,src/**,")).toEqual([
			"docs/**",
			"src/**",
		]);
	});

	test("an all-whitespace value yields no patterns at all", () => {
		expect(splitActivationScalar("   ")).toEqual([]);
		expect(splitActivationScalar(" , ")).toEqual([]);
	});

	test("a value with no comma is a single pattern", () => {
		expect(splitActivationScalar("docs/**")).toEqual(["docs/**"]);
	});

	test("a comma inside a brace group is not a separator", () => {
		expect(splitActivationScalar("src/*.{ts,tsx}")).toEqual(["src/*.{ts,tsx}"]);
	});

	test("the commas around a brace group still separate", () => {
		expect(splitActivationScalar("a/{b,c}/*.ts, d.ts")).toEqual([
			"a/{b,c}/*.ts",
			"d.ts",
		]);
	});

	test("nested brace groups are one pattern, however many commas follow an inner group", () => {
		expect(splitActivationScalar("src/{a,{b,c}}/x.ts")).toEqual([
			"src/{a,{b,c}}/x.ts",
		]);
		expect(splitActivationScalar("src/{a,{b,c},d}/x.ts, y.ts")).toEqual([
			"src/{a,{b,c},d}/x.ts",
			"y.ts",
		]);
	});

	test("an unclosed brace splits as if it were any other character", () => {
		expect(splitActivationScalar("src/{a,b")).toEqual(["src/{a", "b"]);
		// The unclosed `{` protects nothing, and a balanced group after it still does.
		expect(splitActivationScalar("src/{a,b, c/{d,e}")).toEqual([
			"src/{a",
			"b",
			"c/{d,e}",
		]);
	});

	test("a closing brace with no opening one is an ordinary character", () => {
		expect(splitActivationScalar("a},{b,c}")).toEqual(["a}", "{b,c}"]);
	});
});

describe("normalizeActivationPatterns", () => {
	test("sorts, so a difference in order is not a difference in scope", () => {
		expect(normalizeActivationPatterns(["b/**", "a/**"])).toEqual([
			"a/**",
			"b/**",
		]);
		expect(normalizeActivationPatterns(["b/**", "a/**"])).toEqual(
			normalizeActivationPatterns(["a/**", "b/**"]),
		);
	});

	test("dedupes, so a repeated pattern is not a difference in scope", () => {
		expect(normalizeActivationPatterns(["a/**", "a/**", "b/**"])).toEqual([
			"a/**",
			"b/**",
		]);
	});

	test("trims each part and drops the empty ones", () => {
		expect(normalizeActivationPatterns([" a/** ", "", "   ", "b/**"])).toEqual([
			"a/**",
			"b/**",
		]);
	});

	test("an input with nothing usable in it normalizes to nothing", () => {
		expect(normalizeActivationPatterns([" ", ""])).toEqual([]);
	});
});

/**
 * Synthetic views: the dialect ids are real (nothing else would typecheck), but the scopes are
 * hand-built, because no pair of built-in contracts can produce them — see this file's header.
 */
const patternsView = (
	dialect: DialectId,
	key: string,
	patterns: readonly string[],
): ActivationView => ({
	dialect,
	scope: {
		kind: "patterns",
		key,
		patterns: normalizeActivationPatterns(patterns),
	},
});

const opaqueView = (dialect: DialectId, key: string): ActivationView => ({
	dialect,
	scope: { kind: "opaque", key },
});

const absentView = (dialect: DialectId): ActivationView => ({
	dialect,
	scope: { kind: "absent" },
});

const emptyView = (dialect: DialectId, key: string): ActivationView => ({
	dialect,
	scope: { kind: "empty", key },
});

describe("outOfSyncMessage", () => {
	test("two different primary keys with different pattern sets report, naming both", () => {
		// One side carries TWO patterns on purpose: it is the only case that pins the `", "`
		// separator `describeScope` joins a pattern list with (with single-element lists
		// everywhere, joining with a space — or with nothing — renders identically), and it pins
		// that the rendered list is the NORMALIZED one, sorted rather than as written.
		expect(
			outOfSyncMessage([
				patternsView("claude-code", "paths", ["src/**", "lib/**"]),
				patternsView("cursor", "globs", ["docs/**"]),
			]),
		).toBe(
			outOfSync(
				'claude-code: "paths" = lib/**, src/**; cursor: "globs" = docs/**',
			),
		);
	});

	test("two different primary keys resolving to the same patterns agree", () => {
		// The key NAME is deliberately not part of the comparison: two tools reading different
		// keys that scope the document to the same globs are exactly what "in sync" means.
		expect(
			outOfSyncMessage([
				patternsView("claude-code", "paths", ["docs/**"]),
				patternsView("cursor", "globs", ["docs/**"]),
			]),
		).toBeUndefined();
	});

	test("an ordering-only difference is not a difference", () => {
		expect(
			outOfSyncMessage([
				patternsView("claude-code", "paths", ["b/**", "a/**"]),
				patternsView("cursor", "globs", ["a/**", "b/**"]),
			]),
		).toBeUndefined();
	});

	test("a duplicate-only difference is not a difference", () => {
		expect(
			outOfSyncMessage([
				patternsView("claude-code", "paths", ["a/**", "a/**"]),
				patternsView("cursor", "globs", ["a/**"]),
			]),
		).toBeUndefined();
	});

	test("an opaque scope is never equal to an absent one — it cannot be proven equal", () => {
		expect(
			outOfSyncMessage([
				absentView("claude-code"),
				opaqueView("cursor", "globs"),
			]),
		).toBe(
			outOfSync(`claude-code: ${UNSCOPED}; cursor: ${legacyScope("globs")}`),
		);
	});

	test("an opaque scope is never equal to a pattern set either", () => {
		expect(
			outOfSyncMessage([
				patternsView("claude-code", "paths", ["a/**"]),
				opaqueView("cursor", "globs"),
			]),
		).toBe(
			outOfSync(`claude-code: "paths" = a/**; cursor: ${legacyScope("globs")}`),
		);
	});

	test("two opaque scopes on the same key agree: same key, same document, same value", () => {
		expect(
			outOfSyncMessage([
				opaqueView("claude-code", "globs"),
				opaqueView("cursor", "globs"),
			]),
		).toBeUndefined();
	});

	test("two opaque scopes on different keys do not agree", () => {
		expect(
			outOfSyncMessage([
				opaqueView("claude-code", "applyTo"),
				opaqueView("cursor", "globs"),
			]),
		).toBe(
			outOfSync(
				`claude-code: ${legacyScope("applyTo")}; cursor: ${legacyScope("globs")}`,
			),
		);
	});

	test("an absent and a present-but-empty key are the same scope, so two of them agree", () => {
		expect(
			outOfSyncMessage([
				absentView("claude-code"),
				emptyView("cursor", "globs"),
			]),
		).toBeUndefined();
	});

	test("a present-but-empty key names itself when it is the odd one out", () => {
		expect(
			outOfSyncMessage([
				emptyView("claude-code", "paths"),
				patternsView("cursor", "globs", ["a/**"]),
			]),
		).toBe(
			outOfSync(
				'claude-code: unscoped ("paths" is empty); cursor: "globs" = a/**',
			),
		);
	});

	test("an absent and an empty view share a group, described by the first of the two", () => {
		// The one place two members of a single group can describe themselves differently. The
		// group is real (they ARE the same scope), so it prints once, using the scope of its
		// lexicographically-first dialect — `claude-code`'s, here, whichever order they arrive in.
		const absent = absentView("claude-code");
		const empty = emptyView("cursor", "globs");
		const scoped = patternsView("copilot", "applyTo", ["a/**"]);
		const expected = outOfSync(
			`claude-code, cursor: ${UNSCOPED}; copilot: "applyTo" = a/**`,
		);

		expect(outOfSyncMessage([absent, empty, scoped])).toBe(expected);
		expect(outOfSyncMessage([empty, scoped, absent])).toBe(expected);
	});

	test("dialects that agree are named together in one group", () => {
		// Three dialects, two scopes: the two that agree share a group, and the group prints its
		// ids sorted and comma-joined.
		expect(
			outOfSyncMessage([
				patternsView("cursor", "globs", ["a/**"]),
				patternsView("claude-code", "paths", ["a/**"]),
				patternsView("copilot", "applyTo", ["b/**"]),
			]),
		).toBe(
			outOfSync(
				'claude-code, cursor: "paths" = a/**; copilot: "applyTo" = b/**',
			),
		);
	});

	test("the rendering does not depend on the order the views arrive in", () => {
		const claude = patternsView("claude-code", "paths", ["a/**"]);
		const cursor = patternsView("cursor", "globs", ["a/**"]);
		const copilot = patternsView("copilot", "applyTo", ["b/**"]);
		const expected = outOfSync(
			'claude-code, cursor: "paths" = a/**; copilot: "applyTo" = b/**',
		);

		// Every permutation of the same three views renders byte-identically — including the
		// group's own description, which is pinned to the lexicographically-first dialect in the
		// group rather than to whichever view happened to arrive first. `cursor` before
		// `claude-code` is the permutation that catches the latter.
		expect(outOfSyncMessage([claude, cursor, copilot])).toBe(expected);
		expect(outOfSyncMessage([cursor, claude, copilot])).toBe(expected);
		expect(outOfSyncMessage([copilot, cursor, claude])).toBe(expected);
	});

	test("a single view, or none at all, is never out of sync", () => {
		expect(outOfSyncMessage([])).toBeUndefined();
		expect(
			outOfSyncMessage([patternsView("cursor", "globs", ["a/**"])]),
		).toBeUndefined();
	});
});
