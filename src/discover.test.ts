import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_FILENAME,
	ConfigError,
	loadConfig,
	type ResolvedConfig,
	type ResolvedSpoke,
	type ResolvedSurface,
} from "./config.js";
import type { Loc } from "./diagnostic.js";
import { discoverFiles } from "./discover.js";
import type { Rule } from "./rule.js";
import { frontmatterSchema } from "./rules/skill/frontmatter-schema.js";

const FRONTMATTER_SCHEMA_ONLY: readonly Rule[] = [frontmatterSchema];

// Anchored to this module's own location, not process.cwd() — cwd-relative paths break as
// soon as the test suite is invoked from a directory other than the repo root (e.g. `bun
// test` from within src/). import.meta.url is standard ESM, not Bun-only.
const SKILLS_REPO_FIXTURE = fileURLToPath(
	new URL("../test/fixtures/skills-repo", import.meta.url),
);

/** Creates a fresh temp dir, runs `body`, and always cleans it up afterwards. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-discover-"));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface SurfaceInput {
	root: string;
	include?: readonly string[];
	ignore?: readonly string[];
	/** set it to assert that a problem about this surface points at the user's own line */
	loc?: Loc;
	/** already normalized, as `loadConfig` hands them over; a `loc` is asserted on in problems */
	spokes?: readonly ResolvedSpoke[];
}

/** Builds a `ResolvedConfig` directly — discoverFiles takes the resolved shape, not yaml. */
function makeConfig(
	root: string,
	surfaces: readonly SurfaceInput[],
	ignore: readonly string[] = [],
): ResolvedConfig {
	return {
		root,
		origin: "config",
		configFile: join(root, CONFIG_FILENAME),
		ignore,
		surfaces: surfaces.map((s) => ({
			root: s.root,
			kind: "skills" as const,
			dialects: ["generic" as const],
			include: s.include ?? ["**/SKILL.md"],
			ignore: s.ignore ?? [],
			spokes: s.spokes ?? [],
			rules: new Map(),
			...(s.loc === undefined ? {} : { loc: s.loc }),
		})),
		rules: new Map(),
		ruleOptions: new Map(),
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
	throw new Error("expected discoverFiles to reject with ConfigError");
}

// Feature-detected once, not platform-string-checked: CI runs ubuntu-latest (case-sensitive
// ext4), while local dev is darwin (case-insensitive APFS by default) — a `process.platform
// === "darwin"` check would either skip the test everywhere that matters in CI, or assume a
// filesystem property that isn't actually guaranteed by the OS. Probing is a few extra
// milliseconds at module load and works correctly on both.
const CASE_INSENSITIVE_FS = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-case-probe-"));
	try {
		await mkdir(join(dir, "probe"), { recursive: true });
		try {
			await stat(join(dir, "PROBE"));
			return true;
		} catch {
			return false;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

test("discovering the skills-repo fixture returns exactly the 6 SKILL.md files, sorted, repo-relative, posix, excluding reference.md", async () => {
	const resolved = await loadConfig(
		SKILLS_REPO_FIXTURE,
		FRONTMATTER_SCHEMA_ONLY,
	);

	const files = (await discoverFiles(resolved)).map((f) => f.path);

	expect(files).toEqual([
		".claude/skills/broken-yaml/SKILL.md",
		".claude/skills/empty-name/SKILL.md",
		".claude/skills/good-skill/SKILL.md",
		".claude/skills/missing-description/SKILL.md",
		".claude/skills/no-frontmatter/SKILL.md",
		".claude/skills/unknown-key/SKILL.md",
	]);
});

test("surface.ignore filters a matched file out of discovery", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "keep"), { recursive: true });
		await mkdir(join(dir, "skills", "drop"), { recursive: true });
		await writeFile(join(dir, "skills", "keep", "SKILL.md"), "keep", "utf8");
		await writeFile(join(dir, "skills", "drop", "SKILL.md"), "drop", "utf8");

		const config = makeConfig(dir, [{ root: "skills", ignore: ["drop/**"] }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/keep/SKILL.md"]);
	});
});

test("config.ignore is matched relative to each surface root: `dist/**` filters <surface>/dist", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "dist"), { recursive: true });
		await mkdir(join(dir, "skills", "real"), { recursive: true });
		await writeFile(join(dir, "skills", "dist", "SKILL.md"), "x", "utf8");
		await writeFile(join(dir, "skills", "real", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [{ root: "skills" }], ["dist/**"]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/real/SKILL.md"]);
	});
});

test("a repo-anchored ignore pattern (`skills/dist/**`) does NOT filter <surface>/dist — ignore is matched relative to the surface root, not the repo root", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "dist"), { recursive: true });
		await writeFile(join(dir, "skills", "dist", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [{ root: "skills" }], ["skills/dist/**"]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		// Honest semantics: "skills/dist/**" is evaluated against the surface-relative path
		// "dist/SKILL.md", not "skills/dist/SKILL.md" — it never matches, so the file
		// survives even though a repo-root mental model would expect it excluded.
		expect(files).toEqual(["skills/dist/SKILL.md"]);
	});
});

test("the global config.ignore excludes a file under node_modules inside a surface (the always-on defaults loadConfig merges in)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "node_modules", "pkg"), {
			recursive: true,
		});
		await mkdir(join(dir, "skills", "real"), { recursive: true });
		await writeFile(
			join(dir, "skills", "node_modules", "pkg", "SKILL.md"),
			"x",
			"utf8",
		);
		await writeFile(join(dir, "skills", "real", "SKILL.md"), "x", "utf8");

		const config = makeConfig(
			dir,
			[{ root: "skills" }],
			["**/node_modules/**", "**/.git/**"],
		);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/real/SKILL.md"]);
	});
});

/**
 * The surface decides which dialects a file is checked against, so "whichever surface came
 * first in the config" is not an answer. Two genuinely different roots whose globs land on the
 * same file are the per-file case; two spellings of the *same* directory are the other case
 * below, and get a different message because "list several dialects" is not the fix when the
 * user has one directory named twice.
 */
test("a file matched by two different surfaces names both, owner first", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [
			{ root: ".", include: ["skills/**/SKILL.md"] },
			{ root: "skills" },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toBe(
			'"skills/a/SKILL.md" is matched by surfaces[0] (".") and surfaces[1] ("skills"); a file belongs to exactly one surface — list several dialects on one surface instead of overlapping two',
		);
	});
});

/**
 * tinyglobby's match order is not stable between runs, so building the problem list in match
 * order made this test flaky (8 failures in 25 runs before the fix). Errors are keyed and
 * sorted by path, the same way the returned file list always was.
 */
test("every overlapping file is reported, sorted by path", async () => {
	await withTempDir(async (dir) => {
		for (const name of ["d", "b", "a", "c"]) {
			await mkdir(join(dir, "skills", name), { recursive: true });
			await writeFile(join(dir, "skills", name, "SKILL.md"), "x", "utf8");
		}

		const config = makeConfig(dir, [
			{ root: ".", include: ["skills/**/SKILL.md"] },
			{ root: "skills" },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.map((p) => p.message.split('"')[1])).toEqual([
			"skills/a/SKILL.md",
			"skills/b/SKILL.md",
			"skills/c/SKILL.md",
			"skills/d/SKILL.md",
		]);
	});
});

/**
 * A symlinked hub (`.agents/skills` → `.claude/skills`) is an explicitly supported layout,
 * so it must not be reported once per file with advice that does not apply to it. One problem,
 * naming the two surfaces, is the honest answer.
 */
test('two spellings of the same surface root ("skills" and "./skills/") are one directory, reported once', async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await mkdir(join(dir, "skills", "b"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");
		await writeFile(join(dir, "skills", "b", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [{ root: "skills" }, { root: "./skills/" }]);

		const err = await catchConfigError(discoverFiles(config));

		// once, not once per file underneath
		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toBe(
			'surfaces[0] ("skills") and surfaces[1] ("./skills/") resolve to the same directory; a directory belongs to exactly one surface — list several dialects on one surface instead',
		);
	});
});

test("a surface root reached through a symlink is the same directory as its target", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await writeFile(join(dir, ".claude", "skills", "SKILL.md"), "x", "utf8");
		await symlink(join(dir, ".claude", "skills"), join(dir, "hub"), "dir");

		const config = makeConfig(dir, [
			{ root: ".claude/skills" },
			{ root: "hub" },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toBe(
			'surfaces[0] (".claude/skills") and surfaces[1] ("hub") resolve to the same directory; a directory belongs to exactly one surface — list several dialects on one surface, or declare "hub" as a spoke of the surface rooted at ".claude/skills"',
		);
	});
});

test("the spoke hint names the symlink as the spoke and the real directory as the hub, whichever surface comes first", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await writeFile(join(dir, ".claude", "skills", "SKILL.md"), "x", "utf8");
		await symlink(join(dir, ".claude", "skills"), join(dir, "hub"), "dir");

		const err = await catchConfigError(
			discoverFiles(
				makeConfig(dir, [{ root: "hub" }, { root: ".claude/skills" }]),
			),
		);

		expect(err.problems.map((p) => p.message)).toEqual([
			'surfaces[0] ("hub") and surfaces[1] (".claude/skills") resolve to the same directory; a directory belongs to exactly one surface — list several dialects on one surface, or declare "hub" as a spoke of the surface rooted at ".claude/skills"',
		]);
	});
});

test("two symlinks to one directory get the hint without a direction", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "real"), { recursive: true });
		await writeFile(join(dir, "real", "SKILL.md"), "x", "utf8");
		await symlink(join(dir, "real"), join(dir, "a"), "dir");
		await symlink(join(dir, "real"), join(dir, "b"), "dir");

		const err = await catchConfigError(
			discoverFiles(makeConfig(dir, [{ root: "a" }, { root: "b" }])),
		);

		expect(err.problems.map((p) => p.message)).toEqual([
			'surfaces[0] ("a") and surfaces[1] ("b") resolve to the same directory; a directory belongs to exactly one surface — list several dialects on one surface, or declare one directory as the other\'s spoke',
		]);
	});
});

test.skipIf(!CASE_INSENSITIVE_FS)(
	"on a case-insensitive filesystem, two case variants of the same surface root (.claude/skills vs .Claude/skills, only the lowercase one created on disk) are one directory",
	async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, ".claude", "skills"), { recursive: true });
			await writeFile(join(dir, ".claude", "skills", "SKILL.md"), "x", "utf8");

			const config = makeConfig(dir, [
				{ root: ".claude/skills" },
				{ root: ".Claude/skills" },
			]);

			const err = await catchConfigError(discoverFiles(config));

			expect(err.problems[0]?.message).toContain(
				"resolve to the same directory",
			);
			expect(err.problems[0]?.message).toContain(
				"or declare one directory as the other's spoke",
			);
		});
	},
);

test("an overlap is positioned at the claiming surface's root, when the surface has a loc", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(join(dir, "skills", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [
			{ root: ".", include: ["skills/**/SKILL.md"] },
			{ root: "skills", loc: { line: 9, col: 5 } },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems[0]?.loc).toEqual({ line: 9, col: 5 });
	});
});

test("discovery pairs each file with the surface that claimed it", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "a"), { recursive: true });
		await mkdir(join(dir, "b"), { recursive: true });
		await writeFile(join(dir, "a", "SKILL.md"), "x", "utf8");
		await writeFile(join(dir, "b", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [{ root: "b" }, { root: "a" }]);

		const files = await discoverFiles(config);

		// sorted by path regardless of the order the surfaces are declared in
		expect(files.map((f) => f.path)).toEqual(["a/SKILL.md", "b/SKILL.md"]);
		expect(files.map((f) => f.surface.root)).toEqual(["a", "b"]);
		expect(files[0]?.surface).toBe(config.surfaces[1] as ResolvedSurface);
	});
});

test("a nonexistent surface root throws ConfigError naming the offending surface root", async () => {
	await withTempDir(async (dir) => {
		const config = makeConfig(dir, [{ root: "does-not-exist" }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("does-not-exist");
	});
});

test("a surface root that exists but is a file, not a directory, throws ConfigError", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "not-a-directory"), "hello", "utf8");
		const config = makeConfig(dir, [{ root: "not-a-directory" }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("not-a-directory");
	});
});

test("an absolute surface root pointing outside the repo throws ConfigError", async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outside = join(dir, "outside");
		await mkdir(repoRoot, { recursive: true });
		await mkdir(outside, { recursive: true });

		const config = makeConfig(repoRoot, [{ root: outside }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("escapes");
	});
});

test('a relative surface root that escapes the repo ("../outside") throws ConfigError', async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outside = join(dir, "outside");
		await mkdir(repoRoot, { recursive: true });
		await mkdir(outside, { recursive: true });

		const config = makeConfig(repoRoot, [{ root: "../outside" }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("escapes");
	});
});

test("an absolute include pattern matching a file outside the repo throws ConfigError naming the surface and the offending path", async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outside = join(dir, "outside");
		await mkdir(join(repoRoot, "skills"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.md"), "secret", "utf8");

		// realpath'd: validateSurfaces resolves the surface root (the glob's cwd) through
		// realpath before matching, so on a platform where the OS temp dir is itself a
		// symlink (macOS: /var -> /private/var), an include pattern built from the
		// non-realpath'd `outside` would no longer share a filesystem-real common prefix with
		// cwd, and tinyglobby's absolute-to-cwd-relative arithmetic would silently match
		// nothing — a test-harness artifact, not a property of the fix under test.
		const realSecret = await realpath(join(outside, "secret.md"));

		const config = makeConfig(repoRoot, [
			{ root: "skills", include: [realSecret] },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("outside the repository");
		expect(err.message).toContain("skills");
	});
});

test('a relative include pattern that escapes the repo ("../../outside/secret.md") throws ConfigError', async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outside = join(dir, "outside");
		await mkdir(join(repoRoot, "skills"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.md"), "secret", "utf8");

		const config = makeConfig(repoRoot, [
			{ root: "skills", include: ["../../outside/secret.md"] },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("outside the repository");
	});
});

test("a normal include pattern (no escape) is unaffected by the escape guard", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [
			{ root: "skills", include: ["a/SKILL.md"] },
		]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/a/SKILL.md"]);
	});
});

test("multiple bad surfaces (nonexistent, non-directory, escaping) are all collected into a single ConfigError, not just the first", async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outside = join(dir, "outside");
		await mkdir(repoRoot, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(repoRoot, "not-a-directory"), "hello", "utf8");

		const config = makeConfig(repoRoot, [
			{ root: "does-not-exist" },
			{ root: "not-a-directory" },
			{ root: "../outside" },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(3);
	});
});

test("an existing but empty surface directory returns no files (not an error)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"), { recursive: true });
		// No `loc` on this surface (this test's `makeConfig` helper only adds one when a test
		// explicitly asks for it) — the same shape zero-config auto-detection produces for
		// a synthesized surface. `config/no-files` treats an absent `loc` as "not something
		// the user actually wrote", so it silently opts out of the zero-match check; that is what
		// this test now pins, not merely "an empty directory is fine".
		const config = makeConfig(dir, [{ root: "skills" }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual([]);
	});
});

test("an explicitly configured surface (has a `loc`) that matches zero files is a `config/no-files` ConfigError positioned at the surface's own loc", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"), { recursive: true });
		const config = makeConfig(
			dir,
			[
				{
					root: "skills",
					include: ["**/SKILL.md", "**/other.md"],
					ignore: ["**/x/**"],
					loc: { line: 3, col: 5 },
				},
			],
			["**/node_modules/**"],
		);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.ruleId).toBe("config/no-files");
		expect(err.problems[0]?.loc).toEqual({ line: 3, col: 5 });
		// the ignore list (surface's own, then the global one — the same order
		// `discoverFiles` passes to `glob`) rides along, so the message is not blamed on
		// `include` alone when `ignore` might be the actual culprit.
		expect(err.problems[0]?.message).toBe(
			'surfaces[0] ("skills") matched no files; include patterns: **/SKILL.md, **/other.md; ignore patterns: **/x/**, **/node_modules/**',
		);
	});
});

test("an explicit surface with an empty `include` list gets the empty-include message", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills"), { recursive: true });
		const config = makeConfig(dir, [
			{ root: "skills", include: [], loc: { line: 1, col: 1 } },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.ruleId).toBe("config/no-files");
		expect(err.problems[0]?.message).toBe(
			'surfaces[0] ("skills") matched no files; its include list is empty; ignore patterns: ',
		);
	});
});

/**
 * the pre-fix message named only `include` — unfixable advice, since
 * `**\/SKILL.md` genuinely matches `skills/a/SKILL.md`. It was `ignore` that filtered the match
 * out, and nothing in the old message said so.
 */
test("config/no-files blames `ignore` too when it, not `include`, filtered out the only match", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");
		const config = makeConfig(
			dir,
			[
				{
					root: "skills",
					ignore: ["**/a/**"],
					loc: { line: 1, col: 1 },
				},
			],
			["**/node_modules/**", "**/.git/**"],
		);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toBe(
			'surfaces[0] ("skills") matched no files; include patterns: **/SKILL.md; ignore patterns: **/a/**, **/node_modules/**, **/.git/**',
		);
	});
});

test("two explicit surfaces that both match zero files produce two problems, in config order", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "a"), { recursive: true });
		await mkdir(join(dir, "b"), { recursive: true });
		const config = makeConfig(dir, [
			{ root: "a", loc: { line: 1, col: 1 } },
			{ root: "b", loc: { line: 2, col: 1 } },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(2);
		expect(err.problems.map((p) => p.ruleId)).toEqual([
			"config/no-files",
			"config/no-files",
		]);
		expect(err.problems[0]?.loc).toEqual({ line: 1, col: 1 });
		expect(err.problems[1]?.loc).toEqual({ line: 2, col: 1 });
	});
});

test("overlap is reported before no-files: two surfaces claiming the same single file produce only the overlap problem, never a bogus no-files diagnosis of the surface that lost every file to the overlap", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [
			{ root: ".", include: ["skills/**/SKILL.md"], loc: { line: 1, col: 1 } },
			{ root: "skills", loc: { line: 2, col: 1 } },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.message).toContain("is matched by");
		expect(err.problems.some((p) => p.ruleId === "config/no-files")).toBe(
			false,
		);
	});
});

test("a directory symlink inside a surface is not traversed", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "real"), { recursive: true });
		await writeFile(join(dir, "skills", "real", "SKILL.md"), "x", "utf8");
		await symlink(
			join(dir, "skills", "real"),
			join(dir, "skills", "linked-dir"),
			"dir",
		);

		const config = makeConfig(dir, [{ root: "skills" }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		// Only the real path is found — the symlinked directory is not descended into, so it
		// never contributes a second ("skills/linked-dir/SKILL.md") match.
		expect(files).toEqual(["skills/real/SKILL.md"]);
	});
});

test("a file symlink matching the include pattern is excluded too, not just symlinked directories (pinned tinyglobby behavior, followSymbolicLinks: false)", async () => {
	// Observed by direct experiment against tinyglobby 0.2.17: with `followSymbolicLinks:
	// false`, a plain file named SKILL.md that is itself a symlink to another file is
	// dropped from the results entirely — not merely "not traversed" (that phrase only
	// makes sense for directories), but excluded outright even though its parent directory
	// is a real directory and the pattern matches its name. Pinning this here because the
	// test above covers only directory symlinks; this is the file-symlink half.
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "real"), { recursive: true });
		await writeFile(join(dir, "skills", "real", "SKILL.md"), "x", "utf8");
		await mkdir(join(dir, "skills", "symlinked-file"), { recursive: true });
		await symlink(
			join(dir, "skills", "real", "SKILL.md"),
			join(dir, "skills", "symlinked-file", "SKILL.md"),
			"file",
		);

		const config = makeConfig(dir, [{ root: "skills" }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/real/SKILL.md"]);
	});
});

test("a symlinked surface root whose target is inside the repo resolves through to the target's real path", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "real-skills"), { recursive: true });
		await writeFile(join(dir, "real-skills", "SKILL.md"), "x", "utf8");
		await symlink(join(dir, "real-skills"), join(dir, "linked-skills"), "dir");

		const config = makeConfig(dir, [{ root: "linked-skills" }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		// Repo-relative path uses the target's real location, not the symlink's name.
		expect(files).toEqual(["real-skills/SKILL.md"]);
	});
});

test("a symlinked surface root whose target is outside the repo throws ConfigError", async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outsideTarget = join(dir, "outside-target");
		await mkdir(repoRoot, { recursive: true });
		await mkdir(outsideTarget, { recursive: true });
		await symlink(outsideTarget, join(repoRoot, "linked-skills"), "dir");

		const config = makeConfig(repoRoot, [{ root: "linked-skills" }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.message).toContain("escapes");
	});
});

test("an include pattern naming a bare directory matches nothing (expandDirectories: false — include patterns mean only what they say)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "SKILL.md"), "x", "utf8");

		// No `loc` on this surface, same as its neighbour above ("an existing but empty surface
		// directory returns no files") — silently opts out of the `config/no-files` check, which
		// is why zero matches here returns an empty list instead of throwing a ConfigError.
		const config = makeConfig(dir, [{ root: "skills", include: ["a"] }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual([]);
	});
});

test("returned paths use forward slashes only, never backslashes (Windows-path safety)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "skills", "a", "b"), { recursive: true });
		await writeFile(join(dir, "skills", "a", "b", "SKILL.md"), "x", "utf8");

		const config = makeConfig(dir, [{ root: "skills" }]);

		const files = (await discoverFiles(config)).map((f) => f.path);

		expect(files).toEqual(["skills/a/b/SKILL.md"]);
		for (const file of files) {
			expect(file.includes("\\")).toBe(false);
		}
	});
});

/** The `loc` on the pre-existing root problems needs its own cover. */
test("a nonexistent root and an escaping root each report at their own surface's line", async () => {
	await withTempDir(async (dir) => {
		const config = makeConfig(dir, [
			{ root: "nope", loc: { line: 2, col: 11 } },
			{ root: "/etc", loc: { line: 4, col: 11 } },
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.map((p) => p.loc)).toEqual([
			{ line: 2, col: 11 },
			{ line: 4, col: 11 },
		]);
	});
});

/**
 * A surface with no yaml behind it (zero-config auto-detection synthesizes those) still reports,
 * just without a caret.
 */
test("a surface with no loc still produces an unpositioned problem", async () => {
	await withTempDir(async (dir) => {
		const config = makeConfig(dir, [{ root: "nope" }]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.length).toBe(1);
		expect(err.problems[0]?.loc).toBeUndefined();
		expect("loc" in (err.problems[0] ?? {})).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Spokes: tool directories declared on a surface, validated against the other surfaces
// ---------------------------------------------------------------------------

interface SpokeSurface {
	root: string;
	include?: readonly string[];
	spokes?: readonly string[];
}

/** Every spoke on a line of its own (indented 8), so a problem's line can be read off the text. */
function spokeConfig(surfaces: readonly SpokeSurface[]): string {
	const blocks = surfaces.map(({ root, include, spokes }) => {
		const props = [`      "root": ${JSON.stringify(root)}`];
		if (include !== undefined) {
			props.push(`      "include": ${JSON.stringify(include)}`);
		}
		if (spokes !== undefined) {
			props.push(
				`      "spokes": [\n${spokes
					.map((spoke) => `        ${JSON.stringify(spoke)}`)
					.join(",\n")}\n      ]`,
			);
		}
		return `    {\n${props.join(",\n")}\n    }`;
	});
	return `{\n  "surfaces": [\n${blocks.join(",\n")}\n  ]\n}\n`;
}

function lineOf(text: string, needle: string): number {
	return text.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

/** Writes the config into `dir`, loads it, and runs discovery — the whole path a run takes. */
async function discoverConfigured(dir: string, json: string) {
	await writeFile(join(dir, CONFIG_FILENAME), json, "utf8");
	return await discoverFiles(await loadConfig(dir, FRONTMATTER_SCHEMA_ONLY));
}

async function spokeProblems(dir: string, json: string) {
	return (await catchConfigError(discoverConfigured(dir, json))).problems;
}

async function makeHub(dir: string, root: string): Promise<void> {
	await mkdir(join(dir, root, "a"), { recursive: true });
	await writeFile(join(dir, root, "a", "SKILL.md"), "x", "utf8");
}

const OWN_ROOT_HINT = "a spoke is a separate directory that mirrors the hub";
const OTHER_ROOT_HINT = "a spoke may not overlap another surface's root";

test("a directory-level symlink to the hub and a spoke that does not exist are both accepted, and discovery is unchanged", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await mkdir(join(dir, ".claude"), { recursive: true });
		await symlink(
			join(dir, ".agents", "skills"),
			join(dir, ".claude", "skills"),
			"dir",
		);

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{
					root: ".agents/skills",
					spokes: [".claude/skills", ".cursor/skills"],
				},
			]),
		);

		expect(files.map((f) => f.path)).toEqual([".agents/skills/a/SKILL.md"]);
		expect(files[0]?.surface.spokes.map((s) => s.path)).toEqual([
			".claude/skills",
			".cursor/skills",
		]);
	});
});

test("an absolute spoke is a problem positioned at that entry", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		const json = spokeConfig([
			{
				root: ".agents/skills",
				spokes: [".claude/skills", "/opt/tools/skills"],
			},
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.message)).toEqual([
			'spoke "/opt/tools/skills" of surfaces[0] (".agents/skills") is an absolute path; write it relative to the repository root',
		]);
		expect(problems[0]?.loc).toEqual({
			line: lineOf(json, '"/opt/tools/skills"'),
			col: 9,
			endLine: lineOf(json, '"/opt/tools/skills"'),
			endCol: 28,
		});
	});
});

test("a spoke that climbs out of the repository is a problem, also when it only gets there through a/../..", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([{ root: ".agents/skills", spokes: ["../x", "a/../../y/"] }]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			'spoke "../x" of surfaces[0] (".agents/skills") escapes the repository root',
			'spoke "../y" of surfaces[0] (".agents/skills") escapes the repository root',
		]);
	});
});

test("a spoke equal to its own root after normalization is a problem, however it is spelled", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{
					root: ".agents/skills",
					spokes: ["./.agents/skills", "x/../.agents/skills/"],
				},
			]),
		);

		// both spellings are one spoke, kept once and reported once, under its normalized name
		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".agents/skills" of surfaces[0] (".agents/skills") is its own root; ${OWN_ROOT_HINT}`,
		]);
	});
});

test("a spoke inside its own root is a problem", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([{ root: ".agents/skills", spokes: [".agents/skills/a/b"] }]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".agents/skills/a/b" of surfaces[0] (".agents/skills") is inside its own root; ${OWN_ROOT_HINT}`,
		]);
	});
});

test("a spoke containing its own root is a problem, including the repository root itself", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([{ root: ".agents/skills", spokes: [".agents", "./"] }]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".agents" of surfaces[0] (".agents/skills") contains its own root; ${OWN_ROOT_HINT}`,
			`spoke "." of surfaces[0] (".agents/skills") contains its own root; ${OWN_ROOT_HINT}`,
		]);
	});
});

test("a spoke equal to another surface's root is a problem at the spoke", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, ".cursor/skills");
		const json = spokeConfig([
			{ root: ".agents/skills", spokes: [".cursor/skills"] },
			{ root: ".cursor/skills" },
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".cursor/skills" of surfaces[0] (".agents/skills") is the root of surfaces[1] (".cursor/skills"); ${OTHER_ROOT_HINT}`,
		]);
		expect(problems[0]?.loc?.line).toBe(lineOf(json, '".cursor/skills"'));
	});
});

test("a spoke inside or containing another surface's root is a problem too", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, ".cursor/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{
					root: ".agents/skills",
					spokes: [".cursor/skills/mirror", ".cursor"],
				},
				{ root: ".cursor/skills" },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".cursor/skills/mirror" of surfaces[0] (".agents/skills") is inside the root of surfaces[1] (".cursor/skills"); ${OTHER_ROOT_HINT}`,
			`spoke ".cursor" of surfaces[0] (".agents/skills") contains the root of surfaces[1] (".cursor/skills"); ${OTHER_ROOT_HINT}`,
		]);
	});
});

/**
 * The rule for a spoke that exists on disk: compared with the other roots by its real path only
 * when it is NOT itself a symlink. A symlink spoke resolves to its target by design, and the
 * target of a correct directory-level spoke IS a root, so comparing it would flag every correct
 * layout; what the symlink points at is for the `hub/symlinks` rule to judge, not the config.
 */
test("a spoke that is a symlink to another surface's root is not a config problem; the rule judges where it points", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, ".cursor/skills");
		await mkdir(join(dir, ".claude"), { recursive: true });
		await symlink(
			join(dir, ".cursor", "skills"),
			join(dir, ".claude", "skills"),
			"dir",
		);

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{ root: ".agents/skills", spokes: [".claude/skills"] },
				{ root: ".cursor/skills" },
			]),
		);

		expect(files.map((f) => f.path)).toEqual([
			".agents/skills/a/SKILL.md",
			".cursor/skills/a/SKILL.md",
		]);
	});
});

test("a spoke that is not a symlink but resolves to another surface's root is a problem, found by its real path", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, ".cursor/skills");
		// `.claude/skills` is a plain path to lstat, but `.claude` itself leads into `.cursor`
		await symlink(join(dir, ".cursor"), join(dir, ".claude"), "dir");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{ root: ".agents/skills", spokes: [".claude/skills"] },
				{ root: ".cursor/skills" },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".claude/skills" of surfaces[0] (".agents/skills") is the root of surfaces[1] (".cursor/skills") (after resolving symlinks); ${OTHER_ROOT_HINT}`,
		]);
	});
});

test("a spoke that is the hub itself through a symlinked ancestor does not contain a surface nested inside the hub", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".claude/skills");
		await makeHub(dir, ".claude/skills/a/nested");
		await symlink(".claude", join(dir, ".agents"), "dir");
		await mkdir(join(dir, ".cursor"));
		await symlink(
			"../.claude/skills/a/nested",
			join(dir, ".cursor", "skills"),
			"dir",
		);

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{
					root: ".claude/skills",
					include: ["*/SKILL.md"],
					spokes: [".agents/skills"],
				},
				{ root: ".cursor/skills" },
			]),
		);

		expect(files.map((f) => f.path)).toEqual([
			".claude/skills/a/SKILL.md",
			".claude/skills/a/nested/a/SKILL.md",
		]);
	});
});

test("a spoke that leads to a directory other than the hub, holding a nested surface, is still a problem", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "elsewhere/sub/nested");
		await symlink("elsewhere", join(dir, ".alias"), "dir");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{ root: ".agents/skills", spokes: [".alias/sub"] },
				{ root: "elsewhere/sub/nested" },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".alias/sub" of surfaces[0] (".agents/skills") contains the root of surfaces[1] ("elsewhere/sub/nested") (after resolving symlinks); ${OTHER_ROOT_HINT}`,
		]);
	});
});

test("the same spoke declared by two surfaces is a problem naming both, at the second declaration", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "other");
		const json = spokeConfig([
			{ root: ".agents/skills", spokes: [".claude/skills"] },
			{ root: "other", spokes: ["./.claude/skills/"] },
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.message)).toEqual([
			'spoke ".claude/skills" is declared by both surfaces[0] (".agents/skills") and surfaces[1] ("other"); a directory mirrors exactly one hub',
		]);
		expect(problems[0]?.loc?.line).toBe(lineOf(json, '"./.claude/skills/"'));
	});
});

test("a spoke listed twice on one surface is one spoke, not a duplicate declaration", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{
					root: ".agents/skills",
					spokes: [".claude/skills", "./.claude/skills/"],
				},
			]),
		);

		expect(files[0]?.surface.spokes.map((s) => s.path)).toEqual([
			".claude/skills",
		]);
	});
});

test("every bad spoke is reported, after the root problems, in surface then declaration order", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, ".cursor/skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{ root: ".agents/skills", spokes: ["/abs", ".agents"] },
				{ root: "missing" },
				{ root: ".cursor/skills", spokes: ["../x"] },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			'surface root "missing" does not exist or is not a directory',
			'spoke "/abs" of surfaces[0] (".agents/skills") is an absolute path; write it relative to the repository root',
			`spoke ".agents" of surfaces[0] (".agents/skills") contains its own root; ${OWN_ROOT_HINT}`,
			'spoke "../x" of surfaces[2] (".cursor/skills") escapes the repository root',
		]);
	});
});

test("a spoke problem falls back to the surface's own position when the entry carries none", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "hub"), { recursive: true });
		const config = makeConfig(dir, [
			{
				root: "hub",
				spokes: [{ path: "/abs", loc: { line: 12, col: 3 } }, { path: "../x" }],
				loc: { line: 9, col: 5 },
			},
		]);

		const err = await catchConfigError(discoverFiles(config));

		expect(err.problems.map((p) => p.loc)).toEqual([
			{ line: 12, col: 3 },
			{ line: 9, col: 5 },
		]);
	});
});

/**
 * An outer root that holds both the hub and the spoke is just a broader surface; nested roots are
 * accepted everywhere else, so the spoke being "inside" it is not a conflict.
 */
test("a root that holds both the hub and the spoke does not make the spoke a conflict", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "skills");
		await mkdir(join(dir, ".claude"), { recursive: true });
		await symlink(
			join(dir, ".agents", "skills"),
			join(dir, ".claude", "skills"),
			"dir",
		);

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{ root: ".", include: ["skills/**/SKILL.md"] },
				{ root: ".agents/skills", spokes: [".claude/skills"] },
			]),
		);

		expect(files.map((f) => f.path)).toEqual([
			".agents/skills/a/SKILL.md",
			"skills/a/SKILL.md",
		]);
	});
});

test("the same holds for a spoke that is a real directory, found by its real path, under a root that is a symlink to the repository", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "skills");
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await symlink(dir, join(dir, "link"), "dir");

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{ root: "link", include: ["skills/**/SKILL.md"] },
				{ root: ".agents/skills", spokes: [".claude/skills"] },
			]),
		);

		expect(files.map((f) => f.path)).toEqual([
			".agents/skills/a/SKILL.md",
			"skills/a/SKILL.md",
		]);
	});
});

test("a spoke equal to the repository root is still a problem next to a root that holds it", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "skills");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{ root: ".", include: ["skills/**/SKILL.md"] },
				{ root: ".agents/skills", spokes: ["."] },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke "." of surfaces[1] (".agents/skills") contains its own root; ${OWN_ROOT_HINT}`,
		]);
	});
});

test("a spoke that is the hub itself through a symlinked root is a problem, at the spoke", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".claude/skills");
		await mkdir(join(dir, ".agents"), { recursive: true });
		await symlink(
			join(dir, ".claude", "skills"),
			join(dir, ".agents", "skills"),
			"dir",
		);
		const json = spokeConfig([
			{ root: ".agents/skills", spokes: [".claude/skills"] },
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke ".claude/skills" of surfaces[0] (".agents/skills") is its own root (after resolving symlinks); ${OWN_ROOT_HINT}`,
		]);
		expect(problems[0]?.loc?.line).toBe(lineOf(json, '".claude/skills"'));
	});
});

test("a spoke under a symlinked ancestor that resolves to the hub is a working mirror, not a problem", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await symlink(join(dir, ".agents"), join(dir, ".claude"), "dir");

		const files = await discoverConfigured(
			dir,
			spokeConfig([{ root: ".agents/skills", spokes: [".claude/skills"] }]),
		);

		expect(files.map((f) => f.path)).toEqual([".agents/skills/a/SKILL.md"]);
	});
});

test.skipIf(!CASE_INSENSITIVE_FS)(
	"on a case-insensitive filesystem, a spoke that is a case variant of the hub's real root is a problem",
	async () => {
		await withTempDir(async (dir) => {
			await makeHub(dir, ".agents/skills");

			const problems = await spokeProblems(
				dir,
				spokeConfig([{ root: ".Agents/skills", spokes: [".agents/skills"] }]),
			);

			expect(problems.map((p) => p.message)).toEqual([
				`spoke ".agents/skills" of surfaces[0] (".Agents/skills") is its own root (after resolving symlinks); ${OWN_ROOT_HINT}`,
			]);
		});
	},
);

test("the same spoke directory reached by two spellings through a symlinked ancestor is one declaration, across surfaces", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "other");
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await symlink(join(dir, ".claude"), join(dir, ".cursor"), "dir");
		const json = spokeConfig([
			{ root: ".agents/skills", spokes: [".claude/skills"] },
			{ root: "other", spokes: [".cursor/skills"] },
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.message)).toEqual([
			'spoke ".cursor/skills" of surfaces[1] ("other") is the same directory as spoke ".claude/skills" of surfaces[0] (".agents/skills") (after resolving symlinks); a directory mirrors exactly one hub',
		]);
		expect(problems[0]?.loc?.line).toBe(lineOf(json, '".cursor/skills"'));
	});
});

test("two symlink spokes with one target are not one declaration: a symlink is never judged by where it points", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		await makeHub(dir, "other");
		await mkdir(join(dir, "shared"), { recursive: true });
		await symlink(join(dir, "shared"), join(dir, "s1"), "dir");
		await symlink(join(dir, "shared"), join(dir, "s2"), "dir");

		const files = await discoverConfigured(
			dir,
			spokeConfig([
				{ root: ".agents/skills", spokes: ["s1"] },
				{ root: "other", spokes: ["s2"] },
			]),
		);

		expect(files.map((f) => f.path)).toEqual([
			".agents/skills/a/SKILL.md",
			"other/a/SKILL.md",
		]);
	});
});

test("a spoke that is a real directory resolving outside the repository is a problem; a symlink spoke leaving it is not", async () => {
	const outside = await mkdtemp(join(tmpdir(), "skillslurp-outside-"));
	try {
		await withTempDir(async (dir) => {
			await makeHub(dir, ".agents/skills");
			await mkdir(join(outside, "skills"), { recursive: true });
			await symlink(outside, join(dir, ".cursor"), "dir");
			await symlink(join(outside, "skills"), join(dir, "escape"), "dir");
			const json = spokeConfig([
				{
					root: ".agents/skills",
					spokes: ["escape", ".cursor/skills"],
				},
			]);

			const problems = await spokeProblems(dir, json);

			expect(problems.map((p) => p.message)).toEqual([
				'spoke ".cursor/skills" of surfaces[0] (".agents/skills") escapes the repository root (after resolving symlinks)',
			]);
			expect(problems[0]?.loc?.line).toBe(lineOf(json, '".cursor/skills"'));
		});
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("a duplicate listed before a bad spoke does not move the bad spoke's position", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, ".agents/skills");
		const json = spokeConfig([
			{
				root: ".agents/skills",
				spokes: [".claude/skills", "./.claude/skills/", "/abs"],
			},
		]);

		const problems = await spokeProblems(dir, json);

		expect(problems.map((p) => p.loc?.line)).toEqual([lineOf(json, '"/abs"')]);
		expect(problems[0]?.loc?.col).toBe(9);
	});
});

test("a spoke containing the roots of two other surfaces is one problem, naming the first", async () => {
	await withTempDir(async (dir) => {
		await makeHub(dir, "hub");
		await makeHub(dir, "x/one");
		await makeHub(dir, "x/two");

		const problems = await spokeProblems(
			dir,
			spokeConfig([
				{ root: "hub", spokes: ["x"] },
				{ root: "x/one" },
				{ root: "x/two" },
			]),
		);

		expect(problems.map((p) => p.message)).toEqual([
			`spoke "x" of surfaces[0] ("hub") contains the root of surfaces[1] ("x/one"); ${OTHER_ROOT_HINT}`,
		]);
	});
});
