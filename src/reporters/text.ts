/**
 * Escapes every Unicode control (`Cc`), format (`Cf`), line-separator (`Zl`) or
 * paragraph-separator (`Zp`) character into a visible `\u{hex}` form (e.g. ESC → `\u{1b}`).
 * `file` and `message` both ultimately come from the content of
 * linted files (frontmatter values, etc.) — untrusted text that must never reach a sink that
 * interprets raw control bytes: a crafted message containing a raw ANSI escape sequence (e.g.
 * `\x1b[2J\x1b[1;1H`) can repaint or clear a terminal, and an invisible/format character would
 * silently skew a column-padded reporter's own width math. This function is the only place raw
 * control/format characters are allowed to exist.
 *
 * Three callers. `stylish` (terminal output, where escaping happens before padding is computed
 * so it's the escaped, always-longer form that gets padded); `github` (GitHub Actions
 * workflow-command annotations, where the same untrusted text is embedded into a `::error ...::`
 * log line and escaped again — percent-encoded, per `github.ts` — on top of this); and
 * `formatError` in `run.ts`, which is not a reporter at all but the funnel every write to stderr
 * goes through, added after a committed baseline file was measured putting raw ANSI and forged
 * `::` lines into a terminal and a CI log through it.
 *
 * The json reporter does NOT call this — its escaping is `JSON.stringify`'s, which covers every
 * C0 control character, plus one addition for the two separators `JSON.stringify` leaves raw
 * (`serialize`, `json.ts`). Same coverage, reached a different way, because a `\u{1b}` rendering
 * inside a JSON string would be a lie about what the byte was.
 *
 * `Zl`/`Zp` — U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — are here because they
 * were measured passing through all three reporters raw: they are
 * neither `Cc` nor `Cf`, so the class above never matched them, yet they are invisible and they
 * feed the same column-width math this function exists to protect. They are not a
 * workflow-command injection (the GitHub runner splits log lines on `\n`), just the rest of the
 * invisible-character class the JSDoc above already claims to cover.
 */
export function sanitizeControlChars(s: string): string {
	return s.replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
		(ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`,
	);
}

// The Actions runner parses `::name` after leading whitespace and the legacy `##[name]` anywhere in a
// line: TryParseV2 and TryParse in https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Common/ActionCommand.cs
// (fetched 2026-11-06).
export function neutralizeLegacyCommands(s: string): string {
	return s.replaceAll("##[", "#\\u{23}[");
}

export function neutralizeWorkflowCommands(line: string): string {
	const start = line.length - line.trimStart().length;
	const head = line.startsWith("::", start)
		? `${line.slice(0, start)}\\u{3a}${line.slice(start + 1)}`
		: line;
	return neutralizeLegacyCommands(head);
}
