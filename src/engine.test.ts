import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	ConfigError,
	loadConfig,
	type ResolvedConfig,
	type ResolvedRule,
	type SurfaceRuleOverride,
} from "./config.js";
import type { RepoRuleContext, RuleContext } from "./context.js";
import type { Diagnostic, Loc } from "./diagnostic.js";
import type { Document } from "./document.js";
import {
	DOCS_URL,
	type EngineOptions,
	runEngine,
	validateRegistry,
} from "./engine.js";
import { computeExitCode, EXIT_VIOLATIONS } from "./exit.js";
import { runGit } from "./git.js";
import type {
	FileRule,
	MaybePromise,
	ProjectRule,
	Report,
	Rule,
	RuleMeta,
	RuleReport,
	ScanRule,
	ShapeRule,
} from "./rule.js";
import { nameMatchesDir } from "./rules/skill/name-matches-dir.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

/** Creates a fresh temp dir, runs `body`, and always cleans it up afterwards. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-engine-"));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** One surface to build into a test `ResolvedConfig`; see `makeConfig`. */
interface SurfaceInput {
	/** relative to the config's `root`; distinct surfaces need distinct directories on disk */
	root: string;
	rules?: ReadonlyMap<string, SurfaceRuleOverride>;
	/**
	 * Where this surface's `root` sits in the config yaml. Omitted by almost every caller, and
	 * absent (not `undefined`) on the built surface when omitted — `ResolvedSurface.loc` is what
	 * a `ConfigReport` defaults its position to, and "no yaml behind this surface" has to stay
	 * distinguishable from "positioned at undefined".
	 */
	loc?: Loc;
}

/**
 * Builds a `ResolvedConfig` directly. Defaults to the original single-surface-at-the-repo-root
 * shape every single-surface test in this file already relies on, so none of them had to change;
 * the per-(rule, surface) tests pass a third argument naming two or more real subdirectories,
 * each getting its own `rules` delta.
 */
function makeConfig(
	root: string,
	rules: ReadonlyMap<string, ResolvedRule> = new Map(),
	surfaces: readonly SurfaceInput[] = [{ root: "." }],
	ruleOptions: ReadonlyMap<string, unknown> = new Map(),
): ResolvedConfig {
	return {
		root,
		origin: "config",
		configFile: join(root, "skillslurp.json"),
		ignore: [],
		surfaces: surfaces.map((s) => {
			// Field-by-field rather than `{ ...base, loc: s.loc }` (CLAUDE.md): an own `loc` key
			// holding `undefined` is not the same as no `loc` key, and `locFields` reads exactly
			// that difference.
			const base = {
				root: s.root,
				kind: "skills" as const,
				dialects: ["generic" as const],
				include: ["**/*.md"],
				ignore: [],
				spokes: [],
				rules: s.rules ?? new Map(),
			};
			return s.loc === undefined ? base : { ...base, loc: s.loc };
		}),
		rules,
		ruleOptions,
		skippedCandidates: [],
	};
}

async function catchConfigError(
	promise: Promise<unknown>,
): Promise<ConfigError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ConfigError) {
			return err;
		}
		throw err;
	}
	throw new Error("expected runEngine to reject with ConfigError");
}

const STUB_META = {
	description: "stub rule for engine tests",
	docsUrl: "https://example.invalid/docs",
	tiers: ["recommended"] as const,
	defaultSeverity: "error" as const,
	fixable: false,
};

/** A minimal file rule that records every document it was invoked on. */
function makeFileRule<O = unknown>(
	id: string,
	// `Report[]`, not `RuleReport[]`: a stub rule in this file must be able to return a
	// `ConfigReport`, and `RuleReport.problem?: never` makes the narrower annotation a compile
	// error rather than a silent pass-through.
	check: (doc: Document, ctx: RuleContext<O>) => MaybePromise<Report[]>,
	metaOverrides: Partial<RuleMeta<O>> = {},
): FileRule<O> & { calls: Document[] } {
	const calls: Document[] = [];
	return {
		kind: "file",
		meta: { id, ...STUB_META, ...metaOverrides },
		calls,
		check: async (doc, ctx) => {
			calls.push(doc);
			return await check(doc, ctx);
		},
	};
}

/**
 * A minimal project rule that records every `ctx` it was invoked with — one entry per
 * (surface, dispatch), same idiom as `makeFileRule`'s `calls` but recording the context
 * instead of the document, since a project rule's `check` gets no document argument at all.
 */
function makeProjectRule<O = unknown>(
	id: string,
	/** `Report[]` — see `makeFileRule` */
	check: (ctx: RuleContext<O>) => MaybePromise<Report[]>,
	metaOverrides: Partial<RuleMeta<O>> = {},
): ProjectRule<O> & { calls: RuleContext<O>[] } {
	const calls: RuleContext<O>[] = [];
	return {
		kind: "project",
		meta: { id, ...STUB_META, ...metaOverrides },
		calls,
		check: async (ctx) => {
			calls.push(ctx);
			return await check(ctx);
		},
	};
}

/** `makeProjectRule`'s `scan`-kind twin — see its doc comment. */
function makeScanRule<O = unknown>(
	id: string,
	/** `Report[]` — see `makeFileRule` */
	check: (ctx: RuleContext<O>) => MaybePromise<Report[]>,
	metaOverrides: Partial<RuleMeta<O>> = {},
): ScanRule<O> & { calls: RuleContext<O>[] } {
	const calls: RuleContext<O>[] = [];
	return {
		kind: "scan",
		meta: { id, ...STUB_META, ...metaOverrides },
		calls,
		check: async (ctx) => {
			calls.push(ctx);
			return await check(ctx);
		},
	};
}

/**
 * `makeProjectRule`'s once-per-run twin for `shape`: records every `RepoRuleContext` it was
 * invoked with, so `calls.length` IS the number of dispatches the run made.
 */
function makeShapeRule<O = unknown>(
	id: string,
	/** `Report[]` — see `makeFileRule` */
	check: (ctx: RepoRuleContext<O>) => MaybePromise<Report[]>,
	metaOverrides: Partial<RuleMeta<O>> = {},
): ShapeRule<O> & { calls: RepoRuleContext<O>[] } {
	const calls: RepoRuleContext<O>[] = [];
	return {
		kind: "shape",
		meta: { id, ...STUB_META, ...metaOverrides },
		calls,
		check: async (ctx) => {
			calls.push(ctx);
			return await check(ctx);
		},
	};
}

// Tiers now come from each rule's own `meta.tiers`, so a test registry no longer has to carry
// a stub for every preset id just to satisfy a cross-check (`assertPresetRuleIds` was deleted).
// `run` stays as the single place tests reach the engine.
async function run(
	config: ResolvedConfig,
	registry: readonly Rule[],
	options?: EngineOptions,
): Promise<readonly Diagnostic[]> {
	return (await runEngine(config, registry, options)).diagnostics;
}

/**
 * The same `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` neutralization `gitInitAndCommit` applies to
 * its own invocations (rule-tester.ts): the extra commits the `--diff-base` fixtures below need
 * must be as independent of the developer's own `~/.gitconfig` as the first one is. Passed as
 * `runGit`'s `envOverrides` rather than set on `process.env` (context.test.ts's approach) so this
 * file changes nothing for the tests above it.
 */
const GIT_TEST_ENV = Object.freeze({
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
});

/** `runGit` with this file's fixed environment, trimmed to text. */
async function git(dir: string, args: readonly string[]): Promise<string> {
	return (await runGit(dir, args, GIT_TEST_ENV)).toString("utf8").trim();
}

/**
 * The second and later commits of a fixture repo — `gitInitAndCommit` makes the first one and
 * configures the identity these reuse. Shaped after `context.test.ts`'s `commitAll`/`headRev`
 * pair rather than as a third helper with a third opinion; `--no-verify` and an emptied
 * `core.hooksPath` match `gitInitAndCommit`'s own commit call, so a hook in an inherited template
 * cannot run here either.
 */
async function commitAll(dir: string, message: string): Promise<void> {
	await git(dir, ["add", "-A"]);
	await git(dir, [
		"-c",
		"core.hooksPath=",
		"commit",
		"--quiet",
		"--no-verify",
		"-m",
		message,
	]);
}

async function headRev(dir: string): Promise<string> {
	return git(dir, ["rev-parse", "HEAD"]);
}

/** A skill document body; content differs per call so a commit really changes the file. */
function doc(body: string): string {
	return `# Heading\n\n${body}\n`;
}

test("a stub file rule reports over multiple files; a report without `file` falls back to doc.path; configured severity is applied", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body A\n", "utf8");
		await writeFile(join(dir, "b.md"), "Body B\n", "utf8");

		const rule = makeFileRule("test/stub", async (doc) => [
			{ message: `checked ${doc.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "warn" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.length).toBe(2);
		const [first, second] = diagnostics;
		if (!first || !second) throw new Error("expected two diagnostics");

		expect(first.file).toBe("a.md");
		expect(first.message).toBe("checked a.md");
		expect(first.severity).toBe("warn");
		expect(first.ruleId).toBe("test/stub");
		expect(first.fixable).toBe(false);
		expect(first.docsUrl).toBe(rule.meta.docsUrl);
		expect(first.line).toBeUndefined();

		expect(second.file).toBe("b.md");
		expect(second.message).toBe("checked b.md");

		// sorted by file
		expect(diagnostics.map((d) => d.file)).toEqual(["a.md", "b.md"]);
	});
});

test("a document with broken frontmatter yaml gets a parse/frontmatter diagnostic, and its file rules are skipped, while a healthy document's rules still run", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "broken.md"),
			"---\nname: [unclosed\n---\n",
			"utf8",
		);
		await writeFile(
			join(dir, "healthy.md"),
			"---\nname: ok\n---\n\nBody.\n",
			"utf8",
		);

		const rule = makeFileRule("test/stub", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		const parseErrors = diagnostics.filter(
			(d) => d.ruleId === "parse/frontmatter",
		);
		expect(parseErrors.length).toBe(1);
		const [problem] = parseErrors;
		if (!problem) throw new Error("expected a parse/frontmatter diagnostic");
		expect(problem.file).toBe("broken.md");
		expect(problem.severity).toBe("error");
		expect(problem.fixable).toBe(false);
		expect(problem.docsUrl).toBe(DOCS_URL);
		// Same fixture as document.test.ts: yaml-local EOF on line 1 of the frontmatter body,
		// lineOffset 1 (opening fence is file line 1) → file line 2.
		expect(problem.line).toBe(2);

		expect(rule.calls.map((d) => d.path)).toEqual(["healthy.md"]);
	});
});

test("a document with a duplicate frontmatter key gets a parse/frontmatter diagnostic and file rules are skipped (duplicate keys are owned by parse/frontmatter)", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "dup.md"),
			"---\nname: a\nname: b\n---\n",
			"utf8",
		);

		const rule = makeFileRule("test/stub", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.length).toBe(1);
		const [only] = diagnostics;
		if (!only) throw new Error("expected one diagnostic");
		expect(only.ruleId).toBe("parse/frontmatter");
		expect(only.message).toBe("Map keys must be unique");
		expect(rule.calls.length).toBe(0);
	});
});

test("validateRegistry throws on duplicate rule ids", () => {
	const ruleA = makeFileRule("test/dup", async () => []);
	const ruleB = makeFileRule("test/dup", async () => []);

	expect(() => validateRegistry([ruleA, ruleB])).toThrow(/duplicate/i);
});

test('validateRegistry throws on a rule id in the reserved "parse/" namespace', () => {
	const rule = makeFileRule("parse/anything", async () => []);

	expect(() => validateRegistry([rule])).toThrow(/reserved/i);
});

test('validateRegistry throws on a rule id in the reserved "config/" namespace', () => {
	const rule = makeFileRule("config/anything", async () => []);

	expect(() => validateRegistry([rule])).toThrow(/reserved/i);
});

// An empty ruleId would break the stylish reporter's no-trailing-whitespace invariant: it's
// the last, unpadded column on each diagnostic line.
test("validateRegistry throws when a rule id is an empty string", () => {
	const rule = makeFileRule("", async () => []);

	expect(() => validateRegistry([rule])).toThrow(/non-empty string/i);
});

test("a rule with a defaulted options schema, configured by bare severity, receives the schema's defaults", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean().default(true) });
		let seenOptions: unknown;
		const rule = makeFileRule<{ flag: boolean }>(
			"test/opts",
			async (_doc, ctx) => {
				seenOptions = ctx.options;
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/opts", { severity: "warn" }]]),
		);

		await run(config, [rule]);

		expect(seenOptions).toEqual({ flag: true });
	});
});

test("invalid options against a rule's schema throw a ConfigError naming the rule id", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const rule = makeFileRule<{ flag: boolean }>("test/opts", async () => [], {
			optionsSchema: schema,
		});
		const config = makeConfig(
			dir,
			new Map([["test/opts", { severity: "warn", options: { flag: "nope" } }]]),
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.file).toBe(config.configFile);
		expect(err.problems.length).toBeGreaterThan(0);
		expect(err.problems.some((p) => p.message.includes("test/opts"))).toBe(
			true,
		);
		expect(err.problems.every((p) => p.loc === undefined)).toBe(true);
	});
});

test("options given to a rule with no optionsSchema throw a ConfigError naming the rule id", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/no-opts", async () => []);
		const config = makeConfig(
			dir,
			new Map([
				["test/no-opts", { severity: "warn", options: { anything: true } }],
			]),
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems.some((p) => p.message.includes("test/no-opts"))).toBe(
			true,
		);
		expect(
			err.problems.some((p) => p.message.includes("accepts no options")),
		).toBe(true);
	});
});

test("a rule whose check throws synchronously causes runEngine to reject with an Error naming the rule id and file, chaining the original as cause", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const original = new Error("boom");
		const rule: Rule = {
			kind: "file",
			meta: { id: "test/throws", ...STUB_META },
			check() {
				throw original;
			},
		};
		const config = makeConfig(
			dir,
			new Map([["test/throws", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/throws");
		expect(caught.message).toContain("a.md");
		expect(caught.cause).toBe(original);
	});
});

test("an async rule (check returns a Promise) is awaited correctly and its reports are collected", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule: Rule = {
			kind: "file",
			meta: { id: "test/async", ...STUB_META },
			check: (doc) =>
				new Promise((resolveCheck) => {
					setTimeout(
						() => resolveCheck([{ message: `async check of ${doc.path}` }]),
						0,
					);
				}),
		};
		const config = makeConfig(
			dir,
			new Map([["test/async", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0]?.message).toBe("async check of a.md");
	});
});

test("diagnostics from multiple rules with interleaved positions are stably sorted by file, line, col, ruleId, then message", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const ruleZ = makeFileRule("z/rule", async () => [
			{ message: "b-message", loc: { line: 1, col: 1 } },
			{ message: "a-message", loc: { line: 1, col: 1 } },
			{ message: "x", loc: { line: 2, col: 1 } },
		]);
		const ruleA = makeFileRule("a/rule", async () => [
			{ message: "y", loc: { line: 1, col: 1 } },
			{ message: "w", loc: { line: 1, col: 5 } },
		]);
		const config = makeConfig(
			dir,
			new Map([
				["z/rule", { severity: "error" }],
				["a/rule", { severity: "error" }],
			]),
		);

		// Registry deliberately ordered [ruleZ, ruleA]: proves the final order comes from the
		// sort, not from registry iteration order or config.rules insertion order.
		const diagnostics = await run(config, [ruleZ, ruleA]);

		expect(
			diagnostics.map((d) => ({
				ruleId: d.ruleId,
				line: d.line,
				col: d.col,
				message: d.message,
			})),
		).toEqual([
			{ ruleId: "a/rule", line: 1, col: 1, message: "y" },
			{ ruleId: "z/rule", line: 1, col: 1, message: "a-message" },
			{ ruleId: "z/rule", line: 1, col: 1, message: "b-message" },
			{ ruleId: "a/rule", line: 1, col: 5, message: "w" },
			{ ruleId: "z/rule", line: 2, col: 1, message: "x" },
		]);
	});
});

test("a rule present in the registry but not enabled in config.rules is never invoked", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const enabledRule = makeFileRule("test/enabled", async () => []);
		const disabledRule = makeFileRule("test/disabled", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/enabled", { severity: "error" }]]),
		);

		await run(config, [enabledRule, disabledRule]);

		expect(enabledRule.calls.length).toBe(1);
		expect(disabledRule.calls.length).toBe(0);
	});
});

test("running the engine twice over the same tree yields deeply equal diagnostics arrays", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body A\n", "utf8");
		await writeFile(join(dir, "b.md"), "Body B\n", "utf8");
		await writeFile(
			join(dir, "broken.md"),
			"---\nname: [unclosed\n---\n",
			"utf8",
		);

		const rule = makeFileRule("test/stub", async (doc) => [
			{ message: `checked ${doc.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "warn" }]]),
		);

		const first = await run(config, [rule]);
		const second = await run(config, [rule]);

		expect(second).toEqual(first);
	});
});

test("the returned diagnostics array is frozen", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");
		const config = makeConfig(dir);

		const diagnostics = await run(config, []);

		expect(Object.isFrozen(diagnostics)).toBe(true);
	});
});

test("invalid options across multiple rules are all collected into a single ConfigError, not just the first", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const ruleA = makeFileRule<{ flag: boolean }>(
			"test/opts-a",
			async () => [],
			{ optionsSchema: schema },
		);
		const ruleB = makeFileRule<{ flag: boolean }>(
			"test/opts-b",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([
				["test/opts-a", { severity: "warn", options: { flag: "nope" } }],
				["test/opts-b", { severity: "warn", options: { flag: "also-nope" } }],
			]),
		);

		const err = await catchConfigError(run(config, [ruleA, ruleB]));

		expect(err.problems.length).toBe(2);
		const messages = err.problems.map((p) => p.message);
		expect(messages.some((m) => m.includes("test/opts-a"))).toBe(true);
		expect(messages.some((m) => m.includes("test/opts-b"))).toBe(true);
	});
});

test("bad options on a file rule and on a shape rule are one ConfigError, the file rule's problem first", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const shapeRule = makeShapeRule<{ flag: boolean }>(
			"test/a-shape",
			async () => [],
			{ optionsSchema: schema },
		);
		const fileRule = makeFileRule<{ flag: boolean }>(
			"test/z-file",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([
				["test/a-shape", { severity: "error", options: { flag: "nope" } }],
				["test/z-file", { severity: "error", options: { flag: "nope" } }],
			]),
		);

		const err = await catchConfigError(run(config, [shapeRule, fileRule]));

		expect(err.problems.map((p) => p.message)).toEqual([
			expect.stringContaining('rule "test/z-file"'),
			expect.stringContaining('rule "test/a-shape"'),
		]);
		expect(shapeRule.calls.length).toBe(0);
		expect(fileRule.calls.length).toBe(0);
	});
});

test("one RuleContext is built per rule, reused (===) across every document, and is itself frozen", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "b.md"), "Body\n", "utf8");

		const seenCtxs: unknown[] = [];
		const rule = makeFileRule("test/ctx-identity", async (_doc, ctx) => {
			seenCtxs.push(ctx);
			return [];
		});
		const config = makeConfig(
			dir,
			new Map([["test/ctx-identity", { severity: "error" }]]),
		);

		await run(config, [rule]);

		expect(seenCtxs.length).toBe(2);
		expect(seenCtxs[0]).toBe(seenCtxs[1]);
		expect(Object.isFrozen(seenCtxs[0])).toBe(true);
	});
});

test("validated options are deep-frozen: a rule trying to mutate an options array throws, and later documents see it unchanged", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "b.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			allowed: z.array(z.string()).default(["x"]),
		});
		const seenLengths: number[] = [];
		let pushThrew = false;
		const rule = makeFileRule<{ allowed: string[] }>(
			"test/mutate",
			async (_doc, ctx) => {
				seenLengths.push(ctx.options.allowed.length);
				try {
					ctx.options.allowed.push("poison");
				} catch {
					pushThrew = true;
				}
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/mutate", { severity: "error" }]]),
		);

		await run(config, [rule]);

		expect(pushThrew).toBe(true);
		// Both documents saw the same, unmutated length — the first document's attempted push
		// never poisoned the second document's view of the (shared, cached) options.
		expect(seenLengths).toEqual([1, 1]);
	});
});

/**
 * `Object.freeze` on a `Map` is cosmetic — a Map's entries live in internal
 * slots, so `set`/`delete`/`clear` keep working even though `Object.isFrozen` reports `true`.
 * An options schema that transforms into a `Map` (for O(1) lookups) is entirely ordinary and
 * reachable from plain config yaml, and the engine shares one validated options object *by
 * reference* across every surface that does not override a rule — so a rule mutating a `Map` in
 * its own options used to poison every later surface in the same run, silently.
 */
test("a Map inside validated options rejects mutation (deepFreeze shadows Map mutators)", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			byKey: z
				.array(z.tuple([z.string(), z.string()]))
				.default([["a", "1"]])
				.transform((entries) => new Map(entries)),
		});
		let setThrew = false;
		const rule = makeFileRule<{ byKey: Map<string, string> }>(
			"test/mutate-map",
			async (_doc, ctx) => {
				try {
					ctx.options.byKey.set("poison", "x");
				} catch {
					setThrew = true;
				}
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/mutate-map", { severity: "error" }]]),
		);

		await run(config, [rule]);

		expect(setThrew).toBe(true);
	});
});

/** Same defect, the `Set` half — `add`/`delete`/`clear` keep working on a frozen `Set` too. */
test("a Set inside validated options rejects mutation (deepFreeze shadows Set mutators)", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			allowed: z
				.array(z.string())
				.default(["x"])
				.transform((a) => new Set(a)),
		});
		let addThrew = false;
		const rule = makeFileRule<{ allowed: Set<string> }>(
			"test/mutate-set",
			async (_doc, ctx) => {
				try {
					ctx.options.allowed.add("poison");
				} catch {
					addThrew = true;
				}
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/mutate-set", { severity: "error" }]]),
		);

		await run(config, [rule]);

		expect(addThrew).toBe(true);
	});
});

/**
 * `deepFreeze`'s cycle-guard `seen` set must not stop it from freezing an object it finds
 * *inside* a Map value — this is the Map/Set half of "walk the entries, not just the keys".
 */
test("an object nested inside a Map value is itself frozen", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			byKey: z
				.array(z.tuple([z.string(), z.object({ n: z.number() })]))
				.default([["a", { n: 1 }]])
				.transform((entries) => new Map(entries)),
		});
		let seenFrozen: boolean | undefined;
		const rule = makeFileRule<{ byKey: Map<string, { n: number }> }>(
			"test/mutate-map-value",
			async (_doc, ctx) => {
				seenFrozen = Object.isFrozen(ctx.options.byKey.get("a"));
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/mutate-map-value", { severity: "error" }]]),
		);

		await run(config, [rule]);

		expect(seenFrozen).toBe(true);
	});
});

test("a rule check that returns a non-array at runtime (e.g. undefined) is caught with a single, descriptive error naming the rule id and file — not double-wrapped", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule: Rule = {
			kind: "file",
			meta: { id: "test/non-array", ...STUB_META },
			check: async () => undefined as unknown as RuleReport[],
		};
		const config = makeConfig(
			dir,
			new Map([["test/non-array", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/non-array");
		expect(caught.message).toContain("a.md");
		expect(caught.message).toContain("non-array");
		// Exactly one Error, not the generic "crashed while checking" wrapper around a second,
		// near-identical inner message (the pre-fix double-wrap) — see engine.ts's runEngine
		// doc comment (point 6).
		expect(caught.cause).toBeUndefined();
	});
});

test("a rule report with an absolute `file` is rejected as a rule bug: runEngine rejects with an Error naming the rule id, chaining a cause naming the bad path", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/bad-file", async () => [
			{ message: "oops", file: "/abs/x.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/bad-file", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/bad-file");
		expect(caught.cause).toBeInstanceOf(Error);
		expect((caught.cause as Error).message).toContain("/abs/x.md");
	});
});

// Every one of these climbs out of the repo without starting with `/` or `../`, so the
// pre-normalization prefix test called all three safe and forwarded them into `Diagnostic.file`
// (measured on the raw-string version of `escapesRepoPosix`). `a/../b` is the control: an interior
// `..` that lands back INSIDE the repo, which must still be accepted.
test.each([
	"a/../../etc/passwd",
	"./../x",
	"docs/../../x.md",
	"..",
	"/abs/x.md",
])(
	"a rule report whose `file` escapes the repo only after normalization (%p) is rejected as a rule bug",
	async (badPath) => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "a.md"), "Body\n", "utf8");

			const rule = makeFileRule("test/escaping-file", async () => [
				{ message: "oops", file: badPath },
			]);
			const config = makeConfig(
				dir,
				new Map([["test/escaping-file", { severity: "error" }]]),
			);

			let caught: unknown;
			try {
				await run(config, [rule]);
			} catch (err) {
				caught = err;
			}

			if (!(caught instanceof Error))
				throw new Error("expected runEngine to reject");
			expect(caught.message).toContain("test/escaping-file");
			expect(caught.cause).toBeInstanceOf(Error);
			expect((caught.cause as Error).message).toContain(badPath);
		});
	},
);

test("an interior `..` that stays inside the repo is still accepted, and reaches the Diagnostic in its normalized form", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/inner-dotdot", async () => [
			{ message: "oops", file: "docs/../notes.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/inner-dotdot", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		// Accepted, and normalized: the engine is the single normalizer for `RuleReport.file`
		// now, so "docs/../notes.md" collapses to "notes.md" — the same string a rule that
		// wrote "notes.md" directly would produce, which is the whole point (grouping by file).
		expect(diagnostics.map((d) => d.file)).toEqual(["notes.md"]);
	});
});

// --- the engine normalizes RuleReport.file into Diagnostic.file, instead of forwarding it
// verbatim and discarding the normal form it already computed to answer the escape question ---

test('a rule report\'s `file` is normalized before reaching Diagnostic.file: "./x.md" and "x.md" produce the identical string', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/normalize-file", async () => [
			{ message: "one", file: "./x.md" },
			{ message: "two", file: "x.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/normalize-file", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.map((d) => d.file)).toEqual(["x.md", "x.md"]);
	});
});

test("a rule report's `file` with backslashes is converted to posix separators before normalizing", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/backslash-file", async () => [
			{ message: "oops", file: "a\\b.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/backslash-file", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.map((d) => d.file)).toEqual(["a/b.md"]);
	});
});

test.each(["", "  ", "."])(
	'a rule report\'s blank `file` (%j) is rejected as a rule bug, not forwarded as Diagnostic.file: ""',
	async (blankFile) => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "a.md"), "Body\n", "utf8");

			const rule = makeFileRule("test/blank-file", async () => [
				{ message: "oops", file: blankFile },
			]);
			const config = makeConfig(
				dir,
				new Map([["test/blank-file", { severity: "error" }]]),
			);

			let caught: unknown;
			try {
				await run(config, [rule]);
			} catch (err) {
				caught = err;
			}

			if (!(caught instanceof Error))
				throw new Error("expected runEngine to reject");
			expect(caught.message).toContain("test/blank-file");
			expect(caught.cause).toBeInstanceOf(Error);
			expect((caught.cause as Error).message).toContain("empty file path");
		});
	},
);

test.skipIf(process.getuid?.() === 0)(
	"a discovered file that cannot be read (EACCES) rejects with an Error naming the repo-relative path, chaining the original errno as cause",
	async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "secret.md"), "Body\n", "utf8");
			await chmod(join(dir, "secret.md"), 0o000);

			try {
				const config = makeConfig(dir);

				let caught: unknown;
				try {
					await run(config, []);
				} catch (err) {
					caught = err;
				}

				if (!(caught instanceof Error))
					throw new Error("expected runEngine to reject");
				expect(caught.message).toContain('"secret.md"');
				expect(caught.message).not.toContain(dir);
				expect(caught.cause).toBeInstanceOf(Error);
				expect((caught.cause as NodeJS.ErrnoException).code).toBe("EACCES");
			} finally {
				// Restore before withTempDir's own cleanup tries to rm the directory.
				await chmod(join(dir, "secret.md"), 0o644);
			}
		});
	},
);

test("a rule whose check returns a rejected promise (async rejection, not a sync throw) is caught and rethrown with the original as cause", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const original = new Error("async boom");
		const rule: Rule = {
			kind: "file",
			meta: { id: "test/rejects", ...STUB_META },
			check: () => Promise.reject(original),
		};
		const config = makeConfig(
			dir,
			new Map([["test/rejects", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/rejects");
		expect(caught.message).toContain("a.md");
		expect(caught.cause).toBe(original);
	});
});

test("a document with no frontmatter at all (doc.frontmatter === null) still reaches file rules", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "no-fm.md"), "Just a body.\n", "utf8");

		const rule = makeFileRule("test/stub", async (doc) => [
			{ message: `checked ${doc.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.map((d) => d.path)).toEqual(["no-fm.md"]);
		expect(diagnostics.length).toBe(1);
	});
});

test("a document with an empty-but-valid frontmatter block (---/--- with no parse errors) still reaches file rules", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "empty-fm.md"), "---\n---\nBody\n", "utf8");

		const rule = makeFileRule("test/stub", async (doc) => [
			{ message: `checked ${doc.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.map((d) => d.path)).toEqual(["empty-fm.md"]);
		expect(diagnostics.length).toBe(1);
	});
});

test("report.file, report.fixable, and loc.endLine/endCol all propagate into the Diagnostic", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/stub", async () => [
			{
				message: "custom file + fixable + full loc",
				file: "elsewhere.md",
				fixable: true,
				loc: { line: 3, col: 4, endLine: 5, endCol: 6 },
			},
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics.length).toBe(1);
		const [only] = diagnostics;
		if (!only) throw new Error("expected one diagnostic");
		expect(only.file).toBe("elsewhere.md");
		expect(only.fixable).toBe(true);
		expect(only.line).toBe(3);
		expect(only.col).toBe(4);
		expect(only.endLine).toBe(5);
		expect(only.endCol).toBe(6);
	});
});

// --- per-(rule, surface) contexts -----------------------------------------------------------

test("the same rule observes different options on two surfaces in one run", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const schema = z.strictObject({ max: z.number().default(500) });
		const seen: Record<string, number> = {};
		const rule = makeFileRule<{ max: number }>(
			"test/opts-per-surface",
			async (doc, ctx) => {
				seen[doc.path] = ctx.options.max;
				return [];
			},
			{ optionsSchema: schema },
		);

		const config = makeConfig(
			dir,
			new Map([
				["test/opts-per-surface", { severity: "error", options: { max: 10 } }],
			]),
			[
				{ root: "surface-a" },
				{
					root: "surface-b",
					rules: new Map([["test/opts-per-surface", { options: { max: 20 } }]]),
				},
			],
		);

		await run(config, [rule]);

		expect(seen["surface-a/a.md"]).toBe(10);
		expect(seen["surface-b/b.md"]).toBe(20);
	});
});

test("a global `warn` plus a surface `error` override: per-file diagnostic severities differ", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/sev-per-surface", async (doc) => [
			{ message: `checked ${doc.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/sev-per-surface", { severity: "warn" }]]),
			[
				{ root: "surface-a" },
				{
					root: "surface-b",
					rules: new Map([["test/sev-per-surface", { severity: "error" }]]),
				},
			],
		);

		const diagnostics = await run(config, [rule]);

		const bySeverity = Object.fromEntries(
			diagnostics.map((d) => [d.file, d.severity]),
		);
		expect(bySeverity["surface-a/a.md"]).toBe("warn");
		expect(bySeverity["surface-b/b.md"]).toBe("error");
	});
});

test("surface severity `off`: the rule never runs on that surface's documents, but still runs on the other", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/off-per-surface", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/off-per-surface", { severity: "error" }]]),
			[
				{
					root: "surface-a",
					rules: new Map([["test/off-per-surface", { severity: "off" }]]),
				},
				{ root: "surface-b" },
			],
		);

		await run(config, [rule]);

		expect(rule.calls.map((d) => d.path)).toEqual(["surface-b/b.md"]);
	});
});

test("a rule absent from the global config, enabled only via one surface's severity, runs only on that surface", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const rule = makeFileRule("test/only-on-surface", async () => []);
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([["test/only-on-surface", { severity: "error" }]]),
			},
			{ root: "surface-b" },
		]);

		await run(config, [rule]);

		expect(rule.calls.map((d) => d.path)).toEqual(["surface-a/a.md"]);
	});
});

test("a surface entry with only VALID `options` on a rule that is off globally leaves it off — options for a disabled rule are inert, but still validated", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");

		// A schema that ACCEPTS `{ whatever: true }`: validation now happens ahead of the
		// severity gate and succeeds silently, so it is the severity gate alone — this
		// rule is off everywhere — that keeps the rule from ever running. Matches loadConfig's
		// own validation of an inert override's options (see checkRuleOptions): the engine's
		// backstop must neither accept nor reject something differently from the real pipeline.
		const schema = z.strictObject({ whatever: z.boolean() });
		const rule = makeFileRule<{ whatever: boolean }>(
			"test/inert-options",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([
					["test/inert-options", { options: { whatever: true } }],
				]),
			},
		]);

		await run(config, [rule]);

		expect(rule.calls.length).toBe(0);
	});
});

/**
 * The companion of the test above, now that validates an inert override's options ahead
 * of the severity gate: a rule that is off everywhere must still fail the run when the options
 * written for it are actually invalid, exactly as `loadConfig` already does — a rule "enabled
 * nowhere" is not license to ignore a config mistake nobody would ever see take effect, because
 * that is precisely how a typo survives an `off` that gets deleted later.
 */
test("a surface entry with INVALID `options` on a rule that is off globally is a ConfigError, not a silent skip", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");

		// No optionsSchema at all: the rule takes no options, so any override options blob is
		// invalid regardless of whether the rule ends up enabled anywhere.
		const rule = makeFileRule("test/inert-invalid-options", async () => []);
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([
					["test/inert-invalid-options", { options: { whatever: true } }],
				]),
			},
		]);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems[0]?.message).toBe(
			'surfaces[0] ("surface-a"): rule "test/inert-invalid-options" accepts no options',
		);
	});
});

test("surface options REPLACE the global blob wholesale: a field the surface does not write falls back to the schema default, not the global value", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			max: z.number().default(500),
			flag: z.boolean().default(false),
		});
		const seen: Record<string, unknown> = {};
		const rule = makeFileRule<{ max: number; flag: boolean }>(
			"test/replace-not-merge",
			async (doc, ctx) => {
				seen[doc.path] = ctx.options;
				return [];
			},
			{ optionsSchema: schema },
		);

		const config = makeConfig(
			dir,
			new Map([
				[
					"test/replace-not-merge",
					{ severity: "error", options: { max: 10, flag: true } },
				],
			]),
			[
				{ root: "surface-a" },
				{
					root: "surface-b",
					rules: new Map([
						["test/replace-not-merge", { options: { max: 20 } }],
					]),
				},
			],
		);

		await run(config, [rule]);

		expect(seen["surface-a/a.md"]).toEqual({ max: 10, flag: true });
		expect(seen["surface-b/b.md"]).toEqual({ max: 20, flag: false });
	});
});

test('invalid surface options produce a ConfigError problem prefixed with the surface descriptor (`surfaces[i] ("root")`)', async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const rule = makeFileRule<{ flag: boolean }>(
			"test/opts-surface-invalid",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([
				[
					"test/opts-surface-invalid",
					{ severity: "warn", options: { flag: true } },
				],
			]),
			[
				{
					root: "surface-a",
					rules: new Map([
						["test/opts-surface-invalid", { options: { flag: "nope" } }],
					]),
				},
			],
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(
			err.problems.some((p) =>
				p.message.startsWith(
					'surfaces[0] ("surface-a"): rule "test/opts-surface-invalid"',
				),
			),
		).toBe(true);
	});
});

test("a bad GLOBAL options blob still produces the unprefixed message (no surface descriptor)", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const rule = makeFileRule<{ flag: boolean }>(
			"test/opts-global-invalid",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([
				[
					"test/opts-global-invalid",
					{ severity: "warn", options: { flag: "nope" } },
				],
			]),
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(
			err.problems.some((p) =>
				p.message.startsWith('rule "test/opts-global-invalid"'),
			),
		).toBe(true);
		expect(err.problems.some((p) => p.message.includes("surfaces["))).toBe(
			false,
		);
	});
});

/**
 * `globalFailed` exists precisely to avoid this: the run is already going to fail on the bad
 * global blob, so a surface that also writes its own (also bad) override for the same id must
 * not add a second, near-duplicate problem — the per-id loop skips a `globalFailed` id before it
 * ever looks at that surface's override.
 */
test("a rule with a bad GLOBAL options blob AND a bad surface override produces exactly one problem, not two", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const rule = makeFileRule<{ flag: boolean }>(
			"test/global-failed-once",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([
				[
					"test/global-failed-once",
					{ severity: "error", options: { flag: "nope" } },
				],
			]),
			[
				{
					root: "surface-a",
					rules: new Map([
						["test/global-failed-once", { options: { flag: "also-nope" } }],
					]),
				},
			],
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toContain(
			'rule "test/global-failed-once"',
		);
	});
});

/**
 * Pins the determinism the function's own JSDoc claims: "surfaces are processed in config
 * order and each surface's rule ids in sorted order". Two rule ids are chosen out of
 * alphabetical order (`zzz` before `aaa`, as written into each surface's `Map`) so a bug that
 * dropped the `.sort()` on `allIds` would still pass a test built with already-sorted ids.
 */
test("two surfaces each with a bad override for the same two rule ids produce four problems: config order across surfaces, sorted rule-id order within each", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const schema = z.strictObject({ flag: z.boolean() });
		const zzzRule = makeFileRule<{ flag: boolean }>(
			"test/zzz-bad",
			async () => [],
			{ optionsSchema: schema },
		);
		const aaaRule = makeFileRule<{ flag: boolean }>(
			"test/aaa-bad",
			async () => [],
			{ optionsSchema: schema },
		);
		const badOverride = { options: { flag: "nope" } };
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([
					["test/zzz-bad", badOverride],
					["test/aaa-bad", badOverride],
				]),
			},
			{
				root: "surface-b",
				rules: new Map([
					["test/zzz-bad", badOverride],
					["test/aaa-bad", badOverride],
				]),
			},
		]);

		const err = await catchConfigError(run(config, [zzzRule, aaaRule]));

		expect(err.problems.length).toBe(4);
		expect(
			err.problems[0]?.message.startsWith(
				'surfaces[0] ("surface-a"): rule "test/aaa-bad"',
			),
		).toBe(true);
		expect(
			err.problems[1]?.message.startsWith(
				'surfaces[0] ("surface-a"): rule "test/zzz-bad"',
			),
		).toBe(true);
		expect(
			err.problems[2]?.message.startsWith(
				'surfaces[1] ("surface-b"): rule "test/aaa-bad"',
			),
		).toBe(true);
		expect(
			err.problems[3]?.message.startsWith(
				'surfaces[1] ("surface-b"): rule "test/zzz-bad"',
			),
		).toBe(true);
	});
});

/**
 * driven through the REAL pipeline (`loadConfig` + `runEngine`), not a
 * hand-built `ResolvedConfig`: a rule set to `off` globally with `options: { max: 7 }`,
 * re-enabled by a surface writing only a bare severity, must observe `max: 7` — not the schema
 * default (`500`) `ResolvedRule` would have handed out before `ResolvedConfig.ruleOptions`
 * existed to carry an `off` rule's options through to the surface layer.
 */
test("a globally-off rule's options survive into a surface that re-enables it via a bare severity", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(join(dir, "skills", "SKILL.md"), "Body\n", "utf8");
		await writeFile(
			join(dir, "skillslurp.json"),
			JSON.stringify({
				extends: [],
				rules: { "test/maxy": { severity: "off", options: { max: 7 } } },
				surfaces: [{ root: "skills", rules: { "test/maxy": "error" } }],
			}),
			"utf8",
		);

		const schema = z.strictObject({ max: z.number().default(500) });
		const seen: number[] = [];
		const rule = makeFileRule<{ max: number }>(
			"test/maxy",
			async (_doc, ctx) => {
				seen.push(ctx.options.max);
				return [];
			},
			{ optionsSchema: schema, tiers: [] },
		);

		const config = await loadConfig(dir, [rule]);
		await runEngine(config, [rule]);

		expect(seen).toEqual([7]);
	});
});

/**
 * `validateRuleOptions` used `options ?? {}`, so a hand-built `ResolvedConfig`
 * with a literal `options: null` was silently treated as `{}` — disagreeing with `loadConfig`'s
 * `checkRuleOptions`, which uses `options === undefined ? {} : options` on purpose (`options:`
 * with nothing after it is a mistake worth reporting, not a synonym for omitting the key). Driven
 * through a hand-built config (not `loadConfig`, which already rejects `null` earlier and would
 * never let one reach the engine) — exactly the caller this backstop exists for.
 */
test("the engine backstop rejects `options: null` on a globally-enabled rule, matching loadConfig", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({ max: z.number().default(500) });
		const rule = makeFileRule<{ max: number }>(
			"test/null-options",
			async () => [],
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/null-options", { severity: "error", options: null }]]),
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems[0]?.message).toBe(
			'rule "test/null-options" options: Invalid input: expected object, received null',
		);
	});
});

test("a surface-overridden context's options are deep-frozen too: a rule that mutates them throws", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");

		const schema = z.strictObject({
			allowed: z.array(z.string()).default(["x"]),
		});
		let pushThrew = false;
		const rule = makeFileRule<{ allowed: string[] }>(
			"test/mutate-surface-options",
			async (_doc, ctx) => {
				try {
					ctx.options.allowed.push("poison");
				} catch {
					pushThrew = true;
				}
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([
					[
						"test/mutate-surface-options",
						{ severity: "error", options: { allowed: ["a"] } },
					],
				]),
			},
		]);

		await run(config, [rule]);

		expect(pushThrew).toBe(true);
	});
});

test("two surfaces that do not override a rule share the identical (===) frozen global options object", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const schema = z.strictObject({ max: z.number().default(500) });
		const seenOptions: unknown[] = [];
		const rule = makeFileRule<{ max: number }>(
			"test/shared-options",
			async (_doc, ctx) => {
				seenOptions.push(ctx.options);
				return [];
			},
			{ optionsSchema: schema },
		);
		const config = makeConfig(
			dir,
			new Map([["test/shared-options", { severity: "error" }]]),
			[{ root: "surface-a" }, { root: "surface-b" }],
		);

		await run(config, [rule]);

		expect(seenOptions.length).toBe(2);
		expect(Object.is(seenOptions[0], seenOptions[1])).toBe(true);
	});
});

// --- project/scan dispatch --------------------------------------------------------------

test("a hand-written ProjectRule stub is dispatched and its report becomes a diagnostic carrying the reported `file`", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeProjectRule("test/project-stub", async () => [
			{ message: "project violation", file: "a.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/project-stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(diagnostics.length).toBe(1);
		const [only] = diagnostics;
		if (!only) throw new Error("expected one diagnostic");
		expect(only.file).toBe("a.md");
		expect(only.message).toBe("project violation");
		expect(only.ruleId).toBe("test/project-stub");
		expect(only.severity).toBe("error");
	});
});

test("a hand-written ScanRule stub is dispatched and its report becomes a diagnostic carrying the reported `file`", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeScanRule("test/scan-stub", async () => [
			{ message: "scan violation", file: "a.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/scan-stub", { severity: "warn" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(diagnostics.length).toBe(1);
		const [only] = diagnostics;
		if (!only) throw new Error("expected one diagnostic");
		expect(only.file).toBe("a.md");
		expect(only.message).toBe("scan violation");
		expect(only.ruleId).toBe("test/scan-stub");
		expect(only.severity).toBe("warn");
	});
});

test("ctx.surface is the identity of the surface a project rule is enabled on, and scopes ctx.documents() to that surface's own documents", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		let seenPaths: string[] = [];
		const rule = makeProjectRule("test/surface-scope", async (ctx) => {
			const docs = await ctx.documents();
			seenPaths = docs
				.filter((doc) => doc.surface === ctx.surface)
				.map((doc) => doc.path);
			return [];
		});
		// Enabled via one surface's own severity only (not the global layer), so the rule runs
		// exactly once and there is exactly one `ctx.surface` to assert identity against.
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([["test/surface-scope", { severity: "error" }]]),
			},
			{ root: "surface-b" },
		]);

		await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(rule.calls[0]?.surface).toBe(config.surfaces[0]);
		expect(seenPaths).toEqual(["surface-a/a.md"]);
	});
});

test("a project rule enabled on two surfaces is invoked twice, once per surface, each call's ctx.surface matching the surface it ran for (the accepted per-surface-dispatch quirk)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const rule = makeProjectRule("test/two-surfaces", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/two-surfaces", { severity: "error" }]]),
			[{ root: "surface-a" }, { root: "surface-b" }],
		);

		await run(config, [rule]);

		expect(rule.calls.length).toBe(2);
		expect(rule.calls[0]?.surface).toBe(config.surfaces[0]);
		expect(rule.calls[1]?.surface).toBe(config.surfaces[1]);
	});
});

// --- two surfaces sharing a rule that reports something surface-independent must not
// double the diagnostic count for one violation ---

test("two surfaces sharing one project rule at the same severity collapse a surface-independent, byte-identical report into a single Diagnostic", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		// Deliberately reports the SAME `file`/`loc`/`message` regardless of which surface is
		// being checked — the shape `index/no-missing-targets` actually produces (`file`: the configured
		// index path, `loc`: the link's own position, neither derived from `ctx.surface`), which
		// is the false premise this dedupe corrects: "no built-in rule creates this case".
		const rule = makeProjectRule("test/dup-report", async () => [
			{ message: "duplicate", file: "SHARED.md", loc: { line: 3, col: 3 } },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/dup-report", { severity: "error" }]]),
			[{ root: "surface-a" }, { root: "surface-b" }],
		);

		const diagnostics = await run(config, [rule]);

		// The rule really was dispatched twice — the collapse happens to the
		// two byte-identical DIAGNOSTICS it produced, not to the dispatch itself.
		expect(rule.calls.length).toBe(2);
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0]?.message).toBe("duplicate");
		expect(diagnostics[0]?.file).toBe("SHARED.md");
	});
});

test("two surfaces reporting the identical file/loc/message at DIFFERENT severities are NOT collapsed — they disagree on one field", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "surface-a"));
		await mkdir(join(dir, "surface-b"));
		await writeFile(join(dir, "surface-a", "a.md"), "Body\n", "utf8");
		await writeFile(join(dir, "surface-b", "b.md"), "Body\n", "utf8");

		const rule = makeProjectRule("test/dup-report-diff-severity", async () => [
			{ message: "duplicate", file: "SHARED.md", loc: { line: 3, col: 3 } },
		]);
		const config = makeConfig(dir, new Map(), [
			{
				root: "surface-a",
				rules: new Map([
					["test/dup-report-diff-severity", { severity: "error" }],
				]),
			},
			{
				root: "surface-b",
				rules: new Map([
					["test/dup-report-diff-severity", { severity: "warn" }],
				]),
			},
		]);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(2);
		expect(diagnostics.length).toBe(2);
		expect(diagnostics.map((d) => d.severity).sort()).toEqual([
			"error",
			"warn",
		]);
	});
});

test("a project rule enabled on zero surfaces is never invoked", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		// Absent from both the global `rules` map and every surface's own `rules` map — never a
		// key of `allIds`, so it never gets a severity anywhere.
		const rule = makeProjectRule("test/zero-surfaces", async () => []);
		const config = makeConfig(dir, new Map());

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(0);
		expect(diagnostics.length).toBe(0);
	});
});

test('a project rule reporting without `file` fails the run through the crash path, naming the rule id and the surface (surfaces[0] ("."))', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeProjectRule("test/no-file", async () => [
			{ message: "oops, no file" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/no-file", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/no-file");
		expect(caught.message).toContain('surfaces[0] (".")');
		expect(caught.cause).toBeInstanceOf(Error);
		expect((caught.cause as Error).message).toContain("test/no-file");
		expect((caught.cause as Error).message).toContain("no file");
	});
});

test('a project rule reporting an escaping `file` ("../outside.md") still throws via `escapesRepoPosix`, same as a file rule', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule = makeProjectRule("test/escaping-project-file", async () => [
			{ message: "oops", file: "../outside.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/escaping-project-file", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/escaping-project-file");
		expect(caught.cause).toBeInstanceOf(Error);
		expect((caught.cause as Error).message).toContain("../outside.md");
	});
});

test("a project rule whose check throws is caught and rethrown naming the rule id and the surface, chaining the original as cause", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const original = new Error("project boom");
		const rule: Rule = {
			kind: "project",
			meta: { id: "test/project-throws", ...STUB_META },
			check: () => {
				throw original;
			},
		};
		const config = makeConfig(
			dir,
			new Map([["test/project-throws", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/project-throws");
		expect(caught.message).toContain('surfaces[0] (".")');
		expect(caught.cause).toBe(original);
	});
});

test("a project rule check that returns a non-array at runtime produces a distinct, single-message error naming the rule id and the surface — not double-wrapped", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "Body\n", "utf8");

		const rule: Rule = {
			kind: "project",
			meta: { id: "test/project-non-array", ...STUB_META },
			check: async () => undefined as unknown as RuleReport[],
		};
		const config = makeConfig(
			dir,
			new Map([["test/project-non-array", { severity: "error" }]]),
		);

		let caught: unknown;
		try {
			await run(config, [rule]);
		} catch (err) {
			caught = err;
		}

		if (!(caught instanceof Error))
			throw new Error("expected runEngine to reject");
		expect(caught.message).toContain("test/project-non-array");
		expect(caught.message).toContain("non-array");
		expect(caught.message).toContain('surfaces[0] (".")');
		// Exactly one Error, not the generic "crashed while checking ..." wrapper around a
		// second, near-identical inner message — same shape as the file-rule version of this
		// test (see runEngine's doc comment, point 7).
		expect(caught.cause).toBeUndefined();
	});
});

test("a document with broken frontmatter yaml still lets a project rule for its surface run: the skip is a file-rule-only skip, not a surface-wide one", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "broken.md"),
			"---\nname: [unclosed\n---\n",
			"utf8",
		);

		const rule = makeProjectRule("test/project-despite-broken-fm", async () => [
			{ message: "project ran", file: "broken.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/project-despite-broken-fm", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(
			diagnostics.some((d) => d.ruleId === "test/project-despite-broken-fm"),
		).toBe(true);
		expect(diagnostics.some((d) => d.ruleId === "parse/frontmatter")).toBe(
			true,
		);
	});
});

test("diagnostics from the second (project/scan) loop are merged into the same single, sorted list as file-rule diagnostics — an interleaved file order proves it, not just both being present", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "b.md"), "Body\n", "utf8");

		const fileRule = makeFileRule("test/file-b", async () => [
			{ message: "file rule violation" },
		]);
		const projectRule = makeProjectRule("test/project-ac", async () => [
			{ message: "project violation a", file: "a.md" },
			{ message: "project violation c", file: "c.md" },
		]);
		const config = makeConfig(
			dir,
			new Map([
				["test/file-b", { severity: "error" }],
				["test/project-ac", { severity: "error" }],
			]),
		);

		const diagnostics = await run(config, [fileRule, projectRule]);

		expect(diagnostics.map((d) => d.file)).toEqual(["a.md", "b.md", "c.md"]);
	});
});

// ---------------------------------------------------------------------------
// A rule can report a config-shaped problem (`ConfigReport`)
// ---------------------------------------------------------------------------

test("a ConfigReport becomes config/<problem> at error, against the config file, positioned at the surface's own yaml loc", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		const rule = makeProjectRule("test/config-report", async () => [
			{
				problem: "stale-allowlist",
				message: "entry no longer matches anything",
			},
		]);
		const config = makeConfig(
			dir,
			// `warn`, deliberately: the diagnostic below must still be `error`. A stale allowlist
			// entry is "itself an error" unconditionally, which is the whole reason severity is not
			// the rule's to pick.
			new Map([["test/config-report", { severity: "warn" as const }]]),
			[{ root: ".", loc: { line: 7, col: 5 } }],
		);

		const diagnostics = await run(config, [rule]);

		expect(diagnostics).toEqual([
			{
				ruleId: "config/stale-allowlist",
				severity: "error",
				message: "entry no longer matches anything",
				file: "skillslurp.json",
				line: 7,
				col: 5,
				fixable: false,
				docsUrl: DOCS_URL,
			},
		]);
		// Exit 1, not 2: nothing threw, and this is an `error`-severity diagnostic in the
		// run's normal list, so `computeExitCode` reads it exactly like a rule violation.
		expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
	});
});

test("a surface with no yaml behind it (auto-detected) yields a ConfigReport with no position at all", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		const rule = makeProjectRule("test/config-report-noloc", async () => [
			{ problem: "missing-file", message: "no such file" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/config-report-noloc", { severity: "error" as const }]]),
		);

		const [diagnostic] = await run(config, [rule]);

		// Not `line: undefined` — no `line` key at all, the property the json reporter's
		// contract is pinned on (`locFields`, diagnostic.ts).
		expect(diagnostic && "line" in diagnostic).toBe(false);
		expect(diagnostic?.ruleId).toBe("config/missing-file");
	});
});

test("a ConfigReport may name its own file and loc, overriding both engine defaults", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		// The shape `docs/contract-sync` needs: the problem is in a configured DOCUMENT,
		// at a specific block, not in the config yaml.
		const rule = makeProjectRule("test/config-report-own-file", async () => [
			{
				problem: "malformed-block",
				message: "contract block is not valid yaml",
				file: "./docs/CONTRACT.md",
				loc: { line: 12, col: 3 },
			},
		]);
		const config = makeConfig(
			dir,
			new Map([
				["test/config-report-own-file", { severity: "error" as const }],
			]),
			[{ root: ".", loc: { line: 7, col: 5 } }],
		);

		const [diagnostic] = await run(config, [rule]);

		// `./docs/CONTRACT.md` normalized to `docs/CONTRACT.md`, the same `normalizeReportFile`
		// pass a `RuleReport.file` goes through — a config problem gets no laxer path contract.
		expect(diagnostic?.file).toBe("docs/CONTRACT.md");
		expect(diagnostic?.line).toBe(12);
		expect(diagnostic?.col).toBe(3);
	});
});

test("a ConfigReport from a FILE rule takes the same path — never the document under check", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		// No built-in `file` rule reports one today. Routed through `toConfigDiagnostic` anyway
		// so the first one that does cannot silently get `toDiagnostic`'s `docPath` fallback,
		// which would file a config problem against whichever document happened to be in hand.
		const rule = makeFileRule("test/file-config-report", async () => [
			{ problem: "missing-file", message: "no such file" },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/file-config-report", { severity: "error" as const }]]),
		);

		const [diagnostic] = await run(config, [rule]);

		expect(diagnostic?.ruleId).toBe("config/missing-file");
		expect(diagnostic?.file).toBe("skillslurp.json");
	});
});

test("an ill-formed `problem` is a rule bug, not a diagnostic", async () => {
	for (const problem of ["", "../etc", "Stale-Allowlist", "stale allowlist"]) {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "a.md"), "# A\n", "utf8");
			const rule = makeProjectRule("test/bad-problem", async () => [
				{ problem, message: "x" },
			]);
			const config = makeConfig(
				dir,
				new Map([["test/bad-problem", { severity: "error" as const }]]),
			);

			// Wrapped by the same crash path as a throwing `check` (`ruleCrashErrorForSurface`),
			// so it surfaces at exit 2 as a rule bug — a `Diagnostic.ruleId` is user-facing and
			// machine-read, and `config/../etc` is neither lookupable nor safe to key a baseline
			// on.
			await expect(run(config, [rule])).rejects.toThrow(
				/test\/bad-problem.*crashed/,
			);
		});
	}
});

test("`problem` present but undefined is rejected, not silently treated as an ordinary report", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		// Exactly the object CLAUDE.md's "never build `{ key: maybeUndefined }`" habit warns
		// about, and the reason `isConfigReport` discriminates on the KEY: the alternative test
		// (`typeof report.problem === "string"`) would let this through as a `RuleReport`,
		// reporting it under the rule's own id at the rule's own severity — the exact framing
		// the rule was trying not to use. The cast is how a plain JS consumer reaches this;
		// `problem?: never` on `RuleReport` makes it a compile error for everyone else.
		const rule = makeProjectRule("test/undefined-problem", async () => [
			{
				problem: undefined,
				message: "x",
				file: "a.md",
			} as unknown as RuleReport,
		]);
		const config = makeConfig(
			dir,
			new Map([["test/undefined-problem", { severity: "error" as const }]]),
		);

		await expect(run(config, [rule])).rejects.toThrow(
			/test\/undefined-problem.*crashed/,
		);
	});
});

test("runEngine scopes the grep corpus with the run's real configFile, baselineFile and ignore list", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		await writeFile(
			join(dir, "skillslurp.json"),
			"# CORPUS-PROBE-TOKEN\n",
			"utf8",
		);
		// `runEngine` derives `CorpusScope.baselineFile` from `config.root` itself —
		// nothing else in the engine reads the baseline, so this grep is the only thing that can
		// show the field is really being set rather than left to a default.
		await writeFile(
			join(dir, "skillslurp-baseline.json"),
			'{"version":1,"files":{"a.md":{"r/x":{"CORPUS-PROBE-TOKEN":1}}}}\n',
			"utf8",
		);
		await mkdir(join(dir, "vendor"), { recursive: true });
		await writeFile(
			join(dir, "vendor", "v.md"),
			"CORPUS-PROBE-TOKEN\n",
			"utf8",
		);
		await writeFile(join(dir, "kept.md"), "CORPUS-PROBE-TOKEN\n", "utf8");
		await gitInitAndCommit(dir);

		// `createCapabilities`'s `scope` argument is optional (several dozen test call sites omit
		// it), so this is the test that keeps the optionality from quietly becoming the
		// production path: it fails the moment `runEngine` stops passing a real one.
		const seen: string[] = [];
		const rule = makeScanRule("test/corpus-scope", async (ctx) => {
			for (const hit of await ctx.grep(/CORPUS-PROBE-TOKEN/)) {
				seen.push(hit.file);
			}
			return [];
		});
		const config: ResolvedConfig = {
			...makeConfig(
				dir,
				new Map([["test/corpus-scope", { severity: "error" as const }]]),
			),
			ignore: ["vendor/**"],
		};

		await run(config, [rule]);

		expect(seen).toEqual(["kept.md"]);
	});
});

// ---------------------------------------------------------------------------
// `--diff-base <ref>`: `EngineOptions.diffBase` narrows the per-document
// loop to the documents committed since `<ref>`, and nothing else.
// ---------------------------------------------------------------------------

test("diffBase: of two documents each carrying a file-rule violation, only the one committed since the base is linted", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("original a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("original b"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "a.md"), doc("edited a"), "utf8");
		await commitAll(dir, "edit a");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		// The control: without the option both documents are linted, so the assertion below is
		// about the option and not about a fixture that only ever had one document in it.
		expect((await run(config, [rule])).map((d) => d.file)).toEqual([
			"a.md",
			"b.md",
		]);
		rule.calls.length = 0;

		const diagnostics = await run(config, [rule], { diffBase: base });

		expect(diagnostics.map((d) => d.file)).toEqual(["a.md"]);
		expect(rule.calls.map((d) => d.path)).toEqual(["a.md"]);
	});
});

// The one test that pins the THREE-dot range. Two-dot (`<base>..HEAD`) is a plain
// tree comparison, so every file the base branch changed after the fork point reads as "changed
// by this branch" and gets linted; three-dot (`<base>...HEAD`) diffs from the merge base and
// does not. The fixture below is built so the two answers differ: `main` moves on after
// `feature` branches off it.
test("diffBase: a base branch that has moved on since the fork contributes nothing — the range is three-dot, diffed from the merge base", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("original a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("original b"), "utf8");
		await gitInitAndCommit(dir);

		await git(dir, ["checkout", "--quiet", "-b", "feature"]);
		await writeFile(join(dir, "a.md"), doc("feature edits a"), "utf8");
		await commitAll(dir, "feature edits a");

		await git(dir, ["checkout", "--quiet", "main"]);
		await writeFile(join(dir, "b.md"), doc("main edits b"), "utf8");
		await commitAll(dir, "main edits b");

		await git(dir, ["checkout", "--quiet", "feature"]);

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule], { diffBase: "main" });

		// `b.md` is what tells the two ranges apart: `main` changed it after the fork, so a
		// two-dot range reports it as changed here even though this branch never touched it.
		expect(diagnostics.map((d) => d.file)).toEqual(["a.md"]);
		expect(rule.calls.map((d) => d.path)).toEqual(["a.md"]);
	});
});

test("diffBase: with zero changed documents the file rules are silent, the project rule still reports over the complete document list, and the run still exits 1", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("b"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		// A file that is not a document at all: the commit is real, but nothing discovery
		// produced is in it.
		await writeFile(join(dir, "notes.txt"), "not a document\n", "utf8");
		await commitAll(dir, "add notes.txt");

		const fileRule = makeFileRule("test/file", (d) => [
			{ message: `file rule saw ${d.path}` },
		]);
		// Stands in for `index/complete`: it reports on documents it reads out of
		// `ctx.documents()`, so it goes blind the moment that list is what gets narrowed.
		const projectRule = makeProjectRule("test/project", async (ctx) =>
			(await ctx.documents()).map((d) => ({
				file: d.path,
				message: `project rule saw ${d.path}`,
			})),
		);
		const config = makeConfig(
			dir,
			new Map([
				["test/file", { severity: "error" }],
				["test/project", { severity: "error" }],
			]),
		);

		const diagnostics = await run(config, [fileRule, projectRule], {
			diffBase: base,
		});

		expect(fileRule.calls).toEqual([]);
		expect(diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
			["test/project", "a.md"],
			["test/project", "b.md"],
		]);
		expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
	});
});

test("diffBase: an unchanged document with a duplicate frontmatter key produces no parse/frontmatter diagnostic — the short-circuit is inside the skipped loop body", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "broken.md"),
			"---\nname: one\nname: two\n---\n\nBody.\n",
			"utf8",
		);
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "a.md"), doc("edited a"), "utf8");
		await commitAll(dir, "edit a");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		// The control: the duplicate key really is a parse error, so the absence asserted below
		// is the option's doing and not a fixture that never had one.
		const full = await run(config, [rule]);
		expect(full.map((d) => d.ruleId)).toContain("parse/frontmatter");

		const diagnostics = await run(config, [rule], { diffBase: base });

		expect(diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
			["test/stub", "a.md"],
		]);
	});
});

test("diffBase: a document added since the base is linted", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "new.md"), doc("brand new"), "utf8");
		await commitAll(dir, "add new.md");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule], { diffBase: base });

		expect(diagnostics.map((d) => d.file)).toEqual(["new.md"]);
	});
});

test("diffBase: a document renamed since the base is linted at its NEW path", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "keep.md"), doc("keep"), "utf8");
		await writeFile(
			join(dir, "orig.md"),
			doc("line one\nline two\nline three\nline four\nline five"),
			"utf8",
		);
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await git(dir, ["mv", "orig.md", "renamed.md"]);
		await commitAll(dir, "rename orig.md");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule], { diffBase: base });

		// A rename arrives as ONE `ChangedFile` at the new path (`parseNameStatusZ`), so the
		// document is linted where it now lives — and `keep.md`, untouched, is not.
		expect(diagnostics.map((d) => d.file)).toEqual(["renamed.md"]);
	});
});

test("diffBase: a document deleted since the base does not crash the run, and a project rule still reports about it", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await writeFile(join(dir, "gone.md"), doc("gone"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await rm(join(dir, "gone.md"));
		await commitAll(dir, "delete gone.md");

		const fileRule = makeFileRule("test/file", (d) => [
			{ message: `file rule saw ${d.path}` },
		]);
		// Stands in for `index/no-missing-targets`: it reports about a path that no longer exists, which
		// only a rule running in full can notice.
		const projectRule = makeProjectRule("test/project", () => [
			{ file: "a.md", message: 'index still links "gone.md"' },
		]);
		const config = makeConfig(
			dir,
			new Map([
				["test/file", { severity: "error" }],
				["test/project", { severity: "error" }],
			]),
		);

		const diagnostics = await run(config, [fileRule, projectRule], {
			diffBase: base,
		});

		// The deleted path is dropped from the changed set, and `a.md` was not touched, so no
		// file rule runs at all — while the project rule's report survives.
		expect(fileRule.calls).toEqual([]);
		expect(diagnostics.map((d) => [d.ruleId, d.message])).toEqual([
			["test/project", 'index still links "gone.md"'],
		]);
	});
});

test("diffBase: a scan rule still sees the whole corpus — a hit in an UNCHANGED file is reported", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await writeFile(join(dir, "README.md"), doc("DANGLING-PROBE here"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "a.md"), doc("edited a"), "utf8");
		await commitAll(dir, "edit a");

		const scanRule = makeScanRule("test/scan", async (ctx) =>
			(await ctx.grep(/DANGLING-PROBE/)).map((hit) => ({
				file: hit.file,
				message: `found in ${hit.file}`,
			})),
		);
		const config = makeConfig(
			dir,
			new Map([["test/scan", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [scanRule], { diffBase: base });

		// `README.md` was not committed in this range. It is reported anyway: narrowing the scan
		// corpus would be a second meaning for one flag, and the baseline is the tool for
		// pre-existing findings.
		expect(diagnostics.map((d) => [d.file, d.message])).toEqual([
			["README.md", "found in README.md"],
		]);
	});
});

test("diffBase: an uncommitted working-tree edit is not a change — committed-only, Biome's posture", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("b"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "a.md"), doc("committed edit"), "utf8");
		await commitAll(dir, "edit a");

		// Edited on disk and left there: not staged, not committed.
		await writeFile(join(dir, "b.md"), doc("uncommitted edit"), "utf8");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const diagnostics = await run(config, [rule], { diffBase: base });

		expect(diagnostics.map((d) => d.file)).toEqual(["a.md"]);
	});
});

test("diffBase: the result's changedDocuments equals the number of documents that survived the filter", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("b"), "utf8");
		await writeFile(join(dir, "c.md"), doc("c"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		await writeFile(join(dir, "a.md"), doc("edited a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("edited b"), "utf8");
		// A changed path that is NOT a document: the count is discovery ∩ diff, not the diff.
		await writeFile(join(dir, "notes.txt"), "not a document\n", "utf8");
		await commitAll(dir, "edit a and b, add notes.txt");

		const rule = makeFileRule("test/stub", () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const result = await runEngine(config, [rule], { diffBase: base });

		expect(result.changedDocuments).toBe(2);
	});
});

test("no diffBase: the result carries no own changedDocuments key", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);

		const rule = makeFileRule("test/stub", () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const result = await runEngine(config, [rule]);

		expect(Object.hasOwn(result, "changedDocuments")).toBe(false);
	});
});

test("runEngine's result, and its diagnostics array, are both frozen", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);

		const rule = makeFileRule("test/stub", () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		const result = await runEngine(config, [rule]);

		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.diagnostics)).toBe(true);
	});
});

test("diffBase: an unknown ref fails the run with git's own error, naming the ref", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);

		const rule = makeFileRule("test/stub", () => []);
		const config = makeConfig(
			dir,
			new Map([["test/stub", { severity: "error" }]]),
		);

		await expect(
			run(config, [rule], { diffBase: "no-such-ref" }),
		).rejects.toThrow(/no-such-ref/);
	});
});

// `changedDocumentPaths` (engine.ts) now compares both sides Unicode
// NFC-normalized. `core.precomposeunicode` (git's macOS default; `gitInitAndCommit` neutralizes
// only `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, so a repo-local default still applies) makes
// `git diff --name-status -z` report an NFC-precomposed path, while discovery's `readdir` yields
// whatever bytes the directory was actually created with — NFD here, on purpose. Without the
// fix, the two spellings of "café" never compare equal and the document is silently dropped from
// the diffBase-filtered run, the same way it was in the wild (linted by a full run, skipped
// under `--diff-base`). This only discriminates on a filesystem plus git configuration that
// precomposes (macOS default); on Linux both sides are already NFD and it passes with or
// without the fix — the pin is for the platform where the bug lives.
test("diffBase: a skill directory name stored NFD-decomposed on disk still matches git's NFC-precomposed diff output", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);

		// Written with the DECOMPOSED form on purpose: `readdir` returns exactly these bytes back
		// (verified: APFS does not force a normalization form on write), so this is what
		// `doc.path` carries downstream — unlike git's own report of the same path, below.
		const skillDir = "café".normalize("NFD");
		await mkdir(join(dir, skillDir));
		await writeFile(
			join(dir, skillDir, "SKILL.md"),
			[
				"---",
				"name: not-cafe",
				"description: exercises NFC/NFD path matching under --diff-base.",
				"---",
				"",
				"# Heading",
				"",
				"Body.",
				"",
			].join("\n"),
			"utf8",
		);
		await commitAll(dir, "add café skill");

		const rule = makeFileRule("test/stub", (d) => [
			{ message: `checked ${d.path}` },
		]);
		const config = makeConfig(
			dir,
			new Map([
				["test/stub", { severity: "error" }],
				["skill/name-matches-dir", { severity: "error" }],
			]),
		);

		const { diagnostics, changedDocuments } = await runEngine(
			config,
			[rule, nameMatchesDir],
			{ diffBase: base },
		);

		// The count is discovery ∩ diff: `a.md`, present since the base commit, does not count —
		// only the café skill, added since, does.
		expect(changedDocuments).toBe(1);
		// The stub file rule actually ran on it — the loop did not `continue` past it as
		// "unchanged".
		expect(rule.calls.map((d) => d.path)).toEqual([`${skillDir}/SKILL.md`]);
		// And the real rule this directory was built to trip — `name` ("not-cafe") deliberately
		// does not match the directory basename — fired, which it cannot do on a document the
		// loop skipped.
		expect(diagnostics.map((d) => d.ruleId)).toContain(
			"skill/name-matches-dir",
		);
	});
});

// ---------------------------------------------------------------------------
// `shape` rules are dispatched once per RUN, never once per surface; these go through
// `runEngine` with fake rules.
// ---------------------------------------------------------------------------

/** Three real surface directories, one document each. */
async function threeSurfaces(dir: string): Promise<SurfaceInput[]> {
	const roots = ["s1", "s2", "s3"];
	for (const root of roots) {
		await mkdir(join(dir, root));
		await writeFile(join(dir, root, "x.md"), "Body\n", "utf8");
	}
	return roots.map((root) => ({ root }));
}

test("shape: a rule enabled globally over three surfaces is called exactly once, with all three", async () => {
	await withTempDir(async (dir) => {
		const surfaces = await threeSurfaces(dir);
		const rule = makeShapeRule("test/shape", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/shape", { severity: "error" }]]),
			surfaces,
		);

		await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(rule.calls[0]?.surfaces.length).toBe(3);
	});
});

test("shape: a surface with zero files (no loc) still gets the shape rule dispatched, once", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "empty"));
		const rule = makeShapeRule("test/shape", async () => []);
		const config = makeConfig(
			dir,
			new Map([["test/shape", { severity: "error" }]]),
			[{ root: "empty" }],
		);

		await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(await rule.calls[0]?.documents()).toEqual([]);
	});
});

test("shape: a surface `rules` entry naming a repository-wide rule is a positioned ConfigError from loadConfig", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"));
		await writeFile(join(dir, "skills", "SKILL.md"), "Body\n", "utf8");
		const rule = makeShapeRule("test/shape", async () => []);
		const id = "test/shape";
		await writeFile(
			join(dir, "skillslurp.json"),
			[
				"{",
				'  "extends": [],',
				'  "surfaces": [',
				"    {",
				'      "root": "skills",',
				'      "rules": {',
				`        "${id}": "error"`,
				"      }",
				"    }",
				"  ]",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		const err = await catchConfigError(loadConfig(dir, [rule]));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toBe(
			`rule "${id}" is repository-wide and must be configured in the top-level "rules", not on a surface`,
		);
		// the `"<id>"` key itself: quotes included, starting at column 9
		expect(err.problems[0]?.loc).toEqual({
			line: 7,
			col: 9,
			endLine: 7,
			endCol: 9 + id.length + 2,
		});
		expect(rule.calls.length).toBe(0);
	});
});

test("shape: the engine backstop rejects a surface `rules` entry naming a repository-wide rule in a hand-built config", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"));
		await writeFile(join(dir, "skills", "x.md"), "Body\n", "utf8");
		const rule = makeShapeRule("test/shape", async () => []);
		const id = "test/shape";
		const config = makeConfig(dir, new Map([[id, { severity: "error" }]]), [
			{
				root: "skills",
				rules: new Map([[id, { severity: "off" }]]),
			},
		]);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems.map((p) => p.message)).toEqual([
			`surfaces[0] ("skills"): rule "${id}" is repository-wide and must be configured in the top-level "rules"`,
		]);
		expect(rule.calls.length).toBe(0);
	});
});

test("shape: a rule with no config entry (globally off) is not called", async () => {
	await withTempDir(async (dir) => {
		const surfaces = await threeSurfaces(dir);
		const rule = makeShapeRule("test/shape", async () => [
			{ message: "should never run", file: "s1/x.md" },
		]);
		const config = makeConfig(dir, new Map(), surfaces);

		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(0);
		expect(diagnostics.length).toBe(0);
	});
});

// Through `loadConfig`, because "a tier contributes `defaultSeverity`" is its job; the
// engine only ever sees the collapsed `config.rules` entry.
test("shape: a rule claiming the recommended tier is called once, at its own defaultSeverity", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"));
		await writeFile(join(dir, "skills", "SKILL.md"), "Body\n", "utf8");
		await writeFile(
			join(dir, "skillslurp.json"),
			JSON.stringify({
				extends: ["recommended"],
				surfaces: [{ root: "skills" }],
			}),
			"utf8",
		);
		const rule = makeShapeRule(
			"test/shape",
			async () => [{ message: "m", file: "skills/SKILL.md" }],
			{ tiers: ["recommended"], defaultSeverity: "warn" },
		);

		const config = await loadConfig(dir, [rule]);
		const diagnostics = await run(config, [rule]);

		expect(rule.calls.length).toBe(1);
		expect(diagnostics.map((d) => d.severity)).toEqual(["warn"]);
	});
});

test("shape: a top-level `rules` entry overrides the tier's severity, and is the only layer that can", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"));
		await writeFile(join(dir, "skills", "SKILL.md"), "Body\n", "utf8");
		await writeFile(
			join(dir, "skillslurp.json"),
			JSON.stringify({
				extends: ["recommended"],
				rules: { "test/shape": "error" },
				surfaces: [{ root: "skills" }],
			}),
			"utf8",
		);
		const rule = makeShapeRule(
			"test/shape",
			async () => [{ message: "m", file: "skills/SKILL.md" }],
			{ tiers: ["recommended"], defaultSeverity: "warn" },
		);

		const config = await loadConfig(dir, [rule]);
		const diagnostics = await run(config, [rule]);

		expect(diagnostics.map((d) => d.severity)).toEqual(["error"]);
	});
});

test('shape: a report without `file` is a rule crash naming the rule and "the repository"', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		const rule = makeShapeRule("test/shape", async () => [
			{ message: "no file" },
		]);
		const id = "test/shape";
		const config = makeConfig(dir, new Map([[id, { severity: "error" }]]));
		let caught: unknown;
		try {
			await runEngine(config, [rule]);
		} catch (err) {
			caught = err;
		}
		if (!(caught instanceof Error))
			throw new Error(`expected ${id} to crash the run`);
		expect(caught.message).toBe(
			`rule "${id}" crashed while checking the repository`,
		);
		const cause = caught.cause;
		if (!(cause instanceof Error))
			throw new Error(`expected ${id}'s crash to carry its cause`);
		expect(cause.message).toBe(
			`rule "${id}" reported no file while checking the repository: "file" is required on a "project"/"scan"/"shape" rule's report`,
		);
	});
});

/** Runs `body`'s engine call expecting a plain rejection; returns the `Error` it rejected with. */
async function catchRunError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof Error) {
			return err;
		}
		throw err;
	}
	throw new Error("expected the run to reject");
}

test('shape: a check that throws is a crash naming the rule and "the repository", chaining the original as cause', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		const original = new Error("boom");
		const rule = makeShapeRule("test/shape", async () => {
			throw original;
		});
		const id = "test/shape";
		const config = makeConfig(dir, new Map([[id, { severity: "error" }]]));

		const caught = await catchRunError(runEngine(config, [rule]));

		expect(caught.message).toBe(
			`rule "${id}" crashed while checking the repository`,
		);
		expect(caught.cause).toBe(original);
	});
});

test("shape: a check that returns a non-array is one distinct error, not double-wrapped", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		const rule: Rule = {
			kind: "shape",
			meta: { id: "test/shape", ...STUB_META },
			check: async () => undefined as unknown as Report[],
		};
		const id = "test/shape";
		const config = makeConfig(dir, new Map([[id, { severity: "error" }]]));

		const caught = await catchRunError(runEngine(config, [rule]));

		expect(caught.message).toBe(
			`rule "${id}" returned non-array while checking the repository: undefined`,
		);
		expect(caught.cause).toBeUndefined();
	});
});

test("shape: a ConfigReport becomes config/<problem> at error, against the config file, with no loc even when surfaces have one", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("a"), "utf8");
		const shapeRule = makeShapeRule("test/shape", async () => [
			{ problem: "stale-allowlist", message: "shape entry no longer matches" },
		]);
		const config = makeConfig(
			dir,
			// `warn`: the diagnostic must still be `error` — severity is not the rule's to pick.
			new Map([["test/shape", { severity: "warn" as const }]]),
			[{ root: ".", loc: { line: 7, col: 5 } }],
		);

		const diagnostics = await run(config, [shapeRule]);

		expect(diagnostics).toEqual([
			{
				ruleId: "config/stale-allowlist",
				severity: "error",
				message: "shape entry no longer matches",
				file: "skillslurp.json",
				fixable: false,
				docsUrl: DOCS_URL,
			},
		]);
		for (const diagnostic of diagnostics) {
			expect("line" in diagnostic).toBe(false);
			expect("col" in diagnostic).toBe(false);
		}
		expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
	});
});

// Through `loadConfig`, because `ResolvedConfig.surfaces` is frozen THERE; the engine
// hands the same array and the same surface objects straight through.
test("shape: ctx is frozen, carries surfaces and not surface, and ctx.surfaces[i] is config.surfaces[i]", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "one"));
		await mkdir(join(dir, "two"));
		await writeFile(join(dir, "one", "SKILL.md"), doc("a"), "utf8");
		await writeFile(join(dir, "two", "SKILL.md"), doc("b"), "utf8");
		await writeFile(
			join(dir, "skillslurp.json"),
			JSON.stringify({
				extends: [],
				rules: {
					"test/shape": { severity: "error", options: { list: ["a", "b"] } },
				},
				surfaces: [{ root: "one" }, { root: "two" }],
			}),
			"utf8",
		);
		// A nested array: `Object.isFrozen` on the options object alone would pass for a shallow
		// freeze, and on `undefined` (a rule with no schema) passes vacuously.
		const optionsSchema = z.strictObject({ list: z.array(z.string()) });
		const shapeRule = makeShapeRule("test/shape", async () => [], {
			optionsSchema,
		});

		const config = await loadConfig(dir, [shapeRule]);
		await run(config, [shapeRule]);

		const ctx = shapeRule.calls[0];
		if (ctx === undefined)
			throw new Error("expected the rule to have been dispatched");
		expect(Object.isFrozen(ctx)).toBe(true);
		const options = ctx.options;
		if (typeof options !== "object" || options === null || !("list" in options))
			throw new Error("expected ctx.options to carry the configured list");
		expect(options.list).toEqual(["a", "b"]);
		expect(Object.isFrozen(options)).toBe(true);
		expect(Object.isFrozen(options.list)).toBe(true);
		expect(Object.isFrozen(ctx.surfaces)).toBe(true);
		expect("surface" in ctx).toBe(false);
		expect(ctx.surfaces).toBe(config.surfaces);
		expect(ctx.surfaces.length).toBe(2);
		config.surfaces.forEach((surface, index) => {
			expect(ctx.surfaces[index]).toBe(surface);
		});
		expect(() => {
			Object.assign(ctx, { options: {} });
		}).toThrow();
	});
});

test("shape: under --diff-base the rule still sees the complete ctx.documents(), while a file rule is narrowed", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "a.md"), doc("original a"), "utf8");
		await writeFile(join(dir, "b.md"), doc("original b"), "utf8");
		await gitInitAndCommit(dir);
		const base = await headRev(dir);
		await writeFile(join(dir, "a.md"), doc("edited a"), "utf8");
		await commitAll(dir, "edit a");

		const seen: string[][] = [];
		const shapeRule = makeShapeRule("test/shape", async (ctx) => {
			seen.push((await ctx.documents()).map((d) => d.path));
			return [];
		});
		const fileRule = makeFileRule("test/file", async () => []);
		const config = makeConfig(
			dir,
			new Map([
				["test/shape", { severity: "error" }],
				["test/file", { severity: "error" }],
			]),
		);

		await run(config, [shapeRule, fileRule], { diffBase: base });

		expect(fileRule.calls.map((d) => d.path)).toEqual(["a.md"]);
		expect(seen).toEqual([["a.md", "b.md"]]);
	});
});

test("shape: invalid options over three surfaces are one config problem, not one per surface", async () => {
	await withTempDir(async (dir) => {
		const surfaces = await threeSurfaces(dir);
		const rule = makeShapeRule("test/shape", async () => [], {
			optionsSchema: z.strictObject({ max: z.number() }),
		});
		const config = makeConfig(
			dir,
			new Map([["test/shape", { severity: "error", options: { max: "x" } }]]),
			surfaces,
		);

		const err = await catchConfigError(run(config, [rule]));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toContain('rule "test/shape" options');
		expect(rule.calls.length).toBe(0);
	});
});

test("shape: the same run twice produces identical results, one dispatch per rule per run", async () => {
	await withTempDir(async (dir) => {
		const surfaces = await threeSurfaces(dir);
		// Deliberately reported out of sorted order, across files, plus a ConfigReport.
		const shapeRule = makeShapeRule("test/shape", async (ctx) => [
			{ message: "z", file: "s3/x.md", loc: { line: 1, col: 1 } },
			{ message: "a", file: "s1/x.md", loc: { line: 1, col: 1 } },
			{ problem: "stale", message: `surfaces: ${ctx.surfaces.length}` },
		]);
		const config = makeConfig(
			dir,
			new Map([["test/shape", { severity: "error" }]]),
			surfaces,
		);

		const first = await runEngine(config, [shapeRule]);
		const second = await runEngine(config, [shapeRule]);

		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(first.diagnostics.length).toBe(3);
		expect(shapeRule.calls.length).toBe(2);
	});
});
