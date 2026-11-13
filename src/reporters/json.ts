import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import type { Reporter, RuleLister } from "./types.js";

/**
 * Builds the serialized shape field-by-field in the EXPLICIT key order:
 * ruleId, severity, message, file, line, col, endLine, endCol, fixable, docsUrl. Undefined
 * position keys are omitted entirely rather than serialized as `null` — do not spread
 * `Diagnostic` itself, its own key order is not the contract here.
 */
function serializeDiagnostic(d: Diagnostic): Record<string, unknown> {
	const out: Record<string, unknown> = {
		ruleId: d.ruleId,
		severity: d.severity,
		message: d.message,
		file: d.file,
	};
	if (d.line !== undefined) {
		out.line = d.line;
	}
	if (d.col !== undefined) {
		out.col = d.col;
	}
	if (d.endLine !== undefined) {
		out.endLine = d.endLine;
	}
	if (d.endCol !== undefined) {
		out.endCol = d.endCol;
	}
	out.fixable = d.fixable;
	out.docsUrl = d.docsUrl;
	return out;
}

/**
 * Machine-consumed reporter: one compact (no pretty-print) JSON object plus a trailing
 * newline. `options.color` is ignored (still typed as `Reporter` so it's interchangeable with
 * `stylish` at the call site).
 */
/**
 * `JSON.stringify`, plus the two separators it deliberately leaves raw, plus a lossless `\u0023`
 * in every `##[`, the legacy Actions workflow-command prefix (see `neutralizeLegacyCommands`).
 *
 * `JSON.stringify` escapes every C0 control character but NOT U+2028 LINE SEPARATOR or U+2029
 * PARAGRAPH SEPARATOR: they are legal, unescaped, inside a JSON string. That is correct JSON and
 * every `JSON.parse` consumer is unaffected either way — `\u2028` parses back to the same
 * character. It is escaped anyway for two reasons. The output is a machine-readable document that
 * a consumer may embed in a `<script>` block or otherwise treat as JS source, where a raw U+2028
 * has historically terminated a string literal. And the other two reporters escape these code
 * points (`sanitizeControlChars`, `text.ts`, widened to `\p{Zl}`/`\p{Zp}`), so leaving them here
 * would make one claim true of two reporters out of three — the kind of almost-true invariant
 * this project would rather not ship.
 *
 * Applied to the SERIALIZED string, not to the messages: the escape is a JSON-level concern, and
 * doing it per-field would miss file paths and rule ids.
 */
function serialize(payload: unknown): string {
	return JSON.stringify(payload)
		.replace(
			/[\u2028\u2029]/g,
			(ch) => `\\u${ch.codePointAt(0)?.toString(16).padStart(4, "0")}`,
		)
		.replaceAll("##[", "#\\u0023[");
}

export const json: Reporter = (diagnostics, _options) => {
	let errors = 0;
	let warnings = 0;
	for (const d of diagnostics) {
		if (d.severity === "error") {
			errors++;
		} else {
			warnings++;
		}
	}

	const payload = {
		version: 1,
		summary: { problems: diagnostics.length, errors, warnings },
		diagnostics: diagnostics.map(serializeDiagnostic),
	};

	return `${serialize(payload)}\n`;
};

/**
 * Serializes one rule for `--list-rules`, field by field in the EXPLICIT key order the tests
 * pin: id, kind, tiers, defaultSeverity, fixable, description, docsUrl — same discipline, and
 * same reason, as `serializeDiagnostic` above. Do not spread `rule.meta`: its key order is not
 * this output's contract, and it would leak `optionsSchema` (a zod object, which `JSON.stringify`
 * renders as internal noise) into the payload.
 *
 * `kind` is the rule's own top-level field rather than anything under `meta`, and it is here
 * because it is the field a user choosing rules needs most: it says whether a rule looks at one
 * document at a time or at the repository as a whole.
 */
function serializeRule(rule: Rule): Record<string, unknown> {
	return {
		id: rule.meta.id,
		kind: rule.kind,
		// Copied out of the frozen `meta.tiers` rather than handed over: what this function
		// returns is a plain payload object, and nothing downstream should inherit a freeze it
		// did not ask for.
		tiers: [...rule.meta.tiers],
		defaultSeverity: rule.meta.defaultSeverity,
		fixable: rule.meta.fixable,
		description: rule.meta.description,
		docsUrl: rule.meta.docsUrl,
	};
}

/**
 * Machine-consumed rule listing: one compact JSON ARRAY plus a trailing newline, in registry
 * order (which `rules/index.test.ts` pins as id-sorted, so it is an invariant and not a
 * coincidence of how the list happens to be written).
 *
 * Deliberately a bare array rather than the `{ version, summary, diagnostics }` envelope `json`
 * above emits. The envelope exists so a *run's* result can gain fields without breaking parsers;
 * a listing is a static dump of the built-in registry, has no summary to carry, and `jq '.[].id'`
 * is the whole point of asking for it. `options.color` is ignored, exactly as in `json`.
 */
export const jsonRules: RuleLister = (rules, _options) =>
	`${serialize(rules.map(serializeRule))}\n`;
