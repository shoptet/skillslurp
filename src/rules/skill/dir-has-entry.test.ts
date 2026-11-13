import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	freezeSurface,
	loadConfig,
	type ResolvedSpoke,
	type ResolvedSurface,
	sealMap,
} from "../../config.js";
import { createCapabilities, type RuleContext } from "../../context.js";
import { DEFAULT_INCLUDE } from "../../dialects.js";
import { discoverFiles } from "../../discover.js";
import { parseSource } from "../../document.js";
import { runEngine } from "../../engine.js";
import { EXIT_CLEAN } from "../../exit.js";
import { runGit } from "../../git.js";
import { runCli } from "../../run.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { dirHasEntry } from "./dir-has-entry.js";

// git lists NFC on macOS (core.precomposeunicode) but the raw NFD bytes on Linux; the message keeps git's spelling, `file` is always NFC.
const GIT_LISTED_CAFE = process.platform === "darwin" ? "café" : "café";

const NO_ENTRY = (
	dir: string,
	root = "skills",
	include = "**/SKILL.md",
): string =>
	`Directory "${dir}" under skills root "${root}" has no entry document (${include})`;

runRuleTests(dirHasEntry, {
	valid: [
		{
			name: "a directory with its entry document and supporting files is clean, and a directory inside the item is never reported",
			surface: { root: "skills" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/foo/references/ref.md": "# Ref\n",
				"skills/foo/scripts/run.sh": "echo\n",
			},
		},
		{
			name: "a surface root with its own SKILL.md is the item: a directory inside it is never judged",
			surface: { root: "skills/foo" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/foo/references/guide.md": "# Guide\n",
			},
		},
		{
			name: "a surface root with its own SKILL.md stays the item when that entry is tracked but missing from the working tree",
			surface: { root: "skills/foo" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/foo/group/a/SKILL.md": "# A\n",
				"skills/foo/references/guide.md": "# Guide\n",
			},
			worktree: { remove: ["skills/foo/SKILL.md"] },
		},
		{
			name: "a surface root with its own SKILL.md stays the item when that entry is on disk but not tracked yet",
			surface: { root: "skills/foo" },
			files: {
				"skills/foo/group/a/SKILL.md": "# A\n",
				"skills/foo/references/guide.md": "# Guide\n",
			},
			worktree: { files: { "skills/foo/SKILL.md": "# Foo\n" } },
		},
		{
			name: "a symlinked surface root whose real directory holds a SKILL.md is the item too",
			surface: { root: ".agents/skills" },
			files: {
				".claude/skills/foo/SKILL.md": "# Foo\n",
				".claude/skills/foo/references/x.md": "# X\n",
			},
			symlinks: { ".agents/skills": "../.claude/skills/foo" },
		},
		{
			name: "a directory holding only untracked or gitignored files is not reported",
			surface: { root: "skills" },
			files: {
				".gitignore": "skills/scratch/\n",
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/scratch/notes.md": "# Scratch\n",
			},
			worktree: { files: { "skills/fresh/notes.md": "# Not committed\n" } },
		},
		{
			name: "a directory whose tracked files are all matched by the top-level ignore is not reported",
			surface: { root: "skills" },
			ignore: ["skills/vendored/**"],
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/vendored/notes.md": "# Vendored\n",
				"skills/vendored/deep/more.md": "# More\n",
			},
		},
		{
			name: "a directory matched by the surface ignore as `wip` is not reported",
			surface: { root: "skills", ignore: ["wip"] },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/wip/notes.md": "# Notes\n",
			},
		},
		{
			name: "a directory matched by the surface ignore as `wip/` is not reported",
			surface: { root: "skills", ignore: ["wip/"] },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/wip/notes.md": "# Notes\n",
			},
		},
		{
			name: "a directory matched by the surface ignore as `wip/**` is not reported",
			surface: { root: "skills", ignore: ["wip/**"] },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/wip/notes.md": "# Notes\n",
			},
		},
		{
			name: "a grouping directory over a skill is not reported even when it also holds a file of its own",
			surface: { root: "skills" },
			files: {
				"skills/group/a/SKILL.md": "# A\n",
				"skills/group/notes.md": "# Notes\n",
			},
		},
		{
			name: "a file directly at the surface root is not in any directory and is not reported",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/README.md": "# Skills\n",
			},
		},
		{
			name: "a tracked symlink directly under the root is a file in git's listing and is not reported",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"shared/notes.md": "# Shared\n",
			},
			symlinks: { "skills/linked": "../shared" },
		},
		{
			name: "a rules surface is not judged: an entry there is a file, not a directory",
			surface: { root: ".cursor/rules", kind: "rules", dialects: ["cursor"] },
			files: {
				".cursor/rules/a.mdc": "# A\n",
				".cursor/rules/sub/notes.md": "# Notes\n",
			},
		},
		{
			name: "an instructions surface is not judged",
			surface: {
				root: ".github/instructions",
				kind: "instructions",
				dialects: ["copilot"],
			},
			files: {
				".github/instructions/a.instructions.md": "# A\n",
				".github/instructions/sub/notes.md": "# Notes\n",
			},
		},
		{
			name: "commands folded into a skills surface with include **/*.md: flat files at the root and files in subdirectories are clean",
			surface: { root: "commands", include: ["**/*.md"] },
			files: {
				"commands/README.md": "# Commands\n",
				"commands/deploy.md": "# Deploy\n",
				"commands/ops/restart.md": "# Restart\n",
				"commands/ops/helper.sh": "echo\n",
			},
		},
		{
			name: "a SKILL.md tracked in git but deleted from the working tree is not reported as missing",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/foo/notes.md": "# Notes\n",
			},
			worktree: { remove: ["skills/foo/SKILL.md"] },
		},
		{
			name: "a discovered document that git does not track yet still makes its directory a skill",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/fresh/notes.md": "# Notes\n",
			},
			worktree: { files: { "skills/fresh/SKILL.md": "# Fresh\n" } },
		},
		{
			name: "an item whose SKILL.md is tracked but deleted from the working tree still owns its subdirectories",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/foo/references/ref.md": "# Ref\n",
			},
			worktree: { remove: ["skills/foo/SKILL.md"] },
		},
		{
			name: "tracked files outside the surface root are not judged, even in a directory that shares its prefix",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills-extra/foo/notes.md": "# Notes\n",
				"other/foo/notes.md": "# Notes\n",
			},
		},
		{
			name: "an NFD-decomposed directory holding its entry document is clean",
			surface: { root: "skills" },
			files: {
				[`skills/${"café"}/SKILL.md`]: "# Cafe\n",
				[`skills/${"café"}/notes.md`]: "# Notes\n",
			},
		},
	],
	invalid: [
		{
			name: "a directory with only notes.md is reported",
			surface: { root: "skills" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/bar/notes.md": "# Notes\n",
			},
			errors: [{ message: NO_ENTRY("skills/bar"), file: "skills/bar" }],
		},
		{
			name: "a SKILL.md renamed to README.md is reported",
			surface: { root: "skills" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/baz/README.md": "# Baz\n",
			},
			errors: [{ message: NO_ENTRY("skills/baz"), file: "skills/baz" }],
		},
		{
			name: "a lowercase skill.md is not an entry document: discovery matches the name case-sensitively, so it is reported on every platform",
			surface: { root: "skills" },
			files: {
				"skills/foo/SKILL.md": "# Foo\n",
				"skills/low/skill.md": "# Low\n",
			},
			errors: [{ message: NO_ENTRY("skills/low"), file: "skills/low" }],
		},
		{
			name: "a grouping directory is looked through: its entry-less child is reported once, at its top-most directory, and the group is not",
			surface: { root: "skills" },
			files: {
				"skills/group/a/SKILL.md": "# A\n",
				"skills/group/b/notes.md": "# Notes\n",
				"skills/group/b/deep/more.md": "# More\n",
			},
			errors: [
				{
					message: NO_ENTRY("skills/group/b"),
					file: "skills/group/b",
				},
			],
		},
		{
			name: "a grouping whose only entry is tracked but missing from the working tree is looked through, so its entry-less child is still reported",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				"skills/group/x/SKILL.md": "# X\n",
				"skills/group/y/notes.md": "# Notes\n",
			},
			worktree: { remove: ["skills/group/x/SKILL.md"] },
			errors: [
				{
					message: NO_ENTRY("skills/group/y"),
					file: "skills/group/y",
				},
			],
		},
		{
			name: "a SKILL.md deeper than the root does not make the root an item",
			surface: { root: "skills/foo" },
			files: {
				"skills/foo/group/a/SKILL.md": "# A\n",
				"skills/foo/references/guide.md": "# Guide\n",
			},
			errors: [
				{
					message: NO_ENTRY("skills/foo/references", "skills/foo"),
					file: "skills/foo/references",
				},
			],
		},
		{
			name: "a symlinked surface root is judged under its real root, and the diagnostic names the real path",
			surface: { root: ".agents/skills" },
			files: {
				".claude/skills/foo/SKILL.md": "# Foo\n",
				".claude/skills/bar/notes.md": "# Notes\n",
			},
			symlinks: { ".agents/skills": "../.claude/skills" },
			errors: [
				{
					message: NO_ENTRY(".claude/skills/bar", ".claude/skills"),
					file: ".claude/skills/bar",
				},
			],
		},
		{
			name: "a surface rooted at the repository root judges every top-level directory",
			surface: { root: "." },
			files: {
				"foo/SKILL.md": "# Foo\n",
				"README.md": "# Repo\n",
				"docs/guide.md": "# Guide\n",
			},
			errors: [{ message: NO_ENTRY("docs", "."), file: "docs" }],
		},
		{
			name: "an NFD-decomposed directory without an entry document is reported once, spelled as git lists it",
			surface: { root: "skills" },
			files: {
				"skills/ok/SKILL.md": "# Ok\n",
				[`skills/${"café"}/notes.md`]: "# Notes\n",
			},
			errors: [
				{
					message: NO_ENTRY(`skills/${GIT_LISTED_CAFE}`),
					file: `skills/${"café"}`,
				},
			],
		},
		{
			name: "with a custom include, the message names every pattern and a directory with no match is reported",
			surface: { root: "commands", include: ["**/*.md", "**/*.txt"] },
			files: {
				"commands/deploy.md": "# Deploy\n",
				"commands/tools/run.sh": "echo\n",
			},
			errors: [
				{
					message: NO_ENTRY("commands/tools", "commands", "**/*.md, **/*.txt"),
					file: "commands/tools",
				},
			],
		},
	],
});

interface Repo {
	readonly files: Readonly<Record<string, string>>;
	readonly config: unknown;
}

async function withRepo<T>(
	repo: Repo,
	body: (root: string) => Promise<T>,
): Promise<T> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-direntry-")),
	);
	try {
		const files = {
			...repo.files,
			"skillslurp.json": JSON.stringify(repo.config),
		};
		for (const [path, source] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source, "utf8");
		}
		await gitInitAndCommit(root);
		return await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const GIT_ENV = Object.freeze({
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
});

async function commitAll(root: string): Promise<void> {
	await runGit(root, ["add", "-A"], GIT_ENV);
	await runGit(
		root,
		[
			"-c",
			"core.hooksPath=",
			"commit",
			"--quiet",
			"--no-verify",
			"-m",
			"second",
		],
		GIT_ENV,
	);
}

async function reported(
	root: string,
	diffBase?: string,
): Promise<readonly (readonly [string, string])[]> {
	const config = await loadConfig(root, [dirHasEntry]);
	const { diagnostics } = await runEngine(
		config,
		[dirHasEntry],
		diffBase === undefined ? undefined : { diffBase },
	);
	return diagnostics.map((d) => [d.file, d.message] as const);
}

describe("skill/dir-has-entry in a zero-config run", () => {
	test("a detected root that links to one skill directory is that skill: its references/ is not reported", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-direntry-zero-")),
		);
		try {
			const files: Readonly<Record<string, string>> = {
				".claude/skills/foo/SKILL.md":
					"---\nname: foo\ndescription: Foo\n---\n\nSee references/x.md.\n",
				".claude/skills/foo/references/x.md": "# X\n",
			};
			for (const [path, source] of Object.entries(files)) {
				await mkdir(dirname(join(root, path)), { recursive: true });
				await writeFile(join(root, path), source, "utf8");
			}
			await mkdir(join(root, ".agents"));
			await symlink("../.claude/skills/foo", join(root, ".agents/skills"));
			await gitInitAndCommit(root);

			const result = await runCli({
				path: root,
				reporter: "stylish",
				color: false,
			});
			expect(result.stdout).not.toContain("skill/dir-has-entry");
			expect(result.exitCode).toBe(EXIT_CLEAN);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("skill/dir-has-entry through the engine", () => {
	test("an empty directory is not reported: git tracks no directory, so a fresh checkout does not contain it", async () => {
		await withRepo(
			{
				files: {
					"skills/ok/SKILL.md": "# Ok\n",
					"skills/bar/notes.md": "# N\n",
				},
				config: { version: 1, surfaces: [{ root: "skills" }] },
			},
			async (root) => {
				await mkdir(join(root, "skills", "empty", "nested"), {
					recursive: true,
				});
				expect(await reported(root)).toEqual([
					["skills/bar", NO_ENTRY("skills/bar")],
				]);
			},
		);
	});

	test("discovery reads the entry name case-sensitively, which is what makes a lowercase skill.md entry-less", async () => {
		await withRepo(
			{
				files: {
					"skills/foo/SKILL.md": "# Foo\n",
					"skills/low/skill.md": "# Low\n",
				},
				config: { version: 1, surfaces: [{ root: "skills" }] },
			},
			async (root) => {
				const config = await loadConfig(root, [dirHasEntry]);
				expect((await discoverFiles(config)).map((f) => f.path)).toEqual([
					"skills/foo/SKILL.md",
				]);
			},
		);
	});

	test("a rules surface rooted inside a skills root is left alone, and an unrelated sibling is still reported", async () => {
		await withRepo(
			{
				files: {
					".agents/ok/SKILL.md": "# Ok\n",
					".agents/rules/a.mdc": "# A\n",
					".agents/rules/sub/b.mdc": "# B\n",
					".agents/misc/notes.md": "# Notes\n",
				},
				config: {
					version: 1,
					surfaces: [
						{ root: ".agents", kind: "skills" },
						{ root: ".agents/rules", kind: "rules", dialects: ["cursor"] },
					],
				},
			},
			async (root) => {
				expect(await reported(root)).toEqual([
					[".agents/misc", NO_ENTRY(".agents/misc", ".agents")],
				]);
			},
		);
	});

	test("a project rule runs in full under --diff-base: an unchanged entry-less directory is still reported", async () => {
		await withRepo(
			{
				files: {
					"skills/ok/SKILL.md": "# Ok\n",
					"skills/bar/notes.md": "# Notes\n",
				},
				config: { version: 1, surfaces: [{ root: "skills" }] },
			},
			async (root) => {
				const base = (await runGit(root, ["rev-parse", "HEAD"], GIT_ENV))
					.toString("utf8")
					.trim();
				await writeFile(join(root, "skills/ok/SKILL.md"), "# Ok, edited\n");
				await commitAll(root);

				const expected: (readonly [string, string])[] = [
					["skills/bar", NO_ENTRY("skills/bar")],
				];
				expect(await reported(root)).toEqual(expected);
				expect(await reported(root, base)).toEqual(expected);
			},
		);
	});
});

function skills(
	root: string,
	spokes: readonly ResolvedSpoke[] = [],
): ResolvedSurface {
	return freezeSurface({
		root,
		kind: "skills",
		dialects: ["generic"],
		include: DEFAULT_INCLUDE.skills,
		ignore: [],
		spokes,
		rules: sealMap(new Map()),
	});
}

interface Listing {
	readonly files: Readonly<Record<string, string>>;
	readonly listing: readonly string[];
	readonly surface: ResolvedSurface;
	readonly documents: readonly {
		readonly path: string;
		readonly surface: ResolvedSurface;
	}[];
}

async function checkAgainst(layout: Listing) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-direntry-listing-")),
	);
	try {
		for (const [path, source] of Object.entries(layout.files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source, "utf8");
		}
		const documents = layout.documents.map((entry) =>
			parseSource(
				entry.path,
				join(root, entry.path),
				layout.files[entry.path] ?? "",
				entry.surface,
			),
		);
		const caps = createCapabilities(root, async () => documents);
		const ctx: RuleContext = {
			...caps,
			git: { ...caps.git, trackedFiles: async () => layout.listing },
			options: {},
			surface: layout.surface,
		};
		return await dirHasEntry.check(ctx);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("skill/dir-has-entry against a hand-written git listing", () => {
	test("reports come out in ascending path order whatever order git listed them in, one per top-most directory", async () => {
		const surface = skills("skills");
		const reports = await checkAgainst({
			files: { "skills/ok/SKILL.md": "# Ok\n" },
			listing: [
				"skills/zeta/notes.md",
				"skills/mid/sub/x.md",
				"skills/mid/y.md",
				"skills/ok/SKILL.md",
				"skills/alpha/notes.md",
			],
			surface,
			documents: [{ path: "skills/ok/SKILL.md", surface }],
		});

		expect(reports.map((r) => r.file)).toEqual([
			"skills/alpha",
			"skills/mid",
			"skills/zeta",
		]);
	});

	test("a directory is matched to its documents by pathKey, whichever Unicode form git or the disk used", async () => {
		const surface = skills("skills");
		const nfd = "cafe\u0301";
		const nfc = "caf\u00e9";
		for (const [listed, discovered] of [
			[nfc, nfd],
			[nfd, nfc],
		]) {
			const reports = await checkAgainst({
				files: {
					[`skills/${discovered}/SKILL.md`]: "# Cafe\n",
					"skills/zzz/notes.md": "# Notes\n",
				},
				listing: [`skills/${listed}/notes.md`, "skills/zzz/notes.md"],
				surface,
				documents: [{ path: `skills/${discovered}/SKILL.md`, surface }],
			});

			expect(reports.map((r) => r.file)).toEqual(["skills/zzz"]);
		}
	});

	test("a reported directory keeps the spelling of the listing, NFC or NFD", async () => {
		const surface = skills("skills");
		for (const spelling of ["café", "café"]) {
			const reports = await checkAgainst({
				files: { "skills/ok/SKILL.md": "# Ok\n" },
				listing: ["skills/ok/SKILL.md", `skills/${spelling}/notes.md`],
				surface,
				documents: [{ path: "skills/ok/SKILL.md", surface }],
			});

			expect(reports).toEqual([
				{
					message: NO_ENTRY(`skills/${spelling}`),
					file: `skills/${spelling}`,
				},
			]);
		}
	});

	test("a directory that is a spoke of another surface is not reported, and neither is anything inside it", async () => {
		const mine = skills("area");
		const other = skills("hub", [{ path: "area/mirror" }]);
		const reports = await checkAgainst({
			files: {
				"area/ok/SKILL.md": "# Ok\n",
				"area/mirror/x.md": "# X\n",
				"area/mirror/deep/y.md": "# Y\n",
				"area/loose/z.md": "# Z\n",
				"hub/a/SKILL.md": "# A\n",
			},
			listing: [
				"area/ok/SKILL.md",
				"area/mirror/x.md",
				"area/mirror/deep/y.md",
				"area/loose/z.md",
				"hub/a/SKILL.md",
			],
			surface: mine,
			documents: [
				{ path: "area/ok/SKILL.md", surface: mine },
				{ path: "hub/a/SKILL.md", surface: other },
			],
		});

		expect(reports.map((r) => r.file)).toEqual(["area/loose"]);
	});

	test("a directory holding another surface's spoke is looked through, not reported", async () => {
		const mine = skills("area");
		const other = skills("hub", [{ path: "area/tools/mirror" }]);
		const reports = await checkAgainst({
			files: {
				"area/ok/SKILL.md": "# Ok\n",
				"area/tools/mirror/x.md": "# X\n",
				"area/tools/loose/z.md": "# Z\n",
				"hub/a/SKILL.md": "# A\n",
			},
			listing: [
				"area/ok/SKILL.md",
				"area/tools/mirror/x.md",
				"area/tools/loose/z.md",
				"hub/a/SKILL.md",
			],
			surface: mine,
			documents: [
				{ path: "area/ok/SKILL.md", surface: mine },
				{ path: "hub/a/SKILL.md", surface: other },
			],
		});

		expect(reports.map((r) => r.file)).toEqual(["area/tools/loose"]);
	});
});

describe("skill/dir-has-entry meta", () => {
	test("is a project rule, an error in both tiers, and takes no options", () => {
		expect(dirHasEntry.meta.id).toBe("skill/dir-has-entry");
		expect(dirHasEntry.meta.tiers).toEqual(["recommended", "strict"]);
		expect(dirHasEntry.meta.defaultSeverity).toBe("error");
		expect(dirHasEntry.meta.fixable).toBe(false);
		expect(dirHasEntry.meta.optionsSchema).toBeUndefined();
		expect(dirHasEntry.kind).toBe("project");
	});
});
