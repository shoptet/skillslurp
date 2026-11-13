import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../config.js";
import { DOCS_URL } from "../../diagnostic.js";
import { runEngine } from "../../engine.js";
import { computeExitCode } from "../../exit.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { builtinRules } from "../index.js";
import { fileMaxLines } from "./max-lines.js";

/**
 * Builds `n` distinct, single-line entries joined by `eol`, with a trailing `eol` only when
 * `trailing` is true. Kept tiny and content-agnostic on purpose — nothing about this rule reads
 * line CONTENT, only line COUNT, so every case below generates exactly the shape it needs rather
 * than pasting hundreds of lines into the file.
 */
function lines(n: number, eol: string, trailing: boolean): string {
	const rows = Array.from({ length: n }, (_, i) => `Line ${i + 1}.`);
	return rows.join(eol) + (trailing ? eol : "");
}

/** What the rule reports for `count` over `max` — the exact wording the rule emits, pinned. */
const overLimit = (count: number, max: number): string =>
	`File has ${count} lines, over the limit of ${max} (the whole file, frontmatter included)`;

// --- boundary: exactly `max` is clean, one line over reports, at `max + 1` col 1 ---

runRuleTests(fileMaxLines, {
	valid: [
		{
			name: "exactly max lines is clean under the default max: 500",
			files: { "widgets/SKILL.md": lines(500, "\n", true) },
		},
		{
			name: "exactly max lines is clean under a small configured max",
			options: { max: 7 },
			files: { "widgets/SKILL.md": lines(7, "\n", true) },
		},
		{
			// No trailing separator at all: the last element `split` produces is real content,
			// not a phantom line, so nothing is dropped and the count already equals `max`.
			name: "no trailing newline: the last line is content, and the count is clean at exactly max",
			options: { max: 5 },
			files: { "widgets/SKILL.md": lines(5, "\n", false) },
		},
		{
			// The trailing-newline twin of the case above: a SINGLE trailing separator produces
			// exactly one phantom empty element, which is dropped — so this is just as clean as
			// the no-trailing-newline file, not one line "longer".
			name: "a single trailing newline is not counted as a phantom extra line",
			options: { max: 5 },
			files: { "widgets/SKILL.md": lines(5, "\n", true) },
		},
		{
			// A pin on the drop rule at its degenerate boundary, not a special case: `"".split(
			// /\r?\n/)` yields `[""]` (length 1), and that lone empty element is dropped by the
			// exact same "trailing empty element is not a real line" rule that handles a real
			// file's trailing newline — countLines has no separate branch for this case.
			name: "an empty file is 0 lines and clean",
			files: { "widgets/SKILL.md": "" },
		},
	],
	invalid: [
		{
			name: "max + 1 lines is reported once, at line max + 1, col 1, severity warn",
			options: { max: 5 },
			files: { "widgets/SKILL.md": lines(6, "\n", true) },
			errors: [{ message: overLimit(6, 5), line: 6, col: 1, severity: "warn" }],
		},
		{
			// Pins what this case can actually prove: a CRLF file counts and reports
			// identically to its LF twin above. It does NOT prove `split(/\r?\n/)` treats
			// `\r\n` as one separator "because of" the `\r?` — for any input,
			// `split(/\r?\n/)` and `split("\n")` produce identical counts (verified: the
			// optional `\r` only ever extends a `\n` match backward, it can never let one
			// `\n` satisfy two matches or leave one unmatched), so no count assertion can
			// attribute the behavior to the `\r?`. What this DOES catch is the mutation to
			// `split(/\r|\n/)`, which treats a bare `\r` as its own separator: under that
			// mutation this case reports 12 lines, not 6.
			name: "CRLF line endings count the same as LF, and report the same line",
			options: { max: 5 },
			files: { "widgets/SKILL.md": lines(6, "\r\n", true) },
			errors: [{ message: overLimit(6, 5), line: 6, col: 1, severity: "warn" }],
		},
		{
			// Two trailing newlines leave one real blank line behind after the single phantom
			// element is dropped — proving the blank line itself is counted, not discarded along
			// with the phantom. 4 content lines + 1 trailing blank line = 5, one over max: 4.
			name: "a file ending in two newlines counts the blank line as its own line",
			options: { max: 4 },
			files: { "widgets/SKILL.md": `${lines(4, "\n", false)}\n\n` },
			errors: [{ message: overLimit(5, 4), line: 5, col: 1, severity: "warn" }],
		},
		{
			// Frontmatter fences count like any other line: the whole-file guidance this rule
			// encodes is about what an agent has to load, and frontmatter costs exactly as much
			// to load as body. No body at all here — 5 lines, all of them frontmatter.
			name: "a frontmatter-only file (no body) is counted, fences included",
			options: { max: 3 },
			files: {
				"widgets/SKILL.md":
					"---\ndescription: A skill with no body at all.\nkey2: value\nkey3: value\n---",
			},
			errors: [{ message: overLimit(5, 3), line: 4, col: 1, severity: "warn" }],
		},
		{
			// A second case where count exceeds max by more than one, deliberately over a
			// plain body rather than frontmatter: exists so the reported `line` (max + 1 = 4)
			// cannot silently collapse into `count` (6) and still pass by coincidence — the
			// frontmatter-only case above is currently the ONLY other invalid case where the
			// two spellings disagree, and one case alone left the `line: max + 1` -> `line:
			// count` mutation undetected everywhere except that single fixture shape.
			name: "count exceeding max by more than one still reports at line max + 1, not at count",
			options: { max: 3 },
			files: { "widgets/SKILL.md": lines(6, "\n", true) },
			errors: [{ message: overLimit(6, 3), line: 4, col: 1, severity: "warn" }],
		},
		{
			// The field-default trap: a rule enabled with NO options block at all is parsed as
			// `{}`, and only a FIELD-level `.default(500)` makes that resolve to the documented
			// default. A schema-level `.default({max:500})` would never fire here, since `{}` is
			// not `undefined`.
			name: "the default max: 500 applies with no options block at all",
			files: { "widgets/SKILL.md": lines(501, "\n", true) },
			errors: [
				{ message: overLimit(501, 500), line: 501, col: 1, severity: "warn" },
			],
		},
	],
});

// --- the "no scope gate" claim, proved: this rule reports on a surface that is not `skills` ---

// The rule's JSDoc says it runs on every document any surface discovers, whatever kind. A `valid`
// case on a non-skills surface cannot prove that — it looks identical whether the rule ran and
// found nothing or never ran at all. These two are `invalid`, so they fail the moment the rule
// stops running: adding `if (doc.surface.kind !== "skills") return [];` to the top of `check`
// turns both red. Before they existed, that mutation left the whole suite green.
runRuleTests(fileMaxLines, {
	valid: [],
	invalid: [
		{
			name: "rules kind + cursor: an over-long .mdc is the same context-bloat defect and is reported",
			surface: { kind: "rules", dialects: ["cursor"] },
			options: { max: 7 },
			files: { "style.mdc": lines(8, "\n", true) },
			errors: [{ message: overLimit(8, 7), line: 8, col: 1 }],
		},
		{
			name: "instructions kind + copilot: an over-long .instructions.md is reported too",
			surface: { kind: "instructions", dialects: ["copilot"] },
			options: { max: 7 },
			files: { "ts.instructions.md": lines(8, "\n", true) },
			errors: [{ message: overLimit(8, 7), line: 8, col: 1 }],
		},
	],
});

// --- the required-shape option mistakes: positioned config errors, not silent behavior ---

/** Writes `content` as `skillslurp.json` into a fresh temp dir, then cleans it up. */
async function withConfig<T>(
	content: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-max-lines-"));
	try {
		await writeFile(join(dir, "skillslurp.json"), content, "utf8");
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function catchConfigError(
	content: string,
): Promise<ConfigError["problems"]> {
	return await withConfig(content, async (dir) => {
		try {
			await loadConfig(dir, [fileMaxLines]);
		} catch (err) {
			if (err instanceof ConfigError) {
				return err.problems;
			}
			throw err;
		}
		throw new Error("expected loadConfig to reject with a ConfigError");
	});
}

test("options: { max: 0 } is rejected by min(1), positioned at the value", async () => {
	const problems = await catchConfigError(
		'{"surfaces":[{"root":".claude/skills"}],"rules":{"file/max-lines":{"options":{"max":0}}}}\n',
	);

	expect(problems).toEqual([
		{
			message:
				'rule "file/max-lines" options.max: Too small: expected number to be >=1',
			loc: { line: 1, col: 85, endLine: 1, endCol: 86 },
		},
	]);
});

test("a non-integer max is rejected by int(), positioned at the value", async () => {
	const problems = await catchConfigError(
		'{"surfaces":[{"root":".claude/skills"}],"rules":{"file/max-lines":{"options":{"max":1.5}}}}\n',
	);

	expect(problems).toEqual([
		{
			message:
				'rule "file/max-lines" options.max: Invalid input: expected int, received number',
			loc: { line: 1, col: 85, endLine: 1, endCol: 88 },
		},
	]);
});

// --- a real run, through the registry, produces exactly one warn diagnostic, exit 0 ---

test("a real run over a temp dir with one over-long file produces exactly one warn diagnostic and computeExitCode is 0", async () => {
	await withConfig(
		'{"surfaces":[{"root":".claude/skills"}]}\n',
		async (dir) => {
			await mkdir(join(dir, ".claude", "skills", "widgets"), {
				recursive: true,
			});
			// Clean per every OTHER recommended-tier rule: `name` matches the directory, both
			// required generic keys are present, nothing unrecognized — the only thing left for
			// `extends: [recommended]`'s default run to flag is the line count itself.
			const front =
				"---\nname: widgets\ndescription: A widget skill fixture used to prove file/max-lines fires exactly once end to end.\n---\n";
			const body = `${lines(497, "\n", false)}\n`;
			await writeFile(
				join(dir, ".claude", "skills", "widgets", "SKILL.md"),
				front + body,
				"utf8",
			);
			// This runs the WHOLE `recommended` tier, which includes a `project` rule
			// (`refs/no-unreachable-files`) that asks `ctx.git.trackedFiles()` for any surface with an
			// item directory — so the tier now needs a checkout unconditionally. Git-init'ing is
			// the fix that keeps this test's point intact: narrowing `extends` would turn "the whole
			// default tier flags exactly one thing here" into a much weaker claim about one rule.
			// `widgets/` holds nothing but its entry document, so the new rule stays silent.
			await gitInitAndCommit(dir);

			const config = await loadConfig(dir, builtinRules);
			const { diagnostics } = await runEngine(config, builtinRules);

			expect(diagnostics).toEqual([
				{
					ruleId: "file/max-lines",
					severity: "warn",
					message: overLimit(501, 500),
					file: ".claude/skills/widgets/SKILL.md",
					line: 501,
					col: 1,
					fixable: false,
					docsUrl: DOCS_URL,
				},
			]);
			expect(computeExitCode(diagnostics)).toBe(0);
		},
	);
});
