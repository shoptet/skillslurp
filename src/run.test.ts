import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BASELINE_FILENAME } from "./baseline.js";
import { ConfigError, type ResolvedConfig } from "./config.js";
import { type Diagnostic, DOCS_URL } from "./diagnostic.js";
import { runEngine } from "./engine.js";
import { EXIT_CLEAN, EXIT_ERROR, EXIT_VIOLATIONS } from "./exit.js";
import { runGit } from "./git.js";
import type { ScanRule } from "./rule.js";
import { builtinRules } from "./rules/index.js";
import {
	configErrorDiagnostics,
	displayPath,
	formatError,
	listRulesCli,
	resolveColor,
	runCli,
} from "./run.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

test("configErrorDiagnostics: zero problems falls back to one diagnostic built from the error's own message", () => {
	const err = new ConfigError(
		"/repo/skillslurp.json",
		[],
		"no skillslurp.json found in .",
	);

	const diagnostics = configErrorDiagnostics(err, "/repo");

	expect(diagnostics).toHaveLength(1);
	expect(diagnostics[0]).toEqual({
		ruleId: "config/invalid",
		severity: "error",
		message: "no skillslurp.json found in .",
		file: "skillslurp.json",
		fixable: false,
		docsUrl: expect.any(String),
	});
});

test("configErrorDiagnostics: one diagnostic per problem, positioned when the problem has a loc", () => {
	const err = new ConfigError("/repo/skillslurp.json", [
		{ message: 'unrecognized key "rulez"', loc: { line: 2, col: 1 } },
		{ message: "surfaces is required" },
	]);

	const diagnostics = configErrorDiagnostics(err, "/repo");

	expect(diagnostics).toHaveLength(2);
	expect(diagnostics[0]?.line).toBe(2);
	expect(diagnostics[0]?.col).toBe(1);
	expect(diagnostics[1]?.line).toBeUndefined();
	expect(diagnostics[1]?.col).toBeUndefined();
	for (const d of diagnostics) {
		expect(d.ruleId).toBe("config/invalid");
		expect(d.file).toBe("skillslurp.json");
	}
});

test('configErrorDiagnostics: a problem carrying `ruleId: "config/no-files"` renders with that ruleId, not the generic config/invalid', () => {
	const err = new ConfigError("/repo/skillslurp.json", [
		{
			message:
				'surfaces[0] ("skills") matched no files; its include list is empty',
			ruleId: "config/no-files",
		},
	]);

	const diagnostics = configErrorDiagnostics(err, "/repo");

	expect(diagnostics).toHaveLength(1);
	expect(diagnostics[0]?.ruleId).toBe("config/no-files");
});

/**
 * `ConfigProblem.ruleId`'s JSDoc requires a reserved namespace, but nothing
 * enforced it at the one place every problem is consumed — a future problem minted with a
 * registered rule's own id would otherwise be indistinguishable from that rule's real output.
 */
test("configErrorDiagnostics: a problem carrying a non-reserved `ruleId` (e.g. a registered rule's own id) throws a plain Error naming it, not a ConfigError", () => {
	const err = new ConfigError("/repo/skillslurp.json", [
		{
			message: "impersonating a registered rule",
			ruleId: "skill/frontmatter-schema",
		},
	]);

	expect(() => configErrorDiagnostics(err, "/repo")).toThrow(
		/skill\/frontmatter-schema.*not in a reserved namespace/,
	);
});

test("runCli: a surface matching zero files exits 2 and reports config/no-files (end-to-end through loadConfig + discoverFiles)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-no-files-"));
	try {
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(
			join(dir, "skillslurp.json"),
			'{"surfaces":[{"root":"skills"}]}\n',
			"utf8",
		);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_ERROR);
		const payload = JSON.parse(result.stdout) as {
			diagnostics: { ruleId: string }[];
		};
		expect(
			payload.diagnostics.some((d) => d.ruleId === "config/no-files"),
		).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * The missing test named in the review: `run.test.ts` previously pinned only the
 * json reporter's shape for `config/no-files`; the stylish reporter goes through an entirely
 * separate rendering path (see reporters/stylish.ts) and had no coverage at all.
 */
test("runCli: a surface matching zero files reports config/no-files through the stylish reporter too", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-no-files-stylish-"));
	try {
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(
			join(dir, "skillslurp.json"),
			'{"surfaces":[{"root":"skills"}]}\n',
			"utf8",
		);

		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_ERROR);
		expect(result.stdout).toContain("config/no-files");
		expect(result.stdout).toContain("matched no files");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Zero-config auto-detection: the CLI-owned announcement / none-found notice
// ---------------------------------------------------------------------------

test("runCli: a detected .claude/skills layout with a real frontmatter violation exits 1, reports it on stdout, and announces detection on stderr (json reporter)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-detected-json-"));
	try {
		await mkdir(join(dir, ".claude", "skills", "broken-skill"), {
			recursive: true,
		});
		// An unrecognized key — `claude-code`'s dialect contract (auto-detected for
		// `.claude/skills`) makes both `name` and `description` optional (dialect-driven
		// defaults), so neither being absent is a violation here; the real,
		// engine-reported violation this test needs is check 4's unexpected-key report, which
		// fires regardless of what's required.
		await writeFile(
			join(dir, ".claude", "skills", "broken-skill", "SKILL.md"),
			"---\nname: broken-skill\nnot-a-real-key: nope\n---\nBody.\n",
			"utf8",
		);
		// `refs/no-unreachable-files` is a `recommended`-tier `project` rule that asks
		// `ctx.git.trackedFiles()` for any surface with an item directory, so the default tier
		// needs a checkout — on the zero-config path too. This fixture therefore has to be one;
		// the skill directory holds nothing but its entry document, so the rule itself stays
		// silent.
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		// stdout stays exactly what the reporter would produce for a configured run — the json
		// reporter must stay parseable, with the announcement nowhere in it.
		const payload = JSON.parse(result.stdout) as {
			diagnostics: { ruleId: string; message: string }[];
		};
		expect(
			payload.diagnostics.some((d) => d.ruleId === "skill/frontmatter-schema"),
		).toBe(true);
		expect(result.stdout).not.toContain("auto-detected");

		expect(result.stderr).toContain(
			"no skillslurp.json found; linting auto-detected surfaces:",
		);
		expect(result.stderr).toContain(".claude/skills (skills, claude-code)");
		// The ruleset a zero-config run applied is the single most surprising fact about
		// it — a user reading only stderr must be able to see it, not just which roots were
		// linted.
		expect(result.stderr).toContain(
			'using rules from extends: ["recommended"]',
		);
		expect(result.stderr).toContain("create skillslurp.json");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runCli: the same detected layout through the stylish reporter — stdout renders the violation, stderr carries the announcement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-detected-stylish-"));
	try {
		await mkdir(join(dir, ".claude", "skills", "broken-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "broken-skill", "SKILL.md"),
			"---\nname: broken-skill\nnot-a-real-key: nope\n---\nBody.\n",
			"utf8",
		);
		// A checkout, for the reason spelled out at the json-reporter detection test above.
		await gitInitAndCommit(dir);

		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toContain("skill/frontmatter-schema");
		expect(result.stdout).not.toContain("auto-detected");
		expect(result.stderr).toContain("linting auto-detected surfaces:");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// A candidate symlinked to the parent of another does not fail the run
// ---------------------------------------------------------------------------

/**
 * `.agents/skills` symlinked to `.claude` (a candidate pointing at another candidate's
 * *parent*, not at `.claude/skills` itself) resolves to a different real directory than
 * `.claude/skills`, yet both match `.claude/skills/my-skill/SKILL.md`. Detection used to hand
 * both to discovery, which rejected the run with a per-file-overlap `ConfigError` (exit 2) on a
 * layout the user never configured. Detection now keeps the deeper one and says so on stderr.
 */
test("runCli: a candidate symlinked to another candidate's parent is skipped as overlapping, the run exits by diagnostics, and the notice names the kept root", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-detected-overlap-"));
	try {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill.\n---\nBody.\n",
			"utf8",
		);
		await mkdir(join(dir, ".agents"), { recursive: true });
		await symlink("../.claude", join(dir, ".agents", "skills"), "dir");
		// A checkout, for the reason spelled out at the json-reporter detection test above.
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_CLEAN);
		const payload = JSON.parse(result.stdout) as {
			diagnostics: { ruleId: string }[];
		};
		expect(payload.diagnostics.map((d) => d.ruleId)).not.toContain(
			"config/invalid",
		);
		expect(result.stderr).toContain(
			"no skillslurp.json found; linting auto-detected surfaces:",
		);
		expect(result.stderr).toContain(".claude/skills (skills, claude-code)");
		expect(result.stderr).not.toContain(".agents/skills (skills, generic)");
		expect(result.stderr).toContain(
			".agents/skills overlaps .claude/skills and was skipped",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runCli: nested candidates whose matched files are disjoint are both linted, nothing is skipped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-detected-nested-"));
	try {
		await mkdir(join(dir, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill.\n---\nBody.\n",
			"utf8",
		);
		await mkdir(join(dir, ".claude", "rules"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "rules", "style.mdc"),
			"---\ndescription: a fixture rule.\nalwaysApply: true\n---\nBody.\n",
			"utf8",
		);
		await mkdir(join(dir, ".cursor"), { recursive: true });
		await symlink("../.claude", join(dir, ".cursor", "rules"), "dir");
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stderr).toContain(".claude/skills (skills, claude-code)");
		expect(result.stderr).toContain(".cursor/rules (rules, cursor)");
		expect(result.stderr).not.toContain("was skipped");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runCli: no known layout under an empty directory exits 0, stdout is the reporter's clean output ([] for json), stderr carries the none-found notice", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-none-found-json-"));
	try {
		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_CLEAN);
		const payload = JSON.parse(result.stdout) as { diagnostics: unknown[] };
		expect(payload.diagnostics).toEqual([]);
		expect(result.stderr).toContain(
			`no known agent-skill layout found under ${dir}`,
		);
		expect(result.stderr).toContain(".claude/skills");
		expect(result.stderr).toContain("create skillslurp.json");
		// Nothing existed, so the symlink hint would be advice about a problem this run does
		// not have — it is shown only when some candidate directory was really there.
		expect(result.stderr).not.toContain("are not followed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runCli: no known layout under an empty directory, stylish reporter — stdout is empty, stderr carries the none-found notice, exit 0", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-run-none-found-stylish-"),
	);
	try {
		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			`no known agent-skill layout found under ${dir}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The none-found notice must not deny a layout that is sitting right there
// ---------------------------------------------------------------------------

/**
 * A `.claude/skills` full of directory symlinks to real skill directories elsewhere (a
 * symlink-hub — the `hub/symlinks` shape rule) is a real, first-class layout. Before
 * the fix, the CLI's none-found notice said "no known agent-skill layout found ... looked in:
 * .claude/skills", which reads as "there is no such layout" even though `.claude/skills`
 * genuinely exists — the bug this test pins is fixed.
 */
test("runCli: a symlink-hub .claude/skills (skill directories are themselves symlinks) produces a none-found notice naming it as present-but-empty, exit 0", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-run-symlink-hub-empty-"),
	);
	try {
		await mkdir(join(dir, "real", "my-skill"), { recursive: true });
		await writeFile(join(dir, "real", "my-skill", "SKILL.md"), "x", "utf8");
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });
		await symlink(
			join(dir, "real", "my-skill"),
			join(dir, ".claude", "skills", "my-skill"),
			"dir",
		);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stderr).toContain(
			`no known agent-skill layout found under ${dir}; nothing to lint.`,
		);
		expect(result.stderr).toContain(
			".claude/skills exists, but no file matched **/SKILL.md",
		);
		expect(result.stderr).toContain("also looked for:");
		expect(result.stderr).toContain(".agents/skills");
		// The one hint that gets a hub user unstuck: without it, "exists, but no file matched
		// **/SKILL.md" is a dead end for someone staring at a directory full of symlinks.
		expect(result.stderr).toContain(
			"note: symlinks inside a surface are not followed.",
		);
		expect(result.stderr).toContain("create skillslurp.json");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * `.claude/skills` symlinked to a directory outside the repo, and nothing else present: the
 * none-found notice must name it specifically as an escaping symlink ("outside-repo"), not lump
 * it in with the candidates that are simply not there.
 */
test("runCli: an escaping symlink candidate is named in the none-found notice as outside-repo, exit 0", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-escapes-only-"));
	try {
		const outsideTarget = join(dir, "outside");
		await mkdir(outsideTarget, { recursive: true });
		await writeFile(join(outsideTarget, "SKILL.md"), "x", "utf8");
		await mkdir(join(dir, "repo", ".claude"), { recursive: true });
		await symlink(outsideTarget, join(dir, "repo", ".claude", "skills"), "dir");

		const result = await runCli({
			path: join(dir, "repo"),
			reporter: "json",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stderr).toContain(
			".claude/skills points outside the repository and was skipped",
		);
		expect(result.stderr).toContain("also looked for:");
		expect(result.stderr).toContain(".agents/skills");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * A run that DID find surfaces to lint can still have a candidate that contributed nothing
 * alongside them (here, an escaping symlink) — the detected-run announcement must mention it
 * too, one line, not silently drop it because the run overall succeeded.
 */
test("runCli: a detected run's announcement also names a skipped escaping-symlink candidate alongside the surfaces it found", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-mixed-skip-"));
	try {
		const repoRoot = join(dir, "repo");
		const outsideTarget = join(dir, "outside-of-repo-target");
		await mkdir(join(repoRoot, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(repoRoot, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill.\n---\nBody.\n",
			"utf8",
		);
		await mkdir(outsideTarget, { recursive: true });
		await writeFile(join(outsideTarget, "x.mdc"), "x", "utf8");
		await mkdir(join(repoRoot, ".cursor"), { recursive: true });
		await symlink(outsideTarget, join(repoRoot, ".cursor", "rules"), "dir");
		// A checkout, for the reason spelled out at the json-reporter detection test above.
		await gitInitAndCommit(repoRoot);

		const result = await runCli({
			path: repoRoot,
			reporter: "json",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stderr).toContain(".claude/skills (skills, claude-code)");
		expect(result.stderr).toContain(
			".cursor/rules points outside the repository and was skipped",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Coverage gaps: .agents/ and mixed layouts end-to-end
// ---------------------------------------------------------------------------

test("runCli: a .agents/skills-only layout end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-agents-only-"));
	try {
		await mkdir(join(dir, ".agents", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".agents", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\n---\nBody.\n",
			"utf8",
		);
		// A checkout, for the reason spelled out at the json-reporter detection test above.
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			diagnostics: { ruleId: string }[];
		};
		expect(
			payload.diagnostics.some((d) => d.ruleId === "skill/frontmatter-schema"),
		).toBe(true);
		expect(result.stderr).toContain(".agents/skills (skills, generic)");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * For a mixed layout, the announcement must list both surfaces in table order (`.claude/skills`
 * before `.cursor/rules`, matching `CANDIDATE_TABLE`), not e.g. filesystem readdir order.
 */
/**
 * `.github/skills` and `.cursor/rules` are deliberately the pair used here, not `.claude/skills`
 * + `.cursor/rules`: `CANDIDATE_TABLE` order puts `.github/skills` (index 4) before
 * `.cursor/rules` (index 5), but plain alphabetical order would put `.cursor/rules` FIRST
 * (`.cursor` < `.github`) — the opposite of table order. An assertion built on `.claude/skills`
 * + `.cursor/rules` cannot tell "sorted by table position" from "sorted alphabetically" apart,
 * since `.claude` < `.cursor` either way (CLAUDE.md: "an ordering assertion whose fixture
 * happened to be sorted already" has already passed for the wrong reason once in this repo).
 */
test("runCli: a mixed .github/skills + .cursor/rules layout end-to-end, announcement lists both surfaces in table order (not alphabetical)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-mixed-"));
	try {
		await mkdir(join(dir, ".github", "skills", "my-skill"), {
			recursive: true,
		});
		await writeFile(
			join(dir, ".github", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: a fixture skill.\n---\nBody.\n",
			"utf8",
		);
		await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
		// `alwaysApply`, not `globs`: `activation/no-unmatched-globs` resolves an activation glob
		// against `ctx.git.trackedFiles()`, and a `globs:` key here would make this test — which
		// is about the ORDER surfaces are announced in and nothing else — depend on what the
		// checkout below happens to contain. `alwaysApply: true` is a documented `cursor` rules
		// key that declares no activation scope at all, so the fixture stays a realistic `.mdc`
		// while the announcement stays the only thing under test.
		await writeFile(
			join(dir, ".cursor", "rules", "x.mdc"),
			"---\nalwaysApply: true\n---\nBody.\n",
			"utf8",
		);
		// A checkout, for the reason spelled out at the json-reporter detection test above. The
		// `.cursor/rules` surface is flat — every entry sits directly in the surface root — so
		// `refs/no-unreachable-files` is a no-op for it and only `.github/skills` is walked.
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		const githubIndex = result.stderr.indexOf(
			".github/skills (skills, copilot)",
		);
		const cursorIndex = result.stderr.indexOf(".cursor/rules (rules, cursor)");
		expect(githubIndex).toBeGreaterThanOrEqual(0);
		expect(cursorIndex).toBeGreaterThan(githubIndex);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// "candidate directory exists but is empty" at the
// runCli level (the existing none-found tests use a wholly empty root)
// ---------------------------------------------------------------------------

test("runCli: a candidate directory that exists but is empty still exits 0 with the none-found notice, not a false-clean run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-empty-candidate-"));
	try {
		await mkdir(join(dir, ".claude", "skills"), { recursive: true });

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_CLEAN);
		const payload = JSON.parse(result.stdout) as { diagnostics: unknown[] };
		expect(payload.diagnostics).toEqual([]);
		expect(result.stderr).toContain(
			".claude/skills exists, but no file matched **/SKILL.md",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("displayPath: a non-absolute file is returned as-is (posix-converted), root is not consulted", () => {
	expect(displayPath("/anything/at/all", "already/relative.yaml")).toBe(
		"already/relative.yaml",
	);
});

test("displayPath: an absolute file inside root is rendered relative to root", () => {
	expect(displayPath("/repo", "/repo/skillslurp.json")).toBe("skillslurp.json");
});

test("formatError: an Error with no cause returns just its own message", () => {
	expect(formatError(new Error("boom"))).toBe("boom");
});

test("formatError: an Error with an Error cause appends the cause's own message", () => {
	const err = new Error("outer", { cause: new Error("inner") });
	expect(formatError(err)).toBe("outer: inner");
});

test("formatError: an Error with a non-Error cause stringifies the cause", () => {
	const err = new Error("outer", { cause: "inner-string" });
	expect(formatError(err)).toBe("outer: inner-string");
});

test("formatError: a message cannot open a GitHub workflow command or carry a legacy one", () => {
	const err = new Error("::warning::x", { cause: new Error("##[error]y") });
	expect(formatError(err)).toBe("\\u{3a}:warning::x: #\\u{23}[error]y");
});

test("formatError: a thrown non-Error is escaped the same way as an Error message", () => {
	expect(formatError("::warning::x\x1b")).toBe("\\u{3a}:warning::x\\u{1b}");
});

// Reproduced from an ordinary committed file: a
// `skillslurp-baseline.json` whose top-level key carries ANSI and CRLF reaches stderr through
// zod's `strictObject` message, which embeds the offending key raw. Raw ANSI repaints the
// operator's terminal; a raw newline followed by `::` forges a workflow-command line in a CI log.
// Mutation check: drop the `sanitizeControlChars` wrapper in `formatError` and both assertions
// below fail.
test("formatError: control characters in a message are escaped, not passed to stderr raw", () => {
	const esc = String.fromCodePoint(0x1b);
	const hostile = `${esc}[2J\r\n::error::PWNED`;
	const rendered = formatError(new Error(`invalid: ${hostile}`));

	expect(rendered).toBe("invalid: \\u{1b}[2J\\u{d}\\u{a}::error::PWNED");
	expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(rendered)).toBe(false);
});

// The same, one link deeper: a cause chain is joined BEFORE sanitizing, so a hostile cause must
// not slip through the join.
test("formatError: a hostile cause is escaped too", () => {
	const esc = String.fromCodePoint(0x1b);
	const err = new Error("outer", { cause: new Error(`${esc}[31minner`) });
	expect(formatError(err)).toBe("outer: \\u{1b}[31minner");
});

test("formatError: a non-Error throw is stringified directly", () => {
	expect(formatError("just a string")).toBe("just a string");
});

test('formatError: an Error with a plain-object cause renders it via JSON.stringify, not the useless default "[object Object]"', () => {
	const err = new Error("outer", { cause: { code: "EACCES", errno: -13 } });
	expect(formatError(err)).toBe('outer: {"code":"EACCES","errno":-13}');
});

// --- formatError must walk the WHOLE cause chain, not just one level ---

test('formatError: a three-level cause chain (rule crash / wrapped read failure / raw errno) renders every link, `": "`-joined, no stack trace', () => {
	// Shape measured off a real run: engine.ts's `ruleCrashErrorForSurface` wraps whatever a
	// scan rule's own `check` threw, and a rule that reads a file itself typically wraps the
	// raw errno in its own "failed to read ..." message — three links by the time it reaches
	// `formatError`, not two.
	const innermost = new Error(
		"EACCES: permission denied, lstat '/private/tmp/sseacces/locked.md'",
	);
	const middle = new Error('failed to read "locked.md"', {
		cause: innermost,
	});
	const outer = new Error(
		'rule "probe/scan" crashed while checking surfaces[0] ("skills")',
		{ cause: middle },
	);

	expect(formatError(outer)).toBe(
		[
			'rule "probe/scan" crashed while checking surfaces[0] ("skills")',
			'failed to read "locked.md"',
			"EACCES: permission denied, lstat '/private/tmp/sseacces/locked.md'",
		].join(": "),
	);
	expect(formatError(outer).split("\n")).toHaveLength(1);
});

test("formatError: a self-referencing cause (`err.cause === err`) terminates instead of looping forever", () => {
	const err = new Error("boom") as Error & { cause: unknown };
	err.cause = err;

	expect(formatError(err)).toBe("boom: boom");
});

test("formatError: a two-node cause cycle (a -> b -> a) terminates instead of looping forever", () => {
	const a = new Error("a") as Error & { cause: unknown };
	const b = new Error("b", { cause: a });
	a.cause = b;

	expect(formatError(a)).toBe("a: b: a");
});

test.skipIf(process.getuid?.() === 0)(
	"formatError: a real scan-rule crash over a mode-000 file renders the raw errno's message, machine-absolute path included — deliberately, since a permission error is undiagnosable without it",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-eacces-"));
		try {
			await writeFile(join(dir, "locked.md"), "secret\n", "utf8");
			await chmod(join(dir, "locked.md"), 0o000);

			// A minimal scan rule that reads a file itself and wraps the failure exactly the
			// way `engine.ts`'s own discovery-time reads do (`failed to read "<path>"`,
			// `{ cause: err }`) — the shape `formatError`'s doc names, reproduced with a REAL EACCES
			// rather than a hand-built Error, so the claim "Node's own message embeds the
			// absolute path" is backed by this test's own assertion below, not assumed.
			const rule: ScanRule = {
				kind: "scan",
				meta: {
					id: "probe/scan",
					description: "test probe",
					docsUrl: "https://example.invalid/docs",
					tiers: [],
					defaultSeverity: "error",
					fixable: false,
				},
				check: async (ctx) => {
					try {
						await readFile(resolve(ctx.root, "locked.md"), "utf8");
					} catch (err) {
						throw new Error('failed to read "locked.md"', { cause: err });
					}
					return [];
				},
			};

			const config: ResolvedConfig = {
				root: dir,
				origin: "config",
				configFile: join(dir, "skillslurp.json"),
				ignore: [],
				surfaces: [
					{
						root: ".",
						kind: "skills",
						dialects: ["generic"],
						include: ["**/*.md"],
						// `locked.md` must never be discovered/read as an ordinary document —
						// the engine reads every discovered document up front (`caps.documents()`
						// inside `runEngine`) regardless of which rules are enabled, and THAT
						// read failing first would produce only a two-level chain ("failed to
						// read ...: EACCES ...", no "rule crashed" wrapper), not the three-level
						// one this test exists to pin. Ignored here so the ONLY read of it is
						// the rule's own, inside `check`.
						ignore: ["locked.md"],
						spokes: [],
						rules: new Map(),
					},
				],
				rules: new Map([["probe/scan", { severity: "error" }]]),
				ruleOptions: new Map(),
				skippedCandidates: [],
			};

			let caught: unknown;
			try {
				await runEngine(config, [rule]);
			} catch (err) {
				caught = err;
			}

			if (!(caught instanceof Error)) {
				throw new Error("expected runEngine to reject");
			}

			const rendered = formatError(caught);
			expect(rendered).toContain(
				'rule "probe/scan" crashed while checking surfaces[0]',
			);
			expect(rendered).toContain('failed to read "locked.md"');
			expect(rendered).toContain("EACCES");
			// The deliberate part: the innermost link's OWN message names the
			// real, machine-absolute path the syscall was actually given — rendered here, not
			// suppressed, because there is no other way for the user to know which file on
			// their own disk needs its permissions fixed.
			expect(rendered).toContain(join(dir, "locked.md"));
			expect(rendered.split("\n")).toHaveLength(1);
		} finally {
			await chmod(join(dir, "locked.md"), 0o644);
			await rm(dir, { recursive: true, force: true });
		}
	},
);

/**
 * Temporarily overrides `process.env` keys and `process.stdout.isTTY` for the duration of
 * `fn`, always restoring the previous values — `resolveColor` reads these globals directly, so
 * there is no other way to exercise its branches without actually attaching/detaching a real
 * TTY.
 */
function withColorEnv<T>(
	env: Record<string, string | undefined>,
	isTTY: boolean | undefined,
	fn: () => T,
): T {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
	}
	// @types/node declares `isTTY` as a plain `boolean`, but at runtime it is simply absent
	// (undefined) on a non-TTY stream — the cast reflects that reality, which is exactly the
	// branch this helper needs to simulate.
	const savedIsTTY = process.stdout.isTTY as boolean | undefined;
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		process.stdout.isTTY = isTTY as boolean;
		return fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		process.stdout.isTTY = savedIsTTY as boolean;
	}
}

test("resolveColor: false when stdout is not a TTY", () => {
	withColorEnv({ NO_COLOR: undefined, TERM: undefined }, false, () => {
		expect(resolveColor()).toBe(false);
	});
});

test("resolveColor: false when NO_COLOR is set to a non-empty value", () => {
	withColorEnv({ NO_COLOR: "1", TERM: undefined }, true, () => {
		expect(resolveColor()).toBe(false);
	});
});

test("resolveColor: true when NO_COLOR is present but empty (spec: only non-empty disables color)", () => {
	withColorEnv({ NO_COLOR: "", TERM: undefined }, true, () => {
		expect(resolveColor()).toBe(true);
	});
});

test("resolveColor: false when TERM is dumb", () => {
	withColorEnv({ NO_COLOR: undefined, TERM: "dumb" }, true, () => {
		expect(resolveColor()).toBe(false);
	});
});

test("resolveColor: true when isTTY, no NO_COLOR, and TERM is not dumb", () => {
	withColorEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, true, () => {
		expect(resolveColor()).toBe(true);
	});
});

// --- the same repo must lint identically regardless of which of two valid spellings of
// its root the caller used — the real path, or a symlink to it ---

test("runCli: index/complete and index/no-missing-targets give byte-identical, correct output through the repo's real path AND through a symlink to it", async () => {
	const parent = await mkdtemp(join(tmpdir(), "skillslurp-d1-"));
	try {
		const repoLexical = join(parent, "repo");
		await mkdir(repoLexical, { recursive: true });
		const repoReal = await realpath(repoLexical);
		await mkdir(join(repoReal, ".claude", "skills", "widgets"), {
			recursive: true,
		});
		await mkdir(join(repoReal, ".claude", "skills", "gadgets"), {
			recursive: true,
		});
		await writeFile(
			join(repoReal, ".claude", "skills", "widgets", "SKILL.md"),
			"# Widgets\n",
			"utf8",
		);
		await writeFile(
			join(repoReal, ".claude", "skills", "gadgets", "SKILL.md"),
			"# Gadgets\n",
			"utf8",
		);
		// `widgets` is linked; `gadgets` is not (index/complete must catch it); the index also
		// links a target that does not exist anywhere (index/no-missing-targets must catch it).
		await writeFile(
			join(repoReal, "SKILLS.md"),
			"# Skills Index\n\n" +
				"- [widgets](.claude/skills/widgets/SKILL.md)\n" +
				"- [ghost](.claude/skills/nope/SKILL.md)\n",
			"utf8",
		);
		await writeFile(
			join(repoReal, "skillslurp.json"),
			// No tier rules — this test is only about the two index rules; leaving the default
			// `extends: [recommended]` in place would add `skill/frontmatter-schema` noise for these
			// frontmatter-less fixtures.
			JSON.stringify({
				surfaces: [{ root: ".claude/skills" }],
				extends: [],
				rules: {
					"index/complete": {
						severity: "error",
						options: { file: "SKILLS.md" },
					},
					"index/no-missing-targets": {
						severity: "error",
						options: { file: "SKILLS.md" },
					},
				},
			}),
			"utf8",
		);
		// Both index rules resolve their link targets against git's index, so this
		// repo has to be a checkout — `gitInitAndCommit` is the same materialization step
		// `RuleTester` runs for a `project` case, reused rather than reimplemented here. It also
		// sharpens what the assertions below prove: `nope/SKILL.md` is a ghost because git tracks
		// nothing there, and `widgets`/`gadgets` are found because git does.
		await gitInitAndCommit(repoReal);

		// A second, differently-spelled path to the IDENTICAL directory — the shape macOS's
		// own `/tmp` -> `/private/tmp` produces on every ordinary invocation, reproduced here
		// explicitly so the test does not depend on which platform it runs on.
		const repoSymlink = join(parent, "repo-symlink");
		await symlink(repoReal, repoSymlink, "dir");

		const viaRealPath = await runCli({
			path: repoReal,
			reporter: "json",
			color: false,
		});
		const viaSymlink = await runCli({
			path: repoSymlink,
			reporter: "json",
			color: false,
		});

		// Byte-identical: not just "both wrong the same way" — this also asserts each one is
		// CORRECT (exactly the two expected violations, nothing extra, nothing missing).
		expect(viaSymlink.stdout).toBe(viaRealPath.stdout);
		expect(viaSymlink.stderr).toBe(viaRealPath.stderr);
		expect(viaSymlink.exitCode).toBe(viaRealPath.exitCode);

		expect(viaRealPath.exitCode).toBe(EXIT_VIOLATIONS);
		expect(viaRealPath.stderr).toBe("");
		const payload = JSON.parse(viaRealPath.stdout) as {
			diagnostics: { ruleId: string; message: string }[];
		};
		expect(payload.diagnostics).toHaveLength(2);
		expect(
			payload.diagnostics.find((d) => d.ruleId === "index/complete")?.message,
		).toBe(
			'Entry document ".claude/skills/gadgets/SKILL.md" is not linked from index file "SKILLS.md"',
		);
		expect(
			payload.diagnostics.find((d) => d.ruleId === "index/no-missing-targets")
				?.message,
		).toBe(
			'Index link target ".claude/skills/nope/SKILL.md" does not exist or is not tracked by git',
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

/**
 * `loadConfig` succeeding and THEN a downstream `ConfigError` (here, `discoverFiles`'s
 * surface-overlap check) is the one path `runCli`'s own `root` variable (`resolve(options.path)`,
 * always lexical) no longer agrees with `err.file` (`config.configFile`, now canonical) on a
 * symlinked path — unless `runCli` prefers `config.root` once `loadConfig` has actually
 * returned one.
 */
test("runCli: a post-loadConfig ConfigError (surface overlap) renders a clean repo-relative file even through a symlinked root", async () => {
	const realDir = await mkdtemp(join(tmpdir(), "skillslurp-overlap-real-"));
	try {
		await mkdir(join(realDir, "a"), { recursive: true });
		await writeFile(join(realDir, "a", "SKILL.md"), "x", "utf8");
		await writeFile(
			join(realDir, "skillslurp.json"),
			'{"surfaces":[{"root":"a"},{"root":"a"}]}\n',
			"utf8",
		);
		const linkDir = join(tmpdir(), `skillslurp-overlap-link-${process.pid}`);
		await symlink(realDir, linkDir, "dir");
		try {
			const result = await runCli({
				path: linkDir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_ERROR);
			const payload = JSON.parse(result.stdout) as {
				diagnostics: Diagnostic[];
			};
			expect(payload.diagnostics).toHaveLength(1);
			expect(payload.diagnostics[0]?.file).toBe("skillslurp.json");
		} finally {
			await rm(linkDir, { force: true });
		}
	} finally {
		await rm(realDir, { recursive: true, force: true });
	}
});

// --- a git checkout is a hard requirement of the `recommended` tier, and a run that has not
// got one says so once, at the top, instead of blaming the rule that asked first ---

test("runCli: a directory that is not a checkout stops with one sentence naming the path and the requirement, at exit 2", async () => {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-no-checkout-")),
	);
	try {
		await mkdir(join(dir, ".claude", "skills", "widgets"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "skills", "widgets", "SKILL.md"),
			"---\nname: widgets\ndescription: A skill that links to its own reference file.\n---\n\n[the reference](./reference.md)\n",
			"utf8",
		);
		// Present and correct: the link is not broken, and nothing else here is either. The one
		// thing wrong with this directory is that it is not a checkout — which is exactly the
		// zero-config flagship path (`npx skillslurp .` on an unzipped folder) the checkout requirement is about.
		await writeFile(
			join(dir, ".claude", "skills", "widgets", "reference.md"),
			"# Reference\n",
			"utf8",
		);

		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		// Exactly one line, and it is about git — not `rule "links/resolve" crashed while
		// checking ".claude/skills/widgets/SKILL.md"`, which is what this produced before the
		// engine learned to recognise the error (`gitCheckoutRequiredError`, engine.ts).
		expect(result.stderr).toBe(
			`"${dir}" is not a git checkout — skillslurp resolves link targets against git's index, so the path it lints must be inside a git repository\n`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * End to end through the real CLI path: `index/complete` with a configured `file`
 * that does not exist reports `config/missing-file` and the run exits **1**, not 2.
 *
 * Every clause of that sentence is a separate way the mechanism could regress, and each is
 * asserted:
 * - exit 1, not 2 — a `ConfigError` (the only exit-2 config path, `loadConfig`/`discoverFiles`)
 *   aborts before a single rule runs; this is found WHILE linting;
 * - `config/missing-file`, not `index/complete` — the engine's id, not the rule's;
 * - severity `error` though the rule is configured `warn` in the yaml below;
 * - positioned at the surface's own `root:` line in the config file, which is `ResolvedSurface.loc`
 *   reaching a diagnostic for the first time;
 * - and the run's OTHER diagnostics still print, which is the entire reason this is exit 1 rather
 *   than a `ConfigError`: `links/resolve` still reports the broken link in `skills/a/SKILL.md`.
 */
test("runCli: a configured-but-missing index file exits 1 as config/missing-file, and the run's other diagnostics still print", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-run-config-report-"));
	try {
		await mkdir(join(dir, "skills", "a"), { recursive: true });
		await writeFile(
			join(dir, "skills", "a", "SKILL.md"),
			"# A\n\n[gone](./nowhere.md)\n",
			"utf8",
		);
		await writeFile(
			join(dir, "skillslurp.json"),
			[
				"{",
				'  "rules": { "links/resolve": "error" },',
				'  "surfaces": [',
				"    {",
				'      "root": "skills",',
				'      "rules": { "index/complete": { "severity": "warn", "options": { "file": "SKILLS.md" } } }',
				"    }",
				"  ]",
				"}",
				"",
			].join("\n"),
			"utf8",
		);

		// `links/resolve` resolves its targets against git's index, so a run over a
		// directory that is not a checkout stops at exit 2 before any of this can be observed
		// (`gitCheckoutRequiredError`, engine.ts). Git-initting here keeps the exit code under
		// test the one this test is about — 1, from the config report — rather than that one.
		await gitInitAndCommit(dir);

		const result = await runCli({ path: dir, reporter: "json", color: false });

		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			diagnostics: Diagnostic[];
		};
		const configDiagnostic = payload.diagnostics.find(
			(d) => d.ruleId === "config/missing-file",
		);
		expect(configDiagnostic).toEqual({
			ruleId: "config/missing-file",
			severity: "error",
			message: 'Index file "SKILLS.md" does not exist',
			// Repo-relative, despite `ResolvedConfig.configFile` and `.root` disagreeing about
			// symlinks on darwin — see `configFileForReports` (engine.ts) for the inconsistency
			// this asserts the handling of.
			file: "skillslurp.json",
			// The `"skills"` scalar on line 5 of the JSON above: `ResolvedSurface.loc`
			// reaching a `Diagnostic` for the first time. Positioning at the surface a rule was
			// dispatched on is what makes this actionable — a run with three surfaces, two of them
			// configuring `index/complete`, otherwise reports two identical unpositioned lines.
			line: 5,
			col: 15,
			endLine: 5,
			endCol: 23,
			fixable: false,
			docsUrl: DOCS_URL,
		});
		// The rest of the run still reported: this is exactly what exit 2 would have thrown away.
		expect(payload.diagnostics.some((d) => d.ruleId === "links/resolve")).toBe(
			true,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------------------------
// `listRulesCli` — `--list-rules`.
//
// Every count and every id below is DERIVED from `builtinRules`, never typed out. The listing's
// job is to describe whatever the registry currently holds, so a test that hardcoded thirteen
// would have to be rewritten by the next person to add a rule, and would tell them nothing about
// whether their rule reached the listing — only that the number changed.
// ---------------------------------------------------------------------------------------------

test("listRulesCli: the json listing carries every registered rule, in registry order, exit 0", () => {
	const result = listRulesCli({ reporter: "json", color: false });

	expect(result.exitCode).toBe(EXIT_CLEAN);
	// No detection announcement, no notice, nothing: this path never looks at a repository, so
	// it has nothing to tell the user about one.
	expect(result.stderr).toBe("");

	const parsed = JSON.parse(result.stdout) as {
		id: string;
		kind: string;
		tiers: string[];
		defaultSeverity: string;
		fixable: boolean;
		description: string;
		docsUrl: string;
	}[];

	expect(parsed).toHaveLength(builtinRules.length);
	expect(parsed.map((r) => r.id)).toEqual(builtinRules.map((r) => r.meta.id));
	// Every field of every rule, compared against the registry itself — this is what makes the
	// listing a view of `builtinRules` rather than a second, drifting copy of it.
	expect(parsed).toEqual(
		builtinRules.map((rule) => ({
			id: rule.meta.id,
			kind: rule.kind,
			tiers: [...rule.meta.tiers],
			defaultSeverity: rule.meta.defaultSeverity,
			fixable: rule.meta.fixable,
			description: rule.meta.description,
			docsUrl: rule.meta.docsUrl,
		})),
	);
});

test("listRulesCli: the stylish listing is one line per registered rule, exit 0", () => {
	const result = listRulesCli({ reporter: "stylish", color: false });

	expect(result.exitCode).toBe(EXIT_CLEAN);
	expect(result.stderr).toBe("");
	// `terminate`'s trailing newline, the same one a stylish lint run's stdout gets.
	expect(result.stdout.endsWith("\n")).toBe(true);

	const lines = result.stdout.trimEnd().split("\n");
	expect(lines).toHaveLength(builtinRules.length);
	for (const [i, rule] of builtinRules.entries()) {
		const line = lines[i] ?? "";
		expect(line.startsWith(`${rule.meta.id} `)).toBe(true);
		expect(line).toContain(rule.kind);
		expect(line).toContain(rule.meta.description);
		expect(line).toContain(rule.meta.docsUrl);
	}
});

/**
 * The contract: not one ANSI byte reaches stdout under `--reporter json`, whatever the terminal
 * is. It breaks every machine consumer, and `JSON.parse` would not necessarily notice — an escape
 * inside a string value parses fine.
 *
 * Two independent layers hold it up, and this test guards the composite rather than either one:
 * `listRulesCli` forces `color: false` for json (the rule `runCli` already applies, restated
 * because this is a second entry point into the same reporters), and `jsonRules` ignores
 * `options.color` outright. Measured: removing EITHER layer alone leaves this green, and removing
 * both fails it. That is what defense in depth looks like from a test's point of view, and it is
 * recorded here so the redundancy reads as deliberate rather than as one of the two being dead
 * code. The lister's own half is pinned separately in reporters/json.test.ts.
 */
test("listRulesCli: --reporter json puts no ANSI on stdout for a color: true request", () => {
	const colored = listRulesCli({ reporter: "json", color: true });

	expect(colored.stdout).not.toContain("\x1b");
	expect(colored.stdout).toBe(
		listRulesCli({ reporter: "json", color: false }).stdout,
	);
});

// ---------------------------------------------------------------------------
// The suppression baseline: load, match, suppress, stale guard
// ---------------------------------------------------------------------------

/**
 * Builds a throwaway repository from a path → content map, commits it, and hands the directory
 * to `body`. Every baseline case needs the same three things — real files, a real checkout (the
 * `refs/*` rules read git's index), and a temp directory that is cleaned up even when the
 * assertion throws — and writing that out per case is how two cases end up differing in a way
 * nobody intended.
 *
 * `Object.entries` order is insertion order for these keys, so the write order is the literal's
 * order; nothing here depends on it, but it keeps a failure reproducible.
 */
async function writeFiles(
	dir: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const abs = join(dir, path);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
}

async function writeLinks(
	dir: string,
	links: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [path, target] of Object.entries(links)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await symlink(target, join(dir, path), "dir");
	}
}

/** `withRepo` with directory symlinks (path to relative target) committed alongside the files. */
async function withLinkedRepo(
	prefix: string,
	files: Readonly<Record<string, string>>,
	links: Readonly<Record<string, string>>,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	await withRepo(prefix, files, async (dir) => {
		await writeLinks(dir, links);
		await commitAll(dir, "links");
		await body(dir);
	});
}

async function withRepo(
	prefix: string,
	files: Readonly<Record<string, string>>,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), `skillslurp-${prefix}-`));
	try {
		await writeFiles(dir, files);
		await gitInitAndCommit(dir);
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * The same `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` neutralization `gitInitAndCommit` applies to
 * its own invocations (rule-tester.ts) — the extra commits `--diff-base` needs must be as
 * independent of the developer's `~/.gitconfig` as the first one is.
 */
const GIT_TEST_ENV = Object.freeze({
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
});

/** `runGit` with this file's fixed environment, trimmed to text. */
async function git(dir: string, args: readonly string[]): Promise<string> {
	return (await runGit(dir, args, GIT_TEST_ENV)).toString("utf8").trim();
}

/** Second and later commits; `gitInitAndCommit` made the first and configured the identity. */
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

/**
 * `withRepo`'s two-commit sibling: writes `initial`, commits it, records that commit as
 * the diff base, then writes `second` over the top and commits again. `body` gets the repo and
 * the base revision, so every `--diff-base` case below states its "before" and "after" as two
 * file maps and nothing else.
 */
async function withDiffRepo(
	prefix: string,
	initial: Readonly<Record<string, string>>,
	second: Readonly<Record<string, string>>,
	body: (dir: string, base: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), `skillslurp-${prefix}-`));
	try {
		await writeFiles(dir, initial);
		await gitInitAndCommit(dir);
		const base = await headRev(dir);
		await writeFiles(dir, second);
		await commitAll(dir, "second commit");
		await body(dir, base);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * The baseline file as a user would write it. `JSON.stringify` rather than
 * `serializeBaseline`: a test that built its input with the implementation's own serializer
 * would pass just as happily if both sides agreed on the wrong shape. Key order here is
 * deliberately NOT sorted for the same reason — the loader must not care.
 */
function baselineJson(
	files: Readonly<Record<string, Record<string, Record<string, number>>>>,
): string {
	return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

interface JsonReport {
	version: number;
	summary: { problems: number; errors: number; warnings: number };
	diagnostics: {
		ruleId: string;
		severity: string;
		message: string;
		file: string;
		line?: number;
		col?: number;
		fixable: boolean;
		docsUrl: string;
	}[];
}

function parseReport(stdout: string): JsonReport {
	return JSON.parse(stdout) as JsonReport;
}

/** One valid skill, so every fixture below has a surface with a document in it. */
const ALPHA_SKILL =
	"---\nname: fixture-alpha\ndescription: A fixture skill for the baseline tests.\n---\n\nBody.\n";

/**
 * `refs/no-dangling-paths` only, at error. `extends: []` so the run's diagnostics are exactly
 * the ones each case is about — a tier would add `file/max-lines` warnings and
 * `refs/no-unreachable-files` to every assertion below.
 */
const PATHS_CONFIG = `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ]
    }
  ],
  "rules": {
    "refs/no-dangling-paths": "error"
  }
}
`;

/** The same dangling path twice, at lines 5 and 11, both at column 5. */
const NOTES_TWICE = `# Notes

Filler line.

See .claude/skills/gone/SKILL.md for details.

Filler line.

Filler line.

See .claude/skills/gone/SKILL.md again.
`;

/** One occurrence, at line 3. */
const NOTES_ONCE = `# Notes

See .claude/skills/gone/SKILL.md for details.
`;

const DANGLING_MESSAGE =
	'Path ".claude/skills/gone/SKILL.md" does not exist or is not tracked by git';

const PATHS_FIXTURE: Readonly<Record<string, string>> = {
	"skillslurp.json": PATHS_CONFIG,
	".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
	"notes.md": NOTES_TWICE,
};

test("baseline: a run with no baseline file reports everything and prints no notice", async () => {
	await withRepo("baseline-absent", PATHS_FIXTURE, async (dir) => {
		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(`notes.md
  5:5   error  ${DANGLING_MESSAGE}  refs/no-dangling-paths
  11:5  error  ${DANGLING_MESSAGE}  refs/no-dangling-paths

✖ 2 problems (2 errors, 0 warnings)
`);
		// The whole of stderr: a repo without a baseline must not learn that the feature exists.
		expect(result.stderr).toBe("");
	});
});

/**
 * The end-to-end shape of the read-side symlink hole, at the level a CI log actually sees it:
 * `git clone <untrusted> && skillslurp .`, no flags, with `skillslurp-baseline.json` committed as
 * a symlink. Measured 2026-09-06 before the guard, the run printed the target's first bytes back
 * (`... is not valid JSON: Unexpected token 'A', "AKIAIOSFOD"...`) at exit 2 — an
 * information-disclosure primitive chosen by whoever opened the pull request.
 *
 * The link target lives inside the repository, not outside it, so this test proves the guard
 * refuses on the LINK rather than on containment: `isWithinRoot` would have let this one through.
 */
test("baseline: a symlinked skillslurp-baseline.json is refused at exit 2 with nothing from the target in the output", async () => {
	await withRepo(
		"baseline-symlink",
		{ ...PATHS_FIXTURE, "secret.txt": "SLURPSECRET-do-not-echo\n" },
		async (dir) => {
			await rm(join(dir, BASELINE_FILENAME), { force: true });
			await symlink(join(dir, "secret.txt"), join(dir, BASELINE_FILENAME));

			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_ERROR);
			expect(result.stderr).toBe(
				'refusing to read "skillslurp-baseline.json": it is a symbolic link, and following it would read outside the path you asked to lint\n',
			);
			// Not just "the message is right": nothing anywhere in the run's output may carry a
			// byte of the target, and neither sink is exempt — stdout is where the config
			// loader's equivalent leak landed.
			expect(result.stdout + result.stderr).not.toContain("SLURPSECRET");
		},
	);
});

test("baseline: an entry matching every occurrence (N = M) suppresses them all, exit 0, and the notice reports the count", async () => {
	await withRepo(
		"baseline-all",
		{
			...PATHS_FIXTURE,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				"skillslurp-baseline.json: 2 problem(s) suppressed, 0 stale entr(y|ies)\n",
			);
		},
	);
});

test("baseline: N = 1 against M = 2 suppresses the lowest position only and reports the excess", async () => {
	await withRepo(
		"baseline-excess",
		{
			...PATHS_FIXTURE,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			const report = parseReport(result.stdout);
			// Excess is REPORTED (not ESLint's all-or-nothing), and it is the line-11 one: the
			// suppression takes the lowest position first, which is the only deterministic
			// choice a line-free key allows.
			expect(report.diagnostics.map((d) => [d.ruleId, d.line, d.col])).toEqual([
				["refs/no-dangling-paths", 11, 5],
			]);
			expect(result.stderr).toBe(
				"skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n",
			);
		},
	);
});

test("baseline: N = 2 against M = 1 suppresses the one and reports a positionless baseline/stale error at exit 1", async () => {
	await withRepo(
		"baseline-stale",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			// Exit 1, not ESLint's 2: a stale entry is a fact about the repository found while
			// linting it (2 is reserved for a crash or a config error).
			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			const report = parseReport(result.stdout);
			expect(report.diagnostics).toEqual([
				{
					ruleId: "baseline/stale",
					severity: "error",
					// Names the rule, the file it was filed under, what it expected and what is
					// left — measured against the diagnostics that came IN, not against what
					// survived suppression, or every matched entry would read as "but 0 remain".
					message: `Baseline entry for rule "refs/no-dangling-paths" in "notes.md" expects 2 occurrence(s) but 1 remain — run \`skillslurp --update-baseline\` to prune it`,
					file: "skillslurp-baseline.json",
					fixable: false,
					docsUrl: DOCS_URL,
				},
			]);
			// No position: the entry's line in the JSON is not stable across a regeneration.
			expect(report.diagnostics[0]).not.toHaveProperty("line");
			expect(report.diagnostics[0]).not.toHaveProperty("col");
			expect(result.stderr).toBe(
				"skillslurp-baseline.json: 1 problem(s) suppressed, 1 stale entr(y|ies)\n",
			);
		},
	);
});

test("baseline: an entry for a file with no current diagnostics at all (M = 0) is stale too", async () => {
	await withRepo(
		"baseline-stale-file",
		{
			...PATHS_FIXTURE,
			"notes.md": "# Notes\n\nNothing dangling here.\n",
			[BASELINE_FILENAME]: baselineJson({
				"deleted.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			const report = parseReport(result.stdout);
			// The iteration is over the BASELINE's keys, not the run's diagnostics — a file that
			// stopped producing anything (or stopped existing) has no diagnostic to notice.
			expect(report.diagnostics.map((d) => [d.ruleId, d.message])).toEqual([
				[
					"baseline/stale",
					`Baseline entry for rule "refs/no-dangling-paths" in "deleted.md" expects 1 occurrence(s) but 0 remain — run \`skillslurp --update-baseline\` to prune it`,
				],
			]);
		},
	);
});

test("baseline: inserting two blank lines above a baselined violation keeps it suppressed (no line in the key)", async () => {
	await withRepo(
		"baseline-shift",
		{
			...PATHS_FIXTURE,
			// The same content as NOTES_TWICE, shifted down by two lines: the violations are now
			// at 7 and 13. The baseline below is the N = M test's, unchanged.
			"notes.md": `\n\n${NOTES_TWICE}`,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
		},
	);
});

test("baseline: a file/max-lines entry keyed on the digit-normalized message survives the file growing", async () => {
	const grown = `---\nname: fixture-alpha\ndescription: A fixture skill for the baseline tests.\n---\n${"\nBody.".repeat(
		8,
	)}\n`;
	await withRepo(
		"baseline-digits",
		{
			"skillslurp.json": `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ]
    }
  ],
  "rules": {
    "file/max-lines": {
      "severity": "error",
      "options": {
        "max": 5
      }
    }
  }
}
`,
			".claude/skills/fixture-alpha/SKILL.md": grown,
			// Written when the file was shorter, so the digits in the real message are NOT the
			// digits this entry was created from — which is exactly what `#` buys.
			[BASELINE_FILENAME]: baselineJson({
				".claude/skills/fixture-alpha/SKILL.md": {
					"file/max-lines": {
						"File has # lines, over the limit of # (the whole file, frontmatter included)": 1,
					},
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
			expect(result.stderr).toBe(
				"skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n",
			);
		},
	);
});

test("baseline: a warn diagnostic is suppressed like an error (the exit code cannot show it, so stdout does)", async () => {
	const long = `---\nname: fixture-alpha\ndescription: A fixture skill for the baseline tests.\n---\n${"\nBody.".repeat(
		8,
	)}\n`;
	const files: Readonly<Record<string, string>> = {
		"skillslurp.json": `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ]
    }
  ],
  "rules": {
    "file/max-lines": {
      "severity": "warn",
      "options": {
        "max": 5
      }
    }
  }
}
`,
		".claude/skills/fixture-alpha/SKILL.md": long,
	};
	// Control first: without a baseline the warning IS reported (and still exits 0), which is
	// what makes the assertion below about suppression rather than about severity.
	await withRepo("baseline-warn-control", files, async (dir) => {
		const result = await runCli({ path: dir, reporter: "json", color: false });
		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(
			parseReport(result.stdout).diagnostics.map((d) => d.severity),
		).toEqual(["warn"]);
	});
	await withRepo(
		"baseline-warn",
		{
			...files,
			[BASELINE_FILENAME]: baselineJson({
				".claude/skills/fixture-alpha/SKILL.md": {
					"file/max-lines": {
						"File has # lines, over the limit of # (the whole file, frontmatter included)": 1,
					},
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});
			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
		},
	);
});

test("baseline: malformed JSON stops the run at exit 2 with its own message, empty stdout", async () => {
	await withRepo(
		"baseline-malformed",
		{ ...PATHS_FIXTURE, [BASELINE_FILENAME]: "{ not json\n" },
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_ERROR);
			expect(result.stdout).toBe("");
			// The MESSAGE, not just the exit code: loading the baseline inside `runEngine` would
			// also exit 2, but through a rule-crash wrapper that blames the engine for a typo in
			// a JSON file. The repo-relative name, never an absolute path.
			expect(
				result.stderr.startsWith(
					'"skillslurp-baseline.json" is not valid JSON: ',
				),
			).toBe(true);
			expect(result.stderr).not.toContain(dir);
		},
	);
});

test("baseline: a schema violation exits 2 with the offending JSON path", async () => {
	const cases: readonly (readonly [string, string, string])[] = [
		[
			"version",
			`{ "version": 2, "files": {} }\n`,
			'invalid "skillslurp-baseline.json": version: ',
		],
		[
			"unknown-key",
			`{ "version": 1, "files": {}, "extra": true }\n`,
			'invalid "skillslurp-baseline.json": Unrecognized key: "extra"',
		],
		[
			"zero-count",
			`{ "version": 1, "files": { "a.md": { "r/x": { "m": 0 } } } }\n`,
			'invalid "skillslurp-baseline.json": files["a.md"]["r/x"]["m"]: ',
		],
		[
			"fractional-count",
			`{ "version": 1, "files": { "a.md": { "r/x": { "m": 1.5 } } } }\n`,
			'invalid "skillslurp-baseline.json": files["a.md"]["r/x"]["m"]: ',
		],
	];
	for (const [name, content, expected] of cases) {
		await withRepo(
			`baseline-schema-${name}`,
			{ ...PATHS_FIXTURE, [BASELINE_FILENAME]: content },
			async (dir) => {
				const result = await runCli({
					path: dir,
					reporter: "stylish",
					color: false,
				});
				expect([name, result.exitCode]).toEqual([name, EXIT_ERROR]);
				expect([name, result.stdout]).toEqual([name, ""]);
				expect([name, result.stderr.startsWith(expected)]).toEqual([
					name,
					true,
				]);
			},
		);
	}
});

/**
 * A config with `refs/no-dangling-paths` on, so every literal the baseline file
 * carries has a rule looking for it.
 */
const SCAN_CONFIG = `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ]
    }
  ],
  "rules": {
    "refs/no-dangling-paths": "error"
  }
}
`;

test("baseline: the baseline file is not a scan target, so its own message keys are not re-reported", async () => {
	const notes = "See .claude/skills/gone/SKILL.md here.\n";
	await withRepo(
		"baseline-corpus",
		{
			"skillslurp.json": SCAN_CONFIG,
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"notes.md": notes,
			// The entry matches a real diagnostic, so nothing here is stale: any diagnostic on
			// `skillslurp-baseline.json` in this run could only have come from scanning the
			// baseline file itself.
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": {
					"refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 },
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(parseReport(result.stdout).diagnostics).toEqual([]);
			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stderr).toBe(
				"skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n",
			);
		},
	);
});

// The exclusion is unconditional, not "when the file exists"
test("baseline: a repo whose only dangling-path carrier would be an ABSENT baseline file runs clean", async () => {
	await withRepo(
		"baseline-corpus-absent",
		{
			"skillslurp.json": SCAN_CONFIG,
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"notes.md": "Nothing dangling here.\n",
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			// `CorpusScope.baselineFile` names a path that is not there; excluding it must cost
			// nothing and crash nothing (no stat, no ENOENT), and no notice may appear.
			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
			expect(result.stderr).toBe("");
		},
	);
});

test("baseline: a config/* diagnostic found while linting is baselinable like any other", async () => {
	const staleAllowlist =
		'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/never-mentioned" matched nothing — remove it';
	const files: Readonly<Record<string, string>> = {
		"skillslurp.json": `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ],
      "rules": {
        "refs/no-dangling-paths": {
          "severity": "error",
          "options": {
            "allowlist": [
              ".claude/skills/never-mentioned"
            ]
          }
        }
      }
    }
  ]
}
`,
		".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
	};
	// Control: the unused allowlist entry really is reported as `config/stale-allowlist`.
	await withRepo("baseline-config-control", files, async (dir) => {
		const result = await runCli({ path: dir, reporter: "json", color: false });
		expect(result.exitCode).toBe(EXIT_VIOLATIONS);
		expect(parseReport(result.stdout).diagnostics.map((d) => d.ruleId)).toEqual(
			["config/stale-allowlist"],
		);
	});
	await withRepo(
		"baseline-config",
		{
			...files,
			[BASELINE_FILENAME]: baselineJson({
				"skillslurp.json": {
					"config/stale-allowlist": { [staleAllowlist]: 1 },
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			// One rule, no special cases: a baseline can mute a staleness guard, exactly as
			// PHPStan's can. Recorded knowingly, not discovered later.
			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
		},
	);
});

test("baseline: an entry filed under baseline/stale cannot mute the guard — it is itself stale", async () => {
	await withRepo(
		"baseline-self",
		{
			"skillslurp.json": PATHS_CONFIG,
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			[BASELINE_FILENAME]: baselineJson({
				"skillslurp-baseline.json": {
					"baseline/stale": {
						'Baseline entry for rule "refs/no-dangling-paths" in "notes.md" expects # occurrence(s) but # remain — run `skillslurp --update-baseline` to prune it': 1,
					},
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			// Stale diagnostics are produced after suppression and are never candidates for it,
			// so M is structurally 0 for this key and the entry reports itself.
			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			const report = parseReport(result.stdout);
			expect(report.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
				["baseline/stale", "skillslurp-baseline.json"],
			]);
			expect(report.diagnostics[0]?.message).toContain(
				'Baseline entry for rule "baseline/stale" in "skillslurp-baseline.json"',
			);
		},
	);
});

test("baseline: a zero-config detected run applies the baseline and prints both stderr lines", async () => {
	await withRepo(
		"baseline-detected",
		{
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"notes.md": NOTES_ONCE,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stdout).toBe("");
			// Announcement first, then the notice — the order a reader builds the run's story in.
			expect(result.stderr.startsWith("no skillslurp.json found;")).toBe(true);
			expect(
				result.stderr.endsWith(
					"skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n",
				),
			).toBe(true);
		},
	);
});

test("baseline: two runs over the same repo produce byte-identical stdout and stderr", async () => {
	await withRepo(
		"baseline-determinism",
		{
			...PATHS_FIXTURE,
			[BASELINE_FILENAME]: baselineJson({
				// Two stale entries and one live one, so the ordering of the stale diagnostics is
				// part of what this pins.
				"zzz.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
				"aaa.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 3 } },
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
			}),
		},
		async (dir) => {
			const first = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});
			const second = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
			});

			expect(first.stdout).toBe(second.stdout);
			expect(first.stderr).toBe(second.stderr);
			expect(first.exitCode).toBe(EXIT_VIOLATIONS);
			// aaa.md before zzz.md: the merged list is re-sorted with the engine's own
			// comparator, not appended in the order the file happened to list its keys.
			expect(first.stdout.indexOf('"aaa.md"')).toBeLessThan(
				first.stdout.indexOf('"zzz.md"'),
			);
			expect(first.stderr).toBe(
				"skillslurp-baseline.json: 1 problem(s) suppressed, 2 stale entr(y|ies)\n",
			);
		},
	);
});

// Pins that the merged report is RE-SORTED, not merely concatenated.
// `[...applied.kept, ...applied.stale]` (run.ts) is two separate arrays, and every OTHER fixture
// in this file keeps its kept diagnostics under `.claude/...`, which sorts before
// "skillslurp-baseline.json" bytewise — so plain concatenation happens to read as sorted, and
// removing `.sort(compareDiagnostics)` leaves the rest of this file green. This fixture's kept
// diagnostic lives in "zzz.md", which sorts AFTER "skillslurp-baseline.json", so only an actual
// sort puts the baseline/stale entry first.
test("baseline: a kept diagnostic in a file that sorts after skillslurp-baseline.json still comes after baseline/stale", async () => {
	await withRepo(
		"baseline-sort-order",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
			// Its own tracked file, no baseline entry of its own — `refs/no-dangling-paths` is a
			// scan rule and reports on any tracked file, the same way it already does on
			// "notes.md", so this occurrence is never a suppression candidate and survives kept.
			"zzz.md": NOTES_ONCE,
			[BASELINE_FILENAME]: baselineJson({
				// N = 2 against M = 1: fully suppresses notes.md's one
				// occurrence and stales the excess.
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			const report = parseReport(result.stdout);
			expect(report.diagnostics.map((d) => [d.ruleId, d.file])).toEqual([
				["baseline/stale", "skillslurp-baseline.json"],
				["refs/no-dangling-paths", "zzz.md"],
			]);
		},
	);
});

test("baseline: the json document keeps its shape — summary counts what is reported, no new keys (no `suppressed` count)", async () => {
	await withRepo(
		"baseline-json",
		{
			...PATHS_FIXTURE,
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 1 } },
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			const report = parseReport(result.stdout);
			expect(Object.keys(report)).toEqual([
				"version",
				"summary",
				"diagnostics",
			]);
			expect(Object.keys(report.summary)).toEqual([
				"problems",
				"errors",
				"warnings",
			]);
			// One of the two occurrences was suppressed; `problems` counts what this run
			// reports, and the suppressed count lives on stderr where no machine consumer of
			// the document has to know about it.
			expect(report.summary).toEqual({ problems: 1, errors: 1, warnings: 0 });
			expect(result.stdout).not.toContain("suppressed");
		},
	);
});

// ---------------------------------------------------------------------------
// `--diff-base <ref>` at the CLI layer: the stderr notice, the baseline
// interaction, and the failure modes a user can actually type.
// ---------------------------------------------------------------------------

/** A second skill, so a `--diff-base` fixture can change one document and leave another alone. */
const BETA_SKILL =
	"---\nname: fixture-beta\ndescription: A second fixture skill for the diff-base tests.\n---\n\nBody.\n";

const BETA_SKILL_EDITED =
	"---\nname: fixture-beta\ndescription: A second fixture skill for the diff-base tests.\n---\n\nEdited body.\n";

test("diff-base: an unknown ref stops the run at exit 2, names the ref on stderr, and writes nothing to stdout", async () => {
	await withRepo(
		"diff-unknown-ref",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: "no-such-ref",
			});

			expect(result.exitCode).toBe(EXIT_ERROR);
			expect(result.stdout).toBe("");
			// git's own error, kept whole: it names the ref in the range it could not resolve and
			// carries git's `fatal: bad revision ...` as the cause.
			expect(result.stderr).toContain("no-such-ref");
			expect(result.stderr).toContain("bad revision");
		},
	);
});

// The premise — "a shallow checkout has no merge base" — is a DEDUCTION from two vendor
// sentences (git's `A...B` is `merge-base A B` plus actions/checkout's "Only a single commit is
// fetched by default"), not a vendor sentence itself, so it is measured here rather than
// asserted. Measured first: the naive recipe, `git clone --depth 1
// file://<repo>` followed by `--diff-base main`, produces NO error at all — `main` and `HEAD` are
// the same grafted commit, so the merge base is that commit and the diff is empty. What really
// reproduces it is the shape CI actually has: a shallow checkout of the PR branch plus a
// shallowly fetched base branch, whose two grafted commits share no ancestor.
test("diff-base: a shallow clone whose base branch shares no ancestor with HEAD exits 2 with the fetch-depth advice, and git's own wording is pinned", async () => {
	const parent = await mkdtemp(join(tmpdir(), "skillslurp-diff-shallow-"));
	try {
		const origin = join(parent, "origin");
		await writeFiles(origin, {
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
		});
		await gitInitAndCommit(origin);
		await git(origin, ["checkout", "--quiet", "-b", "feature"]);
		await writeFiles(origin, {
			".claude/skills/fixture-beta/SKILL.md": BETA_SKILL,
		});
		await commitAll(origin, "feature commit");
		await git(origin, ["checkout", "--quiet", "main"]);
		await writeFiles(origin, { "extra.md": "# Extra\n" });
		await commitAll(origin, "main moves on");

		const clone = join(parent, "clone");
		await git(parent, [
			"clone",
			"--quiet",
			"--depth",
			"1",
			"--no-single-branch",
			"--branch",
			"feature",
			`file://${origin}`,
			clone,
		]);

		// The vendor fact this feature's error message is built on, measured rather than
		// believed. git 2.54.0 on 2026-09-06 printed exactly this, at exit 128 — `engine.ts`'s
		// `NO_MERGE_BASE_STDERR` is the trailing fragment of it.
		let gitStderr: unknown;
		try {
			await git(clone, [
				"diff",
				"--name-status",
				"--relative",
				"-z",
				"origin/main...HEAD",
				"--",
			]);
		} catch (err) {
			gitStderr = err instanceof Error ? err.cause : err;
		}
		expect(gitStderr).toBe("fatal: origin/main...HEAD: no merge base");

		const result = await runCli({
			path: clone,
			reporter: "stylish",
			color: false,
			diffBase: "origin/main",
		});

		expect(result.exitCode).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			'no merge base between "origin/main" and HEAD — in GitHub Actions, actions/checkout fetches one commit by default; set fetch-depth: 0\n',
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("diff-base: an empty ref and a ref shaped like an option are both refused at exit 2, with assertSafeRevision's own messages", async () => {
	await withRepo(
		"diff-unsafe-ref",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
		},
		async (dir) => {
			const empty = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: "",
			});
			expect(empty.exitCode).toBe(EXIT_ERROR);
			expect(empty.stdout).toBe("");
			expect(empty.stderr).toBe(
				'git base revision must not be empty — an empty string is silently read as "HEAD...HEAD" (no changes), not as an error\n',
			);

			const option = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: "-x",
			});
			expect(option.exitCode).toBe(EXIT_ERROR);
			expect(option.stdout).toBe("");
			expect(option.stderr).toBe(
				'git base revision "-x" must not start with "-" — it would be parsed by git as an option, not a revision\n',
			);
		},
	);
});

test("diff-base: the baseline still suppresses, but an entry the repository has outgrown is NOT reported stale — and the notice says so", async () => {
	await withDiffRepo(
		"diff-baseline",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
			// N = 2 against the M = 1 this repo produces: stale on a full run.
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
			}),
		},
		{ ".claude/skills/fixture-alpha/SKILL.md": `${ALPHA_SKILL}\nEdited.\n` },
		async (dir, base) => {
			// The control: the same baseline over the same repo IS stale without the option.
			const full = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});
			expect(parseReport(full.stdout).diagnostics.map((d) => d.ruleId)).toEqual(
				["baseline/stale"],
			);

			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				diffBase: base,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
			expect(result.stderr).toBe(
				`skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n--diff-base ${base}: file rules limited to 1 changed document(s); project, scan and shape rules ran in full; baseline staleness not checked\n`,
			);
		},
	);
});

// A REGRESSION PIN, and honest about being one: it was predicted that computing
// the changed set before `resolveEnabledBySurface` would break this case, and it does not —
// measured 2026-09-06, that mutation fails no test at all. It cannot: `config/no-files` is raised
// inside `discoverFiles`, which `runEngine` calls before any of this option's code runs, so no
// ordering *within* the option can reach it. What this case does guard is the implementation
// nobody wrote but somebody might: narrowing the option by filtering discovery's own input, which
// would turn every unchanged surface into an exit-2 config error.
test("diff-base: a surface whose only document is unchanged is not a config/no-files error — discovery is judged before the filter", async () => {
	await withDiffRepo(
		"diff-no-files",
		{
			...PATHS_FIXTURE,
			"notes.md": "# Notes\n\nNothing dangling here.\n",
		},
		{ "notes.md": "# Notes\n\nStill nothing dangling.\n" },
		async (dir, base) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				diffBase: base,
			});

			// Exit 0, not 2: `.claude/skills` matched a file, and that verdict has nothing to do
			// with whether the file was committed in this range.
			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
			expect(result.stderr).toBe(
				`--diff-base ${base}: file rules limited to 0 changed document(s); project, scan and shape rules ran in full\n`,
			);
		},
	);
});

// A shape rule is never narrowed either: `hub/symlinks` judges a spoke no changed document touches.
test("diff-base: a shape rule runs in full — hub/symlinks still reports a spoke that no changed document touches", async () => {
	await withDiffRepo(
		"diff-hub-symlinks",
		{
			".agents/skills/demo/SKILL.md": ALPHA_SKILL,
			"skillslurp.json": `${JSON.stringify({
				version: 1,
				extends: [],
				surfaces: [{ root: ".agents/skills", spokes: [".claude/skills"] }],
				rules: { "hub/symlinks": "error" },
			})}\n`,
		},
		{ "notes.txt": "unrelated\n" },
		async (dir, base) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				diffBase: base,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			expect(
				parseReport(result.stdout).diagnostics.map((d) => [d.ruleId, d.file]),
			).toEqual([["hub/symlinks", ".claude/skills"]]);
			expect(result.stderr).toBe(
				`--diff-base ${base}: file rules limited to 0 changed document(s); project, scan and shape rules ran in full\n`,
			);
		},
	);
});

test("diff-base: a zero-config detected run carries both stderr lines, the announcement first", async () => {
	await withDiffRepo(
		"diff-zero-config",
		{
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			".claude/skills/fixture-beta/SKILL.md": BETA_SKILL,
		},
		{ ".claude/skills/fixture-beta/SKILL.md": BETA_SKILL_EDITED },
		async (dir, base) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: base,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .claude/skills (skills, claude-code)
using rules from extends: ["recommended"] (the built-in default).
create skillslurp.json to choose surfaces, rules and severities.
--diff-base ${base}: file rules limited to 1 changed document(s); project, scan and shape rules ran in full\n`,
			);
		},
	);
});

test("diff-base: a directory that is not a checkout still stops with the one sentence naming the path and the requirement, at exit 2", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-diff-nogit-"));
	try {
		await writeFiles(dir, {
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
		});
		const real = await realpath(dir);

		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
			diffBase: "main",
		});

		expect(result.exitCode).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		// Byte-identical to the message a run without the option produces (see the
		// "not a checkout" test above): `--diff-base` moves the FIRST git call earlier in the
		// run, and this is what keeps that from changing what the user is told.
		expect(result.stderr).toBe(
			`"${real}" is not a git checkout — skillslurp resolves link targets against git's index, so the path it lints must be inside a git repository\n`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("diff-base: two runs over the same repo produce byte-identical stdout and stderr", async () => {
	await withDiffRepo(
		"diff-determinism",
		{
			...PATHS_FIXTURE,
			".claude/skills/fixture-beta/SKILL.md": BETA_SKILL,
		},
		{ ".claude/skills/fixture-beta/SKILL.md": BETA_SKILL_EDITED },
		async (dir, base) => {
			const first = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: base,
			});
			const second = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				diffBase: base,
			});

			expect(first.exitCode).toBe(EXIT_VIOLATIONS);
			expect(second).toEqual(first);
		},
	);
});

// The stderr NOTICES, not just `formatError`, now go through
// `sanitizeControlChars`. `formatDiffBaseNotice` interpolates `options.diffBase` verbatim, and a
// `:/<text>` search revision lets the caller choose that string's own bytes — including a raw
// ESC, which used to reach stderr unescaped (measured with `cat -v` before this fix).
test("diff-base: a `:/` search revision carrying a raw control character reaches stderr escaped, not verbatim", async () => {
	await withRepo(
		"diff-base-control-chars",
		{ ...PATHS_FIXTURE, "notes.md": "# Notes\n\nNothing dangling here.\n" },
		async (dir) => {
			// The commit message is the one place this fixture can plant a byte the CLI would
			// never otherwise accept straight from a caller — `:/<text>` resolves a revision by
			// searching commit messages, so the search STRING (what becomes `options.diffBase`)
			// and the message it has to match both carry the same raw ESC.
			await writeFile(
				join(dir, "notes.md"),
				"# Notes\n\nEdited once.\n",
				"utf8",
			);
			await commitAll(dir, "evil\x1bRED");
			await writeFile(
				join(dir, "notes.md"),
				"# Notes\n\nEdited twice.\n",
				"utf8",
			);
			await commitAll(dir, "third commit");

			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				diffBase: ":/evil\x1bRED",
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			// The raw byte never reaches stderr...
			expect(result.stderr).not.toContain("\x1b");
			// ...it leaves through the same escaping `formatError` already used — text.ts's own
			// spelling for code point 0x1b.
			expect(result.stderr).toContain("\\u{1b}");
			expect(result.stderr).toContain(":/evil");
		},
	);
});

test("diff-base: a legacy ##[ command in a `:/` search revision reaches stderr neutralized", async () => {
	await withRepo(
		"diff-base-legacy-command",
		{ ...PATHS_FIXTURE, "notes.md": "# Notes\n\nNothing dangling here.\n" },
		async (dir) => {
			await writeFile(
				join(dir, "notes.md"),
				"# Notes\n\nEdited once.\n",
				"utf8",
			);
			// `:/` is a regex search, so `##[w]arning` matches this message while carrying `##[` itself.
			await commitAll(dir, "evil ##warning");
			await writeFile(
				join(dir, "notes.md"),
				"# Notes\n\nEdited twice.\n",
				"utf8",
			);
			await commitAll(dir, "third commit");

			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				diffBase: ":/evil ##[w]arning",
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stderr).not.toContain("##[");
			expect(result.stderr).toContain(":/evil #\\u{23}[w]arning");
		},
	);
});

// ---------------------------------------------------------------------------
// `--update-baseline`: what goes into the file, what goes to stdout and
// stderr, and the combinations that are refused before any of it happens.
// ---------------------------------------------------------------------------

/** True iff `path` is on disk. The cases below assert absence as often as presence. */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The empty baseline, measured rather than assumed: `serializeBaseline` is hand-written (see its
 * JSDoc — `JSON.stringify(obj, null, 2)` reorders integer-like keys and would silently overrule
 * the bytewise sort), so the file's exact shape is a fact about that function, not about JSON.
 */
const EMPTY_BASELINE = '{\n  "version": 1,\n  "files": {}\n}\n';

/** `skill/frontmatter-schema` under the `generic` contract, which requires `description`. */
const MISSING_DESCRIPTION_MESSAGE =
	'Missing required frontmatter key "description"';

/** A second dangling path, so a fixture can carry two different messages in two different files. */
const OTHER_DANGLING_MESSAGE =
	'Path ".claude/skills/vanished/SKILL.md" does not exist or is not tracked by git';

/**
 * `refs/no-dangling-paths` AND `skill/frontmatter-schema`, both at error, so one fixture carries
 * two rules. No `dialects:` key, deliberately: the surface then gets the `generic` contract, the
 * one that requires `description` — `claude-code`'s contract requires nothing at all, so a skill
 * missing its description is valid there (see dialects.ts) and this fixture would quietly have
 * only one rule in it.
 */
const UPDATE_CONFIG = `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills"
    }
  ],
  "rules": {
    "refs/no-dangling-paths": "error",
    "skill/frontmatter-schema": "error"
  }
}
`;

/** Missing `description`, which the claude-code contract requires: one error at 1:1. */
const BROKEN_SKILL = "---\nname: fixture-broken\n---\n\nBody.\n";

/**
 * Several files, several rules and one message that occurs twice — the shape the file format
 * exists for (a count, and three levels of sorting).
 */
const UPDATE_FIXTURE: Readonly<Record<string, string>> = {
	"skillslurp.json": UPDATE_CONFIG,
	".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
	".claude/skills/fixture-broken/SKILL.md": BROKEN_SKILL,
	"notes.md": NOTES_TWICE,
	"docs/guide.md":
		"# Guide\n\nSee .claude/skills/vanished/SKILL.md for details.\n",
};

test("update-baseline: the regenerated file is byte-pinned — sorted, counted, newline-terminated — and the run exits 0 with an empty report", async () => {
	await withRepo("update-basic", UPDATE_FIXTURE, async (dir) => {
		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
			updateBaseline: true,
		});

		expect(result.exitCode).toBe(EXIT_CLEAN);
		// Everything the run found went into the file, so there is nothing left to report.
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"wrote skillslurp-baseline.json: 4 problem(s) in 3 file(s) (4 errors, 0 warnings)\n",
		);
		// `config.root`, not the caller's `path`: the write target is canonical, so a root
		// reached through a symlink (macOS's `/tmp` -> `/private/tmp` is enough) still names one
		// file rather than two spellings of it.
		expect(result.baseline?.path).toBe(
			join(await realpath(dir), BASELINE_FILENAME),
		);
		// `runCli` returned the file; it did not write it. The whole reason the write lives in
		// `cli.ts` is that this function stays a pure "what should this invocation print and
		// exit with" — `run.test.ts` calls it a hundred times and touches nothing.
		expect(await exists(join(dir, BASELINE_FILENAME))).toBe(false);
		// Byte-pinned, not parsed: the sort at all three levels, the two-space indent and the
		// trailing newline are the file's contract with git — a reordering nobody asked for is a
		// diff on every machine that regenerates it.
		expect(result.baseline?.content).toBe(`{
  "version": 1,
  "files": {
    ".claude/skills/fixture-broken/SKILL.md": {
      "skill/frontmatter-schema": {
        ${JSON.stringify(MISSING_DESCRIPTION_MESSAGE)}: 1
      }
    },
    "docs/guide.md": {
      "refs/no-dangling-paths": {
        ${JSON.stringify(OTHER_DANGLING_MESSAGE)}: 1
      }
    },
    "notes.md": {
      "refs/no-dangling-paths": {
        ${JSON.stringify(DANGLING_MESSAGE)}: 2
      }
    }
  }
}
`);
	});
});

test("update-baseline: regenerating over a file this feature itself wrote produces identical bytes and an identical notice", async () => {
	await withRepo("update-twice", UPDATE_FIXTURE, async (dir) => {
		const options = {
			path: dir,
			reporter: "stylish" as const,
			color: false,
			updateBaseline: true,
		};

		const first = await runCli(options);
		// Written AND committed, which is what a user does with this file. Both halves matter:
		// the second run is then a regeneration over an existing file rather than a repeat of
		// the same first-time write, and — because the scan corpus is git's tracked set — the
		// committed file is now a real candidate for `refs/no-dangling-paths`, whose message
		// keys it is full of. Only the baseline's corpus exclusion keeps the two runs identical.
		await writeFile(
			join(dir, BASELINE_FILENAME),
			first.baseline?.content ?? "",
		);
		await commitAll(dir, "commit the baseline");
		const second = await runCli(options);

		expect(second.baseline?.content).toBe(first.baseline?.content);
		expect(second.stderr).toBe(first.stderr);
		expect(second.stdout).toBe(first.stdout);
		expect(second.exitCode).toBe(first.exitCode);
	});
});

// The serializer pretty-prints at two spaces, so the empty baseline is the pretty form, not
// `{"version":1,"files":{}}\n`. Measured, then pinned.
test("update-baseline: a repository with nothing to report still writes the empty baseline", async () => {
	await withRepo(
		"update-clean",
		{
			"skillslurp.json": UPDATE_CONFIG,
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				updateBaseline: true,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				"wrote skillslurp-baseline.json: 0 problem(s) in 0 file(s) (0 errors, 0 warnings)\n",
			);
			// A user who typed the flag asked for the file: an empty baseline is a committed
			// statement that the repository is clean, not a no-op.
			expect(result.baseline?.content).toBe(EMPTY_BASELINE);
		},
	);
});

test("update-baseline: an entry the repository has outgrown is gone from the regenerated file — this regenerates, it does not merge", async () => {
	await withRepo(
		"update-regenerate",
		{
			...PATHS_FIXTURE,
			"notes.md": NOTES_ONCE,
			// Two entries a merging implementation would carry forward: a count of 2 where the
			// repository now produces 1, and a whole file that no longer reports anything.
			[BASELINE_FILENAME]: baselineJson({
				"notes.md": { "refs/no-dangling-paths": { [DANGLING_MESSAGE]: 2 } },
				"deleted.md": {
					"refs/no-dangling-paths": { [OTHER_DANGLING_MESSAGE]: 1 },
				},
			}),
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				updateBaseline: true,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.baseline?.content).toBe(`{
  "version": 1,
  "files": {
    "notes.md": {
      "refs/no-dangling-paths": {
        ${JSON.stringify(DANGLING_MESSAGE)}: 1
      }
    }
  }
}
`);
			expect(result.baseline?.content).not.toContain("deleted.md");
		},
	);
});

test("update-baseline: one violation reported by a scan rule on two surfaces is counted once — the engine's dedupe, seen from outside", async () => {
	await withRepo(
		"update-dedupe",
		{
			"skillslurp.json": `{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills",
      "dialects": [
        "claude-code"
      ]
    },
    {
      "root": "docs/skills",
      "dialects": [
        "claude-code"
      ]
    }
  ],
  "rules": {
    "refs/no-dangling-paths": "error"
  }
}
`,
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"docs/skills/fixture-gamma/SKILL.md":
				"---\nname: fixture-gamma\ndescription: A third fixture skill, on the second surface.\n---\n\nBody.\n",
			"notes.md": NOTES_ONCE,
		},
		async (dir) => {
			// The control: the run really does enable the rule on both surfaces, so a count of 1
			// below is `dedupeDiagnostics` doing its job rather than the second surface being
			// silently absent.
			const plain = await runCli({ path: dir, reporter: "json", color: false });
			expect(parseReport(plain.stdout).summary.problems).toBe(1);

			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				updateBaseline: true,
			});

			expect(result.baseline?.content).toContain(
				`${JSON.stringify(DANGLING_MESSAGE)}: 1`,
			);
		},
	);
});

test("update-baseline: warnings are baselined too, and counted separately in the notice", async () => {
	await withRepo(
		"update-warn",
		{
			...PATHS_FIXTURE,
			"skillslurp.json": PATHS_CONFIG.replace(
				'"refs/no-dangling-paths": "error"',
				'"refs/no-dangling-paths": "warn"',
			),
			"notes.md": NOTES_ONCE,
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				updateBaseline: true,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stderr).toBe(
				"wrote skillslurp-baseline.json: 1 problem(s) in 1 file(s) (0 errors, 1 warnings)\n",
			);
			expect(result.baseline?.content).toContain(
				`${JSON.stringify(DANGLING_MESSAGE)}: 1`,
			);
		},
	);
});

// The CLI refuses the pair before the run starts (cli.test.ts); this is
// the guard behind that check, for a programmatic caller that never went through citty.
test("update-baseline: combined with diffBase, runCli refuses at exit 2 and returns no file", async () => {
	await withRepo("update-diff-guard", PATHS_FIXTURE, async (dir) => {
		const result = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
			updateBaseline: true,
			diffBase: "HEAD",
		});

		expect(result.exitCode).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"internal error: --update-baseline cannot be combined with --diff-base — a baseline records what a full run found\n",
		);
		expect(result.baseline).toBeUndefined();
		expect(await exists(join(dir, BASELINE_FILENAME))).toBe(false);
	});
});

// The absence assertion is honest about what it can and cannot catch: MEASURED
// 2026-09-06, moving the write from `cli.ts` into `runCli` does not fail this case and cannot,
// because a config error aborts before the engine — and therefore before any write — ever runs.
// The regeneration test above catches that mutation. What this one guards is the other direction:
// that a run which exits 2 without linting anything does not leave a baseline behind.
test("update-baseline: a config error exits 2, reports as usual and produces no baseline — not even an empty one", async () => {
	await withRepo(
		"update-config-error",
		{
			"skillslurp.json": '{"version":1,"rulez":{},"surfaces":[]}\n',
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
				updateBaseline: true,
			});

			expect(result.exitCode).toBe(EXIT_ERROR);
			const diagnostics = parseReport(result.stdout).diagnostics;
			expect(diagnostics.length).toBeGreaterThan(0);
			expect(diagnostics.every((d) => d.ruleId === "config/invalid")).toBe(
				true,
			);
			expect(result.baseline).toBeUndefined();
			expect(await exists(join(dir, BASELINE_FILENAME))).toBe(false);
		},
	);
});

test("update-baseline: the round trip — regenerate, then a plain run is clean with everything suppressed and nothing stale", async () => {
	await withRepo("update-round-trip", UPDATE_FIXTURE, async (dir) => {
		const update = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
			updateBaseline: true,
		});
		await writeFile(
			join(dir, BASELINE_FILENAME),
			update.baseline?.content ?? "",
		);

		const plain = await runCli({
			path: dir,
			reporter: "stylish",
			color: false,
		});

		expect(plain.exitCode).toBe(EXIT_CLEAN);
		expect(plain.stdout).toBe("");
		expect(plain.stderr).toBe(
			"skillslurp-baseline.json: 4 problem(s) suppressed, 0 stale entr(y|ies)\n",
		);
	});
});

test("update-baseline: the json reporter emits its zero-summary document, and the file is produced all the same", async () => {
	await withRepo("update-json", UPDATE_FIXTURE, async (dir) => {
		const result = await runCli({
			path: dir,
			reporter: "json",
			color: false,
			updateBaseline: true,
		});

		expect(result.exitCode).toBe(EXIT_CLEAN);
		expect(result.stdout).toBe(
			'{"version":1,"summary":{"problems":0,"errors":0,"warnings":0},"diagnostics":[]}\n',
		);
		expect(result.baseline?.content).toContain('"notes.md"');
	});
});

test("update-baseline: a zero-config detected run announces detection first, then the wrote-line", async () => {
	await withRepo(
		"update-zero-config",
		{
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			".claude/skills/fixture-beta/SKILL.md": BETA_SKILL,
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "stylish",
				color: false,
				updateBaseline: true,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .claude/skills (skills, claude-code)
using rules from extends: ["recommended"] (the built-in default).
create skillslurp.json to choose surfaces, rules and severities.
wrote skillslurp-baseline.json: 0 problem(s) in 0 file(s) (0 errors, 0 warnings)\n`,
			);
			expect(result.baseline?.content).toBe(EMPTY_BASELINE);
		},
	);
});

/** A skill carrying a key no dialect allows, so that a diagnostic names the skill's own file. */
const VERSIONED_SKILL =
	"---\nname: fixture-alpha\ndescription: A fixture skill for the detected-spoke tests.\nversion: 1\n---\n\nBody.\n";

const SPOKE_ANNOUNCEMENT_TAIL =
	'using rules from extends: ["recommended"] (the built-in default).\ncreate skillslurp.json to choose surfaces, rules and severities.\n';

test("zero-config: a symlinked hub is announced as the real directory with the links as its spokes, and diagnostics keep their paths", async () => {
	await withLinkedRepo(
		"detect-spokes-s",
		{
			".agents/skills/fixture-alpha/SKILL.md": VERSIONED_SKILL,
			"notes.md":
				"See .agents/skills/fixture-alpha/gone.md and .claude/skills/fixture-alpha/gone2.md\n",
		},
		{ ".claude/skills": "../.agents/skills" },
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .agents/skills (skills, claude-code, generic; spokes: .claude/skills)
${SPOKE_ANNOUNCEMENT_TAIL}`,
			);
			expect(
				parseReport(result.stdout).diagnostics.map((d) => [
					d.ruleId,
					d.file,
					d.message,
				]),
			).toEqual([
				[
					"skill/frontmatter-schema",
					".agents/skills/fixture-alpha/SKILL.md",
					expect.stringContaining('Unexpected frontmatter key "version"'),
				],
				[
					"refs/no-dangling-paths",
					"notes.md",
					'Path ".agents/skills/fixture-alpha/gone.md" does not exist or is not tracked by git',
				],
				[
					"refs/no-dangling-paths",
					"notes.md",
					'Path ".claude/skills/fixture-alpha/gone2.md" does not exist or is not tracked by git',
				],
			]);
		},
	);
});

test("zero-config: a link later in the table is a spoke, and a dangling mention through it is reported", async () => {
	await withLinkedRepo(
		"detect-spokes-r",
		{
			".claude/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"notes.md": "See .agents/skills/fixture-alpha/a.md\n",
		},
		{ ".agents/skills": "../.claude/skills" },
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .claude/skills (skills, claude-code, generic; spokes: .agents/skills)
${SPOKE_ANNOUNCEMENT_TAIL}`,
			);
			expect(
				parseReport(result.stdout).diagnostics.map((d) => [
					d.ruleId,
					d.file,
					d.message,
				]),
			).toEqual([
				[
					"refs/no-dangling-paths",
					"notes.md",
					'Path ".agents/skills/fixture-alpha/a.md" does not exist or is not tracked by git',
				],
			]);
		},
	);
});

test("zero-config: every link to the real directory is a spoke, in table order, and a mention through the last one is checked", async () => {
	await withLinkedRepo(
		"detect-spokes-three",
		{
			".agents/skills/fixture-alpha/SKILL.md": ALPHA_SKILL,
			"notes.md":
				"See .cursor/skills/fixture-alpha/c.md and .cursor/skills/fixture-alpha/SKILL.md\n",
		},
		{
			".cursor/skills": "../.agents/skills",
			".claude/skills": "../.agents/skills",
		},
		async (dir) => {
			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_VIOLATIONS);
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .agents/skills (skills, claude-code, generic, cursor; spokes: .claude/skills, .cursor/skills)
${SPOKE_ANNOUNCEMENT_TAIL}`,
			);
			expect(
				parseReport(result.stdout).diagnostics.map((d) => [
					d.ruleId,
					d.message,
				]),
			).toEqual([
				[
					"refs/no-dangling-paths",
					'Path ".cursor/skills/fixture-alpha/c.md" does not exist or is not tracked by git',
				],
			]);
		},
	);
});

test("zero-config: a link that exists only on this machine is a spoke nobody checks as a symlink", async () => {
	await withRepo(
		"detect-spokes-local",
		{ ".agents/skills/fixture-alpha/SKILL.md": ALPHA_SKILL },
		async (dir) => {
			await writeLinks(dir, { ".claude/skills": "../.agents/skills" });

			const result = await runCli({
				path: dir,
				reporter: "json",
				color: false,
			});

			expect(result.exitCode).toBe(EXIT_CLEAN);
			expect(result.stderr).toBe(
				`no skillslurp.json found; linting auto-detected surfaces:
  .agents/skills (skills, claude-code, generic; spokes: .claude/skills)
${SPOKE_ANNOUNCEMENT_TAIL}`,
			);
			expect(parseReport(result.stdout).diagnostics).toEqual([]);
		},
	);
});
