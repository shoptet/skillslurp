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
import { join } from "node:path";
import { freezeSurface, sealMap } from "../../config.js";
import { createCapabilities, type RuleContext } from "../../context.js";
import { DEFAULT_INCLUDE } from "../../dialects.js";
import { parseSource } from "../../document.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { indexNoMissingTargets } from "./no-missing-targets.js";
import type { IndexOptions } from "./shared.js";

/**
 * `index/no-missing-targets`'s own edge cases — see `complete.test.ts`'s header for why the cases
 * shared with `index/complete` are written out here too rather than factored into a helper, and for
 * the repo-root-index / `skills/`-surface layout every fixture below uses.
 *
 * Three more sections follow the `runRuleTests` call below, for properties `RuleTester` cannot
 * observe at all (a review-fixes pass): a symlinked surface root and a symlink escaping
 * the repo through the configured `file` itself, both calling
 * `indexNoMissingTargets.check(ctx)` directly against a hand-built `ctx` —
 * `links/resolve.test.ts`'s "(C)" idiom for `linksResolve.check`, reused here.
 */

runRuleTests(indexNoMissingTargets, {
	valid: [
		{
			name: "every link resolves to something real",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n- [gadgets](skills/gadgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
		{
			// A link to a real but non-entry file is not a ghost, and it does not count toward
			// `complete` either — the other half of this exact case is `complete.test.ts`'s
			// "does not satisfy completeness" invalid case.
			name: "a link to a real, non-entry file is not a ghost",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets reference](skills/widgets/reference.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/reference.md": "# Widgets Reference\n",
			},
		},
		{
			// The target does not exist ANYWHERE — proving "outside the surface root" is checked
			// and short-circuits before existence is ever asked about, not merely that an
			// out-of-root link happens to resolve when it is written against a real file.
			name: "a link outside the surface root is ignored even when its target does not exist at all",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [elsewhere](does-not-exist-outside.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
		},
		{
			name: "a reference-style link resolves through its separate definition, no ghost",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n[the widgets skill][wref]\n\n[wref]: skills/widgets/SKILL.md\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
		},
		{
			name: "two links to the same real target are redundant, not a violation",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [gadgets, take one](skills/gadgets/SKILL.md)\n- [gadgets, take two](skills/gadgets/SKILL.md)\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
		{
			// Orchestrator's addition: the mirror image of `complete.test.ts`'s "zero links"
			// case — nothing to check means nothing to report, not every entry treated as a
			// ghost by some inverted mistake.
			name: "an index file with zero links reports nothing",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\nNothing links from here yet.\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
		},
		{
			// Same fixture as `complete.test.ts`'s mirror case — the link
			// resolves to a real, discovered entry (not a ghost) once `entryByAbsPath`'s
			// `pathKey` fix lets the NFC-authored link text and the NFD-on-disk directory meet.
			name: "an NFD-decomposed entry directory linked with its NFC-precomposed spelling is not a ghost",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": `# Skills Index\n\n- [cafe](skills/${"caf\u00e9"}/SKILL.md)\n`,
				[`skills/${"cafe\u0301"}/SKILL.md`]: "# Cafe\n",
			},
		},
	],
	invalid: [
		{
			name: "a link resolving to nothing on disk is a ghost",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\n[missing](skills/widgets/missing.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					message:
						'Index link target "skills/widgets/missing.md" does not exist or is not tracked by git',
					file: "SKILLS.md",
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 37,
				},
			],
		},
		{
			// Two ghosts on two lines: the expected order below is (line 3, "ghost-two") before
			// (line 4, "ghost-one") — position order, not alphabetical-by-name order, so a
			// coincidentally name-sorted fixture could not pass this by accident.
			//
			// Corrected: this is NOT proof that a `.sort()` in this rule is load-bearing —
			// there no longer is one (see this rule's own `check`). It regression-tests
			// `classifyLinks`'s (shared.ts) walk order instead, which is what actually determines
			// `result.ghosts`'s order: `collectLinkTargets` (links.ts) visits nodes in PRE-ORDER,
			// which for `link`/`image`/`definition` is exactly source order, and a filter over
			// that walk cannot reorder it. Two ghosts on two DIFFERENT lines are what makes this
			// discriminating at all — one ghost, or two ghosts on the same line in written
			// order, would pass whether or not the walk preserved order.
			name: "multiple ghosts are reported in position order",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n[ghost-two](skills/widgets/missing-two.md)\n[ghost-one](skills/widgets/missing-one.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					message:
						'Index link target "skills/widgets/missing-two.md" does not exist or is not tracked by git',
					file: "SKILLS.md",
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 43,
				},
				{
					message:
						'Index link target "skills/widgets/missing-one.md" does not exist or is not tracked by git',
					file: "SKILLS.md",
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 43,
				},
			],
		},
		{
			// Same diagnostic `complete.test.ts` pins, asserted again here
			// because both rules must produce it consistently — this is what proves
			// they actually do, not just that each was told to.
			//
			// `file` is the run's config file, not the missing `indexPath` itself — see
			// `missingFileReport` (configured-document.ts).
			name: "a configured file missing from disk is reported once, naming the path",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					// `config/missing-file`, not this rule's own id. `file` is the run's config file,
					// not the missing `indexPath` itself — see `missingFileReport`
					// (configured-document.ts). No `line`/`col`:
					// the engine defaults a `ConfigReport`'s position to `ctx.surface.loc`, and
					// `RuleTester` builds its surface in code with no yaml behind it, so there is
					// none to default to. The positioned path is proven where a surface DOES carry a
					// `loc`: `engine.test.ts`'s surface-loc case and `run.test.ts`'s end-to-end one.
					ruleId: "config/missing-file",
					message: 'Index file "SKILLS.md" does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			// Blocker: see `complete.test.ts`'s identical three cases for the full
			// reasoning. Asserted again here because both rules share the exact same
			// `missingFileReport` call (configured-document.ts) and must therefore both stop crashing.
			name: "a file option escaping the repository via '../' is reported, not a crash",
			options: { file: "../outside.md" },
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					// Same `config/missing-file` shape as the case above.
					ruleId: "config/missing-file",
					message: 'Index file "../outside.md" does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			name: "a file option that is filesystem-absolute is reported, not a crash",
			options: { file: "/etc/passwd" },
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					// Same `config/missing-file` shape as the case above.
					ruleId: "config/missing-file",
					message: 'Index file "/etc/passwd" does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			name: "a file option of exactly '..' is reported, not a crash",
			options: { file: ".." },
			surface: { root: "skills" },
			files: {
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					// Same `config/missing-file` shape as the case above.
					ruleId: "config/missing-file",
					message: 'Index file ".." does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			// Reuses the very first invalid case's fixture verbatim, just with a trailing
			// slash on the configured `file` — `result.indexPath` (the ghost diagnostic's OWN
			// `file`, unlike `complete`'s message-embedded spelling) is where the leak would show.
			name: "a trailing slash on the configured file is stripped from the reported file",
			options: { file: "SKILLS.md/" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\n[missing](skills/widgets/missing.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					message:
						'Index link target "skills/widgets/missing.md" does not exist or is not tracked by git',
					file: "SKILLS.md",
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 37,
				},
			],
		},
		{
			// Minor: the ONLY reference-style case in this rule's own suite used to be a
			// `valid` one whose target resolved — with `collectLinkTargets` mutated to skip
			// EVERY `definition` node (not just footnote ones), `no-missing-targets` would see zero
			// targets and report zero ghosts, so that case stayed green for the wrong reason
			// (`index/complete`'s own reference-style case caught the same mutation, this rule's
			// did not — measured). This case's ghost is reachable ONLY through the definition,
			// so the same mutation now has to make it disappear for the test to pass, which it
			// does not.
			name: "a ghost reachable only through a reference-style definition is reported",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n[the widgets skill][wref]\n\n[wref]: skills/widgets/missing.md\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
			errors: [
				{
					message:
						'Index link target "skills/widgets/missing.md" does not exist or is not tracked by git',
					file: "SKILLS.md",
					line: 5,
					col: 1,
					endLine: 5,
					endCol: 34,
				},
			],
		},
	],
});

// --- classifyLinks's non-path guard, exercised by an index file that actually has one of
// every non-path link shape it claims to handle (see `complete.test.ts`'s identical case for the
// full reasoning) ---

runRuleTests(indexNoMissingTargets, {
	valid: [
		{
			name: "external, anchor, mailto, protocol-relative, empty and query-only links are ignored, never ghosts",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n- [ext](https://example.com/x)\n- [anchor](#section)\n- [mail](mailto:person@example.com)\n- [cdn](//cdn.example.com/x)\n- [empty]()\n- [query](?q=1)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
			},
		},
	],
	invalid: [],
});

// --- a symlinked surface root must not let a genuine ghost past the bounds check (the
// mirror image of `complete.test.ts`'s "against a symlinked surface root" case, same fixture
// shape, opposite direction) ---

describe("index/no-missing-targets against a symlinked surface root", () => {
	test("a ghost inside the surface's real target directory is not silently dropped", async () => {
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-index-symlink-")),
		);
		try {
			const realSkillsDir = join(dir, ".claude", "skills");
			await mkdir(join(realSkillsDir, "widgets"), { recursive: true });
			const widgetsAbsPath = join(realSkillsDir, "widgets", "SKILL.md");
			await writeFile(widgetsAbsPath, "# Widgets\n", "utf8");
			await mkdir(join(dir, ".agents"), { recursive: true });
			await symlink(
				join("..", ".claude", "skills"),
				join(dir, ".agents", "skills"),
			);
			// `.claude/skills/nope/SKILL.md` genuinely does not exist anywhere.
			await writeFile(
				join(dir, "SKILLS.md"),
				"# Skills Index\n\n[ghost](.claude/skills/nope/SKILL.md)\n",
				"utf8",
			);
			// `loadIndexAnalysis` resolves link targets against git's index, so a
			// hand-built fixture needs the same ephemeral checkout `RuleTester` materializes for
			// a `project` case — same function, so there is only one way this is ever done. It
			// also makes the assertion below stronger than it was: `.claude/skills/nope/SKILL.md`
			// is now a ghost because git tracks nothing there, not merely because `stat` failed.
			await gitInitAndCommit(dir);

			const surface = freezeSurface({
				root: ".agents/skills",
				kind: "skills",
				dialects: ["generic"],
				include: DEFAULT_INCLUDE.skills,
				ignore: [],
				spokes: [],
				rules: sealMap(new Map()),
			});

			const widgetsDoc = parseSource(
				".claude/skills/widgets/SKILL.md",
				widgetsAbsPath,
				"# Widgets\n",
				surface,
			);

			const ctx: RuleContext<IndexOptions> = {
				...createCapabilities(dir, async () => [widgetsDoc]),
				options: { file: "SKILLS.md" },
				surface,
			};

			// Before the fix: `surfaceAbsRoot` named the symlink, the ghost link resolved under
			// the real directory, `relative()` between them climbed out, and the link was
			// treated as "outside the surface root" — silently dropping a genuine ghost.
			expect(
				(await indexNoMissingTargets.check(ctx)).map((r) => r.message),
			).toEqual([
				'Index link target ".claude/skills/nope/SKILL.md" does not exist or is not tracked by git',
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// --- the configured index `file` itself must not be read through a symlink that escapes
// the repository ---

describe("index/no-missing-targets refuses to read an index file that escapes the repo through a symlink", () => {
	test("a tracked symlink to a file outside the repo is reported as a missing index file, not read", async () => {
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-index-repo-")),
		);
		const outsideDir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-index-outside-")),
		);
		try {
			await mkdir(join(dir, "skills", "widgets"), { recursive: true });
			await writeFile(
				join(dir, "skills", "widgets", "SKILL.md"),
				"# Widgets\n",
				"utf8",
			);
			// The outside file's own content would, if ever read, name a ghost the rule has
			// never heard of — proof, if this test regresses, that the content actually leaked.
			await writeFile(
				join(outsideDir, "secret.md"),
				"# Secret\n\n[gone](skills/widgets/SECRET-PROJECT-NAME.md)\n",
				"utf8",
			);
			await symlink(join(outsideDir, "secret.md"), join(dir, "notes.md"));

			const surface = freezeSurface({
				root: "skills",
				kind: "skills",
				dialects: ["generic"],
				include: DEFAULT_INCLUDE.skills,
				ignore: [],
				spokes: [],
				rules: sealMap(new Map()),
			});

			const widgetsDoc = parseSource(
				"skills/widgets/SKILL.md",
				join(dir, "skills", "widgets", "SKILL.md"),
				"# Widgets\n",
				surface,
			);

			const ctx: RuleContext<IndexOptions> = {
				...createCapabilities(dir, async () => [widgetsDoc]),
				options: { file: "notes.md" },
				surface,
			};

			// The same "missing index file" report an ENOENT gets — no errno, no
			// machine-absolute path (the same posture `loadConfiguredDocument` keeps for an
			// escaping symlink) — never the
			// outside file's own ghost. A `ConfigReport`: `problem` and `message`
			// only, with `file`/`loc` left for the engine to default (the config file, and the
			// surface's own yaml position). `toEqual` is exact, so the ABSENCE of `file`/`loc`
			// here is itself asserted — a rule that started echoing the configured path back into
			// `file` would fail this again, which is the crash this shape exists to prevent.
			expect(await indexNoMissingTargets.check(ctx)).toEqual([
				{
					problem: "missing-file",
					message: 'Index file "notes.md" does not exist',
				},
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(outsideDir, { recursive: true, force: true });
		}
	});
});
