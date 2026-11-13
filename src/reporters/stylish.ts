import * as picocolors from "picocolors";
import type { Diagnostic, Severity } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import {
	neutralizeLegacyCommands,
	neutralizeWorkflowCommands,
	sanitizeControlChars,
} from "./text.js";
import type { Reporter, RuleLister } from "./types.js";

type Colors = ReturnType<typeof picocolors.createColors>;

interface Row {
	pos: string;
	severity: Diagnostic["severity"];
	message: string;
	ruleId: string;
}

/** Naive pluralization by count: `1 problem`, `2 problems`, `0 warnings`. */
function pluralize(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The position cell for one row. `Loc` is 1-based (diagnostic.ts), so `0` is not a coordinate any
 * diagnostic can legitimately carry — rendering `0:0` for one that has no position invented a
 * spot no editor can jump to and no `Loc` could ever have produced. The json reporter has always
 * answered this by omitting an absent position rather than filling it in (`locFields`, plus
 * `serializeDiagnostic`'s own-key discipline); this is the same answer in a fixed-width column:
 * an empty cell, padded with the rest of its block so a positioned row beside it still lines up.
 *
 * Reachable, not theoretical. A `ConfigError` carrying no positioned problems becomes a
 * `config/invalid` diagnostic with neither `line` nor `col` (run.ts's `configErrorDiagnostics`,
 * the `problems.length === 0` branch); `skillslurp <path-to-a-file>` — "... is not a directory" —
 * is the shortest reproduction, and it printed `0:0` before this function existed.
 *
 * A `line` with no `col` renders as the bare line number rather than `12:0`, for the same reason.
 * Nothing produces that shape today — `locFields` writes both or neither — but `Diagnostic` types
 * the two independently, so the column has to mean something if it ever appears.
 */
function positionCell(d: Diagnostic): string {
	if (d.line === undefined) {
		return "";
	}
	return d.col === undefined ? `${d.line}` : `${d.line}:${d.col}`;
}

/**
 * Groups consecutive same-file diagnostics. The engine already sorts diagnostics by file, so
 * this produces one group per file; it does not re-sort or otherwise rely on that ordering
 * beyond "same file stays consecutive". `message` is sanitized here, before it is ever
 * measured for column width or rendered (see `sanitizeControlChars`).
 */
function groupByFile(
	diagnostics: readonly Diagnostic[],
): { file: string; rows: Row[] }[] {
	const groups: { file: string; rows: Row[] }[] = [];
	for (const d of diagnostics) {
		const row: Row = {
			pos: positionCell(d),
			severity: d.severity,
			message: neutralizeLegacyCommands(sanitizeControlChars(d.message)),
			ruleId: d.ruleId,
		};
		const last = groups[groups.length - 1];
		if (last && last.file === d.file) {
			last.rows.push(row);
		} else {
			groups.push({ file: d.file, rows: [row] });
		}
	}
	return groups;
}

/**
 * Renders one file block: the file path on its own line, then one line per diagnostic with
 * position/severity/message columns padded to the widest value IN THIS BLOCK (not globally) —
 * two spaces between columns, a single trailing (unpadded) ruleId. Padding is applied to the
 * plain text before any color wrapping, so ANSI escape codes (added afterwards, around the
 * text only, never the padding spaces) never skew alignment. `endLine`/`endCol` are
 * deliberately not rendered (ESLint-stylish parity: only the start position is shown).
 */
function formatFileBlock(
	file: string,
	rows: readonly Row[],
	colors: Colors,
): string {
	let posWidth = 0;
	let severityWidth = 0;
	let messageWidth = 0;
	for (const row of rows) {
		posWidth = Math.max(posWidth, row.pos.length);
		severityWidth = Math.max(severityWidth, row.severity.length);
		messageWidth = Math.max(messageWidth, row.message.length);
	}

	const lines = rows.map((row) => {
		// The color call is skipped for an empty cell on purpose: picocolors wraps even `""` in a
		// dim/reset pair, which would put two invisible escape sequences into a row that renders
		// nothing at all.
		const pos =
			(row.pos === "" ? "" : colors.dim(row.pos)) +
			" ".repeat(posWidth - row.pos.length);
		const severityColor = row.severity === "error" ? colors.red : colors.yellow;
		const severity =
			severityColor(row.severity) +
			" ".repeat(severityWidth - row.severity.length);
		const message = row.message + " ".repeat(messageWidth - row.message.length);
		const ruleId = colors.dim(row.ruleId);
		return `  ${pos}  ${severity}  ${message}  ${ruleId}`;
	});

	return [
		colors.underline(neutralizeWorkflowCommands(sanitizeControlChars(file))),
		...lines,
	].join("\n");
}

/**
 * ESLint-like reporter. Zero diagnostics → `""` (the CLI prints nothing on a clean run).
 * Otherwise: one blank-line-separated block per file, then a `✖ N problem(s) (...)` summary
 * colored red if any error is present, yellow if only warnings.
 */
export const stylish: Reporter = (diagnostics, options) => {
	if (diagnostics.length === 0) {
		return "";
	}

	const colors = picocolors.createColors(options.color);
	const groups = groupByFile(diagnostics);
	const blocks = groups.map((g) => formatFileBlock(g.file, g.rows, colors));

	let errors = 0;
	let warnings = 0;
	for (const d of diagnostics) {
		if (d.severity === "error") {
			errors++;
		} else {
			warnings++;
		}
	}

	const summaryText = `✖ ${pluralize(diagnostics.length, "problem")} (${pluralize(errors, "error")}, ${pluralize(warnings, "warning")})`;
	const summary =
		errors > 0 ? colors.red(summaryText) : colors.yellow(summaryText);

	return [...blocks, summary].join("\n\n");
};

/**
 * The cell a "nothing here" value renders as in a rule listing: no tiers, or not fixable.
 *
 * An EMPTY cell would have been the `positionCell` answer, but the two situations are not the
 * same. There, one column was absent and the rest of the row still labelled itself; here two
 * adjacent columns can both be empty at once (an opt-in, non-fixable rule — five of the built-ins
 * today), and a run of padding spaces gives a reader nothing to count against the row above. A
 * literal placeholder keeps every column present and countable, and cannot be confused with a
 * value: no tier and no boolean renders as `-`.
 */
const EMPTY_CELL = "-";

/** One rule's cells, in the field order `--list-rules` pins (see `serializeRule`, json.ts). */
interface RuleRow {
	id: string;
	kind: string;
	tiers: string;
	defaultSeverity: Severity;
	fixable: string;
	description: string;
	docsUrl: string;
}

function ruleRow(rule: Rule): RuleRow {
	return {
		id: rule.meta.id,
		kind: rule.kind,
		// No separating space: this is a whitespace-separated table, so `recommended, strict`
		// would read as two columns.
		tiers: rule.meta.tiers.length > 0 ? rule.meta.tiers.join(",") : EMPTY_CELL,
		defaultSeverity: rule.meta.defaultSeverity,
		fixable: rule.meta.fixable ? "fixable" : EMPTY_CELL,
		description: rule.meta.description,
		docsUrl: rule.meta.docsUrl,
	};
}

/** Right-pads `s` with spaces to `width`; `width` is never below `s.length` by construction. */
function pad(s: string, width: number): string {
	return s + " ".repeat(width - s.length);
}

/**
 * Human-readable rule listing: one line per rule, columns padded to the widest value across the
 * whole listing (there are no per-file blocks to scope padding to, unlike `formatFileBlock`).
 *
 * `description` is padded even though it is long and free-form, for the same reason
 * `formatFileBlock` pads `message`: a trailing dim column follows it, and an unpadded column
 * before a trailing one is a ragged right edge rather than a table. `defaultSeverity` is colored
 * with the same red/yellow vocabulary a diagnostic's severity gets — it is the same word meaning
 * the same thing, and a listing that colored it differently would be teaching a second one.
 *
 * Padding is applied to plain text before any color wrapping, so ANSI codes never skew alignment;
 * no cell is sanitized, because unlike a diagnostic's `file`/`message` every value here comes from
 * this project's own rule sources, never from the content of a linted file.
 */
export const stylishRules: RuleLister = (rules, options) => {
	const colors = picocolors.createColors(options.color);
	const rows = rules.map(ruleRow);

	let idWidth = 0;
	let kindWidth = 0;
	let tiersWidth = 0;
	let severityWidth = 0;
	let fixableWidth = 0;
	let descriptionWidth = 0;
	for (const row of rows) {
		idWidth = Math.max(idWidth, row.id.length);
		kindWidth = Math.max(kindWidth, row.kind.length);
		tiersWidth = Math.max(tiersWidth, row.tiers.length);
		severityWidth = Math.max(severityWidth, row.defaultSeverity.length);
		fixableWidth = Math.max(fixableWidth, row.fixable.length);
		descriptionWidth = Math.max(descriptionWidth, row.description.length);
	}

	return rows
		.map((row) => {
			const severityColor =
				row.defaultSeverity === "error" ? colors.red : colors.yellow;
			return [
				pad(row.id, idWidth),
				pad(row.kind, kindWidth),
				pad(row.tiers, tiersWidth),
				severityColor(row.defaultSeverity) +
					" ".repeat(severityWidth - row.defaultSeverity.length),
				pad(row.fixable, fixableWidth),
				pad(row.description, descriptionWidth),
				colors.dim(row.docsUrl),
			].join("  ");
		})
		.join("\n");
};
