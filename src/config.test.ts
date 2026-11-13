import { describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ZodType, z } from "zod";
import {
	ConfigError,
	jsonSyntaxErrorLoc,
	loadConfig,
	NoSurfacesDetectedError,
	RESERVED_NAMESPACES,
	type ResolvedRule,
	type ResolvedSpoke,
	resolveSpokes,
	type SurfaceRuleOverride,
	validateRegistry,
} from "./config.js";
import type { Severity } from "./diagnostic.js";
import {
	type DialectId,
	dialectsSupportingKind,
	SURFACE_KINDS,
} from "./dialects.js";
import { discoverFiles } from "./discover.js";
import type { Rule, Tier } from "./rule.js";
import { builtinRules } from "./rules/index.js";
import { frontmatterSchema } from "./rules/skill/frontmatter-schema.js";

/**
 * The real rule, not a stub: `loadConfig` now derives the tiers from `meta.tiers` and validates
 * options against `meta.optionsSchema`, so a fake would test the fake.
 */
const FRONTMATTER_SCHEMA_ONLY: readonly Rule[] = [frontmatterSchema];

/** A registry entry with only the metadata a given test cares about. */
function fakeRule(
	id: string,
	overrides: {
		tiers?: readonly Tier[];
		defaultSeverity?: Severity;
		optionsSchema?: ZodType;
	} = {},
): Rule {
	return {
		kind: "file",
		meta: {
			id,
			description: `${id} (test fixture)`,
			docsUrl: "https://example.invalid/docs",
			tiers: overrides.tiers ?? [],
			defaultSeverity: overrides.defaultSeverity ?? "error",
			fixable: false,
			...(overrides.optionsSchema
				? { optionsSchema: overrides.optionsSchema }
				: {}),
		},
		check: () => [],
	};
}

/** Writes `content` as `skillslurp.json` into a fresh temp dir, then cleans it up. */
async function withConfig<T>(
	content: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		await writeFile(join(dir, "skillslurp.json"), content, "utf8");
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Creates a fresh temp dir with no config file in it, then cleans it up. */
async function withEmptyDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Whether this machine has a `mkfifo` binary on PATH — false on a platform without one (e.g.
 * Windows). The FIFO test below needs a REAL named pipe to reproduce the hang it guards against
 * (there is no portable, dependency-free way to make one from Node), and the probe's own absence
 * must not be mistaken for the fix passing. Same probe context.test.ts already carries for its
 * FIFO test.
 */
const MKFIFO_AVAILABLE = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-mkfifo-probe-"));
	try {
		await promisify(execFileCb)("mkfifo", [join(dir, "probe.fifo")]);
		return true;
	} catch {
		return false;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

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
	throw new Error("expected loadConfig to reject with ConfigError");
}

async function catchNoSurfacesDetectedError(
	promise: Promise<unknown>,
): Promise<NoSurfacesDetectedError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof NoSurfacesDetectedError) {
			return err;
		}
		throw err;
	}
	throw new Error("expected loadConfig to reject with NoSurfacesDetectedError");
}

test("valid minimal config resolves with defaults applied", async () => {
	await withConfig(
		'{\n  "surfaces": [{ "root": ".claude/skills" }]\n}\n',
		async (dir) => {
			const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

			// Canonical, not merely `dir` itself: on a platform where the OS temp dir is
			// itself reached through a symlink (macOS: `/var` -> `/private/var`, and `dir` here is
			// under `os.tmpdir()`), `loadConfig` now `realpath`s before returning, so `resolved.root`
			// is the REAL path, not whichever spelling `mkdtemp` happened to hand back.
			expect(resolved.root).toBe(await realpath(dir));
			expect(resolved.ignore).toEqual(["**/node_modules/**", "**/.git/**"]);
			expect(resolved.surfaces).toEqual([
				{
					root: ".claude/skills",
					kind: "skills",
					dialects: ["generic"],
					include: ["**/SKILL.md"],
					ignore: [],
					spokes: [],
					rules: new Map(),
					// the `root` value, so a later problem (missing dir, overlap, zero matches)
					// can point at the line the user wrote
					loc: { line: 2, col: 26, endLine: 2, endCol: 42 },
				},
			]);
			expect([...resolved.rules.entries()]).toEqual([
				["skill/frontmatter-schema", { severity: "error" }],
			]);
		},
	);
});

/**
 * `configFile` used to be built from the LEXICAL root (`resolve(root)`, before
 * `realpath`), while `root` itself is canonical. The two only ever diverge when some path
 * component of the given root is a symlink — which incidentally is every macOS `os.tmpdir()`
 * path (`/var` -> `/private/var`), but a dedicated symlinked root is used here rather than
 * relying on that platform incidental, so this test also catches the bug on a CI runner whose
 * temp dir happens not to be symlinked.
 *
 * `buildCorpus` (context.ts) relies on `configFile` sharing `root`'s base to ever exclude the
 * config file itself from the scan corpus; `displayPath(config.root, config.configFile)`
 * (engine.ts) relies on the same thing to render a sane repo-relative path instead of a
 * `../`-laden one. Both would silently break if this regressed.
 */
test("loadConfig: configFile is built from the SAME canonical base as root, even when the given path is itself a symlink", async () => {
	const realDir = await mkdtemp(join(tmpdir(), "skillslurp-config-real-"));
	try {
		await writeFile(
			join(realDir, "skillslurp.json"),
			'{\n  "surfaces": [{ "root": ".claude/skills" }]\n}\n',
			"utf8",
		);
		const linkDir = join(tmpdir(), `skillslurp-config-link-${process.pid}`);
		await symlink(realDir, linkDir, "dir");
		try {
			const resolved = await loadConfig(linkDir, FRONTMATTER_SCHEMA_ONLY);

			expect(resolved.root).toBe(await realpath(realDir));
			expect(resolved.configFile).toBe(join(resolved.root, "skillslurp.json"));
		} finally {
			await rm(linkDir, { force: true });
		}
	} finally {
		await rm(realDir, { recursive: true, force: true });
	}
});

test("unknown top-level key produces a positioned problem at the key scalar", async () => {
	const content =
		'{\n  "rulez": {},\n  "surfaces": [{ "root": ".claude/skills" }]\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.loc).toEqual({ line: 2, col: 3, endLine: 2, endCol: 10 });
	});
});

test("unknown nested surface key produces a positioned problem", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills", "bogus": 1 }]\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.loc).toEqual({ line: 2, col: 44, endLine: 2, endCol: 51 });
	});
});

test("bad severity value produces a positioned problem", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "skill/frontmatter-schema": "fatal" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.loc).toBeDefined();
		expect(problem.loc?.line).toBe(3);
	});
});

test("bad severity value inside the object form (severity not the first key) is positioned at the value, not the whole rule block", async () => {
	// Regression test: zod v4 collapses RuleSettingSchema's union into a single
	// "invalid_union" issue whose default loc used to fall back to the entire nested
	// mapping's range (spanning from `options:` down through `severity: fatal`). The fix
	// recurses into the union's per-branch sub-issues so the loc lands on the severity
	// value itself, regardless of key order.
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": {\n    "skill/frontmatter-schema": {\n      "options": { "required": ["name"] },\n      "severity": "fatal"\n    }\n  }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("severity");
		expect(problem.message).toContain("error");
		// `"severity": "fatal"` is on line 6; the old behavior wrongly reported line 4 (the
		// start of the whole nested `options:`/`severity:` mapping).
		expect(problem.loc).toEqual({ line: 6, col: 19, endLine: 6, endCol: 26 });
	});
});

test("a misspelled option key inside the object form (optionz) is positioned at that key", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": {\n    "skill/frontmatter-schema": {\n      "severity": "warn",\n      "optionz": {}\n    }\n  }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("optionz");
		expect(problem.loc).toEqual({ line: 6, col: 7, endLine: 6, endCol: 16 });
	});
});

test("missing surfaces produces a ConfigError whose message mentions surfaces", async () => {
	await withConfig('{ "version": 1 }\n', async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.message).toContain("surfaces");
		expect(err.problems.length).toBe(1);
	});
});

test("unknown rule id produces a positioned problem at the key", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "nope/nope": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("nope/nope");
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 25 });
	});
});

test("a reserved-namespace rule id (parse/*) produces a positioned problem", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "parse/frontmatter": "off" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("reserved");
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 33 });
	});
});

/**
 * Measured 2026-09-06: a JS object literal treats
 * `__proto__` as an accessor, not an own key, and `z.record`'s output-building re-triggers that
 * accessor — so `rules: { __proto__: error }` used to parse clean, with `Object.keys` on the
 * schema's OUTPUT coming back empty and `checkRuleIds` never seeing the id at all. Silence, exit
 * 0, and a rule the user believed they had configured stayed exactly as it was. The charset
 * check reads the id off the yaml mapping's own keys (`ruleIdKeys`), not off that output, so
 * `__proto__` is now seen and rejected like any other malformed id.
 */
test("top-level rules.__proto__ is rejected, not silently swallowed", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "__proto__": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "__proto__" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 25 });
	});
});

/**
 * The cost the union has to not pay: an ordinary key is seen by BOTH sources, so without
 * deduplication every bad id in every config would be reported twice. `onlyProblem` asserts
 * exactly one.
 */
test("a rule id both sources see is reported exactly once, not once per source", async () => {
	const problem = await onlyProblem(
		'{\n  "surfaces": [{ "root": "x" }],\n  "rules": { "nope/one": "error" }\n}\n',
	);

	expect(problem.message).toBe('unknown rule id "nope/one"');
	expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 24 });
});

/** And a `rules:` block with nothing wrong in it still resolves, union or no union. */
test("a valid rules block is still accepted after the key union", async () => {
	await withConfig(
		'{\n  "surfaces": [{ "root": "x" }],\n  "rules": { "skill/frontmatter-schema": "warn" }\n}\n',
		async (dir) => {
			const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

			expect([...resolved.rules.entries()]).toEqual([
				["skill/frontmatter-schema", { severity: "warn" }],
			]);
		},
	);
});

test("a rule id with an uppercase letter is rejected as malformed", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "Skill/Foo": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "Skill/Foo" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 25 });
	});
});

test("a rule id with no slash is rejected as malformed", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "noslash": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "noslash" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 23 });
	});
});

test("a rule id with two slashes is rejected as malformed", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "foo/bar/baz": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "foo/bar/baz" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 27 });
	});
});

test("a rule id with an empty segment (foo/) is rejected as malformed", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "foo/": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "foo/" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 20 });
	});
});

/**
 * `baseline/` joined `RESERVED_NAMESPACES` in the same review (see that constant's own comment):
 * `baseline/stale` matches `RULE_ID_PATTERN` just fine, so without checking reserved namespaces
 * FIRST this would report as a charset violation instead of the more specific "reserved" — the
 * ordering `checkRuleIds` documents.
 */
test("baseline/stale is reported as reserved, not as a charset violation", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "baseline/stale": "off" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "baseline/stale" is reserved and cannot be configured',
		);
	});
});

test("a well-formed rule id is still accepted (regression)", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "skill/frontmatter-schema": "warn" }\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.rules.get("skill/frontmatter-schema")).toEqual({
			severity: "warn",
		});
	});
});

test("explicit rules override wins over the preset: off drops the rule entirely", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "skill/frontmatter-schema": "off" }\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.rules.size).toBe(0);
	});
});

test("object form with options resolves severity and passes options through opaquely", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": {\n    "skill/frontmatter-schema": { "severity": "warn", "options": { "required": ["name"] } }\n  }\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.rules.get("skill/frontmatter-schema")).toEqual({
			severity: "warn",
			options: { required: ["name"] },
		});
	});
});

test("object form without options does not add an own `options: undefined` key", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "skill/frontmatter-schema": { "severity": "warn" } }\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		const rule = resolved.rules.get("skill/frontmatter-schema");
		expect(rule).toEqual({ severity: "warn" });
		expect(rule && "options" in rule).toBe(false);
	});
});

/**
 * A missing config file in an otherwise real, empty directory used to be an unconditional
 * `ConfigError`. It is now zero-config auto-detection's
 * job first — an empty temp dir has no known layout, so detection finds nothing and the result
 * is `NoSurfacesDetectedError`, deliberately NOT a `ConfigError` (see that class's own JSDoc for
 * why: exit must be 0, not 2). This test used to pin the `ConfigError` shape; it now pins the
 * new truth instead of being deleted, per CLAUDE.md's edge-case policy.
 */
test("missing config file with no known layout produces a NoSurfacesDetectedError, not a ConfigError", async () => {
	await withEmptyDir(async (dir) => {
		const err = await catchNoSurfacesDetectedError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.root).toBe(dir);
		expect(err.candidateRoots.length).toBeGreaterThan(0);
		expect(err).not.toBeInstanceOf(ConfigError);
	});
});

test("missing config file with no known layout and a relative root keeps NoSurfacesDetectedError.root relative, not the absolute machine path", async () => {
	// Machine-specific absolute paths in a message would poison a baseline (same file, two
	// checkouts, two different messages) — `root` must echo back whatever the caller passed,
	// unresolved, even though loadConfig resolves internally for its own fs access.
	await withEmptyDir(async (dir) => {
		const relativeRoot = relative(process.cwd(), dir);

		const err = await catchNoSurfacesDetectedError(
			loadConfig(relativeRoot, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.root).toBe(relativeRoot);
		expect(err.root.startsWith("/")).toBe(false);
	});
});

/**
 * Refused by `repoFileRefusal`'s regular-file check now, ahead of the `readFile` that used to
 * turn this into a bare `EISDIR`; the contract the test was written for — a `ConfigError` that
 * says "directory", never a raw fs error — is unchanged, and the message is asserted in full so
 * that narrowing the guard back to symlinks-only is visible here too.
 */
test("skillslurp.json existing as a directory is a ConfigError, not a raw fs error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		await mkdir(join(dir, "skillslurp.json"));
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(0);
		expect(err.message).toBe(
			`refusing to read ${join(dir, "skillslurp.json")}: it is a directory, not a regular file`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a root that is itself a file (ENOTDIR) is a ConfigError, not a raw fs error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		const rootFile = join(dir, "not-a-directory");
		await writeFile(rootFile, "hello", "utf8");

		const err = await catchConfigError(
			loadConfig(rootFile, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(0);
		expect(err.message).toContain("not a directory");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * The ENOENT hook must NOT treat a nonexistent `root` as "no known layout, exit 0" — that
 * would silently swallow a caller typo. `loadConfig` checks `stat(root)` before ever calling
 * `detectSurfaces`, so this stays a `ConfigError`. The message changed (it used to say
 * "no skillslurp.json found"); it now names the actual problem — the root itself is
 * missing — since a missing config file is no longer automatically fatal.
 */
test("a root that does not exist at all is a ConfigError, not a raw fs error, and NOT the zero-config detected/none-found path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		const nonexistentRoot = join(dir, "does-not-exist");

		const err = await catchConfigError(
			loadConfig(nonexistentRoot, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(0);
		expect(err.message).toContain("does not exist");
		expect(err.message).not.toContain("skillslurp.json");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// A broken symlink at the config path stays exit 2
// ---------------------------------------------------------------------------

/**
 * `readFile` on a dangling symlink fails with the exact same `ENOENT` a genuinely absent file
 * would — `loadConfig`'s ENOENT hook cannot tell "nothing here, try auto-detection" from "there
 * IS something here, and it is broken" without a separate check. Falling through to
 * auto-detection here would silently lint whatever layout happens to exist on disk instead of
 * the config the user actually wrote (or meant to reach, via the symlink) — a checkout where
 * `skillslurp.json` symlinks to a shared file elsewhere that has since moved is a
 * realistic way to hit this, and CI would go from a loud exit 2 to a quiet, wrong exit 0/1.
 *
 * A `.claude/skills` layout is deliberately placed alongside the broken symlink: if the ENOENT
 * hook incorrectly fell through to auto-detection, this test would still pass by accident
 * (`loadConfig` would just succeed with a detected surface) — the layout on disk is what makes
 * "did NOT silently auto-detect" an observable, not just an absence of one particular error.
 *
 * The mechanism moved with `repoFileRefusal`: `lstat` now runs BEFORE the read, so a dangling
 * symlink is refused for being a symlink rather than diagnosed after an ambiguous `ENOENT`. The
 * observable contract this test was written for is untouched, so the assertions are.
 */
test("a dangling symlink at skillslurp.json is a ConfigError, not silently auto-detected", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"x",
			"utf8",
		);
		await symlink(
			join(dir, "does-not-exist.json"),
			join(dir, "skillslurp.json"),
		);

		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(0);
		expect(err.message).toContain("skillslurp.json");
		expect(err.message).not.toContain("does not exist or is not a directory");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * The symlink hole on the READ side of a repository-chosen path, and the one that is worse than
 * the baseline's: a config file's parse problems go to STDOUT, the machine-readable sink.
 * Measured 2026-09-06 on a plain `skillslurp <repo>` with no flags, before this guard, with
 * `skillslurp.json` committed as a link to an unrelated JSON file:
 *
 *     skillslurp.json
 *       1:2   error  unrecognized key "aws_key"     config/invalid
 *       1:35  error  unrecognized key "aws_secret"  config/invalid
 *
 * Every top-level key of a file the operator never named, printed by the linter, chosen by
 * whoever opened the pull request. The target's own content is asserted absent from the message
 * rather than only the refusal asserted present.
 */
test("a symlinked skillslurp.json is refused, and nothing from the target is echoed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
	try {
		const secret = join(dir, "secret.json");
		await writeFile(secret, '{"slurp_secret_key":"SLURPSECRET"}\n', "utf8");
		await symlink(secret, join(dir, "skillslurp.json"));

		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(0);
		expect(err.message).toBe(
			`refusing to read ${join(dir, "skillslurp.json")}: it is a symbolic link, and following it would read outside the path you asked to lint`,
		);
		expect(err.message).not.toContain("slurp_secret_key");
		expect(err.message).not.toContain("SLURPSECRET");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * The other half of why the guard is `!isFile()` and not "not a symlink": a FIFO with no writer
 * blocks `readFile` forever, and `skillslurp.json` is a name the repository picks.
 * Measured 2026-09-06: a plain run against a repository carrying one was still blocked at 15s
 * and had to be SIGKILLed.
 *
 * The 5s per-test timeout is load-bearing — a regression fails this one test loudly instead of
 * hanging the suite. `MKFIFO_AVAILABLE` guards the platforms with no `mkfifo` binary; the probe's
 * absence must not read as the fix passing.
 */
/**
 * Releases a reader blocked on `fifo`, if there is one. Opening the write end with `O_NONBLOCK`
 * succeeds only when something IS blocked on the read end (`ENXIO` otherwise), and closing it
 * immediately sends that reader EOF. Never rejects: it is called from a timer.
 */
async function releaseFifoReader(fifo: string): Promise<void> {
	try {
		const handle = await open(
			fifo,
			fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
		);
		await handle.close();
	} catch {
		// no reader waiting, which is the green case
	}
}

test.skipIf(!MKFIFO_AVAILABLE)(
	"a FIFO at skillslurp.json is refused rather than blocking forever",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "skillslurp-config-"));
		const fifo = join(dir, "skillslurp.json");
		await promisify(execFileCb)("mkfifo", [fifo]);
		/**
		 * A watchdog, not just the test timeout, because a timeout cannot clean up: bun abandons the
		 * timed-out async function, so its `finally` never runs and the blocked `readFile` keeps the
		 * event loop alive — `bun test` prints the failure and then never exits, which is the "hangs the
		 * suite" outcome this test exists to prevent. Firing releases the leak AND records that there was
		 * one, so the regression fails on `blocked` even if some future refactor made the message match.
		 */
		let blocked = false;
		const watchdog = setTimeout(() => {
			blocked = true;
			void releaseFifoReader(fifo);
		}, 2_000);
		try {
			const err = await catchConfigError(
				loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
			);

			expect(err.message).toBe(
				`refusing to read ${fifo}: it is not a regular file`,
			);
			expect(blocked).toBe(false);
		} finally {
			clearTimeout(watchdog);
			await rm(dir, { recursive: true, force: true });
		}
	},
	5_000,
);

/**
 * The other half of the same branch: a config path that is genuinely absent (no filesystem
 * entry of any kind, not even a broken symlink) must still fall through to auto-detection —
 * `lstat` on a truly missing path also rejects with `ENOENT`, and that case must keep working.
 * The many "no config + a ... layout resolves via auto-detection" tests below already exercise
 * this continuously; this test exists only to name the branch explicitly, right next to the one
 * above that changed it.
 */
test("a genuinely absent config file (no symlink, nothing there at all) still falls through to auto-detection", async () => {
	await withEmptyDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"x",
			"utf8",
		);

		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.origin).toBe("detected");
	});
});

// ---------------------------------------------------------------------------
// Zero-config auto-detection, loadConfig's ENOENT hook
// ---------------------------------------------------------------------------

test('no config + a .claude/skills layout resolves via auto-detection, origin "detected", rules matching extends: [recommended] on the same registry', async () => {
	await withEmptyDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill for detection tests.\n---\nBody.\n",
			"utf8",
		);

		const detected = await loadConfig(dir, builtinRules);

		expect(detected.origin).toBe("detected");
		expect(detected.surfaces).toHaveLength(1);
		expect(detected.surfaces[0]?.root).toBe(".claude/skills");
		expect(detected.surfaces[0]?.kind).toBe("skills");
		expect(detected.surfaces[0]?.dialects).toEqual(["claude-code"]);
		// no yaml behind a detected surface — `config/no-files` reads the absence of
		// `loc` as "not something the user wrote" and must not be able to fail this run.
		expect(detected.surfaces[0]?.loc).toBeUndefined();
		expect("loc" in (detected.surfaces[0] ?? {})).toBe(false);
		// `include` comes from the kind's own default (dialects.ts's `DEFAULT_INCLUDE`) — a
		// synthesized surface has no `include:` key of its own to have written.
		expect(detected.surfaces[0]?.include).toEqual(["**/SKILL.md"]);
		// no yaml `ignore:` block either, and no per-surface override to hold.
		expect(detected.surfaces[0]?.ignore).toEqual([]);
		expect(detected.surfaces[0]?.rules.size).toBe(0);
		expect(detected.ignore).toEqual(["**/node_modules/**", "**/.git/**"]);

		// The tier-resolution helper (`resolveTierRules`) must be the SAME code both the
		// configured and the detected paths call — asserted by comparing against a real,
		// minimally-configured `extends: [recommended]` result on the identical registry,
		// rather than hand-deriving the expected map here (which could drift from
		// `loadConfig`'s own logic without this test noticing).
		await withConfig(
			'{ "surfaces": [{ "root": "." }] }\n',
			async (configuredDir) => {
				const configured = await loadConfig(configuredDir, builtinRules);
				expect([...detected.rules.entries()]).toEqual([
					...configured.rules.entries(),
				]);
				expect([...detected.ruleOptions.entries()]).toEqual([
					...configured.ruleOptions.entries(),
				]);
			},
		);
	});
});

test("a zero-config detected run's ResolvedConfig.root is also canonical, not merely resolved", async () => {
	await withEmptyDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill for detection tests.\n---\nBody.\n",
			"utf8",
		);

		const detected = await loadConfig(dir, builtinRules);

		// Same fix, same reason as the configured path's own test just above — this branch
		// (`loadConfig`'s config-file-ENOENT / zero-config auto-detection hook) returns through
		// a SEPARATE `return` statement, so it needed the identical `realpath` applied
		// separately; nothing upstream shares the two.
		expect(detected.root).toBe(await realpath(dir));
	});
});

/**
 * The freezing assertion this used to be lives in detect.test.ts, back when `detectSurfaces`
 * itself built and froze `ResolvedSurface`s. It now returns plain `DetectedSurface` data;
 * `resolveDetectedSurface` (config.ts, called from `loadConfig`'s ENOENT branch) is what
 * builds and freezes the `ResolvedSurface`, through the exact same `freezeSurface` pass a
 * written surface goes through — so this moved here rather than disappearing.
 */
test("a detected surface and everything reachable from it is frozen", async () => {
	await withEmptyDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "a"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "skills", "a", "SKILL.md"),
			"x",
			"utf8",
		);

		const detected = await loadConfig(dir, builtinRules);
		const surface = detected.surfaces[0];
		if (!surface) throw new Error("expected a detected surface");

		expect(Object.isFrozen(detected.surfaces)).toBe(true);
		expect(Object.isFrozen(surface)).toBe(true);
		expect(Object.isFrozen(surface.dialects)).toBe(true);
		expect(Object.isFrozen(surface.include)).toBe(true);
		expect(Object.isFrozen(surface.ignore)).toBe(true);
		expect(() => {
			(surface as { root: string }).root = "/etc";
		}).toThrow(TypeError);
		expect(() => {
			(surface.rules as Map<string, SurfaceRuleOverride>).set("x", {
				severity: "off",
			});
		}).toThrow(TypeError);
	});
});

test("no config + no known layout throws NoSurfacesDetectedError, not a ConfigError", async () => {
	await withEmptyDir(async (dir) => {
		const err = await catchNoSurfacesDetectedError(
			loadConfig(dir, builtinRules),
		);

		expect(err.root).toBe(dir);
		expect(err.candidateRoots).toEqual([
			".claude/skills",
			".agents/skills",
			".opencode/skills",
			".cursor/skills",
			".github/skills",
			".cursor/rules",
			".github/instructions",
		]);
		// A wholly empty root has nothing for any candidate to describe — every candidate
		// directory is simply absent, so `skipped` must stay empty (this is deliberately the
		// "nothing at all" half; the "present but empty" half is the next test, since a wholly
		// empty root cannot exercise it).
		expect(err.skipped).toEqual([]);
	});
});

/**
 * Every none-found test above uses a wholly empty root, which never
 * exercises the "a candidate directory exists but is empty" half of `NoSurfacesDetectedError`
 * — only the one-layer-down `detectSurfaces` tests (detect.test.ts) did. `loadConfig` must
 * still raise `NoSurfacesDetectedError` (not silently treat the empty `.claude/skills` as "found
 * nothing to lint, clean run") when the only candidate present on disk matches zero files, and
 * the error's `skipped` list must name it.
 */
test("a candidate directory exists but is empty still throws NoSurfacesDetectedError, and names it in skipped", async () => {
	await withEmptyDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });

		const err = await catchNoSurfacesDetectedError(
			loadConfig(dir, builtinRules),
		);

		expect(err.skipped).toEqual([
			{ root: ".claude/skills", reason: "no-match" },
		]);
	});
});

test("an empty config file (0 bytes) is a positioned ConfigError", async () => {
	// An empty file is not valid JSON (`JSON.parse("")` throws), so this is now caught by the
	// JSON syntax gate rather than reaching `toJS()`/the schema at all — but the shape a caller
	// sees is unchanged: exactly one problem, at 1:1, since there is nothing else to blame.
	await withConfig("", async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("invalid JSON");
		expect(problem.loc).toEqual({ line: 1, col: 1 });
	});
});

/**
 * This test runs `loadConfig` in-process (`bun test`, not a spawned `node dist/cli.js`), so the
 * `SyntaxError` it sees is Bun's own JSON.parse (JavaScriptCore) — which, unlike V8's, never
 * carries a `(line N column M)` suffix, so `jsonSyntaxErrorLoc` (config.ts) always falls back to
 * 1:1 here. No automated test exercises the suffix end to end: only the compiled CLI under Node
 * produces it, and that path was verified by hand.
 */
test("invalid JSON config produces a ConfigError", async () => {
	await withConfig("surfaces: [unterminated\n", async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toContain("invalid JSON");
		expect(problem.loc).toEqual({ line: 1, col: 1 });
	});
});

test("duplicate top-level key in skillslurp.json is a DUPLICATE_KEY ConfigError", async () => {
	const content = '{"a":1,"a":2}';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe("Map keys must be unique");
		expect(problem.loc).toBeDefined();
	});
});

/**
 * `jsonSyntaxErrorLoc` turns V8's `(line N column M)` suffix into a `Loc`. It is tested on literal
 * message strings because `bun test` runs on JavaScriptCore, whose `JSON.parse` never produces
 * that suffix — the `loadConfig` test above always sees the 1:1 fallback here, and only the built
 * CLI under Node exercises the match. The anchoring matters as much as the match: V8 quotes a
 * snippet of the offending source in some messages, so a suffix-shaped string inside the user's
 * own file must not be mistaken for a position.
 */
describe("jsonSyntaxErrorLoc", () => {
	test("reads V8's trailing suffix into line and column", () => {
		expect(
			jsonSyntaxErrorLoc(
				"Expected double-quoted property name in JSON at position 68 (line 1 column 69)",
			),
		).toEqual({ line: 1, col: 69 });
		expect(
			jsonSyntaxErrorLoc(
				"Expected property name or '}' in JSON at position 4 (line 2 column 3)",
			),
		).toEqual({ line: 2, col: 3 });
	});

	test("returns undefined when the engine names no position", () => {
		expect(jsonSyntaxErrorLoc("Unexpected end of JSON input")).toBeUndefined();
		expect(
			jsonSyntaxErrorLoc("JSON Parse error: Unable to parse JSON string"),
		).toBeUndefined();
		expect(
			jsonSyntaxErrorLoc(
				"Unexpected token 's', \"surfaces:\n\"... is not valid JSON",
			),
		).toBeUndefined();
	});

	test("ignores a suffix-shaped string that is not at the end of the message", () => {
		expect(
			jsonSyntaxErrorLoc(
				"Unexpected token 'x', \"x (line 9 column 9)\"... is not valid JSON",
			),
		).toBeUndefined();
	});
});

/**
 * An explicit empty key, `"": "error"`, is the one key shape JSON can still produce that the
 * YAML-era `jsKeyString` normalisation exists for: the id reported must be `""` — the key zod
 * actually resolved — never `"null"`, and `keyLoc` must position it on that key rather than fall
 * back to blaming the whole `rules` block.
 */
test("an explicit empty rules key is reported as the empty id it resolves to, positioned on the key", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "": "error" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		expect(problem.message).toBe(
			'rule id "" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
		);
		expect(problem.message).not.toContain("null");
		expect(problem.loc).toEqual({ line: 3, col: 14, endLine: 3, endCol: 16 });
	});
});

test("multiple zod issues at once are all carried by a single ConfigError", async () => {
	const content =
		'{\n  "rulez": {},\n  "surfaces": [{ "root": ".claude/skills", "bogus": 1 }],\n  "rules": { "skill/frontmatter-schema": "fatal" }\n}\n';
	await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);

		expect(err.problems.length).toBeGreaterThanOrEqual(2);
		const messages = err.problems.map((p) => p.message);
		expect(messages.some((m) => m.includes("rulez"))).toBe(true);
		expect(messages.some((m) => m.includes("bogus"))).toBe(true);
	});
});

test("rules map iterates in deterministic, sorted-by-id order", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "rules": { "skill/zzz-check": "warn", "skill/aaa-check": "error" }\n}\n';
	const registry: readonly Rule[] = [
		frontmatterSchema,
		fakeRule("skill/zzz-check"),
		fakeRule("skill/aaa-check"),
	];
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, registry);

		expect([...resolved.rules.keys()]).toEqual([
			"skill/aaa-check",
			"skill/frontmatter-schema",
			"skill/zzz-check",
		]);
	});
});

test("a user ignore list is merged with the always-on defaults, user entries first, deduped", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "ignore": ["dist/**"]\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.ignore).toEqual([
			"dist/**",
			"**/node_modules/**",
			"**/.git/**",
		]);
	});
});

test("a user ignore list that repeats a default does not duplicate it", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "ignore": ["dist/**", "**/node_modules/**"]\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.ignore).toEqual([
			"dist/**",
			"**/node_modules/**",
			"**/.git/**",
		]);
	});
});

test("extends: [] resolves to zero preset rules", async () => {
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "extends": []\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.rules.size).toBe(0);
	});
});

test("extends: [strict, recommended] merges in listed order (later preset wins on overlap)", async () => {
	// Both stub presets currently agree on `skill/frontmatter-schema: error`, so this can't
	// distinguish "strict wins" from "recommended wins" by value — it pins the current
	// merge-order plumbing (iterate `extends` in order, `Map.set` per id, last write wins)
	// so a future divergence between the presets has a test already in place.
	const content =
		'{\n  "surfaces": [{ "root": ".claude/skills" }],\n  "extends": ["strict", "recommended"]\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.rules.get("skill/frontmatter-schema")).toEqual({
			severity: "error",
		});
	});
});

test("surfaces keep the order they were written in (not sorted)", async () => {
	const content = '{ "surfaces": [{ "root": "b" }, { "root": "a" }] }\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

		expect(resolved.surfaces.map((s) => s.root)).toEqual(["b", "a"]);
	});
});

test("a relative root resolves to an absolute, canonical ResolvedConfig.root", async () => {
	const content = '{\n  "surfaces": [{ "root": ".claude/skills" }]\n}\n';
	await withConfig(content, async (dir) => {
		const relativeRoot = relative(process.cwd(), dir);

		const resolved = await loadConfig(relativeRoot, FRONTMATTER_SCHEMA_ONLY);

		// `resolve(relativeRoot)` is merely absolute (lexical); `realpath(dir)` is canonical.
		// The two differ whenever `dir` is reached through a symlink somewhere in its path
		// (macOS's `os.tmpdir()` qualifies — see the previous test's comment) and happen to
		// coincide on a platform with no such symlink in the way — asserting against
		// `resolved.root` alone, not a `!==` between the two, keeps this test meaningful on
		// both without being flaky on either.
		expect(resolved.root).toBe(await realpath(dir));
		expect(resolved.root).toBe(await realpath(resolve(relativeRoot)));
	});
});

// ---------------------------------------------------------------------------
// Surface schema v2: kind, dialects, per-surface rules
// ---------------------------------------------------------------------------

/** Asserts a single-problem ConfigError and returns that problem. */
async function onlyProblem(content: string) {
	return await withConfig(content, async (dir) => {
		const err = await catchConfigError(
			loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
		);
		expect(err.problems.length).toBe(1);
		const [problem] = err.problems;
		if (!problem) throw new Error("expected a problem");
		return problem;
	});
}

async function onlySurface(content: string) {
	return await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
		const [surface] = resolved.surfaces;
		if (!surface) throw new Error("expected a surface");
		return surface;
	});
}

test("kind drives both the default include and the default dialects", async () => {
	const rules = await onlySurface(
		'{ "surfaces": [{ "root": ".cursor/rules", "kind": "rules" }] }\n',
	);
	expect(rules.kind).toBe("rules");
	expect(rules.include).toEqual(["**/*.mdc"]);
	expect(rules.dialects).toEqual(["cursor"]);

	const instructions = await onlySurface(
		'{ "surfaces": [{ "root": ".github/instructions", "kind": "instructions" }] }\n',
	);
	expect(instructions.include).toEqual(["**/*.instructions.md"]);
	expect(instructions.dialects).toEqual(["copilot"]);
});

/**
 * The defaults are hardcoded, so this is the guard that keeps them honest: each one must be a
 * dialect that actually defines a contract for its kind. A new built-in speaking `rules` or
 * `instructions` makes the second half of this fail, which is the intended prompt to decide
 * the default deliberately instead of leaving whichever one was written first.
 */
test("every default dialect actually speaks its surface kind", async () => {
	const bad: string[] = [];
	for (const kind of SURFACE_KINDS) {
		const surface = await onlySurface(
			`{ "surfaces": [{ "root": "x", "kind": "${kind}" }] }\n`,
		);
		const supporting = dialectsSupportingKind(kind);
		for (const dialect of surface.dialects) {
			if (!supporting.includes(dialect)) {
				bad.push(
					`${kind} defaults to ${dialect}, which has no ${kind} contract`,
				);
			}
		}
	}
	expect(bad).toEqual([]);
});

/**
 * The other half of the guard above. `DEFAULT_DIALECTS` is hardcoded, so a new speaker for a kind
 * has to make its default a deliberate choice rather than whichever dialect was written first.
 * `instructions` has one built-in speaker and nothing to choose. `rules` has two, and its default
 * stays `cursor` on purpose: it is what every config that omitted `dialects` already meant, and
 * Claude Code's rules are opt-in by naming the dialect. A third speaker for `rules`, or a second
 * for `instructions`, fails here.
 */
test("instructions has one built-in speaker, and rules two with cursor still its default", async () => {
	expect(dialectsSupportingKind("rules")).toEqual(["claude-code", "cursor"]);
	expect(dialectsSupportingKind("instructions")).toEqual(["copilot"]);

	const rules = await onlySurface(
		'{ "surfaces": [{ "root": ".claude/rules", "kind": "rules" }] }\n',
	);
	expect(rules.dialects).toEqual(["cursor"]);
});

test("a rules surface accepts claude-code on its own and next to cursor", async () => {
	const alone = await onlySurface(
		'{ "surfaces": [{ "root": ".claude/rules", "kind": "rules", "dialects": ["claude-code"] }] }\n',
	);
	expect(alone.kind).toBe("rules");
	expect(alone.dialects).toEqual(["claude-code"]);

	const both = await onlySurface(
		'{ "surfaces": [{ "root": ".claude/rules", "kind": "rules", "dialects": ["claude-code", "cursor"] }] }\n',
	);
	expect(both.dialects).toEqual(["claude-code", "cursor"]);
});

/**
 * The default `include` follows the dialects, not only the kind: without that, a Claude Code
 * rules surface that spells out no `include` would fall back to Cursor's `**\/*.mdc`, match
 * nothing, and end in a `config/no-files` error at exit 2.
 */
test("a surface with no include gets the sorted union of its dialects' includes", async () => {
	const includeOf = async (dialects: string): Promise<readonly string[]> =>
		(
			await onlySurface(
				`{ "surfaces": [{ "root": "r", "kind": "rules", "dialects": ${dialects} }] }\n`,
			)
		).include;

	expect(await includeOf('["claude-code"]')).toEqual(["**/*.md"]);
	expect(await includeOf('["cursor"]')).toEqual(["**/*.mdc"]);
	expect(await includeOf('["claude-code", "cursor"]')).toEqual([
		"**/*.md",
		"**/*.mdc",
	]);
	expect(await includeOf('["cursor", "claude-code"]')).toEqual([
		"**/*.md",
		"**/*.mdc",
	]);
});

test("a written include is kept as written, not merged with the dialects' defaults", async () => {
	const written = await onlySurface(
		'{ "surfaces": [{ "root": "r", "kind": "rules", "dialects": ["claude-code", "cursor"], "include": ["z/*.md", "a/*.md"] }] }\n',
	);
	expect(written.include).toEqual(["z/*.md", "a/*.md"]);
});

test("discovery under the default include: claude-code finds nested .md and not .mdc, cursor the reverse, both find both", async () => {
	const discovered = async (dialects: string): Promise<string[]> =>
		await withConfig(
			`{ "surfaces": [{ "root": ".claude/rules", "kind": "rules", "dialects": ${dialects} }] }\n`,
			async (dir) => {
				await mkdir(join(dir, ".claude", "rules", "frontend"), {
					recursive: true,
				});
				await writeFile(
					join(dir, ".claude", "rules", "frontend", "x.md"),
					"x",
					"utf8",
				);
				await writeFile(join(dir, ".claude", "rules", "y.mdc"), "y", "utf8");
				const config = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
				return (await discoverFiles(config)).map((f) => f.path);
			},
		);

	expect(await discovered('["claude-code"]')).toEqual([
		".claude/rules/frontend/x.md",
	]);
	expect(await discovered('["cursor"]')).toEqual([".claude/rules/y.mdc"]);
	expect(await discovered('["claude-code", "cursor"]')).toEqual([
		".claude/rules/frontend/x.md",
		".claude/rules/y.mdc",
	]);
});

test("an explicit empty include is kept, not replaced by the kind default", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "x", "include": [] }] }\n',
	);

	expect(surface.include).toEqual([]);
});

/**
 * Config order, not sorted order — the fixture is deliberately anti-alphabetical so that adding
 * a `.sort()` to the resolution step fails here instead of sliding through.
 */
test("duplicate dialects are deduped, first occurrence wins, config order kept", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "x", "dialects": ["opencode", "generic", "cursor", "generic"] }] }\n',
	);

	expect(surface.dialects).toEqual(["opencode", "generic", "cursor"]);
});

test("unknown surface kind produces a positioned problem", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": ".cursor/rules", "kind": "ruls" }] }\n',
	);

	expect(problem.message).toBe(
		'surfaces.0.kind: Invalid option: expected one of "skills"|"rules"|"instructions"',
	);
	expect(problem.loc).toEqual({ line: 1, col: 51, endLine: 1, endCol: 57 });
});

test("unknown dialect id produces a problem positioned at the list entry", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": ".claude/skills", "dialects": ["claude-code", "nope"] }] }\n',
	);

	expect(problem.message).toBe(
		'unknown dialect "nope" (known: claude-code, codex, copilot, cursor, generic, opencode)',
	);
	expect(problem.loc).toEqual({ line: 1, col: 72, endLine: 1, endCol: 78 });
});

/**
 * A dialect that does not define the surface's kind can never contribute a contract, so the
 * surface would be checked against nothing — a silent false-green rather than a config error.
 */
test("a dialect with no contract for the surface kind is a positioned problem", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": ".cursor/rules", "kind": "rules", "dialects": ["cursor", "copilot"] }] }\n',
	);

	expect(problem.message).toBe(
		'dialect "copilot" has no contract for surface kind "rules" (kind "rules" is spoken by: claude-code, cursor)',
	);
	expect(problem.loc).toEqual({ line: 1, col: 83, endLine: 1, endCol: 92 });
});

test("an empty dialects list is rejected", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": ".claude/skills", "dialects": [] }] }\n',
	);

	expect(problem.message).toBe(
		"surfaces.0.dialects: list at least one dialect, or omit the key to use this kind's default",
	);
	expect(problem.loc).toEqual({ line: 1, col: 56, endLine: 1, endCol: 58 });
});

test("per-surface rules keep `off` and carry options, sorted by rule id", async () => {
	const content =
		'{\n  "surfaces": [\n    {\n      "root": "x",\n      "rules": {\n        "skill/zzz": "off",\n        "skill/frontmatter-schema": { "severity": "warn", "options": { "required": ["name"] } }\n      }\n    }\n  ]\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, [
			frontmatterSchema,
			fakeRule("skill/zzz"),
		]);
		const [surface] = resolved.surfaces;
		if (!surface) throw new Error("expected a surface");

		expect([...surface.rules.entries()]).toEqual([
			[
				"skill/frontmatter-schema",
				{ severity: "warn", options: { required: ["name"] } },
			],
			["skill/zzz", { severity: "off" }],
		]);
	});
});

test("a per-surface rule set to off keeps an own key, unlike the global map", async () => {
	await withConfig(
		'{\n  "surfaces": [{ "root": "x", "rules": { "skill/frontmatter-schema": "off" } }],\n  "rules": { "skill/frontmatter-schema": "off" }\n}\n',
		async (dir) => {
			const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
			const [surface] = resolved.surfaces;
			if (!surface) throw new Error("expected a surface");

			// global: `off` means "not enabled", so the id is simply absent
			expect(resolved.rules.has("skill/frontmatter-schema")).toBe(false);
			// per-surface: `off` is a delta that has to survive, or the surface could never
			// disable a rule the global layer turned on
			expect(surface.rules.get("skill/frontmatter-schema")).toEqual({
				severity: "off",
			});
		},
	);
});

test("a reserved rule id inside a surface produces a positioned problem", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x", "rules": { "parse/frontmatter": "off" } }] }\n',
	);

	expect(problem.message).toBe(
		'rule id "parse/frontmatter" is reserved and cannot be configured',
	);
	expect(problem.loc).toEqual({ line: 1, col: 42, endLine: 1, endCol: 61 });
});

test("an unknown rule id inside a surface produces a positioned problem", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x", "rules": { "nope/nope": "error" } }] }\n',
	);

	expect(problem.message).toBe('unknown rule id "nope/nope"');
	expect(problem.loc).toEqual({ line: 1, col: 42, endLine: 1, endCol: 53 });
});

/**
 * The per-surface half of the same finding as the top-level `__proto__` test above: the
 * surface's `rules:` block goes through the identical `z.record` → `ruleIdKeys` path, so it
 * must be rejected here too, not just at the top level.
 */
test("per-surface rules.__proto__ is rejected, not silently swallowed", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x", "rules": { "__proto__": "error" } }] }\n',
	);

	expect(problem.message).toBe(
		'rule id "__proto__" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")',
	);
	expect(problem.loc).toEqual({ line: 1, col: 42, endLine: 1, endCol: 53 });
});

test("a bad severity inside a surface rule block is positioned at the value", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x", "rules": { "skill/frontmatter-schema": "fatal" } }] }\n',
	);

	expect(problem.message).toBe(
		'surfaces.0.rules.skill/frontmatter-schema: Invalid option: expected one of "error"|"warn"|"off"',
	);
	expect(problem.loc).toEqual({ line: 1, col: 70, endLine: 1, endCol: 77 });
});

/**
 * Dialect ids and rule ids share one stage, so every id problem in the file is reported
 * together. Order is schema-declaration order — surfaces, then the global `rules` block —
 * regardless of how the keys are laid out in the yaml.
 */
test("dialect and rule id problems are collected together, surfaces first", async () => {
	await withConfig(
		'{\n  "surfaces": [{ "root": "a", "dialects": ["bogus"], "rules": { "nope/one": "error" } }],\n  "rules": { "nope/two": "error" }\n}\n',
		async (dir) => {
			const err = await catchConfigError(
				loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
			);

			expect(err.problems.map((p) => p.message)).toEqual([
				'unknown dialect "bogus" (known: claude-code, codex, copilot, cursor, generic, opencode)',
				'unknown rule id "nope/one"',
				'unknown rule id "nope/two"',
			]);
		},
	);
});

/**
 * The blocker this schema exists to avoid: a surface entry is a delta, so touching only
 * `options` must not also assert a severity. Defaulting it (as the global block does) would
 * silently escalate a globally-`warn` rule to `error` on that surface.
 */
test("an options-only surface override leaves severity unset", async () => {
	const content =
		'{\n  "rules": { "skill/frontmatter-schema": "warn" },\n  "surfaces": [\n    {\n      "root": "x",\n      "rules": { "skill/frontmatter-schema": { "options": { "required": ["name"] } } }\n    }\n  ]\n}\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
		const [surface] = resolved.surfaces;
		if (!surface) throw new Error("expected a surface");
		const override = surface.rules.get("skill/frontmatter-schema");

		expect(override).toEqual({ options: { required: ["name"] } });
		expect(override && "severity" in override).toBe(false);
		expect(resolved.rules.get("skill/frontmatter-schema")).toEqual({
			severity: "warn",
		});
	});
});

test("a surface override may still name a severity on its own", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "x", "rules": { "skill/frontmatter-schema": { "severity": "warn" } } }] }\n',
	);

	expect(surface.rules.get("skill/frontmatter-schema")).toEqual({
		severity: "warn",
	});
});

test("default include and dialect arrays are frozen and never shared mutably", async () => {
	const content = '{ "surfaces": [{ "root": "a" }, { "root": "b" }] }\n';
	await withConfig(content, async (dir) => {
		const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
		const [first, second] = resolved.surfaces;
		if (!first || !second) throw new Error("expected two surfaces");

		expect(Object.isFrozen(first.include)).toBe(true);
		expect(Object.isFrozen(first.dialects)).toBe(true);
		expect(() => {
			(first.include as string[]).push("**/*.poisoned");
		}).toThrow(TypeError);
		expect(second.include).toEqual(["**/SKILL.md"]);
	});
});

// ---------------------------------------------------------------------------
// Tiers as the single source of truth, positioned rule-option errors
// ---------------------------------------------------------------------------

const OPTIONAL_PREFIX = z.strictObject({ prefix: z.string().min(1) });

/**
 * The direction that matters most: nobody edits a preset table to add a rule to a tier, so a
 * rule that claims one is in it, and a rule that claims none is in nothing. Both are asserted,
 * because a preset built by ignoring `meta.tiers` entirely would pass only the second.
 */
test("a rule is in a tier because its own meta says so", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/in-recommended", { tiers: ["recommended"] }),
		fakeRule("test/in-strict-only", { tiers: ["strict"] }),
		fakeRule("test/in-no-tier"),
	];
	await withConfig('{ "surfaces": [{ "root": "x" }] }\n', async (dir) => {
		const resolved = await loadConfig(dir, registry);

		expect([...resolved.rules.keys()]).toEqual(["test/in-recommended"]);
	});
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "extends": ["strict"] }\n',
		async (dir) => {
			const resolved = await loadConfig(dir, registry);

			// strict is a superset (TIER_IMPLIES), so it carries the recommended rule too
			expect([...resolved.rules.keys()]).toEqual([
				"test/in-recommended",
				"test/in-strict-only",
			]);
		},
	);
});

/**
 * `extends: [strict]` must never be a weaker lint than `extends: [recommended]`. Without the
 * implication that depends on every rule author remembering to list both tiers, which is
 * exactly the kind of bookkeeping that tiers-as-data removed everywhere else.
 */
test("strict is a superset of recommended, for built-ins too", async () => {
	await withConfig('{ "surfaces": [{ "root": "x" }] }\n', async (dir) => {
		const recommended = await loadConfig(dir, builtinRules);
		await withConfig(
			'{ "surfaces": [{ "root": "x" }], "extends": ["strict"] }\n',
			async (strictDir) => {
				const strict = await loadConfig(strictDir, builtinRules);

				for (const id of recommended.rules.keys()) {
					expect([...strict.rules.keys()]).toContain(id);
				}
			},
		);
	});
});

test("a tier hands each rule its own defaultSeverity", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/loud", { tiers: ["recommended"], defaultSeverity: "error" }),
		fakeRule("test/quiet", { tiers: ["recommended"], defaultSeverity: "warn" }),
	];
	await withConfig('{ "surfaces": [{ "root": "x" }] }\n', async (dir) => {
		const resolved = await loadConfig(dir, registry);

		expect([...resolved.rules.entries()]).toEqual([
			["test/loud", { severity: "error" }],
			["test/quiet", { severity: "warn" }],
		]);
	});
});

test("an explicit rules entry still beats the tier that enabled the rule", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/loud", { tiers: ["recommended"], defaultSeverity: "error" }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/loud": "warn" } }\n',
		async (dir) => {
			const resolved = await loadConfig(dir, registry);

			expect(resolved.rules.get("test/loud")).toEqual({ severity: "warn" });
		},
	);
});

test("a bad option value is positioned at the value that caused it", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x" }], "rules": { "skill/frontmatter-schema": { "options": { "required": "nope" } } } }\n',
	);

	expect(problem.message).toBe(
		'rule "skill/frontmatter-schema" options.required: Invalid input: expected array, received string',
	);
	expect(problem.loc).toEqual({ line: 1, col: 100, endLine: 1, endCol: 106 });
});

test("a bad option value inside a surface is positioned inside that surface", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "x", "rules": { "skill/frontmatter-schema": { "options": { "allowed": 7 } } } }] }\n',
	);

	expect(problem.message).toBe(
		'rule "skill/frontmatter-schema" options.allowed: Invalid input: expected array, received number',
	);
	expect(problem.loc).toEqual({ line: 1, col: 96, endLine: 1, endCol: 97 });
});

test("every bad option is reported, not just the first", async () => {
	await withConfig(
		'{\n  "surfaces": [{ "root": "x" }],\n  "rules": {\n    "skill/frontmatter-schema": {\n      "options": {\n        "required": "nope",\n        "allowed": 7\n      }\n    }\n  }\n}\n',
		async (dir) => {
			const err = await catchConfigError(
				loadConfig(dir, FRONTMATTER_SCHEMA_ONLY),
			);

			expect(err.problems.map((p) => p.loc?.line)).toEqual([6, 7]);
		},
	);
});

test("options given to a rule that takes none is a positioned problem", async () => {
	const registry: readonly Rule[] = [fakeRule("test/plain")];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/plain": { "options": { "a": 1 } } } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems.length).toBe(1);
			expect(err.problems[0]?.message).toBe(
				'rule "test/plain" accepts no options',
			);
			expect(err.problems[0]?.loc?.line).toBe(1);
		},
	);
});

/**
 * A rule whose schema demands an option, enabled without one. There is no `options` node to
 * point at, so `issueLoc` walks the path back to the nearest thing the user did write — here
 * the severity on the rule's own line. Without that walk-up it would land on line 1, col 1.
 */
test("a required option missing entirely still lands near the rule that needs it", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/needs-prefix", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/needs-prefix": "error" } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems[0]?.message).toBe(
				'rule "test/needs-prefix" options.prefix: Invalid input: expected string, received undefined',
			);
			expect(err.problems[0]?.loc).toEqual({
				line: 1,
				col: 66,
				endLine: 1,
				endCol: 73,
			});
		},
	);
});

/**
 * A surface entry naming only a severity inherits the global options rather than clearing
 * them, so there is nothing to validate there — validating `{}` would reject a perfectly good
 * config whose required option is supplied one layer down.
 */
test("a severity-only surface override does not re-validate the global options", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/needs-prefix", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{\n  "surfaces": [{ "root": "x", "rules": { "test/needs-prefix": "warn" } }],\n  "rules": { "test/needs-prefix": { "options": { "prefix": "acme-" } } }\n}\n',
		async (dir) => {
			const resolved = await loadConfig(dir, registry);

			expect(resolved.rules.get("test/needs-prefix")).toEqual({
				severity: "error",
				options: { prefix: "acme-" },
			});
			expect(resolved.surfaces[0]?.rules.get("test/needs-prefix")).toEqual({
				severity: "warn",
			});
		},
	);
});

/**
 * A misspelled option key is the likeliest option mistake there is, so it has to land on the
 * key. `unrecognized_keys` reports on the *parent* path with the key in `issue.keys`, which is
 * why option issues go through the same `mapIssue` special-casing as config-level ones instead
 * of a second, simpler mapping.
 */
test("an unknown option key is positioned at the key, not at the whole blob", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{\n  "surfaces": [{ "root": "x" }],\n  "rules": {\n    "test/p": {\n      "options": {\n        "prefix": "acme-",\n        "prefx": "typo"\n      }\n    }\n  }\n}\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems).toEqual([
				{
					message: 'rule "test/p" options: unrecognized key "prefx"',
					loc: { line: 7, col: 9, endLine: 7, endCol: 16 },
				},
			]);
		},
	);
});

test("a union options schema reports the real sub-issue, not a bare Invalid input", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/u", {
			optionsSchema: z.union([
				z.strictObject({ a: z.number() }),
				z.strictObject({ b: z.string() }),
			]),
		}),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/u": { "options": 5 } } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems[0]?.message).toBe(
				'rule "test/u" options: Invalid input: expected object, received number',
			);
			expect(err.problems[0]?.loc).toEqual({
				line: 1,
				col: 68,
				endLine: 1,
				endCol: 69,
			});
		},
	);
});

/**
 * A rule enabled only by a tier has no `rules:` entry to point at. The walk must stop at the
 * rule's own (absent) entry and blame the `extends:` list that pulled it in — never the
 * enclosing `rules:` map, which would put the caret on whichever unrelated rule the user did
 * configure.
 */
test("a tier-enabled rule's missing option is blamed on extends, not on another rule", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/tiered", {
			tiers: ["recommended"],
			optionsSchema: OPTIONAL_PREFIX,
		}),
		fakeRule("test/other"),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "extends": ["recommended"], "rules": { "test/other": "warn" } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems).toEqual([
				{
					message:
						'rule "test/tiered" options.prefix: Invalid input: expected string, received undefined',
					loc: { line: 1, col: 45, endLine: 1, endCol: 60 },
				},
			]);
		},
	);
});

test("an empty `options:` is a problem, not a synonym for omitting it", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/p": { "severity": "error", "options": null } } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems[0]?.message).toBe(
				'rule "test/p" options: Invalid input: expected object, received null',
			);
		},
	);
});

/**
 * `off` drops the rule from the resolved map, but the options the user wrote are still theirs
 * to get wrong — and the surface layer would have reported them. Discarding them silently is
 * how a typo survives until someone deletes the `off` months later.
 */
test("options written for a globally-off rule are still validated", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x" }], "rules": { "test/p": { "severity": "off", "options": { "prefix": 5 } } } }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems[0]?.message).toBe(
				'rule "test/p" options.prefix: Invalid input: expected string, received number',
			);
			expect(err.problems[0]?.loc?.line).toBe(1);
		},
	);
});

/** The surface index has to reach the path, or every surface reports against surface 0. */
test("an option error on the second surface is positioned in the second surface", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "a" }, { "root": "b", "rules": { "test/p": { "options": { "prefix": 5 } } } }] }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems[0]?.loc).toEqual({
				line: 1,
				col: 94,
				endLine: 1,
				endCol: 95,
			});
		},
	);
});

/** A rule in no tier and absent from the global block — the shape a rule in no tier with a required option, e.g. `index/complete`, has. */
test("a surface-only rule still has its options validated", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "a", "rules": { "test/p": { "options": { "prefix": 5 } } } }] }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems.length).toBe(1);
			expect(err.problems[0]?.loc?.line).toBe(1);
		},
	);
});

/**
 * A rule mentioned only in a surface's bare-severity `rules:` entry is in
 * neither `rules.keys()` nor `Object.keys(parsed.rules)`, so the global option loop never sees
 * it — before this fix, `loadConfig` accepted it clean and only the engine's loc-less backstop
 * ever caught the missing required option, which cannot satisfy a "positioned config error"
 * contract (for a rule in no tier with a required option, e.g. `index/complete`). The
 * caret must land on the surface's own rule
 * entry, not the (nonexistent) options node under it.
 */
test("a rule with a required option, enabled by a bare surface severity alone, is a positioned ConfigError from loadConfig", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/needs-prefix", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x", "rules": { "test/needs-prefix": "error" } }] }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems.length).toBe(1);
			expect(err.problems[0]?.message).toBe(
				'rule "test/needs-prefix" options.prefix: Invalid input: expected string, received undefined',
			);
			expect(err.problems[0]?.loc).toEqual({
				line: 1,
				col: 63,
				endLine: 1,
				endCol: 70,
			});
		},
	);
});

/**
 * The mirror image of the test above, and the reason the skip is keyed on membership in the
 * global loop's id set rather than on "is there an options blob to inherit": a rule pulled in
 * by a tier has no blob either, yet the global loop already validated its effective `{}` and
 * reported the missing option. Validating again per surface would bill one mistake twice —
 * once at `extends`, once at whichever surface happened to mention the rule.
 */
test("a rule enabled by a tier and also named by a bare surface severity reports its missing required option once, not once per layer", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/needs-prefix", {
			optionsSchema: OPTIONAL_PREFIX,
			tiers: ["recommended"],
		}),
	];
	await withConfig(
		'{ "surfaces": [{ "root": "x", "rules": { "test/needs-prefix": "error" } }] }\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems.length).toBe(1);
		},
	);
});

/** Collect-all spans both layers: one stage, one ConfigError, global first then surfaces. */
test("a bad global option and a bad surface option are reported together", async () => {
	const registry: readonly Rule[] = [
		fakeRule("test/p", { optionsSchema: OPTIONAL_PREFIX }),
	];
	await withConfig(
		'{\n  "surfaces": [{ "root": "a", "rules": { "test/p": { "options": { "prefix": 5 } } } }],\n  "rules": { "test/p": { "options": { "prefix": 9 } } }\n}\n',
		async (dir) => {
			const err = await catchConfigError(loadConfig(dir, registry));

			expect(err.problems.map((p) => p.loc?.line)).toEqual([3, 2]);
		},
	);
});

/**
 * `loadConfig` reads tier membership straight off the registry, so it has to validate the
 * registry itself: otherwise a rule claiming a tier could put a reserved id into the resolved
 * config — an id the same user is forbidden to write in `rules:`.
 */
test("loadConfig rejects a registry rule in a reserved namespace", async () => {
	const registry: readonly Rule[] = [
		fakeRule("config/no-files", { tiers: ["recommended"] }),
	];
	await withConfig('{ "surfaces": [{ "root": "x" }] }\n', async (dir) => {
		await expect(loadConfig(dir, registry)).rejects.toThrow(
			/reserved namespace .* cannot be registered/,
		);
	});
});

/**
 * The in-house half of the same charset check `checkRuleIds` applies to user config: a built-in
 * rule cannot ship an id the config file could never name. Checked directly against
 * `validateRegistry`, not through `loadConfig`, since this is a registry bug rather than a
 * config-file mistake — it throws a plain `Error`, the same as the existing reserved-namespace
 * and duplicate-id checks right above.
 */
test("validateRegistry rejects a registry rule id that violates the charset", () => {
	const registry: readonly Rule[] = [fakeRule("Skill/Bad_Id")];

	expect(() => validateRegistry(registry)).toThrow(
		/must look like "namespace\/name"/,
	);
});

/**
 * `RESERVED_NAMESPACES` is imported into engine.ts, discover.ts and run.ts,
 * each of which asserts an owned pseudo-rule id against it at import time — `Readonly<T>` is a
 * type, not a lock (AGENTS.md), and this array had none until now.
 */
test("RESERVED_NAMESPACES is frozen", () => {
	expect(() => {
		(RESERVED_NAMESPACES as string[]).push("evil/");
	}).toThrow(TypeError);
});

/**
 * `Document.surface` hands this object to every rule in the run, so a mutable one would undo
 * the point of freezing the Document itself: a rule could rewrite the dialects the next
 * document is judged against. `Readonly<>` is a type, not a lock.
 */
test("a resolved surface and everything reachable from it is frozen", async () => {
	await withConfig(
		'{ "surfaces": [{ "root": "x", "rules": { "skill/frontmatter-schema": "warn" } }] }\n',
		async (dir) => {
			const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);
			const surface = resolved.surfaces[0];
			if (!surface) throw new Error("expected a surface");

			expect(Object.isFrozen(resolved.surfaces)).toBe(true);
			expect(Object.isFrozen(surface)).toBe(true);
			expect(() => {
				(surface as { root: string }).root = "/etc";
			}).toThrow(TypeError);
			expect(() => {
				(surface.dialects as DialectId[]).push("cursor");
			}).toThrow(TypeError);
			expect(() => {
				(surface.include as string[]).push("**/*");
			}).toThrow(TypeError);
			// a Map keeps working through `set` even when frozen, so the mutators are shadowed
			expect(() => {
				(surface.rules as Map<string, SurfaceRuleOverride>).set("x", {
					severity: "off",
				});
			}).toThrow(TypeError);
			expect(() => {
				(resolved.rules as Map<string, ResolvedRule>).clear();
			}).toThrow(TypeError);
			// `sealMap` only locked the map's own shape — the plain override
			// object each `.get(id)` hands back was still mutable, so a rule could rewrite
			// `doc.surface.rules.get(id)!.severity` and every later rule would see the lie.
			const override = surface.rules.get("skill/frontmatter-schema");
			if (!override) throw new Error("expected an override entry");
			expect(() => {
				(override as { severity: string }).severity = "off";
			}).toThrow(TypeError);

			expect(surface.root).toBe("x");
			expect(surface.dialects).toEqual(["generic"]);
			expect(resolved.rules.size).toBe(1);
		},
	);
});

test("a second surface's loc points at its own line, not the first one's", async () => {
	await withConfig(
		'{ "surfaces": [{ "root": "a" }, { "root": "b" }] }\n',
		async (dir) => {
			const resolved = await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY);

			expect(resolved.surfaces.map((s) => s.loc)).toEqual([
				{ line: 1, col: 26, endLine: 1, endCol: 29 },
				{ line: 1, col: 43, endLine: 1, endCol: 46 },
			]);
		},
	);
});

// ---------------------------------------------------------------------------
// Surface spokes: declared on the hub, normalized, carried on the resolved surface
// ---------------------------------------------------------------------------

test("spokes resolve normalized, in written order, frozen, each with the position of its own entry", async () => {
	const surface = await onlySurface(
		'{\n  "surfaces": [{\n    "root": ".agents/skills",\n    "spokes": [".cursor/skills", "./.claude/skills/"]\n  }]\n}\n',
	);

	expect(surface.spokes).toEqual([
		{
			path: ".cursor/skills",
			loc: { line: 4, col: 16, endLine: 4, endCol: 32 },
		},
		{
			path: ".claude/skills",
			loc: { line: 4, col: 34, endLine: 4, endCol: 53 },
		},
	]);
	expect(Object.isFrozen(surface.spokes)).toBe(true);
	expect(() => {
		(surface.spokes as ResolvedSpoke[]).push({ path: "x" });
	}).toThrow(TypeError);
	for (const spoke of surface.spokes) {
		expect(Object.isFrozen(spoke)).toBe(true);
		expect(Object.isFrozen(spoke.loc)).toBe(true);
	}
});

test("a surface without spokes resolves to an empty, frozen list", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": ".agents/skills" }] }\n',
	);

	expect(surface.spokes).toEqual([]);
	expect(Object.isFrozen(surface.spokes)).toBe(true);
});

test("a spoke listed twice, in any spelling, is kept once at its first position", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "h", "spokes": ["a", "b", "./a/", "a"] }] }\n',
	);

	expect(surface.spokes.map((s) => s.path)).toEqual(["a", "b"]);
	expect(surface.spokes.map((s) => s.loc)).toEqual([
		{ line: 1, col: 42, endLine: 1, endCol: 45 },
		{ line: 1, col: 47, endLine: 1, endCol: 50 },
	]);
});

test("a duplicate listed before a later spoke does not shift that spoke's position", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "h", "spokes": ["a", "./a/", "b"] }] }\n',
	);

	expect(surface.spokes.map((s) => s.path)).toEqual(["a", "b"]);
	expect(surface.spokes.map((s) => s.loc)).toEqual([
		{ line: 1, col: 42, endLine: 1, endCol: 45 },
		{ line: 1, col: 55, endLine: 1, endCol: 58 },
	]);
});

test("a spoke the locator cannot place has no loc key, rather than an own one holding undefined", () => {
	const spokes = resolveSpokes(["a", "b"], (position) =>
		position === 0 ? undefined : { line: 3, col: 7 },
	);

	expect(spokes).toEqual([
		{ path: "a" },
		{ path: "b", loc: { line: 3, col: 7 } },
	]);
	expect("loc" in (spokes[0] ?? {})).toBe(false);
});

test("spokes are normalized to repo-relative posix paths: trailing slashes, ./ prefixes, repeated slashes and a/../b", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "h", "spokes": ["a/b/", "x/../y", "./c//d/", "./", "a/.."] }] }\n',
	);

	expect(surface.spokes.map((s) => s.path)).toEqual(["a/b", "y", "c/d", "."]);
});

test.skipIf(process.platform === "win32")(
	"a backslash in a spoke is a literal character on POSIX, not a separator",
	async () => {
		const surface = await onlySurface(
			`{ "surfaces": [{ "root": "h", "spokes": [${JSON.stringify("a\\b/")}] }] }\n`,
		);

		expect(surface.spokes.map((s) => s.path)).toEqual(["a\\b"]);
	},
);

test("an absolute or repo-escaping spoke keeps its escaping shape through normalization, for validateSurfaces to reject", async () => {
	const surface = await onlySurface(
		'{ "surfaces": [{ "root": "h", "spokes": ["/etc/skills/", "../x/", "a/../../x"] }] }\n',
	);

	expect(surface.spokes.map((s) => s.path)).toEqual(["/etc/skills", "../x"]);
});

test("a typo'd key (spoke) is an unknown-key problem at the key, not a silently ignored list", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": ".agents/skills", "spoke": [".claude/skills"] }] }\n',
	);

	expect(problem.message).toBe('unrecognized key "surfaces.0.spoke"');
	expect(problem.loc).toEqual({ line: 1, col: 44, endLine: 1, endCol: 51 });
});

test("an empty spoke entry is rejected by the schema at that entry", async () => {
	const problem = await onlyProblem(
		'{ "surfaces": [{ "root": "h", "spokes": ["a", ""] }] }\n',
	);

	expect(problem.message).toContain("surfaces.0.spokes.1");
	expect(problem.loc).toEqual({ line: 1, col: 47, endLine: 1, endCol: 49 });
});
