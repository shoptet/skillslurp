import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
	execFile as execFileCb,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import { existsSync, constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	chmod,
	open as fsOpen,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { EXIT_CLEAN, EXIT_ERROR, EXIT_VIOLATIONS } from "./exit.js";
import { runGit } from "./git.js";
import { builtinRules } from "./rules/index.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

// Every test here spawns the CLI, several of them more than once; bun's 5 s default flaked on a loaded host.
setDefaultTimeout(30000);

// Anchored to this module's own location, not process.cwd() — see discover.test.ts for the
// same rationale. import.meta.url is standard ESM, not Bun-only.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_REPO = fileURLToPath(
	new URL("../test/fixtures/skills-repo", import.meta.url),
);
const CLEAN_REPO = fileURLToPath(
	new URL("../test/fixtures/clean-repo", import.meta.url),
);
const BAD_CONFIG = fileURLToPath(
	new URL("../test/fixtures/bad-config", import.meta.url),
);
// Fixtures: the first three carry no config file at all and exercise zero-config
// auto-detection (detect.ts); the last four each pin one rule that no other fixture reaches.
const ZERO_CONFIG_CLAUDE = fileURLToPath(
	new URL("../test/fixtures/zero-config-claude", import.meta.url),
);
const ZERO_CONFIG_AGENTS = fileURLToPath(
	new URL("../test/fixtures/zero-config-agents", import.meta.url),
);
const ZERO_CONFIG_EMPTY = fileURLToPath(
	new URL("../test/fixtures/zero-config-empty", import.meta.url),
);
const MULTI_DIALECT_REPO = fileURLToPath(
	new URL("../test/fixtures/multi-dialect-repo", import.meta.url),
);
const RULES_REPO = fileURLToPath(
	new URL("../test/fixtures/rules-repo", import.meta.url),
);
const LINKS_REPO = fileURLToPath(
	new URL("../test/fixtures/links-repo", import.meta.url),
);
const MAX_LINES_REPO = fileURLToPath(
	new URL("../test/fixtures/max-lines-repo", import.meta.url),
);
// Deliberately does not exist on disk; only the path string is needed.
const NONEXISTENT = fileURLToPath(
	new URL("../test/fixtures/does-not-exist", import.meta.url),
);

interface Runner {
	name: string;
	run(args: readonly string[]): SpawnSyncReturns<string>;
}

// Both variants must agree: the bundled dist/cli.js (built once in beforeAll, below) is what
// actually ships, but `bun src/cli.ts` is what every other test in this repo invokes directly.
// cwd is pinned to the repo root so the relative `src/cli.ts` / `dist/cli.js` entry points
// resolve regardless of where `bun test` itself is invoked from.
const runners: readonly Runner[] = [
	{
		name: "bun src/cli.ts",
		run: (args) =>
			spawnSync("bun", ["src/cli.ts", ...args], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			}),
	},
	{
		name: "node dist/cli.js",
		run: (args) =>
			spawnSync("node", ["dist/cli.js", ...args], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			}),
	},
];

beforeAll(() => {
	const build = spawnSync("bun", ["run", "build"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (build.status !== 0) {
		throw new Error(
			`bun run build failed (status ${String(build.status)}):\n${build.stderr}`,
		);
	}
});

// Pinned byte-for-byte: stdout is piped, never a TTY, so the CLI's color decision is
// deterministically off without needing NO_COLOR. This also asserts a real violation, correct
// position, exit code 1, for the skills-repo fixture as a whole, not just its unknown-key file.
const EXPECTED_SKILLS_REPO_STYLISH = `.claude/skills/broken-yaml/SKILL.md
  3:1  error  Flow sequence in block collection must be sufficiently indented and end with a ]  parse/frontmatter

.claude/skills/empty-name/SKILL.md
  2:7  error  Frontmatter key "name" must not be empty  skill/frontmatter-schema

.claude/skills/missing-description/SKILL.md
  1:1  error  Missing required frontmatter key "description"  skill/frontmatter-schema

.claude/skills/no-frontmatter/SKILL.md
  1:1  error  Missing YAML frontmatter block  skill/frontmatter-schema

.claude/skills/unknown-key/SKILL.md
  4:1  error  Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)  skill/frontmatter-schema

✖ 5 problems (5 errors, 0 warnings)
`;

const EXPECTED_JSON_RULE_IDS = [
	"parse/frontmatter",
	"skill/frontmatter-schema",
	"skill/frontmatter-schema",
	"skill/frontmatter-schema",
	"skill/frontmatter-schema",
].sort();

// ---------------------------------------------------------------------------------------------
// One pinned output per new fixture repo. Between them and EXPECTED_SKILLS_REPO_STYLISH
// above, every file rule in `builtinRules` is covered end to end by at least one fixture —
// skill/frontmatter-schema (skills-repo, zero-config-claude, zero-config-agents),
// skill/name-matches-dir (zero-config-agents, plus its decoupled no-op in zero-config-claude),
// file/max-lines (max-lines-repo), links/resolve (links-repo),
// activation/consistent-scope (multi-dialect-repo) and activation/no-unmatched-globs
// (multi-dialect-repo too — see that fixture's own note below).
// ---------------------------------------------------------------------------------------------

// Zero-config, `.claude/` half: no config file anywhere in the fixture, so the run is
// whatever detect.ts finds. The long allowed-key list is claude-code's own documented key set,
// pinned verbatim rather than matched loosely — it is the part of this message a user actually
// reads, and a dialect losing a key would otherwise be invisible here.
//
// The single problem is load-bearing too. The fixture's `fixture-display-label` skill carries a
// `name` that disagrees with its directory, and claude-code documents `name` as a display label
// only (`nameMatchesDir: "decoupled"`), so `skill/name-matches-dir` must stay silent about it —
// the counterpart to `zero-config-agents/fixture-renamed-dir`, which is the same mismatch on a
// `generic` surface and does report.
const EXPECTED_ZERO_CONFIG_CLAUDE_STYLISH = `.claude/skills/fixture-unknown-key/SKILL.md
  4:1  error  Unexpected frontmatter key "allowedTools" (allowed: agent, allowed-tools, argument-hint, arguments, background, compatibility, context, description, disable-model-invocation, disallowed-tools, effort, hooks, license, metadata, model, name, paths, shell, user-invocable, when_to_use)  skill/frontmatter-schema

✖ 1 problem (1 error, 0 warnings)
`;

// The detection announcement is stderr-only and carries no absolute path, so it pins whole.
const EXPECTED_ZERO_CONFIG_CLAUDE_STDERR = `no skillslurp.json found; linting auto-detected surfaces:
  .claude/skills (skills, claude-code)
using rules from extends: ["recommended"] (the built-in default).
create skillslurp.json to choose surfaces, rules and severities.
`;

// Zero-config, `.agents/` half: the same run against the `generic` dialect, which is the
// Agent Skills spec — a closed six-key set (so `version` is unknown) and a name coupled to its
// directory (so a renamed skill is reported, which claude-code above would not do).
const EXPECTED_ZERO_CONFIG_AGENTS_STYLISH = `.agents/skills/fixture-renamed-dir/SKILL.md
  2:7  error  Frontmatter key "name" must match the directory name "fixture-renamed-dir" (found "fixture-renamed-skill")  skill/name-matches-dir

.agents/skills/fixture-version-key/SKILL.md
  4:1  error  Unexpected frontmatter key "version" (allowed: allowed-tools, compatibility, description, license, metadata, name)  skill/frontmatter-schema

✖ 2 problems (2 errors, 0 warnings)
`;

const EXPECTED_ZERO_CONFIG_AGENTS_STDERR = `no skillslurp.json found; linting auto-detected surfaces:
  .agents/skills (skills, generic)
using rules from extends: ["recommended"] (the built-in default).
create skillslurp.json to choose surfaces, rules and severities.
`;

// The only line here that is not fixed text is the repo root, which is the path the CLI was
// given — hence the interpolation rather than a `toContain`.
const EXPECTED_ZERO_CONFIG_EMPTY_STDERR = `no known agent-skill layout found under ${ZERO_CONFIG_EMPTY}; nothing to lint.
also looked for: .claude/skills, .agents/skills, .opencode/skills, .cursor/skills, .github/skills, .cursor/rules, .github/instructions
create skillslurp.json to lint a layout skillslurp does not detect.
`;

// One surface, two dialects, and three skills that each pin a different answer.
//
// `fixture-legacy-globs` is the dialect divergence: scoped in Cursor by the legacy key, unscoped
// in Claude Code. `fixture-stale-paths` is the stale scope: both dialects read its `paths`, so
// they agree and `activation/consistent-scope` says nothing, while the glob itself matches no
// tracked file. `fixture-paths-scoped` is absent from this output entirely — its `paths` is both
// agreed-on AND live (it matches the fixture's own `docs/example.md`), which is what makes both
// rules selective rather than "any two-dialect surface is a violation".
//
// The `4:8` column on the second stanza is the VALUE node, not the key: a complaint about what a
// glob points at blames the glob. `activation/consistent-scope`'s `4:1` above blames the key,
// because that complaint is about which key is present.
//
// This is also the fixture that pins `activation/no-unmatched-globs` running against a real `git
// ls-files`: the fixture is linted in place inside this checkout, so its own committed files are
// what `trackedFiles()` returns. A fixture file that is not yet `git add`ed therefore does not
// count as tracked, and `fixture-paths-scoped` would start reporting.
const EXPECTED_MULTI_DIALECT_STYLISH = `.cursor/skills/fixture-legacy-globs/SKILL.md
  4:1  error  Activation is out of sync across this surface's dialects — claude-code: unscoped (no activation key present); cursor: scoped by "globs" (legacy key; its value shape is undocumented, so it cannot be compared)  activation/consistent-scope

.cursor/skills/fixture-stale-paths/SKILL.md
  4:8  error  Activation glob "gone/**/*.md" (frontmatter key "paths") matches no file tracked by git  activation/no-unmatched-globs

✖ 2 problems (2 errors, 0 warnings)
`;

// A rules surface naming `claude-code` and `cursor`, with no `include:` — the default for that
// pair is what finds `.claude/rules/frontend/ts.md`, a nested `.md` file, at all. Claude Code
// reads `paths` and Cursor reads `globs`: `ts.md` gives `paths` one more pattern than `globs`, so
// the two tools scope it differently (`activation/consistent-scope`, blamed on the first
// activation key in the file, `globs` on line 2) and that extra pattern matches no tracked file
// (`activation/no-unmatched-globs`, blamed on the pattern itself, hence `3:24`). `in-sync.md` writes the same live pattern both ways and is
// absent: the rules are selective, not "any two-dialect rules surface is a violation".
// Like `multi-dialect-repo`, the fixture is linted in place, so `src/a.ts` must be `git add`ed for
// `src/**/*.ts` to count as live.
const EXPECTED_RULES_STYLISH = `.claude/rules/frontend/ts.md
  2:1   error  Activation is out of sync across this surface's dialects — claude-code: "paths" = src/**/*.dead, src/**/*.ts; cursor: "globs" = src/**/*.ts  activation/consistent-scope
  3:24  error  Activation glob "src/**/*.dead" (frontmatter key "paths") matches no file tracked by git                                                     activation/no-unmatched-globs

✖ 2 problems (2 errors, 0 warnings)
`;

// Four of the fixture's five links resolve — plain, `#fragment`, `?query` and `?query#fragment`
// — and not one of them appears here. That half is skillslurp's own code declining to over-fire,
// on the `pathComponent` strip no other fixture reaches. The link inside the fenced code block is
// a different claim and not one about skillslurp at all: `collectLinkTargets` has no code-node
// skip, a `code` node simply has no `link` children, so what that half pins is remark's grammar.
// Worth pinning byte-for-byte all the same — adding `remark-gfm`, a dependency not yet decided
// on, would change exactly that grammar, and this is where it would announce itself.
const EXPECTED_LINKS_STYLISH = `.claude/skills/fixture-links/SKILL.md
  8:23  error  Link target "./gone.md" does not exist or is not tracked by git  links/resolve

✖ 1 problem (1 error, 0 warnings)
`;

// `warn`, and the file is two lines over so the reported line (13) differs from the counted
// total (14) — a pin where the two coincided could not tell "first line past the limit" from
// "last line of the file". The sibling `fixture-at-limit` is exactly 12 lines and is absent from
// this output: at the limit is not over it, and it is the only fixture from which `count <= max`
// narrowed to `count < max` is visible at all.
const EXPECTED_MAX_LINES_STYLISH = `.claude/skills/fixture-too-long/SKILL.md
  13:1  warn  File has 14 lines, over the limit of 12 (the whole file, frontmatter included)  file/max-lines

✖ 1 problem (0 errors, 1 warning)
`;

// The same skills-repo fixture EXPECTED_SKILLS_REPO_STYLISH pins above, through
// `--reporter github` instead. `endLine`/`endCol` show up here (the yaml/frontmatter parsers
// attach a span), even though `stylish` never renders them — this is the one output format that
// does.
const EXPECTED_SKILLS_REPO_GITHUB = `::error file=.claude/skills/broken-yaml/SKILL.md,line=3,endLine=3,col=1,endColumn=2,title=parse/frontmatter::Flow sequence in block collection must be sufficiently indented and end with a ]
::error file=.claude/skills/empty-name/SKILL.md,line=2,endLine=2,col=7,endColumn=9,title=skill/frontmatter-schema::Frontmatter key "name" must not be empty
::error file=.claude/skills/missing-description/SKILL.md,line=1,endLine=1,col=1,endColumn=4,title=skill/frontmatter-schema::Missing required frontmatter key "description"
::error file=.claude/skills/no-frontmatter/SKILL.md,line=1,col=1,title=skill/frontmatter-schema::Missing YAML frontmatter block
::error file=.claude/skills/unknown-key/SKILL.md,line=4,endLine=4,col=1,endColumn=6,title=skill/frontmatter-schema::Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)
skillslurp: 5 problems (5 errors, 0 warnings)
`;

// A config-error run (exit 2) goes through the SAME reporter as a normal run
// (the `err instanceof ConfigError` branch in `runCli`) — this is what proves the github reporter does not special-case config/stale
// diagnostics. `unrecognized key "rulez"` carries a yaml span (line 2, col 1..6), which is why
// this one DOES have endLine/endColumn despite being a config, not a lint, diagnostic.
const EXPECTED_BAD_CONFIG_GITHUB = `::error file=skillslurp.json,line=3,endLine=3,col=2,endColumn=9,title=config/invalid::unrecognized key "rulez"
skillslurp: 1 problem (1 error, 0 warnings)
`;

for (const runner of runners) {
	test(`${runner.name}: --version prints the semver-shaped package version`, () => {
		const result = runner.run(["--version"]);
		expect(result.status).toBe(EXIT_CLEAN);
		const out = result.stdout.trim();
		expect(out).toBe(pkg.version);
		expect(out).toMatch(/^\d+\.\d+\.\d+/);
	});

	test(`${runner.name}: skills-repo + stylish is pinned byte-for-byte, exit 1`, () => {
		const result = runner.run([SKILLS_REPO]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_SKILLS_REPO_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: skills-repo + json parses with 5 errors and the expected ruleIds, exit 1`, () => {
		const result = runner.run([SKILLS_REPO, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			summary: { problems: number; errors: number; warnings: number };
			diagnostics: { ruleId: string }[];
		};
		expect(payload.summary.errors).toBe(5);
		expect(payload.summary.warnings).toBe(0);
		expect(payload.summary.problems).toBe(5);
		const ruleIds = payload.diagnostics.map((d) => d.ruleId).sort();
		expect(ruleIds).toEqual(EXPECTED_JSON_RULE_IDS);
	});

	test(`${runner.name}: clean-repo exits 0 with empty stdout`, () => {
		const result = runner.run([CLEAN_REPO]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: bad-config reports config/invalid with a position, exit 2`, () => {
		const result = runner.run([BAD_CONFIG]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toContain("config/invalid");
		expect(result.stdout).toContain("rulez");
		expect(result.stdout).toMatch(/\d+:\d+/);
	});

	// Config-error diagnostics go through the reporter exactly like lint
	// diagnostics do (the `err instanceof ConfigError` branch in `runCli`) — byte-pinned so a github-specific special case for
	// config/stale diagnostics would show up here.
	test(`${runner.name}: bad-config + github reporter is pinned byte-for-byte, exit 2`, () => {
		const result = runner.run([BAD_CONFIG, "--reporter", "github"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe(EXPECTED_BAD_CONFIG_GITHUB);
		expect(result.stderr).toBe("");
	});

	// skills-repo (the fixture already pinned for stylish/json above)
	// through `--reporter github`, under both runtimes — proves the loader/reporter runs
	// identically on Bun and on the built Node dist.
	test(`${runner.name}: skills-repo + github reporter is pinned byte-for-byte, exit 1`, () => {
		const result = runner.run([SKILLS_REPO, "--reporter", "github"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_SKILLS_REPO_GITHUB);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: an unquoted ": " in frontmatter is annotated at the colon's column, github reporter, exit 1`, async () => {
		const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-colon-"));
		try {
			await writeFile(
				join(repo, "skillslurp.json"),
				'{"version":1,"extends":[],"surfaces":[{"root":".cursor/rules","kind":"rules","dialects":["cursor"]}]}\n',
			);
			await mkdir(join(repo, ".cursor", "rules"), { recursive: true });
			await writeFile(
				join(repo, ".cursor", "rules", "api.mdc"),
				"---\ndescription: Rules for API handlers: applies when editing tests\n---\n\nBody.\n",
			);
			const result = runner.run([repo, "--reporter", "github"]);
			expect(result.status).toBe(EXIT_VIOLATIONS);
			expect(result.stdout).toBe(
				`::error file=.cursor/rules/api.mdc,line=2,endLine=2,col=36,endColumn=37,title=parse/frontmatter::A value contains an unquoted ": ", which YAML reads as the start of a nested mapping; wrap the whole value in quotes
skillslurp: 1 problem (1 error, 0 warnings)
`,
			);
			expect(result.stderr).toBe("");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	// `--list-rules --reporter github` must equal `--list-rules --reporter
	// stylish`'s piped (non-TTY, so already uncolored) output byte-for-byte — including the
	// trailing newline, which `githubRules` has to supply itself since `run.ts`'s `terminate`
	// only adds one for the literal reporter name "stylish" (see github.ts's own comment on
	// this).
	test(`${runner.name}: --list-rules --reporter github equals --list-rules --reporter stylish, piped`, () => {
		const github = runner.run(["--list-rules", "--reporter", "github"]);
		const stylish = runner.run(["--list-rules", "--reporter", "stylish"]);
		expect(github.status).toBe(EXIT_CLEAN);
		expect(github.stdout).toBe(stylish.stdout);
		expect(github.stdout).not.toContain("\x1b");
		expect(github.stderr).toBe("");
	});

	test(`${runner.name}: a nonexistent path exits 2`, () => {
		const result = runner.run([NONEXISTENT]);
		expect(result.status).toBe(EXIT_ERROR);
	});

	test(`${runner.name}: --reporter bogus exits 2 and stderr names the valid reporters`, () => {
		const result = runner.run([CLEAN_REPO, "--reporter", "bogus"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain("stylish");
		expect(result.stderr).toContain("json");
	});

	test(`${runner.name}: two positionals exit 2 (the second path must not be silently dropped)`, () => {
		const result = runner.run([CLEAN_REPO, SKILLS_REPO]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain(SKILLS_REPO);
	});

	test(`${runner.name}: --reportr json (misspelled flag) exits 2 with the flag named`, () => {
		const result = runner.run([CLEAN_REPO, "--reportr", "json"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain("--reportr");
	});

	test(`${runner.name}: -r json (unknown short flag) exits 2 with the flag named`, () => {
		const result = runner.run([CLEAN_REPO, "-r", "json"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain("-r");
	});

	test(`${runner.name}: --help to a pipe has zero ANSI escape bytes and still mentions --reporter, --diff-base and --update-baseline`, () => {
		const result = runner.run(["--help"]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stdout).not.toContain("\x1b");
		expect(result.stdout).toContain("--reporter");
		// A flag nobody can discover is not shipped. citty renders a declared
		// string arg as `--diff-base=<diff_base>`, so this matches the prefix only.
		expect(result.stdout).toContain("--diff-base");
		// The other half of the same clause.
		expect(result.stdout).toContain("--update-baseline");
	});

	// The same posture as `--list-rules` with an explicit path: a flag this CLI
	// accepts and then ignores answers a question the user did not ask.
	test(`${runner.name}: --update-baseline --list-rules exits 2 naming both flags, and prints no listing`, () => {
		const result = runner.run(["--update-baseline", "--list-rules"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"skillslurp: --update-baseline cannot be combined with --list-rules; --list-rules prints the built-in rules and never reads a repository, so there is nothing to baseline\n",
		);
	});

	// `--diff-base` alongside `--list-rules` was accepted
	// and silently ignored until this check.
	test(`${runner.name}: --diff-base --list-rules exits 2 naming both flags, and prints no listing`, () => {
		const result = runner.run(["--list-rules", "--diff-base", "main"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"skillslurp: --diff-base cannot be combined with --list-rules; --list-rules prints the built-in rules and never reads a repository\n",
		);
	});

	// The temp directory is never even looked at — the check fires before the
	// run starts — which is what the absence assertion states.
	test(`${runner.name}: --update-baseline --diff-base exits 2 before any work and writes nothing`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "skillslurp-update-refuse-"));
		try {
			const result = runner.run([
				dir,
				"--update-baseline",
				"--diff-base",
				"main",
			]);
			expect(result.status).toBe(EXIT_ERROR);
			expect(result.stdout).toBe("");
			// Pinned whole, not probed: `runCli` carries its OWN guard against this pair (see
			// run.test.ts), and that one exits 2 with an "internal error:" message. Only the
			// exact text distinguishes "the CLI refused this before doing any work" from "the
			// CLI accepted it and the backstop caught it a layer down".
			expect(result.stderr).toBe(
				"skillslurp: --update-baseline cannot be combined with --diff-base; a baseline records what a FULL run found, and a diff-scoped run never looked at most of the repository\n",
			);
			expect(existsSync(join(dir, "skillslurp-baseline.json"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// MEASURED, not assumed (2026-09-06, the pinned citty 0.2.2): citty hands
	// `-x` through as the VALUE of `--diff-base` rather than eating it as a short flag of its
	// own, so `assertSafeRevision`'s leading-`-` guard is reachable from the command line and
	// this is what it says. Had citty swallowed it, this test would be pinning that instead.
	test(`${runner.name}: --diff-base -x reaches the revision guard as a value, exiting 2`, () => {
		const result = runner.run([CLEAN_REPO, "--diff-base", "-x"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			'git base revision "-x" must not start with "-" — it would be parsed by git as an option, not a revision\n',
		);
	});

	// An empty `--diff-base` value used to reach `assertSafeRevision`
	// (context.ts) through `runCli`'s outer catch, whose message has no `skillslurp: ` prefix and
	// never names the flag — unlike every other CLI-level refusal above. Both forms below are
	// MEASURED (pinned citty 0.2.2) to parse to the same empty string, so both get the same new,
	// early message instead.
	test(`${runner.name}: --diff-base= (empty value) is refused at the CLI, naming the flag`, () => {
		const result = runner.run([CLEAN_REPO, "--diff-base="]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"skillslurp: --diff-base requires a git revision, e.g. --diff-base origin/main\n",
		);
	});

	test(`${runner.name}: a bare trailing --diff-base (no value at all) is refused the same way`, () => {
		const result = runner.run([CLEAN_REPO, "--diff-base"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"skillslurp: --diff-base requires a git revision, e.g. --diff-base origin/main\n",
		);
	});

	// citty quirk, pinned rather than left undocumented: the built-in `--version` short-circuit
	// only fires when it is the SOLE raw argument (see node_modules/citty's runMain — it checks
	// `rawArgs.length === 1`). Combined with a real positional it used to silently run a normal
	// lint and ignore `--version` entirely; now that unknown flags are rejected (see above),
	// "version" surfaces as just another unrecognized key instead, so this now exits 2 rather
	// than running a lint — still not "prints the version", just differently not-that.
	test(`${runner.name}: --version mixed with another arg is not honored (rejected, not silently run as a lint)`, () => {
		const result = runner.run([CLEAN_REPO, "--version"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain("--version");
	});

	test(`${runner.name}: two runs over skills-repo produce byte-identical stdout`, () => {
		const first = runner.run([SKILLS_REPO]);
		const second = runner.run([SKILLS_REPO]);
		expect(first.stdout).toBe(second.stdout);
		expect(first.stdout).toBe(EXPECTED_SKILLS_REPO_STYLISH);
	});

	// -------------------------------------------------------------------------------------
	// `npx skillslurp .` with no config produces useful output on
	// a repo with a `.claude/` or `.agents/` layout. Both halves run under both runners,
	// because "useful output" that only holds for `bun src/cli.ts` is not what ships.
	// -------------------------------------------------------------------------------------

	test(`${runner.name}: zero-config .claude/ layout is detected and linted, exit 1`, () => {
		const result = runner.run([ZERO_CONFIG_CLAUDE]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_ZERO_CONFIG_CLAUDE_STYLISH);
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_CLAUDE_STDERR);
	});

	// The separation is the assertion: a single stray byte of the announcement on stdout would
	// break every machine consumer, so this parses stdout rather than merely inspecting it.
	test(`${runner.name}: zero-config .claude/ json stdout parses; the announcement is on stderr`, () => {
		const result = runner.run([ZERO_CONFIG_CLAUDE, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			summary: { problems: number; errors: number; warnings: number };
			diagnostics: { ruleId: string; file: string; line?: number }[];
		};
		expect(payload.summary).toEqual({ problems: 1, errors: 1, warnings: 0 });
		expect(payload.diagnostics.map((d) => d.ruleId)).toEqual([
			"skill/frontmatter-schema",
		]);
		expect(payload.diagnostics[0]?.file).toBe(
			".claude/skills/fixture-unknown-key/SKILL.md",
		);
		expect(result.stdout).not.toContain("auto-detected");
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_CLAUDE_STDERR);
	});

	test(`${runner.name}: zero-config .agents/ layout resolves to the generic dialect, exit 1`, () => {
		const result = runner.run([ZERO_CONFIG_AGENTS]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_ZERO_CONFIG_AGENTS_STYLISH);
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_AGENTS_STDERR);
	});

	test(`${runner.name}: zero-config .agents/ json stdout parses; the announcement is on stderr`, () => {
		const result = runner.run([ZERO_CONFIG_AGENTS, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			summary: { problems: number; errors: number; warnings: number };
			diagnostics: { ruleId: string }[];
		};
		expect(payload.summary).toEqual({ problems: 2, errors: 2, warnings: 0 });
		expect(payload.diagnostics.map((d) => d.ruleId).sort()).toEqual([
			"skill/frontmatter-schema",
			"skill/name-matches-dir",
		]);
		expect(result.stdout).not.toContain("auto-detected");
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_AGENTS_STDERR);
	});

	// "Nothing to lint" is not a failure: exit 0, stdout untouched, the whole explanation on
	// stderr. A caller piping stdout into a JSON parser must not have to special-case it.
	test(`${runner.name}: zero-config with no known layout notices on stderr, exit 0, empty stdout`, () => {
		const result = runner.run([ZERO_CONFIG_EMPTY]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_EMPTY_STDERR);
	});

	test(`${runner.name}: zero-config with no known layout still emits parseable json, exit 0`, () => {
		const result = runner.run([ZERO_CONFIG_EMPTY, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_CLEAN);
		const payload = JSON.parse(result.stdout) as {
			summary: { problems: number };
			diagnostics: unknown[];
		};
		expect(payload.summary.problems).toBe(0);
		expect(payload.diagnostics).toEqual([]);
		expect(result.stderr).toBe(EXPECTED_ZERO_CONFIG_EMPTY_STDERR);
	});

	test(`${runner.name}: multi-dialect surface reports the out-of-sync skill and the stale scope, and nothing else, exit 1`, () => {
		const result = runner.run([MULTI_DIALECT_REPO]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_MULTI_DIALECT_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: rules-repo reports the diverging paths and the dead pattern, and not the in-sync rule, exit 1`, () => {
		const result = runner.run([RULES_REPO]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_RULES_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: rules-repo json carries both diagnostics at the same file, exit 1`, () => {
		const result = runner.run([RULES_REPO, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as {
			summary: { problems: number; errors: number; warnings: number };
			diagnostics: {
				ruleId: string;
				file: string;
				line: number;
				col: number;
			}[];
		};
		expect(payload.summary).toEqual({ problems: 2, errors: 2, warnings: 0 });
		expect(
			payload.diagnostics.map((d) => [d.ruleId, d.file, d.line, d.col]),
		).toEqual([
			["activation/consistent-scope", ".claude/rules/frontend/ts.md", 2, 1],
			["activation/no-unmatched-globs", ".claude/rules/frontend/ts.md", 3, 24],
		]);
		expect(result.stderr).toBe("");
	});

	// A rules surface naming only `claude-code` and no `include:` falls back to `**/*.md`: the
	// nested file is found and the `.mdc` beside it is not (it would be flagged for its own
	// `description` if it were). Claude Code reads `paths` and nothing else from a rule, so any
	// other key is reported as unknown — a decision about what this linter flags, not a claim
	// about what Claude Code does with the key.
	test(`${runner.name}: a claude-code rules surface with no include finds nested .md files, not .mdc, and flags keys other than paths, exit 1`, async () => {
		const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-ccrules-"));
		try {
			await writeFile(
				join(repo, "skillslurp.json"),
				'{"version":1,"extends":[],"surfaces":[{"root":".claude/rules","kind":"rules","dialects":["claude-code"]}],"rules":{"skill/frontmatter-schema":"error"}}\n',
			);
			await mkdir(join(repo, ".claude", "rules", "frontend"), {
				recursive: true,
			});
			await writeFile(
				join(repo, ".claude", "rules", "frontend", "x.md"),
				"---\ndescription: Not a Claude Code rule key\npaths: src/**\n---\n\nBody.\n",
			);
			await writeFile(
				join(repo, ".claude", "rules", "y.mdc"),
				"---\ndescription: Never read for this surface\n---\n\nBody.\n",
			);
			const result = runner.run([repo]);
			expect(result.status).toBe(EXIT_VIOLATIONS);
			expect(result.stdout).toBe(
				`.claude/rules/frontend/x.md
  2:1  error  Unexpected frontmatter key "description" (allowed: paths)  skill/frontmatter-schema

✖ 1 problem (1 error, 0 warnings)
`,
			);
			expect(result.stderr).toBe("");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	// Requiring both keys is the schema rule's own option, not something the dialects demand: a
	// rule with neither key is valid in both tools, and only this option reports it.
	test(`${runner.name}: requiring globs and paths on a claude-code + cursor rules surface reports a rule with neither, once per key, exit 1`, async () => {
		const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-ccrules-req-"));
		try {
			await writeFile(
				join(repo, "skillslurp.json"),
				'{"version":1,"extends":[],"surfaces":[{"root":".claude/rules","kind":"rules","dialects":["claude-code","cursor"]}],"rules":{"skill/frontmatter-schema":{"severity":"error","options":{"required":["globs","paths"]}}}}\n',
			);
			await mkdir(join(repo, ".claude", "rules"), { recursive: true });
			await writeFile(
				join(repo, ".claude", "rules", "a.md"),
				"---\ndescription: Carries neither scoping key\n---\n\nBody.\n",
			);
			const result = runner.run([repo]);
			expect(result.status).toBe(EXIT_VIOLATIONS);
			expect(result.stdout).toBe(
				`.claude/rules/a.md
  1:1  error  Missing required frontmatter key "globs"  skill/frontmatter-schema
  1:1  error  Missing required frontmatter key "paths"  skill/frontmatter-schema

✖ 2 problems (2 errors, 0 warnings)
`,
			);
			expect(result.stderr).toBe("");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	test(`${runner.name}: links-repo reports the broken link only, exit 1`, () => {
		const result = runner.run([LINKS_REPO]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_LINKS_STYLISH);
		expect(result.stderr).toBe("");
	});

	// `file/max-lines` defaults to `warn`, and a run whose only
	// diagnostics are warnings exits 0 — the whole reason severity and exit code are separate.
	test(`${runner.name}: max-lines-repo is warn-only and exits 0`, () => {
		const result = runner.run([MAX_LINES_REPO]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stdout).toBe(EXPECTED_MAX_LINES_STYLISH);
		expect(result.stderr).toBe("");
	});

	// -------------------------------------------------------------------------------------
	// `--list-rules`. Counts and ids are DERIVED from `builtinRules`: the flag's job
	// is to print whatever the registry holds, so a pinned number would have to be edited by
	// whoever adds the next rule and would prove nothing about that rule reaching the listing.
	// -------------------------------------------------------------------------------------

	test(`${runner.name}: --list-rules prints one line per registered rule and exits 0`, () => {
		const result = runner.run(["--list-rules"]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stderr).toBe("");
		// stdout is piped, never a TTY, so the color decision is deterministically off.
		expect(result.stdout).not.toContain("\x1b");

		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(builtinRules.length);
		expect(lines.map((l) => l.split(" ")[0])).toEqual(
			builtinRules.map((rule) => rule.meta.id),
		);
	});

	test(`${runner.name}: --list-rules --reporter json emits every registered rule as an array, exit 0`, () => {
		const result = runner.run(["--list-rules", "--reporter", "json"]);
		expect(result.status).toBe(EXIT_CLEAN);
		expect(result.stderr).toBe("");

		const parsed = JSON.parse(result.stdout) as { id: string; kind: string }[];
		expect(parsed).toHaveLength(builtinRules.length);
		expect(parsed.map((r) => r.id)).toEqual(
			builtinRules.map((rule) => rule.meta.id),
		);
		expect(parsed.map((r) => r.kind)).toEqual(
			builtinRules.map((rule) => rule.kind),
		);
	});

	// `path` defaults to ".", so ignoring an explicit one would silently answer a question the
	// user did not ask (there is no per-repo rule list) rather than telling them it is not one.
	test(`${runner.name}: --list-rules with an explicit path exits 2 and names the path`, () => {
		const result = runner.run(["--list-rules", CLEAN_REPO]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--list-rules");
		expect(result.stderr).toContain(CLEAN_REPO);
	});

	// `--list-rules` joins KNOWN_ARG_KEYS rather than bypassing the
	// unknown-flag check, so a typo alongside it is still caught and still named. Both spellings
	// citty writes onto the args object (`list-rules` and its camelCase alias `listRules`) have
	// to be declared for this to hold — miss one and it is `--listRules`, not `--reportr`, that
	// gets reported here.
	test(`${runner.name}: --list-rules --reportr json exits 2 with the misspelled flag named, not the listing`, () => {
		const result = runner.run(["--list-rules", "--reportr", "json"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--reportr");
		expect(result.stderr).not.toContain("--listRules");
	});

	test(`${runner.name}: --list-rules --reporter bogus exits 2 and names the valid reporters`, () => {
		const result = runner.run(["--list-rules", "--reporter", "bogus"]);
		expect(result.status).toBe(EXIT_ERROR);
		expect(result.stderr).toContain("stylish");
		expect(result.stderr).toContain("json");
	});

	// Determinism, on the path that has the most room to wobble: detection order comes from
	// CANDIDATE_TABLE, discovery order from a sort over glob output (whose own order is not
	// stable between runs), and both feed this output.
	test(`${runner.name}: two zero-config runs produce byte-identical stdout and stderr`, () => {
		const first = runner.run([ZERO_CONFIG_AGENTS]);
		const second = runner.run([ZERO_CONFIG_AGENTS]);
		expect(first.stdout).toBe(second.stdout);
		expect(first.stderr).toBe(second.stderr);
		expect(first.stdout).toBe(EXPECTED_ZERO_CONFIG_AGENTS_STYLISH);
		expect(first.stderr).toBe(EXPECTED_ZERO_CONFIG_AGENTS_STDERR);
	});
}

// Only `node dist/cli.js` (never bun): Bun silently swallows a downstream EPIPE (write to a
// closed pipe), Node does not — an unhandled 'error' event on process.stdout is an uncaught
// exception, a raw stack trace on stderr, and exit code 1 regardless of what the lint itself
// found. Proven to need real volume: smaller outputs never fill the kernel pipe buffer, so
// `head -c 10` never gets the chance to close before Node finishes writing.

/** `mkfifo` is POSIX; the FIFO cases below are skipped where it is not on PATH. */
const MKFIFO_AVAILABLE = await (async () => {
	try {
		await promisify(execFileCb)("mkfifo", ["--version"]);
		return true;
	} catch (err) {
		// A non-zero exit means mkfifo IS there and merely dislikes the flag (BSD mkfifo has no
		// --version); only "not found" means it is missing.
		return (err as NodeJS.ErrnoException).code !== "ENOENT";
	}
})();

test("node dist/cli.js: a downstream EPIPE (truncated consumer) exits cleanly, no raw stack trace", async () => {
	const tmpRepo = await mkdtemp(join(tmpdir(), "skillslurp-epipe-"));
	try {
		// `extends: []`, not `[recommended]`: the tier includes a `project` rule
		// (`refs/no-unreachable-files`) that asks `ctx.git.trackedFiles()`, so a `recommended` run
		// needs a checkout — and turning this temp dir into one would mean committing a thousand
		// generated skill directories for a test that is about EPIPE handling and nothing else.
		// `skill/frontmatter-schema` is named explicitly below and is what produces the violations,
		// so both the ~180 KB of output and the exit-1 outcome this test rests on are unchanged.
		await writeFile(
			join(tmpRepo, "skillslurp.json"),
			'{"version":1,"extends":[],"surfaces":[{"root":".claude/skills"}],"rules":{"skill/frontmatter-schema":"error"}}\n',
		);
		const skillsDir = join(tmpRepo, ".claude", "skills");
		// One violation per skill dir; this many pushes stdout to ~180 KB, comfortably past the
		// ~129 KB point where a reader that already exited actually triggers EPIPE.
		const SKILL_COUNT = 1000;
		for (let i = 0; i < SKILL_COUNT; i++) {
			const dir = join(skillsDir, `skill-$i`);
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "SKILL.md"),
				`---\nname: skill-$i\ndescription: fixture skill padding CLI output for the EPIPE test.\ntools: Read, Write\n---\n\nBody.\n`,
			);
		}

		// PIPESTATUS[0] (bash-only) is node's own exit code — `$?` after a pipeline reflects
		// `head`'s exit code, not node's, so plain sh/`$?` cannot observe what we're testing.
		// The `\$` below is bash's own `${PIPESTATUS[0]}` syntax, escaped so JS doesn't try to
		// interpolate it.
		const script = `node dist/cli.js "$1" | head -c 10 >/dev/null; echo "NODE_EXIT:\${PIPESTATUS[0]}"`;
		const result = spawnSync("bash", ["-c", script, "_", tmpRepo], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});

		expect(result.stderr).toBe("");
		const match = result.stdout.match(/NODE_EXIT:(\d+)/);
		expect(match).not.toBeNull();
		// The fixture repo is all violations, so a full (untruncated) run would also exit 1 —
		// this is what proves the EPIPE handler kept the already-computed exit code rather than
		// falling back to the process default of 0.
		expect(match?.[1]).toBe(String(EXIT_VIOLATIONS));
	} finally {
		await rm(tmpRepo, { recursive: true, force: true });
	}
}, 20000);

/**
 * The "no discovery, no config loading, never touches the repo being linted" half of `--list-rules`,
 * proven rather than asserted: an empty temp directory that is not a git checkout, holds no
 * `skillslurp.json` and matches no detection candidate. A `--list-rules` that loaded a
 * config would exit 2 there ("no skillslurp.json found"), and one that ran detection would
 * print the none-found notice on stderr — the two outcomes other tests in this file pin. Instead
 * the listing comes back byte-identical to the one produced from the repo root, under both
 * runtimes.
 *
 * Standalone rather than inside the runner loop because it is the only test here that needs a cwd
 * other than REPO_ROOT, so the entry points have to be spelled absolutely.
 */
test("--list-rules from a non-repo cwd is byte-identical, under both runtimes, exit 0", async () => {
	const outsideRepo = await mkdtemp(join(tmpdir(), "skillslurp-list-rules-"));
	try {
		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			const fromRepoRoot = spawnSync(command, [entry, "--list-rules"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			const fromOutside = spawnSync(
				command,
				[join(REPO_ROOT, entry), "--list-rules"],
				{ cwd: outsideRepo, encoding: "utf8" },
			);

			expect(fromOutside.status).toBe(EXIT_CLEAN);
			expect(fromOutside.stderr).toBe("");
			expect(fromOutside.stdout).toBe(fromRepoRoot.stdout);
			expect(fromOutside.stdout.trimEnd().split("\n")).toHaveLength(
				builtinRules.length,
			);
		}
	} finally {
		await rm(outsideRepo, { recursive: true, force: true });
	}
});

/**
 * The baseline through the real CLI, on both runtimes.
 *
 * The point is `node dist/cli.js`: `src/baseline.ts` reads and parses a file, and the one way a
 * Bun-only API (`Bun.file`) could sneak into that path is if nothing ever ran it outside Bun
 * (dist must run on Node >= 22). The output is byte-pinned rather than probed, so
 * the suppression, the surviving diagnostic's position and the stderr notice are all one
 * assertion.
 *
 * Standalone rather than inside the runner loop above for the same reason `--list-rules from a
 * non-repo cwd` is: the fixture has to be built (and committed — the `refs/*` rules read git's
 * index) before either runtime is invoked.
 */
test("a committed baseline suppresses through the real CLI, byte-identical on both runtimes", async () => {
	const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-baseline-"));
	try {
		await mkdir(join(repo, ".claude", "skills", "fixture-alpha"), {
			recursive: true,
		});
		await writeFile(
			join(repo, "skillslurp.json"),
			'{"version":1,"extends":[],"surfaces":[{"root":".claude/skills","dialects":["claude-code"]}],"rules":{"refs/no-dangling-paths":"error"}}\n',
		);
		await writeFile(
			join(repo, ".claude", "skills", "fixture-alpha", "SKILL.md"),
			"---\nname: fixture-alpha\ndescription: A fixture skill for the CLI baseline test.\n---\n\nBody.\n",
		);
		// The same dangling path on lines 1 and 3; the baseline blesses one of the two.
		await writeFile(
			join(repo, "notes.md"),
			"See .claude/skills/gone/SKILL.md for details.\n\nSee .claude/skills/gone/SKILL.md again.\n",
		);
		await writeFile(
			join(repo, "skillslurp-baseline.json"),
			`{
  "version": 1,
  "files": {
    "notes.md": {
      "refs/no-dangling-paths": {
        "Path \\".claude/skills/gone/SKILL.md\\" does not exist or is not tracked by git": 1
      }
    }
  }
}
`,
		);
		await gitInitAndCommit(repo);

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			const result = spawnSync(command, [entry, repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});

			expect([command, result.status]).toEqual([command, EXIT_VIOLATIONS]);
			expect([command, result.stdout]).toEqual([
				command,
				`notes.md
  3:5  error  Path ".claude/skills/gone/SKILL.md" does not exist or is not tracked by git  refs/no-dangling-paths

✖ 1 problem (1 error, 0 warnings)
`,
			]);
			expect([command, result.stderr]).toEqual([
				command,
				"skillslurp-baseline.json: 1 problem(s) suppressed, 0 stale entr(y|ies)\n",
			]);
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

/**
 * `--diff-base` end to end on both runtimes over a two-commit fixture: the
 * KNOWN_ARG_KEYS pair is what this catches (a missing spelling makes every run using the flag
 * exit 2 with "unknown option(s)"), and the byte-pinned output proves the filter, the notice and
 * the exit code all survive the bundle.
 */
test("--diff-base lints only the document committed since the base, on both runtimes", async () => {
	const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-diff-base-"));
	try {
		await mkdir(join(repo, ".claude", "skills", "alpha"), { recursive: true });
		await mkdir(join(repo, ".claude", "skills", "beta"), { recursive: true });
		await writeFile(
			join(repo, "skillslurp.json"),
			`{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/skills"
    }
  ],
  "rules": {
    "skill/frontmatter-schema": "error"
  }
}
`,
		);
		// Both are missing "description", so a full run reports both. No `dialects:` key, so the
		// surface gets the default `generic` contract — the one that requires `description`.
		await writeFile(
			join(repo, ".claude", "skills", "alpha", "SKILL.md"),
			"---\nname: alpha\n---\n\nBody.\n",
		);
		await writeFile(
			join(repo, ".claude", "skills", "beta", "SKILL.md"),
			"---\nname: beta\n---\n\nBody.\n",
		);
		await gitInitAndCommit(repo);
		const base = (
			await runGit(repo, ["rev-parse", "HEAD"], {
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
			})
		)
			.toString("utf8")
			.trim();

		await writeFile(
			join(repo, ".claude", "skills", "beta", "SKILL.md"),
			"---\nname: beta\n---\n\nEdited body.\n",
		);
		await runGit(repo, ["add", "-A"], {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		});
		await runGit(
			repo,
			[
				"-c",
				"core.hooksPath=",
				"commit",
				"--quiet",
				"--no-verify",
				"-m",
				"edit beta",
			],
			{ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		);

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			const full = spawnSync(command, [entry, repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			// The control: both documents really do violate, so the single-line output below is
			// the flag's doing.
			expect([command, full.status]).toEqual([command, EXIT_VIOLATIONS]);
			expect([
				command,
				full.stdout.match(/skill\/frontmatter-schema/g),
			]).toEqual([
				command,
				["skill/frontmatter-schema", "skill/frontmatter-schema"],
			]);

			const result = spawnSync(command, [entry, "--diff-base", base, repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});

			expect([command, result.status]).toEqual([command, EXIT_VIOLATIONS]);
			expect([command, result.stdout]).toEqual([
				command,
				`.claude/skills/beta/SKILL.md
  1:1  error  Missing required frontmatter key "description"  skill/frontmatter-schema

✖ 1 problem (1 error, 0 warnings)
`,
			]);
			expect([command, result.stderr]).toEqual([
				command,
				`--diff-base ${base}: file rules limited to 1 changed document(s); project, scan and shape rules ran in full\n`,
			]);
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

/**
 * `activation/max-glob-share` is a `file` rule, so under `--diff-base` it runs on changed documents
 * only: an unchanged rule document whose glob is just as broad is not reported, which is the
 * documented cost of keeping a diff-scoped run to what the change touched. The full run is the
 * control that both documents really do carry a broad glob.
 */
test("--diff-base reports a broad activation glob on the changed document only, on both runtimes", async () => {
	const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-glob-share-"));
	const gitEnv = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
	try {
		await mkdir(join(repo, ".claude", "rules"), { recursive: true });
		await writeFile(
			join(repo, "skillslurp.json"),
			`{
  "version": 1,
  "extends": [],
  "surfaces": [
    {
      "root": ".claude/rules",
      "kind": "rules",
      "dialects": ["claude-code"]
    }
  ],
  "rules": {
    "activation/max-glob-share": { "severity": "warn", "options": { "max": 50 } }
  }
}
`,
		);
		const rule = (body: string): string => `---\npaths: "**"\n---\n\n${body}\n`;
		await writeFile(join(repo, ".claude", "rules", "alpha.md"), rule("Body."));
		await writeFile(join(repo, ".claude", "rules", "beta.md"), rule("Body."));
		await gitInitAndCommit(repo);
		const base = (await runGit(repo, ["rev-parse", "HEAD"], gitEnv))
			.toString("utf8")
			.trim();

		await writeFile(
			join(repo, ".claude", "rules", "beta.md"),
			rule("Edited body."),
		);
		await runGit(repo, ["add", "-A"], gitEnv);
		await runGit(
			repo,
			[
				"-c",
				"core.hooksPath=",
				"commit",
				"--quiet",
				"--no-verify",
				"-m",
				"edit beta",
			],
			gitEnv,
		);

		const broad = (file: string): string => `${file}
  2:8  warn  Activation glob "**" (frontmatter key "paths") matches 3 of 3 tracked files (100.0%), more than the limit of 50%  activation/max-glob-share
`;

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			const full = spawnSync(command, [entry, repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			expect([command, full.status]).toEqual([command, EXIT_CLEAN]);
			expect([command, full.stdout]).toEqual([
				command,
				`${broad(".claude/rules/alpha.md")}
${broad(".claude/rules/beta.md")}
✖ 2 problems (0 errors, 2 warnings)
`,
			]);

			const result = spawnSync(command, [entry, "--diff-base", base, repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});
			expect([command, result.status]).toEqual([command, EXIT_CLEAN]);
			expect([command, result.stdout]).toEqual([
				command,
				`${broad(".claude/rules/beta.md")}
✖ 1 problem (0 errors, 1 warning)
`,
			]);
			expect([command, result.stderr]).toEqual([
				command,
				`--diff-base ${base}: file rules limited to 1 changed document(s); project, scan and shape rules ran in full\n`,
			]);
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

/**
 * `--update-baseline` end to end on both runtimes, over a fixture that is built
 * and committed first (so the `refs/*` rules can read git's index) — the same reason the
 * baseline and `--diff-base` tests above sit outside the runner loop.
 *
 * Two things only a spawned process can prove. First, that both spellings citty writes for the
 * flag (`update-baseline` and `updateBaseline`) are in `KNOWN_ARG_KEYS`: miss one and this exits
 * 2 with "unknown option(s)" instead of writing anything. Second, that the write itself runs on
 * Node — `cli.ts` uses `node:fs/promises`, and dist must not need Bun.
 */
test("--update-baseline writes the regenerated file on both runtimes, byte-identical", async () => {
	const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-update-baseline-"));
	try {
		await mkdir(join(repo, ".claude", "skills", "alpha"), { recursive: true });
		await writeFile(
			join(repo, "skillslurp.json"),
			'{"version":1,"extends":[],"surfaces":[{"root":".claude/skills","dialects":["claude-code"]}],"rules":{"refs/no-dangling-paths":"error"}}\n',
		);
		await writeFile(
			join(repo, ".claude", "skills", "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: A fixture skill for the CLI update-baseline test.\n---\n\nBody.\n",
		);
		// The same dangling path twice, so the file has to carry a count of 2.
		await writeFile(
			join(repo, "notes.md"),
			"See .claude/skills/gone/SKILL.md for details.\n\nSee .claude/skills/gone/SKILL.md again.\n",
		);
		await gitInitAndCommit(repo);

		const baselinePath = join(repo, "skillslurp-baseline.json");
		const expected = `{
  "version": 1,
  "files": {
    "notes.md": {
      "refs/no-dangling-paths": {
        "Path \\".claude/skills/gone/SKILL.md\\" does not exist or is not tracked by git": 2
      }
    }
  }
}
`;

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			await rm(baselinePath, { force: true });

			const result = spawnSync(command, [entry, "--update-baseline", repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});

			expect([command, result.status]).toEqual([command, EXIT_CLEAN]);
			expect([command, result.stdout]).toEqual([command, ""]);
			expect([command, result.stderr]).toEqual([
				command,
				"wrote skillslurp-baseline.json: 2 problem(s) in 1 file(s) (2 errors, 0 warnings)\n",
			]);
			expect([command, await readFile(baselinePath, "utf8")]).toEqual([
				command,
				expected,
			]);
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

/**
 * The baseline path is `<root>/skillslurp-baseline.json`, so the REPOSITORY being linted chooses
 * it, not the operator. Measured 2026-09-06 before the guard existed: a repository committing that
 * name as a symlink to a file outside itself had that file silently overwritten by a plain
 * `--update-baseline`, exit 0, with the ordinary `wrote ...` notice — one clone plus one documented
 * flag, and `--update-baseline` is step two of this project's own adoption procedure.
 *
 * The assertion that matters is the last one: the target's ORIGINAL bytes are still there. Exit 2
 * and the message are how a user finds out; the untouched file is the property.
 *
 * Mutation check: replace `writeBaselineFile` in `cli.ts` with a plain `writeFile` and this test
 * fails on the target's contents, on both runtimes.
 */
test("--update-baseline refuses to follow a symlink at the baseline path", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "skillslurp-cli-symlink-"));
	try {
		const repo = join(scratch, "repo");
		const outside = join(scratch, "outside.txt");
		await mkdir(join(repo, ".claude", "skills", "alpha"), { recursive: true });
		await writeFile(outside, "PRECIOUS\n");
		await writeFile(
			join(repo, ".claude", "skills", "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: A fixture skill for the symlink-refusal test.\n---\n\nBody.\n",
		);
		// Relative, and committed: this is the shape an attacker can actually put in a repository.
		await symlink("../outside.txt", join(repo, "skillslurp-baseline.json"));
		await gitInitAndCommit(repo);

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			await writeFile(outside, "PRECIOUS\n");
			const result = spawnSync(command, [entry, "--update-baseline", repo], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			});

			expect([command, result.status]).toEqual([command, EXIT_ERROR]);
			// The FULL sentence, not the substring `"symbolic link"`: `O_NOFOLLOW`'s own errno is
			// `ELOOP: too many symbolic links encountered`, which contains that substring, so a
			// substring assertion passes with the `lstat` guard deleted — measured, the mutation
			// left the whole suite green. The two guards cover different platforms (`O_NOFOLLOW`
			// is undefined on Windows, where `lstat` is the only one left), so a test that cannot
			// tell them apart is a test that cannot see the guard it is named for.
			// The full repo-relative form, not just the opening quote: `path` is
			// `<root>/skillslurp-baseline.json` (absolute), and a `startsWith('refusing to write
			// "')`-only check would still pass if that absolute path ever leaked back into the
			// message instead of the fixed, repo-relative `skillslurp-baseline.json` this now names.
			expect([
				command,
				result.stderr.startsWith(
					'refusing to write "skillslurp-baseline.json": it is a symbolic link, and following it would write outside the path you asked to lint',
				),
			]).toEqual([command, true]);
			expect([command, result.stderr.includes("wrote ")]).toEqual([
				command,
				false,
			]);
			expect([command, await readFile(outside, "utf8")]).toEqual([
				command,
				"PRECIOUS\n",
			]);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

/**
 * The write is the one part of this CLI that can fail on a repository the lint
 * itself is perfectly happy with, so it gets the failure mode a read-only checkout actually
 * produces.
 *
 * `--reporter json` rather than stylish, deliberately: stylish renders an empty report as `""`,
 * so it could not tell "stdout was suppressed" from "stdout was empty anyway". The json
 * reporter's zero-summary document is a real string, and asserting stdout is empty is what
 * fails if the write ever moves after the stdout write — a machine consumer would otherwise
 * read `{"summary":{"problems":0,...}}` as "this repository is clean" from a run whose one job
 * did not happen.
 */
test("--update-baseline on an unwritable root exits 2 naming the path, with nothing on stdout", async () => {
	if (process.getuid?.() === 0) {
		// root ignores the mode bits, so there is no failure to observe.
		return;
	}
	const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-update-eacces-"));
	try {
		await mkdir(join(repo, ".claude", "skills", "alpha"), { recursive: true });
		await writeFile(
			join(repo, "skillslurp.json"),
			'{"version":1,"extends":[],"surfaces":[{"root":".claude/skills","dialects":["claude-code"]}],"rules":{"refs/no-dangling-paths":"error"}}\n',
		);
		await writeFile(
			join(repo, ".claude", "skills", "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: A fixture skill for the unwritable-root test.\n---\n\nBody.\n",
		);
		await writeFile(
			join(repo, "notes.md"),
			"See .claude/skills/gone/SKILL.md for details.\n",
		);
		await gitInitAndCommit(repo);
		// Read and traverse, but no new entries: the lint reads every file it needs (and git
		// reads its own index under `.git`, whose mode is untouched), and only the baseline
		// write — a fresh entry in this directory — is refused.
		await chmod(repo, 0o555);

		for (const [command, entry] of [
			["bun", "src/cli.ts"],
			["node", "dist/cli.js"],
		] as const) {
			const result = spawnSync(
				command,
				[entry, "--update-baseline", "--reporter", "json", repo],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);

			expect([command, result.status]).toEqual([command, EXIT_ERROR]);
			expect([command, result.stdout]).toEqual([command, ""]);
			// The path the write was refused, verbatim from the errno message — the one thing
			// that tells a user which directory to fix.
			expect([
				command,
				result.stderr.includes(join(repo, "skillslurp-baseline.json")),
			]).toEqual([command, true]);
			expect([command, result.stderr.includes("EACCES")]).toEqual([
				command,
				true,
			]);
			// The `wrote ...` line must not appear underneath the error explaining that nothing
			// was written.
			expect([command, result.stderr.includes("wrote ")]).toEqual([
				command,
				false,
			]);
			expect(existsSync(join(repo, "skillslurp-baseline.json"))).toBe(false);
		}
	} finally {
		await chmod(repo, 0o755);
		await rm(repo, { recursive: true, force: true });
	}
});

/**
 * The write side's guard used to cover only symlinks, so a FIFO at the baseline path made
 * `open(O_WRONLY)` block forever waiting for a reader. An indefinite hang is a worse CI outcome
 * than a refusal, because nothing in the log says what happened.
 *
 * The test holds the FIFO's READ end open across the spawn, which is what makes it safe to run.
 * Without a reader, a regression here does not merely fail — it wedges the suite: the child
 * blocks in `open`, and neither `spawnSync`'s `timeout` nor a `child.kill` timer in this process
 * reliably ends it (both were tried and both let a mutation run past four minutes before this
 * was restructured; the correct code, by contrast, exits in about 300ms). With a reader attached
 * the child's `open` always returns immediately, so the two outcomes are distinguished by the
 * exit code rather than by how long anything takes.
 *
 * Mutation check: narrow `repoFileRefusal`'s condition back to `isSymbolicLink()` only. The child
 * then opens the FIFO successfully and writes the baseline into it, so it exits 0 and this test
 * fails on the exit code — promptly, and with the suite still able to finish.
 */
test.skipIf(!MKFIFO_AVAILABLE)(
	"--update-baseline refuses a FIFO at the baseline path rather than writing into it",
	async () => {
		const repo = await mkdtemp(join(tmpdir(), "skillslurp-cli-fifo-"));
		let reader: FileHandle | undefined;
		try {
			await mkdir(join(repo, ".claude", "skills", "alpha"), {
				recursive: true,
			});
			await writeFile(
				join(repo, ".claude", "skills", "alpha", "SKILL.md"),
				"---\nname: alpha\ndescription: A fixture skill for the FIFO-refusal test.\n---\n\nBody.\n",
			);
			await gitInitAndCommit(repo);
			const fifo = join(repo, "skillslurp-baseline.json");
			await promisify(execFileCb)("mkfifo", [fifo]);
			// O_NONBLOCK so opening the read end does not itself wait for a writer.
			reader = await fsOpen(
				fifo,
				fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
			);

			const result = spawnSync(
				"node",
				["dist/cli.js", "--update-baseline", repo],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			);

			expect(result.status).toBe(EXIT_ERROR);
			expect(result.stderr).toContain('refusing to write "');
			expect(result.stderr).toContain("it is not a regular file");
		} finally {
			await reader?.close();
			await rm(repo, { recursive: true, force: true });
		}
	},
);
