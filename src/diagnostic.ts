export type Severity = "error" | "warn";
export type ConfiguredSeverity = Severity | "off";

/**
 * Placeholder docs URL for diagnostics under the reserved `parse/frontmatter` pseudo-rule, and
 * reused by rules (e.g. `skill/frontmatter-schema`) that don't yet have a dedicated docs page.
 * Real per-rule docs URLs (one per registered rule, via `meta.docsUrl`) are not provided yet.
 * Lives here (rather than engine.ts) so rules can import it without a rules → engine edge.
 */
export const DOCS_URL = "https://github.com/shoptet/skillslurp";

/**
 * 1-based line and col. Zero is not a valid value for either — a reporter with no position to
 * show renders nothing rather than `0:0` (see `positionCell` in the stylish reporter).
 *
 * `readonly` throughout: several `Loc`s are shared module-level constants (`START_LOC` just
 * below, `FENCE_LOC` in rules/frontmatter.ts) that are already `Object.freeze`d, and the type
 * used to accept `START_LOC.line = 2` while the runtime rejected it. Every producer builds a
 * fresh object literal, so nothing legitimately writes into one after construction.
 */
export interface Loc {
	readonly line: number;
	readonly col: number;
	readonly endLine?: number;
	readonly endCol?: number;
}

/**
 * File line 1, column 1 — the position a diagnostic points at when there is nothing more
 * specific to blame. Two independent readers of that fact: a document with no frontmatter block
 * at all (`rules/frontmatter.ts`'s own readers, e.g. `skill/frontmatter-schema`'s "Missing YAML
 * frontmatter block"), and an mdast node with no `position` at all (`links.ts`'s `locOfNode`,
 * where mdast types `Node.position` as optional even though this project's own processor always
 * attaches one). Both are the identical statement — "there is no more specific place in this
 * file to point at" — so it is declared once and shared rather than risking two frozen `{ line:
 * 1, col: 1 }` literals drifting apart.
 *
 * Lives here, next to `Loc` itself, rather than in `rules/frontmatter.ts` (where it started):
 * `links.ts` is a shared module the extraction that produced it deliberately kept out of
 * `rules/` (see that file's own header), and a shared non-rule module importing a rule-adjacent
 * one under `rules/` for one frozen constant is the wrong-direction edge — matching `DOCS_URL`'s
 * own precedent just above ("Lives here ... so rules can import it without a rules → engine
 * edge"). `rules/frontmatter.ts` re-exports it, so every existing importer of `START_LOC` from
 * there is unaffected.
 */
export const START_LOC: Loc = Object.freeze({ line: 1, col: 1 });

export interface Diagnostic {
	ruleId: string;
	severity: Severity;
	message: string;
	/** repo-relative, posix separators */
	file: string;
	line?: number;
	col?: number;
	endLine?: number;
	endCol?: number;
	fixable: boolean;
	docsUrl: string;
}

/**
 * The positional half of a `Diagnostic`, carrying only the fields that actually have a value as
 * own keys — three call sites used to spell this out and all three spread `undefined` into the
 * result. Under `exactOptionalPropertyTypes` that is a type error now, which is the point: an
 * own key holding `undefined` makes "no position" indistinguishable from "position explicitly
 * set" to anything reading `"line" in diagnostic` (the json reporter's contract, pinned by its
 * tests).
 */
export function locFields(
	loc: Loc | undefined,
): Pick<Diagnostic, "line" | "col" | "endLine" | "endCol"> {
	if (loc === undefined) {
		return {};
	}
	const fields: Pick<Diagnostic, "line" | "col" | "endLine" | "endCol"> = {
		line: loc.line,
		col: loc.col,
	};
	if (loc.endLine !== undefined) {
		fields.endLine = loc.endLine;
	}
	if (loc.endCol !== undefined) {
		fields.endCol = loc.endCol;
	}
	return fields;
}
