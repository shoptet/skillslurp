import { afterAll, expect, test } from "bun:test";
import {
	cp,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CLEAN, EXIT_VIOLATIONS } from "./exit.js";
import { type CliResult, runCli } from "./run.js";
import { gitInitAndCommit } from "./testing/rule-tester.js";

const FIXTURE = fileURLToPath(
	new URL("../test/fixtures/commands-repo", import.meta.url),
);

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function commandsRepo(
	mutate?: (root: string) => Promise<void>,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-commands-"));
	tempDirs.push(dir);
	const root = await realpath(dir);
	await cp(FIXTURE, root, {
		recursive: true,
		dereference: false,
		verbatimSymlinks: true,
	});
	if (mutate !== undefined) {
		await mutate(root);
	}
	await gitInitAndCommit(root);
	return root;
}

function lint(root: string): Promise<CliResult> {
	return runCli({ path: root, reporter: "stylish", color: false });
}

async function repoint(root: string, spoke: string, target: string) {
	await rm(join(root, spoke), { force: true });
	await symlink(target, join(root, spoke));
}

test("flat command files lint clean under recommended, including one with no frontmatter at all", async () => {
	const root = await commandsRepo();
	expect(await lint(root)).toEqual({
		stdout: "",
		stderr: "",
		exitCode: EXIT_CLEAN,
	});
});

test("a command in a subdirectory is neither unreachable nor a directory without an entry", async () => {
	const root = await commandsRepo(async (r) => {
		const deeper = join(r, ".agents/commands/frontend/forms");
		await mkdir(deeper, { recursive: true });
		await writeFile(
			join(deeper, "field.md"),
			"---\ndescription: Scaffold a form field\n---\n\nCreate a form field named $ARGUMENTS.\n",
		);
	});
	const result = await lint(root);
	expect(result.stdout).not.toContain("refs/no-unreachable-files");
	expect(result.stdout).not.toContain("skill/dir-has-entry");
	expect(result.exitCode).toBe(EXIT_CLEAN);
});

test("a command file that is malformed is reported, so a clean run is not an empty surface", async () => {
	const root = await commandsRepo(async (r) => {
		await writeFile(
			join(r, ".agents/commands/frontend/component.md"),
			"---\ndescription: [unclosed\n---\n\nbody\n",
		);
	});
	const result = await lint(root);
	expect(result.exitCode).toBe(EXIT_VIOLATIONS);
	expect(result.stdout).toContain(".agents/commands/frontend/component.md");
	expect(result.stdout).toContain("parse/frontmatter");
});

test("hub/symlinks reports a spoke repointed away from the commands hub", async () => {
	const root = await commandsRepo(async (r) => {
		await mkdir(join(r, "elsewhere"));
		await writeFile(join(r, "elsewhere/notes.md"), "Notes.\n");
		await repoint(r, ".claude/commands", "../elsewhere");
	});
	const result = await lint(root);
	expect(result).toEqual({
		stdout: `.claude/commands
    error  Spoke ".claude/commands" of hub ".agents/commands" points at "elsewhere", not at the hub  hub/symlinks

✖ 1 problem (1 error, 0 warnings)
`,
		stderr: "",
		exitCode: EXIT_VIOLATIONS,
	});
});

test("hub/symlinks reports a dangling spoke of the commands hub", async () => {
	const root = await commandsRepo(async (r) => {
		await repoint(r, ".cursor/commands", "../.agents/missing");
	});
	const result = await lint(root);
	expect(result).toEqual({
		stdout: `.cursor/commands
    error  Spoke ".cursor/commands" of hub ".agents/commands" points at "../.agents/missing", which does not resolve  hub/symlinks

✖ 1 problem (1 error, 0 warnings)
`,
		stderr: "",
		exitCode: EXIT_VIOLATIONS,
	});
});

// Pins a missed violation: Claude Code's command files take neither key, but the skills contract allows both.
test("a command file carrying name and paths is not reported", async () => {
	const root = await commandsRepo(async (r) => {
		await mkdir(join(r, "src"));
		await writeFile(join(r, "src/app.ts"), "export {};\n");
		await writeFile(
			join(r, ".agents/commands/release.md"),
			"---\nname: ship-it\ndescription: Cut a release\npaths:\n  - src/**/*.ts\n---\n\nCut a release.\n",
		);
	});
	expect(await lint(root)).toEqual({
		stdout: "",
		stderr: "",
		exitCode: EXIT_CLEAN,
	});
});
