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
import { freezeSurface, sealMap } from "../../config.js";
import { createCapabilities, type RuleContext } from "../../context.js";
import { DEFAULT_INCLUDE } from "../../dialects.js";
import { type Document, parseSource } from "../../document.js";
import { collectLinkTargets } from "../../links.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { noUnreachableFiles } from "./no-unreachable-files.js";

/**
 * `refs/no-unreachable-files`'s own edge cases, one test each, through `RuleTester` — which
 * git-inits and commits every `project` case's temp dir, so "present means tracked" is exercised
 * against a real index rather than a stub.
 *
 * Two conventions run through every fixture below:
 *
 * - the surface is rooted at `skills/`, not at `.`, so that a repo-root file (`.gitignore`) is
 *   unambiguously outside every item directory and cannot itself be mistaken for an orphan;
 * - a case that wants an UNTRACKED file gets it via `.gitignore`. That is the only lever the
 *   harness offers — `gitInitAndCommit` runs `git add -A`, so everything `files` writes and git
 *   is willing to stage ends up in the index — and it is the honest one: gitignored is exactly
 *   what "present on disk, absent from a fresh checkout" means in practice.
 *
 * Two sections follow `runRuleTests`, for the two things its fixtures cannot state: that
 * `collectLinkTargets`'s new option is what makes the footnote case pass (against a parsed tree,
 * rather than inferred from a green end-to-end case), and what happens to a reference file that is
 * a symlink out of the repository — a shape `writeFiles` cannot produce at all.
 */

// git lists NFC on macOS (core.precomposeunicode) but the raw NFD bytes on Linux, and a path inside a message keeps that spelling.
const GIT_LISTED_CAFE =
	process.platform === "darwin" ? "caf\u00e9" : "cafe\u0301";

const ORPHAN = (path: string, entry: string): string =>
	`Reference file "${path}" is not reachable from entry document "${entry}"`;

runRuleTests(noUnreachableFiles, {
	valid: [
		{
			// Transitive: `SKILL.md` never mentions `logo.png` at all, `reference.md` does.
			name: "every file under an item's directory is reached from its own entry document",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n\n- [reference](reference.md)\n",
				"skills/widgets/reference.md": "# Reference\n\n![logo](logo.png)\n",
				"skills/widgets/logo.png": "not really a png\n",
			},
		},
		{
			name: "an item whose directory holds nothing but its entry document is clean — the entry is never an orphan of itself",
			surface: { root: "skills" },
			files: { "skills/widgets/SKILL.md": "# Widgets\n" },
		},
		{
			// The fixpoint's termination guarantee: without the visited set this case hangs
			// rather than failing, so it is also the one case whose failure mode is a timeout.
			name: "a cycle between two reference files terminates and orphans neither",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n\n[a](a.md)\n",
				"skills/widgets/a.md": "# A\n\n[b](b.md)\n",
				"skills/widgets/b.md": "# B\n\n[a](a.md)\n",
			},
		},
		{
			// `gone.md` is never written, so the link resolves to nothing tracked. `links/resolve`
			// owns that diagnostic; this rule must stay silent about it — and must not let it
			// derail the rest of the walk, which is what `notes.md` staying unreported proves.
			name: "a link that resolves to nothing is skipped silently, not reported a second time",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md":
					"# Widgets\n\n[gone](gone.md)\n\n[notes](notes.md)\n",
				"skills/widgets/notes.md": "# Notes\n",
			},
		},
		{
			// `.gitignore` sits at the repo root, outside every item directory, so it cannot be
			// an orphan itself and the case measures only what it means to measure.
			name: "a gitignored scratch file inside the item is not an orphan",
			surface: { root: "skills" },
			files: {
				".gitignore": "skills/widgets/scratch.md\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/scratch.md": "# Scratch notes to self\n",
			},
		},
		{
			name: "an untracked asset present on disk under the item is not reported",
			surface: { root: "skills" },
			files: {
				".gitignore": "skills/widgets/build/\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/build/generated.md": "# Generated\n",
				"skills/widgets/build/bundle.js": "// generated\n",
			},
		},
		{
			// `dirname` of each entry IS the surface root, so no item directory exists and
			// the rule is a plain no-op. `README.md` is what makes this case bite — mutation-
			// checked, and the first draft of it did not: with two `.mdc` files alone, letting
			// the surface root count as an item directory changes nothing, because both entries
			// live in it and both seed the walk. A non-entry file sitting beside them is the
			// shape that a surface-root "item" would report, and the one this asserts it does not.
			name: "a flat surface is a no-op — a sibling file at the surface root is never an orphan",
			surface: {
				root: ".cursor/rules",
				kind: "rules",
				dialects: ["cursor"],
			},
			files: {
				".cursor/rules/foo.mdc": "# Foo\n",
				".cursor/rules/bar.mdc": "# Bar\n",
				".cursor/rules/README.md": "# How these rules are organized\n",
			},
		},
		{
			// `outer` links nothing at all, yet neither `inner/SKILL.md` nor `inner/asset.md` is
			// reported: the deepest item directory owns them, and `inner` reaches its own asset.
			name: "a nested entry document owns its own subtree — the outer item reports none of it",
			surface: { root: "skills" },
			files: {
				"skills/outer/SKILL.md": "# Outer\n",
				"skills/outer/inner/SKILL.md": "# Inner\n\n[asset](asset.md)\n",
				"skills/outer/inner/asset.md": "# Asset\n",
			},
		},
		{
			// Without `keepFootnoteDefinitions` this GFM-less parse still produces a `definition`
			// carrying `url: "notes.md"`, but `collectLinkTargets` filters it and `notes.md`
			// becomes an orphan nobody can fix without deleting a real reference.
			name: "a reference file whose only inbound link is a footnote body is not an orphan",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md":
					"# Widgets\n\nProse.[^1]\n\n[^1]: notes.md\n",
				"skills/widgets/notes.md": "# Notes\n",
			},
		},
		{
			name: "a link carrying a fragment reaches the file the path names",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md":
					"# Widgets\n\n[a section](other.md#section)\n",
				"skills/widgets/other.md": "# Other\n\n## Section\n",
			},
		},

		// The top-level `ignore` list. Every case below writes `ignore`, which is the
		// TOP-LEVEL list — repo-root-relative, merged with `DEFAULT_IGNORE` — and never
		// `surface.ignore`, which is surface-relative, discovery-only, and something this rule
		// deliberately does not read (see the rule JSDoc, "What owned excludes").
		{
			// Without the filter, `vendor/x.md` is owned by `skills/widgets`, nothing
			// links it, and it is reported — which is exactly the diagnostic an
			// `ignore`d path must not produce.
			name: "a tracked file matching the top-level ignore list is not owned, so it is not an orphan",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**"],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/vendor/x.md": "# Vendored, and nothing links it\n",
			},
		},
		{
			// The ignored file is not OWNED, but it is still walked THROUGH: `deep.md` is
			// owned, is linked from nowhere else, and stays unreported only because the walk
			// resolved `vendor/notes.md`'s own link. Filter the walk's tracked set as well and
			// an `ignore` entry starts manufacturing orphans out of files it never named.
			name: "an ignored reference file that is reached still contributes its links",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**"],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n\n[vendored](vendor/notes.md)\n",
				"skills/widgets/vendor/notes.md": "# Vendored\n\n[deep](../deep.md)\n",
				"skills/widgets/deep.md": "# Deep\n",
			},
		},
		{
			// The one that pins WHICH root the patterns are relative to. The list is
			// read repo-root-relative here (so every file under `skills/widgets` is ignored and
			// the item owns nothing), while discovery reads the same entry surface-relative
			// against `widgets/SKILL.md` — where it does not match, so the entry is still
			// discovered and still linted by every `file` rule. That the entry IS discovered is
			// asserted by the harness itself: a case discovering nothing fails on its
			// "discovered no files" guard rather than passing quietly, and a case whose rule is
			// never invoked fails on the guard after it.
			name: "a top-level ignore covering the whole item leaves it owning nothing, while its entry is still discovered",
			surface: { root: "skills" },
			ignore: ["skills/widgets/**"],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/notes.md": "# Notes\n",
			},
		},
		{
			// No `ignore` key at all: the list a rule sees is the MERGED one, so
			// `DEFAULT_IGNORE`'s `**/node_modules/**` applies here exactly as a user's own
			// pattern would. Widening, and deliberate — one list, one meaning.
			name: "DEFAULT_IGNORE counts too — a tracked node_modules file inside an item is not an orphan",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/node_modules/left-pad/index.js":
					"module.exports = () => {};\n",
			},
		},
		{
			// Normalization is the corpus's own `normalizeIgnorePattern`, not a second
			// implementation: the trailing slash is stripped (measured 2026-09-06 against
			// picomatch 4.0.7 with `{ dot: true, posix: true }`, the corpus matcher's own
			// options — `"skills/*/vendor/**/"` matches `skills/widgets/vendor/x.md` only AFTER
			// the strip), and an empty entry is dropped before normalization. The empty entry is
			// inert either way — `posix.normalize("")` is `"."`, and `.` as a picomatch pattern
			// matched only the literal path `"."` in that same measurement — so it pins that an
			// empty string never BECOMES a pattern aimed at the repo root, which is the failure
			// the drop exists to prevent.
			name: "a top-level ignore pattern is normalized like the corpus's: trailing slash stripped, empty entry dropped",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**/", ""],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/vendor/x.md": "# Vendored\n",
			},
		},
	],
	invalid: [
		{
			// The item directory is NFD-decomposed on disk. `linked.md` stays
			// silent — the reachability walk's `trackedFiles`/`visited` sets and the
			// ownership walk's `itemsByDir`/`ownerOf` all meet through `pathKey` — while
			// `orphan.md`, genuinely unlinked, is still reported exactly once, at its git-listed
			// spelling. The entry document's own path in the message stays fs-discovered
			// (NFD): `Document.path` is deliberately not touched by this fix.
			name: "an NFD-decomposed item directory: a linked file is silent, an unlinked one is reported exactly once",
			surface: { root: "skills" },
			files: {
				[`skills/${"cafe\u0301"}/SKILL.md`]: "# Cafe\n\n[linked](linked.md)\n",
				[`skills/${"cafe\u0301"}/linked.md`]: "# Linked\n",
				[`skills/${"cafe\u0301"}/orphan.md`]: "# Orphan\n",
			},
			errors: [
				{
					message: ORPHAN(
						`skills/${GIT_LISTED_CAFE}/orphan.md`,
						`skills/${"cafe\u0301"}/SKILL.md`,
					),
					file: `skills/${"caf\u00e9"}/orphan.md`,
				},
			],
		},
		{
			name: "a file under the item that nothing links to is reported by name",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/notes.md": "# Notes\n",
			},
			errors: [
				{
					message: ORPHAN("skills/widgets/notes.md", "skills/widgets/SKILL.md"),
					file: "skills/widgets/notes.md",
				},
			],
		},
		{
			// Per-item scoping, and deliberate (see the rule's JSDoc): `gadgets` links the file,
			// `widgets` owns it, and `widgets`'s walk never starts at `gadgets`' entry document.
			name: "a file linked only from a different item's entry document is still an orphan",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/shared.md": "# Shared\n",
				"skills/gadgets/SKILL.md":
					"# Gadgets\n\n[shared](../widgets/shared.md)\n",
			},
			errors: [
				{
					message: ORPHAN(
						"skills/widgets/shared.md",
						"skills/widgets/SKILL.md",
					),
					file: "skills/widgets/shared.md",
				},
			],
		},
		{
			// One directory link must not excuse everything under it: git has no index entry for
			// a directory, so the target is absent from the tracked FILE set and reaches nothing.
			name: "a link to a directory inside the item does not make its contents reachable",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n\n[the docs](reference/)\n",
				"skills/widgets/reference/notes.md": "# Notes\n",
			},
			errors: [
				{
					message: ORPHAN(
						"skills/widgets/reference/notes.md",
						"skills/widgets/SKILL.md",
					),
					file: "skills/widgets/reference/notes.md",
				},
			],
		},
		{
			// Both halves of "non-markdown is a leaf" in one case: `run.sh` is REACHED (it is not
			// reported), and it is not PARSED (the markdown-shaped link in its comment does not
			// save `notes.md`). Parse it and this case reports nothing at all.
			name: "a non-markdown file is a leaf: reached, never parsed",
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n\n[the script](run.sh)\n",
				"skills/widgets/run.sh": "#!/bin/sh\n# see [notes](notes.md) for why\n",
				"skills/widgets/notes.md": "# Notes\n",
			},
			errors: [
				{
					message: ORPHAN("skills/widgets/notes.md", "skills/widgets/SKILL.md"),
					file: "skills/widgets/notes.md",
				},
			],
		},
		{
			// Two items, one orphan each, reported in ascending path order across item boundaries.
			// `runEngine` re-sorts diagnostics itself, so this pins the SET and the per-item
			// independence rather than the rule's own comparator — see the comment at that sort.
			name: "each item is walked independently and every orphan is reported once",
			surface: { root: "skills" },
			files: {
				"skills/gadgets/SKILL.md": "# Gadgets\n",
				"skills/gadgets/z.md": "# Z\n",
				"skills/widgets/SKILL.md": "# Widgets\n\n[kept](kept.md)\n",
				"skills/widgets/kept.md": "# Kept\n",
				"skills/widgets/a.md": "# A\n",
			},
			errors: [
				{
					message: ORPHAN("skills/gadgets/z.md", "skills/gadgets/SKILL.md"),
					file: "skills/gadgets/z.md",
				},
				{
					message: ORPHAN("skills/widgets/a.md", "skills/widgets/SKILL.md"),
					file: "skills/widgets/a.md",
				},
			],
		},
		{
			// The other half of the top-level-ignore test above: `ignore` excludes what it
			// MATCHES, not the item that happens to contain it. Same fixture, same list, one
			// extra file — and the one extra file is still reported, which is what stops
			// "honours ignore" from meaning "goes quiet whenever an ignore list is present".
			name: "a top-level ignore entry does not blanket the item — a sibling stray file is still an orphan",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**"],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/vendor/x.md": "# Vendored\n",
				"skills/widgets/stray.md": "# Stray\n",
			},
			errors: [
				{
					message: ORPHAN("skills/widgets/stray.md", "skills/widgets/SKILL.md"),
					file: "skills/widgets/stray.md",
				},
			],
		},
		{
			// A measured fact found while writing the normalization test, pinned rather than left
			// to be rediscovered. A DIRECTORY-shaped pattern excludes
			// the directory and NOT the files under it: `normalizeIgnorePattern` strips the
			// trailing slash and stops there, because tinyglobby's own `/**` expansion is gated
			// on `expandDirectories`, which `discoverFiles` sets to `false` (context.ts). So
			// `skills/*/vendor/` normalizes to `skills/*/vendor`, which picomatch matches
			// against `skills/widgets/vendor` alone — measured 2026-09-06 against picomatch
			// 4.0.7 with `{ dot: true, posix: true }`, the corpus matcher's own options. Users
			// write `vendor/**`; this is here so that a future "helpful" `/**` expansion has to
			// change a test that states the trade-off instead of silently widening one word.
			name: "a directory-shaped ignore pattern excludes the directory, not the files under it",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/"],
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/vendor/x.md": "# Vendored\n",
			},
			errors: [
				{
					message: ORPHAN(
						"skills/widgets/vendor/x.md",
						"skills/widgets/SKILL.md",
					),
					file: "skills/widgets/vendor/x.md",
				},
			],
		},
	],
});

const ENTRY = "skills/widgets/SKILL.md";
const SKILL_DIR = `\${CLAUDE_SKILL_DIR}`;
const PROJECT_DIR = `\${CLAUDE_PROJECT_DIR}`;

const orphanOf = (path: string, entry = ENTRY) => ({
	message: ORPHAN(path, entry),
	file: path,
});

const HUB_ROOT = {
	root: ".agents/skills",
	spokes: [".claude/skills"],
} as const;
const CLAUDE_LINK = { ".claude/skills": "../.agents/skills" } as const;

runRuleTests(noUnreachableFiles, {
	valid: [
		{
			name: "an inline-code relative path in the entry document reaches the file",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee `references/a.md` for details.\n",
				"skills/widgets/references/a.md": "# A\n",
			},
		},
		{
			name: "a bare path on its own prose line reaches the file",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\nRun the extraction script:\nscripts/extract.py\n",
				"skills/widgets/scripts/extract.py": "print(1)\n",
			},
		},
		{
			name: "a repo-root path in a fenced shell command reaches the file",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\n```bash\npython3 skills/widgets/scripts/x.py --flag\n```\n",
				"skills/widgets/scripts/x.py": "print(1)\n",
			},
		},
		{
			name: "CLAUDE_SKILL_DIR and CLAUDE_PROJECT_DIR substitutions reach the files they name",
			surface: { root: "skills" },
			files: {
				[ENTRY]: [
					"# Widgets",
					"",
					"```bash",
					`bash ${SKILL_DIR}/scripts/x.sh`,
					`"${PROJECT_DIR}/skills/widgets/scripts/y.sh"`,
					"```",
					"",
					"[a](references/a.md)",
					"",
				].join("\n"),
				"skills/widgets/scripts/x.sh": "echo x\n",
				"skills/widgets/scripts/y.sh": "echo y\n",
				"skills/widgets/references/a.md": `# A\n\n\`${SKILL_DIR}/scripts/z.sh\`\n`,
				"skills/widgets/scripts/z.sh": "echo z\n",
			},
		},
		{
			name: "@references/x.md in prose reaches the file",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRead @references/x.md before you start.\n",
				"skills/widgets/references/x.md": "# X\n",
			},
		},
		{
			name: "a document reaches a skill-root-relative path from a subdirectory",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\n[a](references/a.md)\n",
				"skills/widgets/references/a.md": "# A\n\nSee `references/b.md`.\n",
				"skills/widgets/references/b.md": "# B\n",
			},
		},
		{
			name: "a document reaches a sibling written by its bare name",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\n[a](references/a.md)\n",
				"skills/widgets/references/a.md": "# A\n\nSee `b.md`.\n",
				"skills/widgets/references/b.md": "# B\n",
			},
		},
		{
			name: "a glob with a literal directory prefix reaches the files it matches, nested ones with **",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nAll of `notes/**/*.md` apply.\n",
				"skills/widgets/notes/a.md": "# A\n",
				"skills/widgets/notes/sub/c.md": "# C\n",
			},
		},
		{
			name: "a chain of mentions inside the item is followed",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee `references/a.md`.\n",
				"skills/widgets/references/a.md": "# A\n\nThen `references/b.md`.\n",
				"skills/widgets/references/b.md": "# B\n\nThen `scripts/x.py`.\n",
				"skills/widgets/scripts/x.py": "print(1)\n",
			},
		},
		{
			name: "trailing punctuation and wrappers around a mention are not part of the path",
			surface: { root: "skills" },
			files: {
				[ENTRY]: [
					"# Widgets",
					"",
					"End of sentence references/a.md.",
					"(references/b.md)",
					"List: references/c.md, and more",
					"**references/d.md**",
					"[references/e.md]",
					"<references/f.md>",
					"Then references/g.md; then",
					"|references/h.md|",
					"*references/i.md*",
					"See references/j.md:",
					"**references/k.md.**",
					"",
				].join("\n"),
				...Object.fromEntries(
					"abcdefghijk"
						.split("")
						.map((n) => [`skills/widgets/references/${n}.md`, "# R\n"]),
				),
			},
		},
		{
			name: "a fragment or a line suffix after a path is not part of the path",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\nSee references/a.md#section and scripts/x.py:42 and scripts/y.py:42:7.\n",
				"skills/widgets/references/a.md": "# A\n\n## Section\n",
				"skills/widgets/scripts/x.py": "print(1)\n",
				"skills/widgets/scripts/y.py": "print(2)\n",
			},
		},
		{
			name: "a ? or ! ending the sentence after a path is not part of the path, and does not make it a glob",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\nHave you read references/forms.md?\n\nThen run references/check.md!\n",
				"skills/widgets/references/forms.md": "# Forms\n",
				"skills/widgets/references/check.md": "# Check\n",
			},
		},
		{
			name: "a mention in the frontmatter reaches the file",
			surface: { root: "skills" },
			files: {
				[ENTRY]: `---\nname: widgets\nallowed-tools: Bash(${SKILL_DIR}/scripts/render.sh *)\n---\n\n# Widgets\n`,
				"skills/widgets/scripts/render.sh": "echo render\n",
			},
		},
		{
			name: "a mention inside an HTML comment counts",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\n<!-- see references/a.md -->\n",
				"skills/widgets/references/a.md": "# A\n",
			},
		},
		{
			name: "a mention through a declared spoke is rewritten onto the hub",
			surface: HUB_ROOT,
			symlinks: CLAUDE_LINK,
			files: {
				".agents/skills/widgets/SKILL.md":
					"# Widgets\n\nRun `.claude/skills/widgets/scripts/run.sh` and read .claude/skills/widgets/references/a.md.\n",
				".agents/skills/widgets/scripts/run.sh": "echo run\n",
				".agents/skills/widgets/references/a.md": "# A\n",
			},
		},
		{
			name: "a mention through an undeclared spoke that leads to the hub is rewritten onto the hub",
			surface: { root: ".agents/skills", undeclaredSpokes: [".claude/skills"] },
			symlinks: CLAUDE_LINK,
			files: {
				".agents/skills/widgets/SKILL.md":
					"# Widgets\n\nRun `.claude/skills/widgets/scripts/run.sh`.\n",
				".agents/skills/widgets/scripts/run.sh": "echo run\n",
			},
		},
		{
			name: "a mention through the symlinked surface root is rewritten onto the real root",
			surface: { root: ".claude/skills" },
			symlinks: CLAUDE_LINK,
			files: {
				".agents/skills/widgets/SKILL.md":
					"# Widgets\n\nRun `.claude/skills/widgets/scripts/run.sh`.\n",
				".agents/skills/widgets/scripts/run.sh": "echo run\n",
			},
		},
		{
			name: "a glob written through a spoke is rewritten onto the hub",
			surface: HUB_ROOT,
			symlinks: CLAUDE_LINK,
			files: {
				".agents/skills/widgets/SKILL.md":
					"# Widgets\n\nAll of `.claude/skills/widgets/notes/*.md` apply.\n",
				".agents/skills/widgets/notes/a.md": "# A\n",
			},
		},
		{
			name: "a CRLF document is scanned like an LF one",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\r\n\r\nRun\r\nscripts/x.sh\r\nthen read `references/a.md`.\r\n",
				"skills/widgets/scripts/x.sh": "echo x\n",
				"skills/widgets/references/a.md": "# A\r\n\r\nSee\r\nb.md\r\n",
				"skills/widgets/references/b.md": "# B\n",
			},
		},
		{
			name: "a BOM before the first path does not hide it",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "﻿references/a.md\r\n",
				"skills/widgets/references/a.md": "# A\n",
			},
		},
		{
			name: "a tracked file matching the top-level ignore list is not an orphan, mentioned or not",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**"],
			files: {
				[ENTRY]: "# Widgets\n\nSee `vendor/x.md`.\n",
				"skills/widgets/vendor/x.md": "# Mentioned\n",
				"skills/widgets/vendor/y.md": "# Not mentioned\n",
			},
		},
		{
			name: "a glob matches dotfiles",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nEverything in `assets/*` is shipped.\n",
				"skills/widgets/assets/.keep": "",
				"skills/widgets/assets/b.png": "not really a png\n",
			},
		},
		{
			name: "an ignored markdown file inside the item that a mention reaches is walked, not reported — its links and mentions are followed",
			surface: { root: "skills" },
			ignore: ["skills/*/vendor/**"],
			files: {
				[ENTRY]:
					"# Widgets\n\nSee `vendor/by-mention.md`, `vendor/also.md` and `vendor/glob/*.md`.\n",
				"skills/widgets/vendor/by-mention.md":
					"# Vendored\n\n[deep](../deep1.md)\n",
				"skills/widgets/vendor/also.md": "# Also vendored\n\nSee `deep2.md`.\n",
				"skills/widgets/vendor/glob/x.md":
					"# Globbed\n\n[deep](../../deep3.md)\n",
				"skills/widgets/deep1.md": "# Deep 1\n",
				"skills/widgets/deep2.md": "# Deep 2\n",
				"skills/widgets/deep3.md": "# Deep 3\n",
			},
		},
		{
			name: "a prose word with no slash or dot reaches an extensionless sibling",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRun the Makefile first.\n",
				"skills/widgets/Makefile": "all:\n",
			},
		},
		{
			name: "a link chain through a neighbour's document still reaches the file — only mentions are fenced",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\n[bridge](../gadgets/bridge.md)\n",
				"skills/widgets/orphan.md": "# Orphan\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n\n[bridge](bridge.md)\n",
				"skills/gadgets/bridge.md": "# Bridge\n\n[o](../widgets/orphan.md)\n",
			},
		},
	],
	invalid: [
		{
			name: "a bare basename of a file in a subdirectory reaches nothing",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRead a.md before you start.\n",
				"skills/widgets/references/a.md": "# A\n",
			},
			errors: [orphanOf("skills/widgets/references/a.md")],
		},
		{
			name: "a file mentioned nowhere is still reported next to mentioned ones",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee `references/a.md`.\n",
				"skills/widgets/references/a.md": "# A\n",
				"skills/widgets/references/ghost.md": "# Ghost\n",
			},
			errors: [orphanOf("skills/widgets/references/ghost.md")],
		},
		{
			name: "a directory mention, bare or with @, reaches nothing under it",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee notes/ and @docs/ for the rest.\n",
				"skills/widgets/notes/a.md": "# A\n",
				"skills/widgets/docs/b.md": "# B\n",
			},
			errors: [
				orphanOf("skills/widgets/docs/b.md"),
				orphanOf("skills/widgets/notes/a.md"),
			],
		},
		{
			name: "a glob reaches the owned files it matches and no others",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nAll of `notes/*.md` apply.\n",
				"skills/widgets/notes/a.md": "# A\n",
				"skills/widgets/notes/b.md": "# B\n",
				"skills/widgets/notes/x.txt": "x\n",
				"skills/widgets/notes/sub/c.md": "# C\n",
			},
			errors: [
				orphanOf("skills/widgets/notes/sub/c.md"),
				orphanOf("skills/widgets/notes/x.txt"),
			],
		},
		{
			name: "a glob with no literal directory prefix excuses nothing",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\nMarkdown files:\n*.md\n*\n**/*.md\n./*.md\nnotes*/*.md\n",
				"skills/widgets/top.md": "# Top\n",
				"skills/widgets/references/r.md": "# R\n",
				"skills/widgets/notes/n.md": "# N\n",
			},
			errors: [
				orphanOf("skills/widgets/notes/n.md"),
				orphanOf("skills/widgets/references/r.md"),
				orphanOf("skills/widgets/top.md"),
			],
		},
		{
			name: "a mention of a neighbour's document does not carry that document's links back into the item",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee skills/gadgets/bridge.md.\n",
				"skills/widgets/orphan.md": "# Orphan\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n\n[bridge](bridge.md)\n",
				"skills/gadgets/bridge.md": "# Bridge\n\n[o](../widgets/orphan.md)\n",
			},
			errors: [orphanOf("skills/widgets/orphan.md")],
		},
		{
			name: "a glob over a neighbour's directory does not carry its links back into the item",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nSee skills/gadgets/*.md.\n",
				"skills/widgets/orphan.md": "# Orphan\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n\n[bridge](bridge.md)\n",
				"skills/gadgets/bridge.md": "# Bridge\n\n[o](../widgets/orphan.md)\n",
			},
			errors: [orphanOf("skills/widgets/orphan.md")],
		},
		{
			name: "a mention or a glob naming another item's file does not rescue that item's orphan",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\nSee skills/gadgets/x.md and skills/gadgets/*.md.\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
				"skills/gadgets/x.md": "# X\n",
			},
			errors: [orphanOf("skills/gadgets/x.md", "skills/gadgets/SKILL.md")],
		},
		{
			name: "a mention in a document outside the item rescues nothing, even one the item links to",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\n[hub](../README.md) and [gadgets](../gadgets/SKILL.md)\n",
				"skills/widgets/notes.md": "# Notes\n",
				"skills/widgets/notes2.md": "# Notes 2\n",
				"skills/README.md": "# Hub\n\nSee `widgets/notes.md`.\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n\nSee `../widgets/notes2.md`.\n",
			},
			errors: [
				orphanOf("skills/widgets/notes.md"),
				orphanOf("skills/widgets/notes2.md"),
			],
		},
		{
			name: "a file reached by a mention is a leaf unless it is markdown",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRun `scripts/x.py`.\n",
				"skills/widgets/scripts/x.py": "# see references/hidden.md\n",
				"skills/widgets/references/hidden.md": "# Hidden\n",
			},
			errors: [orphanOf("skills/widgets/references/hidden.md")],
		},
		{
			name: "absolute paths, ~ paths, URLs and paths leaving the item are not mentions",
			surface: { root: "skills" },
			files: {
				[ENTRY]: [
					"# Widgets",
					"",
					"https://host/references/a.md",
					"/skills/widgets/references/b.md",
					"~/skills/widgets/references/c.md",
					"../outside.md",
					"../../../../etc/passwd",
					`${SKILL_DIR}/../../outside.md`,
					"",
				].join("\n"),
				"skills/widgets/references/a.md": "# A\n",
				"skills/widgets/references/b.md": "# B\n",
				"skills/widgets/references/c.md": "# C\n",
				"skills/widgets/references/d.md": "# D\n",
				"skills/outside.md": "# Outside\n\n[d](widgets/references/d.md)\n",
			},
			errors: [
				orphanOf("skills/widgets/references/a.md"),
				orphanOf("skills/widgets/references/b.md"),
				orphanOf("skills/widgets/references/c.md"),
				orphanOf("skills/widgets/references/d.md"),
			],
		},
		{
			name: "a path with a space in it is not recognized, so the file has to be linked",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					'# Widgets\n\nSee "references/my notes.md" and `references/my notes.md`.\n',
				"skills/widgets/references/my notes.md": "# Notes\n",
			},
			errors: [orphanOf("skills/widgets/references/my notes.md")],
		},
		{
			name: "$OTHER/x and $CLAUDE_SKILL_DIR/x without braces are skipped",
			surface: { root: "skills" },
			files: {
				[ENTRY]:
					"# Widgets\n\n$OTHER/scripts/a.sh\n$CLAUDE_SKILL_DIR/scripts/b.sh\n",
				"skills/widgets/scripts/a.sh": "echo a\n",
				"skills/widgets/scripts/b.sh": "echo b\n",
			},
			errors: [
				orphanOf("skills/widgets/scripts/a.sh"),
				orphanOf("skills/widgets/scripts/b.sh"),
			],
		},
		{
			name: "CLAUDE_SKILL_DIR resolves against the item alone and CLAUDE_PROJECT_DIR against the repository root alone",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\n[a](references/a.md)\n",
				"skills/widgets/references/a.md": `# A\n\n\`${SKILL_DIR}/b.md\` and \`${PROJECT_DIR}/references/c.md\`\n`,
				"skills/widgets/references/b.md": "# B\n",
				"skills/widgets/references/c.md": "# C\n",
			},
			errors: [
				orphanOf("skills/widgets/references/b.md"),
				orphanOf("skills/widgets/references/c.md"),
			],
		},
		{
			name: "a prose word with no slash or dot reaches nothing but a sibling of that name",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRun the Makefile and read notes first.\n",
				"skills/widgets/Makefile": "all:\n",
				"skills/widgets/references/Makefile": "all:\n",
				"skills/widgets/notes/a.md": "# A\n",
			},
			errors: [
				orphanOf("skills/widgets/notes/a.md"),
				orphanOf("skills/widgets/references/Makefile"),
			],
		},
		{
			name: "a brace glob reaches the files it names and no others",
			surface: { root: "skills" },
			files: {
				[ENTRY]: "# Widgets\n\nRun `scripts/{a,b}.sh`.\n",
				"skills/widgets/scripts/a.sh": "echo a\n",
				"skills/widgets/scripts/b.sh": "echo b\n",
				"skills/widgets/scripts/c.sh": "echo c\n",
			},
			errors: [orphanOf("skills/widgets/scripts/c.sh")],
		},
	],
});

/**
 * The footnote decision, stated where it actually lives instead of inferred from a green fixture:
 * one source, two calls, two different answers. Delete `keepFootnoteDefinitions` from the rule's
 * own call and the end-to-end case above turns red; delete the OPTION and `links/resolve` starts
 * reporting `notes.md` as a missing link target, which is the false positive
 * `isFootnoteDefinition` exists to prevent. Both halves have to keep holding, so both are asserted
 * here.
 */
describe("no-unreachable-files: the footnote option, against a parsed tree", () => {
	const treeOf = (source: string) =>
		parseSource("x.md", "/tmp/x.md", source, {
			root: ".",
			kind: "skills",
			dialects: ["generic"],
			include: [],
			ignore: [],
			spokes: [],
			rules: new Map(),
		}).ast;

	test("the default walk drops a footnote body and the orphan walk keeps it", () => {
		const tree = treeOf("Prose.[^1]\n\n[^1]: notes.md\n\n[ref]: ./a.md\n");

		expect(collectLinkTargets(tree).map((t) => t.url)).toEqual(["./a.md"]);
		expect(
			collectLinkTargets(tree, { keepFootnoteDefinitions: true }).map(
				(t) => t.url,
			),
		).toEqual(["notes.md", "./a.md"]);
	});

	test("the option changes nothing for a document with no footnote in it", () => {
		const tree = treeOf("[a](./a.md)\n\n![b](./b.png)\n\n[ref]: ./c.md\n");
		const urls = ["./a.md", "./b.png", "./c.md"];

		expect(collectLinkTargets(tree).map((t) => t.url)).toEqual(urls);
		expect(
			collectLinkTargets(tree, { keepFootnoteDefinitions: true }).map(
				(t) => t.url,
			),
		).toEqual(urls);
	});
});

/**
 * `loadWalkable`'s containment check (applied to a reference file), which `RuleTester`
 * cannot reach: its `files` map only ever writes plain files (`writeFiles`, rule-tester.ts), never
 * a symlink. So this calls `noUnreachableFiles.check(ctx)` directly against a hand-built temp
 * checkout, the same idiom `index/complete.test.ts` and `links/resolve.test.ts` use for a fixture
 * `RuleTester` cannot express.
 */
describe("no-unreachable-files: a reference file symlinked out of the repository", () => {
	test("is reached, but is never read — so nothing it says can mark another file reachable", async () => {
		const parent = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-orphan-escape-")),
		);
		try {
			const root = join(parent, "repo");
			const widgets = join(root, "skills", "widgets");
			await mkdir(widgets, { recursive: true });

			// The out-of-repo file. Its link is REPO-ROOT-relative on purpose: a plain relative
			// link would resolve against this file's own (outside) directory and be rejected by
			// `resolveTarget` anyway, which would make the case pass for a reason that has
			// nothing to do with the check under test. Written as `/skills/...`, it resolves
			// squarely inside the repository — so if this content is ever read, it really does
			// decide whether `trapped.md` counts as reachable.
			const outside = join(parent, "outside");
			await mkdir(outside, { recursive: true });
			await writeFile(
				join(outside, "secret.md"),
				"# Not part of the repository\n\n[trap](/skills/widgets/trapped.md)\n",
				"utf8",
			);

			const entrySource = "# Widgets\n\n[escape](escape.md)\n";
			await writeFile(join(widgets, "SKILL.md"), entrySource, "utf8");
			await symlink(join(outside, "secret.md"), join(widgets, "escape.md"));
			await writeFile(join(widgets, "trapped.md"), "# Trapped\n", "utf8");
			// git tracks a symlink by its own path whatever it points at (`TrackedFileIndex`'s
			// own doc) — which is exactly why the index cannot answer this question and the
			// containment check has to.
			await gitInitAndCommit(root);

			const surface = freezeSurface({
				root: "skills",
				kind: "skills",
				dialects: ["generic"],
				include: DEFAULT_INCLUDE.skills,
				ignore: [],
				spokes: [],
				rules: sealMap(new Map()),
			});
			const entry = parseSource(
				"skills/widgets/SKILL.md",
				join(widgets, "SKILL.md"),
				entrySource,
				surface,
			);
			const ctx: RuleContext = {
				...createCapabilities(root, async () => [entry]),
				options: {},
				surface,
			};

			// `escape.md` itself is reached (it is a tracked path the entry links) and therefore
			// absent from this list. `trapped.md` is present because the only thing that "links"
			// it lives outside the repository and was never read — drop the containment check and
			// this list is empty.
			expect(await noUnreachableFiles.check(ctx)).toEqual([
				{
					message: ORPHAN(
						"skills/widgets/trapped.md",
						"skills/widgets/SKILL.md",
					),
					file: "skills/widgets/trapped.md",
				},
			]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
});

describe("no-unreachable-files: a git listing in NFD, as Linux gives it", () => {
	test("an owned file is looked up in the reached set by its pathKey, whatever spelling git listed", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-orphan-nfd-")),
		);
		try {
			const dir = `skills/${"cafe\u0301"}`;
			await mkdir(join(root, dir), { recursive: true });
			const entrySource = "# Cafe\n\n[linked](linked.md)\n";
			await writeFile(join(root, dir, "SKILL.md"), entrySource, "utf8");
			await writeFile(join(root, dir, "linked.md"), "# Linked\n", "utf8");
			await writeFile(join(root, dir, "orphan.md"), "# Orphan\n", "utf8");

			const surface = freezeSurface({
				root: "skills",
				kind: "skills",
				dialects: ["generic"],
				include: DEFAULT_INCLUDE.skills,
				ignore: [],
				spokes: [],
				rules: sealMap(new Map()),
			});
			const entry = parseSource(
				`${dir}/SKILL.md`,
				join(root, dir, "SKILL.md"),
				entrySource,
				surface,
			);
			const caps = createCapabilities(root, async () => [entry]);
			const ctx: RuleContext = {
				...caps,
				git: {
					...caps.git,
					trackedFiles: async () => [
						`${dir}/SKILL.md`,
						`${dir}/linked.md`,
						`${dir}/orphan.md`,
					],
				},
				options: {},
				surface,
			};

			expect(await noUnreachableFiles.check(ctx)).toEqual([
				{
					message: ORPHAN(`${dir}/orphan.md`, `${dir}/SKILL.md`),
					file: `${dir}/orphan.md`,
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

/**
 * `noUnreachableFiles.check` against a git listing the test writes by hand, so the spelling git
 * gives a path (NFC on macOS, the raw NFD bytes on Linux) and the order it lists them in are
 * inputs of the case, not properties of the machine running it.
 */
async function checkAgainstListing(
	files: Readonly<Record<string, string>>,
	listing: readonly string[],
) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "skillslurp-orphan-listing-")),
	);
	try {
		const surface = freezeSurface({
			root: "skills",
			kind: "skills",
			dialects: ["generic"],
			include: DEFAULT_INCLUDE.skills,
			ignore: [],
			spokes: [],
			rules: sealMap(new Map()),
		});
		const entries: Document[] = [];
		for (const [path, source] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source, "utf8");
			entries.push(parseSource(path, join(root, path), source, surface));
		}
		const caps = createCapabilities(root, async () => entries);
		const ctx: RuleContext = {
			...caps,
			git: { ...caps.git, trackedFiles: async () => listing },
			options: {},
			surface,
		};
		return await noUnreachableFiles.check(ctx);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("no-unreachable-files: mentions against a hand-written git listing", () => {
	test("a mention and a glob are matched by pathKey, whichever spelling the document or git used", async () => {
		const dir = "skills/widgets";
		const reports = await checkAgainstListing(
			{
				[`${dir}/SKILL.md`]: [
					"# Widgets",
					"",
					"`references/a-caf\u00e9.md` `references/b-cafe\u0301.md`",
					"`notes-caf\u00e9/*.md` `notes-cafe\u0301/*.txt` `docs/e\u0301-*.md`",
					"",
				].join("\n"),
			},
			[
				`${dir}/SKILL.md`,
				`${dir}/references/a-cafe\u0301.md`,
				`${dir}/references/b-caf\u00e9.md`,
				`${dir}/references/zzz.md`,
				`${dir}/notes-cafe\u0301/x.md`,
				`${dir}/notes-caf\u00e9/y.txt`,
				`${dir}/docs/\u00e9-x.md`,
			],
		);

		expect(reports).toEqual([
			{
				message: ORPHAN(`${dir}/references/zzz.md`, `${dir}/SKILL.md`),
				file: `${dir}/references/zzz.md`,
			},
		]);
	});

	test("orphans come out in ascending path order whatever order git listed them in", async () => {
		const reports = await checkAgainstListing(
			{
				"skills/b/SKILL.md": "# B\n",
				"skills/a/SKILL.md": "# A\n\nSee `k.md`.\n",
			},
			[
				"skills/b/y.md",
				"skills/b/SKILL.md",
				"skills/a/z.md",
				"skills/a/m.md",
				"skills/a/k.md",
				"skills/a/SKILL.md",
			],
		);

		expect(reports.map((report) => report.file)).toEqual([
			"skills/a/m.md",
			"skills/a/z.md",
			"skills/b/y.md",
		]);
	});
});

describe("no-unreachable-files meta", () => {
	test("is a project rule, an error in both tiers, and takes no options", () => {
		expect(noUnreachableFiles.meta.id).toBe("refs/no-unreachable-files");
		expect(noUnreachableFiles.meta.tiers).toEqual(["recommended", "strict"]);
		expect(noUnreachableFiles.meta.defaultSeverity).toBe("error");
		expect(noUnreachableFiles.meta.fixable).toBe(false);
		expect(noUnreachableFiles.meta.optionsSchema).toBeUndefined();
		expect(noUnreachableFiles.kind).toBe("project");
	});
});
