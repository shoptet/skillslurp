import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freezeSurface, type ResolvedSurface, sealMap } from "../../config.js";
import { createCapabilities, type RuleContext } from "../../context.js";
import {
	type DialectId,
	defaultInclude,
	type SurfaceKind,
} from "../../dialects.js";
import { parseSource } from "../../document.js";
import type { Report } from "../../rule.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { noUnmatchedGlobs } from "./no-unmatched-globs.js";

/**
 * Three sections, each covering what the other two cannot.
 *
 * **(A) `runRuleTests`** — the engine end to end, but ONLY for cases where the rule declares no
 * glob to check. `RuleTester` git-inits a `project`/`scan` case's temp dir and deliberately does
 * not for a `file` case (`runCase`'s own comment), and this is a `file` rule that reads
 * `ctx.git.trackedFiles()` — so any case here that reached the git call would crash with "is not
 * a git checkout" rather than assert anything. That constraint is exactly what makes these cases
 * worth having: each of them is a shape the rule must answer WITHOUT asking git, and the harness
 * is the thing that proves it did not ask. Delete the `globs.length === 0` guard in the rule and
 * every case in this section fails.
 *
 * **(B) direct `check(doc, ctx)`** against a hand-built context whose `trackedFiles()` returns a
 * fixed list — the same shape `links/resolve.test.ts` and `index/*.test.ts` already use. This is
 * where the tracked list is the variable under test, so it has to be an input rather than
 * whatever a temp repo happens to contain, and where exact positions and messages are pinned.
 *
 * **(C) one ephemeral git repo**, because (B) can only prove the rule handles a list it is given,
 * never that the list it asks for is the real `git ls-files`. It also settles "no filesystem
 * access" in the one way a stub cannot: it feeds the rule an ABSOLUTE glob pointing at a file
 * that exists, and is tracked, and the rule still has to call it dead.
 */

const surfaceOf = (
	kind: SurfaceKind,
	dialects: readonly DialectId[],
	root = ".",
): ResolvedSurface =>
	freezeSurface({
		root,
		kind,
		dialects,
		include: defaultInclude(kind, dialects),
		ignore: [],
		spokes: [],
		rules: sealMap(new Map()),
	});

/** `paths` primary, no legacy fallback. */
const CC_SKILLS = surfaceOf("skills", ["claude-code"]);
/** `paths` primary WITH the legacy `globs` fallback — the only built-in that has one. */
const CURSOR_SKILLS = surfaceOf("skills", ["cursor"]);
/** `globs`, comma-scalar, on a surface whose root is not the repo root. */
const CURSOR_RULES = surfaceOf("rules", ["cursor"], ".cursor/rules");
/** `paths`, the only key a Claude Code rule reads, on a surface that is not at the repo root. */
const CC_RULES = surfaceOf("rules", ["claude-code"], ".claude/rules");
/** Both rules formats on one surface: `paths` for Claude Code, `globs` for Cursor. */
const BOTH_RULES = surfaceOf(
	"rules",
	["claude-code", "cursor"],
	".claude/rules",
);
/** `applyTo`, comma-scalar. */
const COPILOT_INSTRUCTIONS = surfaceOf("instructions", ["copilot"]);
/** No activation key in any contract — nothing for this rule to read. */
const GENERIC_SKILLS = surfaceOf("skills", ["generic"]);

/**
 * A document whose frontmatter is exactly `frontmatter`. Line 1 is the opening fence, so the
 * first key is on line 2 — every position asserted below counts from there.
 */
const doc = (frontmatter: string): string =>
	`---\n${frontmatter}\n---\n\nBody.\n`;

interface CheckResult {
	// `Report`, not `RuleReport`: `check`'s return type was widened. This rule only ever
	// produces `RuleReport`s — it has no options to be wrong about — but the annotation follows
	// the contract rather than the current behaviour.
	readonly reports: readonly Report[];
	/** how many times the rule asked for the tracked list */
	readonly trackedCalls: number;
}

/**
 * Runs the rule against a hand-built context. `tracked` is the whole universe the rule gets to
 * match against; nothing else about the returned context is usable, and every other capability
 * throws rather than returning a plausible empty answer — a rule that started calling `grep` or
 * `diff` should fail loudly here, not quietly pass.
 */
async function checkWith(
	surface: ResolvedSurface,
	path: string,
	source: string,
	tracked: readonly string[],
): Promise<CheckResult> {
	const document = parseSource(path, `/nowhere/${path}`, source, surface);
	let trackedCalls = 0;
	const unused = (name: string) => (): never => {
		throw new Error(`ctx.${name} is not part of this rule's contract`);
	};
	const ctx: RuleContext = {
		root: "/nowhere",
		documents: async () => [document],
		git: {
			trackedFiles: async () => {
				trackedCalls += 1;
				return tracked;
			},
			trackedFileIndex: unused("git.trackedFileIndex"),
			trackedModes: unused("git.trackedModes"),
			diff: unused("git.diff"),
		},
		grep: unused("grep"),
		// Throws rather than answering `false`: a live glob may match only ignored files, by
		// decision — the agent tool reading the glob knows nothing of skillslurp's `ignore` — so
		// this rule's `trackedFiles()` read stays unfiltered, and the day someone revisits that,
		// this test must say so instead of quietly passing.
		isIgnored: unused("isIgnored"),
		options: {},
		surface,
	};
	return {
		reports: await noUnmatchedGlobs.check(document, ctx),
		trackedCalls,
	};
}

const messagesOf = (result: CheckResult): string[] =>
	result.reports.map((r) => r.message);

const dead = (pattern: string, key: string): string =>
	`Activation glob "${pattern}" (frontmatter key "${key}") matches no file tracked by git`;

// ---------------------------------------------------------------------------------------------
// (A) through the engine — every case here must answer without asking git; see the file header
// ---------------------------------------------------------------------------------------------

runRuleTests(noUnmatchedGlobs, {
	valid: [
		{
			name: "a skill with no activation key at all",
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "an empty list is no activation scope, not a stale glob",
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\npaths: []\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "an empty comma-scalar is no activation scope either",
			files: {
				"widgets/SKILL.md":
					'---\nname: widgets\ndescription: A fixture skill.\npaths: " , "\n---\n\nBody.\n',
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "a value that is neither a string nor a list is skipped silently",
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\nglobs: {}\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["cursor"] },
		},
		{
			name: "a document whose only pattern is negated has nothing this rule can judge",
			files: {
				"widgets/SKILL.md":
					'---\nname: widgets\ndescription: A fixture skill.\npaths: "!**/*.test.ts"\n---\n\nBody.\n',
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "a dialect with no activation key contributes no keys to check",
			files: {
				// `paths` is a perfectly ordinary key name; on a `generic` surface no contract
				// reads it for activation, so this rule must not treat it as a glob list. (It is
				// an unknown key for `generic`, which is `skill/frontmatter-schema`'s business,
				// not this rule's — and that rule is not in this case's registry.)
				"widgets/SKILL.md":
					'---\nname: widgets\ndescription: A fixture skill.\npaths: "gone/**/*.md"\n---\n\nBody.\n',
			},
			surface: { kind: "skills", dialects: ["generic"] },
		},
	],
	invalid: [],
});

// ---------------------------------------------------------------------------------------------
// (B) the tracked list as an input
// ---------------------------------------------------------------------------------------------

describe("no-unmatched-globs: liveness against the tracked list", () => {
	test("happy path: both keys of a cursor skill match tracked files", async () => {
		const result = await checkWith(
			CURSOR_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "docs/**/*.md"\nglobs: "notes/**/*.md"'),
			["docs/a.md", "notes/b.md", "widgets/SKILL.md"],
		);
		expect(messagesOf(result)).toEqual([]);
		// One call for the whole document, not one per key or per pattern.
		expect(result.trackedCalls).toBe(1);
	});

	test("a renamed or deleted target leaves a glob that matches nothing", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "src/legacy/**"'),
			["src/current/a.ts", "widgets/SKILL.md"],
		);
		expect(messagesOf(result)).toEqual([dead("src/legacy/**", "paths")]);
	});

	test("a literal, non-glob value is live iff that exact tracked file exists", async () => {
		const live = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "README.md"'),
			["README.md"],
		);
		expect(messagesOf(live)).toEqual([]);

		// Same pattern, and a tracked path that merely CONTAINS it as a segment: a literal is
		// still a glob, anchored at the repo root, so this one is dead.
		const stale = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "README.md"'),
			["docs/README.md"],
		);
		expect(messagesOf(stale)).toEqual([dead("README.md", "paths")]);
	});

	test("a glob matching only files OUTSIDE the surface root is live", async () => {
		// The corrected decision, and the case that would have caught the original "must match a
		// tracked file under the surface root" wording: nothing under `.cursor/rules` matches
		// `src/**/*.ts`, and Cursor's own documented examples are workspace-root paths.
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc('globs: "src/**/*.ts"'),
			[".cursor/rules/x.mdc", "src/app/main.ts"],
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("a comma-scalar is split, and each piece is judged on its own", async () => {
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc('globs: "docs/**, src/**"'),
			["docs/a.md"],
		);
		expect(messagesOf(result)).toEqual([dead("src/**", "globs")]);
	});

	test("every piece of a comma-scalar is blamed on the scalar, there being no per-piece node", async () => {
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc('globs: "gone/**, also-gone/**"'),
			["docs/a.md"],
		);
		// Sorted, deduped patterns — so "also-gone/**" first, whatever order they were written
		// in — and both at the one position the scalar occupies.
		expect(result.reports).toEqual([
			{
				message: dead("also-gone/**", "globs"),
				loc: { line: 2, col: 8, endLine: 2, endCol: 31 },
			},
			{
				message: dead("gone/**", "globs"),
				loc: { line: 2, col: 8, endLine: 2, endCol: 31 },
			},
		]);
	});

	test("a real yaml list is blamed per item", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc("paths:\n  - docs/**/*.md\n  - gone/**/*.md\n  - also-gone/**/*.md"),
			["docs/a.md"],
		);
		expect(result.reports).toEqual([
			{
				message: dead("also-gone/**/*.md", "paths"),
				loc: { line: 5, col: 5, endLine: 5, endCol: 22 },
			},
			{
				message: dead("gone/**/*.md", "paths"),
				loc: { line: 4, col: 5, endLine: 4, endCol: 17 },
			},
		]);
	});

	test("a quoted list item padded with spaces is still matched back to its own node", async () => {
		// The patterns come back trimmed, the yaml item does not — so the item lookup has to trim
		// too or this report would fall back to blaming the whole list. A plain scalar can never
		// carry the padding; a quoted one can, which is why the fixture quotes it.
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths:\n  - docs/**/*.md\n  - " gone/** "'),
			["docs/a.md"],
		);
		expect(result.reports).toEqual([
			{
				message: dead("gone/**", "paths"),
				loc: { line: 4, col: 5, endLine: 4, endCol: 16 },
			},
		]);
	});

	test("a cursor skill carrying both paths and the legacy globs gets both lists checked", async () => {
		const result = await checkWith(
			CURSOR_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "gone/**/*.md"\nglobs: "also-gone/**/*.md"'),
			["docs/a.md"],
		);
		// Keys in document order (`paths` before `globs`), and the legacy key is reported by its
		// own name — this is the half `consistent-scope` deliberately never reads.
		expect(result.reports).toEqual([
			{
				message: dead("gone/**/*.md", "paths"),
				loc: { line: 2, col: 8, endLine: 2, endCol: 22 },
			},
			{
				message: dead("also-gone/**/*.md", "globs"),
				loc: { line: 3, col: 8, endLine: 3, endCol: 27 },
			},
		]);
	});

	test("blank list items contribute no pattern, and no crash", async () => {
		// `picomatch("")` throws `TypeError: Expected pattern to be a non-empty string` and this
		// rule carries no try/catch, so an empty pattern reaching the matcher would be a rule
		// crash rather than a wrong answer. Three independent filters stand in the way (see
		// `isLive`'s JSDoc), which is also why no SINGLE-line mutation makes this case fail:
		// removing all three at once does, and was measured to produce exactly that TypeError.
		// What this case pins on its own is the observable half — blanks yield no report.
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: ["", " ", "gone/**"]'),
			["docs/a.md"],
		);
		expect(messagesOf(result)).toEqual([dead("gone/**", "paths")]);
	});

	test("an absolute glob matches nothing in a root-relative list", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "/etc/passwd"'),
			["etc/passwd"],
		);
		expect(messagesOf(result)).toEqual([dead("/etc/passwd", "paths")]);
	});

	test("a '..'-escaping glob matches nothing either", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "../outside/*.md"'),
			["outside/a.md"],
		);
		expect(messagesOf(result)).toEqual([dead("../outside/*.md", "paths")]);
	});

	test("copilot's applyTo is read the same way, comma-split and all", async () => {
		const result = await checkWith(
			COPILOT_INSTRUCTIONS,
			".github/instructions/ts.instructions.md",
			doc('applyTo: "**/*.ts,**/*.jsx"'),
			["src/a.ts"],
		);
		expect(messagesOf(result)).toEqual([dead("**/*.jsx", "applyTo")]);
	});

	test("a dotted path is matched, which picomatch's own default would not do", async () => {
		// `dot: true` in the rule's matcher options. With picomatch's default this glob would
		// match nothing under `.claude/`, and every surface this linter checks lives under a dot
		// directory — so the default would report a false positive on the commonest input there
		// is.
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "**/*.md"'),
			[".claude/skills/widgets/SKILL.md"],
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("a negated pattern is skipped, and its siblings are still judged", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "!**/*.test.ts, gone/**"'),
			["src/a.ts"],
		);
		// `!**/*.test.ts` would be "live" under picomatch (a negation matches everything it does
		// not exclude), so a rule that treated it as an ordinary glob would silently bless it.
		expect(messagesOf(result)).toEqual([dead("gone/**", "paths")]);
	});

	test("a repeated glob is reported once, not once per spelling", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc("paths:\n  - gone/**\n  - gone/**"),
			["src/a.ts"],
		);
		expect(messagesOf(result)).toEqual([dead("gone/**", "paths")]);
	});

	test("a document with no frontmatter is not this rule's business", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			"Just a body.\n",
			[],
		);
		expect(messagesOf(result)).toEqual([]);
		expect(result.trackedCalls).toBe(0);
	});

	test("frontmatter that is not a mapping is skill/frontmatter-schema's business", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc("- just\n- a\n- list"),
			[],
		);
		expect(messagesOf(result)).toEqual([]);
		expect(result.trackedCalls).toBe(0);
	});

	test("a surface whose dialects declare no activation key never asks for the tracked list", async () => {
		const result = await checkWith(
			GENERIC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "gone/**"'),
			[],
		);
		expect(messagesOf(result)).toEqual([]);
		expect(result.trackedCalls).toBe(0);
	});
});

describe("no-unmatched-globs: Claude Code rules", () => {
	const TS_RULE = ".claude/rules/frontend/ts.md";

	test("a dead pattern in a paths list is reported per item, under the key paths", async () => {
		const result = await checkWith(
			CC_RULES,
			TS_RULE,
			doc("paths:\n  - src/**/*.ts\n  - src/**/*.dead"),
			["src/a.ts", TS_RULE],
		);
		expect(result.reports).toEqual([
			{
				message: dead("src/**/*.dead", "paths"),
				loc: { line: 4, col: 5, endLine: 4, endCol: 18 },
			},
		]);
	});

	test("a comma-separated paths string is split, and the dead piece is blamed on the scalar", async () => {
		const result = await checkWith(
			CC_RULES,
			TS_RULE,
			doc('paths: "src/**/*.ts, src/**/*.dead"'),
			["src/a.ts", TS_RULE],
		);
		expect(result.reports).toEqual([
			{
				message: dead("src/**/*.dead", "paths"),
				loc: { line: 2, col: 8, endLine: 2, endCol: 36 },
			},
		]);
	});

	test("a rule whose paths all match tracked files is silent", async () => {
		const result = await checkWith(
			CC_RULES,
			TS_RULE,
			doc("paths:\n  - src/**/*.ts\n  - frontend/**"),
			["src/a.ts", "frontend/app.ts"],
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("a dead pattern under paths alone is reported on a surface that also names cursor", async () => {
		const result = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('globs: "src/**/*.ts"\npaths:\n  - src/**/*.ts\n  - src/**/*.dead'),
			["src/a.ts", TS_RULE],
		);
		expect(result.reports).toEqual([
			{
				message: dead("src/**/*.dead", "paths"),
				loc: { line: 5, col: 5, endLine: 5, endCol: 18 },
			},
		]);
	});

	test("a dead pattern under globs alone is reported under globs, and both keys are read in document order", async () => {
		const globsOnly = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('paths: [src/**/*.ts]\nglobs: "src/**/*.dead"'),
			["src/a.ts", TS_RULE],
		);
		expect(messagesOf(globsOnly)).toEqual([dead("src/**/*.dead", "globs")]);

		const both = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('paths: [gone/**]\nglobs: "also-gone/**"'),
			["src/a.ts", TS_RULE],
		);
		expect(messagesOf(both)).toEqual([
			dead("gone/**", "paths"),
			dead("also-gone/**", "globs"),
		]);
	});

	// Claude Code reads `paths` only, so `globs` on this surface is an unknown key for the schema
	// rule to flag, not a list of globs this rule has any business judging.
	test("globs is not an activation key on a surface that names only claude-code", async () => {
		const result = await checkWith(CC_RULES, TS_RULE, doc('globs: "gone/**"'), [
			"src/a.ts",
		]);
		expect(messagesOf(result)).toEqual([]);
		expect(result.trackedCalls).toBe(0);
	});

	// The vendor's own pattern table row: "`*.md` | Markdown files in the project root".
	test("a project-root pattern is live iff a root file matches it", async () => {
		const live = await checkWith(
			CC_RULES,
			".claude/rules/style.md",
			doc('paths: "*.md"'),
			["README.md"],
		);
		expect(messagesOf(live)).toEqual([]);

		const stale = await checkWith(
			CC_RULES,
			".claude/rules/style.md",
			doc('paths: "*.md"'),
			["docs/guide.md"],
		);
		expect(messagesOf(stale)).toEqual([dead("*.md", "paths")]);
	});
});

describe("no-unmatched-globs: one report per dead pattern", () => {
	const TS_RULE = ".claude/rules/frontend/ts.md";
	const TRACKED = ["src/a.ts", TS_RULE];

	const deadUnder = (pattern: string, keys: readonly string[]): string =>
		`Activation glob "${pattern}" (frontmatter keys ${keys.map((k) => `"${k}"`).join(", ")}) matches no file tracked by git`;

	test("the same dead pattern under paths and globs is one report, naming both keys, on the earlier key's item", async () => {
		const result = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('paths:\n  - gone/**\nglobs: "gone/**"'),
			TRACKED,
		);
		expect(result.reports).toEqual([
			{
				message: deadUnder("gone/**", ["paths", "globs"]),
				loc: { line: 3, col: 5, endLine: 3, endCol: 12 },
			},
		]);
	});

	test("different dead patterns under the two keys are two reports, each naming its own key", async () => {
		const result = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('paths: [gone/**]\nglobs: "also-gone/**"'),
			TRACKED,
		);
		expect(result.reports).toEqual([
			{
				message: dead("gone/**", "paths"),
				loc: { line: 2, col: 9, endLine: 2, endCol: 16 },
			},
			{
				message: dead("also-gone/**", "globs"),
				loc: { line: 3, col: 8, endLine: 3, endCol: 22 },
			},
		]);
	});

	test("a cursor skill whose legacy globs repeats a dead paths pattern is one report", async () => {
		const result = await checkWith(
			CURSOR_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "gone/**"\nglobs: "gone/**"'),
			["docs/a.md"],
		);
		expect(result.reports).toEqual([
			{
				message: deadUnder("gone/**", ["paths", "globs"]),
				loc: { line: 2, col: 8, endLine: 2, endCol: 17 },
			},
		]);
	});

	test("reports follow first occurrence and keys are named in document order, not sorted", async () => {
		// `paths` before `globs`, and the pattern only `globs` carries sorts BEFORE the shared
		// one: sorting the patterns, or the key names, gives a different answer than this.
		const result = await checkWith(
			BOTH_RULES,
			TS_RULE,
			doc('paths: [zz/**]\nglobs: ["aa/**", "zz/**"]'),
			TRACKED,
		);
		expect(result.reports).toEqual([
			{
				message: deadUnder("zz/**", ["paths", "globs"]),
				loc: { line: 2, col: 9, endLine: 2, endCol: 14 },
			},
			{
				message: dead("aa/**", "globs"),
				loc: { line: 3, col: 9, endLine: 3, endCol: 16 },
			},
		]);
	});

	test("a pattern under one key keeps the singular wording byte for byte", async () => {
		const paths = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "src/legacy/**"'),
			["src/current/a.ts"],
		);
		expect(messagesOf(paths)).toEqual([
			'Activation glob "src/legacy/**" (frontmatter key "paths") matches no file tracked by git',
		]);

		const globs = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc('globs: "src/legacy/**"'),
			["src/current/a.ts"],
		);
		expect(messagesOf(globs)).toEqual([
			'Activation glob "src/legacy/**" (frontmatter key "globs") matches no file tracked by git',
		]);
	});
});

describe("no-unmatched-globs: braces in a comma-separated scalar", () => {
	test("a brace group is one pattern, live when it matches a tracked file", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc("paths: src/*.{ts,tsx}"),
			["src/a.ts"],
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("a dead brace group is one report naming the whole pattern", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc("paths: src/*.{md,txt}"),
			["src/a.ts"],
		);
		expect(result.reports).toEqual([
			{
				message: dead("src/*.{md,txt}", "paths"),
				loc: { line: 2, col: 8, endLine: 2, endCol: 22 },
			},
		]);
	});

	test("a brace group inside a pattern leaves the commas around it as separators", async () => {
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc("globs: a/{b,c}/*.ts, d.ts"),
			["docs/a.md"],
		);
		expect(messagesOf(result)).toEqual([
			dead("a/{b,c}/*.ts", "globs"),
			dead("d.ts", "globs"),
		]);
	});

	test("nested groups stay one pattern", async () => {
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc("globs: src/{a,{b,c},d}/x.ts"),
			["src/d/x.ts"],
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("an unclosed brace splits at its comma, as a scalar without braces does", async () => {
		const result = await checkWith(
			CURSOR_RULES,
			".cursor/rules/x.mdc",
			doc("globs: src/{a,b"),
			["docs/a.md"],
		);
		expect(messagesOf(result)).toEqual([
			dead("b", "globs"),
			dead("src/{a", "globs"),
		]);
	});
});

// ---------------------------------------------------------------------------------------------
// (C) against a real, ephemeral checkout
// ---------------------------------------------------------------------------------------------

describe("no-unmatched-globs: against a real git checkout", () => {
	test("the universe is git's tracked list — an untracked file does not make a glob live, and an absolute glob is dead even when it names a tracked file", async () => {
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-globs-live-")),
		);
		try {
			const write = async (rel: string, content: string): Promise<void> => {
				const abs = join(dir, rel);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, content, "utf8");
			};

			await write("docs/tracked.md", "# Tracked\n");
			// The absolute spelling of a file that exists AND is tracked. Nothing in a
			// `git ls-files` listing starts with `/`, so the only way this could come back live
			// is if the rule consulted the filesystem — which is the whole claim being tested.
			const absoluteGlob = join(dir, "docs", "tracked.md");
			const source = doc(
				`paths:\n  - docs/**/*.md\n  - notes/**/*.md\n  - "${absoluteGlob}"`,
			);
			await write("widgets/SKILL.md", source);
			await gitInitAndCommit(dir);

			// Written only AFTER the commit, so it is present on disk and absent from the index.
			await write("notes/untracked.md", "# Untracked\n");

			const document = parseSource(
				"widgets/SKILL.md",
				join(dir, "widgets", "SKILL.md"),
				source,
				CC_SKILLS,
			);
			const ctx: RuleContext = {
				...createCapabilities(dir, async () => [document]),
				options: {},
				surface: CC_SKILLS,
			};

			expect(
				(await noUnmatchedGlobs.check(document, ctx)).map((r) => r.message),
			).toEqual([dead(absoluteGlob, "paths"), dead("notes/**/*.md", "paths")]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("no-unmatched-globs meta", () => {
	test("is an error in both tiers, takes no options, and claims no fix", () => {
		expect(noUnmatchedGlobs.meta.id).toBe("activation/no-unmatched-globs");
		expect(noUnmatchedGlobs.meta.tiers).toEqual(["recommended", "strict"]);
		expect(noUnmatchedGlobs.meta.defaultSeverity).toBe("error");
		expect(noUnmatchedGlobs.meta.fixable).toBe(false);
		expect(noUnmatchedGlobs.meta.optionsSchema).toBeUndefined();
		expect(noUnmatchedGlobs.kind).toBe("file");
	});
});
