/**
 * Frontmatter reading helpers shared by the file rules that read a frontmatter block. Imported
 * from here today: the three `skill/*` rules (two of them for `START_LOC`/`FENCE_LOC`) and
 * `activation/consistent-scope` (`describeType`). `links/resolve` no longer imports `START_LOC`
 * from here; it gets the fact it needs (`locOfNode`'s file-1:1 fallback) through
 * `links.ts` instead, which imports `START_LOC` straight from `diagnostic.ts` — see the note on
 * this module's own re-export of it, just below, for why.
 *
 * Extracted from `skill/frontmatter-schema` once a second and third rule had to
 * answer the same question — "what string did this document put under `name`, and which yaml
 * node do I blame for it?" — because getting that answer right needs three non-obvious steps
 * (resolve an alias, treat a structurally-absent value like an explicit null, fall back from the
 * value's range to the key's when there is no value node to point at) and a rule that reimplemented
 * any one of them would report a subtly different position than the rule next to it.
 *
 * Nothing here executes a check or knows about a dialect: the helpers read a `Frontmatter` and
 * hand back values plus positions.
 *
 * `describeType` was moved in here on the same grounds: `activation/consistent-scope` names the
 * type of an unusable activation value in its own diagnostic, and a second copy of that
 * list|mapping|number|boolean|date mapping would let two rules describe the identical yaml node
 * with two different words.
 *
 * `START_LOC` moved OUT of here, to `diagnostic.ts` — re-exported below so every
 * existing importer of it from this module keeps working unchanged. See `diagnostic.ts`'s own
 * doc on it for why: the new `links.ts` shared module needed the same frozen 1:1 constant
 * without importing a module that sits under `rules/`.
 */

import { isAlias, isMap, isNode, isScalar, isSeq } from "yaml";
import { type Loc, START_LOC } from "../diagnostic.js";
import { type Frontmatter, locFromRange } from "../document.js";

export { START_LOC };

/**
 * The opening `---` fence: always file line 1, columns 1–3 (a fixed loc, not derived). What a
 * rule points at when the thing it is complaining about is *absent* from the frontmatter, so
 * there is no node of its own to blame.
 */
export const FENCE_LOC: Loc = Object.freeze({
	line: 1,
	col: 1,
	endLine: 1,
	endCol: 4,
});

/**
 * The mdast `Yaml` node's own position (block start to block end, fences included). Used for a
 * diagnostic about the block as a whole, and as a defensive fallback when a yaml AST node has no
 * `range`. `parseFrontmatter` (document.ts) throws before a `Frontmatter` is ever constructed
 * without a position, so the `!pos` branch here is unreachable in practice; kept only because
 * mdast types `Node.position` as optional.
 */
export function blockLoc(fm: Frontmatter): Loc {
	const pos = fm.node.position;
	if (!pos) {
		return START_LOC;
	}
	return {
		line: pos.start.line,
		col: pos.start.column,
		endLine: pos.end.line,
		endCol: pos.end.column,
	};
}

/** A yaml AST node's own range, if it has one — undefined for a structurally absent value/key. */
function rangeOf(node: unknown): readonly [number, number, number] | undefined {
	if (!isNode(node)) {
		return undefined;
	}
	return node.range ?? undefined;
}

/** `node`'s own position, or the whole block's when it has none to offer. */
export function locOf(fm: Frontmatter, node: unknown): Loc {
	const range = rangeOf(node);
	return range ? locFromRange(fm, range) : blockLoc(fm);
}

/**
 * Resolves an Alias node to the node it points at (`alias.resolve(fm.doc)`, finding the last
 * matching anchor before the alias — an anchor defined *after* an alias cannot be resolved: yaml
 * has no forward references). A key's value can legitimately be an alias — `name: &n hello` /
 * `description: *n` is valid yaml with zero parse errors — and a rule must judge the *resolved*
 * node, not the Alias wrapper itself (which is neither a Scalar, a YAMLMap, nor a YAMLSeq, and
 * would otherwise look like an unrecognizable type to every caller).
 *
 * An alias that fails to resolve (forward reference, or no matching anchor at all) makes
 * `doc.toJS()` throw, which `document.ts`'s `parseFrontmatter` already turns into a
 * `parse/frontmatter` `ParseProblem` — the engine's short-circuit means no rule ever observes
 * such a document in production. The `?? value` fallback below only guards a test that calls a
 * rule's `check()` directly, bypassing the engine.
 */
function resolveIfAlias(fm: Frontmatter, value: unknown): unknown {
	return isAlias(value) ? (value.resolve(fm.doc) ?? value) : value;
}

/**
 * True for a structurally absent value (`pair.value === null`, e.g. an explicit key with no
 * `:` line) or a Scalar resolving to yaml `null` (the common `key:`-with-nothing-after form).
 * Both are "no value was given", and both fall back to the key's own range for `loc` (see
 * `resolveValueAndLoc`) since neither has a meaningful span of its own to point at — a
 * resolved-null Scalar's range is a zero-width point right after the colon.
 */
function isNullValue(value: unknown): boolean {
	return value === null || (isScalar(value) && value.value === null);
}

/** Null (see `isNullValue`) or a string that trims to "". */
export function isEmptyValue(value: unknown): boolean {
	if (isNullValue(value)) {
		return true;
	}
	return (
		isScalar(value) &&
		typeof value.value === "string" &&
		value.value.trim() === ""
	);
}

/** list | mapping | number | boolean | date, with a defensive fallback for anything else. */
export function describeType(node: unknown): string {
	if (isSeq(node)) {
		return "list";
	}
	if (isMap(node)) {
		return "mapping";
	}
	if (isScalar(node)) {
		const { value } = node;
		if (typeof value === "number") {
			return "number";
		}
		if (typeof value === "boolean") {
			return "boolean";
		}
		// A `!!timestamp`-TAGGED scalar resolves to a Date under yaml's default core schema. The
		// tag is required, and that is the whole reason this branch is narrow: confirmed
		// empirically against yaml 2.9.0, parsed exactly as `parseFrontmatter` does, a bare
		// unquoted `2001-12-14` stays a plain STRING (0 errors, no warnings), while
		// `!!timestamp 2001-12-14` yields a real `Date` instance on the same terms — no warning,
		// no TAG_RESOLVE_FAILED, `doc.errors` stays empty. Without this check the tagged form
		// would fall through to the generic `typeof` fallback below as "object", which is
		// accurate but unhelpful in a message aimed at a human.
		if (value instanceof Date) {
			return "date";
		}
		// Beyond the list|mapping|number|boolean(|date) set: no other yaml core-schema
		// tag produces anything else as of yaml 2.9, but `typeof` is a safe, honest fallback for
		// whatever does turn up rather than crashing or lying about the shape.
		return typeof value;
	}
	return "unknown";
}

export interface ScalarPair {
	key: unknown;
	value: unknown;
}

export interface ResolvedValue {
	/** the alias-resolved value (see `resolveIfAlias`); judge THIS node's emptiness/type/format */
	value: unknown;
	/**
	 * What a diagnostic about this key should point `loc` at: an alias reference's own range
	 * (never its anchor's — that's someone else's text), a genuine value node's own range, or —
	 * only when there is no value node at all to point at (a structurally absent value, or the
	 * common `key:`-with-nothing-after null scalar) — the key's own range.
	 */
	locNode: unknown;
}

/**
 * Resolves a mapping pair's value through an alias (if any) and picks the node a diagnostic about
 * it should blame. Factored out so the call sites cannot quietly diverge on which node they
 * point at.
 */
export function resolveValueAndLoc(
	fm: Frontmatter,
	pair: ScalarPair,
): ResolvedValue {
	const { key: keyNode, value: rawValue } = pair;
	const value = resolveIfAlias(fm, rawValue);
	const locNode = isAlias(rawValue) || !isNullValue(value) ? rawValue : keyNode;
	return { value, locNode };
}

/**
 * Every scalar-keyed mapping pair, keyed by `String(key.value)`, first occurrence winning.
 * Returns an empty map when the frontmatter is not a mapping at all (a bare scalar, a list, an
 * empty block) — a caller that cares about the difference checks `isMap(fm.doc.contents)` itself.
 *
 * "First occurrence wins" is NOT the same thing as "duplicate key" in yaml's own sense: `1: a`
 * and `"1": b` are two genuinely DISTINCT yaml keys (a number and a string; no DUPLICATE_KEY
 * error, since yaml compares keys by value *and* type) that collapse onto the same string here —
 * a rule cannot tell them apart once stringified, so the first one wins and the second is
 * silently shadowed. An actual yaml DUPLICATE_KEY (`name: a\nname: b`) is a parse error the
 * engine already short-circuited on before any rule ran, so that case never reaches here.
 *
 * Non-scalar (yaml collection) keys are skipped: they parse fine, so the engine never
 * short-circuits them away, but they can never match a string key a rule is looking for.
 */
export function collectScalarPairs(
	fm: Frontmatter,
): ReadonlyMap<string, ScalarPair> {
	const pairs = new Map<string, ScalarPair>();
	const contents = fm.doc.contents;
	if (!isMap(contents)) {
		return pairs;
	}
	for (const item of contents.items) {
		if (isScalar(item.key) && !pairs.has(String(item.key.value))) {
			pairs.set(String(item.key.value), { key: item.key, value: item.value });
		}
	}
	return pairs;
}

/**
 * The pair for `key`, or `undefined` when the frontmatter has no such key. Distinguishing
 * "absent" from "present but unusable" is the whole reason this is separate from
 * `readStringField`: a caller that falls back only when a key is missing entirely needs that
 * distinction — `readStringField` collapses both into the same `undefined`.
 */
export function findScalarPair(
	fm: Frontmatter,
	key: string,
): ScalarPair | undefined {
	return collectScalarPairs(fm).get(key);
}

export interface StringField {
	value: string;
	/** the node a diagnostic about this value should point at (see `ResolvedValue.locNode`) */
	loc: Loc;
}

/**
 * A pair's value as a non-empty string plus the loc to blame, or `undefined` when the value is
 * empty, null, or not a string scalar at all.
 *
 * That `undefined` is what lets every rule downstream of `skill/frontmatter-schema` stay silent
 * on a malformed value instead of adding a second diagnostic about it: the schema rule owns
 * emptiness and value types, so a rule checking a *property* of the string (does it match the
 * directory, does it carry a prefix) has nothing to say when there is no string.
 */
export function readStringValue(
	fm: Frontmatter,
	pair: ScalarPair,
): StringField | undefined {
	const { value, locNode } = resolveValueAndLoc(fm, pair);
	if (isEmptyValue(value)) {
		return undefined;
	}
	if (!(isScalar(value) && typeof value.value === "string")) {
		return undefined;
	}
	return { value: value.value, loc: locOf(fm, locNode) };
}

/** `findScalarPair` + `readStringValue`: the usable string under `key`, if there is one. */
export function readStringField(
	fm: Frontmatter,
	key: string,
): StringField | undefined {
	const pair = findScalarPair(fm, key);
	return pair === undefined ? undefined : readStringValue(fm, pair);
}
