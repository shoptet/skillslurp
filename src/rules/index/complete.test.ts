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
import { indexComplete } from "./complete.js";
import type { IndexOptions } from "./shared.js";

/**
 * `index/complete`'s own edge cases for the `index/complete` /
 * `index/no-missing-targets` pair, through `RuleTester`, which takes `project`/`scan` rules
 * for exactly this. Every fixture below puts the surface at `skills/` and the index file at the
 * repo root (`SKILLS.md`), so a link that climbs OUT of `skills/` (e.g. to a repo-root `LICENSE`)
 * is "outside the surface root but inside the repository" without needing a literal `../..` — the
 * same semantic a `../..` fixture would demonstrate, reached the simpler way.
 *
 * `index/no-missing-targets` gets the mirror-image cases in `no-missing-targets.test.ts`; the
 * handful that are meaningless to one rule but not the other (a ghost link, an unlinked entry) live
 * only where they apply. The cases both rules genuinely share (outside-root ignored,
 * reference+definition, duplicate links, zero-links) are each written out in both files, against
 * each rule's own question, rather than shared via a helper — the fixtures are small enough that a
 * shared helper would cost more to read than it would save.
 *
 * Two more sections follow the `runRuleTests` call below, for properties `RuleTester` cannot
 * observe at all (a review-fixes pass): a symlinked surface root, and this rule's own
 * report order. Both call `indexComplete.check(ctx)` directly against a hand-built `ctx`, the
 * same "exported/callable for a test real fixtures cannot reach" idiom `links/resolve.test.ts`
 * already uses for `linksResolve.check`.
 */

runRuleTests(indexComplete, {
	valid: [
		{
			name: "every discovered entry is linked at least once",
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
			// A link target outside the surface's root is ignored outright — not every link in
			// an index doc is an index entry. `does-not-exist-outside.md` sits at the
			// repo root, outside the `skills/` surface root, and is never written to disk at
			// all — proving the link is skipped before ever being checked for existence, not
			// merely tolerated because it happens to resolve.
			name: "a link outside the surface root is ignored, entries are still complete via their own links",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n- [gadgets](skills/gadgets/SKILL.md)\n- [elsewhere](does-not-exist-outside.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
		{
			name: "a reference-style link resolves through its separate definition",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n[the widgets skill][wref]\n\n[wref]: skills/widgets/SKILL.md\n\n- [gadgets](skills/gadgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
		{
			name: "two links to the same entry are redundant, not a violation",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [gadgets, take one](skills/gadgets/SKILL.md)\n- [gadgets, take two](skills/gadgets/SKILL.md)\n- [widgets](skills/widgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
		{
			// The index link is authored precomposed (NFC, what a human types
			// and what git's own listing shows on macOS), the entry's directory is decomposed on
			// disk (NFD, what `readdir` actually returns there) — same fixture as
			// `no-missing-targets.test.ts`'s mirror case. Without `entryByAbsPath`'s `pathKey`
			// fix (shared.ts), the two spellings never meet and this entry reports as unlinked.
			name: "an NFD-decomposed entry directory linked with its NFC-precomposed spelling is complete",
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
			name: "an entry with no link anywhere in the index is reported by name",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
			errors: [
				{
					message:
						'Entry document "skills/gadgets/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/gadgets/SKILL.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// A link resolving to a real, non-entry file inside the surface root does not satisfy
			// `complete` for anything either. The index links `reference.md`
			// (real, on disk, not a discovered entry — its name is not `SKILL.md`) instead of
			// `widgets/SKILL.md` itself, so `widgets` is still unlinked.
			name: "a link to a real, non-entry file does not satisfy completeness for any entry",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets reference](skills/widgets/reference.md)\n- [gadgets](skills/gadgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/widgets/reference.md": "# Widgets Reference\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
			errors: [
				{
					message:
						'Entry document "skills/widgets/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/widgets/SKILL.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// Path-handling requirement: a `./` prefix on the configured `file` must
			// not silently produce a path that never matches anything. `resolve(ctx.root, "./
			// SKILLS.md")` would tolerate the raw string just fine on its own — `node:path`
			// collapses a `./` prefix regardless of this rule's own normalization — so a VALID
			// case proves nothing about whether `normalizeConfiguredPath` actually ran. What
			// does is this: `gadgets` is deliberately left unlinked so the message has to name
			// the index file, and the message names it as `"SKILLS.md"`, not `"./SKILLS.md"` —
			// only reachable if the option was normalized before being echoed back.
			name: "a './' prefix on the configured file is normalized before being echoed into a message",
			options: { file: "./SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
			errors: [
				{
					message:
						'Entry document "skills/gadgets/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/gadgets/SKILL.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// An index file that exists
			// but has zero links reports every entry — the same class of violation as "no link
			// anywhere", just for all of them at once. Directory names are picked to have
			// nothing to do with alphabetical order (`zeta` first, `alpha` last) so the fixture
			// itself is not accidentally already sorted — but this is NOT a sort-determinism
			// proof (corrected): `runEngine` re-sorts every diagnostic by (file, line,
			// col, ...) before any `RuleTester` case ever sees it, so THIS assertion would read
			// identically whether `index/complete`'s own `.sort()` ran or not (measured:
			// reversing or deleting that comparator leaves this case green). The genuine proof
			// that the rule's own sort matters is the "direct check() call" section at the
			// bottom of this file, which bypasses `runEngine` entirely.
			name: "an index file with zero links reports every entry, sorted by path",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"skills/zeta/SKILL.md": "# Zeta\n",
				"skills/mid/SKILL.md": "# Mid\n",
				"skills/alpha/SKILL.md": "# Alpha\n",
				"SKILLS.md": "# Skills Index\n\nNothing links from here yet.\n",
			},
			errors: [
				{
					message:
						'Entry document "skills/alpha/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/alpha/SKILL.md",
					line: 1,
					col: 1,
				},
				{
					message:
						'Entry document "skills/mid/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/mid/SKILL.md",
					line: 1,
					col: 1,
				},
				{
					message:
						'Entry document "skills/zeta/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/zeta/SKILL.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// A configured `file` missing from disk is reported once, naming the configured
			// path — not silence, not a crash. Also proves the backslash half of the
			// path-normalization requirement: the option is written Windows-style and the
			// diagnostic still names the posix form.
			//
			// The diagnostic's `file` is never the configured path itself, and the three
			// escaping-`file`-option cases just below are why: `RuleReport.file` on a
			// `project`/`scan` rule must stay inside the repo (engine.ts's
			// `toProjectDiagnostic`), so echoing an option that escapes it would crash the whole
			// run instead of reporting a config mistake. The
			// configured spelling belongs in `message`, and that is where it stays.
			name: "a configured file missing from disk is reported once, naming the (normalized) path",
			options: { file: "docs\\SKILLS.md" },
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
					message: 'Index file "docs/SKILLS.md" does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			// Blocker: a `file` option that NORMALIZES to a path outside the repository —
			// here, a literal `../` escape — used to be handed straight into `RuleReport.file`,
			// which `toProjectDiagnostic` (engine.ts) rejects as a RULE bug (an escaping report
			// file), crashing the whole run at exit 2 instead of reporting a config mistake.
			// `file` names the run's own config file; the offending spelling stays in `message`
			// either way.
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
			// The absolute-path shape of the same escape (`/etc/passwd`, `/SKILLS.md` and
			// friends all crashed identically before this fix).
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
			// The degenerate case `isRepoRelative` special-cases — `".."` alone escapes to
			// the repo's own parent directory without either the absolute or the `../` prefix
			// shape, so it needs its own case (mirrors `links/resolve.test.ts`'s identical
			// boundary case for `resolveTarget`).
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
			// `posix.normalize` preserves a trailing slash that `resolve` discards, so the
			// file itself still read fine before this fix — only the ECHOED spelling was wrong.
			// Reuses the "'./' prefix" case's exact fixture and expectation, just with a
			// trailing slash instead of a leading `./`, so this is discriminating on that one
			// axis alone: if the strip regresses, the message reads `index file "SKILLS.md/"`.
			name: "a trailing slash on the configured file is stripped before being echoed into a message",
			options: { file: "SKILLS.md/" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md": "# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
			errors: [
				{
					message:
						'Entry document "skills/gadgets/SKILL.md" is not linked from index file "SKILLS.md"',
					file: "skills/gadgets/SKILL.md",
					line: 1,
					col: 1,
				},
			],
		},
	],
});

// --- classifyLinks's non-path guard, exercised by an index file that actually has one of
// every non-path link shape it claims to handle ---

runRuleTests(indexComplete, {
	valid: [
		{
			// Every fixture link elsewhere in this file is a relative filesystem path, so
			// `classifyLinks`'s `if (resolution.kind !== "path") continue;` guard (shared.ts)
			// never ran — measured: deleting it left this whole file green. An ordinary index
			// file almost always has at least one external link, so this is not a contrived
			// case. All six non-path shapes `resolveTarget` documents handling: a scheme URL, an
			// anchor, `mailto:`, a protocol-relative CDN link, an empty target and a query-only
			// target — none of them name a file inside (or outside) the surface root, so none of
			// them affect either entry's linked status.
			name: "external, anchor, mailto, protocol-relative, empty and query-only links are ignored outright",
			options: { file: "SKILLS.md" },
			surface: { root: "skills" },
			files: {
				"SKILLS.md":
					"# Skills Index\n\n- [widgets](skills/widgets/SKILL.md)\n- [gadgets](skills/gadgets/SKILL.md)\n- [ext](https://example.com/x)\n- [anchor](#section)\n- [mail](mailto:person@example.com)\n- [cdn](//cdn.example.com/x)\n- [empty]()\n- [query](?q=1)\n",
				"skills/widgets/SKILL.md": "# Widgets\n",
				"skills/gadgets/SKILL.md": "# Gadgets\n",
			},
		},
	],
	invalid: [],
});

// --- a symlinked surface root must not disagree with discovery about what "inside the
// surface root" means ---

describe("index/complete against a symlinked surface root", () => {
	test("an entry reached through the surface's real target directory is not falsely reported as unlinked", async () => {
		// `RuleTester` cannot build this fixture at all — its `files` map only ever writes plain
		// files (rule-tester.ts's `writeFiles`), never a symlink — so this calls
		// `indexComplete.check(ctx)` directly against a hand-built temp directory and `ctx`,
		// mirroring `links/resolve.test.ts`'s "(C)" idiom.
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-index-symlink-")),
		);
		try {
			// The REAL directory. `.agents/skills` below is the ALIAS a user would actually
			// configure `root:` as — discover.ts calls this shape ("a symlinked hub") "the
			// common shape".
			const realSkillsDir = join(dir, ".claude", "skills");
			await mkdir(join(realSkillsDir, "widgets"), { recursive: true });
			const widgetsAbsPath = join(realSkillsDir, "widgets", "SKILL.md");
			await writeFile(widgetsAbsPath, "# Widgets\n", "utf8");
			await mkdir(join(dir, ".agents"), { recursive: true });
			await symlink(
				join("..", ".claude", "skills"),
				join(dir, ".agents", "skills"),
			);
			// Written against the REAL path, exactly as `discoverFiles` would report this
			// entry's own `.path` — the ordinary way an author writes this link once they know
			// where the file actually lives.
			await writeFile(
				join(dir, "SKILLS.md"),
				"# Skills Index\n\n- [widgets](.claude/skills/widgets/SKILL.md)\n",
				"utf8",
			);
			// `loadIndexAnalysis` resolves link targets against git's index, so a
			// hand-built fixture needs the same ephemeral checkout `RuleTester` materializes for
			// a `project` case — same function, so there is only one way this is ever done.
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

			// Built by hand rather than through `discoverFiles`, because the property under test
			// is `loadIndexAnalysis`'s OWN containment logic (shared.ts), not discovery's — but
			// `.path`/`.absPath` are exactly what discovery itself would produce for this layout
			// (discover.ts derives both from `rootReal`, the surface root's REAL target, never
			// the alias).
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

			// Before the fix: `surfaceAbsRoot` named the SYMLINK (`.agents/skills`), the link
			// resolved under the REAL directory (`.claude/skills`), `relative()` between them
			// climbed out, and the link was treated as "outside the surface root" — so `widgets`
			// was falsely reported unlinked despite the index linking it correctly.
			expect(await indexComplete.check(ctx)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// --- this rule's own report order is provably load-bearing, unlike
// `index/no-missing-targets`'s (see the decision recorded at that rule's own `check`) ---

describe("index/complete's own report order", () => {
	test("sorts unlinked entries by path even when ctx.documents() hands them back out of order", async () => {
		// `runEngine` re-sorts every diagnostic by (file, line, col, ...) before a `RuleTester`
		// case ever sees it (engine.ts's `compareDiagnostics`), so no case run through
		// `runRuleTests` above can tell this rule's own `.sort()` from its absence — measured,
		// for the "zero links" case above, both by reversing the comparator and by deleting it
		// outright. What DOES discriminate: calling `check(ctx)` directly with a `ctx.documents()`
		// this test fully controls, handed back in an order that is not path-sorted — something
		// discovery happens not to do today (discover.ts sorts), but nothing in `ctx.documents()`'s
		// own contract requires forever.
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-index-sort-")),
		);
		try {
			for (const name of ["zeta", "mid", "alpha"]) {
				await mkdir(join(dir, "skills", name), { recursive: true });
				await writeFile(
					join(dir, "skills", name, "SKILL.md"),
					`# ${name}\n`,
					"utf8",
				);
			}
			await writeFile(
				join(dir, "SKILLS.md"),
				"# Skills Index\n\nNothing links from here yet.\n",
				"utf8",
			);
			// See the symlinked-surface-root case above: the index file is read and its links
			// resolved through git's index, so this fixture is a checkout too.
			await gitInitAndCommit(dir);

			const surface = freezeSurface({
				root: "skills",
				kind: "skills",
				dialects: ["generic"],
				include: DEFAULT_INCLUDE.skills,
				ignore: [],
				spokes: [],
				rules: sealMap(new Map()),
			});

			// Deliberately zeta, mid, alpha — the reverse of path order — so a rule that merely
			// forwarded `ctx.documents()`'s own order would report them in that same, wrong order.
			const docs = ["zeta", "mid", "alpha"].map((name) =>
				parseSource(
					`skills/${name}/SKILL.md`,
					join(dir, "skills", name, "SKILL.md"),
					`# ${name}\n`,
					surface,
				),
			);

			const ctx: RuleContext<IndexOptions> = {
				...createCapabilities(dir, async () => docs),
				options: { file: "SKILLS.md" },
				surface,
			};

			expect((await indexComplete.check(ctx)).map((r) => r.file)).toEqual([
				"skills/alpha/SKILL.md",
				"skills/mid/SKILL.md",
				"skills/zeta/SKILL.md",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
