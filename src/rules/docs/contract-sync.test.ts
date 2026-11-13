import { runRuleTests } from "../../testing/rule-tester.js";
import { CONTRACT_BLOCK_LANG, docsContractSync } from "./contract-sync.js";

/**
 * `docs/contract-sync`'s edge cases.
 *
 * Every fixture uses one layout: a `skills` surface holding one entry document, and the contract
 * document at `docs/contract.md` — deliberately OUTSIDE the surface root, because a configured
 * document need not be a member of the surface it documents, and putting it inside would also
 * make it a second discovered document and force every expectation to disambiguate `file`.
 *
 * `needsGit: false` for the whole suite: `RuleTester` git-inits `project` cases by default,
 * and this rule never touches `ctx.git` — it reads one configured file and compares two key
 * lists — so three subprocesses per case would buy nothing. Setting it here rather than per case
 * is the same reasoning `RuleTestCases.needsGit` documents for `links/resolve` in the other
 * direction: "does this rule read git" is a fact about the RULE.
 *
 * One edge case has no test here and cannot have one, which is recorded
 * rather than quietly dropped: "a surface whose `skill/frontmatter-schema` options extend the
 * contract is still compared against the dialect merge only". A `RuleTester` case
 * runs against a registry of exactly the rule under test, so another rule's options cannot be
 * present in the first place — and the rule reads `ctx.surface.dialects`, which is the whole of
 * its input, so there is nothing for such a case to discriminate. The guarantee is structural,
 * and it is stated where a user meets it: the rule's own JSDoc.
 */

/** `generic` skills, the RuleTester's default dialect: the spec's closed six-key set. */
const GENERIC_ALLOWED =
	"[name, description, license, compatibility, metadata, allowed-tools]";
const GENERIC_REQUIRED = "[name, description]";

/**
 * A contract document whose single block starts at line 3. With a two-line body the block spans
 * 3:1–6:4, which is `BLOCK_LOC` below — every position assertion in this file is that span, and
 * it is spelled out rather than computed so a fixture that grows a line fails loudly.
 */
function contractDoc(body: string, lang: string = CONTRACT_BLOCK_LANG): string {
	return `# Frontmatter contract\n\n\`\`\`${lang}\n${body}\`\`\`\n`;
}

const BLOCK_LOC = { line: 3, col: 1, endLine: 6, endCol: 4 } as const;

/** The body every "the document is right" fixture uses. */
const MATCHING_BODY = `allowed: ${GENERIC_ALLOWED}\nrequired: ${GENERIC_REQUIRED}\n`;

const ENTRY_FILES = { "skills/widgets/SKILL.md": "# Widgets\n" } as const;

runRuleTests(docsContractSync, {
	needsGit: false,
	valid: [
		{
			name: "the documented lists match the surface's dialect contract exactly",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(MATCHING_BODY),
			},
		},
		{
			// Sets, not sequences: both lists are written back to front and nothing is reported.
			name: "list order does not matter",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [allowed-tools, metadata, compatibility, license, description, name]\nrequired: [description, name]\n",
				),
			},
		},
		{
			// A duplicate is recorded, not reported — a doc-quality nit outside
			// this linter's scope.
			name: "a duplicate inside a list is tolerated",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [name, name, description, license, compatibility, metadata, allowed-tools]\nrequired: [name, description, description]\n",
				),
			},
		},
		{
			// mdast splits the info string into `lang` + `meta`, so anything after the language is
			// invisible to the match. Without that split this fixture would report a missing block.
			name: "extra info after the language still selects the block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					MATCHING_BODY,
					`${CONTRACT_BLOCK_LANG} title=Frontmatter`,
				),
			},
		},
		{
			// The walk is a full tree walk, not a scan of the root's direct children: a fence
			// inside a blockquote (or a list item) is an ordinary way to write one.
			name: "a block nested inside a blockquote is still found",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": `# Frontmatter contract\n\n> \`\`\`${CONTRACT_BLOCK_LANG}\n> allowed: ${GENERIC_ALLOWED}\n> required: ${GENERIC_REQUIRED}\n> \`\`\`\n`,
			},
		},
		{
			// The union, the clean half: `copilot` allows four keys and `opencode` five, sharing
			// three, so the union is six — and a document listing all six is right even though it
			// matches NEITHER dialect on its own.
			name: "a multi-dialect surface is measured against the union of its dialects",
			options: { file: "docs/contract.md" },
			surface: { root: "skills", dialects: ["copilot", "opencode"] },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [name, description, license, allowed-tools, compatibility, metadata]\nrequired: [name, description]\n",
				),
			},
		},
	],
	invalid: [
		{
			name: "a key the contract requires that the document omits is reported",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					`allowed: ${GENERIC_ALLOWED}\nrequired: [name]\n`,
				),
			},
			errors: [
				{
					message:
						'Contract block omits "description" from "required", but this surface\'s dialects require it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
			],
		},
		{
			name: "a key the document claims that no dialect on the surface allows is reported",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [name, description, license, compatibility, metadata, allowed-tools, colour]\nrequired: [name, description]\n",
				),
			},
			errors: [
				{
					message:
						'Contract block lists "colour" under "allowed", but this surface\'s dialects do not allow it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
			],
		},
		{
			// The discriminating half of the union case above: this document is a perfect
			// transcription of `copilot`'s own contract, and it is still wrong, because the surface
			// declares `opencode` too. Compared against either dialect alone it would be clean.
			name: "a multi-dialect surface reports the keys only its other dialect contributes",
			options: { file: "docs/contract.md" },
			surface: { root: "skills", dialects: ["copilot", "opencode"] },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [name, description, license, allowed-tools]\nrequired: [name, description]\n",
				),
			},
			errors: [
				{
					message:
						'Contract block omits "compatibility" from "allowed", but this surface\'s dialects allow it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
				{
					message:
						'Contract block omits "metadata" from "allowed", but this surface\'s dialects allow it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
			],
		},
		{
			// The two lists are compared independently. `license` IS in the contract's `allowed`,
			// and the document's `allowed` agrees about it perfectly — but the contract does not
			// require it, so claiming it under `required` is drift all the same. A comparison that
			// checked "is this key in the contract at all" would let this through.
			name: "a key the contract only allows, documented as required, is a required mismatch",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					`allowed: ${GENERIC_ALLOWED}\nrequired: [name, description, license]\n`,
				),
			},
			errors: [
				{
					message:
						'Contract block lists "license" under "required", but this surface\'s dialects do not require it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
			],
		},
		{
			// Two assertions in one case, on purpose: the second block is reported (positioned at
			// ITSELF, 8:1–11:4, not at the first block or at the file), AND the first block is
			// still compared — its `required: [name]` omission is reported at 3:1–6:4. Dropping
			// either half of that behaviour fails this case.
			name: "a second contract block is reported at itself, and the first is still compared",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": `# Frontmatter contract\n\n\`\`\`${CONTRACT_BLOCK_LANG}\nallowed: ${GENERIC_ALLOWED}\nrequired: [name]\n\`\`\`\n\n\`\`\`${CONTRACT_BLOCK_LANG}\nallowed: []\nrequired: []\n\`\`\`\n`,
			},
			errors: [
				{
					message:
						'Contract block omits "description" from "required", but this surface\'s dialects require it',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
				{
					message: `Contract file "docs/contract.md" has more than one "${CONTRACT_BLOCK_LANG}" code block; there must be exactly one, and only the first is compared`,
					file: "docs/contract.md",
					line: 8,
					col: 1,
					endLine: 11,
					endCol: 4,
				},
			],
		},
		{
			// A configured `file` naming nothing readable is a CONFIGURATION problem, not a
			// violation: `config/missing-file` at `error`, against the config file, through the
			// same `loadConfiguredDocument` the `index/*` rules use — which is why the message
			// differs from theirs by one word. No `line`/`col`: the engine defaults a
			// `ConfigReport`'s position to `ctx.surface.loc`, and `RuleTester` builds its surface
			// in code with no yaml behind it.
			name: "a configured file missing from disk is a config problem, not a violation",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: { ...ENTRY_FILES },
			errors: [
				{
					ruleId: "config/missing-file",
					message: 'Contract file "docs/contract.md" does not exist',
					file: "skillslurp.json",
				},
			],
		},
		{
			// The document is there and readable, it just declares no contract. Reported against
			// the DOCUMENT at 1:1 — the whole file is what is missing the block — rather than
			// against the config file, which is not the thing to go and edit.
			name: "a readable document with no contract block is a config problem at the document",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md":
					"# Frontmatter contract\n\nWe will write this down one day.\n",
			},
			errors: [
				{
					ruleId: "config/missing-contract-block",
					message: `Contract file "docs/contract.md" has no "${CONTRACT_BLOCK_LANG}" code block`,
					file: "docs/contract.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// `lang` is matched EXACTLY, so a merely similar language is not the contract block —
			// and, having found none, the rule says so rather than comparing whatever it found.
			name: "a fence whose language merely resembles the marker is not the contract block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					MATCHING_BODY,
					`${CONTRACT_BLOCK_LANG}-ish`,
				),
			},
			errors: [
				{
					ruleId: "config/missing-contract-block",
					message: `Contract file "docs/contract.md" has no "${CONTRACT_BLOCK_LANG}" code block`,
					file: "docs/contract.md",
					line: 1,
					col: 1,
				},
			],
		},
		{
			// Malformed YAML positioned AT THE BLOCK (3:1–6:4), not at the file and not at a line
			// inside the body: the block is the unit this rule reads.
			name: "malformed YAML in the block is a config problem positioned at the block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					"allowed: [name, description\nrequired: [name, description]\n",
				),
			},
			errors: [
				{
					ruleId: "config/invalid-contract-block",
					message:
						'Contract block in "docs/contract.md" is not valid YAML: Flow sequence in block collection must be sufficiently indented and end with a ]',
					file: "docs/contract.md",
					...BLOCK_LOC,
				},
			],
		},
		{
			// Strict object, the same posture the config's own unknown-key handling takes.
			name: "a body key other than allowed/required is a config problem at the block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": contractDoc(
					`allowed: ${GENERIC_ALLOWED}\nrequired: ${GENERIC_REQUIRED}\nforbidden: [colour]\n`,
				),
			},
			errors: [
				{
					ruleId: "config/invalid-contract-block",
					message:
						'Contract block in "docs/contract.md" is not a valid contract: Unrecognized key: "forbidden"',
					file: "docs/contract.md",
					line: 3,
					col: 1,
					endLine: 7,
					endCol: 4,
				},
			],
		},
		{
			// Both keys are required. A document stating only half the contract is not stating the
			// contract, and reading the absent key as `[]` would turn one lost line into a pile of
			// per-key drift reports pointing everywhere except at what actually broke.
			name: "a body missing one of the two lists is a config problem at the block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": `# Frontmatter contract\n\n\`\`\`${CONTRACT_BLOCK_LANG}\nallowed: ${GENERIC_ALLOWED}\n\`\`\`\n`,
			},
			errors: [
				{
					ruleId: "config/invalid-contract-block",
					message:
						'Contract block in "docs/contract.md" is not a valid contract: required: Invalid input: expected array, received undefined',
					file: "docs/contract.md",
					line: 3,
					col: 1,
					endLine: 5,
					endCol: 4,
				},
			],
		},
		{
			// An empty block parses as YAML `null`, which is not a contract either — the one shape
			// where "the YAML is fine" and "the body is a contract" come apart most quietly.
			name: "an empty block body is a config problem at the block",
			options: { file: "docs/contract.md" },
			surface: { root: "skills" },
			files: {
				...ENTRY_FILES,
				"docs/contract.md": `# Frontmatter contract\n\n\`\`\`${CONTRACT_BLOCK_LANG}\n\`\`\`\n`,
			},
			errors: [
				{
					ruleId: "config/invalid-contract-block",
					message:
						'Contract block in "docs/contract.md" is not a valid contract: Invalid input: expected object, received null',
					file: "docs/contract.md",
					line: 3,
					col: 1,
					endLine: 4,
					endCol: 4,
				},
			],
		},
	],
});
