import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config.js";
import type { RepoRuleContext } from "../context.js";
import type { Severity } from "../diagnostic.js";
import { runGit } from "../git.js";
import type { FileRule, ProjectRule, ScanRule, ShapeRule } from "../rule.js";
import { frontmatterSchema } from "../rules/skill/frontmatter-schema.js";
import {
	gitInitAndCommit,
	type RuleTestCase,
	runCase,
	runRuleTests,
	spyOn,
} from "./rule-tester.js";

const STUB_DOCS_URL = "https://example.invalid/docs";

/** Awaits `promise`, returning the rejection's message (or `String(err)`); throws if it resolves. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected the promise to reject, but it resolved");
}

/** Sync counterpart of `rejectionMessage`, for a registration-time throw (e.g. `runRuleTests`'s own guards, which run before any `test(...)` callback). */
function thrownMessage(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected fn to throw, but it did not");
}

// --- Fixture rules, all under the `test/` namespace (`parse/` and `config/` are reserved). ---

/** Reports nothing, ever — the plainest possible "valid case should pass" fixture. */
const cleanRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/clean",
		description: "reports nothing, for RuleTester happy-path tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: () => [],
};

/** Reports exactly one fixed diagnostic, regardless of the document — for comparison tests. */
const reportRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/report-fixed",
		description:
			"reports one fixed diagnostic, for RuleTester comparison tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: () => [{ message: "always fails", loc: { line: 2, col: 3 } }],
};

const OptionsEchoSchema = z.strictObject({
	// The default lives on the FIELD, never on the schema as a whole — a case that writes no
	// `options` at all parses as `{}`, and only a field-level default fires for that.
	tag: z.string().default("fallback"),
});
type OptionsEcho = z.infer<typeof OptionsEchoSchema>;

/** Reports `ctx.options.tag` — proves a case's `options` blob reaches the rule, schema defaults included. */
const optionsRule: FileRule<OptionsEcho> = {
	kind: "file",
	meta: {
		id: "test/options-echo",
		description:
			"reports ctx.options.tag, for RuleTester options-plumbing tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsEchoSchema,
	},
	check: (_doc, ctx) => [{ message: `tag=${ctx.options.tag}` }],
};

/** Reports `doc.surface.kind`/`doc.surface.dialects` — proves the surface/dialect layer is real. */
const surfaceEchoRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/surface-echo",
		description:
			"reports doc.surface.kind and doc.surface.dialects, for RuleTester surface-plumbing tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: (doc) => [
		{
			message: `kind=${doc.surface.kind};dialects=${doc.surface.dialects.join(",")}`,
		},
	],
};

/** `warn` by default — proves severity defaulting from `meta.defaultSeverity`, and its override. */
const warnRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/warn-default",
		description:
			"warn-severity fixed diagnostic, for RuleTester severity-defaulting tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "warn",
		fixable: false,
	},
	check: () => [{ message: "warn message" }],
};

/** `meta.fixable: true` — proves the expected-side `fixable` default comes from `meta.fixable`, not a hardcoded `false`. */
const fixableRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/fixable-default",
		description:
			"fixable fixed diagnostic, for RuleTester fixable-defaulting tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: true,
	},
	check: () => [{ message: "fixable message" }],
};

/** Reports `doc.path` — proves multi-file cases discover and order documents deterministically. */
const pathEchoRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/path-echo",
		description: "reports doc.path, for RuleTester multi-file ordering tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: (doc) => [{ message: `doc=${doc.path}` }],
};

/**
 * Reports whichever part of `doc.surface` is NOT frozen — pins the fidelity claim that the
 * tester hands rules the same locked surface a real run does (config.ts `freezeSurface` +
 * `sealMap`), so a rule that mutates `doc.surface` cannot pass a rule test and then throw for a
 * user. Reports nothing when everything is locked, so a passing case IS the assertion.
 */
const surfaceFreezeRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/surface-freeze",
		description:
			"reports any unfrozen part of doc.surface, for RuleTester fidelity tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: (doc) => {
		const parts: [string, unknown][] = [
			["surface", doc.surface],
			["dialects", doc.surface.dialects],
			["include", doc.surface.include],
			["ignore", doc.surface.ignore],
			["rules", doc.surface.rules],
		];
		return parts
			.filter(([, value]) => !Object.isFrozen(value))
			.map(([name]) => ({ message: `not frozen: ${name}` }));
	},
};

/** Flags a literal "TODO" in the file body — used to demo `runRuleTests` itself, not just `runCase`. */
const noTodoRule: FileRule = {
	kind: "file",
	meta: {
		id: "test/no-todo",
		description:
			"flags a literal TODO in the file body, demoing runRuleTests end to end",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: (doc) =>
		doc.raw.includes("TODO")
			? [{ message: "file contains a TODO", loc: { line: 1, col: 1 } }]
			: [],
};

// Real yaml syntax error, byte-identical to test/fixtures/skills-repo's own broken-yaml fixture
// (see frontmatter-schema.test.ts's "integration" test) — reused rather than invented, so the
// exact message and loc are already known-good.
const BROKEN_FRONTMATTER = [
	"---",
	"name: [unclosed",
	"description: Frontmatter whose yaml is syntactically invalid.",
	"---",
	"",
	"Body.",
	"",
].join("\n");
const BROKEN_YAML_MESSAGE =
	"Flow sequence in block collection must be sufficiently indented and end with a ]";

describe("runCase: a valid case", () => {
	test("passes when the rule reports nothing", async () => {
		await runCase(
			cleanRule,
			{
				name: "clean skill",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[],
		);
	});
});

describe("runCase: an invalid case", () => {
	test("passes when message, line and col all match exactly", async () => {
		await runCase(
			reportRule,
			{
				name: "always fails",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[{ message: "always fails", line: 2, col: 3 }],
		);
	});

	test("an omitted file defaults to the sole discovered path in the NFC form the engine reports", async () => {
		await runCase(
			reportRule,
			{
				name: "always fails under an NFD directory",
				files: {
					[`${"cafe\u0301"}/SKILL.md`]:
						"---\nname: ok\ndescription: ok\n---\nBody.\n",
				},
			},
			[{ message: "always fails", line: 2, col: 3 }],
		);
	});

	test("a wrong message throws, and the failure names both the expected and the actual message", async () => {
		const message = await rejectionMessage(
			runCase(
				reportRule,
				{
					name: "wrong message",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
				},
				[{ message: "totally different message", line: 2, col: 3 }],
			),
		);

		expect(message).toContain("always fails");
		expect(message).toContain("totally different message");
	});

	test("a wrong line/col throws", async () => {
		const message = await rejectionMessage(
			runCase(
				reportRule,
				{
					name: "wrong loc",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
				},
				[{ message: "always fails", line: 99, col: 99 }],
			),
		);

		expect(message.length).toBeGreaterThan(0);
	});

	test("a missing expected diagnostic (the rule reports fewer than expected) throws, naming the one that never showed up", async () => {
		const message = await rejectionMessage(
			runCase(
				reportRule,
				{
					name: "expects one extra",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
				},
				[
					{ message: "always fails", line: 2, col: 3 },
					{ message: "never actually reported", line: 5, col: 1 },
				],
			),
		);

		expect(message).toContain("never actually reported");
	});

	test("an extra actual diagnostic (the rule reports more than expected) throws, naming it", async () => {
		const message = await rejectionMessage(
			runCase(
				reportRule,
				{
					name: "expects nothing",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
				},
				[],
			),
		);

		expect(message).toContain("always fails");
	});
});

describe("runCase: unsafe or empty 'files' maps are rejected before anything is written to disk", () => {
	test("an empty files map throws", async () => {
		const message = await rejectionMessage(
			runCase(cleanRule, { name: "empty files", files: {} }, []),
		);

		expect(message).toContain('"files" must not be empty');
	});

	test("an absolute files key throws", async () => {
		const message = await rejectionMessage(
			runCase(
				cleanRule,
				{ name: "absolute key", files: { "/etc/passwd": "nope" } },
				[],
			),
		);

		expect(message).toContain("must be a repo-relative path");
	});

	test("a files key escaping the temp dir via '..' throws", async () => {
		const message = await rejectionMessage(
			runCase(
				cleanRule,
				{ name: "escaping key", files: { "../outside.md": "nope" } },
				[],
			),
		);

		expect(message).toContain('escapes the temp dir via ".."');
	});
});

describe("runCase: a malformed (but not unsafe) 'files' key fails with a message naming it", () => {
	test("an empty files key (EISDIR: resolves to the temp dir itself) wraps the fs error with the rule id, case name and key", async () => {
		// "" passes `assertSafeFiles` (it is relative and does not escape via ".."), then fails
		// inside `writeFiles` itself with a bare EISDIR from node:fs — this pins that `writeFiles`
		// wraps that failure instead of letting a case author see just "EISDIR" with no indication
		// of which of possibly many `files` keys, in which case, of which rule, caused it.
		const message = await rejectionMessage(
			runCase(cleanRule, { name: "empty key", files: { "": "content\n" } }, []),
		);

		expect(message).toContain(cleanRule.meta.id);
		expect(message).toContain("empty key");
		expect(message).toContain('files key ""');
	});
});

describe("runCase: false-green guards", () => {
	test("a files map matching no include pattern throws the 'discovered no files' guard, not a silent pass", async () => {
		const message = await rejectionMessage(
			runCase(
				cleanRule,
				{
					// Wrong case: the default skills include is "**/SKILL.md", case-sensitive on
					// the CI filesystem (and realpath'd on darwin too, so this is not relying on
					// case-insensitivity to fail).
					name: "wrong filename",
					files: { "SKILLS.md": "---\nname: ok\ndescription: ok\n---\n" },
				},
				[],
			),
		);

		expect(message).toContain("discovered no files");
	});

	test("a document whose only content has a frontmatter parse error, and no companion clean document, throws the 'rule never ran' guard even though the parse-error diagnostic alone would otherwise satisfy the expectation", async () => {
		// Mutation-check note: `expected` below is deliberately the exact diagnostic the engine
		// DOES produce (the parse/frontmatter one) — so if the "rule never invoked" guard were
		// ever deleted, this case would silently start PASSING (actual === expected) instead of
		// throwing, which is exactly the false green the guard exists to prevent.
		const message = await rejectionMessage(
			runCase(
				cleanRule,
				{
					name: "only a broken document",
					files: { "SKILL.md": BROKEN_FRONTMATTER },
					expectParseErrors: true,
				},
				[
					{
						message: BROKEN_YAML_MESSAGE,
						line: 3,
						col: 1,
						endLine: 3,
						endCol: 2,
						ruleId: "parse/frontmatter",
						severity: "error",
						fixable: false,
					},
				],
			),
		);

		expect(message).toContain("was never invoked");
	});

	test("broken yaml frontmatter without expectParseErrors throws, naming the parse error", async () => {
		const message = await rejectionMessage(
			runCase(
				cleanRule,
				{
					name: "broken yaml, unflagged",
					files: { "SKILL.md": BROKEN_FRONTMATTER },
				},
				[],
			),
		);

		expect(message).toContain("parse/frontmatter");
	});

	test("broken yaml frontmatter WITH expectParseErrors makes the parse/frontmatter diagnostics assertable (a companion clean document keeps the rule itself invoked)", async () => {
		await runCase(
			cleanRule,
			{
				name: "broken yaml, flagged, with a clean companion",
				files: {
					"broken/SKILL.md": BROKEN_FRONTMATTER,
					"clean/SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n",
				},
				expectParseErrors: true,
			},
			[
				{
					message: BROKEN_YAML_MESSAGE,
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 2,
					file: "broken/SKILL.md",
					ruleId: "parse/frontmatter",
					severity: "error",
					fixable: false,
				},
			],
		);
	});
});

describe("runCase: options reach the rule", () => {
	test("no options blob written: the rule sees the schema field's own default", async () => {
		await runCase(
			optionsRule,
			{
				name: "no options",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
			},
			[{ message: "tag=fallback" }],
		);
	});

	test("an options blob written: the rule sees the case's own value", async () => {
		await runCase(
			optionsRule,
			{
				name: "custom options",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
				options: { tag: "custom" },
			},
			[{ message: "tag=custom" }],
		);
	});

	test("an options blob that violates the rule's schema throws, not passes", async () => {
		await expect(
			runCase(
				optionsRule,
				{
					name: "invalid options",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
					// `tag` must be a string; this fails OptionsEchoSchema.
					options: { tag: 123 },
				},
				[],
			),
		).rejects.toBeInstanceOf(ConfigError);
	});
});

describe("runCase: surface plumbing reaches the rule", () => {
	test("doc.surface.kind and doc.surface.dialects reflect the case's surface, not the tester's defaults", async () => {
		// `rules` is a real, checkable kind/dialect combination: `cursor` is the only built-in
		// dialect with a `rules` contract (src/dialects.ts's `dialectsSupportingKind`), unlike the
		// `kind: "rules", dialects: ["cursor", "copilot"]` this test used to write — `copilot`
		// defines no `rules` contract at all, so a real `loadConfig` would reject that surface at
		// exit 2 while the tester silently accepted it (see the "impossible surface" tests below).
		await runCase(
			surfaceEchoRule,
			{
				name: "custom surface",
				files: { "note.mdc": "No frontmatter needed for this rule.\n" },
				surface: { kind: "rules", dialects: ["cursor"] },
			},
			[{ message: "kind=rules;dialects=cursor" }],
		);
	});

	test("the surface a rule receives is frozen, exactly as it is in a real run", async () => {
		// Zero diagnostics means every part was frozen; drop `freezeSurface`/`sealMap` from
		// `buildSurface` and this case reports the parts that went mutable.
		await runCase(
			surfaceFreezeRule,
			{
				name: "frozen surface",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[],
		);
	});
});

describe("runCase: buildSurface rejects a surface a real config could never express", () => {
	test("a dialect with no contract for the surface's kind throws, naming the dialect and the supported list", async () => {
		// The exact combination this file's own showcase test used to write, before it was fixed
		// above: `copilot` has no `rules` contract (src/dialects.ts), so `loadConfig` would reject
		// this at exit 2 for a real user while the tester used to accept it silently.
		const message = await rejectionMessage(
			runCase(
				surfaceEchoRule,
				{
					name: "impossible dialect for this kind",
					files: { "note.mdc": "No frontmatter needed for this rule.\n" },
					surface: { kind: "rules", dialects: ["cursor", "copilot"] },
				},
				[],
			),
		);

		expect(message).toContain(
			'dialect "copilot" has no contract for surface kind "rules"',
		);
		expect(message).toContain("cursor");
	});

	test("an empty dialects list throws", async () => {
		const message = await rejectionMessage(
			runCase(
				surfaceEchoRule,
				{
					name: "empty dialects",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
					surface: { dialects: [] },
				},
				[],
			),
		);

		expect(message).toContain("surface.dialects must not be empty");
	});
});

describe("runCase: surface.root, surface.include and surface.ignore each reach discovery", () => {
	test("surface.root, when set on the case, scopes discovery to that subdirectory", async () => {
		// If `buildSurface` hardcoded `root` to "." (ignoring the case's own value), discovery
		// would glob from the temp dir's root instead of `sub/`, and — because the default skills
		// include (`**/SKILL.md`) is recursive — would still find BOTH files below, turning this
		// into an ambiguous two-document case instead of the single `sub/SKILL.md` this asserts.
		await runCase(
			pathEchoRule,
			{
				name: "custom root",
				files: {
					"sub/SKILL.md": "---\nname: sub\ndescription: sub\n---\n",
					"top/SKILL.md": "---\nname: top\ndescription: top\n---\n",
				},
				surface: { root: "sub" },
			},
			[{ message: "doc=sub/SKILL.md" }],
		);
	});

	test("surface.include, when set on the case, replaces the kind's default include", async () => {
		// If `buildSurface` hardcoded `include` to the default (ignoring the case's own value),
		// discovery would match "SKILL.md" instead of the custom pattern's file.
		await runCase(
			pathEchoRule,
			{
				name: "custom include",
				files: {
					"notes/custom.txt": "custom content\n",
					"SKILL.md": "---\nname: ok\ndescription: ok\n---\n",
				},
				surface: { include: ["**/*.txt"] },
			},
			[{ message: "doc=notes/custom.txt" }],
		);
	});

	// The default follows the case's dialects, as `loadConfig` resolves it for a written surface:
	// a `claude-code` rules case that fell back to the kind's Cursor `.mdc` default would discover
	// the wrong file, and the case would assert on a document a real config never selects.
	test("a rules case with no include gets its dialects' default: claude-code finds a nested .md and not a .mdc", async () => {
		await runCase(
			pathEchoRule,
			{
				name: "claude-code rules default include",
				files: {
					"frontend/x.md": "---\npaths: src/**\n---\n",
					"y.mdc": "---\nglobs: src/**\n---\n",
				},
				surface: { kind: "rules", dialects: ["claude-code"] },
			},
			[{ message: "doc=frontend/x.md" }],
		);
	});

	test("a rules case with no include: cursor finds the .mdc, and both dialects find both files", async () => {
		const files = {
			"frontend/x.md": "---\npaths: src/**\n---\n",
			"y.mdc": "---\nglobs: src/**\n---\n",
		};
		await runCase(
			pathEchoRule,
			{
				name: "cursor rules default include",
				files,
				surface: { kind: "rules", dialects: ["cursor"] },
			},
			[{ message: "doc=y.mdc" }],
		);
		await runCase(
			pathEchoRule,
			{
				name: "claude-code and cursor rules default include",
				files,
				surface: { kind: "rules", dialects: ["claude-code", "cursor"] },
			},
			[
				{ file: "frontend/x.md", message: "doc=frontend/x.md" },
				{ file: "y.mdc", message: "doc=y.mdc" },
			],
		);
	});

	test("surface.ignore, when set on the case, excludes matching files", async () => {
		// If `buildSurface` hardcoded `ignore` to `[]` (ignoring the case's own value), both files
		// would be discovered, turning this into an ambiguous two-document case instead of one.
		await runCase(
			pathEchoRule,
			{
				name: "custom ignore",
				files: {
					"SKILL.md": "---\nname: ok\ndescription: ok\n---\n",
					"excluded/SKILL.md":
						"---\nname: excluded\ndescription: excluded\n---\n",
				},
				surface: { ignore: ["excluded/**"] },
			},
			[{ message: "doc=SKILL.md" }],
		);
	});
});

describe("runCase: severity defaulting", () => {
	test("with no case override, the diagnostic carries the rule's own meta.defaultSeverity", async () => {
		// The expectation names "warn" explicitly rather than omitting `severity` (which would let
		// `normalizeExpected`'s own `?? resolvedSeverity` default paper over a `resolvedSeverity`
		// that was silently wrong on both the actual and expected side — see rule-tester.ts's
		// `ComparableDiagnostic` JSDoc on why the two sides must read independent sources).
		// Mutation check: hardcoding `resolvedSeverity` in `runCase` to `"error"` makes this fail
		// (actual "error" vs. the "warn" asserted here), confirmed and reverted.
		await runCase(
			warnRule,
			{
				name: "default severity",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
			},
			[{ message: "warn message", severity: "warn" }],
		);
	});

	test("an explicit case severity overrides meta.defaultSeverity", async () => {
		await runCase(
			warnRule,
			{
				name: "overridden severity",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
				severity: "error",
			},
			[{ message: "warn message", severity: "error" }],
		);
	});
});

describe("runCase: fixable defaulting", () => {
	test("with no expectation override, the diagnostic carries the rule's own meta.fixable", async () => {
		// `fixableRule.meta.fixable` is `true`; the expectation below omits `fixable` on purpose,
		// so the default `normalizeExpected` applies (`expected.fixable ?? ruleFixable`) is what is
		// under test. Mutation check: hardcoding that expected-side default to `false` makes this
		// fail (actual `true` vs. expected `false`), confirmed and reverted.
		await runCase(
			fixableRule,
			{
				name: "default fixable",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
			},
			[{ message: "fixable message" }],
		);
	});
});

describe("runCase: multi-file cases", () => {
	const TWO_SKILLS = {
		"a/SKILL.md": "---\nname: a\ndescription: a\n---\n",
		"b/SKILL.md": "---\nname: b\ndescription: b\n---\n",
	};

	test("an expectation omitting 'file' throws when more than one document was discovered", async () => {
		const message = await rejectionMessage(
			runCase(
				pathEchoRule,
				{ name: "two skills, ambiguous", files: TWO_SKILLS },
				[{ message: "doc=a/SKILL.md" }],
			),
		);

		expect(message).toContain("discovered 2 documents");
	});

	test("expectations naming both files pass, in the engine's sorted (file, then line/col) order", async () => {
		await runCase(
			pathEchoRule,
			{ name: "two skills, named", files: TWO_SKILLS },
			[
				{ message: "doc=a/SKILL.md", file: "a/SKILL.md" },
				{ message: "doc=b/SKILL.md", file: "b/SKILL.md" },
			],
		);
	});
});

describe("runCase: ResolvedConfig.ignore matches what a real run applies", () => {
	test("a node_modules/** fixture file is not linted, even though it matches surface.include", async () => {
		// `loadConfig` always merges `DEFAULT_IGNORE` in (config.ts); if `buildConfig` hardcoded
		// `ignore: []` instead of reusing that same constant, the file below would also be
		// discovered and this case would become an ambiguous two-document case instead of the one
		// document a real `skillslurp` run would ever see.
		await runCase(
			pathEchoRule,
			{
				name: "node_modules is always ignored",
				files: {
					"SKILL.md": "---\nname: ok\ndescription: ok\n---\n",
					"node_modules/pkg/SKILL.md":
						"---\nname: pkg\ndescription: pkg\n---\n",
				},
			},
			[{ message: "doc=SKILL.md" }],
		);
	});
});

describe("runRuleTests: registration-time errors", () => {
	test("throws when both valid and invalid are empty", () => {
		expect(() => runRuleTests(cleanRule, { valid: [], invalid: [] })).toThrow(
			/at least one valid or invalid case/,
		);
	});

	test("throws on a duplicate case name within one group", () => {
		expect(() =>
			runRuleTests(cleanRule, {
				valid: [
					{
						name: "dup",
						files: { "SKILL.md": "---\nname: a\ndescription: a\n---\n" },
					},
					{
						name: "dup",
						files: { "SKILL.md": "---\nname: b\ndescription: b\n---\n" },
					},
				],
				invalid: [],
			}),
		).toThrow(/duplicate valid case name "dup"/);
	});

	test("throws when an invalid case's errors list is empty", () => {
		expect(() =>
			runRuleTests(cleanRule, {
				valid: [],
				invalid: [
					{
						name: "asserts nothing",
						files: { "SKILL.md": "---\nname: a\ndescription: a\n---\n" },
						errors: [],
					},
				],
			}),
		).toThrow(/an invalid case's "errors" must not be empty/);
	});

	test("throws when every expectation in an invalid case names a different rule id than the rule under test", () => {
		expect(() =>
			runRuleTests(cleanRule, {
				valid: [],
				invalid: [
					{
						name: "wrong rule id",
						files: { "SKILL.md": "---\nname: a\ndescription: a\n---\n" },
						errors: [
							{ message: "some diagnostic", ruleId: "parse/frontmatter" },
						],
					},
				],
			}),
		).toThrow(/every expectation in "errors" names a different rule id/);
	});
});

// Exercises the public `describe`/`test` wrapper itself, not just `runCase` — registers real
// nested tests that `bun test` runs as part of this file.
runRuleTests(noTodoRule, {
	valid: [
		{
			name: "a file without TODO reports nothing",
			files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nAll done.\n" },
		},
	],
	invalid: [
		{
			name: "a file with a literal TODO is flagged",
			files: {
				"SKILL.md": "---\nname: ok\ndescription: ok\n---\nTODO: finish this.\n",
			},
			errors: [{ message: "file contains a TODO", line: 1, col: 1 }],
		},
	],
});

// The real `frontmatterSchema` rule (src/rules/skill/frontmatter-schema.ts), through
// `runCase`, reproducing a handful of frontmatter-schema.test.ts's own unit checks verbatim in
// message and loc.
describe("frontmatterSchema reproduced through runCase", () => {
	test("no frontmatter block at all", async () => {
		await runCase(
			frontmatterSchema,
			{
				name: "no frontmatter",
				files: { "SKILL.md": "# No frontmatter\n\nJust a body.\n" },
			},
			[{ message: "Missing YAML frontmatter block", line: 1, col: 1 }],
		);
	});

	test("frontmatter present but not a mapping", async () => {
		await runCase(
			frontmatterSchema,
			{ name: "empty block", files: { "SKILL.md": "---\n---\nBody\n" } },
			[
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 2,
					endCol: 4,
				},
			],
		);
	});

	test("a missing required key", async () => {
		await runCase(
			frontmatterSchema,
			{
				name: "missing description",
				files: { "SKILL.md": "---\nname: x\n---\n\nBody\n" },
			},
			[
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		);
	});

	test("an unknown key", async () => {
		await runCase(
			frontmatterSchema,
			{
				name: "unknown key",
				files: {
					"SKILL.md": "---\nname: x\ndescription: y\ntools: z\n---\n",
				},
			},
			[
				{
					message:
						'Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 6,
				},
			],
		);
	});
});

// --- RuleTester for ProjectRule/ScanRule. Fixture rules below, same `test/`
// namespace convention as the FileRule fixtures above. ---

/**
 * Reports one fixed diagnostic naming how many documents `ctx.documents()` finds on THIS
 * rule's own `ctx.surface` — proves a "project" rule reaches the real engine's second dispatch
 * loop, with `ctx.surface`/`ctx.documents()` both live, through `RuleTester`.
 */
const projectDocCountRule: ProjectRule = {
	kind: "project",
	meta: {
		id: "test/project-doc-count",
		description:
			"reports the number of documents on ctx.surface, for RuleTester project-kind tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: async (ctx) => {
		const docs = await ctx.documents();
		const mine = docs.filter((doc) => doc.surface === ctx.surface);
		return [
			{
				message: `project saw ${mine.length} document(s) on its surface`,
				file: "SKILL.md",
				loc: { line: 1, col: 1 },
			},
		];
	},
};

/**
 * Reports one diagnostic per `ctx.git.trackedFiles()` entry — proves a "scan" rule reaches the
 * real, materialized (`git init` + commit) temp repo `RuleTester` builds for a project/scan
 * case, not merely a directory `ctx.git` would fail against.
 */
const scanTrackedFilesRule: ScanRule = {
	kind: "scan",
	meta: {
		id: "test/scan-tracked-files",
		description:
			"reports one diagnostic per ctx.git.trackedFiles() entry, for RuleTester scan-kind tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: async (ctx) => {
		const tracked = await ctx.git.trackedFiles();
		return tracked.map((file) => ({ message: `tracked: ${file}`, file }));
	},
};

/**
 * Reports every `ctx.grep(/TODO/)` hit, position included — proves `ctx.grep` (built on the
 * same materialized repo's `ctx.git.trackedFiles()` corpus, context.ts's `buildCorpus`) reaches
 * a "scan" rule through `RuleTester`, distinct from `scanTrackedFilesRule` above which never
 * reads file contents.
 */
const scanTodoGrepRule: ScanRule = {
	kind: "scan",
	meta: {
		id: "test/scan-todo-grep",
		description:
			"reports every ctx.grep(/TODO/) hit, for RuleTester scan-kind tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: async (ctx) => {
		const hits = await ctx.grep(/TODO/);
		return hits.map((hit) => ({
			message: `dangling TODO: "${hit.text}"`,
			file: hit.file,
			loc: { line: hit.line, col: hit.col },
		}));
	},
};

/**
 * Flags a `.git` directory in the case's own temp root — for a `"file"` case this must never
 * fire, since `RuleTester`'s git-init-and-commit materialization step is gated on kind
 * and a `"file"` case gets no `.git` at all. A passing case IS the assertion, same idiom as
 * `test/surface-freeze` above.
 */
const fileRuleAssertingNoGit: FileRule = {
	kind: "file",
	meta: {
		id: "test/no-git-for-file-rule",
		description:
			"flags a .git directory in the case's temp root, for RuleTester's git-gating test",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: (_doc, ctx) =>
		existsSync(join(ctx.root, ".git"))
			? [
					{
						message:
							"unexpected .git directory: the git materialization step ran for a file-rule case",
					},
				]
			: [],
};

/**
 * A rule shaped exactly like `test/project-doc-count` above but tagged `kind: "bogus"` — a kind
 * `TestableRule<O>` (rule-tester.ts) excludes at the type level, so no type-checked caller can
 * construct this exact call; the `as unknown as ProjectRule` cast below exists ONLY to reach
 * `assertTestableKind`'s runtime guard for this test, mirroring a caller with no type checker
 * (or an existing `as`-cast bug elsewhere) rather than claiming this object is an honest
 * `ProjectRule`.
 */
const unknownKindRuleDisguisedAsProject = {
	kind: "bogus",
	meta: {
		id: "test/unknown-kind-disguised-as-project",
		description:
			"a bogus-kind rule wearing a project-shaped body, for the runtime-rejection test",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	},
	check: async () => [],
} as unknown as ProjectRule;

/**
 * Returns one `ConfigReport` and nothing else — a stub, in the same `test/` namespace
 * and the same "prove the mechanism end to end through the real engine" shape
 * `projectDocCountRule` above uses for dispatch.
 *
 * `meta.defaultSeverity` is `warn`, deliberately and load-bearingly: the diagnostic this
 * produces must come out `error` regardless (a config-shaped
 * problem is an error unconditionally), so a stub defaulting to `error` would let the assertion
 * pass without testing anything.
 */
const projectConfigReportRule: ProjectRule = {
	kind: "project",
	meta: {
		id: "test/project-config-report",
		description:
			"returns one ConfigReport, for the RuleTester config-shaped-report tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "warn",
		fixable: false,
	},
	check: async () => [
		{
			problem: "stale-allowlist",
			message: 'allowlist entry "skills/gone.md" matches nothing',
		},
	],
};

describe("a rule can report a config-shaped problem through the real engine", () => {
	test("a ConfigReport surfaces as config/<problem> at error, against the config file, not under the rule's own id or severity", async () => {
		await runCase(
			projectConfigReportRule,
			{
				name: "one config-shaped problem",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[
				{
					// Three engine-owned facts in one assertion, each of which fails on its own if
					// the mechanism regresses: the id is the engine's `config/` namespace and not
					// `test/project-config-report`; the severity is `error` where the rule's is
					// `warn`; the file is the config file and not the case's only document
					// (`SKILL.md`, which is what `ExpectedDiagnostic.file` would otherwise default
					// to here).
					ruleId: "config/stale-allowlist",
					severity: "error",
					message: 'allowlist entry "skills/gone.md" matches nothing',
					file: "skillslurp.json",
				},
			],
		);
	});
});

/**
 * The registration half of that claim, and it cannot be written as a `test(...)`: `runRuleTests`
 * calls `describe`, which bun rejects inside a running test ("Cannot call describe() inside a
 * test"). So it is registered at module scope, where a throw from its registration-time guard
 * (`assertInvalidCaseTargetsRule`) fails this file outright.
 *
 * What it guards: that guard rejects an invalid case whose every expectation names a rule id
 * other than the rule under test — and before it was widened, a `config/*`-only case was
 * exactly that shape. It is not a hypothetical: `index/complete`'s and `index/no-missing-targets`'s
 * "configured file is missing" cases (four each) expect nothing but a `config/missing-file`
 * diagnostic, and all eight failed registration with that error until the guard learned that a
 * `ConfigReport` is the rule under test's own output.
 */
runRuleTests(projectConfigReportRule, {
	valid: [],
	invalid: [
		{
			name: "a config-only expectation registers and passes",
			files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			errors: [
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message: 'allowlist entry "skills/gone.md" matches nothing',
					file: "skillslurp.json",
				},
			],
		},
	],
});

describe("a ProjectRule case asserts an exact diagnostic through the real engine", () => {
	test("ctx.documents()/ctx.surface reach a project rule's check, once per surface", async () => {
		await runCase(
			projectDocCountRule,
			{
				name: "one document on the surface",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[
				{
					message: "project saw 1 document(s) on its surface",
					file: "SKILL.md",
					line: 1,
					col: 1,
				},
			],
		);
	});
});

describe("a ScanRule case asserts an exact diagnostic through the real engine, against the case's materialized git repo", () => {
	test("ctx.git.trackedFiles() sees exactly the file this case wrote and committed", async () => {
		await runCase(
			scanTrackedFilesRule,
			{
				name: "one tracked file",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\nBody.\n" },
			},
			[{ message: "tracked: SKILL.md", file: "SKILL.md" }],
		);
	});

	test("ctx.grep() finds a dangling TODO, position included", async () => {
		// Mutation-check note: hardcoding `scanTodoGrepRule`'s pattern to something that never
		// matches (or skipping `gitInitAndCommit` for scan cases) makes this fail — confirmed
		// and reverted.
		await runCase(
			scanTodoGrepRule,
			{
				name: "one dangling TODO",
				files: {
					"SKILL.md":
						"---\nname: ok\ndescription: ok\n---\nTODO: finish this.\n",
				},
			},
			[
				{
					message: 'dangling TODO: "TODO"',
					file: "SKILL.md",
					line: 5,
					col: 1,
				},
			],
		);
	});
});

describe("a project/scan valid case genuinely runs the rule, not vacuously (a valid case passing because the rule never ran)", () => {
	test("a scan case with zero grep hits passes because the pattern truly does not match, not because the rule never ran", async () => {
		await runCase(
			scanTodoGrepRule,
			{
				name: "no TODOs anywhere",
				files: {
					"SKILL.md": "---\nname: ok\ndescription: ok\n---\nAll done.\n",
				},
			},
			[],
		);
	});
});

describe("a project/scan case that never gets a chance to invoke its rule still fails loudly", () => {
	test("a files map matching no include pattern throws the same 'discovered no files' guard a file-rule case gets, unaffected by the kind widening", async () => {
		const message = await rejectionMessage(
			runCase(
				projectDocCountRule,
				{
					name: "wrong filename",
					files: { "SKILLS.md": "---\nname: ok\ndescription: ok\n---\n" },
				},
				[],
			),
		);

		expect(message).toContain("discovered no files");
	});
});

describe("the git materialization step is gated on kind — a file-rule case gets no git step at all", () => {
	test("a file-rule case's temp dir has no .git directory", async () => {
		await runCase(
			fileRuleAssertingNoGit,
			{
				name: "no git for a file rule",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
			},
			[],
		);
	});
});

describe("needsGit overrides the kind gate, in both directions", () => {
	test("a file-rule case that asks for git gets a .git directory", async () => {
		// The other half of the case just above, and the reason that one is not vacuous: the
		// SAME rule, the SAME files, one added `needsGit: true` — and now the `.git` it looks for
		// is there. Without both halves, deleting the git step entirely would leave the gating
		// test green and nothing would notice.
		await runCase(
			fileRuleAssertingNoGit,
			{
				name: "git for a file rule that asks for it",
				files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
				needsGit: true,
			},
			[
				{
					message:
						"unexpected .git directory: the git materialization step ran for a file-rule case",
				},
			],
		);
	});

	test("a scan-rule case that opts OUT of git makes ctx.git fail with the engine's requirement sentence, not a rule crash", async () => {
		// Two things at once, and they belong together. `needsGit: false` on a `scan` case is the
		// only way to build "a rule that reads git, run against a directory that is not a
		// checkout" from inside this harness — and what comes back out is the engine's
		// handling (`gitCheckoutRequiredError`, engine.ts): the requirement, naming the path,
		// with no mention of the rule that happened to ask first.
		const message = await rejectionMessage(
			runCase(
				scanTrackedFilesRule,
				{
					name: "no git for a scan rule that asks to go without",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
					needsGit: false,
				},
				[],
			),
		);

		expect(message).toContain("is not a git checkout");
		expect(message).toContain(
			"skillslurp resolves link targets against git's index",
		);
		// The point of the whole checkout-required branch: NOT `rule "test/scan-tracked-files" crashed while
		// checking ...`. Both halves asserted, because "contains the requirement" alone would
		// still pass if the requirement were merely appended to a crash message.
		expect(message).not.toContain("crashed while checking");
		expect(message).not.toContain(scanTrackedFilesRule.meta.id);
	});
});

describe("an unknown rule kind is rejected at runtime, not just by the type", () => {
	test("runRuleTests throws for a disguised 'bogus' rule, naming both the kind and why", () => {
		const message = thrownMessage(() =>
			runRuleTests(unknownKindRuleDisguisedAsProject, {
				valid: [
					{
						name: "irrelevant — registration throws first",
						files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
					},
				],
				invalid: [],
			}),
		);

		expect(message).toContain(
			'RuleTester only supports "file", "project", "scan" and "shape" rules — "bogus" rules are not supported yet',
		);
	});

	test("runCase itself rejects the same disguised 'bogus' rule (defense in depth, not only runRuleTests's registration-time check)", async () => {
		const message = await rejectionMessage(
			runCase(
				unknownKindRuleDisguisedAsProject,
				{
					name: "irrelevant — runCase throws first",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
				},
				[],
			),
		);

		expect(message).toContain(
			'RuleTester only supports "file", "project", "scan" and "shape" rules — "bogus" rules are not supported yet',
		);
	});
});

describe("gitInitAndCommit refuses to write into the wrong repository", () => {
	test('aborts before "git add"/"git commit" when the temp dir\'s ".git" resolves to a different repository', async () => {
		// No environment-variable trick needed (git.ts's own env scrub already closes that
		// route): a `.git` that is a symlink into a completely different, unrelated
		// repository reproduces the identical shape of mistake — "the directory this call
		// believes it just initialized is not the one `git` actually operated on" — entirely
		// through the filesystem. `git init` on a directory whose `.git` already exists (even
		// as a symlink elsewhere) succeeds with a warning, not an error, so nothing before
		// `gitInitAndCommit`'s own check would ever notice.
		const victim = await mkdtemp(join(tmpdir(), "skillslurp-fa2-victim-"));
		const caseRoot = await mkdtemp(join(tmpdir(), "skillslurp-fa2-case-"));
		try {
			await runGit(victim, ["init", "--quiet", "-b", "main"]);
			await symlink(join(victim, ".git"), join(caseRoot, ".git"));

			const message = await rejectionMessage(gitInitAndCommit(caseRoot));
			expect(message).toContain(caseRoot);
			// `actualGitDir` in the thrown message is git's own CANONICALIZED path
			// (`--absolute-git-dir`'s documented behavior), so this compares against
			// `realpath(victim)`, not `victim` itself — on macOS, `mkdtemp` returns a path
			// under `/var`/`/tmp`, symlinks to `/private/var`/`/private/tmp`, so asserting the
			// unresolved form here would fail on exactly the platform this repo runs on by
			// default (same reasoning `runCase`'s own realpath call documents).
			expect(message).toContain(await realpath(victim));

			// The real proof: the victim repo never got a commit out of this — if
			// `gitInitAndCommit` had pressed on past the mismatch, "git add"/"git commit" would
			// have run against `victim`'s repository (through the symlink) and given it one.
			// An unborn-branch repo has no HEAD to resolve, so this itself throws; catching that
			// (rather than asserting `rejects`) is what proves "no commit landed", not just
			// "some error happened".
			await expect(runGit(victim, ["rev-parse", "HEAD"])).rejects.toThrow();
		} finally {
			await rm(victim, { recursive: true, force: true });
			await rm(caseRoot, { recursive: true, force: true });
		}
	});
});

describe('spyOn refuses to dispatch a rule whose kind is none of "file", "project", "scan" or "shape"', () => {
	test('spyOn itself rejects a disguised "bogus" rule, independent of runCase\'s own earlier guard', () => {
		// Drives `spyOn` directly, bypassing both `runRuleTests` and `runCase`'s own
		// `assertTestableKind` calls entirely — through either of those, `assertTestableKind`
		// already throws before `spyOn` is ever reached, so this is the only way to observe
		// `spyOn`'s OWN copy of that guard doing anything at all.
		const message = thrownMessage(() =>
			spyOn(unknownKindRuleDisguisedAsProject, [], { called: false }),
		);

		expect(message).toContain(
			'RuleTester only supports "file", "project", "scan" and "shape" rules — "bogus" rules are not supported yet',
		);
	});
});

// --- shape rules, symlinks, worktree ---

/** Like `rejectionMessage`, but hands back the error itself, for a test that reads `.cause`. */
async function rejectionError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof Error) {
			return err;
		}
		throw new Error(`expected an Error, got ${String(err)}`);
	}
	throw new Error("expected the promise to reject, but it resolved");
}

function shapeRule<O = unknown>(
	id: string,
	check: ShapeRule<O>["check"],
	optionsSchema?: z.ZodType<O>,
): ShapeRule<O> {
	const meta = {
		id,
		description: "a fake shape rule, for RuleTester shape-kind tests",
		docsUrl: STUB_DOCS_URL,
		tiers: ["recommended"],
		defaultSeverity: "error",
		fixable: false,
	} as const;
	return {
		kind: "shape",
		meta: optionsSchema === undefined ? meta : { ...meta, optionsSchema },
		check,
	};
}

/** Runs `probe` against the materialized checkout from inside a shape rule's `check`, before `runCase` deletes it. */
async function probeCheckout(
	testCase: RuleTestCase,
	probe: (ctx: RepoRuleContext) => Promise<void>,
): Promise<void> {
	await runCase(
		shapeRule("test/shape-probe", async (ctx) => {
			await probe(ctx);
			return [];
		}),
		testCase,
		[],
	);
}

async function gitOutput(root: string, args: string[]): Promise<string> {
	return (await runGit(root, args)).toString("utf8");
}

const NO_DOCS_FILES = { "notes.txt": "not a document\n" };

describe("RuleTester drives a shape rule through the real engine", () => {
	test("a shape rule runs exactly once, and a valid case with no documents at all passes", async () => {
		let calls = 0;
		const rule = shapeRule("test/shape-counter", () => {
			calls += 1;
			return [];
		});

		await runCase(rule, { name: "no documents", files: NO_DOCS_FILES }, []);

		expect(calls).toBe(1);
	});

	test("a shape rule's diagnostic is asserted with an explicit file, even when no document was discovered", async () => {
		const rule = shapeRule("test/shape-reporter", () => [
			{ message: "shape says hi", file: "notes.txt", loc: { line: 1, col: 1 } },
		]);

		await runCase(rule, { name: "no documents", files: NO_DOCS_FILES }, [
			{ message: "shape says hi", file: "notes.txt", line: 1, col: 1 },
		]);
		const message = await rejectionMessage(
			runCase(
				rule,
				{ name: "no documents, file omitted", files: NO_DOCS_FILES },
				[{ message: "shape says hi", line: 1, col: 1 }],
			),
		);
		expect(message).toContain('omits "file"');
	});

	runRuleTests(
		shapeRule("test/shape-via-run-rule-tests", async (ctx) =>
			(await ctx.git.trackedFiles()).includes("notes.txt")
				? [{ message: "notes.txt is tracked", file: "notes.txt" }]
				: [],
		),
		{
			valid: [
				{
					name: "no documents and nothing tracked but a link",
					files: {},
					symlinks: { link: "nowhere" },
				},
			],
			invalid: [
				{
					name: "no documents discovered, still reports",
					files: NO_DOCS_FILES,
					errors: [{ message: "notes.txt is tracked", file: "notes.txt" }],
				},
			],
		},
	);

	test("surface.spokes are handed to a shape rule as declared (with a loc), surface.undeclaredSpokes without one, both frozen", async () => {
		let seen:
			| readonly { readonly path: string; readonly loc?: unknown }[]
			| undefined;
		const rule = shapeRule("test/shape-spokes", (ctx) => {
			seen = ctx.surfaces[0]?.spokes;
			return [];
		});

		await runCase(
			rule,
			{
				name: "spokes",
				files: { "hub/notes.txt": "not a document\n" },
				surface: {
					root: "hub",
					spokes: ["a/skills", "b/skills"],
					undeclaredSpokes: ["c/skills"],
				},
			},
			[],
		);

		expect(seen?.map((spoke) => spoke.path)).toEqual([
			"a/skills",
			"b/skills",
			"c/skills",
		]);
		expect(seen?.map((spoke) => spoke.loc !== undefined)).toEqual([
			true,
			true,
			false,
		]);
		expect(seen?.map((spoke) => "loc" in spoke)).toEqual([true, true, false]);
		expect(Object.isFrozen(seen)).toBe(true);
		expect(seen?.every((spoke) => Object.isFrozen(spoke))).toBe(true);
	});

	test("a case's options reach a shape rule, validated and frozen, and its severity applies", async () => {
		const OptionsSchema = z.strictObject({ limit: z.number().default(1) });
		let seen: { readonly limit: number } | undefined;
		const rule = shapeRule(
			"test/shape-options",
			(ctx) => {
				seen = ctx.options;
				return [{ message: `limit=${ctx.options.limit}`, file: "notes.txt" }];
			},
			OptionsSchema,
		);

		await runCase(
			rule,
			{
				name: "options and severity",
				files: NO_DOCS_FILES,
				options: { limit: 3 },
				severity: "warn",
			},
			[{ message: "limit=3", file: "notes.txt", severity: "warn" }],
		);

		expect(seen).toEqual({ limit: 3 });
		expect(Object.isFrozen(seen)).toBe(true);
	});

	test("ctx.surfaces handed to a shape rule is frozen, so a rule that mutates it crashes as in production", async () => {
		const rule = shapeRule("test/shape-mutates-surfaces", (ctx) => {
			Array.prototype.push.call(ctx.surfaces, ctx.surfaces[0]);
			return [];
		});

		const error = await rejectionError(
			runCase(rule, { name: "mutation", files: NO_DOCS_FILES }, []),
		);

		expect(error.message).toBe(
			'rule "test/shape-mutates-surfaces" crashed while checking the repository',
		);
		expect(error.cause).toBeInstanceOf(TypeError);
	});
});

describe("a case's `symlinks` become real, committed symlinks", () => {
	test("a symlinks key is an lstat symlink with the given target text, committed with mode 120000", async () => {
		await probeCheckout(
			{
				name: "committed link",
				files: { "hub/SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
				symlinks: { ".claude/skills": "../hub" },
			},
			async (ctx) => {
				const link = join(ctx.root, ".claude/skills");
				expect((await lstat(link)).isSymbolicLink()).toBe(true);
				expect(await readlink(link)).toBe("../hub");
				const staged = await gitOutput(ctx.root, ["ls-files", "-s"]);
				expect(staged).toMatch(/^120000 [0-9a-f]+ 0\t\.claude\/skills$/m);
				expect(staged).toMatch(/^100644 [0-9a-f]+ 0\thub\/SKILL\.md$/m);
			},
		);
	});

	test("a case made only of symlinks is a fixture", async () => {
		await probeCheckout(
			{ name: "only links", files: {}, symlinks: { dangling: "nowhere" } },
			async (ctx) => {
				expect((await lstat(join(ctx.root, "dangling"))).isSymbolicLink()).toBe(
					true,
				);
			},
		);
	});

	test("a symlink whose target lies outside the temp dir creates nothing there", async () => {
		const marker = `skillslurp-t6-outside-${process.pid}-${Date.now()}`;
		const absoluteTarget = join(tmpdir(), `${marker}-absolute`);
		let relativeTarget = "";
		await probeCheckout(
			{
				name: "escaping targets",
				files: NO_DOCS_FILES,
				symlinks: {
					escape: `../../${marker}-relative`,
					"nested/deeper/escape": `../../../../${marker}-nested`,
					absolute: absoluteTarget,
				},
			},
			async (ctx) => {
				relativeTarget = resolve(ctx.root, `../../${marker}-relative`);
				expect(await readlink(join(ctx.root, "escape"))).toBe(
					`../../${marker}-relative`,
				);
				expect(await readlink(join(ctx.root, "absolute"))).toBe(absoluteTarget);
			},
		);

		expect(relativeTarget).not.toBe("");
		expect(existsSync(relativeTarget)).toBe(false);
		expect(existsSync(absoluteTarget)).toBe(false);
		expect(existsSync(resolve(relativeTarget, "..", `${marker}-nested`))).toBe(
			false,
		);
	});
});

describe("a case's `worktree` is applied after the commit and left uncommitted", () => {
	const tracked = { "a.txt": "a\n", "b.txt": "b\n" };

	test("worktree.remove deletes a tracked file from disk but not from the index", async () => {
		await probeCheckout(
			{ name: "removed", files: tracked, worktree: { remove: ["a.txt"] } },
			async (ctx) => {
				expect(await gitOutput(ctx.root, ["ls-files"])).toBe("a.txt\nb.txt\n");
				expect(existsSync(join(ctx.root, "a.txt"))).toBe(false);
				expect(existsSync(join(ctx.root, "b.txt"))).toBe(true);
				expect(await gitOutput(ctx.root, ["status", "--porcelain"])).toBe(
					" D a.txt\n",
				);
			},
		);
	});

	test("worktree.symlinks is an untracked link: on disk as a symlink, absent from the index", async () => {
		await probeCheckout(
			{
				name: "untracked link",
				files: tracked,
				worktree: { symlinks: { "spoke/link": "../a.txt" } },
			},
			async (ctx) => {
				const link = join(ctx.root, "spoke/link");
				expect((await lstat(link)).isSymbolicLink()).toBe(true);
				expect(await readlink(link)).toBe("../a.txt");
				expect(await gitOutput(ctx.root, ["ls-files"])).toBe("a.txt\nb.txt\n");
				expect(await gitOutput(ctx.root, ["status", "--porcelain"])).toBe(
					"?? spoke/\n",
				);
			},
		);
	});

	test("worktree.files is an untracked file on disk, and over a tracked path an uncommitted edit", async () => {
		await probeCheckout(
			{
				name: "untracked file",
				files: tracked,
				worktree: { files: { "new.txt": "new\n", "a.txt": "edited\n" } },
			},
			async (ctx) => {
				expect(await readFile(join(ctx.root, "new.txt"), "utf8")).toBe("new\n");
				expect(await gitOutput(ctx.root, ["ls-files"])).toBe("a.txt\nb.txt\n");
				expect(await gitOutput(ctx.root, ["status", "--porcelain"])).toBe(
					" M a.txt\n?? new.txt\n",
				);
			},
		);
	});

	test("remove plus symlinks on one path swaps a tracked file for an uncommitted link", async () => {
		await probeCheckout(
			{
				name: "type change",
				files: tracked,
				worktree: { remove: ["a.txt"], symlinks: { "a.txt": "b.txt" } },
			},
			async (ctx) => {
				expect((await lstat(join(ctx.root, "a.txt"))).isSymbolicLink()).toBe(
					true,
				);
				expect(await gitOutput(ctx.root, ["status", "--porcelain"])).toBe(
					" T a.txt\n",
				);
			},
		);
	});

	test("worktree.remove refuses a directory instead of deleting the tree", async () => {
		const error = await rejectionError(
			runCase(
				shapeRule("test/shape-remove-dir", () => []),
				{
					name: "remove a directory",
					files: { "d/a.txt": "a\n" },
					worktree: { remove: ["d", "."] },
				},
				[],
			),
		);

		expect(error.message).toContain('worktree.remove entry "d"');
		expect(error.message).toContain("never a directory");
		expect(error.cause).toMatchObject({ syscall: "unlink" });
	});

	test("worktree on a case with no git step is a harness error", async () => {
		const noGit = await rejectionMessage(
			runCase(
				shapeRule("test/shape-no-git", () => []),
				{
					name: "no git",
					files: NO_DOCS_FILES,
					needsGit: false,
					worktree: { remove: ["notes.txt"] },
				},
				[],
			),
		);
		const fileRuleDefault = await rejectionMessage(
			runCase(
				cleanRule,
				{
					name: "file rule, default needsGit",
					files: { "SKILL.md": "---\nname: ok\ndescription: ok\n---\n" },
					worktree: { files: { "x.txt": "x" } },
				},
				[],
			),
		);

		for (const message of [noGit, fileRuleDefault]) {
			expect(message).toContain('"worktree" changes the checkout');
			expect(message).toContain("no git step");
		}
	});
});

describe("every new path key is held to the same bar as `files`", () => {
	const noop = shapeRule("test/shape-unsafe-keys", () => []);
	const unsafe: readonly (readonly [
		string,
		string,
		(key: string) => Partial<RuleTestCase>,
	])[] = [
		["symlinks key", "symlinks", (key) => ({ symlinks: { [key]: "x" } })],
		[
			"worktree.files key",
			"worktree.files",
			(key) => ({ worktree: { files: { [key]: "x" } } }),
		],
		[
			"worktree.symlinks key",
			"worktree.symlinks",
			(key) => ({ worktree: { symlinks: { [key]: "x" } } }),
		],
		[
			"worktree.remove entry",
			"worktree.remove",
			(key) => ({ worktree: { remove: [key] } }),
		],
	];

	for (const [label, name, build] of unsafe) {
		test(`${name}: an absolute key and a '..'-escaping key are rejected, naming the key`, async () => {
			const absolute = await rejectionMessage(
				runCase(
					noop,
					{ name: "absolute", files: NO_DOCS_FILES, ...build("/etc/passwd") },
					[],
				),
			);
			expect(absolute).toContain(
				`${label} "/etc/passwd" must be a repo-relative path, not absolute`,
			);

			const escaping = await rejectionMessage(
				runCase(
					noop,
					{ name: "escaping", files: NO_DOCS_FILES, ...build("../outside") },
					[],
				),
			);
			expect(escaping).toContain(
				`${label} "../outside" escapes the temp dir via ".."`,
			);
		});
	}

	test("a path in both files and symlinks, or both worktree.files and worktree.symlinks, is a harness error", async () => {
		const base = await rejectionMessage(
			runCase(
				noop,
				{
					name: "both",
					files: { "a/./x": "x" },
					symlinks: { "a/x": "y" },
				},
				[],
			),
		);
		expect(base).toContain('"a/x" is listed in both "files" and "symlinks"');

		const worktree = await rejectionMessage(
			runCase(
				noop,
				{
					name: "both in worktree",
					files: NO_DOCS_FILES,
					worktree: { files: { x: "x" }, symlinks: { x: "y" } },
				},
				[],
			),
		);
		expect(worktree).toContain(
			'"x" is listed in both "worktree.files" and "worktree.symlinks"',
		);
	});

	test("a write that would pass through a fixture symlink is refused, and nothing lands outside the temp dir", async () => {
		const marker = `skillslurp-t6-through-${process.pid}-${Date.now()}`;
		const outside = join(tmpdir(), marker);
		for (const worktree of [
			{ files: { "out/pwned.txt": "x" } },
			{ files: { out: "x" } },
			{ symlinks: { "out/link": "x" } },
			{ remove: ["out/pwned.txt"] },
		]) {
			const message = await rejectionMessage(
				runCase(
					noop,
					{
						name: "through a link",
						files: NO_DOCS_FILES,
						symlinks: { out: outside },
						worktree,
					},
					[],
				),
			);
			expect(message).toContain("passes through a symlink");
		}

		expect(existsSync(outside)).toBe(false);
	});
});

describe("a NUL byte in any path key is a harness error naming the key", () => {
	const noop = shapeRule("test/shape-nul-keys", () => []);
	const groups: readonly (readonly [
		string,
		(key: string) => Partial<RuleTestCase>,
	])[] = [
		["files key", (key) => ({ files: { [key]: "x" } })],
		["symlinks key", (key) => ({ symlinks: { [key]: "x" } })],
		["worktree.files key", (key) => ({ worktree: { files: { [key]: "x" } } })],
		[
			"worktree.symlinks key",
			(key) => ({ worktree: { symlinks: { [key]: "x" } } }),
		],
		["worktree.remove entry", (key) => ({ worktree: { remove: [key] } })],
	];

	for (const [label, build] of groups) {
		test(`${label}: a key holding a NUL is rejected before anything is written`, async () => {
			const key = "a\0b.txt";

			const message = await rejectionMessage(
				runCase(noop, { name: "nul", files: NO_DOCS_FILES, ...build(key) }, []),
			);

			expect(message).toContain(
				`${label} ${JSON.stringify(key)} must not contain a NUL byte`,
			);
		});
	}
});

describe("a fixture can never pre-create .git, and a shape case cannot run at a severity no config produces", () => {
	test("a symlinks entry named .git is refused before git init, and the directory it points at stays empty", async () => {
		const outside = await mkdtemp(join(tmpdir(), "skillslurp-t6-gitlink-"));
		try {
			const message = await rejectionMessage(
				runCase(
					shapeRule("test/shape-git-link", () => []),
					{
						name: "git symlink",
						files: NO_DOCS_FILES,
						symlinks: { ".git": outside },
					},
					[],
				),
			);

			expect(message).toContain('the fixture wrote an entry at ".git"');
			expect(await readdir(outside)).toEqual([]);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("a files entry under .git is refused too, whatever the rule kind", async () => {
		const message = await rejectionMessage(
			runCase(
				shapeRule("test/shape-git-file", () => []),
				{ name: "git file", files: { ".git/HEAD": "ref: refs/heads/x\n" } },
				[],
			),
		);

		expect(message).toContain('the fixture wrote an entry at ".git"');
	});

	test('a shape case whose severity is "off" is a harness error, and the rule never runs', async () => {
		let ran = false;
		const off: string = "off";

		const message = await rejectionMessage(
			runCase(
				shapeRule("test/shape-off", () => {
					ran = true;
					return [];
				}),
				{
					name: "off",
					files: NO_DOCS_FILES,
					severity: off as Severity,
				},
				[],
			),
		);

		expect(message).toContain('severity "off" is not "error" or "warn"');
		expect(ran).toBe(false);
	});
});
