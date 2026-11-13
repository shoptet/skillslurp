import type { Diagnostic } from "../diagnostic.js";
import { stylishRules } from "./stylish.js";
import { sanitizeControlChars } from "./text.js";
import type { Reporter, RuleLister } from "./types.js";

/** `Diagnostic.severity` → the GitHub Actions workflow-command name. */
const LEVEL: Readonly<Record<Diagnostic["severity"], string>> = Object.freeze({
	error: "error",
	warn: "warning",
});

/**
 * Percent-encodes the characters GitHub's own runner un-escapes when it parses a `::name
 * key=value,...::message` workflow command out of a line of log output — `%` first (so a
 * literal `%0A` etc. already present in the input round-trips as `%250A` rather than being
 * misread as an escape this function itself just produced), then the two line-ending bytes
 * that would otherwise split one command across multiple log lines.
 *
 * Ported from `escapeData` in `actions/toolkit`, `packages/core/src/command.ts`
 * (<https://github.com/actions/toolkit>), commit `ed3ea3b5ba8cf9cc0232e157f2080a9864305bd5`
 * (fetched 2026-09-06) — the runner-side truth, since docs.github.com's workflow-commands page
 * no longer states any escaping rules at all (verified on the same date: the page's parameter
 * tables and syntax block say nothing about encoding). `skill-check`'s own `github` formatter
 * (prior art, same fetch date) escapes nothing, which is a negative example, not a second
 * source.
 */
function escapeData(s: string): string {
	return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * `escapeData` plus `:` → `%3A` and `,` → `%2C`, in that order after the three `escapeData`
 * replacements — the toolkit's own `escapeProperty` (same file, same commit, immediately below
 * `escapeData`) applies these two on top for `key=value` PROPERTY values specifically, because
 * `:` and `,` are syntactically significant there (`key=value,key=value`) in a way they are not
 * inside the trailing `::message` half of the command.
 */
function escapeProperty(s: string): string {
	return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * One annotation's `key=value` properties, in the fixed order: `file`, `line`,
 * `endLine`, `col`, `endColumn`, `title`. `file` and `title` (`ruleId`) are always present;
 * the four position fields are each emitted independently and ONLY when the diagnostic actually
 * carries them — never as `line=0`, which the toolkit's own `if (val)` guard would drop anyway
 * (`0` is falsy) and which is not a coordinate a 1-based `Loc` can ever produce regardless
 * (see `diagnostic.ts`'s `Loc`). `line`/`endLine`/`col`/`endColumn` are always plain decimal
 * digits (`Diagnostic`'s type is `number`), so they need neither `escapeProperty` nor
 * `sanitizeControlChars`. `file` is the only field carrying arbitrary text and is the only one
 * sanitized: `title` is the rule id, which cannot hold a control byte because every id is
 * charset-validated at registry validation (`RULE_ID_PATTERN`, config.ts) and the `config/`
 * half is separately constrained (`CONFIG_PROBLEM_PATTERN`, engine.ts). It still goes through
 * `escapeProperty`, because `/` is not the concern there — a future id shape might carry a
 * `:` or a `,`, which are what break the `key=value,key=value` grammar.
 *
 * `escapeProperty` runs BEFORE `sanitizeControlChars` on `file` — the reverse of the order that
 * reads most natural, and deliberately so: see `annotationLine`'s own comment for why (the two
 * functions' domains overlap on `\r`/`\n`, and only this order gives the byte-exact `%0D`/`%0A`
 * the vendor source promises for those two bytes specifically).
 */
function annotationProperties(d: Diagnostic): string {
	const parts: string[] = [
		`file=${sanitizeControlChars(escapeProperty(d.file))}`,
	];
	if (d.line !== undefined) {
		parts.push(`line=${String(d.line)}`);
	}
	if (d.endLine !== undefined) {
		parts.push(`endLine=${String(d.endLine)}`);
	}
	if (d.col !== undefined) {
		parts.push(`col=${String(d.col)}`);
	}
	if (d.endCol !== undefined) {
		parts.push(`endColumn=${String(d.endCol)}`);
	}
	parts.push(`title=${escapeProperty(d.ruleId)}`);
	return parts.join(",");
}

/**
 * One `::error ...::message` / `::warning ...::message` line for one diagnostic.
 *
 * `escapeData` runs on the RAW message first, and `sanitizeControlChars` on its result second —
 * not the other way around. `sanitizeControlChars`'s own `\p{Cc}` match (`text.ts`) already
 * covers every C0 control byte, which includes `\r` (U+000D) and `\n` (U+000A) themselves: if it
 * ran first, an actual carriage-return/linefeed pair would already have become the literal text
 * `\u{d}\u{a}` before `escapeData` ever saw a `\r` or `\n` byte to replace, and the line would
 * read `...done\u{d}\u{a}next` instead of the toolkit's own `...done%0D%0Anext`. Running
 * `escapeData` first lets its `\r`→`%0D`/`\n`→`%0A` rule fire on the real bytes exactly as
 * `command.ts` does it; `sanitizeControlChars` afterward still catches every OTHER control/format
 * byte `escapeData` never touches (ESC, NUL, ...), so nothing reaches the log line unescaped
 * either way — the two functions' domains only genuinely overlap on `\r`/`\n`, so this ordering
 * question does not arise for `sanitizeControlChars`'s other targets.
 */
function annotationLine(d: Diagnostic): string {
	const message = sanitizeControlChars(escapeData(d.message));
	return `::${LEVEL[d.severity]} ${annotationProperties(d)}::${message}`;
}

/** Naive pluralization by count: `1 problem`, `2 problems`, `0 warnings`. */
function pluralize(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * GitHub Actions reporter: one workflow-command annotation line per diagnostic
 * (<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands>,
 * fetched 2026-09-06 — syntax `::error file={name},line={line},endLine={endLine},col={col},
 * endColumn={endColumn},title={title}::{message}`, same shape for `warning`/`notice`), then one
 * plain (uncolored) summary line, so the count survives even where GitHub caps the annotations
 * actually rendered (see below). Zero diagnostics → `""`, matching every other reporter's
 * clean-run answer.
 *
 * Position base: `line`/`col` are documented as "starting at 1" on the page above — the same
 * 1-based convention `Loc` already uses (`diagnostic.ts`), so no conversion happens here.
 * `endLine`/`endColumn` carry NO stated base on that page at all (verified same fetch date: the
 * parameter table gives them only "End line/column number", no starting value) — they are
 * passed through exactly as skillslurp holds them (`Diagnostic.endLine`/`endCol`, themselves
 * 1-based by this project's own `Loc` convention), without inventing a GitHub-side guarantee no
 * vendor source states.
 *
 * Annotation limits — "10 warning annotations, 10 error annotations, and 10 notice annotations
 * per step" and "50 annotations per job (sum of annotations from all the steps)" — are stated
 * only in `actions/toolkit`'s `docs/problem-matchers.md`
 * (<https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md>, commit
 * `f0b00fd201c7ddf14e1572a10d5fb4577c4bd6a2`, fetched 2026-09-06), NOT on docs.github.com. That
 * same page's own documented mitigation is "consider filtering of the log messages ... (e.g. by
 * PR touched files, lines, or other)" — this project's `--diff-base <ref>` is exactly
 * that filter.
 *
 * `file` is emitted as-is (repo-relative posix, `Diagnostic.file`'s own contract) — correct when
 * the linted root is the workflow's checkout root, and not otherwise.
 */
export const github: Reporter = (diagnostics, _options) => {
	if (diagnostics.length === 0) {
		return "";
	}

	const lines = diagnostics.map(annotationLine);

	let errors = 0;
	let warnings = 0;
	for (const d of diagnostics) {
		if (d.severity === "error") {
			errors++;
		} else {
			warnings++;
		}
	}
	const summary = `skillslurp: ${pluralize(diagnostics.length, "problem")} (${pluralize(errors, "error")}, ${pluralize(warnings, "warning")})`;

	return `${[...lines, summary].join("\n")}\n`;
};

/**
 * `--list-rules --reporter github`: the same listing `stylish` produces, uncolored — a rule
 * listing is not a set of annotations (there is nothing here for the runner to parse as a
 * workflow command), so there is no github-specific rendering to invent; only the CLI's own
 * TTY/`NO_COLOR` decision needs to be overridden, the same way the `json` lister already ignores
 * it.
 *
 * Self-terminates with a trailing `\n`, exactly matching `run.ts`'s `terminate(reporter, body)`
 * for `reporter === "stylish"` (`body.length > 0 ? \`${body}\n\` : body`) — NOT the shorter
 * `stylishRules(rules, { color: false })`, because `terminate` only
 * adds that newline for the literal string `"stylish"`; for every other reporter name (`github`
 * included) it returns the lister's own output untouched. Without this, `--list-rules --reporter
 * github` would come back one byte short of `--list-rules --reporter stylish`'s piped output —
 * measured directly (`diff` reports "No newline at end of file" on the `github` side only) — and
 * the byte-identity would fail.
 */
export const githubRules: RuleLister = (rules) => {
	const body = stylishRules(rules, { color: false });
	return body.length > 0 ? `${body}\n` : body;
};
