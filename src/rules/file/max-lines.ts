import { z } from "zod";
import { DOCS_URL } from "../../diagnostic.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";

export const OptionsSchema = z.strictObject({
	/**
	 * Field-level default, never a schema-level `.default(...)` — see the comment on
	 * `RuleMeta.optionsSchema` (rule.ts). A rule enabled with no `options:` block is parsed as
	 * `{}`, not `undefined`, so a top-level `.default({ max: 500 })` would never fire and the rule
	 * would become impossible to enable without restating its own default in every config.
	 *
	 * `min(1)`: `max: 0` is not a threshold at all — it says "no document may have any content" —
	 * so it is rejected at the type boundary rather than accepted as a legal-but-draconian value.
	 * `max: 1` IS accepted and does almost the same thing in practice (every real skill or rule
	 * document has at least one line), but the tool does not otherwise police an unhelpfully small
	 * `max`; only the degenerate value that is not really a line-count limit at all is rejected
	 * here.
	 */
	max: z.number().int().min(1).default(500),
});
export type Options = z.infer<typeof OptionsSchema>;

/**
 * Counts logical lines in `raw`. The one adjustment below exists because a trailing line break is
 * a terminator, not a line of its own — it must not inflate the count the way a literal
 * `String.split` element count would.
 *
 * `split(/\r?\n/)` turns a file that ends with a line break into an array with one trailing empty
 * string that is not a real line — just "nothing after the last newline" — so it is dropped
 * before counting. A file with NO trailing line break has no such phantom element and needs no
 * adjustment: its last line is real content. The empty file needs no special case either:
 * `"".split(/\r?\n/)` yields `[""]` (length 1), and that single empty element is exactly as much
 * "not a real line" as the phantom trailing one above is — the same drop rule removes it, leaving
 * 0, the correct count for a file with no bytes at all.
 *
 * Stated limitation, not handled: a lone `\r` (classic Mac line ending, obsolete even by Apple's
 * own standards) is not treated as a line break. `split(/\r?\n/)` only recognizes `\n` and
 * `\r\n`; a file using bare `\r` throughout would count as a single very long line. No dialect
 * this tool targets documents that convention, so it is noted rather than special-cased.
 */
function countLines(raw: string): number {
	const lines = raw.split(/\r?\n/);
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.length;
}

/**
 * Every discovered document whose frontmatter parsed must stay under a configurable line count —
 * the whole file, no exceptions beyond that one. The exception is the engine's, not this rule's:
 * `engine.ts` (step 4) skips every file rule — this one included — on a document whose
 * frontmatter failed to parse, so a 3000-line file with one YAML typo reports only
 * `parse/frontmatter` and never its line count (reproduced end to end: a duplicate-key SKILL.md
 * over 3000 lines produces exactly one `parse/frontmatter` diagnostic and nothing from this
 * rule). Pre-existing, documented engine behaviour (`engine.ts` step 4; `rule-tester.ts`'s
 * `expectParseErrors` doc) and out of scope to fix here. This
 * is the first rule that reads no frontmatter at all, which is what makes the skip newly
 * consequential rather than a paper cut.
 *
 * `skill/name-matches-dir` gates on the document's filename — the `skill/*` rule this one
 * actually contrasts with; the other, `skill/frontmatter-schema`, has no scope gate either. This
 * rule has NO scope gate at all: no `doc.surface.kind` check, no dialect check, no filename
 * check. It runs
 * on every document any surface discovers whose frontmatter parsed (see above), whatever kind or
 * dialect that surface speaks. The namespace is `file/`, not `skill/`, on purpose: an over-long
 * Cursor `.mdc` rule or an over-long Copilot `.instructions.md` file is exactly the same
 * context-bloat problem as an over-long `SKILL.md`.
 *
 * That framing — a file an agent has to read in full before doing anything else, competing with
 * everything else in its context window — holds cleanly for an entry file: `SKILL.md`, `.mdc`,
 * and `.instructions.md`, what each kind's default `include` matches. It is weaker for a
 * supporting file a widened `include` happens to pull in: Claude Code's own skills docs describe
 * a skill's supporting files as reference material Claude accesses "only when needed", and that
 * "large reference docs, API specifications, or example collections don't need to load into
 * context every time the skill runs" (code.claude.com/docs/en/skills, fetched 2026-09-03) — the
 * opposite of always being read in full up front. This rule does not draw that distinction: every
 * discovered document is counted the same way, entry point or not.
 *
 * The count is over the WHOLE file, frontmatter included, not just the prose after the closing
 * fence. The authoring guidance this rule encodes ("keep it under N lines") is about how much the
 * file costs to load, and frontmatter costs exactly as much to load as body — so a
 * frontmatter-only document (no body at all) still has a non-zero count, and a file entirely
 * consumed by a long frontmatter block is exactly as reportable as one with a long body.
 *
 * Default `{ max: 500 }`. Provenance, cited rather than denied: Claude Code's own skills docs
 * state this exact number — "Keep `SKILL.md` under 500 lines. Move detailed reference material to
 * separate files." (code.claude.com/docs/en/skills, fetched 2026-09-03) — so the default is a
 * cited vendor number, not an invented one. Two things that sentence does NOT make this rule,
 * both worth keeping honest:
 *
 * - It is guidance, not a hard tool-side cap. Nothing in any dialect this tool checks documents a
 *   500-line ceiling that breaks a skill or rule file; that is exactly why `defaultSeverity` is
 *   `"warn"` and `max` is a configurable option rather than a fixed constant — a repo with a
 *   reference-heavy skill is expected to tune it. A default run therefore never exits nonzero on
 *   this rule alone (`computeExitCode` only counts `"error"` severities).
 * - The vendor sentence is about `SKILL.md` specifically. This rule applies the same threshold to
 *   every document kind this tool discovers — a Cursor `.mdc` rule, a Copilot
 *   `.instructions.md` file, any supporting file a widened `include` pulls in — which is this
 *   project's own extension of the guidance, not a claim code.claude.com makes. Labelled as ours:
 *   that extension is this project's own decision, not the vendor page.
 *
 * (Unrelated, despite sharing the number: `dialects.ts`'s several `500`s are the agentskills.io
 * spec's `compatibility`-string length cap, a completely different field with a completely
 * different, vendor-sourced provenance — the two "500"s are coincidental, not cross-referenced.)
 */
export const fileMaxLines: FileRule<Options> = freezeRule({
	kind: "file",
	meta: {
		id: "file/max-lines",
		description:
			"A file longer than the line limit (500 by default), frontmatter included.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "warn",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	check(doc: Document, ctx): RuleReport[] {
		const { max } = ctx.options;
		const count = countLines(doc.raw);
		if (count <= max) {
			return [];
		}
		return [
			{
				message: `File has ${count} lines, over the limit of ${max} (the whole file, frontmatter included)`,
				// The first line past the limit, col 1 — not the last valid line, and not the
				// file's actual last line. This is where the file would have to stop to comply,
				// which is a more useful spot for an editor to jump to than the count itself.
				loc: { line: max + 1, col: 1 },
			},
		];
	},
});
