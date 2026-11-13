import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { BUILTIN_DIALECTS } from "../../dialects.js";
import { runEngine } from "../../engine.js";
import { runRuleTests } from "../../testing/rule-tester.js";
import { builtinRules } from "../index.js";
import { frontmatterSchema } from "./frontmatter-schema.js";

// Anchored to this module's own location, not process.cwd() (see discover.test.ts for the same
// rationale) — import.meta.url is standard ESM, not Bun-only. Used only by the final
// runEngine-over-skills-repo integration test; every behavioral case above it runs through
// `runRuleTests`/RuleTester, with an inline `files` map
// instead of a fixture on disk.
const SKILLS_REPO_ROOT = fileURLToPath(
	new URL("../../../test/fixtures/skills-repo", import.meta.url),
);

// --- checks 1 & 2: structural (no dialect involved — these fire before any option is read) ---

runRuleTests(frontmatterSchema, {
	valid: [],
	invalid: [
		{
			name: "a document with no frontmatter block reports at 1:1 and nothing else",
			files: { "SKILL.md": "# No frontmatter\n\nJust a body.\n" },
			errors: [{ message: "Missing YAML frontmatter block", line: 1, col: 1 }],
		},
		{
			name: "empty block (--- / --- with nothing between) reports at the block position",
			files: { "SKILL.md": "---\n---\nBody\n" },
			errors: [
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 2,
					endCol: 4,
				},
			],
		},
		{
			name: "a bare scalar block reports at the block position",
			files: { "SKILL.md": "---\nhello\n---\n" },
			errors: [
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 3,
					endCol: 4,
				},
			],
		},
		{
			name: "a list block reports at the block position",
			files: { "SKILL.md": "---\n- a\n---\n" },
			errors: [
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 3,
					endCol: 4,
				},
			],
		},
	],
});

// --- checks 1 & 2 where the merged contract makes the block optional (claude-code only) ---

const MISSING_BLOCK = {
	message: "Missing YAML frontmatter block",
	line: 1,
	col: 1,
};

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "claude-code rules: a rule with no frontmatter block is clean",
			surface: { kind: "rules", dialects: ["claude-code"] },
			files: { ".claude/rules/style.md": "Always use tabs.\n" },
		},
		{
			name: "claude-code rules: an empty frontmatter block is clean",
			surface: { kind: "rules", dialects: ["claude-code"] },
			files: { ".claude/rules/style.md": "---\n---\nAlways use tabs.\n" },
		},
		{
			name: "claude-code skills: a skill with no frontmatter block is clean",
			surface: { dialects: ["claude-code"] },
			files: { "SKILL.md": "# No frontmatter\n\nJust a body.\n" },
		},
		{
			name: "claude-code skills: an empty frontmatter block is clean",
			surface: { dialects: ["claude-code"] },
			files: { "SKILL.md": "---\n---\nBody.\n" },
		},
		{
			name: "claude-code skills: a first line that is not the opening fence is plain content, not frontmatter",
			surface: { dialects: ["claude-code"] },
			files: { "SKILL.md": "\n---\nname: Not-A-Valid_Name\nbogus: 1\n---\n" },
		},
	],
	invalid: [
		{
			name: "cursor rules: a rule with no frontmatter block is still reported",
			surface: { kind: "rules", dialects: ["cursor"] },
			files: { "style.mdc": "Always use tabs.\n" },
			errors: [MISSING_BLOCK],
		},
		{
			name: "claude-code + cursor rules: one dialect that needs the block makes it required for the surface",
			surface: { kind: "rules", dialects: ["claude-code", "cursor"] },
			files: { "style.md": "Always use tabs.\n" },
			errors: [MISSING_BLOCK],
		},
		{
			name: "cursor + claude-code rules: the same in the other order, for an empty block",
			surface: { kind: "rules", dialects: ["cursor", "claude-code"] },
			files: { "style.md": "---\n---\nAlways use tabs.\n" },
			errors: [
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 2,
					endCol: 4,
				},
			],
		},
		{
			name: "claude-code + generic skills: generic needs the block, so it is required for the surface",
			surface: { dialects: ["claude-code", "generic"] },
			files: { "SKILL.md": "# No frontmatter\n" },
			errors: [MISSING_BLOCK],
		},
		{
			name: "claude-code skills: a bare scalar block is still not a mapping",
			surface: { dialects: ["claude-code"] },
			files: { "SKILL.md": "---\nhello\n---\n" },
			errors: [
				{
					message: "Frontmatter must be a YAML mapping",
					line: 1,
					col: 1,
					endLine: 3,
					endCol: 4,
				},
			],
		},
		{
			name: "claude-code skills: a required key from the options is missing from a document with no block, at 1:1",
			surface: { dialects: ["claude-code"] },
			options: { required: ["description"] },
			files: { "SKILL.md": "# No frontmatter\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
				},
			],
		},
		{
			name: "claude-code skills: a required key from the options is missing from an empty block, on the opening fence",
			surface: { dialects: ["claude-code"] },
			options: { required: ["description", "name"] },
			files: { "SKILL.md": "---\n---\nBody.\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
				{
					message: 'Missing required frontmatter key "name"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "claude-code rules: a required key from the options is missing from a rule with no block",
			surface: { kind: "rules", dialects: ["claude-code"] },
			options: { required: ["paths"] },
			files: { ".claude/rules/style.md": "Always use tabs.\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "paths"',
					line: 1,
					col: 1,
				},
			],
		},
	],
});

// --- check 3: missing required keys, now dialect-driven instead of a hardcoded default ---

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "generic: a fully valid, ordinary skill produces zero reports",
			files: {
				"SKILL.md":
					"---\nname: good-skill\ndescription: A well-formed skill used as the clean control.\n---\n\nNothing here should trigger any diagnostic.\n",
			},
		},
		{
			name: "claude-code alone: nothing is required, so a frontmatter with only description is clean",
			surface: { dialects: ["claude-code"] },
			files: {
				"SKILL.md":
					"---\ndescription: A skill with no name key at all.\n---\nBody.\n",
			},
		},
	],
	invalid: [
		{
			name: "generic: missing description reports the exact message at the opening fence",
			files: { "SKILL.md": "---\nname: x\n---\n\nBody\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "generic: both name and description missing report in dialect (required) order",
			// An explicit empty flow mapping (`{}`) — a mapping with zero keys — isolates this
			// check: no unexpected-key report can fire alongside it.
			files: { "SKILL.md": "---\n{}\n---\n" },
			errors: [
				// Same position for both (the opening fence), so the engine's own tie-break
				// (compareDiagnostics, engine.ts) sorts by message text, not by the rule's push
				// order — "description" sorts before "name" alphabetically.
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
				{
					message: 'Missing required frontmatter key "name"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "claude-code + generic: required is the union, so both are demanded even though claude-code alone requires neither",
			surface: { dialects: ["claude-code", "generic"] },
			files: { "SKILL.md": "---\n{}\n---\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
				{
					message: 'Missing required frontmatter key "name"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
	],
});

// --- check 4: unexpected keys, and options.required/options.allowed as overrides ---

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "a custom required+allowed union: a required-but-not-allowed key is never reported unexpected",
			options: { required: ["name", "topic"], allowed: ["name"] },
			files: { "SKILL.md": "---\nname: x\ntopic: y\n---\n" },
		},
		{
			name: "required override alone: the dialect's allowed set stays in force for keys the override never mentions",
			options: { required: ["name", "topic"] },
			files: {
				"SKILL.md": "---\nname: x\ntopic: y\nlicense: MIT\n---\nBody.\n",
			},
		},
	],
	invalid: [
		{
			name: "the unknown-key case reports exactly one violation, with the generic dialect's own (sorted) allowed list",
			files: {
				"SKILL.md":
					"---\nname: unknown-key\ndescription: Has a key that is not in the allowed set.\ntools: Read, Write\n---\n\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 6,
				},
			],
		},
		{
			name: "a custom allowed set flags a key outside the required+allowed union as unexpected",
			options: { required: ["name"], allowed: ["name"] },
			files: { "SKILL.md": "---\nname: x\nextra: y\n---\n" },
			errors: [
				{
					message: 'Unexpected frontmatter key "extra" (allowed: name)',
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 6,
				},
			],
		},
		{
			name: "an empty effective allowed set (required: [], allowed: []) omits the parenthetical entirely",
			options: { required: [], allowed: [] },
			files: { "SKILL.md": "---\nname: x\n---\n" },
			errors: [
				{
					message: 'Unexpected frontmatter key "name"',
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 5,
				},
			],
		},
		{
			name: "version is unexpected on the generic dialect — no built-in dialect documents it",
			files: {
				"SKILL.md":
					"---\nname: ok-name\ndescription: A description.\nversion: 1\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "version" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 8,
				},
			],
		},
		{
			name: "version is unexpected on a claude-code + generic surface too — union of allowed still excludes it",
			surface: { dialects: ["claude-code", "generic"] },
			files: {
				"SKILL.md":
					"---\nname: ok-name\ndescription: A description.\nversion: 1\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "version" (allowed: agent, allowed-tools, argument-hint, arguments, background, compatibility, context, description, disable-model-invocation, disallowed-tools, effort, hooks, license, metadata, model, name, paths, shell, user-invocable, when_to_use)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 8,
				},
			],
		},
		{
			name: "required override alone: the overridden key is still demanded, even though it is not a dialect key",
			options: { required: ["name", "topic"] },
			files: { "SKILL.md": "---\nname: x\nlicense: MIT\n---\nBody.\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "topic"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "allowed override alone: it REPLACES the dialect's allowed set rather than extending it",
			options: { allowed: ["name", "description"] },
			files: {
				"SKILL.md": "---\nname: x\ndescription: y\nlicense: MIT\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "license" (allowed: description, name)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 8,
				},
			],
		},
	],
});

// --- checks 5 & 6: required key present, value shape (incl. alias-valued keys) ---

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "a mapping-valued metadata key is allowed and never type-checked (metadata is not required)",
			files: {
				"SKILL.md": "---\nname: x\ndescription: y\nmetadata:\n  a: 1\n---\n",
			},
		},
		{
			name: "an alias resolving to a non-empty string passes (zero reports)",
			files: { "SKILL.md": "---\nname: &n hello\ndescription: *n\n---\n" },
		},
	],
	invalid: [
		{
			name: 'name: "" reports empty at the value node\'s range',
			files: { "SKILL.md": '---\nname: ""\ndescription: x\n---\n' },
			errors: [
				{
					message: 'Frontmatter key "name" must not be empty',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 9,
				},
			],
		},
		{
			name: 'name: "   " (whitespace-only) also reports empty, at the value node\'s range',
			files: { "SKILL.md": '---\nname: "   "\ndescription: x\n---\n' },
			errors: [
				{
					message: 'Frontmatter key "name" must not be empty',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 12,
				},
			],
		},
		{
			name: "description: (null value, key with nothing after it) reports empty, falling back to the key's range",
			files: { "SKILL.md": "---\nname: x\ndescription:\n---\n" },
			errors: [
				{
					message: 'Frontmatter key "description" must not be empty',
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 12,
				},
			],
		},
		{
			name: "name: [a] reports a list type at the value node's range",
			files: { "SKILL.md": "---\nname: [a]\ndescription: x\n---\n" },
			errors: [
				{
					message: 'Frontmatter key "name" must be a string, got list',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 10,
				},
			],
		},
		{
			name: "description: 42 reports a number type at the value node's range",
			files: { "SKILL.md": "---\nname: x\ndescription: 42\n---\n" },
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got number',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 16,
				},
			],
		},
		// An explicit `!!timestamp` tag is required for this: verified empirically (see
		// describeType's comment in ../frontmatter.ts) that yaml's default
		// "core" (1.2) schema leaves a bare, untagged `2001-12-14` as a plain string — only the
		// explicit tag forces resolution to a real `Date` instance.
		{
			name: 'a !!timestamp-tagged required value resolves to a Date and reports "got date"',
			files: {
				"SKILL.md": "---\nname: x\ndescription: !!timestamp 2001-12-14\n---\n",
			},
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got date',
					line: 3,
					col: 26,
					endLine: 3,
					endCol: 36,
				},
			],
		},
		{
			name: 'an alias resolving to "" fires "must not be empty", at the alias reference\'s own range (not its anchor\'s)',
			options: { required: ["name", "description"], allowed: ["name", "d"] },
			files: { "SKILL.md": '---\nd: &d ""\nname: x\ndescription: *d\n---\n' },
			errors: [
				{
					message: 'Frontmatter key "description" must not be empty',
					line: 4,
					col: 14,
					endLine: 4,
					endCol: 16,
				},
			],
		},
		{
			name: 'an alias resolving to a list fires "got list", at the alias reference\'s own range',
			options: {
				required: ["name", "description"],
				allowed: ["name", "lst"],
			},
			files: {
				"SKILL.md": "---\nlst: &lst [a, b]\nname: x\ndescription: *lst\n---\n",
			},
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got list',
					line: 4,
					col: 14,
					endLine: 4,
					endCol: 18,
				},
			],
		},
		{
			name: 'a duplicate required key ("name" twice) reports the missing key only once',
			options: { required: ["name", "name"] },
			files: { "SKILL.md": "---\n{}\n---\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "name"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: 'a duplicate required key ("name" twice) reports an empty value only once',
			options: { required: ["name", "name"] },
			files: { "SKILL.md": '---\nname: ""\n---\n' },
			errors: [
				{
					message: 'Frontmatter key "name" must not be empty',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 9,
				},
			],
		},
		{
			name: 'a numeric key 1 and a string key "1" are not a yaml DUPLICATE_KEY, but collapse in this rule — the first one wins',
			// `1: ""` (a numeric key) is parsed first; `"1": b` (a string key) is a second,
			// entirely distinct yaml mapping entry — yaml itself raises no DUPLICATE_KEY error
			// for this. This rule can only compare keys by their String() form, though, so the
			// two collapse onto the same "1" — first occurrence wins. Proof it's the FIRST that
			// wins: only the first entry's value is empty, and that's exactly the one reported.
			// (If frontmatter parsing HAD produced a `parse/frontmatter` error here, the engine
			// would skip this rule entirely and RuleTester's own "rule never invoked" guard would
			// fail the case — so a passing case is itself proof `fm.errors` stayed empty.)
			options: {
				required: ["1", "name", "description"],
				allowed: ["1", "name", "description"],
			},
			files: {
				"SKILL.md": '---\n1: ""\n"1": b\nname: n\ndescription: d\n---\n',
			},
			errors: [
				{
					message: 'Frontmatter key "1" must not be empty',
					line: 2,
					col: 4,
					endLine: 2,
					endCol: 6,
				},
			],
		},
		{
			name: "an explicit non-scalar key (a yaml collection key) is reported as unexpected, with keyDisplay's JSON-ish form byte-pinned",
			files: {
				"SKILL.md": "---\n? [a, b]\n: x\nname: n\ndescription: d\n---\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "["a","b"]" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
					line: 2,
					col: 3,
					endLine: 2,
					endCol: 9,
				},
			],
		},
	],
});

// --- check 7: name format, against every distinct pattern the surface's dialects document ---

const NAME_FORMAT_MESSAGE =
	'Frontmatter key "name" must contain only lowercase letters, digits and single hyphens, with no leading, trailing or consecutive hyphens';

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "generic: a perfectly ordinary name passes",
			files: {
				"SKILL.md":
					"---\nname: pdf-tools\ndescription: A perfectly ordinary name.\n---\nBody.\n",
			},
		},
		{
			name: "claude-code alone: an odd name (uppercase, underscore, colon-shaped) is clean — the dialect places no charset constraint on it",
			surface: { dialects: ["claude-code"] },
			files: {
				"SKILL.md":
					"---\nname: Not-A-Valid_Name\ndescription: A skill whose name claude-code does not constrain.\n---\nBody.\n",
			},
		},
	],
	invalid: [
		{
			name: "a leading hyphen is rejected",
			files: {
				"SKILL.md":
					"---\nname: -lead\ndescription: A name with a leading hyphen.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 12,
				},
			],
		},
		{
			name: "a trailing hyphen is rejected",
			files: {
				"SKILL.md":
					"---\nname: trail-\ndescription: A name with a trailing hyphen.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 13,
				},
			],
		},
		{
			name: "consecutive hyphens are rejected",
			files: {
				"SKILL.md":
					"---\nname: double--hyphen\ndescription: A name with consecutive hyphens.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 21,
				},
			],
		},
		{
			name: "uppercase letters are rejected",
			files: {
				"SKILL.md":
					"---\nname: Upper\ndescription: A name with an uppercase letter.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 12,
				},
			],
		},
		{
			name: "an underscore is rejected",
			files: {
				"SKILL.md":
					"---\nname: snake_case\ndescription: A name with an underscore.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 17,
				},
			],
		},
		{
			name: "claude-code + generic: generic's pattern applies to a present name even though claude-code alone would not constrain it",
			surface: { dialects: ["claude-code", "generic"] },
			files: {
				"SKILL.md":
					"---\nname: Not-Valid-Under-Generic\ndescription: A description.\n---\nBody.\n",
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 30,
				},
			],
		},
		{
			name: "check 7 fires independently of required-ness: name is optional via options.required, but its format is still checked",
			options: { required: [] },
			files: { "SKILL.md": "---\nname: Bad_Name\n---\nBody.\n" },
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 15,
				},
			],
		},
	],
});

// --- check 8: documented max lengths (name, description, compatibility, ...) ---

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "generic: name at exactly 64 characters is clean",
			files: {
				"SKILL.md": `---\nname: ${"a".repeat(64)}\ndescription: A valid, ordinary description.\n---\nBody.\n`,
			},
		},
		{
			name: "generic: description at exactly 1024 characters is clean",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: ${"a".repeat(1024)}\n---\nBody.\n`,
			},
		},
		{
			name: "generic: compatibility at exactly 500 characters is clean",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: A description.\ncompatibility: ${"a".repeat(500)}\n---\nBody.\n`,
			},
		},
		{
			name: "claude-code alone: a 2000-character description is clean — the dialect documents no cap for it",
			surface: { dialects: ["claude-code"] },
			files: {
				"SKILL.md": `---\ndescription: ${"a".repeat(2000)}\n---\nBody.\n`,
			},
		},
		{
			name: "generic: description at exactly 1024 ASTRAL code points is clean (code points counted, not UTF-16 units)",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: ${"𝕏".repeat(1024)}\n---\nBody.\n`,
			},
		},
	],
	invalid: [
		{
			name: "generic: name at 65 characters is flagged",
			files: {
				"SKILL.md": `---\nname: ${"a".repeat(65)}\ndescription: A valid, ordinary description.\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "name" must be at most 64 characters (found 65)',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 72,
				},
			],
		},
		{
			name: "generic: description at 1025 characters is flagged",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: ${"a".repeat(1025)}\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "description" must be at most 1024 characters (found 1025)',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 1039,
				},
			],
		},
		{
			name: "generic: compatibility at 501 characters is flagged",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: A description.\ncompatibility: ${"a".repeat(501)}\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "compatibility" must be at most 500 characters (found 501)',
					line: 4,
					col: 16,
					endLine: 4,
					endCol: 517,
				},
			],
		},
		{
			name: "claude-code + generic: min-per-key applies — generic's 1024 cap on description still fires even though claude-code alone caps nothing there",
			surface: { dialects: ["claude-code", "generic"] },
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: ${"a".repeat(1025)}\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "description" must be at most 1024 characters (found 1025)',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 1039,
				},
			],
		},
		{
			name: "generic: description at 1025 ASTRAL code points is flagged with the code-point count, not the (double) UTF-16 count",
			files: {
				"SKILL.md": `---\nname: ok-name\ndescription: ${"𝕏".repeat(1025)}\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "description" must be at most 1024 characters (found 1025)',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 2064,
				},
			],
		},
	],
});

// --- a third dialect data point beyond generic/claude-code: cursor's own allowed key set ---

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "cursor: paths and globs are both accepted (globs stays allowed as cursor's documented legacy fallback)",
			surface: { dialects: ["cursor"] },
			files: {
				"SKILL.md":
					'---\nname: my-cursor-skill\ndescription: Uses the allowed keys for the cursor skills dialect.\npaths: "docs/**"\nglobs: "legacy/**"\n---\nBody.\n',
			},
		},
	],
	invalid: [
		{
			name: "cursor: description is required, same as name",
			surface: { dialects: ["cursor"] },
			files: { "SKILL.md": "---\nname: my-cursor-skill\n---\nBody.\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "description"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "cursor: a claude-code-only key (when_to_use) is unexpected here",
			surface: { dialects: ["cursor"] },
			files: {
				"SKILL.md":
					"---\nname: my-cursor-skill\ndescription: Uses the allowed keys for the cursor skills dialect.\nwhen_to_use: This key belongs to claude-code, not cursor.\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "when_to_use" (allowed: color, description, disable-model-invocation, globs, icon, metadata, name, paths)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 12,
				},
			],
		},
	],
});

// --- the surface's `kind` selects the dialect contract, and the rule runs on a non-`skills`
// surface at all ---

// The two halves are one argument, and the `invalid` half is what makes the `valid` half mean
// anything. On its own, a clean case on a non-`skills` surface cannot tell "the kind's contract
// was consulted and the file satisfies it" apart from "the rule never ran" — which is exactly what
// this block used to claim, over two `valid` cases and nothing else. So each kind gets both: a
// file that is clean ONLY under that kind's contract (both would be several errors under a
// `skills` contract — `globs`, `alwaysApply` and `applyTo` are all unexpected there, and `name` is
// missing), and a file whose one unexpected key IS reported, naming that kind's own allowed set.
// Adding `if (doc.surface.kind !== "skills") return [];` to the top of `check` now turns the
// `invalid` half red; before it existed, that mutation left the whole suite green.
runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "rules kind + cursor: description/globs/alwaysApply is the vendor-documented .mdc shape, and is clean",
			surface: { kind: "rules", dialects: ["cursor"] },
			files: {
				"style.mdc":
					"---\ndescription: Style rules for the docs tree.\nglobs: docs/**/*.md, docs/**/*.mdx\nalwaysApply: false\n---\nBody.\n",
			},
		},
		{
			name: "instructions kind + copilot: applyTo plus a free-form name is clean — copilot instructions constrain neither",
			surface: { kind: "instructions", dialects: ["copilot"] },
			files: {
				"ts.instructions.md":
					'---\napplyTo: "**/*.ts"\nname: Whatever Free-Form Label!!\n---\nBody.\n',
			},
		},
	],
	invalid: [
		{
			name: "rules kind + cursor: a key outside the .mdc contract reports, naming the rules allowed set and not the skills one",
			surface: { kind: "rules", dialects: ["cursor"] },
			files: {
				"style.mdc":
					"---\ndescription: Style rules for the docs tree.\nglobs: docs/**/*.md\nlicense: MIT\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "license" (allowed: alwaysApply, description, globs)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 8,
				},
			],
		},
		{
			name: "instructions kind + copilot: a key outside the .instructions.md contract reports too",
			surface: { kind: "instructions", dialects: ["copilot"] },
			files: {
				"ts.instructions.md":
					'---\napplyTo: "**/*.ts"\nlicense: MIT\n---\nBody.\n',
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "license" (allowed: applyTo, description, excludeAgent, name)',
					line: 3,
					col: 1,
					endLine: 3,
					endCol: 8,
				},
			],
		},
	],
});

// --- further per-dialect coverage: opencode, copilot skills, and check 8's
// document-order guarantee across two violations in one file. `codex` is deliberately skipped:
// its skills contract is `generic`'s minus `toolUnknownKeyPolicy`, already pinned at the data
// level in dialects.test.ts, so no rule-level case here would add anything. ---

runRuleTests(frontmatterSchema, {
	valid: [],
	invalid: [
		{
			name: "opencode: allowed-tools is unexpected — the only skills dialect whose allowed set omits it",
			surface: { dialects: ["opencode"] },
			files: {
				"SKILL.md":
					"---\nname: op-skill\ndescription: Exercises the opencode dialect's own allowed set.\nallowed-tools: Read, Write\n---\nBody.\n",
			},
			errors: [
				{
					message:
						'Unexpected frontmatter key "allowed-tools" (allowed: compatibility, description, license, metadata, name)',
					line: 4,
					col: 1,
					endLine: 4,
					endCol: 14,
				},
			],
		},
		{
			name: "copilot: name format is still checked even though the dialect documents no length caps at all — a 2000-character description stays clean",
			surface: { dialects: ["copilot"] },
			files: {
				"SKILL.md": `---\nname: Bad_Name\ndescription: ${"a".repeat(2000)}\n---\nBody.\n`,
			},
			errors: [
				{
					message: NAME_FORMAT_MESSAGE,
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 15,
				},
			],
		},
		{
			name: "generic: two over-cap keys in one file are both reported, in document order",
			files: {
				"SKILL.md": `---\ndescription: ${"a".repeat(1025)}\nname: ${"a".repeat(65)}\n---\nBody.\n`,
			},
			errors: [
				{
					message:
						'Frontmatter key "description" must be at most 1024 characters (found 1025)',
					line: 2,
					col: 14,
					endLine: 2,
					endCol: 1039,
				},
				{
					message:
						'Frontmatter key "name" must be at most 64 characters (found 65)',
					line: 3,
					col: 7,
					endLine: 3,
					endCol: 72,
				},
			],
		},
	],
});

// --- checks 5 & 6, per key: a required key's type is checked only where a source documents one ---

const EMPTY_GLOBS = 'Frontmatter key "globs" must not be empty';

runRuleTests(frontmatterSchema, {
	valid: [
		{
			name: "a required primary activation key written as a flow list is clean",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": "---\nglobs: [docs/**, src/**]\n---\nBody.\n" },
		},
		{
			name: "a required primary activation key written as a block list is clean",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: {
				"style.mdc": "---\nglobs:\n  - docs/**\n  - src/**\n---\nBody.\n",
			},
		},
		{
			name: "a required primary activation key written as a comma-separated scalar is clean",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": "---\nglobs: docs/**, src/**\n---\nBody.\n" },
		},
		{
			name: "a required primary activation key given by an alias to an anchored list is resolved, not reported",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: {
				"style.mdc":
					"---\ndescription: &g [docs/**, src/**]\nglobs: *g\n---\nBody.\n",
			},
		},
		{
			name: "a required LEGACY activation key (cursor skills' globs) has no documented type, so a number is clean",
			surface: { dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "SKILL.md": "---\nglobs: 42\n---\nBody.\n" },
		},
		{
			name: "a key only the config requires is not type-checked: alwaysApply: false (a boolean) is clean",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["alwaysApply"] },
			files: { "style.mdc": "---\nalwaysApply: false\n---\nBody.\n" },
		},
		{
			name: "a key no claude-code constraint covers (metadata) stays presence-only: a non-empty mapping is clean",
			surface: { dialects: ["claude-code"] },
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nmetadata:\n  a: b\n---\nBody.\n" },
		},
		{
			name: "a length cap on a key is read from the surface's own dialects: copilot documents none for compatibility, so a number is clean",
			surface: { dialects: ["copilot"] },
			options: { required: ["compatibility"] },
			files: { "SKILL.md": "---\ncompatibility: 42\n---\nBody.\n" },
		},
		{
			name: "a key only the config requires is not type-checked: a non-empty mapping is clean",
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nmetadata:\n  a: b\n---\nBody.\n" },
		},
	],
	invalid: [
		{
			name: "a required primary activation key that is an empty list reports empty, at the list",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": "---\nglobs: []\n---\nBody.\n" },
			errors: [
				{ message: EMPTY_GLOBS, line: 2, col: 8, endLine: 2, endCol: 10 },
			],
		},
		{
			name: 'a required primary activation key that is a list of blank strings ["", " "] reports empty',
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": '---\nglobs: ["", " "]\n---\nBody.\n' },
			errors: [
				{ message: EMPTY_GLOBS, line: 2, col: 8, endLine: 2, endCol: 17 },
			],
		},
		{
			name: "a required primary activation key that is a list holding only a null reports empty",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": "---\nglobs: [~]\n---\nBody.\n" },
			errors: [
				{ message: EMPTY_GLOBS, line: 2, col: 8, endLine: 2, endCol: 11 },
			],
		},
		{
			name: 'a required primary activation key that is "" reports empty',
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": '---\nglobs: ""\n---\nBody.\n' },
			errors: [
				{ message: EMPTY_GLOBS, line: 2, col: 8, endLine: 2, endCol: 10 },
			],
		},
		{
			name: "a required primary activation key that is a mapping reports the shared reader's message, at the value",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": "---\nglobs: { a: 1 }\n---\nBody.\n" },
			errors: [
				{
					message:
						'Frontmatter key "globs" must be a string or a list of strings, got mapping',
					line: 2,
					col: 8,
					endLine: 2,
					endCol: 16,
				},
			],
		},
		{
			name: "a required primary activation key holding a non-string item reports the shared reader's message, at the item",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "style.mdc": '---\nglobs: [1, "a"]\n---\nBody.\n' },
			errors: [
				{
					message:
						'Frontmatter key "globs" must be a list of strings, but item 0 is a number',
					line: 2,
					col: 9,
					endLine: 2,
					endCol: 10,
				},
			],
		},
		{
			name: 'a required LEGACY activation key (cursor skills\' globs) that is "" still reports empty',
			surface: { dialects: ["cursor"] },
			options: { required: ["globs"] },
			files: { "SKILL.md": '---\nglobs: ""\n---\nBody.\n' },
			errors: [
				{ message: EMPTY_GLOBS, line: 2, col: 8, endLine: 2, endCol: 10 },
			],
		},
		{
			name: "a key a dialect documents as a string through a length cap keeps the string check: claude-code, compatibility: 42",
			surface: { dialects: ["claude-code"] },
			options: { required: ["compatibility"] },
			files: { "SKILL.md": "---\ncompatibility: 42\n---\nBody.\n" },
			errors: [
				{
					message:
						'Frontmatter key "compatibility" must be a string, got number',
					line: 2,
					col: 16,
					endLine: 2,
					endCol: 18,
				},
			],
		},
		{
			name: "a key only the config requires reports an empty mapping as empty",
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nmetadata: {}\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "metadata" must not be empty',
					line: 2,
					col: 11,
					endLine: 2,
					endCol: 13,
				},
			],
		},
		{
			name: "a key only the config requires reports an empty list as empty",
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nmetadata: []\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "metadata" must not be empty',
					line: 2,
					col: 11,
					endLine: 2,
					endCol: 13,
				},
			],
		},
		{
			name: "a key only the config requires reports a bare null as empty, at the key",
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nmetadata:\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "metadata" must not be empty',
					line: 2,
					col: 1,
					endLine: 2,
					endCol: 9,
				},
			],
		},
		{
			name: "a key only the config requires still reports as missing when absent",
			options: { required: ["metadata"] },
			files: { "SKILL.md": "---\nname: x\n---\nBody.\n" },
			errors: [
				{
					message: 'Missing required frontmatter key "metadata"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
		{
			name: "a key a dialect requires as a string keeps the string check: cursor skills, name: 42",
			surface: { dialects: ["cursor"] },
			files: { "SKILL.md": "---\nname: 42\ndescription: x\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "name" must be a string, got number',
					line: 2,
					col: 7,
					endLine: 2,
					endCol: 9,
				},
			],
		},
		{
			name: "a key a dialect only requires, with no cap or pattern on it, is still a string key: cursor skills, description: 42",
			surface: { dialects: ["cursor"] },
			files: { "SKILL.md": "---\nname: x\ndescription: 42\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got number',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 16,
				},
			],
		},
		{
			name: "a key a dialect only requires, with no cap or pattern on it, is still a string key: copilot skills, description: [a]",
			surface: { dialects: ["copilot"] },
			files: { "SKILL.md": "---\nname: x\ndescription: [a]\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got list',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 17,
				},
			],
		},
		{
			name: "a key a dialect requires as a string keeps the string check: generic, description: [a]",
			surface: { dialects: ["generic"] },
			files: { "SKILL.md": "---\nname: x\ndescription: [a]\n---\nBody.\n" },
			errors: [
				{
					message: 'Frontmatter key "description" must be a string, got list',
					line: 3,
					col: 14,
					endLine: 3,
					endCol: 17,
				},
			],
		},
		{
			name: "cursor rules with required description/globs/alwaysApply: four valid documents leave only the genuinely missing globs",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { required: ["description", "globs", "alwaysApply"] },
			files: {
				"a.mdc":
					"---\ndescription: a\nglobs: [docs/**, src/**]\nalwaysApply: false\n---\nBody.\n",
				"b.mdc":
					"---\ndescription: b\nglobs:\n  - docs/**\n  - src/**\nalwaysApply: true\n---\nBody.\n",
				"c.mdc":
					"---\ndescription: c\nglobs: docs/**, src/**\nalwaysApply: false\n---\nBody.\n",
				"d.mdc": "---\ndescription: d\nalwaysApply: false\n---\nBody.\n",
			},
			errors: [
				{
					file: "d.mdc",
					message: 'Missing required frontmatter key "globs"',
					line: 1,
					col: 1,
					endLine: 1,
					endCol: 4,
				},
			],
		},
	],
});

describe("required keys across the built-in contracts and a rule pair that reads the same key", () => {
	test("no built-in contract requires a key other than name and description, the only keys the rule type-checks as strings", () => {
		const typedAsString = new Set(["name", "description"]);
		const offenders: string[] = [];
		let checked = 0;
		for (const [id, dialect] of Object.entries(BUILTIN_DIALECTS)) {
			for (const [kind, contract] of Object.entries(dialect.contracts)) {
				checked++;
				for (const key of contract.required) {
					if (!typedAsString.has(key)) {
						offenders.push(`${id}/${kind}: ${key}`);
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	test("a type violation on a primary activation key is reported by both this rule and activation/consistent-scope on a multi-dialect surface", async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "skillslurp-frontmatter-schema-dup-"),
		);
		try {
			await mkdir(join(dir, "skills", "x"), { recursive: true });
			await writeFile(
				join(dir, "skillslurp.json"),
				JSON.stringify({
					version: 1,
					extends: [],
					surfaces: [{ root: "skills", dialects: ["claude-code", "cursor"] }],
					rules: {
						"skill/frontmatter-schema": { options: { required: ["paths"] } },
						"activation/consistent-scope": "error",
					},
				}),
				"utf8",
			);
			await writeFile(
				join(dir, "skills", "x", "SKILL.md"),
				"---\npaths: { a: 1 }\n---\nBody.\n",
				"utf8",
			);

			const config = await loadConfig(dir, builtinRules);
			const { diagnostics } = await runEngine(config, builtinRules);

			const message =
				'Frontmatter key "paths" must be a string or a list of strings, got mapping';
			const at = { file: "skills/x/SKILL.md", line: 2, col: 8, message };
			expect(
				diagnostics.map((d) => ({
					ruleId: d.ruleId,
					file: d.file,
					line: d.line,
					col: d.col,
					message: d.message,
				})),
			).toEqual([
				{ ruleId: "activation/consistent-scope", ...at },
				{ ruleId: "skill/frontmatter-schema", ...at },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("integration: runEngine over the skills-repo fixture", () => {
	test("produces the full, deterministically sorted diagnostic list for every fixture skill", async () => {
		const config = await loadConfig(SKILLS_REPO_ROOT, builtinRules);
		const { diagnostics } = await runEngine(config, builtinRules);

		expect(
			diagnostics.map((d) => ({
				ruleId: d.ruleId,
				file: d.file,
				line: d.line,
				col: d.col,
				message: d.message,
			})),
		).toEqual([
			{
				ruleId: "parse/frontmatter",
				file: ".claude/skills/broken-yaml/SKILL.md",
				line: 3,
				col: 1,
				message:
					"Flow sequence in block collection must be sufficiently indented and end with a ]",
			},
			{
				ruleId: "skill/frontmatter-schema",
				file: ".claude/skills/empty-name/SKILL.md",
				line: 2,
				col: 7,
				message: 'Frontmatter key "name" must not be empty',
			},
			{
				ruleId: "skill/frontmatter-schema",
				file: ".claude/skills/missing-description/SKILL.md",
				line: 1,
				col: 1,
				message: 'Missing required frontmatter key "description"',
			},
			{
				ruleId: "skill/frontmatter-schema",
				file: ".claude/skills/no-frontmatter/SKILL.md",
				line: 1,
				col: 1,
				message: "Missing YAML frontmatter block",
			},
			{
				ruleId: "skill/frontmatter-schema",
				file: ".claude/skills/unknown-key/SKILL.md",
				line: 4,
				col: 1,
				message:
					'Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
			},
		]);

		// good-skill contributes nothing at all.
		expect(
			diagnostics.some((d) => d.file === ".claude/skills/good-skill/SKILL.md"),
		).toBe(false);
	});
});
