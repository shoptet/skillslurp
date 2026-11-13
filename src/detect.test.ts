import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CANDIDATE_ROOTS, CANDIDATE_TABLE, detectSurfaces } from "./detect.js";
import { BUILTIN_DIALECTS } from "./dialects.js";
import { discoverFiles } from "./discover.js";
import { EXIT_CLEAN } from "./exit.js";
import { builtinRules } from "./rules/index.js";
import { runCli } from "./run.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

/** The always-on discovery excludes `loadConfig` (config.ts) actually passes in production. */
const IGNORE: readonly string[] = ["**/node_modules/**", "**/.git/**"];

/** Creates a fresh temp dir, runs `body`, and always cleans it up afterwards. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-detect-"));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Writes `rel` under `dir`, creating its parent directories. */
async function put(dir: string, rel: string, content = "x"): Promise<void> {
	await mkdir(dirname(join(dir, rel)), { recursive: true });
	await writeFile(join(dir, rel), content, "utf8");
}

/** Symlinks `at` (relative to `dir`) to `target`, creating `at`'s parent directories. */
async function link(dir: string, target: string, at: string): Promise<void> {
	await mkdir(dirname(join(dir, at)), { recursive: true });
	await symlink(target, join(dir, at), "dir");
}

/**
 * Probes whether `chmod 000` on a directory actually denies the current process read access,
 * the way `discover.test.ts` probes for a case-insensitive filesystem rather than checking
 * `process.platform`: running as root (or under a sandbox that grants read regardless of mode
 * bits) makes `chmod 000` a no-op in practice, and a test that assumed otherwise would either
 * silently pass for the wrong reason or fail on an environment it was never actually about.
 */
const CHMOD_DENIES_OWNER = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-chmod-probe-"));
	try {
		const probe = join(dir, "probe");
		await mkdir(probe);
		await writeFile(join(probe, "x.txt"), "x", "utf8");
		await chmod(probe, 0o000);
		try {
			await readdir(probe);
			return false;
		} catch {
			return true;
		} finally {
			await chmod(probe, 0o755);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

/**
 * Guards against a table typo shipping silently: a row pairing a kind with a dialect that
 * defines no contract for that kind would produce a surface no rule can ever check anything
 * against. Mutation-checked by pairing `.cursor/rules` with `claude-code` (a dialect with no
 * `rules` contract): confirmed to fail.
 */
test("every table row's dialect actually defines a contract for that row's kind", () => {
	for (const row of CANDIDATE_TABLE) {
		for (const dialect of row.dialects) {
			expect(BUILTIN_DIALECTS[dialect].contracts[row.kind]).not.toBeUndefined();
		}
	}
});

test("CANDIDATE_ROOTS lists the table's roots, in table order", () => {
	expect(CANDIDATE_ROOTS).toEqual(CANDIDATE_TABLE.map((row) => row.root));
});

test("the table and its rows are frozen", () => {
	expect(Object.isFrozen(CANDIDATE_TABLE)).toBe(true);
	const first = CANDIDATE_TABLE[0];
	if (!first) throw new Error("expected at least one table row");
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first.dialects)).toBe(true);
	expect(() => {
		(CANDIDATE_TABLE as unknown as { root: string }[]).push({ root: "evil" });
	}).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// Single-candidate detection
// ---------------------------------------------------------------------------

test(".claude/skills with one SKILL.md is detected as skills/claude-code", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"x",
			"utf8",
		);

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		const surface = surfaces[0];
		if (!surface) throw new Error("expected one surface");
		expect(surface.root).toBe(".claude/skills");
		expect(surface.kind).toBe("skills");
		expect(surface.dialects).toEqual(["claude-code"]);
	});
});

test(".agents/skills with one SKILL.md is detected as skills/generic", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".agents", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".agents", "skills", "my-skill", "SKILL.md"),
			"x",
			"utf8",
		);

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".agents/skills");
		expect(surfaces[0]?.kind).toBe("skills");
		expect(surfaces[0]?.dialects).toEqual(["generic"]);
	});
});

test("both .claude/skills and .agents/skills present produce two surfaces, in table order", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "a"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "skills", "a", "SKILL.md"),
			"x",
			"utf8",
		);
		await mkdir(join(dir, ".agents", "skills", "b"), { recursive: true });
		await writeFile(
			join(dir, ".agents", "skills", "b", "SKILL.md"),
			"x",
			"utf8",
		);

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([
			".claude/skills",
			".agents/skills",
		]);
	});
});

test("an existing but empty candidate directory is not detected, and is recorded as skipped/no-match", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toEqual([]);
		expect(skipped).toContainEqual({
			root: ".claude/skills",
			reason: "no-match",
		});
	});
});

test("an existing candidate directory holding only non-matching files is not detected, and is recorded as skipped/no-match", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await writeFile(join(dir, ".claude", "skills", "README.md"), "x", "utf8");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toEqual([]);
		expect(skipped).toContainEqual({
			root: ".claude/skills",
			reason: "no-match",
		});
	});
});

/**
 * A `.claude/skills` full of directory symlinks to real skill directories elsewhere in the
 * repo is a first-class layout (the `hub/symlinks` shape rule), but `followSymbolicLinks:
 * false` means the glob never traverses into `my-skill` to find its `SKILL.md`. The directory
 * itself is real, though — this must land in `skipped` as `"no-match"`, not be silently treated
 * as though `.claude/skills` were not there at all (the CLI used to report "no known agent-skill
 * layout found" for a layout sitting right there).
 */
test("a symlink-hub whose skill directories are themselves symlinks is not detected, and is recorded as skipped/no-match (nested symlinks are not traversed)", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "real", "my-skill"), { recursive: true });
		await writeFile(join(dir, "real", "my-skill", "SKILL.md"), "x", "utf8");
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await symlink(
			join(dir, "real", "my-skill"),
			join(dir, ".claude", "skills", "my-skill"),
			"dir",
		);

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toEqual([]);
		expect(skipped).toContainEqual({
			root: ".claude/skills",
			reason: "no-match",
		});
	});
});

/**
 * `glob` swallows an `EACCES` it hits while walking a candidate's contents and returns `[]` —
 * the same observable outcome as a genuinely empty directory. `detectSurfaces` cannot and does
 * not try to tell the two apart; both must land in `skipped` as `"no-match"` rather than the
 * candidate silently vanishing as though it were never there.
 *
 * The unreadable path is a subdirectory of the candidate root, not the candidate root itself:
 * `resolveRealDirectory`'s own `realpath`+`stat` call must still succeed for the candidate root
 * so this test exercises the intended layer (`glob`'s traversal swallowing the error), not
 * `resolveRealDirectory`'s. That distinction is not cosmetic — verified empirically, Bun's
 * `realpath` (unlike Node's, and unlike the POSIX `lstat` semantics a directory permission bit
 * would suggest) itself throws `EACCES` on a mode-000 directory, which would make this test
 * exercise `resolveRealDirectory`'s blanket catch instead of `glob`'s. That gap —
 * `resolveRealDirectory` cannot distinguish "does not exist" from "exists but `realpath` itself
 * refused it" — is real but out of scope here.
 *
 * Skipped (not `process.platform`-gated) when `chmod 000` does not actually deny the current
 * process — e.g. running as root — since then the premise of the test does not hold.
 */
test.skipIf(!CHMOD_DENIES_OWNER)(
	"a candidate whose only matching file sits under an unreadable subdirectory is not detected, and is recorded as skipped/no-match",
	async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, ".claude", "skills", "secret"), {
				recursive: true,
			});
			await writeFile(
				join(dir, ".claude", "skills", "secret", "SKILL.md"),
				"x",
				"utf8",
			);
			await chmod(join(dir, ".claude", "skills", "secret"), 0o000);
			try {
				const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

				expect(surfaces).toEqual([]);
				expect(skipped).toContainEqual({
					root: ".claude/skills",
					reason: "no-match",
				});
			} finally {
				// Restore before withTempDir's own cleanup tries to rm the directory.
				await chmod(join(dir, ".claude", "skills", "secret"), 0o755);
			}
		});
	},
);

test(".cursor/rules/x.mdc is detected as rules/cursor", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
		await writeFile(join(dir, ".cursor", "rules", "x.mdc"), "x", "utf8");

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".cursor/rules");
		expect(surfaces[0]?.kind).toBe("rules");
		expect(surfaces[0]?.dialects).toEqual(["cursor"]);
	});
});

test(".github/instructions/x.instructions.md is detected as instructions/copilot", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".github", "instructions"), { recursive: true });
		await writeFile(
			join(dir, ".github", "instructions", "x.instructions.md"),
			"x",
			"utf8",
		);

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".github/instructions");
		expect(surfaces[0]?.kind).toBe("instructions");
		expect(surfaces[0]?.dialects).toEqual(["copilot"]);
	});
});

test("nothing anywhere detects zero surfaces and skips nothing (every candidate directory is simply absent)", async () => {
	await withTempDir(async (dir) => {
		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);
		expect(surfaces).toEqual([]);
		// A candidate whose directory does not exist at all is not reportable — nothing sits
		// there to describe — so it must NOT appear in `skipped` either.
		expect(skipped).toEqual([]);
	});
});

/**
 * `ignore` is a parameter, not a hardcoded constant — this pins the contract that
 * `detectSurfaces` actually globs with whatever the caller passes, rather than a value baked
 * into this module. A candidate directory containing only files under an ignored pattern must
 * not be detected, exactly as an empty directory would not be.
 */
test("a candidate directory whose only matching file sits under the given ignore pattern is not detected", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "node_modules", "pkg"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "node_modules", "pkg", "SKILL.md"),
			"x",
			"utf8",
		);

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toEqual([]);
		expect(skipped).toContainEqual({
			root: ".claude/skills",
			reason: "no-match",
		});
	});
});

// ---------------------------------------------------------------------------
// Dedupe by realpath
// ---------------------------------------------------------------------------

/**
 * On a symlinked hub, `.claude/skills` and `.agents/skills` resolve to the same
 * real directory. Both are `kind: "skills"`, so they merge into ONE surface — the earlier
 * table entry's `root` wins, and the later entry's dialects are appended. Neither candidate is
 * a miss, so neither appears in `skipped`.
 */
test("a symlinked hub of the same kind merges into one surface, dialects in table order", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"x",
			"utf8",
		);
		await mkdir(join(dir, ".agents"), { recursive: true });
		await symlink(
			join(dir, ".claude", "skills"),
			join(dir, ".agents", "skills"),
			"dir",
		);

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".claude/skills");
		expect(surfaces[0]?.kind).toBe("skills");
		expect(surfaces[0]?.dialects).toEqual(["claude-code", "generic"]);
		expect(surfaces[0]?.spokes).toEqual([{ path: ".agents/skills" }]);
		expect(skipped).toEqual([]);
	});
});

/**
 * A real directory holding both a `SKILL.md` and a `.mdc` file, reached through two candidates
 * of different kinds (`.claude/skills`, dialect `claude-code`, and `.cursor/rules`, dialect
 * `cursor`), cannot become one surface: the two kinds have different file-shape contracts. The
 * earlier table entry wins outright; the later one is dropped, not merged.
 *
 * Deliberately uses two candidates whose dialects DIFFER (`claude-code` vs `cursor`): an
 * earlier version of this test paired `.cursor/skills`/`.cursor/rules`, which both carry the
 * *same* dialect id (`cursor`) — a broken "always merge, never check kind" implementation would
 * have produced an identical-looking result (the dialect was already in the set, so "merging"
 * it was a no-op) and passed for the wrong reason. With different dialects, an incorrect merge
 * is observable: `dialects` would gain `cursor` instead of staying `["claude-code"]`.
 */
test("a symlinked hub of different kinds keeps only the earlier candidate, not a merge", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "shared"), { recursive: true });
		await writeFile(join(dir, "shared", "SKILL.md"), "x", "utf8");
		await writeFile(join(dir, "shared", "x.mdc"), "x", "utf8");
		await mkdir(join(dir, ".claude"), { recursive: true });
		await mkdir(join(dir, ".cursor"), { recursive: true });
		await symlink(join(dir, "shared"), join(dir, ".claude", "skills"), "dir");
		await symlink(join(dir, "shared"), join(dir, ".cursor", "rules"), "dir");

		const { surfaces } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".claude/skills");
		expect(surfaces[0]?.kind).toBe("skills");
		expect(surfaces[0]?.dialects).toEqual(["claude-code"]);
		expect(surfaces[0]?.spokes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Root and spokes of a merged group
// ---------------------------------------------------------------------------

/** What these tests compare: each surface's root, then the paths of its spokes. */
async function rootsAndSpokes(
	dir: string,
): Promise<readonly [string, readonly string[]][]> {
	const { surfaces } = await detectSurfaces(dir, IGNORE);
	return surfaces.map((surface) => [
		surface.root,
		surface.spokes.map((spoke) => spoke.path),
	]);
}

test("a symlink earlier in the table is a spoke of the real directory that comes later", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".agents/skills/foo/SKILL.md");
		await link(dir, "../.agents/skills", ".claude/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]?.root).toBe(".agents/skills");
		expect(surfaces[0]?.spokes).toEqual([{ path: ".claude/skills" }]);
		expect(surfaces[0]?.dialects).toEqual(["claude-code", "generic"]);
		expect(skipped).toEqual([]);
	});
});

test("a symlink later in the table is a spoke of the real directory that comes first", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".claude/skills/foo/SKILL.md");
		await link(dir, "../.claude/skills", ".agents/skills");

		expect(await rootsAndSpokes(dir)).toEqual([
			[".claude/skills", [".agents/skills"]],
		]);
	});
});

test("every symlink reaching the real directory is a spoke of it, in table order", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".agents/skills/foo/SKILL.md");
		await link(dir, "../.agents/skills", ".cursor/skills");
		await link(dir, "../.agents/skills", ".claude/skills");

		expect(await rootsAndSpokes(dir)).toEqual([
			[".agents/skills", [".claude/skills", ".cursor/skills"]],
		]);
	});
});

test("when no candidate is the real directory, the first in the table is the root and the rest are spokes", async () => {
	await withTempDir(async (dir) => {
		await put(dir, "shared/skills/foo/SKILL.md");
		await link(dir, "../shared/skills", ".cursor/skills");
		await link(dir, "../shared/skills", ".agents/skills");
		await link(dir, "../shared/skills", ".claude/skills");

		expect(await rootsAndSpokes(dir)).toEqual([
			[".claude/skills", [".agents/skills", ".cursor/skills"]],
		]);
	});
});

test("a candidate under a symlinked ancestor is a spoke of the real directory", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".claude/skills/foo/SKILL.md");
		await link(dir, ".claude", ".cursor");

		expect(await rootsAndSpokes(dir)).toEqual([
			[".claude/skills", [".cursor/skills"]],
		]);
	});
});

test("a candidate under a symlinked ancestor does not become the root because it comes first in the table", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".agents/skills/foo/SKILL.md");
		await link(dir, ".agents", ".claude");

		expect(await rootsAndSpokes(dir)).toEqual([
			[".agents/skills", [".claude/skills"]],
		]);
	});
});

test("spokes are in table order, whatever order the links were made in", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".github/skills/foo/SKILL.md");
		for (const root of [".cursor", ".opencode", ".agents", ".claude"]) {
			await link(dir, "../.github/skills", `${root}/skills`);
		}

		const first = await detectSurfaces(dir, IGNORE);
		const second = await detectSurfaces(dir, IGNORE);

		expect(first.surfaces[0]?.spokes.map((spoke) => spoke.path)).toEqual([
			".claude/skills",
			".agents/skills",
			".opencode/skills",
			".cursor/skills",
		]);
		expect(second).toEqual(first);
	});
});

test("a candidate that is outside the repo, matches nothing or is of another kind is never a spoke", async () => {
	await withTempDir(async (dir) => {
		const repo = join(dir, "repo");
		await put(repo, ".claude/skills/foo/SKILL.md");
		await mkdir(join(repo, ".claude", "skills", "empty"), { recursive: true });
		await link(repo, dir, ".agents/skills");
		await link(repo, "../.claude/skills/empty", ".cursor/skills");
		await put(repo, "shared/SKILL.md");
		await put(repo, "shared/style.mdc");
		await link(repo, "../shared", ".opencode/skills");
		await link(repo, "../shared", ".cursor/rules");

		const { surfaces, skipped } = await detectSurfaces(repo, IGNORE);

		expect(surfaces.map((s) => [s.root, s.spokes])).toEqual([
			[".claude/skills", []],
			[".opencode/skills", []],
		]);
		expect(skipped).toEqual([
			{ root: ".agents/skills", reason: "outside-repo" },
			{ root: ".cursor/skills", reason: "no-match" },
		]);
	});
});

test("a detected surface's spokes are frozen and carry no loc key, before and after loadConfig", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".agents/skills/foo/SKILL.md");
		await link(dir, "../.agents/skills", ".claude/skills");

		const { surfaces } = await detectSurfaces(dir, IGNORE);
		const config = await loadConfig(dir, builtinRules);

		for (const spokes of [surfaces[0]?.spokes, config.surfaces[0]?.spokes]) {
			expect(spokes).toHaveLength(1);
			expect(Object.isFrozen(spokes)).toBe(true);
			for (const spoke of spokes ?? []) {
				expect(Object.isFrozen(spoke)).toBe(true);
				expect("loc" in spoke).toBe(false);
			}
		}
	});
});

/** Skills candidates linked to one hub in every combination, plus layouts with a link above a candidate. */
function skillLayouts(): readonly {
	readonly name: string;
	readonly real: readonly string[];
	readonly links: Readonly<Record<string, string>>;
}[] {
	const skillRoots = CANDIDATE_TABLE.filter((row) => row.kind === "skills").map(
		(row) => row.root,
	);
	const layouts: {
		name: string;
		real: string[];
		links: Record<string, string>;
	}[] = [];
	for (const hub of [...skillRoots, "shared/skills"]) {
		const others = skillRoots.filter((root) => root !== hub);
		const firstMask = skillRoots.includes(hub) ? 0 : 1;
		for (let mask = firstMask; mask < 1 << others.length; mask++) {
			const linked = others.filter((_, bit) => (mask >> bit) & 1);
			layouts.push({
				name: `hub ${hub}, linked from [${linked.join(", ")}]`,
				real: [hub],
				links: Object.fromEntries(
					linked.map((root) => [
						root,
						posix.relative(posix.dirname(root), hub),
					]),
				),
			});
		}
	}
	layouts.push(
		{
			name: "two real directories and a link to one of them",
			real: [".claude/skills", ".agents/skills"],
			links: { ".cursor/skills": "../.agents/skills" },
		},
		{
			name: "a link above one candidate",
			real: [".claude/skills"],
			links: { ".cursor": ".claude" },
		},
		{
			name: "a link above a later candidate, the real directory being a later row",
			real: [".agents/skills"],
			links: { ".claude": ".agents" },
		},
		{
			name: "two links above one candidate",
			real: [".claude/skills"],
			links: { ".cursor": ".claude", ".github": ".claude" },
		},
		{
			name: "a rules row beside a linked skills hub",
			real: [".claude/skills", ".cursor/rules"],
			links: { ".agents/skills": "../.claude/skills" },
		},
		{
			name: "a link above the hub, and a rules row linked to a directory nested inside the hub",
			real: [".claude/skills", ".claude/skills/foo/rules"],
			links: {
				".agents": ".claude",
				".cursor/rules": "../.claude/skills/foo/rules",
			},
		},
	);
	return layouts;
}

test("every layout detection can meet resolves into surfaces discovery accepts, with every present candidate accounted for", async () => {
	for (const layout of skillLayouts()) {
		await withTempDir(async (dir) => {
			for (const real of layout.real) {
				await put(
					dir,
					real.endsWith("/rules")
						? `${real}/style.mdc`
						: `${real}/foo/SKILL.md`,
				);
			}
			for (const [at, target] of Object.entries(layout.links)) {
				await link(dir, target, at);
			}

			const config = await loadConfig(dir, builtinRules);
			let discovered: Awaited<ReturnType<typeof discoverFiles>> | undefined;
			try {
				discovered = await discoverFiles(config);
			} catch (err) {
				throw new Error(`${layout.name}: ${String(err)}`);
			}
			expect(discovered.length).toBeGreaterThan(0);

			const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);
			const accounted = [
				...surfaces.flatMap((s) => [s.root, ...s.spokes.map((p) => p.path)]),
				...skipped.map((s) => s.root),
			].sort();
			const present: string[] = [];
			for (const root of CANDIDATE_ROOTS) {
				if (await stat(join(dir, root)).catch(() => undefined)) {
					present.push(root);
				}
			}
			expect({ layout: layout.name, accounted }).toEqual({
				layout: layout.name,
				accounted: present.sort(),
			});
			for (const surface of surfaces) {
				expect(surface.spokes.map((s) => s.path)).not.toContain(surface.root);
			}
		});
	}
}, 60_000);

test("a rules link into a hub that is also reached through a symlinked ancestor lints without a config error", async () => {
	await withTempDir(async (dir) => {
		await put(
			dir,
			".claude/skills/foo/SKILL.md",
			"---\nname: foo\ndescription: Foo\n---\n\nSee rules/x.mdc.\n",
		);
		await put(
			dir,
			".claude/skills/foo/rules/x.mdc",
			"---\ndescription: X\n---\n\nBody.\n",
		);
		await link(dir, ".claude", ".agents");
		await link(dir, "../.claude/skills/foo/rules", ".cursor/rules");
		await gitInitAndCommit(dir);

		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.stdout).not.toContain("config/invalid");
		expect(result.exitCode).toBe(EXIT_CLEAN);
	});
});

test("the zero-config fixtures resolve into surfaces with no spokes", async () => {
	for (const name of ["zero-config-claude", "zero-config-agents"]) {
		const fixture = fileURLToPath(
			new URL(`../test/fixtures/${name}`, import.meta.url),
		);
		const config = await loadConfig(fixture, builtinRules);
		expect(config.surfaces.map((surface) => surface.spokes)).toEqual([[]]);
		await discoverFiles(config);
	}
});

// ---------------------------------------------------------------------------
// Overlap by shared files
// ---------------------------------------------------------------------------

/**
 * `.agents/skills` symlinked to `.claude`, the PARENT of `.claude/skills`: the two real
 * directories differ, so the dedupe above cannot see them, but both match the one file
 * `.claude/skills/foo/SKILL.md`. The deeper real directory is kept; the other is recorded.
 */
test("a candidate symlinked to the parent of another is dropped as overlapping it, and recorded", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".claude/skills/foo/SKILL.md");
		await link(dir, "../.claude", ".agents/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".claude/skills"]);
		expect(surfaces[0]?.dialects).toEqual(["claude-code"]);
		expect(skipped).toEqual([
			{
				root: ".agents/skills",
				reason: "overlaps",
				keptRoot: ".claude/skills",
			},
		]);
	});
});

test("the deeper real directory is kept even when it is the later table entry", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".agents/skills/foo/SKILL.md");
		await link(dir, "../.agents", ".claude/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".agents/skills"]);
		expect(surfaces[0]?.dialects).toEqual(["generic"]);
		expect(skipped).toEqual([
			{
				root: ".claude/skills",
				reason: "overlaps",
				keptRoot: ".agents/skills",
			},
		]);
	});
});

test("nested real directories whose matched files are disjoint stay separate surfaces", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".claude/skills/foo/SKILL.md");
		await put(dir, ".claude/rules/style.mdc");
		await link(dir, "../.claude", ".cursor/rules");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => `${s.root} ${s.kind}`)).toEqual([
			".claude/skills skills",
			".cursor/rules rules",
		]);
		expect(skipped).toEqual([]);
	});
});

/**
 * The equal-real-directory rule still decides first: `.claude/skills` and `.cursor/rules` are
 * one directory here, so the later kind loses the dedupe and is not a miss to report. Their
 * matched files are disjoint (`SKILL.md` vs `.mdc`), so only the dedupe can be what drops it.
 */
test("different kinds reaching one real directory keep the earlier and do not record the later", async () => {
	await withTempDir(async (dir) => {
		await put(dir, "shared/SKILL.md");
		await put(dir, "shared/style.mdc");
		await link(dir, "../shared", ".claude/skills");
		await link(dir, "../shared", ".cursor/rules");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".claude/skills"]);
		expect(surfaces[0]?.spokes).toEqual([]);
		expect(skipped).toEqual([]);
	});
});

test("an outside-repo or no-match candidate is never reported as overlapping, whatever it would have shared", async () => {
	await withTempDir(async (dir) => {
		const repo = join(dir, "repo");
		await put(repo, ".claude/skills/foo/SKILL.md");
		await mkdir(join(repo, ".claude", "skills", "empty"), { recursive: true });
		await link(repo, dir, ".agents/skills");
		await link(repo, "../.claude/skills/empty", ".cursor/skills");

		const { surfaces, skipped } = await detectSurfaces(repo, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".claude/skills"]);
		expect(skipped).toEqual([
			{ root: ".agents/skills", reason: "outside-repo" },
			{ root: ".cursor/skills", reason: "no-match" },
		]);
	});
});

/**
 * Pushed in the order the overlap pass visits them (the deepest first), the two dropped
 * candidates would come out `.agents/skills`, `.claude/skills`; `skipped` is table order.
 */
test("skipped entries come out in table order, whichever order the overlaps were decided in", async () => {
	await withTempDir(async (dir) => {
		await put(dir, "pkg/a/skills/foo/SKILL.md");
		await link(dir, "../pkg", ".claude/skills");
		await link(dir, "../pkg/a", ".agents/skills");
		await link(dir, "../pkg/a/skills", ".opencode/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".opencode/skills"]);
		expect(skipped).toEqual([
			{
				root: ".claude/skills",
				reason: "overlaps",
				keptRoot: ".opencode/skills",
			},
			{
				root: ".agents/skills",
				reason: "overlaps",
				keptRoot: ".opencode/skills",
			},
		]);
	});
});

test("a candidate overlapping two equally deep survivors names the earlier table row", async () => {
	await withTempDir(async (dir) => {
		await put(dir, "pkg/a/s1/foo/SKILL.md");
		await put(dir, "pkg/b/s2/bar/SKILL.md");
		await link(dir, "../pkg", ".claude/skills");
		await link(dir, "../pkg/a/s1", ".agents/skills");
		await link(dir, "../pkg/b/s2", ".github/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([
			".agents/skills",
			".github/skills",
		]);
		expect(skipped).toEqual([
			{
				root: ".claude/skills",
				reason: "overlaps",
				keptRoot: ".agents/skills",
			},
		]);
	});
});

/**
 * `.agents/skills` and `.opencode/skills` are one directory, so they merge into a single
 * candidate before the overlap is judged; when that candidate loses, both names were linted
 * under no surface and both are recorded.
 */
test("candidates merged into one that then loses an overlap are each recorded", async () => {
	await withTempDir(async (dir) => {
		await put(dir, ".claude/skills/foo/SKILL.md");
		await link(dir, "../.claude", ".agents/skills");
		await link(dir, "../.claude", ".opencode/skills");

		const { surfaces, skipped } = await detectSurfaces(dir, IGNORE);

		expect(surfaces.map((s) => s.root)).toEqual([".claude/skills"]);
		expect(skipped).toEqual([
			{
				root: ".agents/skills",
				reason: "overlaps",
				keptRoot: ".claude/skills",
			},
			{
				root: ".opencode/skills",
				reason: "overlaps",
				keptRoot: ".claude/skills",
			},
		]);
	});
});

/**
 * A `.claude/skills` symlinked to a directory outside the repo must not be handed to discovery
 * (which would report "surface root escapes the repository root" as an exit-2 `ConfigError` on
 * a run the user never configured). It is skipped, and recorded in `skipped` as `"outside-
 * repo"` — this used to be silently invisible to the user.
 */
test("a candidate symlinked outside the repo is skipped, and recorded as skipped/outside-repo", async () => {
	await withTempDir(async (dir) => {
		const repoRoot = join(dir, "repo");
		const outsideTarget = join(dir, "outside");
		await mkdir(repoRoot, { recursive: true });
		await mkdir(outsideTarget, { recursive: true });
		await writeFile(join(outsideTarget, "SKILL.md"), "x", "utf8");
		await mkdir(join(repoRoot, ".claude"), { recursive: true });
		await symlink(outsideTarget, join(repoRoot, ".claude", "skills"), "dir");

		const { surfaces, skipped } = await detectSurfaces(repoRoot, IGNORE);

		expect(surfaces).toEqual([]);
		expect(skipped).toContainEqual({
			root: ".claude/skills",
			reason: "outside-repo",
		});
	});
});

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

/**
 * `detectSurfaces` still hands back shared data, so the usual freezing discipline applies —
 * `Readonly<T>` is a type, not a lock. The `ResolvedSurface`-specific freezing (`include`,
 * `ignore`, `rules`, `loc`) moved to config.test.ts along with the fields themselves: those are
 * `loadConfig`'s responsibility now, not detection's.
 */
test("detectSurfaces freezes the returned result, its surfaces array, and everything reachable from it", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".claude", "skills", "a"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "skills", "a", "SKILL.md"),
			"x",
			"utf8",
		);
		await mkdir(join(dir, ".cursor", "skills"), { recursive: true });

		const result = await detectSurfaces(dir, IGNORE);
		const surface = result.surfaces[0];
		if (!surface) throw new Error("expected one surface");

		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.surfaces)).toBe(true);
		expect(Object.isFrozen(surface)).toBe(true);
		expect(Object.isFrozen(surface.dialects)).toBe(true);
		expect(Object.isFrozen(result.skipped)).toBe(true);
		const skippedEntry = result.skipped[0];
		if (!skippedEntry) throw new Error("expected one skipped candidate");
		expect(Object.isFrozen(skippedEntry)).toBe(true);
		expect(() => {
			(surface as { root: string }).root = "/etc";
		}).toThrow(TypeError);
	});
});

test("every skipped entry is frozen, and only an overlaps entry carries a kept root", async () => {
	await withTempDir(async (dir) => {
		const repo = join(dir, "repo");
		await put(repo, ".claude/skills/foo/SKILL.md");
		await link(repo, "../.claude", ".agents/skills");
		await mkdir(join(repo, ".opencode", "skills"), { recursive: true });
		await link(repo, dir, ".cursor/skills");

		const { skipped } = await detectSurfaces(repo, IGNORE);

		expect(skipped.map((s) => s.reason)).toEqual([
			"overlaps",
			"no-match",
			"outside-repo",
		]);
		for (const entry of skipped) {
			expect(Object.isFrozen(entry)).toBe(true);
			expect("keptRoot" in entry).toBe(entry.reason === "overlaps");
		}
		const overlap = skipped[0];
		if (overlap?.reason !== "overlaps") throw new Error("expected overlaps");
		expect(overlap.keptRoot).toBe(".claude/skills");
	});
});
