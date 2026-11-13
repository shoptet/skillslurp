import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ConfigError,
	freezeSurface,
	loadConfig,
	type ResolvedSurface,
	sealMap,
} from "../../config.js";
import type { RuleContext } from "../../context.js";
import {
	type DialectId,
	defaultInclude,
	type SurfaceKind,
} from "../../dialects.js";
import { parseSource } from "../../document.js";
import { runEngine } from "../../engine.js";
import { computeExitCode } from "../../exit.js";
import type { Report } from "../../rule.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { maxGlobShare } from "./max-glob-share.js";

/**
 * Four sections.
 *
 * **(A) `runRuleTests`, no git** — shapes the rule must answer WITHOUT asking git. `RuleTester`
 * does not git-init a `file` case, so a case that reached `ctx.git.trackedFiles()` would crash
 * rather than assert anything; that is what proves the no-glob guard.
 *
 * **(B) direct `check(doc, ctx)`** against a hand-built context whose `trackedFiles()` returns a
 * fixed list — the tracked list and `max` are the variables under test, so they are inputs.
 *
 * **(C) a real git checkout**, through the engine, because (B) cannot prove the list the rule asks
 * for is the real `git ls-files`.
 *
 * **(D) configuration** — the required option, and enabling the rule on one surface only.
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

const CC_SKILLS = surfaceOf("skills", ["claude-code"]);
const CURSOR_SKILLS = surfaceOf("skills", ["cursor"]);
const CC_RULES = surfaceOf("rules", ["claude-code"], ".claude/rules");
const BOTH_RULES = surfaceOf(
	"rules",
	["claude-code", "cursor"],
	".claude/rules",
);

/** Line 1 is the opening fence, so the first key is on line 2. */
const doc = (frontmatter: string): string =>
	`---\n${frontmatter}\n---\n\nBody.\n`;

interface CheckResult {
	readonly reports: readonly Report[];
	readonly trackedCalls: number;
}

async function checkWith(
	surface: ResolvedSurface,
	path: string,
	source: string,
	tracked: readonly string[],
	max: number,
): Promise<CheckResult> {
	const document = parseSource(path, `/nowhere/${path}`, source, surface);
	let trackedCalls = 0;
	const unused = (name: string) => (): never => {
		throw new Error(`ctx.${name} is not part of this rule's contract`);
	};
	const ctx: RuleContext<{ max: number }> = {
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
		isIgnored: unused("isIgnored"),
		options: { max },
		surface,
	};
	return {
		reports: await maxGlobShare.check(document, ctx),
		trackedCalls,
	};
}

const messagesOf = (result: CheckResult): string[] =>
	result.reports.map((r) => r.message);

/** `hits` paths under `docs/` followed by `total - hits` paths elsewhere; `docs/**` matches the first group only. */
const spread = (total: number, hits: number): string[] => [
	...Array.from({ length: hits }, (_, i) => `docs/m${i}.md`),
	...Array.from({ length: total - hits }, (_, i) => `other/o${i}.txt`),
];

const over = (
	pattern: string,
	keys: readonly string[],
	count: number,
	total: number,
	share: string,
	max: number,
): string =>
	`Activation glob "${pattern}" (frontmatter ${keys.length === 1 ? "key" : "keys"} ${keys.map((k) => `"${k}"`).join(", ")}) matches ${count} of ${total} tracked files (${share}%), more than the limit of ${max}%`;

// ---------------------------------------------------------------------------------------------
// (A) through the engine — every case here must answer without asking git
// ---------------------------------------------------------------------------------------------

runRuleTests(maxGlobShare, {
	valid: [
		{
			name: "a skill with no activation key declares no glob, so git is never asked",
			options: { max: 5 },
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "an empty list declares no glob",
			options: { max: 5 },
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\npaths: []\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "a value that is neither a string nor a list declares no glob",
			options: { max: 5 },
			files: {
				"widgets/SKILL.md":
					"---\nname: widgets\ndescription: A fixture skill.\nglobs: {}\n---\n\nBody.\n",
			},
			surface: { kind: "skills", dialects: ["cursor"] },
		},
		{
			name: "a document whose only pattern is negated declares no glob",
			options: { max: 5 },
			files: {
				"widgets/SKILL.md":
					'---\nname: widgets\ndescription: A fixture skill.\npaths: "!**/*.test.ts"\n---\n\nBody.\n',
			},
			surface: { kind: "skills", dialects: ["claude-code"] },
		},
		{
			name: "a dialect with no activation key contributes no keys to read",
			options: { max: 5 },
			files: {
				"widgets/SKILL.md":
					'---\nname: widgets\ndescription: A fixture skill.\npaths: "**"\n---\n\nBody.\n',
			},
			surface: { kind: "skills", dialects: ["generic"] },
		},
	],
	invalid: [],
});

// ---------------------------------------------------------------------------------------------
// (B) the tracked list and the limit as inputs
// ---------------------------------------------------------------------------------------------

describe("max-glob-share: the limit", () => {
	test("exactly at the limit is not over it, one file more is, and the message carries the count, the total, the share and the limit", async () => {
		const at = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(20, 1),
			5,
		);
		expect(messagesOf(at)).toEqual([]);

		const above = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(20, 2),
			5,
		);
		expect(above.reports).toEqual([
			{
				message:
					'Activation glob "docs/**" (frontmatter key "paths") matches 2 of 20 tracked files (10.0%), more than the limit of 5%',
				loc: { line: 2, col: 8, endLine: 2, endCol: 17 },
			},
		]);
	});

	test("a decimal limit is compared and rendered as written", async () => {
		const at = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(200, 5),
			2.5,
		);
		expect(messagesOf(at)).toEqual([]);

		const above = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(200, 6),
			2.5,
		);
		expect(messagesOf(above)).toEqual([
			over("docs/**", ["paths"], 6, 200, "3.0", 2.5),
		]);
	});

	test("a decimal limit that the float product misses by one ulp is still exactly at the limit", async () => {
		// 4.56 * 1250 is 5699.999999999999 in floating point, while 57 of 1250 is exactly 4.56%.
		const at = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(1250, 57),
			4.56,
		);
		expect(messagesOf(at)).toEqual([]);

		const above = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(1250, 58),
			4.56,
		);
		expect(messagesOf(above)).toEqual([
			over("docs/**", ["paths"], 58, 1250, "4.6", 4.56),
		]);
	});

	test("a share just over the limit renders with one decimal, so it can read as the limit itself", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**"'),
			spread(1250, 63),
			5,
		);
		expect(messagesOf(result)).toEqual([
			over("docs/**", ["paths"], 63, 1250, "5.0", 5),
		]);
	});

	test("the denominator is every tracked file, not the files under the surface root", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "**"'),
			[".claude/rules/a.md", "src/a.ts", "src/b.ts", "README.md"],
			99,
		);
		expect(messagesOf(result)).toEqual([
			over("**", ["paths"], 4, 4, "100.0", 99),
		]);
		expect(result.trackedCalls).toBe(1);
	});

	test("a pattern under the limit, and one over it, are judged separately", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc("paths:\n  - src/**\n  - docs/**"),
			[...spread(10, 4), "src/a.ts"],
			20,
		);
		expect(messagesOf(result)).toEqual([
			over("docs/**", ["paths"], 4, 11, "36.4", 20),
		]);
	});
});

describe("max-glob-share: what is counted", () => {
	test("a slash-less pattern is root-only: *.md counts a.md and not x/a.md", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "*.md"'),
			["a.md", "x/a.md"],
			40,
		);
		expect(messagesOf(result)).toEqual([
			over("*.md", ["paths"], 1, 2, "50.0", 40),
		]);
	});

	test("dotfiles and dot directories are counted", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "**/*.md"'),
			[".claude/rules/a.md", ".hidden.md", "docs/b.md", "src/c.ts"],
			50,
		);
		expect(messagesOf(result)).toEqual([
			over("**/*.md", ["paths"], 3, 4, "75.0", 50),
		]);
	});

	test("a negated pattern is skipped, not counted", async () => {
		// Counted, `!**/*.ts` would match the two markdown files: 66.7%, over the limit of 50.
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: ["!**/*.ts", "src/**"]'),
			["docs/a.md", "docs/b.md", "src/a.ts"],
			50,
		);
		expect(messagesOf(result)).toEqual([]);
		expect(result.trackedCalls).toBe(1);
	});

	test("a dead pattern is not this rule's finding", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "gone/**"'),
			["src/a.ts", "src/b.ts"],
			1,
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("an empty tracked list reports nothing and divides by nothing", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "**"'),
			[],
			5,
		);
		expect(messagesOf(result)).toEqual([]);
	});

	test("a cursor skill's legacy globs key is read like paths", async () => {
		const result = await checkWith(
			CURSOR_SKILLS,
			"widgets/SKILL.md",
			doc('globs: "**"'),
			["src/a.ts", "src/b.ts"],
			50,
		);
		expect(messagesOf(result)).toEqual([
			over("**", ["globs"], 2, 2, "100.0", 50),
		]);
	});

	test("a skill's paths is counted against the same list", async () => {
		const result = await checkWith(
			CC_SKILLS,
			"widgets/SKILL.md",
			doc('paths: "docs/**"'),
			spread(10, 6),
			50,
		);
		expect(messagesOf(result)).toEqual([
			over("docs/**", ["paths"], 6, 10, "60.0", 50),
		]);
	});
});

describe("max-glob-share: one report per pattern", () => {
	const RULE = ".claude/rules/frontend/ts.md";

	test("a pattern under both keys is one report naming both, in document order, on the first key's item", async () => {
		const result = await checkWith(
			BOTH_RULES,
			RULE,
			doc('globs: "**"\npaths:\n  - "**"'),
			["src/a.ts", "src/b.ts"],
			50,
		);
		expect(result.reports).toEqual([
			{
				message: over("**", ["globs", "paths"], 2, 2, "100.0", 50),
				loc: { line: 2, col: 8, endLine: 2, endCol: 12 },
			},
		]);
		expect(result.trackedCalls).toBe(1);
	});

	test("reports follow keys in document order and sort each key's patterns, on an unsorted fixture", async () => {
		// `globs` first, and its patterns written in reverse; `zz/**` is repeated under `paths`,
		// which also lists `aa/**` before it. Any other order is a different answer than this.
		const result = await checkWith(
			BOTH_RULES,
			RULE,
			doc('globs: "zz/**, mm/**"\npaths:\n  - zz/**\n  - aa/**'),
			["aa/1", "mm/1", "zz/1"],
			10,
		);
		expect(messagesOf(result)).toEqual([
			over("mm/**", ["globs"], 1, 3, "33.3", 10),
			over("zz/**", ["globs", "paths"], 1, 3, "33.3", 10),
			over("aa/**", ["paths"], 1, 3, "33.3", 10),
		]);
	});

	test("a comma-separated scalar is blamed on the scalar, one report per piece", async () => {
		const result = await checkWith(
			CC_RULES,
			".claude/rules/a.md",
			doc('paths: "docs/**, other/**"'),
			spread(4, 2),
			10,
		);
		expect(result.reports).toEqual([
			{
				message: over("docs/**", ["paths"], 2, 4, "50.0", 10),
				loc: { line: 2, col: 8, endLine: 2, endCol: 27 },
			},
			{
				message: over("other/**", ["paths"], 2, 4, "50.0", 10),
				loc: { line: 2, col: 8, endLine: 2, endCol: 27 },
			},
		]);
	});
});

// ---------------------------------------------------------------------------------------------
// (C) a real git checkout, through the engine
// ---------------------------------------------------------------------------------------------

runRuleTests(maxGlobShare, {
	needsGit: true,
	valid: [
		{
			name: "an untracked file does not enter the denominator or the count",
			options: { max: 40 },
			surface: {
				kind: "rules",
				dialects: ["claude-code"],
				root: ".claude/rules",
			},
			files: {
				".claude/rules/a.md": doc('paths: "docs/**"'),
				"docs/a.md": "# A\n",
				"src/a.ts": "a\n",
				"src/b.ts": "b\n",
			},
			// Tracked: a.md, docs/a.md, src/a.ts, src/b.ts, so `docs/**` is 1 of 4. With the
			// two untracked files counted it would be 3 of 6, which is over 40.
			worktree: { files: { "docs/b.md": "# B\n", "docs/c.md": "# C\n" } },
		},
	],
	invalid: [
		{
			name: "a broad glob is a warning by default, positioned on the pattern",
			options: { max: 40 },
			surface: {
				kind: "rules",
				dialects: ["claude-code"],
				root: ".claude/rules",
			},
			files: {
				".claude/rules/a.md": doc("paths:\n  - src/**"),
				"src/a.ts": "a\n",
				"src/b.ts": "b\n",
				"README.md": "# Readme\n",
			},
			errors: [
				{
					message: over("src/**", ["paths"], 2, 4, "50.0", 40),
					line: 3,
					col: 5,
					endLine: 3,
					endCol: 11,
					severity: "warn",
				},
			],
		},
	],
});

// ---------------------------------------------------------------------------------------------
// (D) configuration
// ---------------------------------------------------------------------------------------------

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-max-glob-share-")),
	);
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function configProblems(rules: string): Promise<ConfigError["problems"]> {
	return await withDir(async (dir) => {
		await writeFile(
			join(dir, "skillslurp.json"),
			`{"surfaces":[{"root":".claude/rules","kind":"rules","dialects":["claude-code"]}],"rules":${rules}}\n`,
			"utf8",
		);
		try {
			await loadConfig(dir, [maxGlobShare]);
		} catch (err) {
			if (err instanceof ConfigError) {
				return err.problems;
			}
			throw err;
		}
		throw new Error("expected loadConfig to reject with a ConfigError");
	});
}

describe("max-glob-share options", () => {
	const RULE_ID = "activation/max-glob-share";
	const at = (col: number, endCol: number) => ({
		line: 1,
		col,
		endLine: 1,
		endCol,
	});
	const withMax = (value: string): string =>
		`{"${RULE_ID}":{"options":{"max":${value}}}}`;
	const problem = (detail: string, loc: ReturnType<typeof at>) => ({
		message: `rule "${RULE_ID}" options.${detail}`,
		loc,
	});
	const MISSING = "max: Invalid input: expected number, received undefined";
	const TOO_SMALL = "max: Too small: expected number to be >0";
	const TOO_BIG = "max: Too big: expected number to be <100";

	test("a rule enabled without max is a positioned config error", async () => {
		expect(await configProblems(`{"${RULE_ID}":"warn"}`)).toEqual([
			problem(MISSING, at(119, 125)),
		]);
	});

	test("an options block without max is the same error", async () => {
		expect(await configProblems(`{"${RULE_ID}":{"options":{}}}`)).toEqual([
			problem(MISSING, at(130, 132)),
		]);
	});

	test("a rule set to off still needs its required option, like every rule with one", async () => {
		expect(await configProblems(`{"${RULE_ID}":"off"}`)).toEqual([
			problem(MISSING, at(119, 124)),
		]);
	});

	test("0 and 100 are refused, since neither is a usable share", async () => {
		expect(await configProblems(withMax("0"))).toEqual([
			problem(TOO_SMALL, at(137, 138)),
		]);
		expect(await configProblems(withMax("100"))).toEqual([
			problem(TOO_BIG, at(137, 140)),
		]);
	});

	test("a negative number, a number above 100 and a string are refused", async () => {
		expect(await configProblems(withMax("-1"))).toEqual([
			problem(TOO_SMALL, at(137, 139)),
		]);
		expect(await configProblems(withMax("150"))).toEqual([
			problem(TOO_BIG, at(137, 140)),
		]);
		expect(await configProblems(withMax('"5"'))).toEqual([
			problem(
				"max: Invalid input: expected number, received string",
				at(137, 140),
			),
		]);
	});

	test("an unknown option is refused", async () => {
		expect(
			await configProblems(`{"${RULE_ID}":{"options":{"max":5,"min":1}}}`),
		).toEqual([
			{
				message: `rule "${RULE_ID}" options: unrecognized key "min"`,
				loc: at(139, 144),
			},
		]);
	});

	test("a decimal inside the range is accepted as written", async () => {
		await withDir(async (dir) => {
			await writeFile(
				join(dir, "skillslurp.json"),
				`{"surfaces":[{"root":".claude/rules","kind":"rules","dialects":["claude-code"]}],"rules":${withMax("2.5")}}\n`,
				"utf8",
			);
			const config = await loadConfig(dir, [maxGlobShare]);
			expect(config.ruleOptions.get(RULE_ID)).toEqual({ max: 2.5 });
		});
	});
});

describe("max-glob-share per surface", () => {
	test("enabled on a rules surface and absent on a skills surface, only the rules document is reported", async () => {
		await withDir(async (dir) => {
			const write = async (rel: string, content: string): Promise<void> => {
				const abs = join(dir, rel);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, content, "utf8");
			};
			await write(
				"skillslurp.json",
				JSON.stringify({
					version: 1,
					extends: [],
					surfaces: [
						{
							root: ".claude/skills",
							kind: "skills",
							dialects: ["claude-code"],
						},
						{
							root: ".claude/rules",
							kind: "rules",
							dialects: ["claude-code"],
							rules: {
								"activation/max-glob-share": {
									severity: "warn",
									options: { max: 50 },
								},
							},
						},
					],
				}),
			);
			await write(
				".claude/skills/widgets/SKILL.md",
				doc('name: widgets\ndescription: A fixture skill.\npaths: "**"'),
			);
			await write(".claude/rules/broad.md", doc('paths: "**"'));
			await gitInitAndCommit(dir);

			const config = await loadConfig(dir, [maxGlobShare]);
			const { diagnostics } = await runEngine(config, [maxGlobShare]);

			expect(
				diagnostics.map((d) => [d.ruleId, d.severity, d.file, d.line, d.col]),
			).toEqual([
				["activation/max-glob-share", "warn", ".claude/rules/broad.md", 2, 8],
			]);
			expect(computeExitCode(diagnostics)).toBe(0);
		});
	});
});

describe("max-glob-share meta", () => {
	test("is opt-in, a warning, a file rule with a required max, and claims no fix", () => {
		expect(maxGlobShare.meta.id).toBe("activation/max-glob-share");
		expect(maxGlobShare.meta.tiers).toEqual([]);
		expect(maxGlobShare.meta.defaultSeverity).toBe("warn");
		expect(maxGlobShare.meta.fixable).toBe(false);
		expect(maxGlobShare.kind).toBe("file");
		expect(maxGlobShare.meta.optionsSchema?.safeParse({}).success).toBe(false);
	});
});
