import { expect, test } from "bun:test";
import {
	BUILTIN_DIALECT_IDS,
	BUILTIN_DIALECTS,
	SURFACE_KINDS,
} from "../../dialects.js";
import { runRuleTests } from "../../testing/rule-tester.js";
import { nameMatchesDir } from "./name-matches-dir.js";

/**
 * A skill body, so every fixture below is a plausible file rather than bare frontmatter. The
 * rule never reads it.
 */
const BODY = "\nBody.\n";

/**
 * The same word in the two Unicode spellings a normalizing comparison would fold together:
 * `caf` + U+00E9 (precomposed) versus `cafe` + U+0301 (decomposed). Escapes rather than literal
 * characters, so neither this file's own encoding nor an editor normalizing it on save can
 * quietly turn one of the two into the other and leave the case asserting nothing.
 */
const PRECOMPOSED_CAFE = "caf\u00e9";
const DECOMPOSED_CAFE = "cafe\u0301";

/** `name: <value>` starts the value at column 7; these two derive the expected span from that. */
const VALUE_COL = 7;
const nameValueEndCol = (value: string): number =>
	VALUE_COL + [...value].length;

// --- the coupling the dialect documents is what decides whether this rule checks at all ---

runRuleTests(nameMatchesDir, {
	valid: [
		{
			name: 'generic ("must"): name equal to the directory basename is clean',
			files: {
				"my-skill/SKILL.md": `---\nname: my-skill\ndescription: Matches its directory.\n---${BODY}`,
			},
		},
		{
			name: 'claude-code ("decoupled"): a mismatch is the documented design, so nothing is reported',
			surface: { dialects: ["claude-code"] },
			files: {
				"my-skill/SKILL.md": `---\nname: A Friendly Display Label\ndescription: On claude-code, name is only the listing label.\n---${BODY}`,
			},
		},
	],
	invalid: [
		{
			name: 'generic ("must"): a mismatch reports at the name value, naming both strings',
			files: {
				"my-skill/SKILL.md": `---\nname: other-name\ndescription: Does not match its directory.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "my-skill" (found "other-name")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("other-name"),
				},
			],
		},
		{
			// The vendor documents this one as what the name "typically" is, not as a
			// requirement — the rule still checks it and leaves the softening to a per-surface
			// severity override, which is the decision recorded in the rule's own JSDoc.
			name: 'copilot ("should"): a mismatch is checked exactly like "must"',
			surface: { dialects: ["copilot"] },
			files: {
				"my-skill/SKILL.md": `---\nname: other-name\ndescription: Does not match its directory.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "my-skill" (found "other-name")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("other-name"),
				},
			],
		},
		{
			// The escape hatch claude-code's own contract points at: pairing it with `generic`
			// lifts the merged coupling to `must` (dialects.ts's strongest-coupling-wins
			// polarity), so the same file that is clean on claude-code alone now reports.
			name: "claude-code + generic: the merge lifts the coupling back to must, and the mismatch reports",
			surface: { dialects: ["claude-code", "generic"] },
			files: {
				"my-skill/SKILL.md": `---\nname: other-name\ndescription: Clean on claude-code alone, not once generic is listed too.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "my-skill" (found "other-name")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("other-name"),
				},
			],
		},
	],
});

// --- a name this rule has nothing to say about: `skill/frontmatter-schema` owns all three ---

runRuleTests(nameMatchesDir, {
	valid: [
		{
			name: "no name key at all: the schema rule owns the missing required key",
			files: {
				"my-skill/SKILL.md": `---\ndescription: No name key to compare.\n---${BODY}`,
			},
		},
		{
			name: 'an empty name ("") is skipped rather than compared against the directory',
			files: {
				"my-skill/SKILL.md": `---\nname: ""\ndescription: Present but empty.\n---${BODY}`,
			},
		},
		{
			name: "a null name (key with nothing after the colon) is skipped",
			files: {
				"my-skill/SKILL.md": `---\nname:\ndescription: Present but null.\n---${BODY}`,
			},
		},
		{
			name: "a non-string name (a list) is skipped — there is no string to compare",
			files: {
				"my-skill/SKILL.md": `---\nname: [my-skill]\ndescription: Present but a list.\n---${BODY}`,
			},
		},
		{
			name: "no frontmatter block at all is skipped",
			files: { "my-skill/SKILL.md": "# Just a body\n\nNo frontmatter here.\n" },
		},
	],
	invalid: [],
});

// --- frontmatter that is not a mapping: the schema rule owns it, all three shapes ---

// `generic` ("must") with a name-less document, so the coupling gate is passed and only the
// frontmatter shape is left to decide the outcome. These do NOT discriminate against the `isMap`
// guard in `check`: deleting it leaves them green, because `readStringField` reads a non-mapping
// as "no `name` key" and the very next branch returns anyway. They pin the user-visible
// behaviour — one diagnostic about the frontmatter block, never a second about the directory —
// so a future rewrite that starts reading a non-mapping some other way has to break a test
// rather than a repo.
runRuleTests(nameMatchesDir, {
	valid: [
		{
			name: 'generic ("must"): a bare scalar frontmatter block is left to the schema rule',
			files: { "my-skill/SKILL.md": `---\nhello\n---${BODY}` },
		},
		{
			name: 'generic ("must"): a list frontmatter block is left to the schema rule',
			files: { "my-skill/SKILL.md": `---\n- one\n- two\n---${BODY}` },
		},
		{
			name: 'generic ("must"): an empty frontmatter block is left to the schema rule',
			files: { "my-skill/SKILL.md": `---\n---${BODY}` },
		},
	],
	invalid: [],
});

// --- which file, and which directory, the comparison is about ---

runRuleTests(nameMatchesDir, {
	valid: [
		{
			name: "a nested skill directory compares against the immediate parent, not the surface root",
			files: {
				"team/tools/my-skill/SKILL.md": `---\nname: my-skill\ndescription: Nested two levels under the surface root.\n---${BODY}`,
			},
		},
		{
			// Only the entry point carries the contract; a supporting file in the same directory
			// does not, even when a surface's `include` widens far enough to discover it.
			name: "a non-SKILL.md document is never checked, even with a name that matches nothing",
			surface: { include: ["**/*.md"] },
			files: {
				"my-skill/reference.md": `---\nname: not-the-directory\ndescription: A supporting file, not the skill's entry point.\n---${BODY}`,
			},
		},
	],
	invalid: [
		{
			name: "a nested skill directory reports the immediate parent, not an ancestor that would have matched",
			files: {
				"team/tools/my-skill/SKILL.md": `---\nname: tools\ndescription: Names an ancestor directory rather than its own.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "my-skill" (found "tools")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("tools"),
				},
			],
		},
		{
			// The degenerate layout, pinned deliberately: with `SKILL.md` at the surface root
			// there is no parent directory inside the repo, and `posix.dirname` gives `"."`. What
			// makes this worth a test is the alternative — deriving the directory from
			// `doc.absPath` would put the checkout directory's own name in this message (for a
			// rule test, the random `mkdtemp` basename), so the expected value would depend on
			// where the repo happens to live on disk. Reported rather than skipped because no
			// dialect that couples name to directory documents this layout at all: they all
			// specify `<name>/SKILL.md`.
			name: 'SKILL.md directly at the surface root compares against ".", from doc.path and never the absolute path',
			files: {
				"SKILL.md": `---\nname: root-skill\ndescription: No parent directory inside the repo.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "." (found "root-skill")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("root-skill"),
				},
			],
		},
		{
			// The other half of the case above, and the reason its `"."` is not a special case in
			// the rule: with a real surface root the immediate parent is a real directory. Added
			// after a review pointed out that pinning only the `"."` spelling leaves a
			// reader with the wrong model — the rule always compares the immediate parent, and
			// `"."` is simply what that is when the surface root is the repo root.
			name: "a SKILL.md at a non-root surface root compares against that root's own last segment",
			surface: { root: ".claude/skills" },
			files: {
				".claude/skills/SKILL.md": `---\nname: root-skill\ndescription: At the surface root, which is itself a real directory.\n---${BODY}`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must match the directory name "skills" (found "root-skill")',
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					endCol: nameValueEndCol("root-skill"),
				},
			],
		},
		{
			// Plain inequality, no normalization pass: the directory basename here is the
			// decomposed form (`e` + U+0301) and the name is the precomposed one (U+00E9), the
			// two spellings a normalizing comparison would fold together. Written as explicit
			// escapes on both sides so neither this file's own encoding nor an editor's
			// normalization can quietly change what is being compared. Decomposed on disk on
			// purpose: it is the form macOS's own filesystems store either way, so the fixture
			// round-trips identically on macOS and on Linux CI.
			name: "a Unicode directory basename is compared byte-for-byte, with no Unicode normalization",
			files: {
				[`${DECOMPOSED_CAFE}/SKILL.md`]: `---\nname: ${PRECOMPOSED_CAFE}\ndescription: Precomposed name, decomposed directory.\n---${BODY}`,
			},
			errors: [
				{
					message: `Frontmatter key "name" must match the directory name "${DECOMPOSED_CAFE}" (found "${PRECOMPOSED_CAFE}")`,
					// `Diagnostic.file` is `pathKey`-normalized to NFC, so it is the
					// precomposed spelling even though `files` above discovers the decomposed
					// one — pinning both this test's case and the NFC policy.
					file: `${PRECOMPOSED_CAFE}/SKILL.md`,
					line: 2,
					col: VALUE_COL,
					endLine: 2,
					// Code points, so the precomposed U+00E9 counts as one — the same
					// counting `frontmatter-schema`'s length check uses.
					endCol: nameValueEndCol(PRECOMPOSED_CAFE),
				},
			],
		},
	],
});

// --- a kind whose contracts are all decoupled never invokes the comparison ---

runRuleTests(nameMatchesDir, {
	valid: [
		{
			// Two independent reasons this reports nothing — the file is not a `SKILL.md`, and
			// `cursor`'s rules contract is `decoupled` (a `.mdc` file has no `name` key at all).
			// Pinned because a surface of a non-skills kind is exactly where a rule reaching for
			// a "parent directory" would produce noise for every file at once.
			name: "rules kind + cursor: a .mdc file is never compared against its directory",
			surface: { kind: "rules", dialects: ["cursor"] },
			files: {
				"style.mdc": `---\ndescription: Style rules for the docs tree.\nglobs: docs/**/*.md\n---${BODY}`,
			},
		},
		{
			// The filename gate removed from the equation: a widened `include` on a `rules`
			// surface discovers a file literally named `SKILL.md`, whose `name` matches nothing,
			// and the coupling gate alone still keeps this rule silent.
			name: "rules kind + cursor: even a mismatched SKILL.md is not compared, because the contract is decoupled",
			surface: {
				kind: "rules",
				dialects: ["cursor"],
				include: ["**/*.md", "**/*.mdc"],
			},
			files: {
				"my-skill/SKILL.md": `---\nname: other-name\ndescription: Discovered by a widened include on a rules surface.\n---${BODY}`,
			},
		},
	],
	invalid: [],
});

/**
 * Every file rule that claims no `doc.surface.kind` gate gets an
 * `invalid` case on a non-`skills` surface wherever one can be built, so that adding such a gate
 * to `check` breaks a test rather than passing silently. This rule is one of two that cannot
 * have one, and the absence is pinned here rather than left to be rediscovered.
 *
 * The reason is in the dialect data, not in the rule: every non-`skills` contract in
 * `BUILTIN_DIALECTS` is `nameMatchesDir: "decoupled"`, so the coupling gate in `check` returns
 * before the comparison for every non-`skills` document that exists today — measured, with the two
 * `valid` cases above. Adding `if (doc.surface.kind !== "skills") return [];` is therefore a
 * genuine no-op here, not an uncaught regression. The rule still does not gate on `kind` on
 * purpose (see its JSDoc: a contract is per (dialect, kind), so `nameMatchesDir` already IS this
 * kind's own answer), and this assertion is what fails on the day a non-`skills` contract couples
 * `name` to its directory — at which point the real `invalid` case becomes constructible and has
 * to be written.
 */
test("every non-`skills` contract is decoupled, which is the only reason this rule cannot be proved to run on one", () => {
	const coupled: string[] = [];
	for (const id of BUILTIN_DIALECT_IDS) {
		for (const kind of SURFACE_KINDS) {
			if (kind === "skills") {
				continue;
			}
			const contract = BUILTIN_DIALECTS[id].contracts[kind];
			if (contract !== undefined && contract.nameMatchesDir !== "decoupled") {
				coupled.push(`${id}/${kind}`);
			}
		}
	}

	expect(coupled).toEqual([]);
});
