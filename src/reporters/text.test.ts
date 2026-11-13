import { expect, test } from "bun:test";
import {
	neutralizeLegacyCommands,
	neutralizeWorkflowCommands,
	sanitizeControlChars,
} from "./text.js";

const ESC = String.fromCodePoint(0x1b);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

// The `Cc`/`Cf` half, pinned here rather than only through a reporter, so the class itself has a
// test that names what it covers.
test("sanitizeControlChars: Cc and Cf characters become a visible \\u{hex} form", () => {
	expect(sanitizeControlChars(`a${ESC}b`)).toBe("a\\u{1b}b");
	expect(sanitizeControlChars(`a${ZERO_WIDTH_SPACE}b`)).toBe("a\\u{200b}b");
	expect(sanitizeControlChars("plain text")).toBe("plain text");
});

// U+2028/U+2029 reached all three reporters raw:
// they are Zl and Zp, so the original `[\p{Cc}\p{Cf}]` class never matched them even though the
// JSDoc claimed to cover invisible characters that skew a column-padded reporter's width math.
// Mutation check: narrow the class back to `[\p{Cc}\p{Cf}]` and this test fails on both.
test("sanitizeControlChars: the Zl and Zp separators are escaped too", () => {
	expect(sanitizeControlChars(`a${LINE_SEPARATOR}b`)).toBe("a\\u{2028}b");
	expect(sanitizeControlChars(`a${PARAGRAPH_SEPARATOR}b`)).toBe("a\\u{2029}b");
});

// A sanitized string must have nothing left for a second pass to find — the property that lets
// `github.ts` percent-escape first and sanitize second without either step reopening the other.
test("sanitizeControlChars: the result contains no character the class still matches", () => {
	const hostile = `${ESC}[2J${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}${ZERO_WIDTH_SPACE}x`;
	const once = sanitizeControlChars(hostile);
	expect(sanitizeControlChars(once)).toBe(once);
	expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(once)).toBe(false);
});

test("neutralizeLegacyCommands: every ##[ becomes #\\u{23}[, wherever it sits in the line", () => {
	expect(neutralizeLegacyCommands("##[warning]x")).toBe("#\\u{23}[warning]x");
	expect(neutralizeLegacyCommands("a ##[error]b ##[debug]c")).toBe(
		"a #\\u{23}[error]b #\\u{23}[debug]c",
	);
	expect(neutralizeLegacyCommands("###[x")).not.toContain("##[");
	expect(neutralizeLegacyCommands("#[x] ## [y]")).toBe("#[x] ## [y]");
});

test("neutralizeWorkflowCommands: a line opening with ::, after any leading whitespace, no longer does", () => {
	expect(neutralizeWorkflowCommands("::warning::x")).toBe("\\u{3a}:warning::x");
	expect(neutralizeWorkflowCommands("  ::error::x")).toBe("  \\u{3a}:error::x");
	expect(neutralizeWorkflowCommands("\u3000::notice::x")).toBe(
		"\u3000\\u{3a}:notice::x",
	);
	expect(neutralizeWorkflowCommands("a::b")).toBe("a::b");
	expect(neutralizeWorkflowCommands(":x")).toBe(":x");
	expect(neutralizeWorkflowCommands("::x ##[y]")).toBe("\\u{3a}:x #\\u{23}[y]");
});
