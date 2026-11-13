import { expect, test } from "bun:test";
import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import { stylish, stylishRules } from "./stylish.js";

/** Builds a `Diagnostic` with sensible defaults, overridable per test. */
function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		ruleId: "rule/id",
		severity: "error",
		message: "message",
		file: "file.md",
		fixable: false,
		docsUrl: "https://example.invalid/docs",
		...overrides,
	};
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC control char is exactly what an ANSI escape code starts with — that's the thing being stripped.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Two files, mixed severities, one diagnostic without line/col (b.md), and deliberately
// varying position/severity/message widths within a.md's block to prove per-block alignment:
// "1:1" (3 chars) vs "22:3" (4 chars), "error" (5) vs "warn" (4), "short" (5) vs a 27-char
// message.
const FIXTURE: Diagnostic[] = [
	makeDiagnostic({
		ruleId: "rule/a",
		severity: "error",
		message: "short",
		file: "a.md",
		line: 1,
		col: 1,
	}),
	makeDiagnostic({
		ruleId: "rule/bb",
		severity: "warn",
		message: "a much longer message here",
		file: "a.md",
		line: 22,
		col: 3,
		fixable: true,
	}),
	makeDiagnostic({
		ruleId: "rule/c",
		severity: "error",
		message: "mid message",
		file: "b.md",
		// No line/col at all — the shape a `ConfigError` with no positioned problems produces
		// (run.ts's `configErrorDiagnostics`). The position cell is EMPTY, never `0:0`: `Loc` is
		// 1-based, so zero is not a coordinate a diagnostic can carry, and inventing one sends an
		// editor jumping at a spot that does not exist. Same answer the json reporter has always
		// given by omitting the keys.
	}),
];

const FIXTURE_PLAIN =
	"a.md\n" +
	"  1:1   error  short                       rule/a\n" +
	"  22:3  warn   a much longer message here  rule/bb\n" +
	"\n" +
	"b.md\n" +
	"    error  mid message  rule/c\n" +
	"\n" +
	"✖ 3 problems (2 errors, 1 warning)";

test("stylish renders a pinned, aligned, multi-file output with color: false", () => {
	expect(stylish(FIXTURE, { color: false })).toBe(FIXTURE_PLAIN);
});

test("a position-less diagnostic renders an empty position cell, never the 1-based-impossible 0:0", () => {
	const out = stylish([makeDiagnostic({ ruleId: "config/invalid" })], {
		color: false,
	});

	expect(out).toBe(
		"file.md\n    error  message  config/invalid\n\n✖ 1 problem (1 error, 0 warnings)",
	);
	expect(out).not.toContain("0:0");
});

test("a position-less row keeps the block's columns aligned with the positioned rows beside it", () => {
	// The mixed block is the case an empty cell has to survive: `posWidth` comes from "22:3", so
	// the loc-less row pads to the same four columns and every later column still starts at the
	// same offset. Rendering nothing at all for that cell instead would shift the whole row left.
	const out = stylish(
		[
			makeDiagnostic({
				ruleId: "rule/a",
				message: "positioned",
				line: 22,
				col: 3,
			}),
			makeDiagnostic({ ruleId: "config/invalid", message: "no position" }),
		],
		{ color: false },
	);

	expect(out).toBe(
		"file.md\n" +
			"  22:3  error  positioned   rule/a\n" +
			"        error  no position  config/invalid\n" +
			"\n" +
			"✖ 2 problems (2 errors, 0 warnings)",
	);
});

test("a line with no col renders the bare line number rather than inventing col 0", () => {
	const out = stylish([makeDiagnostic({ ruleId: "rule/a", line: 12 })], {
		color: false,
	});

	expect(out).toContain("  12  error  message  rule/a");
	expect(out).not.toContain("12:0");
});

test("stylish output (color: false) has no trailing whitespace on any line", () => {
	const out = stylish(FIXTURE, { color: false });
	for (const line of out.split("\n")) {
		expect(line).toBe(line.trimEnd());
	}
});

test("stylish with color: true emits ANSI escape codes for severity and file path, and stripping them yields exactly the color: false output", () => {
	const colored = stylish(FIXTURE, { color: true });

	// severity: red "error", yellow "warn"
	expect(colored).toContain("\x1b[31merror\x1b[39m");
	expect(colored).toContain("\x1b[33mwarn\x1b[39m");
	// file path: underlined
	expect(colored).toContain("\x1b[4ma.md\x1b[24m");
	expect(colored).toContain("\x1b[4mb.md\x1b[24m");

	expect(stripAnsi(colored)).toBe(FIXTURE_PLAIN);
});

test("stylish colors the summary red when any error is present", () => {
	const colored = stylish(FIXTURE, { color: true });
	expect(colored).toContain(
		"\x1b[31m✖ 3 problems (2 errors, 1 warning)\x1b[39m",
	);
});

test("stylish colors the summary yellow when there are only warnings", () => {
	const warnOnly = [
		makeDiagnostic({
			ruleId: "rule/w",
			severity: "warn",
			message: "just a warning",
			file: "w.md",
			line: 1,
			col: 1,
		}),
	];

	expect(stylish(warnOnly, { color: false })).toBe(
		"w.md\n  1:1  warn  just a warning  rule/w\n\n✖ 1 problem (0 errors, 1 warning)",
	);
	expect(stylish(warnOnly, { color: true })).toContain(
		"\x1b[33m✖ 1 problem (0 errors, 1 warning)\x1b[39m",
	);
});

test("zero diagnostics renders as an empty string, regardless of color", () => {
	expect(stylish([], { color: false })).toBe("");
	expect(stylish([], { color: true })).toBe("");
});

// Pins the expected e2e sample for the skills-repo unknown-key fixture: a single unknown-key
// violation, including the exact column and the full, alphabetically-sorted allowed-keys message
// that `skill/frontmatter-schema` emits.
test("pins the expected e2e sample for the skills-repo unknown-key fixture", () => {
	const diagnostics = [
		makeDiagnostic({
			ruleId: "skill/frontmatter-schema",
			severity: "error",
			message:
				'Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)',
			file: ".claude/skills/unknown-key/SKILL.md",
			line: 4,
			col: 1,
		}),
	];

	expect(stylish(diagnostics, { color: false })).toBe(
		".claude/skills/unknown-key/SKILL.md\n" +
			'  4:1  error  Unexpected frontmatter key "tools" (allowed: allowed-tools, compatibility, description, license, metadata, name)  skill/frontmatter-schema\n' +
			"\n" +
			"✖ 1 problem (1 error, 0 warnings)",
	);
});

// A crafted control-character payload — which clears the terminal screen
// (`\x1b[2J\x1b[1;1H`) when rendered verbatim — must be escaped into a visible
// `\u{hex}` form in both `file` and `message`, and must not desync the column alignment of a
// later row in the same block (padding is computed on the escaped, always-longer text).
test("a control-character payload in file and message is escaped to a visible form, never reaches the terminal raw, and keeps later rows aligned", () => {
	const screenClear = "\x1b[2J\x1b[1;1H";
	const diagnostics = [
		makeDiagnostic({
			ruleId: "rule/a",
			severity: "error",
			message: `evil${screenClear}message`,
			file: `evil${screenClear}.md`,
			line: 1,
			col: 1,
		}),
		makeDiagnostic({
			ruleId: "rule/b",
			severity: "warn",
			message: "next row",
			file: `evil${screenClear}.md`,
			line: 2,
			col: 1,
		}),
	];

	const out = stylish(diagnostics, { color: false });

	expect(out.includes("\x1b")).toBe(false);
	expect(out).toContain("\\u{1b}");

	for (const line of out.split("\n")) {
		expect(line).toBe(line.trimEnd());
	}

	const lines = out.split("\n");
	const row1 = lines[1];
	const row2 = lines[2];
	if (!row1 || !row2) throw new Error("expected two diagnostic rows");
	// Same file block (grouping happens on the raw, unescaped file value) → same
	// messageWidth → both rule ids must start at the same column.
	expect(row1.indexOf("rule/a")).toBe(row2.indexOf("rule/b"));
});

test("a file name shaped like a GitHub workflow command never starts a stylish line with ::", () => {
	const cases: [file: string, header: string][] = [
		["::warning title=x::y.md", "\\u{3a}:warning title=x::y.md"],
		["  ::error::y.md", "  \\u{3a}:error::y.md"],
		["\u3000::notice::y.md", "\u3000\\u{3a}:notice::y.md"],
	];
	for (const [file, header] of cases) {
		const out = stylish([makeDiagnostic({ file, message: "::error::m" })], {
			color: false,
		});
		const lines = out.split("\n");
		expect(lines[0]).toBe(header);
		for (const line of lines) {
			expect(line.trimStart().startsWith("::")).toBe(false);
		}
	}
});

test("a legacy ##[ command in a file name or message never reaches a stylish line raw", () => {
	const out = stylish(
		[
			makeDiagnostic({
				file: "a ##[warning]f.md",
				message: "m ##[error]x",
				line: 1,
				col: 1,
			}),
			makeDiagnostic({
				file: "a ##[warning]f.md",
				message: "plain",
				line: 2,
				col: 1,
			}),
		],
		{ color: false },
	);
	expect(out).not.toContain("##[");
	const [header, row1, row2] = out.split("\n");
	expect(header).toBe("a #\\u{23}[warning]f.md");
	if (!row1 || !row2) throw new Error("expected two diagnostic rows");
	expect(row1.indexOf("rule/id")).toBe(row2.indexOf("rule/id"));
});

test("a :: that does not open the file name is left alone", () => {
	for (const file of ["a::b.md", ":x.md", "\u0007::x.md"]) {
		const out = stylish([makeDiagnostic({ file })], { color: false });
		expect(out.split("\n")[0]).toBe(file.replace("\u0007", "\\u{7}"));
	}
});

test("endLine/endCol are not rendered: a diagnostic with them produces output identical to one without", () => {
	const withoutEnd = [
		makeDiagnostic({
			ruleId: "rule/e",
			severity: "error",
			message: "same message",
			file: "e.md",
			line: 3,
			col: 2,
		}),
	];
	const withEnd = [
		makeDiagnostic({
			ruleId: "rule/e",
			severity: "error",
			message: "same message",
			file: "e.md",
			line: 3,
			col: 2,
			endLine: 3,
			endCol: 20,
		}),
	];

	expect(stylish(withEnd, { color: false })).toBe(
		stylish(withoutEnd, { color: false }),
	);
});

// ---------------------------------------------------------------------------------------------
// `stylishRules` — the `--list-rules` renderer.
// ---------------------------------------------------------------------------------------------

/**
 * Synthetic rules, deliberately NOT `builtinRules`: this block pins the listing FORMAT, and a
 * format pinned against the real registry would have to be rewritten every time a rule is added
 * or a description reworded — the exact coupling to avoid. That every REGISTERED
 * rule reaches both listers is asserted in run.test.ts and cli.test.ts, where the count is
 * derived from `builtinRules` rather than typed out.
 *
 * The three cover the branches the renderer has: a fixable `warn` rule in two tiers; a rule in no
 * tier and not fixable, so the two `-` cells land side by side; and a rule whose id is the longest
 * while sitting LAST, so the id column's width demonstrably comes from a row other than the first.
 * Their kinds differ too (`file`/`project`/`scan`), which is what makes the `kind` column visibly
 * carry information rather than repeating one word.
 */
const RULE_FIXTURE: readonly Rule[] = [
	{
		kind: "file",
		meta: {
			id: "a/short",
			description: "short",
			docsUrl: "https://example.invalid/a",
			tiers: ["recommended", "strict"],
			defaultSeverity: "warn",
			fixable: true,
		},
		check: () => [],
	},
	{
		kind: "project",
		meta: {
			id: "b/medium-id",
			description: "a much longer description",
			docsUrl: "https://example.invalid/b",
			tiers: [],
			defaultSeverity: "error",
			fixable: false,
		},
		check: () => [],
	},
	{
		kind: "scan",
		meta: {
			id: "c/the-longest-rule-id",
			description: "mid",
			docsUrl: "https://example.invalid/c",
			tiers: ["strict"],
			defaultSeverity: "error",
			fixable: false,
		},
		check: () => [],
	},
];

// Pinned byte-for-byte, and verified against an independent recomputation of the column widths
// from RULE_FIXTURE alone (21, 7, 18, 5, 7, 25) rather than only against the renderer's own
// output — the "a test that passed for the wrong reason" habit in CLAUDE.md.
const EXPECTED_RULE_LISTING = [
	"a/short                file     recommended,strict  warn   fixable  short                      https://example.invalid/a",
	"b/medium-id            project  -                   error  -        a much longer description  https://example.invalid/b",
	"c/the-longest-rule-id  scan     strict              error  -        mid                        https://example.invalid/c",
].join("\n");

test("stylishRules: one line per rule, seven columns in the pinned field order", () => {
	const out = stylishRules(RULE_FIXTURE, { color: false });

	expect(out).toBe(EXPECTED_RULE_LISTING);
	// No trailing newline of its own — `terminate` (run.ts) supplies it, exactly as for `stylish`.
	expect(out.endsWith("\n")).toBe(false);
	expect(out.split("\n")).toHaveLength(RULE_FIXTURE.length);
});

/**
 * The alignment claim, computed from the output rather than restated from the pin above: if any
 * column's width came from that column's own row instead of the widest row, these indices would
 * disagree. This is the assertion that would fail if `pad` were dropped from a single column, and
 * the id/description columns are the two whose widths come from a row that is not the first.
 */
test("stylishRules: every column starts at the same index on every line", () => {
	const lines = stylishRules(RULE_FIXTURE, { color: false }).split("\n");

	for (const marker of ["  file", "  project", "  scan"]) {
		// kind column: each line's kind sits at the same offset, past the widest id.
		const owner = lines.find((l) => l.includes(marker));
		expect(owner?.indexOf(marker)).toBe(21);
	}
	expect(lines.map((l) => l.indexOf("https://example.invalid/"))).toEqual([
		95, 95, 95,
	]);
});

/**
 * `defaultSeverity` borrows the diagnostic reporter's own red/yellow vocabulary, and `docsUrl`
 * the dim of a trailing column. The load-bearing half is the second assertion: color is wrapped
 * around already-padded text, so stripping the escapes reproduces the uncolored output byte for
 * byte — an implementation that padded after coloring would count the escape bytes as width and
 * fail here.
 */
test("stylishRules: color wraps cells without disturbing the padding", () => {
	const colored = stylishRules(RULE_FIXTURE, { color: true });

	expect(colored).toContain("\x1b[");
	expect(stripAnsi(colored)).toBe(EXPECTED_RULE_LISTING);
});

/**
 * Empty in, empty out — the same contract `stylish` keeps for zero diagnostics, and it matters
 * for the same reason: `terminate` (run.ts) appends its newline only to a non-empty body, so this
 * is what keeps an empty listing from printing a lone blank line.
 *
 * What it actually catches, measured rather than assumed: any fixed line the renderer might grow
 * — a column header, a `(no rules)` placeholder, a trailing count. A naive `Math.max(...rows.map(
 * ...))` width computation is NOT among them, which was the guess this comment made first: the
 * widths are never read when there are no rows to render, so `-Infinity` never reaches `repeat`
 * and the empty case stays `""` either way.
 */
test("stylishRules: an empty rule list renders as the empty string", () => {
	expect(stylishRules([], { color: false })).toBe("");
});
