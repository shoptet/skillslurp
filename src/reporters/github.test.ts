import { expect, test } from "bun:test";
import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import { github, githubRules } from "./github.js";

/** Builds a `Diagnostic` with sensible defaults, overridable per test. */
function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		ruleId: "rule/a",
		severity: "error",
		message: "message",
		file: "file.md",
		fixable: false,
		docsUrl: "https://example.invalid/docs",
		...overrides,
	};
}

// -------------------------------------------------------------------------------------------
// One `error`, one `warn` — `::error` first, `::warning` second, engine order kept
// (this reporter never re-sorts; the engine already sorted).
// -------------------------------------------------------------------------------------------
test("one error and one warn emit ::error then ::warning, in the diagnostics' own order", () => {
	const out = github(
		[
			makeDiagnostic({ ruleId: "rule/a", severity: "error", message: "m1" }),
			makeDiagnostic({ ruleId: "rule/b", severity: "warn", message: "m2" }),
		],
		{ color: false },
	);

	const lines = out.split("\n");
	expect(lines[0]).toBe("::error file=file.md,title=rule/a::m1");
	expect(lines[1]).toBe("::warning file=file.md,title=rule/b::m2");
});

// -------------------------------------------------------------------------------------------
// Full position — file, line, endLine, col, endColumn, title, in that fixed order.
// -------------------------------------------------------------------------------------------
test("full position emits file, line, endLine, col, endColumn, title in that order", () => {
	const out = github(
		[
			makeDiagnostic({
				file: "a.md",
				line: 1,
				endLine: 2,
				col: 3,
				endCol: 4,
			}),
		],
		{ color: false },
	);

	expect(out).toContain(
		"::error file=a.md,line=1,endLine=2,col=3,endColumn=4,title=rule/a::message",
	);
});

// -------------------------------------------------------------------------------------------
// `line` only (no `col`, no `endLine`, no `endCol`) — the fields in between are
// skipped entirely rather than appearing empty.
// -------------------------------------------------------------------------------------------
test("line only skips endLine and col — no empty fields", () => {
	const out = github([makeDiagnostic({ file: "a.md", line: 5 })], {
		color: false,
	});

	expect(out).toContain("::error file=a.md,line=5,title=rule/a::message");
});

// -------------------------------------------------------------------------------------------
// No position at all — only file and title, never `line=0`/`col=0` invented for a
// position the diagnostic does not carry (`Loc` is 1-based; `0` is not a coordinate).
// -------------------------------------------------------------------------------------------
test("no position emits only file and title", () => {
	const out = github([makeDiagnostic({ file: "a.md" })], { color: false });

	expect(out).toContain("::error file=a.md,title=rule/a::message");
	expect(out).not.toContain("line=");
	expect(out).not.toContain("col=");
});

// -------------------------------------------------------------------------------------------
// The toolkit's own escapeData order — % first, then \r, then \n — pinned two ways:
// a real CRLF becomes %0D%0A (not the sanitizeControlChars \u{d}\u{a} form: escaping runs BEFORE
// sanitizing, see github.ts's own comment on `annotationLine`), and text that already reads
// "%0A" round-trips to "%250A" rather than being misread as an escape this function just
// produced (which is exactly what escaping % first, before \r/\n, guarantees).
// -------------------------------------------------------------------------------------------
test("message escaping order is %, then \\r, then \\n — pinned both ways", () => {
	const crlf = github([makeDiagnostic({ message: "50% done\r\nnext" })], {
		color: false,
	});
	expect(crlf).toContain("::50%25 done%0D%0Anext");

	const literalPercentZeroA = github(
		[makeDiagnostic({ message: "already %0A here" })],
		{ color: false },
	);
	expect(literalPercentZeroA).toContain("::already %250A here");
});

// -------------------------------------------------------------------------------------------
// `file` is a PROPERTY value, so `,` and `:` are escaped there (they are
// syntactically significant in `key=value,key=value`); the same characters inside `message`
// (the trailing `::message` half) are left alone — the toolkit only escapes those two for
// properties, never for the message/data half.
// -------------------------------------------------------------------------------------------
test("file (a property) escapes , and : ; message (data) leaves them alone", () => {
	const out = github(
		[makeDiagnostic({ file: "a,b:c.md", message: "m,with:chars" })],
		{ color: false },
	);

	expect(out).toContain("file=a%2Cb%3Ac.md");
	expect(out).toContain("::m,with:chars");
});

// -------------------------------------------------------------------------------------------
// An ESC byte is neither `%`, `\r` nor `\n`, so `escapeData` never touches it —
// `sanitizeControlChars` is what turns it into the same visible `\u{1b}` form `stylish` already
// uses for the identical input (reuse, not a second escaping scheme).
// -------------------------------------------------------------------------------------------
test("ESC in the message is sanitized into stylish's own \\u{hex} form", () => {
	const out = github([makeDiagnostic({ message: "foo\x1bbar" })], {
		color: false,
	});

	expect(out).toContain("::foo\\u{1b}bar");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the raw ESC byte is gone is the point.
	expect(out).not.toMatch(/\x1b/);
});

// -------------------------------------------------------------------------------------------
// `file` goes through `annotationProperties`, a separate call site from
// `message`'s `annotationLine` (github.ts:64 vs. :98) — the ESC coverage above does not exercise
// it. Pinned the same way as the message case, so dropping `file`'s own `sanitizeControlChars`
// wrap fails HERE rather than leaving every other test in this file green.
// -------------------------------------------------------------------------------------------
test("ESC in file (a property) is sanitized the same way as message", () => {
	const out = github([makeDiagnostic({ file: "a\x1bb.md" })], {
		color: false,
	});

	expect(out).toContain("file=a\\u{1b}b.md");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the raw ESC byte is gone is the point.
	expect(out).not.toMatch(/\x1b/);
});

// -------------------------------------------------------------------------------------------
// Zero diagnostics is the same "" every reporter answers a clean run with.
// -------------------------------------------------------------------------------------------
test("zero diagnostics is the empty string", () => {
	expect(github([], { color: false })).toBe("");
});

// -------------------------------------------------------------------------------------------
// The trailing summary line is plain (no color), counts total/errors/warnings, and
// is the LAST line — it survives even where GitHub caps the number of annotations actually
// rendered.
// -------------------------------------------------------------------------------------------
test("three diagnostics end with a plain summary line naming problems, errors and warnings", () => {
	const out = github(
		[
			makeDiagnostic({ severity: "error" }),
			makeDiagnostic({ severity: "error" }),
			makeDiagnostic({ severity: "warn" }),
		],
		{ color: true }, // color is ignored entirely, like the json reporter
	);

	const lines = out.split("\n");
	expect(lines.at(-2)).toBe("skillslurp: 3 problems (2 errors, 1 warning)");
	expect(out).not.toContain("\x1b[");
});

// -------------------------------------------------------------------------------------------
// Exactly one trailing newline (this reporter ends its own output, json-style;
// `terminate` in run.ts is untouched and only adds a newline for stylish).
// -------------------------------------------------------------------------------------------
test("output ends with exactly one trailing newline", () => {
	const out = github(
		[
			makeDiagnostic({ ruleId: "rule/a" }),
			makeDiagnostic({ ruleId: "rule/b" }),
		],
		{ color: false },
	);

	expect(out.endsWith("\n")).toBe(true);
	expect(out.endsWith("\n\n")).toBe(false);
});

// -------------------------------------------------------------------------------------------
// `--list-rules --reporter github`: the stylish listing, forced uncolored
// regardless of what the caller passes — the CLI's own TTY/NO_COLOR decision is for
// human-readable stylish output only, exactly like the json lister. Self-terminated with a
// trailing `\n` (see github.ts's own comment on `githubRules`): `run.ts`'s `terminate` only
// adds that newline for the reporter name "stylish", so the lister has to supply it itself to
// stay byte-identical to `--list-rules --reporter stylish`'s piped output (cli.test.ts).
// -------------------------------------------------------------------------------------------
test("githubRules reuses the stylish listing, uncolored, self-terminated, even when asked for color", () => {
	const rules: readonly Rule[] = [
		{
			kind: "file",
			meta: {
				id: "rule/a",
				description: "listing description",
				docsUrl: "https://example.invalid/docs",
				tiers: ["recommended"],
				defaultSeverity: "error",
				fixable: false,
			},
			check: () => [],
		},
	];

	const out = githubRules(rules, { color: true });

	expect(out).toBe(
		"rule/a  file  recommended  error  -  listing description  https://example.invalid/docs\n",
	);
	expect(out).not.toContain("\x1b[");
});
