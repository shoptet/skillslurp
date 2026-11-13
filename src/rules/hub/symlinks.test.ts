import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { basename, dirname, join } from "node:path";
import { freezeSurface, type ResolvedSurface, sealMap } from "../../config.js";
import { createCapabilities, type RepoRuleContext } from "../../context.js";
import { DEFAULT_INCLUDE } from "../../dialects.js";
import { type Document, readDocument } from "../../document.js";
import { EXIT_VIOLATIONS } from "../../exit.js";
import type { RuleReport } from "../../rule.js";
import { runCli } from "../../run.js";
import {
	gitInitAndCommit,
	type InvalidCase,
	type RuleTestCase,
	runRuleTests,
	type ValidCase,
} from "../../testing/rule-tester.js";
import { hubSymlinks, linkNameFor } from "./symlinks.js";

/**
 * `hub/symlinks`: directory-level and item-level spokes, through `RuleTester` where a
 * fixture can state it. A fixture cannot state an absolute target (the temp directory is chosen
 * per case), a report ORDER (the engine re-sorts by file before a case sees it), git modes other
 * than a file's, or a special file, so the sections after `runRuleTests` call
 * `hubSymlinks.check(ctx)` against a hand-built context, the idiom `index/complete`'s own
 * direct-call tests use.
 */

const HUB = ".agents/skills";
const SPOKE = ".claude/skills";
const HUB_FILES = { ".agents/skills/demo/SKILL.md": "# Demo\n" };
const HUB_SURFACE = { root: HUB, spokes: [SPOKE] };

function spokeMessage(text: string, spoke = SPOKE, hub = HUB): string {
	return `Spoke "${spoke}" of hub "${hub}" ${text}`;
}

const NOT_COMMITTED = (state: string) =>
	spokeMessage(`is not committed as a symlink (${state})`);

// A real directory that is not the hub holds one link per hub item
const ITEM_FILES = {
	".agents/skills/foo/SKILL.md": "# Foo\n",
	".agents/skills/bar/SKILL.md": "# Bar\n",
};
const ITEM_LINKS = {
	[`${SPOKE}/foo`]: "../../.agents/skills/foo",
	[`${SPOKE}/bar`]: "../../.agents/skills/bar",
};

const CHECKED_OUT_AS_FILE =
	"is recorded as a symlink in git's index but is a regular file in the working tree (either the change is not staged, or core.symlinks is off in this checkout)";

const UNLINTED =
	"is not a hub item and no surface lints it; move it into the hub and link it, or remove it";

function strayLinkMessage(name: string, where: string): string {
	return `is a symlink, but "${name}" is not a hub item and no surface lints what it points at ("${where}"); move it into the hub and link it, or remove it`;
}

function itemMessage(
	path: string,
	text: string,
	spoke = SPOKE,
	hub = HUB,
): string {
	return `Spoke "${spoke}" of hub "${hub}": "${path}" ${text}`;
}

const RULES_HUB = ".agents/rules";
const CURSOR_SPOKE = ".cursor/rules";
const MD_AND_MDC = ["**/*.md", "**/*.mdc"];

type SurfaceSpec = NonNullable<RuleTestCase["surface"]>;

function cursorSurface(over: SurfaceSpec = {}): SurfaceSpec {
	return {
		root: RULES_HUB,
		kind: "rules",
		dialects: ["cursor"],
		include: ["**/*.md"],
		spokes: [CURSOR_SPOKE],
		...over,
	};
}

function cursorMessage(path: string, text: string): string {
	return itemMessage(path, text, CURSOR_SPOKE, RULES_HUB);
}

function cursorSpokeMessage(text: string): string {
	return spokeMessage(text, CURSOR_SPOKE, RULES_HUB);
}

function collisionMessage(item: string, owner: string): string {
	return `Spoke ".cursor/rules" of hub ".agents/rules": the hub item ".agents/rules/${item}" cannot be linked there, because its ".mdc" name "x.mdc" is also the name of the hub item ".agents/rules/${owner}"; rename one of them`;
}

const RENAME_ADVICE =
	'is named like the hub item ".agents/rules/x.md", but "cursor" reads only ".mdc" files there; name the link "x.mdc"';

const WHOLE_HUB_ADVICE =
	'make it a directory with one link per hub item, naming each one "<name>.mdc"';

const MISSING_X_MDC =
	'does not exist, but ".agents/rules/x.md" is a hub item that needs a link there';

const SECOND_LINK_TO_X_MD =
	'is a second link to the hub item ".agents/rules/x.md"';

const GROUP_ADVICE =
	'a link to a directory cannot rename what is inside it, so make it a directory with one link per hub item, naming each one "<name>.mdc"';

function missingMessage(hubItem: string): string {
	return `does not exist, but "${hubItem}" is a hub item that needs a link there`;
}

function copyMessage(hubItem: string): string {
	return `is a copy, not a link to the hub item "${hubItem}"`;
}

const SUBFOLDER_FILES = {
	".agents/rules/general.md": "# General\n",
	".agents/rules/backend/api.md": "# Api\n",
	".agents/rules/backend/style.md": "# Style\n",
	".agents/rules/frontend/api.md": "# Api\n",
	".agents/rules/frontend/style.md": "# Style\n",
	".agents/rules/testing/api.md": "# Api\n",
	".agents/rules/testing/style.md": "# Style\n",
};

const SUBFOLDER_LINKS = {
	".cursor/rules/general.mdc": "../../.agents/rules/general.md",
	".cursor/rules/backend/api.mdc": "../../../.agents/rules/backend/api.md",
	".cursor/rules/backend/style.mdc": "../../../.agents/rules/backend/style.md",
	".cursor/rules/frontend/api.mdc": "../../../.agents/rules/frontend/api.md",
	".cursor/rules/frontend/style.mdc":
		"../../../.agents/rules/frontend/style.md",
	".cursor/rules/testing/api.mdc": "../../../.agents/rules/testing/api.md",
	".cursor/rules/testing/style.mdc": "../../../.agents/rules/testing/style.md",
};

const CURSOR_VALID: readonly ValidCase[] = [
	{
		name: "a Cursor spoke links a .md hub rule as .mdc",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface(),
	},
	{
		name: "a hub rule already named .mdc keeps its name in a Cursor spoke, next to a renamed one",
		files: { ".agents/rules/x.md": "# X\n", ".agents/rules/y.mdc": "# Y\n" },
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/y.mdc": "../../.agents/rules/y.mdc",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
	},
	{
		name: "a directory item keeps its name in a Cursor spoke, and is silent when every rule in it is .mdc",
		files: {
			".agents/rules/group/a.mdc": "# A\n",
			".agents/rules/group/b.mdc": "# B\n",
		},
		symlinks: { ".cursor/rules/group": "../../.agents/rules/group" },
		surface: cursorSurface({ include: MD_AND_MDC }),
	},
	{
		name: "a directory-level Cursor spoke over a hub of .mdc rules is silent",
		files: { ".agents/rules/a.mdc": "# A\n", ".agents/rules/b.mdc": "# B\n" },
		symlinks: { [CURSOR_SPOKE]: "../.agents/rules" },
		surface: cursorSurface({ include: ["**/*.mdc"] }),
	},
	{
		name: "a real .md file in a Cursor spoke is not reported, since Cursor ignores it",
		files: {
			".agents/rules/x.md": "# X\n",
			".cursor/rules/notes.md": "# Notes\n",
		},
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface(),
	},
	{
		name: "a hub file the surface ignore skips is not reported when linked under its .mdc name",
		files: { ".agents/rules/x.md": "# X\n", ".agents/rules/old.md": "# Old\n" },
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/old.mdc": "../../.agents/rules/old.md",
		},
		surface: cursorSurface({ ignore: ["old.md"] }),
	},
	{
		name: "a .claude/rules spoke on the same hub keeps same-name links next to a Cursor spoke",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".claude/rules/x.md": "../../.agents/rules/x.md",
		},
		surface: cursorSurface({ spokes: [CURSOR_SPOKE, ".claude/rules"] }),
	},
	{
		name: "a nested .cursor/rules item-level spoke keeps the same-name rule",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: {
			"packages/web/.cursor/rules/x.md": "../../../../.agents/rules/x.md",
		},
		surface: cursorSurface({ spokes: ["packages/web/.cursor/rules"] }),
	},
	{
		name: "a nested .cursor/rules directory-level spoke over .md rules is not a Cursor spoke",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: { "packages/web/.cursor/rules": "../../../.agents/rules" },
		surface: cursorSurface({ spokes: ["packages/web/.cursor/rules"] }),
	},
	{
		name: "a .cursor/rules directory-level spoke on a skills surface is not a Cursor spoke",
		files: HUB_FILES,
		symlinks: { [CURSOR_SPOKE]: "../.agents/skills" },
		surface: { root: HUB, spokes: [CURSOR_SPOKE] },
	},
	{
		name: "a .cursor/rules item-level spoke on a skills surface keeps a file item under its own name",
		files: { ".agents/skills/SKILL.md": "# Root\n" },
		symlinks: { ".cursor/rules/SKILL.md": "../../.agents/skills/SKILL.md" },
		surface: { root: HUB, spokes: [CURSOR_SPOKE] },
	},
	{
		name: "a Cursor spoke of a claude-code-only rules surface still wants .mdc links",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface({ dialects: ["claude-code"] }),
	},
	{
		name: "a stray link to a hub directory the surface ignore skips is left alone, under whatever name it has",
		files: {
			".agents/rules/x.md": "# X\n",
			".agents/rules/old/z.mdc": "# Z\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/archive": "../../.agents/rules/old",
		},
		surface: cursorSurface({ include: MD_AND_MDC, ignore: ["old/**"] }),
	},
	{
		name: "a stray link to a directory whose files Cursor does not read is left alone",
		files: {
			".agents/rules/x.md": "# X\n",
			"elsewhere/dir/a.md": "# A\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/dir": "../../elsewhere/dir",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
	},
	{
		name: "a real subfolder of per-file .mdc links mirrors a hub folder",
		files: SUBFOLDER_FILES,
		symlinks: SUBFOLDER_LINKS,
		surface: cursorSurface(),
	},
	{
		name: "the same stem at two levels is no collision",
		files: {
			".agents/rules/x.md": "# X\n",
			".agents/rules/backend/x.md": "# X2\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
	},
	{
		name: "sibling subfolders sharing a name prefix are separate levels",
		files: {
			".agents/rules/backend/a.md": "# A\n",
			".agents/rules/backend-old/b.md": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/a.mdc": "../../../.agents/rules/backend/a.md",
			".cursor/rules/backend-old/b.mdc":
				"../../../.agents/rules/backend-old/b.md",
		},
		surface: cursorSurface(),
	},
	{
		name: "a stray link in a subfolder is judged from its own directory",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			"docs/e.txt": "not a rule\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/e.mdc": "../../../docs/e.txt",
		},
		surface: cursorSurface(),
	},
	{
		name: "a subfolder's .md files are not reported, Cursor ignores them",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/notes.md": "# Notes\n",
			".cursor/rules/backend/README.md": "# Rules\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
	},
	{
		name: "an ignored hub rule linked in a subfolder is not reported",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".agents/rules/backend/old.md": "# Old\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/old.mdc": "../../../.agents/rules/backend/old.md",
		},
		surface: cursorSurface({ ignore: ["backend/old.md"] }),
	},
	{
		name: "a subfolder stray the surface ignore names from the spoke root is left alone",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			"docs/extra.md": "# Extra\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/extra.mdc": "../../../docs/extra.md",
		},
		surface: cursorSurface({ ignore: ["backend/extra.mdc"] }),
	},
	{
		name: "a bare-directory ignore prunes subfolder content as discovery does",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/drafts/x.mdc": "# Draft\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface({ ignore: ["backend/drafts"] }),
	},
	{
		name: "a hub folder with no discovered rules expects no links",
		files: {
			".agents/rules/general.md": "# General\n",
			".agents/rules/drafts/x.md": "# X\n",
			".agents/rules/drafts/y.md": "# Y\n",
		},
		symlinks: {
			".cursor/rules/general.mdc": "../../.agents/rules/general.md",
			".cursor/rules/drafts/x.mdc": "../../../.agents/rules/drafts/x.md",
		},
		surface: cursorSurface({ ignore: ["drafts/**"] }),
	},
	{
		name: "a hub folder that is a symlink expects no links",
		files: {
			".agents/rules/general.md": "# General\n",
			"shared-rules/x.md": "# X\n",
			"shared-rules/y.md": "# Y\n",
		},
		symlinks: {
			".agents/rules/shared": "../../shared-rules",
			".cursor/rules/general.mdc": "../../.agents/rules/general.md",
			".cursor/rules/shared/x.mdc": "../../../shared-rules/x.md",
		},
		surface: cursorSurface(),
	},
	{
		name: "a hub folder reached through a symlink by an include rooted in it is mirrored through its real path",
		files: { "shared-rules/x.md": "# X\n" },
		symlinks: {
			".agents/rules/shared": "../../shared-rules",
			".cursor/rules/shared/x.mdc": "../../../.agents/rules/shared/x.md",
		},
		surface: cursorSurface({ include: ["shared/**/*.md"] }),
	},
	{
		name: "a directory link in a subfolder to .mdc rules is silent",
		files: {
			".agents/rules/backend/legacy/a.mdc": "# A\n",
			".agents/rules/backend/legacy/b.mdc": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/legacy": "../../../.agents/rules/backend/legacy",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
	},
	{
		name: "a subfolder stray link to a directory the surface ignore names from the spoke root is left alone",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			"elsewhere/dir/b.mdc": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/dir": "../../../elsewhere/dir",
		},
		surface: cursorSurface({
			include: MD_AND_MDC,
			ignore: ["backend/dir/**"],
		}),
	},
];

const CURSOR_INVALID: readonly InvalidCase[] = [
	{
		name: "a link under the hub name, with no .mdc link, is one report that says to rename it",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: { ".cursor/rules/x.md": "../../.agents/rules/x.md" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/x.md", RENAME_ADVICE),
				file: ".cursor/rules/x.md",
			},
		],
	},
	{
		name: "a link under the hub name next to the .mdc link is a second link",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/x.md": "../../.agents/rules/x.md",
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/x.md", SECOND_LINK_TO_X_MD),
				file: ".cursor/rules/x.md",
			},
		],
	},
	{
		name: "a link under the hub name that git does not track leaves the missing .mdc link as the report",
		files: {
			".agents/rules/x.md": "# X\n",
			".cursor/rules/README.md": "# Rules\n",
		},
		worktree: {
			symlinks: { ".cursor/rules/x.md": "../../.agents/rules/x.md" },
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/x.mdc", MISSING_X_MDC),
				file: ".cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "a link under the hub name that points somewhere else leaves the missing .mdc link as the report",
		files: {
			".agents/rules/x.md": "# X\n",
			"docs/other.md": "# Other\n",
		},
		symlinks: { ".cursor/rules/x.md": "../../docs/other.md" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/x.mdc", MISSING_X_MDC),
				file: ".cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "neither name exists: the report carries the .mdc name",
		files: {
			".agents/rules/x.md": "# X\n",
			".cursor/rules/README.md": "# Rules\n",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/x.mdc", MISSING_X_MDC),
				file: ".cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "two hub files that need one .mdc name: the one already named so owns it, the other is reported at the spoke",
		files: { ".agents/rules/x.md": "# X\n", ".agents/rules/x.mdc": "# X2\n" },
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.mdc" },
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: collisionMessage("x.md", "x.mdc"),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a link to the .md file under the other file's .mdc name does not satisfy either",
		files: { ".agents/rules/x.md": "# X\n", ".agents/rules/x.mdc": "# X2\n" },
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: collisionMessage("x.md", "x.mdc"),
				file: CURSOR_SPOKE,
			},
			{
				message: cursorMessage(
					".cursor/rules/x.mdc",
					'points at ".agents/rules/x.md", not at the hub item ".agents/rules/x.mdc"',
				),
				file: ".cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "two non-.mdc hub files that need one .mdc name: the first by name owns it",
		files: { ".agents/rules/x.md": "# X\n", ".agents/rules/x.mdx": "# X2\n" },
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface({ include: ["**/*.md", "**/*.mdx"] }),
		errors: [
			{
				message: collisionMessage("x.mdx", "x.md"),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a directory-level Cursor spoke over .md rules is one report with the count and the first path",
		files: { ".agents/rules/b.md": "# B\n", ".agents/rules/a.md": "# A\n" },
		symlinks: { [CURSOR_SPOKE]: "../.agents/rules" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage(
					`links the whole hub, but "cursor" reads only ".mdc" files there and ignores 2 of its 2 rules (first: ".cursor/rules/a.md"); ${WHOLE_HUB_ADVICE}`,
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a directory-level Cursor spoke counts only the rules Cursor ignores",
		files: { ".agents/rules/a.md": "# A\n", ".agents/rules/b.mdc": "# B\n" },
		symlinks: { [CURSOR_SPOKE]: "../.agents/rules" },
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: cursorSpokeMessage(
					`links the whole hub, but "cursor" reads only ".mdc" files there and ignores 1 of its 2 rules (first: ".cursor/rules/a.md"); ${WHOLE_HUB_ADVICE}`,
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a directory-level Cursor spoke of a claude-code-only rules surface is reported too",
		files: { ".agents/rules/a.md": "# A\n" },
		symlinks: { [CURSOR_SPOKE]: "../.agents/rules" },
		surface: cursorSurface({ dialects: ["claude-code"] }),
		errors: [
			{
				message: cursorSpokeMessage(
					`links the whole hub, but "cursor" reads only ".mdc" files there and ignores 1 of its 1 rules (first: ".cursor/rules/a.md"); ${WHOLE_HUB_ADVICE}`,
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a Cursor spoke reached through a committed ancestor link is a whole-hub link too",
		files: { ".agents/rules/a.md": "# A\n" },
		symlinks: { ".cursor": ".agents" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage(
					`links the whole hub, but "cursor" reads only ".mdc" files there and ignores 1 of its 1 rules (first: ".cursor/rules/a.md"); ${WHOLE_HUB_ADVICE}`,
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a Cursor spoke reached through an uncommitted ancestor link is reported for that alone",
		files: { ".agents/rules/a.md": "# A\n" },
		worktree: { symlinks: { ".cursor": ".agents" } },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage(
					'is reached through ".cursor", which is not committed as a symlink (it is not tracked by git)',
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a directory-level Cursor spoke pointing elsewhere is reported for that alone",
		files: { ".agents/rules/a.md": "# A\n", "other/README.md": "# Other\n" },
		symlinks: { [CURSOR_SPOKE]: "../other" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage('points at "other", not at the hub'),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a dangling directory-level Cursor spoke is reported for that alone",
		files: { ".agents/rules/a.md": "# A\n" },
		symlinks: { [CURSOR_SPOKE]: "../nowhere" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage(
					'points at "../nowhere", which does not resolve',
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "an uncommitted directory-level Cursor spoke is reported for that alone",
		files: { ".agents/rules/a.md": "# A\n" },
		worktree: { symlinks: { [CURSOR_SPOKE]: "../.agents/rules" } },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorSpokeMessage(
					"is not committed as a symlink (it is not tracked by git)",
				),
				file: CURSOR_SPOKE,
			},
		],
	},
	{
		name: "a directory item holding a .md rule advises per-file links",
		files: {
			".agents/rules/group/a.md": "# A\n",
			".agents/rules/group/b.mdc": "# B\n",
		},
		symlinks: { ".cursor/rules/group": "../../.agents/rules/group" },
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/group",
					`is a link to the hub item ".agents/rules/group", but "cursor" reads only ".mdc" files there and ignores 1 of its 2 rules (first: ".cursor/rules/group/a.md"); ${GROUP_ADVICE}`,
				),
				file: ".cursor/rules/group",
			},
		],
	},
	{
		name: "a real .mdc file in a Cursor spoke is judged by what Cursor reads, not by the hub's include",
		files: {
			".agents/rules/x.md": "# X\n",
			".cursor/rules/fork.mdc": "# Fork\n",
		},
		symlinks: { ".cursor/rules/x.mdc": "../../.agents/rules/x.md" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/fork.mdc", UNLINTED),
				file: ".cursor/rules/fork.mdc",
			},
		],
	},
	{
		name: "a stray .mdc link to an .md file outside the hub is reported",
		files: {
			".agents/rules/x.md": "# X\n",
			"docs/elsewhere.md": "# Elsewhere\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/other.mdc": "../../docs/elsewhere.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/other.mdc",
					strayLinkMessage("other.mdc", "docs/elsewhere.md"),
				),
				file: ".cursor/rules/other.mdc",
			},
		],
	},
	{
		name: "a stray link to a directory holding .mdc files that no surface lints is reported",
		files: {
			".agents/rules/x.md": "# X\n",
			"elsewhere/dir/b.mdc": "# B\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/dir": "../../elsewhere/dir",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/dir",
					strayLinkMessage("dir", "elsewhere/dir"),
				),
				file: ".cursor/rules/dir",
			},
		],
	},
	{
		name: "a .claude/rules spoke keeps same-name links: an .mdc link there is reported as before",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".claude/rules/x.mdc": "../../.agents/rules/x.md",
		},
		surface: cursorSurface({ spokes: [CURSOR_SPOKE, ".claude/rules"] }),
		errors: [
			{
				message: itemMessage(
					".claude/rules/x.md",
					MISSING_X_MDC,
					".claude/rules",
					RULES_HUB,
				),
				file: ".claude/rules/x.md",
			},
			{
				message: itemMessage(
					".claude/rules/x.mdc",
					SECOND_LINK_TO_X_MD,
					".claude/rules",
					RULES_HUB,
				),
				file: ".claude/rules/x.mdc",
			},
		],
	},
	{
		name: "a nested .cursor/rules spoke keeps the same-name rule: an .mdc link there is reported as before",
		files: { ".agents/rules/x.md": "# X\n" },
		symlinks: {
			"packages/web/.cursor/rules/x.mdc": "../../../../.agents/rules/x.md",
		},
		surface: cursorSurface({ spokes: ["packages/web/.cursor/rules"] }),
		errors: [
			{
				message: itemMessage(
					"packages/web/.cursor/rules/x.md",
					MISSING_X_MDC,
					"packages/web/.cursor/rules",
					RULES_HUB,
				),
				file: "packages/web/.cursor/rules/x.md",
			},
			{
				message: itemMessage(
					"packages/web/.cursor/rules/x.mdc",
					SECOND_LINK_TO_X_MD,
					"packages/web/.cursor/rules",
					RULES_HUB,
				),
				file: "packages/web/.cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "a missing link in a real subfolder is reported at its own path, under the declared spoke",
		files: {
			".agents/rules/backend/a.md": "# A\n",
			".agents/rules/backend/b.md": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/a.mdc": "../../../.agents/rules/backend/a.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/b.mdc",
					missingMessage(".agents/rules/backend/b.md"),
				),
				file: ".cursor/rules/backend/b.mdc",
			},
		],
	},
	{
		name: "a missing link two subfolders down is reported at its path",
		files: {
			".agents/rules/a/b/x.md": "# X\n",
			".cursor/rules/a/b/README.md": "# Rules\n",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/a/b/x.mdc",
					missingMessage(".agents/rules/a/b/x.md"),
				),
				file: ".cursor/rules/a/b/x.mdc",
			},
		],
	},
	{
		name: "a real subfolder in a spoke no tool reads is still a copy",
		files: { ".agents/rules/backend/api.md": "# Api\n" },
		symlinks: {
			".claude/rules/backend/api.md": "../../../.agents/rules/backend/api.md",
		},
		surface: cursorSurface({ spokes: [".claude/rules"] }),
		errors: [
			{
				message: itemMessage(
					".claude/rules/backend",
					copyMessage(".agents/rules/backend"),
					".claude/rules",
					RULES_HUB,
				),
				file: ".claude/rules/backend",
			},
		],
	},
	{
		name: "a real directory where a file item belongs is still a copy",
		files: {
			".agents/rules/x.md": "# X\n",
			".cursor/rules/x.mdc/README.md": "# Rules\n",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/x.mdc",
					copyMessage(".agents/rules/x.md"),
				),
				file: ".cursor/rules/x.mdc",
			},
		],
	},
	{
		name: "a real file inside a real subfolder is a copy of its hub rule",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/x.mdc": "# X\n",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/x.mdc",
					copyMessage(".agents/rules/backend/x.md"),
				),
				file: ".cursor/rules/backend/x.mdc",
			},
		],
	},
	{
		name: "a subfolder link to the wrong level is mistargeted",
		files: {
			".agents/rules/x.md": "# X\n",
			".agents/rules/backend/x.md": "# X2\n",
		},
		symlinks: {
			".cursor/rules/x.mdc": "../../.agents/rules/x.md",
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/x.mdc",
					'points at ".agents/rules/x.md", not at the hub item ".agents/rules/backend/x.md"',
				),
				file: ".cursor/rules/backend/x.mdc",
			},
		],
	},
	{
		name: "a subfolder link under the hub name says to rename it",
		files: { ".agents/rules/backend/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/backend/x.md": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/x.md",
					'is named like the hub item ".agents/rules/backend/x.md", but "cursor" reads only ".mdc" files there; name the link "x.mdc"',
				),
				file: ".cursor/rules/backend/x.md",
			},
		],
	},
	{
		name: "a second link inside a subfolder is an alias",
		files: { ".agents/rules/backend/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/dup.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/dup.mdc",
					'is a second link to the hub item ".agents/rules/backend/x.md"',
				),
				file: ".cursor/rules/backend/dup.mdc",
			},
		],
	},
	{
		name: "two subfolder rules needing one name are reported at the subfolder",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".agents/rules/backend/x.mdc": "# X2\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.mdc",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: collisionMessage("backend/x.md", "backend/x.mdc"),
				file: ".cursor/rules/backend",
			},
		],
	},
	{
		name: "an uncommitted link inside a subfolder is reported",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/README.md": "# Rules\n",
		},
		worktree: {
			symlinks: {
				".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			},
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/x.mdc",
					"is not committed as a symlink (it is not tracked by git)",
				),
				file: ".cursor/rules/backend/x.mdc",
			},
		],
	},
	{
		name: "a link checked out as a file inside a subfolder names both causes",
		files: { ".agents/rules/backend/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		worktree: {
			remove: [".cursor/rules/backend/x.mdc"],
			files: {
				".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			},
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/x.mdc",
					CHECKED_OUT_AS_FILE,
				),
				file: ".cursor/rules/backend/x.mdc",
			},
		],
	},
	{
		name: "a dangling stray link in a subfolder does not resolve",
		files: { ".agents/rules/backend/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/ghost.mdc": "nowhere",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/ghost.mdc",
					'is a symlink, but "ghost.mdc" is not a hub item (it points at "nowhere", which does not resolve)',
				),
				file: ".cursor/rules/backend/ghost.mdc",
			},
		],
	},
	{
		name: "real .mdc content in a subfolder is linted by no surface",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/fork.mdc": "# Fork\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/backend/fork.mdc", UNLINTED),
				file: ".cursor/rules/backend/fork.mdc",
			},
		],
	},
	{
		name: "real content below a subfolder is reported at its top entry",
		files: {
			".agents/rules/backend/x.md": "# X\n",
			".cursor/rules/backend/extra/a.mdc": "# A\n",
		},
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
		},
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/backend/extra", UNLINTED),
				file: ".cursor/rules/backend/extra",
			},
		],
	},
	{
		name: "a spoke subfolder with no hub folder is an entry, not a level",
		files: {
			".agents/rules/general.md": "# General\n",
			".cursor/rules/extra/a.mdc": "# A\n",
		},
		symlinks: { ".cursor/rules/general.mdc": "../../.agents/rules/general.md" },
		surface: cursorSurface(),
		errors: [
			{
				message: cursorMessage(".cursor/rules/extra", UNLINTED),
				file: ".cursor/rules/extra",
			},
		],
	},
	{
		name: "a directory link in a subfolder advises per-file links",
		files: {
			".agents/rules/backend/legacy/a.md": "# A\n",
			".agents/rules/backend/legacy/b.mdc": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/legacy": "../../../.agents/rules/backend/legacy",
		},
		surface: cursorSurface({ include: MD_AND_MDC }),
		errors: [
			{
				message: cursorMessage(
					".cursor/rules/backend/legacy",
					`is a link to the hub item ".agents/rules/backend/legacy", but "cursor" reads only ".mdc" files there and ignores 1 of its 2 rules (first: ".cursor/rules/backend/legacy/a.md"); ${GROUP_ADVICE}`,
				),
				file: ".cursor/rules/backend/legacy",
			},
		],
	},
	{
		name: "a real subfolder that is a declared spoke is left to its own check",
		files: {
			".agents/rules/backend/a.md": "# A\n",
			".agents/rules/backend/b.md": "# B\n",
		},
		symlinks: {
			".cursor/rules/backend/a.mdc": "../../../.agents/rules/backend/a.md",
		},
		surface: cursorSurface({
			spokes: [CURSOR_SPOKE, ".cursor/rules/backend"],
		}),
		errors: [
			{
				message: itemMessage(
					".cursor/rules/backend/backend",
					missingMessage(".agents/rules/backend"),
					".cursor/rules/backend",
					RULES_HUB,
				),
				file: ".cursor/rules/backend/backend",
			},
		],
	},
	{
		name: "a declared spoke inside a subfolder is not a stray of it",
		files: { ".agents/rules/backend/x.md": "# X\n" },
		symlinks: {
			".cursor/rules/backend/x.mdc": "../../../.agents/rules/backend/x.md",
			".cursor/rules/backend/inner": "../nowhere",
		},
		surface: cursorSurface({
			spokes: [CURSOR_SPOKE, ".cursor/rules/backend/inner"],
		}),
		errors: [
			{
				message: spokeMessage(
					'points at "../nowhere", which does not resolve',
					".cursor/rules/backend/inner",
					RULES_HUB,
				),
				file: ".cursor/rules/backend/inner",
			},
		],
	},
	{
		name: "a declared spoke two subfolders down is left to its own check",
		files: {
			".agents/rules/a/b/x.md": "# X\n",
			".agents/rules/a/b/y.md": "# Y\n",
			".agents/rules/a/z.md": "# Z\n",
		},
		symlinks: {
			".cursor/rules/a/b/x.mdc": "../../../../.agents/rules/a/b/x.md",
		},
		surface: cursorSurface({ spokes: [CURSOR_SPOKE, ".cursor/rules/a/b"] }),
		errors: [
			{
				message: itemMessage(
					".cursor/rules/a/b/a",
					missingMessage(".agents/rules/a"),
					".cursor/rules/a/b",
					RULES_HUB,
				),
				file: ".cursor/rules/a/b/a",
			},
			{
				message: cursorMessage(
					".cursor/rules/a/z.mdc",
					missingMessage(".agents/rules/a/z.md"),
				),
				file: ".cursor/rules/a/z.mdc",
			},
		],
	},
];

runRuleTests(hubSymlinks, {
	valid: [
		{
			name: "a directory-level spoke with a relative target, committed, is valid",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.agents/skills" },
			surface: HUB_SURFACE,
		},
		{
			name: "a spoke without a declared position is ignored, even though it does not exist",
			files: HUB_FILES,
			surface: { root: HUB, undeclaredSpokes: [SPOKE] },
		},
		{
			name: "an undeclared spoke is ignored next to a declared one that is fine",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.agents/skills" },
			surface: {
				root: HUB,
				spokes: [SPOKE],
				undeclaredSpokes: [".cursor/skills"],
			},
		},
		{
			name: "a surface without spokes is a no-op",
			files: HUB_FILES,
			surface: { root: HUB },
		},
		{
			name: "no spokes and no documents anywhere is a no-op",
			files: { "notes.txt": "not a document\n" },
			surface: { root: "." },
		},
		{
			name: "a spoke reached through a committed ancestor symlink is valid",
			files: HUB_FILES,
			symlinks: { ".claude": ".agents" },
			surface: HUB_SURFACE,
		},
		{
			name: "the nearest symlinked ancestor is found past a real directory under it",
			files: { ".agents/deep/skills/demo/SKILL.md": "# Demo\n" },
			symlinks: { x: ".agents" },
			surface: { root: ".agents/deep/skills", spokes: ["x/deep/skills"] },
		},
		{
			name: "a hub reached through a symlinked path is compared by its real path",
			files: { "real-agents/skills/demo/SKILL.md": "# Demo\n" },
			symlinks: {
				".agents": "real-agents",
				[SPOKE]: "../real-agents/skills",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a spoke that goes through the symlinked hub path is also the hub",
			files: { "real-agents/skills/demo/SKILL.md": "# Demo\n" },
			symlinks: {
				".agents": "real-agents",
				[SPOKE]: "../.agents/skills",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "an item-level spoke with a committed relative link per hub item is valid",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			surface: HUB_SURFACE,
		},
		{
			name: "an item link that resolves through a chain of links to the hub item is valid",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/foo`]: "../../via-foo",
				"via-foo": ".agents/skills/foo",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a README and a .DS_Store in an item-level spoke are not entries",
			files: {
				...ITEM_FILES,
				[`${SPOKE}/README.md`]: "# Spoke\n",
				[`${SPOKE}/.DS_Store`]: "junk\n",
			},
			symlinks: ITEM_LINKS,
			surface: HUB_SURFACE,
		},
		{
			name: "a hub entry at the hub root needs a file link, and has one",
			files: { ".agents/rules/a.mdc": "# A\n" },
			symlinks: { ".cursor/rules/a.mdc": "../../.agents/rules/a.mdc" },
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				spokes: [".cursor/rules"],
			},
		},
		{
			name: "a nested hub entry makes its top directory the item, and one link to it suffices",
			files: { ".agents/skills/group/foo/SKILL.md": "# Foo\n" },
			symlinks: { [`${SPOKE}/group`]: "../../.agents/skills/group" },
			surface: HUB_SURFACE,
		},
		{
			name: "two item-level spokes on one surface are each complete",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				".cursor/skills/foo": "../../.agents/skills/foo",
				".cursor/skills/bar": "../../.agents/skills/bar",
			},
			surface: { root: HUB, spokes: [SPOKE, ".cursor/skills"] },
		},
		{
			name: "an item-level spoke of a hub reached through a symlinked path compares real paths",
			files: { "real-agents/skills/foo/SKILL.md": "# Foo\n" },
			symlinks: {
				".agents": "real-agents",
				[`${SPOKE}/foo`]: "../../.agents/skills/foo",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a nested declared spoke is checked on its own, not as an entry of the outer one",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/inner/foo`]: "../../../.agents/skills/foo",
				[`${SPOKE}/inner/bar`]: "../../../.agents/skills/bar",
			},
			surface: { root: HUB, spokes: [SPOKE, `${SPOKE}/inner`] },
		},
		{
			name: "a nested declared spoke that is a directory-level link is not an unexpected symlink of the outer one",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/inner`]: "../../.agents/skills",
			},
			surface: { root: HUB, spokes: [SPOKE, `${SPOKE}/inner`] },
		},
		{
			name: "content an item-level spoke holds that the surface's own ignore skips is not reported",
			files: { ...ITEM_FILES, [`${SPOKE}/local/SKILL.md`]: "# Local\n" },
			symlinks: ITEM_LINKS,
			surface: { root: HUB, spokes: [SPOKE], ignore: ["local/**"] },
		},
		{
			name: "content an item-level spoke holds that the top-level ignore skips, matched from the repository root, is not reported",
			files: { ...ITEM_FILES, [`${SPOKE}/local/SKILL.md`]: "# Local\n" },
			symlinks: ITEM_LINKS,
			ignore: [`${SPOKE}/local/**`],
			surface: HUB_SURFACE,
		},
		{
			name: "an item-level spoke with no hub item at all has nothing to link",
			files: {
				".agents/skills/foo/README.md": "# Not an entry document\n",
				[`${SPOKE}/README.md`]: "# Spoke\n",
			},
			surface: { root: HUB, spokes: [SPOKE] },
		},
		{
			name: "a spoke under a committed ancestor link is looked up where git records it, under the ancestor's target",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.agents/skills", ".cursor": ".claude" },
			surface: { root: HUB, spokes: [SPOKE, ".cursor/skills"] },
		},
		{
			name: "an item-level spoke under a committed ancestor link finds each item link under the ancestor's target",
			files: ITEM_FILES,
			symlinks: { ...ITEM_LINKS, ".cursor": ".claude" },
			surface: { root: HUB, spokes: [".cursor/skills"] },
		},
		{
			name: "a spoke under a package's committed link to the root's directory is not reported as untracked",
			files: HUB_FILES,
			symlinks: {
				[SPOKE]: "../.agents/skills",
				"packages/app/.claude": "../../.claude",
			},
			surface: { root: HUB, spokes: ["packages/app/.claude/skills"] },
		},
		{
			name: "the top-level ignore is matched from the repository root for real content and for a link's content alike",
			files: {
				...ITEM_FILES,
				[`${SPOKE}/wip/SKILL.md`]: "# Wip\n",
				"shared/SKILL.md": "# Shared\n",
			},
			symlinks: {
				...ITEM_LINKS,
				".cursor/skills/foo": "../../.agents/skills/foo",
				".cursor/skills/bar": "../../.agents/skills/bar",
				".cursor/skills/wip": "../../shared",
			},
			ignore: [`${SPOKE}/wip/**`, ".cursor/skills/wip/**"],
			surface: { root: HUB, spokes: [SPOKE, ".cursor/skills"] },
		},
		{
			name: "the surface's own ignore is matched from the spoke's root, mirrored onto every spoke, for real content and for a link's content alike",
			files: {
				...ITEM_FILES,
				[`${SPOKE}/wip/SKILL.md`]: "# Wip\n",
				"shared/SKILL.md": "# Shared\n",
			},
			symlinks: {
				...ITEM_LINKS,
				".cursor/skills/foo": "../../.agents/skills/foo",
				".cursor/skills/bar": "../../.agents/skills/bar",
				".cursor/skills/wip": "../../shared",
			},
			surface: {
				root: HUB,
				spokes: [SPOKE, ".cursor/skills"],
				ignore: ["wip/**"],
			},
		},
		{
			name: "real content an item-level spoke holds that git does not track is not reported",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: { files: { [`${SPOKE}/personal/SKILL.md`]: "# Personal\n" } },
			surface: HUB_SURFACE,
		},
		{
			// a link to a hub directory without an entry document lints as nothing
			name: "a link to a hub directory without an entry document is not a hub item, and is left alone",
			files: {
				...ITEM_FILES,
				".agents/skills/empty/README.md": "# No entry document\n",
			},
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/empty`]: "../../.agents/skills/empty",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a dangling stray link that git does not track is not reported, where a committed one is",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: { symlinks: { [`${SPOKE}/ghost`]: "../../nowhere" } },
			surface: HUB_SURFACE,
		},
		{
			name: "a second link to a hub item that git does not track is not reported, where a committed one is",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: {
				symlinks: { [`${SPOKE}/foo-too`]: "../../.agents/skills/foo" },
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a stray link to a directory the include matches nothing in is left alone",
			files: { ...ITEM_FILES, "other/README.md": "# Other\n" },
			symlinks: { ...ITEM_LINKS, [`${SPOKE}/other`]: "../../other" },
			surface: HUB_SURFACE,
		},
		{
			name: "a stray link to a directory whose documents a surface already lints is left alone",
			files: {
				...ITEM_FILES,
				".agents/skills/foo/sub/SKILL.md": "# Sub\n",
			},
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/sub`]: "../../.agents/skills/foo/sub",
			},
			surface: HUB_SURFACE,
		},
		{
			name: "a stray link to a file a surface or top-level ignore skips is left alone",
			files: { ".agents/rules/a.mdc": "# A\n", "elsewhere/x.mdc": "# X\n" },
			symlinks: {
				".cursor/rules/a.mdc": "../../.agents/rules/a.mdc",
				".cursor/rules/skip-surface.mdc": "../../elsewhere/x.mdc",
				".cursor/rules/skip-top.mdc": "../../elsewhere/x.mdc",
			},
			ignore: [".cursor/rules/skip-top.mdc"],
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				ignore: ["skip-surface.mdc"],
				spokes: [".cursor/rules"],
			},
		},
		{
			name: "a stray link to a file the include matches by name but whose target it does not is left alone",
			files: { ".agents/rules/a.mdc": "# A\n", "notes/x.md": "# X\n" },
			symlinks: {
				".cursor/rules/a.mdc": "../../.agents/rules/a.mdc",
				".cursor/rules/extra.mdc": "../../notes/x.md",
			},
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				spokes: [".cursor/rules"],
			},
		},
		{
			name: "a stray link to a file whose own name the include does not match is left alone",
			files: { ".agents/rules/a.mdc": "# A\n", "notes/x.mdc": "# X\n" },
			symlinks: {
				".cursor/rules/a.mdc": "../../.agents/rules/a.mdc",
				".cursor/rules/notes.md": "../../notes/x.mdc",
			},
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				spokes: [".cursor/rules"],
			},
		},
		...CURSOR_VALID,
	],
	invalid: [
		{
			name: "a spoke that does not exist",
			files: HUB_FILES,
			surface: HUB_SURFACE,
			errors: [{ message: spokeMessage("does not exist"), file: SPOKE }],
		},
		{
			name: "a link to another directory inside the repository is not at the hub",
			files: { ...HUB_FILES, "other/README.md": "# Other\n" },
			symlinks: { [SPOKE]: "../other" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage('points at "other", not at the hub'),
					file: SPOKE,
				},
			],
		},
		{
			name: "a dangling link does not resolve",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../nowhere" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						'points at "../nowhere", which does not resolve',
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "a link that resolves outside the linted directory",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.." },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						'points at "../..", which is outside the linted directory',
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "a dangling link that also leaves the tree is reported once, as not resolving",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../../nowhere-at-all" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						'points at "../../nowhere-at-all", which does not resolve',
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "a symlink on disk that git does not track",
			files: HUB_FILES,
			worktree: { symlinks: { [SPOKE]: "../.agents/skills" } },
			surface: HUB_SURFACE,
			errors: [
				{ message: NOT_COMMITTED("it is not tracked by git"), file: SPOKE },
			],
		},
		{
			name: "a symlink on disk that git tracks as a regular file",
			files: { ...HUB_FILES, [SPOKE]: "placeholder\n" },
			worktree: {
				remove: [SPOKE],
				symlinks: { [SPOKE]: "../.agents/skills" },
			},
			surface: HUB_SURFACE,
			errors: [
				{
					message: NOT_COMMITTED("git tracks it as a regular file"),
					file: SPOKE,
				},
			],
		},
		{
			name: "an uncommitted link that also points elsewhere is reported for both",
			files: { ...HUB_FILES, "other/README.md": "# Other\n" },
			worktree: { symlinks: { [SPOKE]: "../other" } },
			surface: HUB_SURFACE,
			errors: [
				{ message: NOT_COMMITTED("it is not tracked by git"), file: SPOKE },
				{
					message: spokeMessage('points at "other", not at the hub'),
					file: SPOKE,
				},
			],
		},
		{
			name: "a spoke that is a regular file",
			files: { ...HUB_FILES, [SPOKE]: "not a directory\n" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						"is neither a directory nor a symlink (it is a regular file)",
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "an ancestor symlink that git does not track",
			files: HUB_FILES,
			worktree: { symlinks: { ".claude": ".agents" } },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						'is reached through ".claude", which is not committed as a symlink (it is not tracked by git)',
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "an ancestor symlink that git tracks as a regular file",
			files: { ...HUB_FILES, ".claude": "placeholder\n" },
			worktree: { remove: [".claude"], symlinks: { ".claude": ".agents" } },
			surface: HUB_SURFACE,
			errors: [
				{
					message: spokeMessage(
						'is reached through ".claude", which is not committed as a symlink (git tracks it as a regular file)',
					),
					file: SPOKE,
				},
			],
		},
		{
			name: "the ancestor named is the nearest symlinked one",
			files: { ".agents/deep/skills/demo/SKILL.md": "# Demo\n" },
			worktree: { symlinks: { x: ".agents" } },
			surface: { root: ".agents/deep/skills", spokes: ["x/deep/skills"] },
			errors: [
				{
					message: spokeMessage(
						'is reached through "x", which is not committed as a symlink (it is not tracked by git)',
						"x/deep/skills",
						".agents/deep/skills",
					),
					file: "x/deep/skills",
				},
			],
		},
		{
			name: "a real directory that is not the hub is item-level: a real copy of a hub item is reported",
			files: {
				...HUB_FILES,
				".claude/skills/demo/SKILL.md": "# Demo\n",
			},
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/demo`,
						'is a copy, not a link to the hub item ".agents/skills/demo"',
					),
					file: `${SPOKE}/demo`,
				},
			],
		},
		{
			name: "an item-level spoke missing the link for one item reports that item",
			files: ITEM_FILES,
			symlinks: { [`${SPOKE}/bar`]: "../../.agents/skills/bar" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'does not exist, but ".agents/skills/foo" is a hub item that needs a link there',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "a real copy where the hub has an item is not a link to it",
			files: { ...ITEM_FILES, [`${SPOKE}/foo/SKILL.md`]: "# Forked foo\n" },
			symlinks: { [`${SPOKE}/bar`]: "../../.agents/skills/bar" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'is a copy, not a link to the hub item ".agents/skills/foo"',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "a real file where the hub has an item is a copy too",
			files: { ...ITEM_FILES, [`${SPOKE}/foo`]: "not a link\n" },
			symlinks: { [`${SPOKE}/bar`]: "../../.agents/skills/bar" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'is a copy, not a link to the hub item ".agents/skills/foo"',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "a dangling link that is not a hub item does not resolve",
			files: ITEM_FILES,
			symlinks: { ...ITEM_LINKS, [`${SPOKE}/ghost`]: "../../nowhere" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/ghost`,
						'is a symlink, but "ghost" is not a hub item (it points at "../../nowhere", which does not resolve)',
					),
					file: `${SPOKE}/ghost`,
				},
			],
		},
		{
			name: "a link that is not a hub item and leaves the linted directory says so",
			files: ITEM_FILES,
			symlinks: { ...ITEM_LINKS, [`${SPOKE}/out`]: "../../.." },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/out`,
						'is a symlink, but "out" is not a hub item (it points at "../../..", which is outside the linted directory)',
					),
					file: `${SPOKE}/out`,
				},
			],
		},
		{
			name: "an item link that dangles does not resolve",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/foo`]: "../../.agents/skills/gone",
			},
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'points at "../../.agents/skills/gone", which does not resolve',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "an item link that leaves the linted directory is outside",
			files: ITEM_FILES,
			symlinks: { ...ITEM_LINKS, [`${SPOKE}/foo`]: "../../.." },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'points at "../../..", which is outside the linted directory',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "an item link to another hub item is not at its own item",
			files: ITEM_FILES,
			symlinks: { ...ITEM_LINKS, [`${SPOKE}/foo`]: "../../.agents/skills/bar" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						'points at ".agents/skills/bar", not at the hub item ".agents/skills/foo"',
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "an item link on disk that git does not track",
			files: ITEM_FILES,
			symlinks: { [`${SPOKE}/bar`]: "../../.agents/skills/bar" },
			worktree: { symlinks: { [`${SPOKE}/foo`]: "../../.agents/skills/foo" } },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo`,
						"is not committed as a symlink (it is not tracked by git)",
					),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "a hub item git does not track yet still needs its link, because discovery reads the disk",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: { files: { ".agents/skills/baz/SKILL.md": "# Baz\n" } },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/baz`,
						'does not exist, but ".agents/skills/baz" is a hub item that needs a link there',
					),
					file: `${SPOKE}/baz`,
				},
			],
		},
		{
			name: "spoke-only content the surface would lint is linted by no surface",
			files: { ...ITEM_FILES, [`${SPOKE}/local/SKILL.md`]: "# Local\n" },
			symlinks: ITEM_LINKS,
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(`${SPOKE}/local`, UNLINTED),
					file: `${SPOKE}/local`,
				},
			],
		},
		{
			name: "a spoke-only file the include would match is reported at the file",
			files: {
				".agents/rules/a.md": "# A\n",
				".claude/rules/notes.md": "# Notes\n",
				".claude/rules/README.txt": "not matched by the include\n",
			},
			symlinks: { ".claude/rules/a.md": "../../.agents/rules/a.md" },
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				include: ["**/*.md"],
				spokes: [".claude/rules"],
			},
			errors: [
				{
					message: itemMessage(
						".claude/rules/notes.md",
						UNLINTED,
						".claude/rules",
						".agents/rules",
					),
					file: ".claude/rules/notes.md",
				},
			],
		},
		{
			name: "a hub entry at the hub root with no file link in the spoke",
			files: {
				".agents/rules/a.mdc": "# A\n",
				".cursor/rules/README.md": "# Rules\n",
			},
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				spokes: [".cursor/rules"],
			},
			errors: [
				{
					message: itemMessage(
						".cursor/rules/a.mdc",
						'does not exist, but ".agents/rules/a.mdc" is a hub item that needs a link there',
						".cursor/rules",
						".agents/rules",
					),
					file: ".cursor/rules/a.mdc",
				},
			],
		},
		{
			name: "a nested hub entry needs its top directory linked, not its own path",
			files: { ".agents/skills/group/foo/SKILL.md": "# Foo\n" },
			symlinks: { [`${SPOKE}/other`]: "../../.agents/skills/group" },
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/group`,
						'does not exist, but ".agents/skills/group" is a hub item that needs a link there',
					),
					file: `${SPOKE}/group`,
				},
				{
					message: itemMessage(
						`${SPOKE}/other`,
						'is a second link to the hub item ".agents/skills/group"',
					),
					file: `${SPOKE}/other`,
				},
			],
		},
		{
			name: "two item-level spokes on one surface are judged independently",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				".cursor/skills/foo": "../../.agents/skills/foo",
			},
			surface: { root: HUB, spokes: [SPOKE, ".cursor/skills"] },
			errors: [
				{
					message: itemMessage(
						".cursor/skills/bar",
						'does not exist, but ".agents/skills/bar" is a hub item that needs a link there',
						".cursor/skills",
					),
					file: ".cursor/skills/bar",
				},
			],
		},
		{
			name: "a nested declared spoke reports its own unexpected content once, under its own name",
			files: {
				...ITEM_FILES,
				[`${SPOKE}/inner/local/SKILL.md`]: "# Local\n",
			},
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/inner/foo`]: "../../../.agents/skills/foo",
				[`${SPOKE}/inner/bar`]: "../../../.agents/skills/bar",
			},
			surface: { root: HUB, spokes: [SPOKE, `${SPOKE}/inner`] },
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/inner/local`,
						UNLINTED,
						`${SPOKE}/inner`,
					),
					file: `${SPOKE}/inner/local`,
				},
			],
		},
		{
			name: "an uncommitted ancestor link is reported once for an item-level spoke, not once per item link",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: { symlinks: { ".cursor": ".claude" } },
			surface: { root: HUB, spokes: [".cursor/skills"] },
			errors: [
				{
					message: spokeMessage(
						'is reached through ".cursor", which is not committed as a symlink (it is not tracked by git)',
						".cursor/skills",
					),
					file: ".cursor/skills",
				},
			],
		},
		{
			name: "an uncommitted ancestor link is reported once for a link spoke too, not as the spoke being untracked",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.agents/skills" },
			worktree: { symlinks: { ".cursor": ".claude" } },
			surface: { root: HUB, spokes: [".cursor/skills"] },
			errors: [
				{
					message: spokeMessage(
						'is reached through ".cursor", which is not committed as a symlink (it is not tracked by git)',
						".cursor/skills",
					),
					file: ".cursor/skills",
				},
			],
		},
		{
			name: "with two nested symlinked ancestors the nearest is the one named",
			files: {
				"real-deep/skills/demo/SKILL.md": "# Demo\n",
				".agents/notes.txt": "keeps the directory\n",
			},
			worktree: {
				symlinks: { x: ".agents", ".agents/deep": "../real-deep" },
			},
			surface: { root: "real-deep/skills", spokes: ["x/deep/skills"] },
			errors: [
				{
					message: spokeMessage(
						'is reached through "x/deep", which is not committed as a symlink (it is not tracked by git)',
						"x/deep/skills",
						"real-deep/skills",
					),
					file: "x/deep/skills",
				},
			],
		},
		{
			name: "a spoke recorded as a link in the index but a regular file on disk names both causes",
			files: HUB_FILES,
			symlinks: { [SPOKE]: "../.agents/skills" },
			worktree: {
				remove: [SPOKE],
				files: { [SPOKE]: "../.agents/skills" },
			},
			surface: HUB_SURFACE,
			errors: [{ message: spokeMessage(CHECKED_OUT_AS_FILE), file: SPOKE }],
		},
		{
			name: "an item link recorded as a link in the index but a regular file on disk names both causes",
			files: ITEM_FILES,
			symlinks: ITEM_LINKS,
			worktree: {
				remove: [`${SPOKE}/foo`],
				files: { [`${SPOKE}/foo`]: "../../.agents/skills/foo" },
			},
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(`${SPOKE}/foo`, CHECKED_OUT_AS_FILE),
					file: `${SPOKE}/foo`,
				},
			],
		},
		{
			name: "a second link to a hub item under another name is an alias",
			files: ITEM_FILES,
			symlinks: {
				...ITEM_LINKS,
				[`${SPOKE}/foo-too`]: "../../.agents/skills/foo",
			},
			surface: HUB_SURFACE,
			errors: [
				{
					message: itemMessage(
						`${SPOKE}/foo-too`,
						'is a second link to the hub item ".agents/skills/foo"',
					),
					file: `${SPOKE}/foo-too`,
				},
			],
		},
		{
			name: "a top-level ignore written from the spoke's root suppresses nothing: it is read from the repository root",
			files: {
				...ITEM_FILES,
				[`${SPOKE}/wip/SKILL.md`]: "# Wip\n",
				"shared/SKILL.md": "# Shared\n",
			},
			symlinks: {
				...ITEM_LINKS,
				".cursor/skills/foo": "../../.agents/skills/foo",
				".cursor/skills/bar": "../../.agents/skills/bar",
				".cursor/skills/wip": "../../shared",
			},
			ignore: ["wip/**"],
			surface: { root: HUB, spokes: [SPOKE, ".cursor/skills"] },
			errors: [
				{
					message: itemMessage(`${SPOKE}/wip`, UNLINTED),
					file: `${SPOKE}/wip`,
				},
				{
					message: itemMessage(
						".cursor/skills/wip",
						strayLinkMessage("wip", "shared"),
						".cursor/skills",
					),
					file: ".cursor/skills/wip",
				},
			],
		},
		{
			name: "a stray link to a file the surface would lint by name is linted by no surface",
			files: { ".agents/rules/a.mdc": "# A\n", "elsewhere/x.mdc": "# X\n" },
			symlinks: {
				".cursor/rules/a.mdc": "../../.agents/rules/a.mdc",
				".cursor/rules/extra.mdc": "../../elsewhere/x.mdc",
			},
			surface: {
				root: ".agents/rules",
				kind: "rules",
				dialects: ["cursor"],
				spokes: [".cursor/rules"],
			},
			errors: [
				{
					message: itemMessage(
						".cursor/rules/extra.mdc",
						strayLinkMessage("extra.mdc", "elsewhere/x.mdc"),
						".cursor/rules",
						".agents/rules",
					),
					file: ".cursor/rules/extra.mdc",
				},
			],
		},
		{
			name: "a nested spoke beneath a stray link exempts that link only, never a link whose name it merely starts with",
			files: {
				...ITEM_FILES,
				"shared-a/SKILL.md": "# A\n",
				"shared-ab/SKILL.md": "# Ab\n",
			},
			symlinks: {
				...ITEM_LINKS,
				"shared-ab/inner": "../.agents/skills",
				[`${SPOKE}/a`]: "../../shared-a",
				[`${SPOKE}/ab`]: "../../shared-ab",
			},
			surface: { root: HUB, spokes: [SPOKE, `${SPOKE}/ab/inner`] },
			errors: [
				{
					message: itemMessage(`${SPOKE}/a`, strayLinkMessage("a", "shared-a")),
					file: `${SPOKE}/a`,
				},
			],
		},
		...CURSOR_INVALID,
	],
});

// --- what a fixture cannot state: absolute targets, order, other git modes, special files ---

interface Checkout {
	readonly dir: string;
}

async function withCheckout(
	setup: (dir: string) => Promise<void>,
	body: (checkout: Checkout) => Promise<void>,
): Promise<void> {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-hub-symlinks-")),
	);
	try {
		await setup(dir);
		await gitInitAndCommit(dir);
		await body({ dir });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeTree(
	dir: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content, "utf8");
	}
}

async function link(dir: string, path: string, target: string): Promise<void> {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await symlink(target, join(dir, path));
}

function surfaceOf(root: string, spokes: readonly string[]): ResolvedSurface {
	return freezeSurface({
		root,
		kind: "skills",
		dialects: ["generic"],
		include: DEFAULT_INCLUDE.skills,
		ignore: [],
		spokes: spokes.map((path) => ({ path, loc: { line: 1, col: 1 } })),
		rules: sealMap(new Map()),
	});
}

function rulesSurfaceOf(
	root: string,
	spokes: readonly string[],
	include: readonly string[] = ["**/*.md"],
): ResolvedSurface {
	return freezeSurface({
		root,
		kind: "rules",
		dialects: ["cursor"],
		include,
		ignore: [],
		spokes: spokes.map((path) => ({ path, loc: { line: 1, col: 1 } })),
		rules: sealMap(new Map()),
	});
}

async function documentsOf(
	dir: string,
	surface: ResolvedSurface,
	paths: readonly string[],
): Promise<readonly Document[]> {
	return Promise.all(paths.map((path) => readDocument(dir, { path, surface })));
}

function contextOf(
	dir: string,
	surfaces: readonly ResolvedSurface[],
	modes?: ReadonlyMap<string, string>,
	documents: readonly Document[] = [],
): RepoRuleContext {
	const capabilities = createCapabilities(dir, async () => documents);
	return {
		...capabilities,
		git:
			modes === undefined
				? capabilities.git
				: { ...capabilities.git, trackedModes: async () => modes },
		options: undefined,
		surfaces,
	};
}

function report(text: string, spoke = SPOKE, hub = HUB): RuleReport {
	return { message: spokeMessage(text, spoke, hub), file: spoke };
}

// Feature-detected like src/discover.test.ts does, not platform-string-checked: CI is
// case-sensitive Linux, local dev is case-insensitive macOS by default.
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

describe("hub/symlinks against a hand-built context", () => {
	test("an absolute target that resolves to the hub is reported as absolute, and only that", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, HUB_FILES);
				await link(dir, SPOKE, join(dir, ".agents", "skills"));
			},
			async ({ dir }) => {
				const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					report(
						`is a symlink with the absolute target "${join(dir, ".agents", "skills")}"; use a relative target so the link stays valid in every checkout`,
					),
				]);
			},
		);
	});

	test("an absolute target that does not resolve is reported as absolute, then as not resolving", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, HUB_FILES);
				await link(dir, SPOKE, join(dir, "nowhere"));
			},
			async ({ dir }) => {
				const target = join(dir, "nowhere");
				const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					report(
						`is a symlink with the absolute target "${target}"; use a relative target so the link stays valid in every checkout`,
					),
					report(`points at "${target}", which does not resolve`),
				]);
			},
		);
	});

	test("a spoke git tracks as a directory, swapped for a link on disk", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, { ...HUB_FILES, ".claude/skills/a.md": "# A\n" });
			},
			async ({ dir }) => {
				await rm(join(dir, SPOKE), { recursive: true });
				await link(dir, SPOKE, "../.agents/skills");
				const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					report(
						"is not committed as a symlink (git tracks it as a directory)",
					),
				]);
			},
		);
	});

	test("the other index modes git can hold are named, and an unknown one is quoted", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, HUB_FILES);
				await link(dir, SPOKE, "../.agents/skills");
			},
			async ({ dir }) => {
				const surfaces = [surfaceOf(HUB, [SPOKE])];
				const listing = (mode: string) => new Map([[SPOKE, mode]]);

				expect(
					await hubSymlinks.check(contextOf(dir, surfaces, listing("160000"))),
				).toStrictEqual([
					report(
						"is not committed as a symlink (git tracks it as a submodule)",
					),
				]);
				expect(
					await hubSymlinks.check(contextOf(dir, surfaces, listing("100755"))),
				).toStrictEqual([
					report(
						"is not committed as a symlink (git tracks it as a regular file)",
					),
				]);
				expect(
					await hubSymlinks.check(contextOf(dir, surfaces, listing("100664"))),
				).toStrictEqual([
					report(
						"is not committed as a symlink (git tracks it with mode 100664)",
					),
				]);
			},
		);
	});

	test.skipIf(process.platform === "win32")(
		"a spoke that is a special file is neither a directory nor a symlink",
		async () => {
			await withCheckout(
				(dir) => writeTree(dir, HUB_FILES),
				async ({ dir }) => {
					await mkdir(join(dir, ".claude"), { recursive: true });
					execFileSync("mkfifo", [join(dir, SPOKE)]);
					const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([
						report(
							"is neither a directory nor a symlink (it is a special file)",
						),
					]);
				},
			);
		},
	);

	test("an NFD-spelled spoke finds git's NFC listing of it", async () => {
		const nfc = ".claude/r\u00e9".normalize("NFC");
		const nfd = nfc.normalize("NFD");
		expect(nfd).not.toBe(nfc);
		await withCheckout(
			async (dir) => {
				await writeTree(dir, HUB_FILES);
				await link(dir, nfd, "../.agents/skills");
			},
			async ({ dir }) => {
				const ctx = contextOf(
					dir,
					[surfaceOf(HUB, [nfd])],
					new Map([[nfc, "120000"]]),
				);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("reports come in surface order, then declaration order, not path order", async () => {
		await withCheckout(
			(dir) =>
				writeTree(dir, {
					".agents/skills/demo/SKILL.md": "# Demo\n",
					".agents/rules/demo.mdc": "# Demo\n",
				}),
			async ({ dir }) => {
				const ctx = contextOf(dir, [
					surfaceOf(".agents/skills", [".z/skills", ".m/skills"]),
					surfaceOf(".agents/rules", [".a/rules"]),
				]);

				expect((await hubSymlinks.check(ctx)).map((r) => r.file)).toEqual([
					".z/skills",
					".m/skills",
					".a/rules",
				]);
			},
		);
	});

	test("the same spoke name under two hubs is judged against the hub it was declared on", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					".agents/skills/demo/SKILL.md": "# Demo\n",
					".agents/rules/demo.mdc": "# Demo\n",
				});
				await link(dir, ".claude/skills", "../.agents/skills");
				await link(dir, ".claude/rules", "../.agents/skills");
			},
			async ({ dir }) => {
				const ctx = contextOf(dir, [
					surfaceOf(".agents/skills", [".claude/skills"]),
					surfaceOf(".agents/rules", [".claude/rules"]),
				]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					report(
						'points at ".agents/skills", not at the hub',
						".claude/rules",
						".agents/rules",
					),
				]);
			},
		);
	});

	test("a surface with no declared spoke never asks git anything", async () => {
		await withCheckout(
			(dir) => writeTree(dir, HUB_FILES),
			async ({ dir }) => {
				const ctx: RepoRuleContext = {
					...contextOf(dir, [surfaceOf(HUB, [])]),
					git: {
						...createCapabilities(dir, async () => []).git,
						trackedModes: async () => {
							throw new Error("trackedModes must not be called");
						},
					},
				};

				expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("a spoke without a declared position, an untracked local link to the hub, is not reported and never asks git anything", async () => {
		await withCheckout(
			(dir) => writeTree(dir, HUB_FILES),
			async ({ dir }) => {
				await link(dir, SPOKE, "../.agents/skills");
				const detected = freezeSurface({
					root: HUB,
					kind: "skills",
					dialects: ["generic"],
					include: DEFAULT_INCLUDE.skills,
					ignore: [],
					spokes: [{ path: SPOKE }],
					rules: sealMap(new Map()),
				});
				const ctx: RepoRuleContext = {
					...contextOf(dir, [detected]),
					git: {
						...createCapabilities(dir, async () => []).git,
						trackedModes: async () => {
							throw new Error("trackedModes must not be called");
						},
					},
				};

				expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("a target whose text climbs above the linted directory is outside, even when it comes back in", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, HUB_FILES);
				await link(dir, SPOKE, `../../${basename(dir)}/.agents/skills`);
			},
			async ({ dir }) => {
				const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					report(
						`points at "../../${basename(dir)}/.agents/skills", which is outside the linted directory`,
					),
				]);
			},
		);
	});

	test("a link whose real parent directory is outside the linted directory is reported as outside", async () => {
		const outside = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-hub-symlinks-outside-")),
		);
		try {
			await withCheckout(
				async (dir) => {
					await writeTree(dir, HUB_FILES);
					await link(dir, ".claude", outside);
					await symlink("../.agents/skills", join(outside, "skills"));
				},
				async ({ dir }) => {
					const ctx = contextOf(dir, [surfaceOf(HUB, [SPOKE])]);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([
						report(
							`is itself outside the linted directory (its parent directory resolves to "../${basename(outside)}")`,
						),
					]);
				},
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("a spoke reached through an ancestor link that itself sits outside the linted directory says so", async () => {
		const outside = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-hub-symlinks-outside-")),
		);
		try {
			await withCheckout(
				async (dir) => {
					await writeTree(dir, HUB_FILES);
					await link(dir, "a", outside);
					await symlink(join(dir, ".agents"), join(outside, "b"));
				},
				async ({ dir }) => {
					const ctx = contextOf(dir, [surfaceOf(HUB, ["a/b/skills"])]);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([
						report(
							'is reached through "a/b", which is itself outside the linted directory',
							"a/b/skills",
						),
					]);
				},
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("hub/symlinks item-level spokes against a hand-built context", () => {
	const ITEM_PATHS = [
		".agents/skills/foo/SKILL.md",
		".agents/skills/bar/SKILL.md",
	];

	test("an absolute item target that resolves to the hub item is reported as absolute, and only that", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, ITEM_FILES);
				await link(dir, `${SPOKE}/foo`, join(dir, ".agents", "skills", "foo"));
				await link(dir, `${SPOKE}/bar`, "../../.agents/skills/bar");
			},
			async ({ dir }) => {
				const surface = surfaceOf(HUB, [SPOKE]);
				const ctx = contextOf(
					dir,
					[surface],
					undefined,
					await documentsOf(dir, surface, ITEM_PATHS),
				);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					{
						message: itemMessage(
							`${SPOKE}/foo`,
							`is a symlink with the absolute target "${join(dir, ".agents", "skills", "foo")}"; use a relative target so the link stays valid in every checkout`,
						),
						file: `${SPOKE}/foo`,
					},
				]);
			},
		);
	});

	test("an NFD-spelled item finds git's NFC listing of its link", async () => {
		const nfc = "r\u00e9".normalize("NFC");
		const nfd = nfc.normalize("NFD");
		expect(nfd).not.toBe(nfc);
		await withCheckout(
			async (dir) => {
				await writeTree(dir, { [`.agents/skills/${nfd}/SKILL.md`]: "# R\n" });
				await link(dir, `${SPOKE}/${nfd}`, `../../.agents/skills/${nfd}`);
			},
			async ({ dir }) => {
				const surface = surfaceOf(HUB, [SPOKE]);
				const ctx = contextOf(
					dir,
					[surface],
					new Map([[`${SPOKE}/${nfc}`, "120000"]]),
					await documentsOf(dir, surface, [`.agents/skills/${nfd}/SKILL.md`]),
				);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test.skipIf(process.platform === "win32")(
		"a special file where the hub has an item is neither a copy nor a link",
		async () => {
			await withCheckout(
				async (dir) => {
					await writeTree(dir, ITEM_FILES);
					await link(dir, `${SPOKE}/bar`, "../../.agents/skills/bar");
				},
				async ({ dir }) => {
					execFileSync("mkfifo", [join(dir, SPOKE, "foo")]);
					const surface = surfaceOf(HUB, [SPOKE]);
					const ctx = contextOf(
						dir,
						[surface],
						undefined,
						await documentsOf(dir, surface, ITEM_PATHS),
					);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([
						{
							message: itemMessage(
								`${SPOKE}/foo`,
								'is a special file, not a link to the hub item ".agents/skills/foo"',
							),
							file: `${SPOKE}/foo`,
						},
					]);
				},
			);
		},
	);

	test("reports come in spoke order, then entry name order, items and strays interleaved", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					".agents/skills/a/SKILL.md": "# A\n",
					".agents/skills/b/SKILL.md": "# B\n",
					".agents/skills/d/SKILL.md": "# D\n",
				});
				for (const spoke of [".z/skills", ".m/skills"]) {
					await link(dir, `${spoke}/b`, "../../.agents/skills/a");
					await link(dir, `${spoke}/c`, "../../.agents/skills/a");
				}
			},
			async ({ dir }) => {
				const surface = surfaceOf(HUB, [".z/skills", ".m/skills"]);
				const ctx = contextOf(
					dir,
					[surface],
					undefined,
					await documentsOf(dir, surface, [
						".agents/skills/d/SKILL.md",
						".agents/skills/b/SKILL.md",
						".agents/skills/a/SKILL.md",
					]),
				);

				expect((await hubSymlinks.check(ctx)).map((r) => r.file)).toEqual([
					".z/skills/a",
					".z/skills/b",
					".z/skills/c",
					".z/skills/d",
					".m/skills/a",
					".m/skills/b",
					".m/skills/c",
					".m/skills/d",
				]);
			},
		);
	});

	test("content another surface's documents already lint is not reported as linted by no surface", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					...ITEM_FILES,
					[`${SPOKE}/local/SKILL.md`]: "# Local\n",
				});
				await link(dir, `${SPOKE}/foo`, "../../.agents/skills/foo");
				await link(dir, `${SPOKE}/bar`, "../../.agents/skills/bar");
			},
			async ({ dir }) => {
				const hubSurface = surfaceOf(HUB, [SPOKE]);
				const spokeSurface = surfaceOf(SPOKE, []);
				const ctx = contextOf(dir, [hubSurface, spokeSurface], undefined, [
					...(await documentsOf(dir, hubSurface, ITEM_PATHS)),
					...(await documentsOf(dir, spokeSurface, [
						`${SPOKE}/local/SKILL.md`,
					])),
				]);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("a stray link whose target text climbs above the linted directory is outside, even when it comes back in", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					...ITEM_FILES,
					"shared/README.md": "# Shared\n",
				});
				await link(dir, `${SPOKE}/foo`, "../../.agents/skills/foo");
				await link(dir, `${SPOKE}/bar`, "../../.agents/skills/bar");
				await link(dir, `${SPOKE}/back`, `../../../${basename(dir)}/shared`);
			},
			async ({ dir }) => {
				const surface = surfaceOf(HUB, [SPOKE]);
				const ctx = contextOf(
					dir,
					[surface],
					undefined,
					await documentsOf(dir, surface, ITEM_PATHS),
				);

				expect(await hubSymlinks.check(ctx)).toStrictEqual([
					{
						message: itemMessage(
							`${SPOKE}/back`,
							`is a symlink, but "back" is not a hub item (it points at "../../../${basename(dir)}/shared", which is outside the linted directory)`,
						),
						file: `${SPOKE}/back`,
					},
				]);
			},
		);
	});

	test.skipIf(process.platform !== "darwin")(
		"an item and its link match whichever Unicode form each is spelled in",
		async () => {
			const nfdItem = "r\u00e9".normalize("NFD");
			const nfcItem = "caf\u00e9".normalize("NFC");
			const nfcLink = nfdItem.normalize("NFC");
			const nfdLink = nfcItem.normalize("NFD");
			expect(nfcLink).not.toBe(nfdItem);
			expect(nfdLink).not.toBe(nfcItem);
			await withCheckout(
				async (dir) => {
					await writeTree(dir, {
						[`.agents/skills/${nfdItem}/SKILL.md`]: "# R\n",
						[`.agents/skills/${nfcItem}/SKILL.md`]: "# C\n",
					});
					await link(
						dir,
						`${SPOKE}/${nfcLink}`,
						`../../.agents/skills/${nfdItem}`,
					);
					await link(
						dir,
						`${SPOKE}/${nfdLink}`,
						`../../.agents/skills/${nfcItem}`,
					);
				},
				async ({ dir }) => {
					const surface = surfaceOf(HUB, [SPOKE]);
					const ctx = contextOf(
						dir,
						[surface],
						undefined,
						await documentsOf(dir, surface, [
							`.agents/skills/${nfdItem}/SKILL.md`,
							`.agents/skills/${nfcItem}/SKILL.md`,
						]),
					);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([]);
				},
			);
		},
	);
});

// --- end to end: a spoke WRITTEN in skillslurp.json is what arms the rule ---

describe("hub/symlinks in a Cursor spoke against a hand-built context", () => {
	test("linkNameFor replaces the last extension, appends one when there is none, and compares case-sensitively", () => {
		const names: Readonly<Record<string, string>> = {
			"a.md": "a.mdc",
			"a.b.md": "a.b.mdc",
			"a.mdc": "a.mdc",
			a: "a.mdc",
			".md": ".md.mdc",
			"A.MDC": "A.mdc",
			"a.": "a.mdc",
		};
		for (const [item, expected] of Object.entries(names)) {
			expect([item, linkNameFor(item, ".mdc")]).toEqual([item, expected]);
		}
	});

	test("item reports come in the order of the names they carry, not of the hub's names", async () => {
		const hubNames = ["a.md", "a.mda.md"];
		const linkNames = hubNames.map((name) => linkNameFor(name, ".mdc"));
		expect([...hubNames].sort()).toEqual(hubNames);
		expect([...linkNames].sort()).not.toEqual(linkNames);

		await withCheckout(
			(dir) =>
				writeTree(dir, {
					".agents/rules/a.md": "# A\n",
					".agents/rules/a.mda.md": "# A2\n",
					".cursor/rules/README.md": "# Rules\n",
				}),
			async ({ dir }) => {
				const surface = rulesSurfaceOf(RULES_HUB, [CURSOR_SPOKE]);
				const ctx = contextOf(
					dir,
					[surface],
					undefined,
					await documentsOf(dir, surface, [
						".agents/rules/a.mda.md",
						".agents/rules/a.md",
					]),
				);

				expect((await hubSymlinks.check(ctx)).map((r) => r.file)).toEqual([
					".cursor/rules/a.mda.mdc",
					".cursor/rules/a.mdc",
				]);
			},
		);
	});

	test.skipIf(!CASE_INSENSITIVE_FS)(
		"on a case-insensitive filesystem, a real subfolder that differs from the hub folder only in case is not mirrored",
		async () => {
			await withCheckout(
				async (dir) => {
					await writeTree(dir, { ".agents/rules/backend/x.md": "# X\n" });
					await link(
						dir,
						".cursor/rules/Backend/x.mdc",
						"../../../.agents/rules/backend/x.md",
					);
				},
				async ({ dir }) => {
					const surface = rulesSurfaceOf(RULES_HUB, [CURSOR_SPOKE]);
					const ctx = contextOf(
						dir,
						[surface],
						undefined,
						await documentsOf(dir, surface, [".agents/rules/backend/x.md"]),
					);

					expect(await hubSymlinks.check(ctx)).toStrictEqual([
						{
							message: cursorMessage(
								".cursor/rules/backend",
								copyMessage(".agents/rules/backend"),
							),
							file: ".cursor/rules/backend",
						},
					]);
				},
			);
		},
	);

	test("a subfolder's reports come in place of its entry, by entry name, not in full-path order", async () => {
		const expected = [
			".cursor/rules/a.mdc",
			".cursor/rules/m/b.mdc",
			".cursor/rules/m.mdc",
		];
		expect([...expected].sort()).not.toEqual(expected);

		await withCheckout(
			(dir) =>
				writeTree(dir, {
					".agents/rules/a.md": "# A\n",
					".agents/rules/m.md": "# M\n",
					".agents/rules/m/b.md": "# B\n",
					".cursor/rules/m/README.md": "# Rules\n",
				}),
			async ({ dir }) => {
				const surface = rulesSurfaceOf(RULES_HUB, [CURSOR_SPOKE]);
				const ctx = contextOf(
					dir,
					[surface],
					undefined,
					await documentsOf(dir, surface, [
						".agents/rules/m/b.md",
						".agents/rules/m.md",
						".agents/rules/a.md",
					]),
				);

				expect((await hubSymlinks.check(ctx)).map((r) => r.file)).toEqual(
					expected,
				);
			},
		);
	});
});

describe("hub/symlinks from a real skillslurp.json", () => {
	const CONFIG = `${JSON.stringify({
		version: 1,
		extends: [],
		surfaces: [{ root: HUB, spokes: [SPOKE] }],
		rules: { "hub/symlinks": "error" },
	})}\n`;

	test("a declared spoke is checked: the diagnostic names the spoke and carries no position", async () => {
		await withCheckout(
			(dir) => writeTree(dir, { ...HUB_FILES, "skillslurp.json": CONFIG }),
			async ({ dir }) => {
				const result = await runCli({
					path: dir,
					reporter: "json",
					color: false,
				});

				expect(result.exitCode).toBe(EXIT_VIOLATIONS);
				const payload = JSON.parse(result.stdout) as {
					diagnostics: Record<string, unknown>[];
				};
				expect(payload.diagnostics).toEqual([
					{
						ruleId: "hub/symlinks",
						severity: "error",
						message: spokeMessage("does not exist"),
						file: SPOKE,
						fixable: false,
						docsUrl: "https://github.com/shoptet/skillslurp",
					},
				]);
				expect(result.stderr).toBe("");
			},
		);
	});

	test("an item-level spoke is checked through real discovery: the diagnostic names the item's path", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, { ...ITEM_FILES, "skillslurp.json": CONFIG });
				await link(dir, `${SPOKE}/foo`, "../../.agents/skills/foo");
			},
			async ({ dir }) => {
				const result = await runCli({
					path: dir,
					reporter: "json",
					color: false,
				});

				expect(result.exitCode).toBe(EXIT_VIOLATIONS);
				const payload = JSON.parse(result.stdout) as {
					diagnostics: Record<string, unknown>[];
				};
				expect(payload.diagnostics).toEqual([
					{
						ruleId: "hub/symlinks",
						severity: "error",
						message: itemMessage(
							`${SPOKE}/bar`,
							'does not exist, but ".agents/skills/bar" is a hub item that needs a link there',
						),
						file: `${SPOKE}/bar`,
						fixable: false,
						docsUrl: "https://github.com/shoptet/skillslurp",
					},
				]);
				expect(result.stderr).toBe("");
			},
		);
	});

	test("a complete item-level spoke is silent, exit 0", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, { ...ITEM_FILES, "skillslurp.json": CONFIG });
				await link(dir, `${SPOKE}/foo`, "../../.agents/skills/foo");
				await link(dir, `${SPOKE}/bar`, "../../.agents/skills/bar");
			},
			async ({ dir }) => {
				const result = await runCli({
					path: dir,
					reporter: "json",
					color: false,
				});

				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
			},
		);
	});

	test("a correct directory-level spoke is silent, exit 0", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, { ...HUB_FILES, "skillslurp.json": CONFIG });
				await link(dir, SPOKE, "../.agents/skills");
			},
			async ({ dir }) => {
				const result = await runCli({
					path: dir,
					reporter: "json",
					color: false,
				});

				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
			},
		);
	});
});

describe("a Cursor spoke through the whole engine", () => {
	const CONFIG = `${JSON.stringify({
		version: 1,
		extends: [],
		surfaces: [
			{
				root: RULES_HUB,
				kind: "rules",
				dialects: ["cursor"],
				include: ["**/*.md"],
				spokes: [CURSOR_SPOKE],
			},
		],
		rules: { "hub/symlinks": "error", "refs/no-dangling-paths": "error" },
	})}\n`;

	async function diagnosticsOf(
		dir: string,
	): Promise<Record<string, unknown>[]> {
		const result = await runCli({ path: dir, reporter: "json", color: false });
		return (
			JSON.parse(result.stdout) as { diagnostics: Record<string, unknown>[] }
		).diagnostics;
	}

	test("an .mdc link to an .md hub rule is silent, and refs/no-dangling-paths judges the paths a note mentions", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					"skillslurp.json": CONFIG,
					".agents/rules/x.md": "# X\n",
					"docs/notes.md":
						"See `.cursor/rules/x.mdc`, `.cursor/rules/x.md` and `.cursor/rules/y.mdc`.\n",
				});
				await link(dir, ".cursor/rules/x.mdc", "../../.agents/rules/x.md");
			},
			async ({ dir }) => {
				const diagnostics = await diagnosticsOf(dir);

				expect(diagnostics.map((d) => [d.ruleId, d.file, d.message])).toEqual([
					[
						"refs/no-dangling-paths",
						"docs/notes.md",
						'Path ".cursor/rules/y.mdc" does not exist or is not tracked by git',
					],
				]);
			},
		);
	});

	test("a real subfolder of per-file links is silent, and refs/no-dangling-paths judges the paths a note mentions inside it", async () => {
		await withCheckout(
			async (dir) => {
				await writeTree(dir, {
					...SUBFOLDER_FILES,
					"skillslurp.json": CONFIG,
					"docs/notes.md":
						"See `.cursor/rules/backend/api.md` and `.cursor/rules/backend/nope.mdc`.\n",
				});
				for (const [path, target] of Object.entries(SUBFOLDER_LINKS)) {
					await link(dir, path, target);
				}
			},
			async ({ dir }) => {
				const result = await runCli({
					path: dir,
					reporter: "json",
					color: false,
				});
				const diagnostics = (
					JSON.parse(result.stdout) as {
						diagnostics: Record<string, unknown>[];
					}
				).diagnostics;

				expect(result.exitCode).toBe(EXIT_VIOLATIONS);
				expect(diagnostics.map((d) => [d.ruleId, d.file, d.message])).toEqual([
					[
						"refs/no-dangling-paths",
						"docs/notes.md",
						'Path ".cursor/rules/backend/nope.mdc" does not exist or is not tracked by git',
					],
				]);
			},
		);
	});
});
