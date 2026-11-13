import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_IGNORE,
	freezeSurface,
	type ResolvedConfig,
	type ResolvedRule,
	type ResolvedSurface,
	type SurfaceRuleOverride,
	sealMap,
} from "../../config.js";
import type { Diagnostic, Severity } from "../../diagnostic.js";
import {
	DEFAULT_INCLUDE,
	type DialectId,
	type SurfaceKind,
} from "../../dialects.js";
import { runEngine } from "../../engine.js";
import { computeExitCode, EXIT_VIOLATIONS } from "../../exit.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { AllowlistSchema, createAllowlistTracker } from "./allowlist.js";
import { noDanglingPaths, OptionsSchema } from "./no-dangling-paths.js";

/**
 * Three sections, each covering what the others structurally cannot.
 *
 * **(A) `runRuleTests`** — the whole rule through the real engine over a real ephemeral git
 * checkout, for everything a SINGLE surface can express: the hit grammar (every one of the
 * refined edge cases), existence against the tracked-file index, the allowlist and its staleness
 * guard, and the config-file corpus exclusion the guard depends on. The mentions written through a
 * declared spoke or a symlinked surface root are a second `runRuleTests` call right after it.
 *
 * **(B) a hand-built multi-surface `ResolvedConfig` through `runEngine`** — because `RuleTester`
 * builds exactly one surface per case (`buildSurface`), and "roots come from EVERY surface" is
 * about there being more than one.
 *
 * **(C) the exit code and the options schema** — that a stale entry with zero real violations
 * still fails the run, and that this rule is enableable with no options at all.
 *
 * Every case pins `surface.root` explicitly rather than taking `RuleTester`'s default of `.`: the
 * surface root IS this rule's input, so a case that let it default would be testing the repo-root
 * spelling of a path rather than the one every real config produces.
 */

/** A minimal skill entry — nothing here is ever about the frontmatter. */
const SKILL = "# Widgets\n";

const CLAUDE_SKILLS = { root: ".claude/skills" } as const;

runRuleTests(noDanglingPaths, {
	valid: [
		{
			name: "every literal path pointing into a surface root resolves",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				".claude/skills/acme-widgets/reference.md": "# Reference\n",
				"docs/guide.md":
					"See .claude/skills/acme-widgets and .claude/skills/acme-widgets/SKILL.md\n",
			},
		},
		{
			// The directory half of "exists": nothing is tracked AT `.claude/skills/acme-widgets`,
			// only underneath it, and a mention of the item directory is the commonest form of
			// all. `TrackedFileIndex` holds every tracked path's ancestors for exactly this.
			name: "a path naming a directory that only has tracked files underneath it resolves",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/nested/SKILL.md": SKILL,
				"docs/guide.md": "See .claude/skills/acme-widgets\n",
			},
		},
		{
			// The `~/` case, added to the edge-case list on 2026-09-05: a user-level skill
			// directory is the single commonest path mention in agent-facing documentation and is
			// not this repository's path. `~` never reaches the lookbehind — the character right
			// before `.claude` is the `/` — so this case is really the `/` half of the exclusion.
			name: "a user-level or absolute path carrying the same suffix is skipped",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"Install to ~/.claude/skills/acme-gone or /etc/.claude/skills/acme-gone\n",
			},
		},
		{
			// The word-character half of the same lookbehind: `my.claude/skills/...` is a
			// different tree that merely ends in this surface's root.
			name: "a path whose root is preceded by a word character is skipped",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "Vendored under my.claude/skills/acme-gone\n",
			},
		},
		{
			// A bare surface root names no item, so there is no item that could have gone
			// missing — with or without the trailing slash.
			name: "a surface root mentioned with nothing after it is not an item reference",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"Skills live in .claude/skills and are written under .claude/skills/ by hand.\n",
			},
		},
		{
			// Not literal paths: a glob, a shell/CI interpolation, and now a `<placeholder>` —
			// none of the four name a file that could be looked up, whether the surface root is
			// followed by wildcard syntax or by a `<name>`-style token a reader is meant to fill
			// in themselves.
			name: "a run holding a glob, an interpolation or a placeholder is not a literal path",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"scripts/build.sh": [
					"cp .claude/skills/*/SKILL.md out/",
					// Written as an escaped template literal so the fixture holds a literal
					// `${name}` without biome reading it as a placeholder someone forgot to
					// interpolate — the shell/CI interpolation IS what this line tests.
					`cat ".claude/skills/\${name}/SKILL.md"`,
					"cat .claude/skills/acme-[0-9]/SKILL.md",
					"cat .claude/skills/{a,b}/SKILL.md",
					// The placeholder sits mid-run, followed by a real path segment —
					// the commonest way a placeholder is spelled in agent-facing documentation.
					"echo .claude/skills/<name>/SKILL.md is the manifest",
					// The placeholder IS the whole run — nothing follows before the
					// newline, so `trimTrailingPunctuation` strips the closing `>` first and
					// what `GLOB_CHARS` sees is `<` alone. That is the fact this line pins: `<`
					// by itself, not the `<...>` pair, is what marks a run as a placeholder.
					"echo see .claude/skills/<name>",
					"",
				].join("\n"),
			},
		},
		{
			// Trailing `.`/`,`/`;`/`:`/`)`/`]`/`>` are the sentence's or the wrapper's, not the
			// path's. Each mention below resolves only because the punctuation is trimmed before
			// the lookup — `SKILL.md` proves the trim is trailing-only (an interior dot survives
			// it), and the final line proves `>` gets identical treatment: a
			// markdown-autolink-style `<path>` mention resolves once its wrapper is stripped,
			// exactly like the `)` and `]` above it. Its leading `<` is never captured at all —
			// `PATH_RUN` only starts matching at the surface root, and the lookbehind that guards
			// the root excludes only `/`, `~` and a word character, so `<` in front of it is not
			// one of those and the match begins right at the `.`.
			name: "trailing sentence punctuation is trimmed before the lookup",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": [
					"Read .claude/skills/acme-widgets.",
					"Also .claude/skills/acme-widgets, and .claude/skills/acme-widgets;",
					"here: .claude/skills/acme-widgets: yes",
					"(see .claude/skills/acme-widgets) and [.claude/skills/acme-widgets]",
					"Entry point: .claude/skills/acme-widgets/SKILL.md.",
					"Wrapped: <.claude/skills/acme-widgets/SKILL.md> ok.",
					"",
				].join("\n"),
			},
		},
		{
			// The quoting delimiters are not part of a path. Without them ending the run, every
			// one of these mentions would carry its closing delimiter into the lookup, resolve to
			// nothing, and be reported — a false positive on the way a path is most often written.
			name: "a path wrapped in backticks or quotes resolves without its delimiter",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"Read `.claude/skills/acme-widgets`, its own `.claude/skills/acme-widgets`'s entry.\n",
				"config/paths.yaml":
					"skill: \".claude/skills/acme-widgets\"\nother: '.claude/skills/acme-widgets'\n",
			},
		},
		{
			// The bounded cost of skipping any run that contains `<` as a placeholder or tag: with no
			// space before the closing tag, the run captured after the surface root
			// is `.claude/skills/acme-widgets</code>`. Trimming strips only the final `>`,
			// leaving `.claude/skills/acme-widgets</code` — which still carries the `<` from
			// `</code>` and so is judged a placeholder/tag, not a literal path, and skipped
			// before the tracked-file lookup ever runs. Previously the same run was
			// reported EVERY time, because `foo</code>` can never resolve — a false positive on
			// valid input. Now it is a possible false negative instead: a real path spelled this
			// way is silently skipped rather than checked. CLAUDE.md's rule is which direction to
			// err in, not that the cost disappears.
			name: "a path glued to a closing HTML tag is skipped, not reported",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"<code>.claude/skills/acme-widgets</code> is deprecated.\n",
			},
		},
		{
			// A regression pin rather than a new behaviour: `|` was named in the same
			// JSDoc sentence as `<` and `>` but is left alone — a
			// markdown table cell already resolves today because whitespace on both sides of the
			// path ends the run before either pipe is ever part of the candidate. Pinned so a
			// future change to the trim or glob sets cannot silently start eating `|` too.
			name: "a path in a markdown table cell resolves, with `|` left untouched",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "| .claude/skills/acme-widgets | ok |\n",
			},
		},
		{
			// Both halves at once: no violation (suppressed) AND no `config/stale-allowlist`
			// (marked used). Delete `unused.delete(value)` in `createAllowlistTracker` and this
			// case fails on the second half alone.
			name: "an allowlisted path is suppressed, and the entry counts as used",
			surface: CLAUDE_SKILLS,
			options: { allowlist: [".claude/skills/acme-retired"] },
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"Historical note: .claude/skills/acme-retired is gone.\n",
			},
		},
		{
			// `**\/node_modules/**` is in `DEFAULT_IGNORE`, which `RuleTester` puts on
			// `ResolvedConfig.ignore` exactly as `loadConfig` would, so the corpus skips it.
			name: "a hit in a file the top-level ignore excludes is never scanned",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"node_modules/pkg/README.md":
					"stale .claude/skills/acme-gone mention\n",
			},
		},
	],
	invalid: [
		{
			// The rule's whole reason to exist, in a non-markdown file: a renamed item directory
			// leaves the old path behind in a script or a CI file, where no markdown-only check
			// would ever look.
			name: "a moved item leaves a stale path in a script, reported at the path",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				".github/workflows/ci.yml":
					"jobs:\n  lint:\n    run: cat .claude/skills/acme-gadgets/SKILL.md\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gadgets/SKILL.md" does not exist or is not tracked by git',
					file: ".github/workflows/ci.yml",
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 50,
				},
			],
		},
		{
			// The strict-prefix case, and it gets no accidental pass: `acme-widget` is a prefix
			// of the real `acme-widgets` as a STRING, but the tracked-file index holds a path's
			// real ancestors, never a prefix of one of its segments.
			name: "a path that is a strict prefix of a real path is still dangling",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "See .claude/skills/acme-widget\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-widget" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 31,
				},
			],
		},
		{
			// One diagnostic per HIT, not per distinct path: the same stale path in three places
			// is three places a reader has to go and fix.
			//
			// The ORDER the three come out in is deliberately not what this case claims to
			// prove, and the distinction was measured rather than assumed: `runEngine` sorts
			// every diagnostic itself (`deduped.sort(compareDiagnostics)`, engine.ts), so
			// reversing the loop over `ctx.grep`'s hits inside `check` leaves this case green.
			// A rule test cannot pin rule-side ordering through the engine, and pretending
			// otherwise is how a test passes for the wrong reason.
			name: "the same dangling path is reported once per hit, not once per path",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/a.md":
					".claude/skills/acme-gone\nand again .claude/skills/acme-gone\n",
				"docs/b.md": ".claude/skills/acme-gone\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/a.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 25,
				},
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/a.md",
					line: 2,
					col: 11,
					endLine: 2,
					endCol: 35,
				},
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/b.md",
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 25,
				},
			],
		},
		{
			// The trim is not a way to avoid checking: a dangling path at the end of a sentence is
			// still dangling, and the reported span covers the path WITHOUT the full stop, so a
			// fix lands on the path alone.
			//
			// The second line is where the trim-then-glob ORDER becomes observable: `]` is in
			// both sets, so testing `GLOB_CHARS` first would read a bracketed mention as a
			// character class and silently skip it. It cannot show up in a valid case — a skipped
			// hit and a resolving one look identical from outside — so it is pinned here.
			//
			// The third line: the SAME dangling path wrapped `<...>`, markdown-autolink
			// style. The leading `<` is never captured, and the trailing `>` is trimmed
			// unconditionally, the same status as `)` and `]` above — the report names the bare
			// path, and its span excludes the `>` while `col` still points at the leading `.`.
			//
			// The fourth line: a stray trailing `>` with no opener anywhere in the
			// line. Trimming does not care whether the run was ever wrapped in the first place,
			// so it is stripped here too and the path is reported exactly the same way — pinning
			// that the trim is unconditional, like `)` today, not conditional on a matching `<`.
			name: "a dangling path at the end of a sentence is reported without its punctuation",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md":
					"Renamed from .claude/skills/acme-gone.\nSee [.claude/skills/acme-gone]\nWrapped <.claude/skills/acme-gone> too.\nStray .claude/skills/acme-gone> trailing.\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 14,
					endLine: 1,
					endCol: 38,
				},
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 2,
					col: 6,
					endLine: 2,
					endCol: 30,
				},
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 3,
					col: 10,
					endLine: 3,
					endCol: 34,
				},
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 4,
					col: 7,
					endLine: 4,
					endCol: 31,
				},
			],
		},
		{
			// A path that exists on disk but is not in the index is not a path a CI checkout can
			// follow — the same posture `links/resolve` takes. `RuleTester` commits only what
			// `files` wrote, so an untracked path cannot be expressed as a fixture at all; the
			// tracked-file index is asserted here through the one shape that can be, a path under
			// a directory git has nothing at.
			name: "a path under a directory git tracks nothing under is dangling",
			surface: CLAUDE_SKILLS,
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "Notes in .claude/skills/acme-widgets/notes/OLD.md\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-widgets/notes/OLD.md" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 10,
					endLine: 1,
					endCol: 50,
				},
			],
		},
		{
			// What this case exists to prove: the config file is not in the
			// corpus, and the staleness guard depends on it. The ONLY textual occurrence of
			// `.claude/skills/acme-retired` in this fixture is the allowlist entry's own literal
			// inside `skillslurp.json`. Put the config file back in the corpus and that
			// literal becomes a hit — one that resolves to nothing, so it would both be reported
			// as a violation AND mark the entry used, and a stale entry could never be found.
			name: "the allowlist entry's own literal in skillslurp.json never counts as a use",
			surface: CLAUDE_SKILLS,
			options: { allowlist: [".claude/skills/acme-retired"] },
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"skillslurp.json": [
					"{",
					'  "version": 1,',
					'  "surfaces": [{',
					'    "root": ".claude/skills",',
					'    "rules": { "refs/no-dangling-paths": { "options": {',
					'      "allowlist": [".claude/skills/acme-retired"]',
					"    } } }",
					"  }]",
					"}",
					"",
				].join("\n"),
			},
			errors: [
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/acme-retired" matched nothing — remove it',
					file: "skillslurp.json",
					fixable: false,
				},
			],
		},
		{
			// The OTHER half of staleness — "name now exists on disk". The mention is there
			// and the entry names it, but the path resolves again, so the entry suppressed
			// nothing. This is what the existence-before-allowlist gate order buys: swap the two
			// checks in `check` and the entry gets marked used and this case goes green.
			name: "an allowlist entry whose path exists again is stale too",
			surface: CLAUDE_SKILLS,
			options: { allowlist: [".claude/skills/acme-widgets"] },
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "See .claude/skills/acme-widgets\n",
			},
			errors: [
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/acme-widgets" matched nothing — remove it',
					file: "skillslurp.json",
					fixable: false,
				},
			],
		},
		{
			name: "a dangling path and a dead allowlist entry are reported independently",
			surface: CLAUDE_SKILLS,
			options: { allowlist: [".claude/skills/acme-never"] },
			files: {
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				"docs/guide.md": "Gone: .claude/skills/acme-gone.\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 7,
					endLine: 1,
					endCol: 31,
				},
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/acme-never" matched nothing — remove it',
					file: "skillslurp.json",
					fixable: false,
				},
			],
		},
		{
			// A non-`skills` surface reports like any other, and its root is spelled with a
			// trailing slash — the raw string a user may write, which `normalizeSurfaceRoot` has
			// to fix before the pattern can match anything at all. Drop that normalization and
			// this case produces zero diagnostics instead of one.
			name: "a dangling path on a rules surface whose configured root has a trailing slash",
			surface: { root: ".cursor/rules/", kind: "rules", dialects: ["cursor"] },
			files: {
				".cursor/rules/acme-style.mdc": "# Style\n",
				"docs/guide.md": "See .cursor/rules/acme-styles.mdc\n",
			},
			errors: [
				{
					message:
						'Path ".cursor/rules/acme-styles.mdc" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 34,
				},
			],
		},
	],
});

/**
 * The same rule through the same harness for mentions written through a spelling git has no
 * entries for: a spoke of the surface (declared, or without a `loc` as detection records it), or
 * a surface root that is itself a symlink. Git
 * lists a link under its own path and nothing below it, so none of these mentions can be found in
 * the index as written; each is rewritten onto the real root, and only the lookup sees that.
 */
const HUB_ITEM = {
	".agents/skills/acme-widgets/SKILL.md": SKILL,
	".agents/skills/acme-widgets/reference.md": "# Reference\n",
} as const;

/** `.claude/skills` is one symlink to the hub `.agents/skills`. */
const CLAUDE_LINK = { ".claude/skills": "../.agents/skills" } as const;

/** The hub as the surface, `.claude/skills` as its declared spoke. */
const AGENTS_HUB = {
	root: ".agents/skills",
	spokes: [".claude/skills"],
} as const;

/**
 * Feature-detected, not platform-string-checked, as `discover.test.ts` does: CI is case-sensitive,
 * a darwin checkout usually is not, and the cases that need the difference only mean something on
 * a filesystem that folds case.
 */
const CASE_INSENSITIVE_FS = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-case-probe-"));
	try {
		await mkdir(join(dir, "probe"));
		return await stat(join(dir, "PROBE")).then(
			() => true,
			() => false,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

runRuleTests(noDanglingPaths, {
	valid: [
		{
			name: "a mention through a declared spoke of an existing hub item resolves",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .claude/skills/acme-widgets for the item.\n",
			},
		},
		{
			// The part after the spoke is carried over untouched: `.claude/skills/acme-widgets/reference.md`
			// is looked up as `.agents/skills/acme-widgets/reference.md`, not as a directory's name
			// with the remainder dropped or glued on.
			name: "a file below a hub item, written through the spoke, resolves through the hub",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md":
					"Read .claude/skills/acme-widgets/reference.md and .agents/skills/acme-widgets/SKILL.md\n",
			},
		},
		{
			// The deduced false positive, pinned: the surface is configured at the link itself, so
			// every mention through the configured path used to be looked up below a symlink.
			name: "a valid mention through a surface root that is a directory-level symlink resolves",
			surface: CLAUDE_SKILLS,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .claude/skills/acme-widgets/SKILL.md\n",
			},
		},
		{
			name: "a mention through the real path of a symlinked surface root resolves",
			surface: CLAUDE_SKILLS,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .agents/skills/acme-widgets/SKILL.md\n",
			},
		},
		{
			name: "a user-level path carrying a spoke's spelling is still skipped",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "Install to ~/.claude/skills/acme-gone\n",
			},
		},
		{
			// The `/` after the alias is part of the pattern: `.claude/skills-other` is a different
			// directory that merely starts with the spoke's name, and no alias heads it.
			name: "a path that only shares a prefix with a spoke is not a mention of it",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .claude/skills-other/acme-gone/SKILL.md\n",
			},
		},
		{
			// Three spokes that overlap by name. `.claude/skills/legacy` is a link inside the
			// spoke `.claude/skills` (an item-level spoke), so the longer alias is the one that
			// names the hub; taking the shorter would look for `.agents/skills/legacy/...`.
			// `.claude/skills-extra` must not be read as `.claude/skills` + `-extra`.
			name: "the longest spoke heading a path is the one that is rewritten",
			surface: {
				root: ".agents/skills",
				spokes: [
					".claude/skills",
					".claude/skills-extra",
					".claude/skills/legacy",
				],
			},
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": [
					"See .claude/skills/legacy/acme-widgets/SKILL.md",
					"and .claude/skills-extra/acme-widgets/SKILL.md",
					"and .claude/skills/acme-widgets/SKILL.md",
					"",
				].join("\n"),
			},
		},
		{
			// Both halves at once, as for any allowlist: suppressed, and counted as used.
			name: "an allowlist entry spelled through a spoke suppresses that mention",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			options: { allowlist: [".claude/skills/acme-retired"] },
			files: {
				...HUB_ITEM,
				"docs/guide.md":
					"Historical note: .claude/skills/acme-retired is gone.\n",
			},
		},
		{
			name: "a mention of an existing hub item through an undeclared spoke that leads to the hub resolves",
			surface: { root: ".agents/skills", undeclaredSpokes: [".claude/skills"] },
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md":
					"See .claude/skills/acme-widgets/reference.md for the item.\n",
			},
		},
		{
			// Undeclared spokes are followed only as far as declared ones: not when they lead elsewhere.
			name: "an undeclared spoke that leads somewhere else than the hub is not an alias",
			surface: { root: ".agents/skills", undeclaredSpokes: [".codex/skills"] },
			symlinks: { ".codex/skills": "../other/skills" },
			files: {
				...HUB_ITEM,
				"other/skills/bar/SKILL.md": SKILL,
				"docs/guide.md": "See .codex/skills/acme-gone/SKILL.md\n",
			},
		},
		{
			// A real directory that is a spoke is an item-level spoke: git tracks what is committed
			// in it under its own path, and only what is committed there is found as written.
			name: "a tracked file inside an item-level spoke, written through the spoke, resolves as written",
			surface: AGENTS_HUB,
			symlinks: {
				".claude/skills/acme-widgets": "../../.agents/skills/acme-widgets",
			},
			files: {
				...HUB_ITEM,
				".claude/skills/README.md": "# Skills\n",
				"docs/guide.md": "See .claude/skills/README.md for the layout.\n",
			},
		},
		{
			// `.codex/skills` is a directory-level spoke (the spoke path itself is a link), and it
			// points somewhere other than the hub: it is no alias of the hub, so a mention through it
			// is unrecognized rather than judged against `.agents/skills/bar`. `hub/symlinks` is the
			// rule that reports the spoke itself.
			name: "a mention through a directory-level spoke that resolves somewhere else than the hub is not recognized",
			surface: { root: ".agents/skills", spokes: [".codex/skills"] },
			symlinks: { ".codex/skills": "../other/skills" },
			files: {
				...HUB_ITEM,
				"other/skills/bar/SKILL.md": SKILL,
				"docs/guide.md": "See .codex/skills/bar/SKILL.md\n",
			},
		},
		{
			// `.claude/skills` and `.claude/skills/leg` are both declared; the second does not exist
			// (it would sit below the link), so it is an alias by default. A mention of
			// `.claude/skills/legacy/...` starts with its text but not with `.claude/skills/leg/`,
			// so the shorter spoke is the one that applies.
			name: "a spoke is matched up to the slash, not as a prefix of a longer name",
			surface: {
				root: ".agents/skills",
				spokes: [".claude/skills", ".claude/skills/leg"],
			},
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				".agents/skills/legacy/SKILL.md": SKILL,
				"docs/guide.md": "See .claude/skills/legacy/SKILL.md\n",
			},
		},
		{
			// Both links lead to the same real root; the spoke must map to that, not to the written
			// `.claude/skills`, below which git tracks nothing.
			name: "a spoke of a surface whose root is itself a symlink maps to the real root",
			surface: { root: ".claude/skills", spokes: [".cursor/skills"] },
			symlinks: {
				".claude/skills": "../.agents/skills",
				".cursor/skills": "../.agents/skills",
			},
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .cursor/skills/acme-widgets/SKILL.md\n",
			},
		},
		...(CASE_INSENSITIVE_FS
			? [
					{
						// The real root differs from the written one by case alone: no link is involved, so
						// its spelling is not a second alias and is not scanned for, as before.
						name: "the on-disk spelling of a root that differs only by case is not an alias",
						surface: { root: ".Claude/skills" },
						files: {
							".claude/skills/acme-widgets/SKILL.md": SKILL,
							"docs/guide.md": "See .claude/skills/missing/SKILL.md\n",
						},
					},
				]
			: []),
	],
	invalid: [
		{
			// The spoke is a different length from the hub so that the span pins the spelling the
			// user wrote, not the rewritten one.
			name: "a mention through a declared spoke of a missing item is reported as written",
			surface: { root: ".agents/skills", spokes: [".codex/skills"] },
			symlinks: { ".codex/skills": "../.agents/skills" },
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .codex/skills/acme-gone/SKILL.md\n",
			},
			errors: [
				{
					message:
						'Path ".codex/skills/acme-gone/SKILL.md" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 37,
				},
			],
		},
		{
			name: "a mention of a missing item through an undeclared spoke that leads to the hub is reported as written",
			surface: { root: ".agents/skills", undeclaredSpokes: [".claude/skills"] },
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .claude/skills/acme-gone/SKILL.md\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gone/SKILL.md" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 38,
				},
			],
		},
		{
			name: "a dangling mention through the real path of a symlinked surface root is reported",
			surface: CLAUDE_SKILLS,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .agents/skills/acme-gone/SKILL.md\n",
			},
			errors: [
				{
					message:
						'Path ".agents/skills/acme-gone/SKILL.md" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 38,
				},
			],
		},
		{
			name: "a dangling mention through a symlinked surface root is reported as written",
			surface: CLAUDE_SKILLS,
			symlinks: CLAUDE_LINK,
			files: {
				...HUB_ITEM,
				"docs/guide.md": "See .claude/skills/acme-gone/SKILL.md\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-gone/SKILL.md" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 5,
					endLine: 1,
					endCol: 38,
				},
			],
		},
		{
			// The entry is matched against the mention as it stands in the file: one spelled with
			// the hub's path suppresses nothing written through the spoke, and so is stale too.
			name: "an allowlist entry spelled with the hub path does not suppress a mention written through a spoke",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			options: { allowlist: [".agents/skills/acme-retired"] },
			files: {
				...HUB_ITEM,
				"docs/guide.md":
					"Historical note: .claude/skills/acme-retired is gone.\n",
			},
			errors: [
				{
					message:
						'Path ".claude/skills/acme-retired" does not exist or is not tracked by git',
					file: "docs/guide.md",
					line: 1,
					col: 18,
					endLine: 1,
					endCol: 45,
				},
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".agents/skills/acme-retired" matched nothing — remove it',
					file: "skillslurp.json",
					fixable: false,
				},
			],
		},
		{
			name: "an unused allowlist entry spelled through a spoke is still stale",
			surface: AGENTS_HUB,
			symlinks: CLAUDE_LINK,
			options: {
				allowlist: [".claude/skills/acme-retired", ".claude/skills/acme-never"],
			},
			files: {
				...HUB_ITEM,
				"docs/guide.md":
					"Historical note: .claude/skills/acme-retired is gone.\n",
			},
			errors: [
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/acme-never" matched nothing — remove it',
					file: "skillslurp.json",
					fixable: false,
				},
			],
		},
		...(CASE_INSENSITIVE_FS
			? [
					{
						name: "a dangling mention through a root written with other casing than on disk is reported as written",
						surface: { root: ".Claude/skills" },
						files: {
							".claude/skills/acme-widgets/SKILL.md": SKILL,
							"docs/guide.md": "See .Claude/skills/missing/SKILL.md\n",
						},
						errors: [
							{
								message:
									'Path ".Claude/skills/missing/SKILL.md" does not exist or is not tracked by git',
								file: "docs/guide.md",
								line: 1,
								col: 5,
								endLine: 1,
								endCol: 36,
							},
						],
					},
				]
			: []),
	],
});

/* ------------------------------------------------------------------------------------------ */

/** Materializes `files` into a fresh temp git checkout and runs `body` against its real root. */
async function withRepo<T>(
	files: Readonly<Record<string, string>>,
	body: (root: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-dangling-paths-"));
	try {
		// realpath'd for the same reason `runCase` does it: macOS's tmpdir is itself a symlink,
		// and `Capabilities.root` is contractually canonical.
		const root = await realpath(dir);
		for (const [relPath, content] of Object.entries(files)) {
			const target = join(root, relPath);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
		}
		await gitInitAndCommit(root);
		return await body(root);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface SurfaceSpec {
	root: string;
	kind?: SurfaceKind;
	dialects?: readonly DialectId[];
	/** this surface's own override of the globally configured rule */
	override?: SurfaceRuleOverride;
}

function surfaceOf(spec: SurfaceSpec): ResolvedSurface {
	const kind = spec.kind ?? "skills";
	const rules = new Map<string, SurfaceRuleOverride>();
	if (spec.override !== undefined) {
		rules.set(noDanglingPaths.meta.id, spec.override);
	}
	return freezeSurface({
		root: spec.root,
		kind,
		dialects: spec.dialects ?? ["generic"],
		include: DEFAULT_INCLUDE[kind],
		ignore: [],
		spokes: [],
		rules: sealMap(rules),
	});
}

/**
 * A multi-surface `ResolvedConfig` with this rule enabled globally at `severity` and configured
 * with `options` — the shape `loadConfig` produces for a config that writes the rule once in the
 * top-level `rules:` block and lets every surface inherit it.
 */
function configOf(
	root: string,
	options: unknown,
	surfaces: readonly ResolvedSurface[],
	severity: Severity = "error",
): ResolvedConfig {
	const resolved: ResolvedRule = { severity };
	resolved.options = options;
	return {
		root,
		origin: "config",
		configFile: join(root, "skillslurp.json"),
		ignore: DEFAULT_IGNORE,
		surfaces,
		rules: new Map([[noDanglingPaths.meta.id, resolved]]),
		ruleOptions: new Map([[noDanglingPaths.meta.id, options]]),
		skippedCandidates: [],
	};
}

const brief = (
	d: Diagnostic,
): { ruleId: string; severity: Severity; file: string; message: string } => ({
	ruleId: d.ruleId,
	severity: d.severity,
	file: d.file,
	message: d.message,
});

describe("refs/no-dangling-paths across surfaces", () => {
	const TWO_ROOT_FILES = {
		".claude/skills/acme-widgets/SKILL.md": SKILL,
		".cursor/rules/acme-style.mdc": "# Style\n",
		"docs/guide.md":
			"Pair .claude/skills/acme-gone with .cursor/rules/acme-gone.mdc\n",
	} as const;

	test("a repo with two roots checks both in one pass", async () => {
		await withRepo(TWO_ROOT_FILES, async (root) => {
			const { diagnostics } = await runEngine(
				configOf(root, {}, [
					surfaceOf({ root: ".claude/skills" }),
					surfaceOf({
						root: ".cursor/rules",
						kind: "rules",
						dialects: ["cursor"],
					}),
				]),
				[noDanglingPaths],
			);

			// Both roots are in the pattern, so both dangling mentions are found; each is found
			// by BOTH dispatches and `dedupeDiagnostics` collapses the duplicate pair.
			expect(diagnostics.map(brief)).toEqual([
				{
					ruleId: "refs/no-dangling-paths",
					severity: "error",
					file: "docs/guide.md",
					message:
						'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
				},
				{
					ruleId: "refs/no-dangling-paths",
					severity: "error",
					file: "docs/guide.md",
					message:
						'Path ".cursor/rules/acme-gone.mdc" does not exist or is not tracked by git',
				},
			]);
		});
	});

	test("a root whose own surface has the rule switched off is still checked", async () => {
		await withRepo(
			{
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				".cursor/rules/acme-style.mdc": "# Style\n",
				"docs/guide.md":
					"Read .cursor/rules/acme-style.mdc, not .cursor/rules/acme-gone.mdc\n",
			},
			async (root) => {
				const { diagnostics } = await runEngine(
					configOf(root, {}, [
						surfaceOf({ root: ".claude/skills" }),
						// The only surface rooted at `.cursor/rules` does not run this rule...
						surfaceOf({
							root: ".cursor/rules",
							kind: "rules",
							dialects: ["cursor"],
							override: { severity: "off" },
						}),
					]),
					[noDanglingPaths],
				);

				// ...and the dangling `.cursor/rules` path is reported anyway, by the ONE
				// dispatch that runs, because roots come from every surface's documents rather
				// than from `ctx.surface`. Scope `collectSurfaceRoots` to `ctx.surface.root` —
				// the way `index/*` deliberately does with `ctx.documents()` — and this run goes
				// silent. The live `.cursor/rules/acme-style.mdc` on the same line proves the
				// cross-surface root is used for resolving, not only for matching.
				expect(diagnostics.map(brief)).toEqual([
					{
						ruleId: "refs/no-dangling-paths",
						severity: "error",
						file: "docs/guide.md",
						message:
							'Path ".cursor/rules/acme-gone.mdc" does not exist or is not tracked by git',
					},
				]);
			},
		);
	});

	test("two surfaces with different allowlists both report, and neither allowlist mutes the other", async () => {
		await withRepo(
			{
				".claude/skills/acme-widgets/SKILL.md": SKILL,
				".agents/skills/acme-gadgets/SKILL.md": SKILL,
				"docs/guide.md": "Gone: .claude/skills/acme-gone\n",
			},
			async (root) => {
				const { diagnostics } = await runEngine(
					configOf(root, {}, [
						// This surface allowlists the dangling path...
						surfaceOf({
							root: ".claude/skills",
							override: {
								options: { allowlist: [".claude/skills/acme-gone"] },
							},
						}),
						// ...and this one allowlists something that does not exist at all.
						surfaceOf({
							root: ".agents/skills",
							override: {
								options: { allowlist: [".agents/skills/acme-never"] },
							},
						}),
					]),
					[noDanglingPaths],
				);

				// The visible face of the per-surface-dispatch quirk: an allowlist belongs
				// to one surface's dispatch while the corpus it scans is the whole repository, so
				// allowlisting the path on one surface does NOT silence the hit — the other
				// surface's dispatch still reports it. The second surface's dead entry is
				// reported on its own, at `error`, against the config file.
				expect(diagnostics.map(brief)).toEqual([
					{
						ruleId: "refs/no-dangling-paths",
						severity: "error",
						file: "docs/guide.md",
						message:
							'Path ".claude/skills/acme-gone" does not exist or is not tracked by git',
					},
					{
						ruleId: "config/stale-allowlist",
						severity: "error",
						file: "skillslurp.json",
						message:
							'Rule "refs/no-dangling-paths": allowlist entry ".agents/skills/acme-never" matched nothing — remove it',
					},
				]);
			},
		);
	});
});

/* ------------------------------------------------------------------------------------------ */

test("a stale allowlist entry with zero real violations still fails the run", async () => {
	await withRepo(
		{
			".claude/skills/acme-widgets/SKILL.md": SKILL,
			"docs/guide.md": "All good: .claude/skills/acme-widgets\n",
		},
		async (root) => {
			const { diagnostics } = await runEngine(
				configOf(
					root,
					{ allowlist: [".claude/skills/acme-never"] },
					[surfaceOf({ root: ".claude/skills" })],
					// Configured `warn`: the run would exit 0 if staleness were reported at the
					// rule's own severity, which is precisely why it is not.
					"warn",
				),
				[noDanglingPaths],
			);

			// Exit code asserted FIRST, deliberately: report the staleness as an ordinary
			// `RuleReport` instead and the diagnostic comparison below fails on its `ruleId`
			// before this line ever runs, leaving "still fails the run" unproven.
			expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
			expect(diagnostics.map(brief)).toEqual([
				{
					ruleId: "config/stale-allowlist",
					severity: "error",
					file: "skillslurp.json",
					message:
						'Rule "refs/no-dangling-paths": allowlist entry ".claude/skills/acme-never" matched nothing — remove it',
				},
			]);
		},
	);
});

describe("OptionsSchema", () => {
	test("an unconfigured rule gets an empty allowlist, not an absent one", () => {
		// A tier enables this rule with no `options:` block, which the engine parses as `{}`. A
		// `.default([])` on the SCHEMA rather than the field would never fire for that input.
		expect(OptionsSchema.parse({})).toEqual({ allowlist: [] });
	});

	// `AllowlistSchema`'s own contract, pinned directly against the schema rather than through
	// this rule's `OptionsSchema`: it is a claim about zod's own default behaviour that no change
	// to this rule could falsify.
	test("allowlist defaults to an empty list and rejects an empty entry", () => {
		const parsed = AllowlistSchema.safeParse(undefined);

		// The default lives on the FIELD: a rule enabled with an `options:` block that omits
		// `allowlist` still gets one, where a schema-level default would never fire.
		expect(parsed.success && parsed.data).toEqual([]);
		// An empty entry could never match anything, so it would be permanently stale — better
		// refused at config time.
		expect(AllowlistSchema.safeParse([""]).success).toBe(false);
	});

	test("an unknown option and a malformed allowlist are config errors", () => {
		expect(
			[
				{ allowlist: "" },
				{ allowlist: [""] },
				{ allowlist: [1] },
				{ prefixes: ["acme"] },
			].map((options) => OptionsSchema.safeParse(options).success),
		).toEqual([false, false, false, false]);
	});
});

describe("createAllowlistTracker", () => {
	test("an entry is used once it suppresses something, and duplicates collapse to one", () => {
		const tracker = createAllowlistTracker(["b", "a", "b"]);

		expect(tracker.allows("b")).toBe(true);
		expect(tracker.allows("nothing")).toBe(false);
		expect(tracker.staleReports("test/rule")).toEqual([
			{
				problem: "stale-allowlist",
				message:
					'Rule "test/rule": allowlist entry "a" matched nothing — remove it',
			},
		]);
	});

	test("stale entries come out in the order they were configured", () => {
		// Deliberately not alphabetical: a sort would reorder these to a, b, z and the
		// assertion would pass for the wrong reason.
		const tracker = createAllowlistTracker(["z", "a", "b"]);

		expect(tracker.staleReports("test/rule").map((r) => r.message)).toEqual([
			'Rule "test/rule": allowlist entry "z" matched nothing — remove it',
			'Rule "test/rule": allowlist entry "a" matched nothing — remove it',
			'Rule "test/rule": allowlist entry "b" matched nothing — remove it',
		]);
	});
});
