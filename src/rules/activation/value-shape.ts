import { isMap, isSeq } from "yaml";
import { DOCS_URL } from "../../diagnostic.js";
import {
	type ActivationKey,
	type ActivationValueShape,
	BUILTIN_DIALECTS,
	type DialectId,
} from "../../dialects.js";
import type { Document, Frontmatter } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import { readScope } from "../activation.js";
import { collectScalarPairs, locOf } from "../frontmatter.js";

/** One dialect of the surface, and the activation key its contract for the surface's kind names. */
export interface DialectActivation {
	readonly dialect: DialectId;
	readonly activation: ActivationKey;
}

const quoted = (dialects: readonly DialectId[]): string =>
	dialects.map((dialect) => `"${dialect}"`).join(", ");

/**
 * Typed by `Record<ActivationValueShape, …>`, so a shape added to `dialects.ts` fails `tsc` here
 * until it has a message. The text names no value from the document, so a baseline entry (keyed on
 * the message) survives an edit to the list and a line move; it goes stale only when the key or a
 * dialect changes, which is a different finding.
 */
const MESSAGES: Readonly<
	Record<
		ActivationValueShape,
		(key: string, dialects: readonly DialectId[]) => string
	>
> = Object.freeze({
	"flow-sequence": (key, dialects) =>
		`Frontmatter key "${key}" is a list in brackets, which does not activate this document in ${quoted(dialects)}; write the patterns comma-separated instead, as in "${key}: a, b", quoting the value if it starts with "*", "!" or "{"`,
});

/** The shape a value is written in, judged on the node itself: an alias is not followed. */
function shapeOf(value: unknown): ActivationValueShape | undefined {
	return isSeq(value) && value.flow === true ? "flow-sequence" : undefined;
}

/**
 * The reports for one document's frontmatter, given the activation key of each dialect of its
 * surface: one per key whose value is written in a shape some dialect lists in
 * `nonActivatingShapes` for that key, naming those dialects once each, sorted, and positioned on
 * the value node, so a list over several lines is blamed over its whole span.
 *
 * Exported, as `outOfSyncMessage` is (consistent-scope.ts), because no built-in can tell a rule
 * that reads the data from one that hard-codes Cursor's `globs`: only one contract lists a shape,
 * and `RuleTester` accepts built-in dialect ids only. A test has to hand this function synthetic
 * activations to pin that, and this is the function it calls.
 *
 * A value is reported only when the shared reader reads at least one pattern from it, so `[]`, a
 * list of blank items and a list with a non-string item are left alone: there is nothing to lose
 * in the first, and the type check owns the others.
 */
export function valueShapeReports(
	fm: Frontmatter,
	activations: readonly DialectActivation[],
): RuleReport[] {
	const reports: RuleReport[] = [];
	for (const [key, pair] of collectScalarPairs(fm)) {
		const shape = shapeOf(pair.value);
		if (shape === undefined) {
			continue;
		}
		const named = new Set<DialectId>();
		for (const { dialect, activation } of activations) {
			if (
				activation.key === key &&
				activation.nonActivatingShapes?.includes(shape) === true
			) {
				named.add(dialect);
			}
		}
		if (named.size === 0) {
			continue;
		}
		// `isPrimary: true`, so the `"parse"` policy, which only a legacy key consults, is moot.
		const outcome = readScope(fm, { key, pair, isPrimary: true }, "parse");
		if (outcome.kind !== "scope" || outcome.scope.kind !== "patterns") {
			continue;
		}
		reports.push({
			message: MESSAGES[shape](key, [...named].sort()),
			loc: locOf(fm, pair.value),
		});
	}
	return reports;
}

/**
 * Reports an activation value written in a shape the format is known not to activate on. Today
 * that is one shape on one contract: a Cursor rule whose `globs` is a YAML flow sequence
 * (`globs: [a, b]`), which Cursor does not attach. Cursor's own wording is only "Separate multiple
 * patterns with commas."; the rest is a dated hand check, recorded with its version and method on
 * the `cursor` contract in `dialects.ts`, where it covers one item, several items and a list over
 * several lines alike.
 *
 * ## What it reads
 *
 * The data, not a hard-coded key: for each dialect of the surface, the `activation` of its
 * contract for the surface's kind, and from it the shapes listed in `nonActivatingShapes`. A
 * contract that lists none, which is every one but `cursor`'s rules, is not inspected, so a
 * missing entry means nothing is known and never that a shape activates.
 *
 * Neither the file's extension, nor `include`, nor where a tool reads the file is consulted. A
 * hub `.md` rule reaches Cursor through an `.mdc` link, and a surface's dialect list says what
 * contract the content meets, not where a tool reads it, so `globs: [a]` in `x.md` on a surface
 * that lists `cursor` is reported as it is in `x.mdc`.
 *
 * ## What it judges
 *
 * - **The primary key only.** A `legacyKeys` entry carries no shape data and is not inspected,
 *   nor is any key that is not an activation key (`description: [a]`).
 * - **The node at the key, as written.** An alias to a flow list (`globs: *g`) is not followed:
 *   the text at the key is `*g`, not brackets, and nobody checked what Cursor does with an alias.
 *   An anchored or tagged list (`&g [a]`, `!!seq [a]`) is itself a flow sequence and is reported.
 *   A block list, which Cursor attaches, a scalar and a flow mapping are not.
 * - **Only a list the shared reader reads a pattern from.** `[]`, `[""]` and `[~]` are left
 *   alone, and so is a list with a non-string item (`[1, a]`), which is a type violation that
 *   `activation/consistent-scope` and `skill/frontmatter-schema` own.
 * - **A negated pattern is a pattern** (`["!a"]` is reported), unlike in `declaredGlobs`.
 * - **`alwaysApply` is not modelled**, as in `activation/consistent-scope`: a rule with
 *   `alwaysApply: true` and a flow list is reported, since the list stops working the day the
 *   flag changes.
 *
 * Two inputs never reach the rule, because the engine skips a document whose frontmatter fails to
 * parse: a repeated key, and a bare leading `*` (`globs: **\/*.ts`, read as an alias), both of
 * which `parse/frontmatter` reports. `globs: {}` parses, and is not a sequence.
 *
 * ## Reports
 *
 * One per key, at the value node, whatever the number of items. The other activation rules are
 * unchanged: a flow list's items stay patterns for `activation/no-unmatched-globs`,
 * `activation/max-glob-share` and `activation/consistent-scope`, so one value can draw a report
 * on an item from those next to this one on the list. Accepted, since each names its own fix.
 *
 * ## `--diff-base`
 *
 * This is a `file` rule, so a diff-scoped run checks it on changed documents only.
 */
export const valueShape: FileRule = freezeRule({
	kind: "file",
	meta: {
		id: "activation/value-shape",
		description:
			"An activation value written in a form the tool does not act on, such as Cursor's `globs` as a list in brackets.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	check(doc: Document): RuleReport[] {
		const fm = doc.frontmatter;
		if (fm === null || !isMap(fm.doc.contents)) {
			return [];
		}
		const activations: DialectActivation[] = [];
		for (const dialect of doc.surface.dialects) {
			const activation =
				BUILTIN_DIALECTS[dialect].contracts[doc.surface.kind]?.activation;
			if (activation !== undefined) {
				activations.push({ dialect, activation });
			}
		}
		return valueShapeReports(fm, activations);
	},
});
