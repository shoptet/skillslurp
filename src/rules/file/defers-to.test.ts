import { describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
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
import { ConfigError, loadConfig } from "../../config.js";
import { createCapabilities, type RepoRuleContext } from "../../context.js";
import { isWithinRoot } from "../../paths.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { builtinRules } from "../index.js";
import { fileDefersTo, type Options, OptionsSchema } from "./defers-to.js";

/**
 * `file/defers-to`. `RuleTester` states most cases; it cannot state an absolute link
 * target that resolves (the temp directory is chosen per case), a link to a file outside the
 * checkout, a tracked path under a symlinked directory, a git mode other than a file's, or a
 * report ORDER (the engine re-sorts by file), so the sections after `runRuleTests` call
 * `check(ctx)` against a context built over a real checkout.
 */

const PAIR = { files: "**/CLAUDE.md", canonical: "AGENTS.md" };

function options(pair: Readonly<Record<string, unknown>> = {}): unknown {
	return { pairs: [{ ...PAIR, ...pair }] };
}

function defers(file: string, canonical: string, reason: string): string {
	return `File "${file}" does not defer to "${canonical}": ${reason}`;
}

function root(reason: string): string {
	return defers("CLAUDE.md", "AGENTS.md", reason);
}

const AGENTS = { "AGENTS.md": "# Agents\n" };

const NO_IMPORT = "it contains no @import";

const INDENTED_IMPORT =
	"its only @import is inside an indented code block; unindent it";

const EXTRA =
	"it holds more than the @import; only blank lines may accompany it";

const ONLY_IMPORT =
	'it is a symlink, but this pair allows only a file whose sole content is an @import (allow: "import")';

const ONLY_SYMLINK =
	'it is a regular file, but this pair allows only a symlink (allow: "symlink")';

const CHECKED_OUT_AS_FILE =
	"it is recorded as a symlink in git's index but is a regular file in the working tree (either the change is not staged, or core.symlinks is off in this checkout)";

const ABSOLUTE_MISSING = "/nonexistent-skillslurp-dir/AGENTS.md";

const LONG_NAME = `${"a".repeat(300)}.md`;

const DANGLING_CANONICAL =
	'the canonical file is a symlink that does not resolve ("missing.md")';

const IS_DIRECTORY = "the canonical path is a directory, not a file";

const ABSOLUTE_IMPORT_ADVICE =
	"use a relative path so the import stays valid in every checkout";

function uncomputable(pair: number, climbs: number): string {
	return `rule "file/defers-to" options.pairs.${pair}.canonical: climbs ${climbs} level${climbs === 1 ? "" : "s"} up, but the depth of the files this "files" glob can match cannot be computed (it uses negation, an extglob, an escape, a bracket expression or braces that are not simple {a,b} groups), so the path might leave the repository`;
}

const NOT_TRACKED = "the canonical file is not tracked by git";

function unmatched(pair: number, files: string, canonical: string) {
	return {
		ruleId: "config/unmatched-pair",
		message: `Pair ${pair} of "file/defers-to" (files "${files}", canonical "${canonical}") matches no tracked file`,
		file: "skillslurp.json",
	};
}

runRuleTests(fileDefersTo, {
	valid: [
		{
			name: "a symlink to the canonical file is valid",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "AGENTS.md" },
		},
		{
			name: "a file holding only @AGENTS.md is valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
		},
		{
			name: "an import without a trailing newline is valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md" },
		},
		{
			name: "a ./-prefixed import is valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@./AGENTS.md\n" },
		},
		{
			name: "blank lines before and after the import are valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "\n\n@AGENTS.md\n\n" },
		},
		{
			name: "blank lines made of spaces and tabs are valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "  \n@AGENTS.md\n\t\n" },
		},
		{
			name: "a BOM and CRLF line endings are valid",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "﻿\r\n@AGENTS.md\r\n\r\n" },
		},
		{
			name: "an escaped-space import of a canonical file with a space is valid",
			options: options({ canonical: "My Agents.md" }),
			files: {
				"My Agents.md": "# Agents\n",
				"CLAUDE.md": "@My\\ Agents.md\n",
			},
		},
		{
			name: "a nested file defers to the canonical file beside it",
			options: options(),
			files: {
				...AGENTS,
				"CLAUDE.md": "@AGENTS.md\n",
				"packages/a/AGENTS.md": "# A\n",
				"packages/a/CLAUDE.md": "@AGENTS.md\n",
				"packages/b/AGENTS.md": "# B\n",
			},
			symlinks: { "packages/b/CLAUDE.md": "AGENTS.md" },
		},
		{
			name: "a canonical path may climb as far as the shallowest match is deep",
			options: options({
				files: "packages/*/CLAUDE.md",
				canonical: "../../AGENTS.md",
			}),
			files: {
				...AGENTS,
				"packages/a/CLAUDE.md": "@../../AGENTS.md\n",
			},
			symlinks: { "packages/b/CLAUDE.md": "../../AGENTS.md" },
		},
		{
			name: "a glob that also matches the canonical file skips it",
			options: options({ files: "**/*.md" }),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
		},
		{
			name: "a glob that matches only the canonical file is not a config problem",
			options: options({ files: "AGENTS.md" }),
			files: AGENTS,
		},
		{
			name: "a matched file under the top-level ignore is skipped",
			options: options(),
			ignore: ["vendor/**"],
			files: { ...AGENTS, "vendor/CLAUDE.md": "anything at all\n" },
			symlinks: { "CLAUDE.md": "AGENTS.md" },
		},
		{
			name: "a pair whose only matches are ignored is not a config problem",
			options: options(),
			ignore: ["vendor/**"],
			files: { ...AGENTS, "vendor/CLAUDE.md": "anything at all\n" },
		},
		{
			name: "a chain of symlinks that ends at the canonical file is valid",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "hop.md", "hop.md": "AGENTS.md" },
		},
		{
			name: "a symlink to what the canonical symlink points at is valid",
			options: options(),
			files: { "docs/agents.md": "# Agents\n" },
			symlinks: {
				"AGENTS.md": "docs/agents.md",
				"CLAUDE.md": "docs/agents.md",
			},
		},
		{
			name: "an import of what the canonical symlink points at is valid",
			options: options(),
			files: {
				"docs/agents.md": "# Agents\n",
				"CLAUDE.md": "@docs/agents.md\n",
			},
			symlinks: { "AGENTS.md": "docs/agents.md" },
		},
		{
			name: "an import spelled through a redundant segment resolves to the canonical file",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@docs/../AGENTS.md\n" },
		},
		{
			name: "an NFD-named nested directory raises no false positive for an import",
			options: options(),
			files: {
				[`packages/${"café"}/AGENTS.md`]: "# Cafe\n",
				[`packages/${"café"}/CLAUDE.md`]: "@AGENTS.md\n",
			},
		},
		{
			name: "an NFD-named nested directory raises no false positive for a symlink",
			options: options(),
			files: { [`packages/${"café"}/AGENTS.md`]: "# Cafe\n" },
			symlinks: { [`packages/${"café"}/CLAUDE.md`]: "AGENTS.md" },
		},
		{
			name: "the glob is case-sensitive: claude.md is not CLAUDE.md",
			options: options(),
			files: { ...AGENTS, "docs/claude.md": "anything at all\n" },
			symlinks: { "CLAUDE.md": "AGENTS.md" },
		},
		{
			name: "allow: symlink accepts a symlink",
			options: options({ allow: "symlink" }),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "AGENTS.md" },
		},
		{
			name: "allow: import accepts an import",
			options: options({ allow: "import" }),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
		},
		{
			name: "a tracked file that is missing from the working tree has nothing to judge",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
			worktree: { remove: ["CLAUDE.md"] },
		},
		{
			name: "a block-level HTML comment before the import is not content",
			options: options(),
			files: {
				...AGENTS,
				"CLAUDE.md": "<!-- Edit AGENTS.md, not this file. -->\n@AGENTS.md\n",
			},
		},
		{
			name: "multi-line and repeated HTML comments around the import are not content",
			options: options(),
			files: {
				...AGENTS,
				"CLAUDE.md":
					"<!--\nmaintainer notes\n-->\n\n@AGENTS.md\n\n<!-- one --> <!-- two -->\n",
			},
		},
		{
			name: "a comment on the line right after the import is not content",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n<!-- trailing note -->\n" },
		},
		{
			name: "a canonical reached through a committed directory link is tracked",
			options: options({
				files: "packages/*/CLAUDE.md",
				canonical: "../../shared/AGENTS.md",
			}),
			files: {
				"docs/shared/AGENTS.md": "# Shared\n",
				"packages/a/CLAUDE.md": "@../../shared/AGENTS.md\n",
			},
			symlinks: { shared: "docs/shared" },
		},
		{
			name: "every alternative of a simple brace group counts toward the depth",
			options: options({
				files: "{apps,packages}/*/CLAUDE.md",
				canonical: "../../AGENTS.md",
			}),
			files: {
				...AGENTS,
				"apps/a/CLAUDE.md": "@../../AGENTS.md\n",
			},
			symlinks: { "packages/b/CLAUDE.md": "../../AGENTS.md" },
		},
		{
			name: "an escaped bracket in files is a literal, not a root",
			options: options({ files: "\\[draft\\]/CLAUDE.md" }),
			files: {
				"[draft]/AGENTS.md": "# Draft\n",
				"[draft]/CLAUDE.md": "@AGENTS.md\n",
			},
		},
		{
			name: "two pairs each accept the file they cover",
			options: {
				pairs: [
					{ files: "CLAUDE.md", canonical: "AGENTS.md" },
					{
						files: "docs/CLAUDE.md",
						canonical: "../README.md",
						allow: "import",
					},
				],
			},
			files: {
				...AGENTS,
				"README.md": "# Readme\n",
				"docs/CLAUDE.md": "@../README.md\n",
			},
			symlinks: { "CLAUDE.md": "AGENTS.md" },
		},
	],
	invalid: [
		{
			name: "prose after the import is reported at its line",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n\nUse plan mode.\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 3, col: 1 }],
		},
		{
			name: "prose before the import is reported at its line",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "\n# Notes\n@AGENTS.md\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 2, col: 1 }],
		},
		{
			name: "text after the import on its own line is reported past the import",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md please\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 1, col: 12 }],
		},
		{
			name: "a trailing dot after the import is content",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md.\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 1, col: 11 }],
		},
		{
			name: "a list item carries content before the import",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "- @AGENTS.md\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 1, col: 1 }],
		},
		{
			name: "with a BOM and CRLF the offending line is still the third",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "﻿@AGENTS.md\r\n\r\nextra\r\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 3, col: 1 }],
		},
		{
			name: "two imports are reported at the second",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n@AGENTS.md\n" },
			errors: [
				{
					message: root("it contains 2 @imports; it must contain exactly one"),
					file: "CLAUDE.md",
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 11,
				},
			],
		},
		{
			name: "an import of a different file is reported",
			options: options(),
			files: {
				...AGENTS,
				"README.md": "# Readme\n",
				"CLAUDE.md": "@README.md\n",
			},
			errors: [
				{
					message: root(
						'it imports "README.md" (written as "@README.md") instead',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 11,
				},
			],
		},
		{
			name: "an import of a missing file is reported like any other file",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENT.md\n" },
			errors: [
				{
					message: root(
						'it imports "AGENT.md" (written as "@AGENT.md") instead',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 10,
				},
			],
		},
		{
			name: "a wrong import and extra content are both reported",
			options: options(),
			files: {
				...AGENTS,
				"README.md": "# Readme\n",
				"CLAUDE.md": "@README.md\nMore.\n",
			},
			errors: [
				{
					message: root(
						'it imports "README.md" (written as "@README.md") instead',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 11,
				},
				{ message: root(EXTRA), file: "CLAUDE.md", line: 2, col: 1 },
			],
		},
		{
			name: "a missing canonical file is reported once, whatever the form",
			options: options(),
			files: { "CLAUDE.md": "@AGENTS.md\n\nextra\n" },
			errors: [
				{
					message: root("the canonical file does not exist"),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a symlink to a missing canonical file reports the canonical file only",
			options: options(),
			files: { "README.md": "# Readme\n" },
			symlinks: { "CLAUDE.md": "AGENTS.md" },
			errors: [
				{
					message: root("the canonical file does not exist"),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a canonical file that exists on disk but is not tracked is reported",
			options: options(),
			files: { "CLAUDE.md": "@AGENTS.md\n" },
			worktree: { files: AGENTS },
			errors: [{ message: root(NOT_TRACKED), file: "CLAUDE.md" }],
		},
		{
			name: "a tracked canonical file deleted from the working tree does not exist",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
			worktree: { remove: ["AGENTS.md"] },
			errors: [
				{
					message: root("the canonical file does not exist"),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a canonical path that is a directory is reported",
			options: options(),
			files: { "AGENTS.md/notes.md": "# Notes\n", "CLAUDE.md": "@AGENTS.md\n" },
			errors: [
				{
					message: root("the canonical path is a directory, not a file"),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a symlink to the wrong file is reported",
			options: options(),
			files: { ...AGENTS, "README.md": "# Readme\n" },
			symlinks: { "CLAUDE.md": "README.md" },
			errors: [
				{
					message: root('it points at "README.md" instead'),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a dangling symlink is reported",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "gone.md" },
			errors: [
				{
					message: root('it points at "gone.md", which does not resolve'),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a symlink loop is reported as not resolving",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "loop.md", "loop.md": "CLAUDE.md" },
			errors: [
				{
					message: root('it points at "loop.md", which does not resolve'),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "an absolute target is reported, and so is its missing target",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "/nonexistent-skillslurp-dir/AGENTS.md" },
			errors: [
				{
					message: root(
						'it is a symlink with the absolute target "/nonexistent-skillslurp-dir/AGENTS.md"; use a relative target so the link stays valid in every checkout',
					),
					file: "CLAUDE.md",
				},
				{
					message: root(
						'it points at "/nonexistent-skillslurp-dir/AGENTS.md", which does not resolve',
					),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "allow: import rejects a symlink",
			options: options({ allow: "import" }),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "AGENTS.md" },
			errors: [{ message: root(ONLY_IMPORT), file: "CLAUDE.md" }],
		},
		{
			name: "allow: symlink rejects an import",
			options: options({ allow: "symlink" }),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
			errors: [{ message: root(ONLY_SYMLINK), file: "CLAUDE.md" }],
		},
		{
			name: "a missing canonical file outranks a form that is not allowed",
			options: options({ allow: "symlink" }),
			files: { "CLAUDE.md": "@AGENTS.md\n" },
			errors: [
				{
					message: root("the canonical file does not exist"),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a nested file is judged against the canonical file beside it, not the root's",
			options: options(),
			files: { ...AGENTS, "packages/b/CLAUDE.md": "@AGENTS.md\n" },
			errors: [
				{
					message: defers(
						"packages/b/CLAUDE.md",
						"packages/b/AGENTS.md",
						"the canonical file does not exist",
					),
					file: "packages/b/CLAUDE.md",
				},
			],
		},
		{
			name: "a nested import must name the canonical file beside it",
			options: options(),
			files: {
				...AGENTS,
				"packages/a/AGENTS.md": "# A\n",
				"packages/a/CLAUDE.md": "@../../AGENTS.md\n",
			},
			errors: [
				{
					message: defers(
						"packages/a/CLAUDE.md",
						"packages/a/AGENTS.md",
						'it imports "AGENTS.md" (written as "@../../AGENTS.md") instead',
					),
					file: "packages/a/CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 17,
				},
			],
		},
		{
			name: "a glob matching the canonical file still checks the other matches",
			options: options({ files: "**/*.md" }),
			files: {
				...AGENTS,
				"CLAUDE.md": "@AGENTS.md\n",
				"NOTES.md": "# Notes\n",
			},
			errors: [
				{
					message: defers("NOTES.md", "AGENTS.md", NO_IMPORT),
					file: "NOTES.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			name: "an empty file has no import and no position",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "" },
			errors: [{ message: root(NO_IMPORT), file: "CLAUDE.md" }],
		},
		{
			name: "a file of blank lines has no import and no position",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "\n \n\t\n" },
			errors: [{ message: root(NO_IMPORT), file: "CLAUDE.md" }],
		},
		{
			name: "prose without an import is reported at its first line",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "\n  Read the agents file.\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 2, col: 3 },
			],
		},
		{
			name: "an import inside a fenced block is not an import",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "```\n@AGENTS.md\n```\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 1, col: 1 },
			],
		},
		{
			name: "an import inside a code span is not an import",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "`see @AGENTS.md`\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 1, col: 1 },
			],
		},
		{
			name: "an import indented four spaces is a code block, reported as such",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "    @AGENTS.md\n" },
			errors: [
				{ message: root(INDENTED_IMPORT), file: "CLAUDE.md", line: 1, col: 5 },
			],
		},
		{
			name: "an import indented with a tab is a code block, reported as such",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "\t@AGENTS.md\n" },
			errors: [
				{ message: root(INDENTED_IMPORT), file: "CLAUDE.md", line: 1, col: 2 },
			],
		},
		{
			name: "an indented code block that holds more than one token is not an import, and gets the plain reason",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "    @AGENTS.md is the file\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 1, col: 5 },
			],
		},
		{
			name: "a quoted path is not imported at all",
			options: options({ canonical: "My Agents.md" }),
			files: {
				"My Agents.md": "# Agents\n",
				"CLAUDE.md": '@"My Agents.md"\n',
			},
			errors: [
				{
					message: defers("CLAUDE.md", "My Agents.md", NO_IMPORT),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			name: "a home-directory import is reported",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@~/AGENTS.md\n" },
			errors: [
				{
					message: root(
						'it imports "@~/AGENTS.md", a path in the home directory, which differs per machine',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 13,
				},
			],
		},
		{
			name: "an import that leaves the repository is reported",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@../AGENTS.md\n" },
			errors: [
				{
					message: root(
						'it imports "@../AGENTS.md", which is outside the repository',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 14,
				},
			],
		},
		{
			name: "an import whose path holds a NUL byte is reported without touching the filesystem",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\0x\n" },
			errors: [
				{
					message: root('its import "@AGENTS.md\\0x" contains a NUL byte'),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 13,
				},
			],
		},
		{
			name: "a pair whose glob matches nothing is a config problem naming the pair",
			options: options({ files: "docs/**/CLAUDE.md" }),
			files: AGENTS,
			errors: [unmatched(1, "docs/**/CLAUDE.md", "AGENTS.md")],
		},
		{
			name: "only the pair that matches nothing is a config problem, and it keeps its number",
			options: {
				pairs: [
					PAIR,
					{ files: "docs/*.txt", canonical: "AGENTS.md", allow: "import" },
				],
			},
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
			errors: [unmatched(2, "docs/*.txt", "AGENTS.md")],
		},
		{
			name: "the glob is case-sensitive: CLAUDE.md is matched, claude.md is not",
			options: options(),
			files: {
				...AGENTS,
				"docs/claude.md": "anything\n",
				"api/CLAUDE.md": "",
			},
			errors: [
				{
					message: defers(
						"api/CLAUDE.md",
						"api/AGENTS.md",
						"the canonical file does not exist",
					),
					file: "api/CLAUDE.md",
				},
			],
		},
		{
			name: "two pairs covering one file are each evaluated",
			options: {
				pairs: [
					{ ...PAIR, allow: "symlink" },
					{ files: "CLAUDE.md", canonical: "README.md" },
				],
			},
			files: {
				...AGENTS,
				"README.md": "# Readme\n",
				"CLAUDE.md": "@AGENTS.md\n",
			},
			errors: [
				{ message: root(ONLY_SYMLINK), file: "CLAUDE.md" },
				{
					message: defers(
						"CLAUDE.md",
						"README.md",
						'it imports "AGENTS.md" (written as "@AGENTS.md") instead',
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 11,
				},
			],
		},
		{
			name: "a symlink in the index that is a regular file on disk names both causes",
			options: options(),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "AGENTS.md" },
			worktree: { remove: ["CLAUDE.md"], files: { "CLAUDE.md": "AGENTS.md" } },
			errors: [{ message: root(CHECKED_OUT_AS_FILE), file: "CLAUDE.md" }],
		},
		{
			name: "a regular file in the index that is a symlink on disk is reported and never read",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" },
			worktree: {
				remove: ["CLAUDE.md"],
				symlinks: { "CLAUDE.md": "AGENTS.md" },
			},
			errors: [
				{
					message: root(
						"it is a symlink on disk but git tracks it as a regular file; commit the change or restore the file",
					),
					file: "CLAUDE.md",
				},
			],
		},
		{
			name: "a file the linter's ignore list does not cover is still checked",
			options: options(),
			ignore: ["vendor/**"],
			files: { ...AGENTS, "docs/CLAUDE.md": "@AGENTS.md\n" },
			errors: [
				{
					message: defers(
						"docs/CLAUDE.md",
						"docs/AGENTS.md",
						"the canonical file does not exist",
					),
					file: "docs/CLAUDE.md",
				},
			],
		},
		{
			name: "an unstaged symlink-to-file change is not judged by the form the pair allows",
			options: options({ allow: "import" }),
			files: AGENTS,
			symlinks: { "CLAUDE.md": "AGENTS.md" },
			worktree: {
				remove: ["CLAUDE.md"],
				files: { "CLAUDE.md": "@AGENTS.md\n" },
			},
			errors: [{ message: root(CHECKED_OUT_AS_FILE), file: "CLAUDE.md" }],
		},
		{
			name: "an HTML block that is not only comments is content",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "<div>x</div>\n\n@AGENTS.md\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 1, col: 1 }],
		},
		{
			name: "an HTML block runs to the next blank line, so a tight import inside it is not an import",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "<div>x</div>\n@AGENTS.md\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 1, col: 1 },
			],
		},
		{
			name: "a comment beside the import on its own line is content",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md <!-- note -->\n" },
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 1, col: 12 }],
		},
		{
			name: "prose next to a comment is still reported",
			options: options(),
			files: {
				...AGENTS,
				"CLAUDE.md": "<!-- note -->\n@AGENTS.md\nmore\n",
			},
			errors: [{ message: root(EXTRA), file: "CLAUDE.md", line: 3, col: 1 }],
		},
		{
			name: "a file of comments only has no import and no position",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "<!-- only a note -->\n" },
			errors: [{ message: root(NO_IMPORT), file: "CLAUDE.md" }],
		},
		{
			name: "an unclosed comment swallows the import after it",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": "<!-- never closed\n@AGENTS.md\n" },
			errors: [
				{ message: root(NO_IMPORT), file: "CLAUDE.md", line: 1, col: 1 },
			],
		},
		{
			name: "an absolute import outside the repository is reported as absolute and as outside",
			options: options(),
			files: { ...AGENTS, "CLAUDE.md": `@${ABSOLUTE_MISSING}\n` },
			errors: [
				{
					message: root(
						`it imports "@${ABSOLUTE_MISSING}", an absolute path; ${ABSOLUTE_IMPORT_ADVICE}`,
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 2 + ABSOLUTE_MISSING.length,
				},
				{
					message: root(
						`it imports "@${ABSOLUTE_MISSING}", which is outside the repository`,
					),
					file: "CLAUDE.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 2 + ABSOLUTE_MISSING.length,
				},
			],
		},
		{
			name: "a canonical that is a symlink to a directory is a directory",
			options: options(),
			files: { "docs/notes.md": "# Notes\n", "CLAUDE.md": "@AGENTS.md\n" },
			symlinks: { "AGENTS.md": "docs" },
			errors: [{ message: root(IS_DIRECTORY), file: "CLAUDE.md" }],
		},
		{
			name: "a symlink to a canonical symlink that leads to a directory is reported",
			options: options(),
			files: { "docs/notes.md": "# Notes\n" },
			symlinks: { "AGENTS.md": "docs", "CLAUDE.md": "AGENTS.md" },
			errors: [{ message: root(IS_DIRECTORY), file: "CLAUDE.md" }],
		},
		{
			name: "a canonical that is a dangling symlink is reported for an import",
			options: options(),
			files: { "CLAUDE.md": "@AGENTS.md\n" },
			symlinks: { "AGENTS.md": "missing.md" },
			errors: [{ message: root(DANGLING_CANONICAL), file: "CLAUDE.md" }],
		},
		{
			name: "a canonical that is a dangling symlink is reported once for a symlink, not again for the link itself",
			options: options(),
			files: { "README.md": "# Readme\n" },
			symlinks: { "AGENTS.md": "missing.md", "CLAUDE.md": "AGENTS.md" },
			errors: [{ message: root(DANGLING_CANONICAL), file: "CLAUDE.md" }],
		},
		{
			name: "a canonical name too long for the filesystem is reported, not thrown",
			options: options({ canonical: LONG_NAME }),
			files: { "CLAUDE.md": "@AGENTS.md\n" },
			errors: [
				{
					message: defers(
						"CLAUDE.md",
						LONG_NAME,
						"the canonical file cannot be inspected",
					),
					file: "CLAUDE.md",
				},
			],
		},
	],
});

interface Checkout {
	readonly dir: string;
}

async function withCheckout(
	setup: (dir: string) => Promise<void>,
	body: (checkout: Checkout) => Promise<void>,
): Promise<void> {
	const base = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-defers-to-")),
	);
	const dir = join(base, "repo");
	try {
		await mkdir(dir);
		await setup(dir);
		await gitInitAndCommit(dir);
		await body({ dir });
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

async function put(dir: string, path: string, content: string): Promise<void> {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await writeFile(join(dir, path), content, "utf8");
}

async function link(dir: string, path: string, target: string): Promise<void> {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await symlink(target, join(dir, path));
}

function contextWith(
	dir: string,
	parsed: Options,
	git?: (base: RepoRuleContext["git"]) => RepoRuleContext["git"],
): RepoRuleContext<Options> {
	const capabilities = createCapabilities(dir, async () => []);
	return {
		...capabilities,
		git: git === undefined ? capabilities.git : git(capabilities.git),
		options: parsed,
		surfaces: [],
	};
}

function contextOf(
	dir: string,
	given: unknown,
	git?: (base: RepoRuleContext["git"]) => RepoRuleContext["git"],
): RepoRuleContext<Options> {
	return contextWith(dir, OptionsSchema.parse(given), git);
}

describe("file/defers-to against a real checkout", () => {
	test("an absolute target that resolves to the canonical file is reported for being absolute only", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await link(dir, "CLAUDE.md", join(dir, "AGENTS.md"));
			},
			async ({ dir }) => {
				const reports = await fileDefersTo.check(contextOf(dir, options()));

				expect(reports).toStrictEqual([
					{
						message: root(
							`it is a symlink with the absolute target "${join(dir, "AGENTS.md")}"; use a relative target so the link stays valid in every checkout`,
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("an absolute import that resolves to the canonical file is reported for being absolute only", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dir, "CLAUDE.md", `@${join(dir, "AGENTS.md")}\n`);
			},
			async ({ dir }) => {
				const abs = join(dir, "AGENTS.md");

				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							`it imports "@${abs}", an absolute path; ${ABSOLUTE_IMPORT_ADVICE}`,
						),
						file: "CLAUDE.md",
						loc: { line: 1, col: 1, endLine: 1, endCol: 2 + abs.length },
					},
				]);
			},
		);
	});

	test("an absolute import of another file in the repository is reported as absolute and as the wrong file", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dir, "README.md", "# Readme\n");
				await put(dir, "CLAUDE.md", `@${join(dir, "README.md")}\n`);
			},
			async ({ dir }) => {
				const abs = join(dir, "README.md");
				const loc = { line: 1, col: 1, endLine: 1, endCol: 2 + abs.length };

				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							`it imports "@${abs}", an absolute path; ${ABSOLUTE_IMPORT_ADVICE}`,
						),
						file: "CLAUDE.md",
						loc,
					},
					{
						message: root(
							`it imports "README.md" (written as "@${abs}") instead`,
						),
						file: "CLAUDE.md",
						loc,
					},
				]);
			},
		);
	});

	test("an absolute link to a file outside the checkout is reported as absolute and as outside", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dirname(dir), "secret.md", "# Secret\n");
				await link(dir, "CLAUDE.md", join(dirname(dir), "secret.md"));
			},
			async ({ dir }) => {
				const outside = join(dirname(dir), "secret.md");

				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							`it is a symlink with the absolute target "${outside}"; use a relative target so the link stays valid in every checkout`,
						),
						file: "CLAUDE.md",
					},
					{
						message: root(
							`it points at "${outside}", which is outside the linted directory`,
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a canonical that is a symlink leading outside the checkout is reported for an import", async () => {
		await withCheckout(
			async (dir) => {
				await put(dirname(dir), "elsewhere.md", "# Elsewhere\n");
				await link(dir, "AGENTS.md", "../elsewhere.md");
				await put(dir, "CLAUDE.md", "@AGENTS.md\n");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'the canonical file is a symlink that leads outside the linted directory ("../elsewhere.md")',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a canonical that is a symlink leading outside the checkout is reported once for a symlink", async () => {
		await withCheckout(
			async (dir) => {
				await put(dirname(dir), "elsewhere.md", "# Elsewhere\n");
				await link(dir, "AGENTS.md", "../elsewhere.md");
				await link(dir, "CLAUDE.md", "AGENTS.md");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'the canonical file is a symlink that leads outside the linted directory ("../elsewhere.md")',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a canonical that is a symlink whose text leaves the checkout and comes back is reported once for a symlink", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "docs/AGENTS.md", "# Agents\n");
				await link(dir, "AGENTS.md", "../repo/docs/AGENTS.md");
				await link(dir, "CLAUDE.md", "AGENTS.md");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'the canonical file is a symlink that leads outside the linted directory ("../repo/docs/AGENTS.md")',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a link through a directory link that leads out of the checkout is reported as outside", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dirname(dir), "elsewhere/AGENTS.md", "# Elsewhere\n");
				await link(dir, "out", "../elsewhere");
				await link(dir, "CLAUDE.md", "out/AGENTS.md");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'it points at "out/AGENTS.md", which is outside the linted directory',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a canonical spelled in NFD is found in git's NFC listing", async () => {
		const nfd = "cafe\u0301.md";
		const nfc = nfd.normalize("NFC");
		await withCheckout(
			async (dir) => {
				await put(dir, nfd, "# Cafe\n");
				await link(dir, "CLAUDE.md", nfd);
			},
			async ({ dir }) => {
				const ctx = contextOf(dir, options({ canonical: nfd }), (git) => ({
					...git,
					trackedFiles: async () => ["CLAUDE.md", nfc],
					trackedModes: async () =>
						new Map([
							["CLAUDE.md", "120000"],
							[nfc, "100644"],
						]),
				}));

				expect(await fileDefersTo.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("a canonical that resolves outside the repository is one config problem per pair, and nothing outside is looked up", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dir, "CLAUDE.md", "@AGENTS.md\n");
				await put(dir, "a/CLAUDE.md", "@../AGENTS.md\n");
				await put(dir, "b/CLAUDE.md", "@../AGENTS.md\n");
				await put(dirname(dir), "AGENTS.md", "# Outside\n");
			},
			async ({ dir }) => {
				const ctx = contextWith(dir, {
					pairs: [
						{
							files: "**/CLAUDE.md",
							canonical: "../AGENTS.md",
							allow: "either",
						},
					],
				});
				const spies = [
					spyOn(fsp, "lstat"),
					spyOn(fsp, "stat"),
					spyOn(fsp, "realpath"),
					spyOn(fsp, "readlink"),
					spyOn(fsp, "readFile"),
				];
				let reports: Awaited<ReturnType<typeof fileDefersTo.check>>;
				let touched: string[];
				try {
					reports = await fileDefersTo.check(ctx);
					touched = spies.flatMap((spy) =>
						spy.mock.calls.map((call) => String(call[0])),
					);
				} finally {
					for (const spy of spies) {
						spy.mockRestore();
					}
				}

				expect(reports).toStrictEqual([
					{
						problem: "canonical-outside",
						message:
							'Pair 1 of "file/defers-to" (files "**/CLAUDE.md", canonical "../AGENTS.md") resolves to a path outside the repository for "CLAUDE.md"',
					},
				]);
				expect(touched.filter((path) => !isWithinRoot(dir, path))).toEqual([]);
			},
		);
	});

	test("a link to an existing file outside the checkout is reported as outside", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dirname(dir), "secret.md", "# Secret\n");
				await link(dir, "CLAUDE.md", "../secret.md");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'it points at "../secret.md", which is outside the linted directory',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a link whose text leaves the checkout and comes back is reported as outside", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await link(dir, "CLAUDE.md", "../repo/AGENTS.md");
			},
			async ({ dir }) => {
				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: root(
							'it points at "../repo/AGENTS.md", which is outside the linted directory',
						),
						file: "CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a matched file under a directory that now points outside the checkout is reported and never read", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "sub/AGENTS.md", "# Agents\n");
				await put(dir, "sub/CLAUDE.md", "@AGENTS.md\n");
			},
			async ({ dir }) => {
				await rm(join(dir, "sub"), { recursive: true });
				await put(dirname(dir), "elsewhere/AGENTS.md", "# Elsewhere\n");
				await put(dirname(dir), "elsewhere/CLAUDE.md", "not an import\n");
				await link(dir, "sub", "../elsewhere");

				expect(
					await fileDefersTo.check(contextOf(dir, options())),
				).toStrictEqual([
					{
						message: defers(
							"sub/CLAUDE.md",
							"sub/AGENTS.md",
							'it is outside the linted directory (its parent directory resolves to "../elsewhere")',
						),
						file: "sub/CLAUDE.md",
					},
				]);
			},
		);
	});

	test("a gitlink entry has nothing to judge", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dir, "CLAUDE.md", "@AGENTS.md\n\nextra\n");
			},
			async ({ dir }) => {
				const ctx = contextOf(dir, options(), (git) => ({
					...git,
					trackedModes: async () =>
						new Map([
							["AGENTS.md", "100644"],
							["CLAUDE.md", "160000"],
						]),
				}));

				expect(await fileDefersTo.check(ctx)).toStrictEqual([]);
			},
		);
	});

	test("reports come in pair order, then file path order, whatever order git lists the files in", async () => {
		await withCheckout(
			async (dir) => {
				await put(dir, "AGENTS.md", "# Agents\n");
				await put(dir, "b/AGENTS.md", "# B\n");
				await put(dir, "a/AGENTS.md", "# A\n");
				await put(dir, "b/CLAUDE.md", "");
				await put(dir, "a/CLAUDE.md", "");
			},
			async ({ dir }) => {
				const ctx = contextOf(
					dir,
					{
						pairs: [
							{ files: "b/CLAUDE.md", canonical: "AGENTS.md" },
							{ files: "**/CLAUDE.md", canonical: "AGENTS.md" },
							{ files: "none/*.md", canonical: "AGENTS.md" },
						],
					},
					(git) => ({
						...git,
						trackedFiles: async () => ["b/CLAUDE.md", "a/CLAUDE.md"],
					}),
				);

				const reports = await fileDefersTo.check(ctx);

				expect(
					reports.map((report) =>
						"problem" in report ? report.problem : report.file,
					),
				).toEqual([
					"b/CLAUDE.md",
					"a/CLAUDE.md",
					"b/CLAUDE.md",
					"unmatched-pair",
				]);
			},
		);
	});
});

async function withConfig<T>(
	content: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-defers-to-config-"));
	try {
		await writeFile(join(dir, "skillslurp.json"), content, "utf8");
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function configProblems(rules: string): Promise<ConfigError["problems"]> {
	return await withConfig(
		`{"surfaces":[{"root":".claude/skills"}],"rules":${rules}}\n`,
		async (dir) => {
			try {
				await loadConfig(dir, builtinRules);
			} catch (err) {
				if (err instanceof ConfigError) {
					return err.problems;
				}
				throw err;
			}
			throw new Error("expected loadConfig to reject with a ConfigError");
		},
	);
}

function entry(pairs: string): string {
	return `{"file/defers-to":{"options":{"pairs":${pairs}}}}`;
}

describe("file/defers-to options", () => {
	const at = (col: number, endCol: number) => ({
		line: 1,
		col,
		endLine: 1,
		endCol,
	});

	test("a rule enabled without options is a positioned config error", async () => {
		expect(await configProblems('{"file/defers-to":"error"}')).toEqual([
			{
				message:
					'rule "file/defers-to" options.pairs: Invalid input: expected array, received undefined',
				loc: at(67, 74),
			},
		]);
	});

	test("a rule set to off still needs its required option, like every rule with one", async () => {
		expect(await configProblems('{"file/defers-to":"off"}')).toEqual([
			{
				message:
					'rule "file/defers-to" options.pairs: Invalid input: expected array, received undefined',
				loc: at(67, 72),
			},
		]);
	});

	test("empty pairs are a positioned config error", async () => {
		expect(await configProblems(entry("[]"))).toEqual([
			{
				message:
					'rule "file/defers-to" options.pairs: Too small: expected array to have >=1 items',
				loc: at(87, 89),
			},
		]);
	});

	test("every invalid pair field is listed, each positioned at its own value", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"/CLAUDE.md","canonical":"AGENTS.md"},{"files":"**/CLAUDE.md","canonical":"/AGENTS.md"},{"files":"**/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"**/CLAUDE.md","canonical":"AGENTS.md","allow":"both"},{"files":"","canonical":"AGENTS.md"},{"files":"*.md","canonical":"AGENTS.md","extra":1}]',
			),
		);

		expect(problems).toEqual([
			{
				message:
					'rule "file/defers-to" options.pairs.0.files: must be relative to the repository root, not absolute',
				loc: at(97, 109),
			},
			{
				message:
					'rule "file/defers-to" options.pairs.1.canonical: must be relative to the directory of each matched file, not absolute',
				loc: at(171, 183),
			},
			{
				message:
					'rule "file/defers-to" options.pairs.2.canonical: climbs 1 level up, but "files" can match a file only 0 levels below the repository root, so the path would leave the repository',
				loc: at(221, 235),
			},
			{
				message:
					'rule "file/defers-to" options.pairs.3.allow: Invalid option: expected one of "either"|"symlink"|"import"',
				loc: at(293, 299),
			},
			{
				message:
					'rule "file/defers-to" options.pairs.4.files: Too small: expected string to have >=1 characters',
				loc: at(310, 312),
			},
			{
				message:
					'rule "file/defers-to" options: unrecognized key "pairs.5.extra"',
				loc: at(378, 385),
			},
		]);
	});

	test("a canonical path may climb as far as the shallowest match is deep, and no further", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"packages/*/CLAUDE.md","canonical":"../../AGENTS.md"},{"files":"packages/*/CLAUDE.md","canonical":"../../../AGENTS.md"},{"files":"{CLAUDE.md,docs/CLAUDE.md}","canonical":"../AGENTS.md"},{"files":"docs/**/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"docs/**/CLAUDE.md","canonical":"../../AGENTS.md"},{"files":"!docs/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"docs\\\\/CLAUDE.md","canonical":"../AGENTS.md"}]',
			),
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			'rule "file/defers-to" options.pairs.1.canonical: climbs 3 levels up, but "files" can match a file only 2 levels below the repository root, so the path would leave the repository',
			'rule "file/defers-to" options.pairs.2.canonical: climbs 1 level up, but "files" can match a file only 0 levels below the repository root, so the path would leave the repository',
			'rule "file/defers-to" options.pairs.4.canonical: climbs 2 levels up, but "files" can match a file only 1 level below the repository root, so the path would leave the repository',
			uncomputable(5, 1),
			uncomputable(6, 1),
		]);
	});

	test("a bracket expression in files defeats the depth, so no climbing canonical is admitted", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"[a/b]/CLAUDE.md","canonical":"../../AGENTS.md"},{"files":"[a/b]/CLAUDE.md","canonical":"AGENTS.md"}]',
			),
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			uncomputable(0, 2),
		]);
	});

	test("an extglob in files defeats the depth, so no climbing canonical is admitted", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"@(CLAUDE.md|docs/CLAUDE.md)","canonical":"../AGENTS.md"},{"files":"!(x)/CLAUDE.md","canonical":"../AGENTS.md"}]',
			),
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			uncomputable(0, 1),
			uncomputable(1, 1),
		]);
	});

	test("nested, range and unbalanced braces defeat the depth too", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"{a,{b,c}}/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"{1..3}/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"{a,b/CLAUDE.md","canonical":"../AGENTS.md"},{"files":"a}/CLAUDE.md","canonical":"../AGENTS.md"}]',
			),
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			uncomputable(0, 1),
			uncomputable(1, 1),
			uncomputable(2, 1),
			uncomputable(3, 1),
		]);
	});

	test("a NUL byte in files or canonical is a positioned config error", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"CLAUDE\\u0000.md","canonical":"AGENTS.md"},{"files":"**/CLAUDE.md","canonical":"AGENTS\\u0000.md"}]',
			),
		);

		expect(problems).toEqual([
			{
				message:
					'rule "file/defers-to" options.pairs.0.files: must not contain a NUL byte',
				loc: at(97, 114),
			},
			{
				message:
					'rule "file/defers-to" options.pairs.1.canonical: must not contain a NUL byte',
				loc: at(176, 193),
			},
		]);
	});

	test("a leading backslash in files is an escape, not a root", () => {
		const escaped = OptionsSchema.safeParse(
			options({ files: "\\[draft\\]/CLAUDE.md" }),
		);
		const rooted = OptionsSchema.safeParse(options({ files: "/CLAUDE.md" }));

		expect(escaped.success).toBe(true);
		expect(rooted.success).toBe(false);
	});

	test("a Windows-style absolute path is absolute too", async () => {
		const problems = await configProblems(
			entry(
				'[{"files":"C:/CLAUDE.md","canonical":"AGENTS.md"},{"files":"**/CLAUDE.md","canonical":"C:\\\\AGENTS.md"}]',
			),
		);

		expect(problems.map((problem) => problem.message)).toEqual([
			'rule "file/defers-to" options.pairs.0.files: must be relative to the repository root, not absolute',
			'rule "file/defers-to" options.pairs.1.canonical: must be relative to the directory of each matched file, not absolute',
		]);
	});
});
