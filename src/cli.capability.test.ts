/**
 * The Bun/Node parity guard for the capability layer, end to end through the real CLI.
 *
 * A separate file from `cli.test.ts`, for one reason that file cannot accommodate: every fixture
 * there is linted IN PLACE inside this checkout, which is only a git checkout by accident of
 * where it sits. Every rule exercised here asks `ctx.git` or `ctx.grep` a question, so each
 * fixture is copied to a temp directory and turned into a real, one-commit repository of its own
 * first — the ephemeral setup, and the only form in which a local run with
 * unstaged fixture files gives the same answer as CI. `.github/workflows/ci.yml` runs the same
 * fixtures the other way (in place, from the checkout) on Node; the two mechanisms are
 * described side by side there.
 *
 * What this proves that nothing else does: `bun test` runs the whole suite under Bun, and CI's
 * Node steps used to run only fixtures that enable no `project`/`scan` rule at all. So the code
 * where Bun/Node divergence was actually FOUND — `child_process` argument and PATH
 * handling in `git.ts`, `realpath` permission semantics in the corpus builder — was covered by
 * exactly one runtime. Both runners below run every fixture, and their `--reporter json` output
 * is compared byte for byte.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_VIOLATIONS } from "./exit.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

// Every test here spawns the CLI, several of them more than once; bun's 5 s default flaked on a loaded host.
setDefaultTimeout(30000);

// Anchored to this module's own location, not process.cwd() — same rationale as cli.test.ts.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT_SCAN_FIXTURE = fileURLToPath(
	new URL("../test/fixtures/project-scan-repo", import.meta.url),
);
const ORPHAN_FIXTURE = fileURLToPath(
	new URL("../test/fixtures/orphan-repo", import.meta.url),
);
const HUB_FIXTURE = fileURLToPath(
	new URL("../test/fixtures/hub-repo", import.meta.url),
);

interface Runner {
	name: string;
	run(args: readonly string[]): SpawnSyncReturns<string>;
}

// The same two runners cli.test.ts uses, and for the same reason: `dist/cli.js` is what ships,
// `bun src/cli.ts` is what every other test in this repo invokes. cwd is the repo root so the
// relative entry point resolves; the path under test is absolute, so the fixture's location is
// not what cwd is for here.
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

/** Every temp directory `materialize` created, removed in `afterAll` whatever the tests did. */
const tempDirs: string[] = [];

/**
 * Copies a checked-in fixture to a temp directory and makes it a one-commit repository.
 *
 * The copy is what makes the run hermetic: `git ls-files` inside it lists that fixture's files
 * and nothing else, so the answer does not depend on the state of the checkout this test happens
 * to run from. `gitInitAndCommit` is the harness's own materialization step (testing/), which
 * already scrubs every git repo-location and config-injection environment variable and refuses
 * to commit into a repository other than the one it just created — this test does not repeat any
 * of that.
 *
 * `realpath` up front, once: macOS's tmpdir sits under `/var`, itself a symlink to
 * `/private/var`, and the CLI canonicalizes the root it is given — comparing an output
 * built from a canonical root against a path that still has the symlink in it is a failure mode
 * `RuleTester` already learned about the hard way.
 *
 * The copy keeps every symlink as the link it is (`dereference: false`, `verbatimSymlinks: true`):
 * `hub-repo` commits one, and a copy that followed it, or rewrote its relative target to an
 * absolute one, would be a different repository that reports different things.
 */
async function materialize(fixture: string, slug: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `skillslurp-e2e-${slug}-`));
	tempDirs.push(dir);
	const root = await realpath(dir);
	await cp(fixture, root, {
		recursive: true,
		dereference: false,
		verbatimSymlinks: true,
	});
	await gitInitAndCommit(root);
	return root;
}

/**
 * Filled in by `beforeAll`. Not `readonly`, and not two bare `let`s either: the assignment
 * happens once, in one place, and every test reads through this object rather than through a
 * binding the type checker would have to be told is definitely assigned.
 */
const repos = { projectScan: "", orphan: "", hub: "" };

beforeAll(async () => {
	const build = spawnSync("bun", ["run", "build"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (build.status !== 0) {
		throw new Error(
			`bun run build failed (status ${String(build.status)}):\n${build.stderr}`,
		);
	}
	repos.projectScan = await materialize(PROJECT_SCAN_FIXTURE, "project-scan");
	repos.orphan = await materialize(ORPHAN_FIXTURE, "orphan");
	repos.hub = await materialize(HUB_FIXTURE, "hub");
}, 30000);

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

// Four rules, four violations, and every other `recommended` rule silent — which is the half a
// fixture like this gets wrong most easily. The silences are each bought by a specific clean
// sibling in the fixture: `fixture-beta`'s live glob (`activation/no-unmatched-globs`),
// `fixture-alpha/notes.md` being linked (`refs/no-unreachable-files`), the live path mention in
// `README.md` (the one `scan` rule), and the two index links that resolve (`index/no-missing-targets`).
//
// Positions are the point of pinning this rather than counting diagnostics. Each of the four is
// a different shape: `index/complete` reports a FILE and has no node to point at, so it lands on
// 1:1; `index/no-missing-targets` points at the link node inside the index document; the glob is at the
// YAML sequence ITEM (4:9), not at the `paths` key; and the `scan` hit carries a line and a
// column that come from a raw-text scan with no parse behind it.
const EXPECTED_PROJECT_SCAN_STYLISH = `.claude/skills/SKILLS.md
  8:3  error  Index link target "fixture-gone/SKILL.md" does not exist or is not tracked by git  index/no-missing-targets

.claude/skills/fixture-alpha/SKILL.md
  4:9  error  Activation glob "src/**/*.renamed" (frontmatter key "paths") matches no file tracked by git  activation/no-unmatched-globs

.claude/skills/fixture-gamma/SKILL.md
  1:1  error  Entry document ".claude/skills/fixture-gamma/SKILL.md" is not linked from index file ".claude/skills/SKILLS.md"  index/complete

README.md
  10:24  error  Path ".claude/skills/fixture-old" does not exist or is not tracked by git  refs/no-dangling-paths

✖ 4 problems (4 errors, 0 warnings)
`;

// No line/column at all on the diagnostic line — the orphan rule reports a file's absence from
// every other file, so there is nothing inside it to point at, and the stylish reporter renders
// that as leading whitespace where the position would be.
const EXPECTED_ORPHAN_STYLISH = `.claude/skills/fixture-solo/reference.md
    error  Reference file ".claude/skills/fixture-solo/reference.md" is not reachable from entry document ".claude/skills/fixture-solo/SKILL.md"  refs/no-unreachable-files

✖ 1 problem (1 error, 0 warnings)
`;

// The two `shape` rules, each firing once on a fixture that is otherwise correct: the hub's
// `.claude/skills` link is committed as a symlink and stays silent, `.cursor/skills` holds a real
// copy of the hub item, and `CLAUDE.md` carries text after its `@AGENTS.md`. `hub/symlinks` files
// its finding against the item's path and has no position; the other points at the extra line.
const EXPECTED_HUB_STYLISH = `.cursor/skills/fixture-hub-item
    error  Spoke ".cursor/skills" of hub ".agents/skills": ".cursor/skills/fixture-hub-item" is a copy, not a link to the hub item ".agents/skills/fixture-hub-item"  hub/symlinks

CLAUDE.md
  3:1  error  File "CLAUDE.md" does not defer to "AGENTS.md": it holds more than the @import; only blank lines may accompany it  file/defers-to

✖ 2 problems (2 errors, 0 warnings)
`;

/** The fields of a json diagnostic this file asserts on; the rest is `json.test.ts`'s business. */
interface JsonDiagnostic {
	readonly ruleId: string;
	readonly file: string;
	readonly line?: number;
	readonly col?: number;
	readonly endLine?: number;
	readonly endCol?: number;
}

interface JsonPayload {
	readonly summary: { problems: number; errors: number; warnings: number };
	readonly diagnostics: readonly JsonDiagnostic[];
}

// Built field by field from the parsed payload rather than compared with `toMatchObject`: an
// absent `line` and a `line` of `undefined` are the same thing to a loose matcher, and "this
// diagnostic carries no position" is exactly what the `index/complete` and orphan cases assert.
function positionsOf(payload: JsonPayload): readonly JsonDiagnostic[] {
	return payload.diagnostics.map((d) => {
		const out: {
			ruleId: string;
			file: string;
			line?: number;
			col?: number;
			endLine?: number;
			endCol?: number;
		} = { ruleId: d.ruleId, file: d.file };
		if (d.line !== undefined) {
			out.line = d.line;
		}
		if (d.col !== undefined) {
			out.col = d.col;
		}
		if (d.endLine !== undefined) {
			out.endLine = d.endLine;
		}
		if (d.endCol !== undefined) {
			out.endCol = d.endCol;
		}
		return out;
	});
}

const EXPECTED_PROJECT_SCAN_POSITIONS: readonly JsonDiagnostic[] = [
	{
		ruleId: "index/no-missing-targets",
		file: ".claude/skills/SKILLS.md",
		line: 8,
		col: 3,
		endLine: 8,
		endCol: 40,
	},
	{
		ruleId: "activation/no-unmatched-globs",
		file: ".claude/skills/fixture-alpha/SKILL.md",
		line: 4,
		col: 9,
		endLine: 4,
		endCol: 27,
	},
	// No `endLine`/`endCol`: `START_LOC` is a point, not a span.
	{
		ruleId: "index/complete",
		file: ".claude/skills/fixture-gamma/SKILL.md",
		line: 1,
		col: 1,
	},
	{
		ruleId: "refs/no-dangling-paths",
		file: "README.md",
		line: 10,
		col: 24,
		endLine: 10,
		endCol: 50,
	},
];

// No position keys whatsoever, which is the assertion: this rule reports a file.
const EXPECTED_ORPHAN_POSITIONS: readonly JsonDiagnostic[] = [
	{
		ruleId: "refs/no-unreachable-files",
		file: ".claude/skills/fixture-solo/reference.md",
	},
];

const EXPECTED_HUB_POSITIONS: readonly JsonDiagnostic[] = [
	{ ruleId: "hub/symlinks", file: ".cursor/skills/fixture-hub-item" },
	{ ruleId: "file/defers-to", file: "CLAUDE.md", line: 3, col: 1 },
];

for (const runner of runners) {
	test(`${runner.name}: project-scan-repo reports four violations from four rules, exit 1`, () => {
		const result = runner.run([repos.projectScan]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_PROJECT_SCAN_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: project-scan-repo json carries every rule id and position, exit 1`, () => {
		const result = runner.run([repos.projectScan, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as JsonPayload;
		expect(payload.summary).toEqual({ problems: 4, errors: 4, warnings: 0 });
		expect(positionsOf(payload)).toEqual(EXPECTED_PROJECT_SCAN_POSITIONS);
	});

	test(`${runner.name}: orphan-repo reports the unreferenced file, exit 1`, () => {
		const result = runner.run([repos.orphan]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_ORPHAN_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: orphan-repo json carries the orphan with no position, exit 1`, () => {
		const result = runner.run([repos.orphan, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as JsonPayload;
		expect(payload.summary).toEqual({ problems: 1, errors: 1, warnings: 0 });
		expect(positionsOf(payload)).toEqual(EXPECTED_ORPHAN_POSITIONS);
	});

	test(`${runner.name}: hub-repo reports the copied spoke item and the extra import text, exit 1`, () => {
		const result = runner.run([repos.hub]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		expect(result.stdout).toBe(EXPECTED_HUB_STYLISH);
		expect(result.stderr).toBe("");
	});

	test(`${runner.name}: hub-repo json carries both shape-rule findings, exit 1`, () => {
		const result = runner.run([repos.hub, "--reporter", "json"]);
		expect(result.status).toBe(EXIT_VIOLATIONS);
		const payload = JSON.parse(result.stdout) as JsonPayload;
		expect(payload.summary).toEqual({ problems: 2, errors: 2, warnings: 0 });
		expect(positionsOf(payload)).toEqual(EXPECTED_HUB_POSITIONS);
	});
}

// ---------------------------------------------------------------------------------------------
// What this asserts: not "both runners agree with a constant", which two independently drifting
// constants could satisfy, but the two runtimes' bytes compared against each other directly.
// Every rule reached here runs a subprocess (`git ls-files`) or reads every tracked file's raw
// text, and those are the two places Bun and Node were measured to differ.
// ---------------------------------------------------------------------------------------------

const [BUN_RUNNER, NODE_RUNNER] = runners;
if (BUN_RUNNER === undefined || NODE_RUNNER === undefined) {
	// Unreachable: `runners` is a two-element literal. Present because
	// `noUncheckedIndexedAccess` types the destructuring as possibly absent, and a non-null
	// assertion here would be a claim the type checker cannot verify.
	throw new Error("expected two runners");
}

for (const fixture of ["projectScan", "orphan", "hub"] as const) {
	test(`${fixture}: bun and node produce byte-identical --reporter json at exit 1`, () => {
		const path = repos[fixture];
		const fromBun = BUN_RUNNER.run([path, "--reporter", "json"]);
		const fromNode = NODE_RUNNER.run([path, "--reporter", "json"]);
		expect(fromBun.status).toBe(EXIT_VIOLATIONS);
		expect(fromNode.status).toBe(EXIT_VIOLATIONS);
		expect(fromBun.stdout).toBe(fromNode.stdout);
		expect(fromBun.stderr).toBe("");
		expect(fromNode.stderr).toBe("");
		// Not merely equal to each other: two empty strings would also be. This is the shape
		// check that makes the comparison above mean something.
		expect(JSON.parse(fromBun.stdout)).toHaveProperty("diagnostics");
	});

	// Determinism inside one runtime, on the path with the most room to wobble: the corpus these
	// rules scan comes from a `git ls-files` subprocess, and the orphan walk's reachability
	// fixpoint is built out of a `Map` whose insertion order is discovery's.
	test(`${fixture}: two runs of node dist/cli.js produce byte-identical stdout`, () => {
		const path = repos[fixture];
		const first = NODE_RUNNER.run([path, "--reporter", "json"]);
		const second = NODE_RUNNER.run([path, "--reporter", "json"]);
		expect(first.stdout).toBe(second.stdout);
	});
}
