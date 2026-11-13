/**
 * Reading a document's *activation* frontmatter — the key (`paths`, `globs`, `applyTo`) a
 * dialect consults to decide whether a document applies to a given file at all.
 *
 * Extracted from `activation/consistent-scope`, when `activation/no-unmatched-globs`
 * became the second rule that has to answer "what patterns does this key carry?". There is
 * exactly one parser for that question, here, because two rules disagreeing about whether
 * `paths: [a, b]` is two patterns or one would be a difference nobody could see in either
 * rule's own tests: one would compare a scope the other never reports on.
 *
 * Nothing here executes a check, compares two dialects, or matches a pattern against anything —
 * it reads a `Frontmatter` and hands back patterns plus the positions to blame.
 */

import { isScalar, isSeq } from "yaml";
import type { Loc } from "../diagnostic.js";
import { BUILTIN_DIALECTS } from "../dialects.js";
import type { Document, Frontmatter } from "../document.js";
import type { RuleReport } from "../rule.js";
import {
	collectScalarPairs,
	describeType,
	isEmptyValue,
	locOf,
	resolveValueAndLoc,
	type ScalarPair,
} from "./frontmatter.js";

/**
 * What one dialect sees when it looks for its own activation key in this document:
 *
 * - `absent` — the dialect's key (and every legacy fallback of it) is missing, so the document
 *   is always eligible in that tool.
 * - `empty` — a key IS present but carries nothing (`paths:`, `paths: ""`, `paths: []`,
 *   `paths: ["", " "]`). Same *meaning* as `absent` — nothing scopes the document — which is why
 *   the two compare equal in `consistent-scope`; they are kept apart only so a message can
 *   say which of the two shapes it found.
 * - `patterns` — the key's value, split and normalized (deduped + sorted): the set of globs that
 *   scope the document in that tool.
 * - `opaque` — a LEGACY key is what the dialect reads (`cursor`'s skills-`globs`) and the caller
 *   asked for `"opaque"` legacy handling. The vendor documents no value shape for such a key, so
 *   the value is not parsed and this scope carries only the key name; see
 *   `consistent-scope`'s `scopeKey` for what that means for comparison, and
 *   `LegacyValuePolicy` for when a caller asks for the other treatment instead.
 */
export type ActivationScope =
	| { readonly kind: "absent" }
	| { readonly kind: "empty"; readonly key: string }
	| {
			readonly kind: "patterns";
			readonly key: string;
			/** already trimmed, deduped and sorted by `normalizeActivationPatterns` */
			readonly patterns: readonly string[];
	  }
	| { readonly kind: "opaque"; readonly key: string };

/**
 * Indexes of the `{` and `}` that pair up, nesting included. A `{` with no closing brace, and a
 * `}` with no opening one, pair with nothing and are absent from the set.
 */
function balancedBraces(raw: string): ReadonlySet<number> {
	const balanced = new Set<number>();
	const open: number[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		if (raw[i] === "{") {
			open.push(i);
		} else if (raw[i] === "}") {
			const start = open.pop();
			if (start !== undefined) {
				balanced.add(start);
				balanced.add(i);
			}
		}
	}
	return balanced;
}

/**
 * Splits one scalar activation value into its patterns: comma-separated, each part trimmed,
 * empty parts dropped (`"a, ,b,"` → `["a", "b"]`).
 *
 * A comma inside a balanced `{…}` group is not a separator, nested groups included (`"src/*.{ts,tsx}"`
 * is one pattern), because neither vendor documents splitting there and leaving the group whole is
 * the reading that reports less; an unclosed `{` has no group to protect and splits as before.
 *
 * Exported for direct unit testing rather than because a second caller needs it — see
 * `outOfSyncMessage`'s JSDoc (consistent-scope.ts) for why no pair of real built-in dialects
 * can drive this function to an observable disagreement through `RuleTester`.
 */
export function splitActivationScalar(raw: string): string[] {
	const balanced = balancedBraces(raw);
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < raw.length; i += 1) {
		if (balanced.has(i)) {
			depth += raw[i] === "{" ? 1 : -1;
		} else if (raw[i] === "," && depth === 0) {
			parts.push(raw.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(raw.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Canonical form of one dialect's pattern list: trimmed, empties dropped, deduped, sorted.
 *
 * Sorting is what makes ordering irrelevant to `consistent-scope`'s comparison (`[b, a]` and
 * `[a, b]` are the same scoping), and deduping is what makes a repeated glob irrelevant (`[a, a]`
 * scopes exactly what `[a]` does). Plain `Array#sort` — code-unit order, never `localeCompare`,
 * which is locale-dependent and would make a rendered message differ between machines (same
 * reason `engine.ts`'s `compareDiagnostics` compares with `<`).
 *
 * Both properties matter to `no-unmatched-globs` too, for a different reason: it reports one
 * diagnostic per dead pattern, so a duplicated glob must not produce two identical diagnostics,
 * and the report order must not depend on the order a user happened to write the list in.
 *
 * Exported for direct unit testing; see `outOfSyncMessage`'s JSDoc.
 */
export function normalizeActivationPatterns(
	parts: readonly string[],
): string[] {
	const cleaned = parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return [...new Set(cleaned)].sort();
}

/**
 * Every frontmatter key on this document that some dialect of its surface consults for
 * activation, mapped to whether that key is a contract's PRIMARY key (as opposed to a
 * `legacyKeys` fallback).
 *
 * Both are collected, and a key that is primary for any dialect stays primary — unlike
 * `consistent-scope`'s `chooseKey`, which applies the vendor's precedence and stops at the
 * primary. The two rules ask different questions: that one asks "which key does this tool
 * actually read?", `no-unmatched-globs` asks "which globs has this document written down?". A
 * Cursor skill carrying both `paths` and the legacy `globs` has two lists of globs, and a stale
 * glob in the one Cursor does not currently read is still a stale glob — it is exactly the
 * leftover a half-finished `globs` → `paths` migration produces.
 */
export function activationKeys(doc: Document): ReadonlyMap<string, boolean> {
	const keys = new Map<string, boolean>();
	for (const id of doc.surface.dialects) {
		const activation =
			BUILTIN_DIALECTS[id].contracts[doc.surface.kind]?.activation;
		if (activation === undefined) {
			continue;
		}
		keys.set(activation.key, true);
		for (const legacy of activation.legacyKeys ?? []) {
			if (!keys.has(legacy)) {
				keys.set(legacy, false);
			}
		}
	}
	return keys;
}

/** The activation key one dialect actually reads in this document, and where it came from. */
export interface ChosenKey {
	readonly key: string;
	readonly pair: ScalarPair;
	/** false when `key` is a `legacyKeys` fallback rather than the contract's primary key */
	readonly isPrimary: boolean;
}

/**
 * Either the scope one key carries, or the type violation(s) that make its value unusable.
 * They are alternatives, never both: a value that cannot be read is not a value that can be
 * compared or matched.
 */
export type KeyOutcome =
	| { readonly kind: "scope"; readonly scope: ActivationScope }
	| { readonly kind: "violations"; readonly reports: readonly RuleReport[] };

/**
 * What `readScope` does with a key whose value shape no vendor documents — i.e. a `legacyKeys`
 * fallback (today, only `cursor`'s skills-`globs`).
 *
 * - `"opaque"` — do not parse it; report only that the key is present (`ActivationScope`'s
 *   `opaque`). What `activation/consistent-scope` asks for: it *compares* two dialects' scopes,
 *   and a value with no documented shape cannot be proven equal to anything.
 * - `"parse"` — read it exactly the way a primary key is read. What `activation/no-unmatched-globs`
 *   asks for; that rule's own JSDoc carries the inference, the source and the fetch date, since
 *   this is the one place in the codebase that reads past a documented shape.
 *
 * A required parameter rather than a defaulted one: which of the two a rule wants is a decision
 * about undocumented vendor behaviour, and the two callers answer it differently. A default
 * would let a third caller inherit an answer it never thought about.
 */
export type LegacyValuePolicy = "opaque" | "parse";

/** `patterns` when there is anything left after normalization, `empty` when there is not. */
function patternsOrEmpty(key: string, parts: readonly string[]): KeyOutcome {
	const patterns = normalizeActivationPatterns(parts);
	if (patterns.length === 0) {
		return { kind: "scope", scope: { kind: "empty", key } };
	}
	return { kind: "scope", scope: { kind: "patterns", key, patterns } };
}

/**
 * Reads a value whose shape a vendor documents: a comma-separated scalar, or a YAML sequence of
 * strings. Anything else is a type violation.
 *
 * The splitter is deliberately NOT a parameter: both `ActivationSplitter` values are read the same
 * way here, a flow sequence included, which `activation/value-shape` reports separately for the
 * keys whose contract lists it in `nonActivatingShapes` — see `consistent-scope`'s "the two
 * splitters are indistinguishable here" section.
 *
 * A sequence item is one whole pattern and is NOT comma-split: a list already says where each
 * pattern ends, so splitting its items again would invent a second delimiter the vendor never
 * wrote.
 */
function readDocumentedValue(
	fm: Frontmatter,
	key: string,
	value: unknown,
	locNode: unknown,
): KeyOutcome {
	if (isScalar(value) && typeof value.value === "string") {
		return patternsOrEmpty(key, splitActivationScalar(value.value));
	}

	if (isSeq(value)) {
		const parts: string[] = [];
		const reports: RuleReport[] = [];
		for (const [index, item] of value.items.entries()) {
			// A sequence item can be an alias (`paths: [*shared]`) exactly as a mapping value
			// can, and it is the RESOLVED node that has to be judged — an Alias wrapper is
			// neither Scalar nor collection and would otherwise be reported as an unreadable
			// item on perfectly valid yaml. `resolveValueAndLoc` is what owns that resolution
			// (and the "which node does a diagnostic blame" question) for the whole rule layer,
			// so it is reused here with the item standing in for both halves of the pair: an
			// item is its own key and its own value, and both of the helper's branches then
			// blame the item itself, which is exactly the node to point at.
			const resolved = resolveValueAndLoc(fm, { key: item, value: item });
			// A null or blank item carries no pattern and is dropped, the same way an empty
			// segment of a comma-separated scalar is (`"a,,b"`). Dropping it before the type
			// check also keeps `paths: [~]` out of the violation branch, where `describeType`
			// would have to call a null scalar an "object".
			if (isEmptyValue(resolved.value)) {
				continue;
			}
			if (
				isScalar(resolved.value) &&
				typeof resolved.value.value === "string"
			) {
				parts.push(resolved.value.value);
				continue;
			}
			reports.push({
				// Zero-based, like the yaml node's own index — the `loc` points straight at the
				// offending item, so the number is a label rather than the only way to find it.
				message: `Frontmatter key "${key}" must be a list of strings, but item ${index} is a ${describeType(resolved.value)}`,
				loc: locOf(fm, resolved.locNode),
			});
		}
		if (reports.length > 0) {
			return { kind: "violations", reports };
		}
		return patternsOrEmpty(key, parts);
	}

	return {
		kind: "violations",
		reports: [
			{
				message: `Frontmatter key "${key}" must be a string or a list of strings, got ${describeType(value)}`,
				// The value node, matching `skill/frontmatter-schema`'s convention for a
				// complaint about a value's SHAPE. `consistent-scope`'s out-of-sync report
				// blames the KEY node instead, because that complaint is about which key is
				// present, not about what its value looks like.
				loc: locOf(fm, locNode),
			},
		],
	};
}

/**
 * Reads one chosen key into a scope, or into the type violations that stop it being readable.
 *
 * `legacyValues` decides what happens to a key with no documented value shape; see
 * `LegacyValuePolicy`. The empty check runs BEFORE that branch on purpose, so an empty list on a
 * LEGACY key is `empty` too, not an `opaque` scope that could never match anything.
 *
 * Note what `"opaque"` costs, deliberately: `globs: 42` on a legacy key becomes an out-of-sync
 * divergence rather than a type violation, because with no documented value shape there is no
 * type for it to violate. Flagging it would be exactly the invented constraint `dialects.ts`'s
 * header rules out — and in the one built-in case that reaches that branch nothing is lost by
 * not flagging it, since the document is reported as out of sync anyway: the primary key is
 * absent (or this key would not have been chosen), so every dialect reading that primary sees an
 * unscoped document.
 */
export function readScope(
	fm: Frontmatter,
	chosen: ChosenKey,
	legacyValues: LegacyValuePolicy,
): KeyOutcome {
	const { key, pair, isPrimary } = chosen;
	const { value, locNode } = resolveValueAndLoc(fm, pair);

	// Present but carrying nothing: `key:`, `key: ""`, `key: []`. The empty SEQ needs its own
	// clause — `isEmptyValue` only knows about nulls and blank strings.
	if (isEmptyValue(value) || (isSeq(value) && value.items.length === 0)) {
		return { kind: "scope", scope: { kind: "empty", key } };
	}

	if (!isPrimary && legacyValues === "opaque") {
		return { kind: "scope", scope: { kind: "opaque", key } };
	}

	return readDocumentedValue(fm, key, value, locNode);
}

/**
 * Matcher options, chosen to agree with discovery rather than picked fresh.
 *
 * `discover.ts` and `detect.ts` both call tinyglobby with `dot: true`, and tinyglobby hands
 * picomatch `{ dot, nobrace: false, nocase: false, noextglob: false, noglobstar: false, posix:
 * true }` (read off tinyglobby 0.2.17's `dist/index.mjs`, 2026-09-05). Everything but `dot` and
 * `posix` there is already picomatch's own default, so these two are the whole difference — and
 * matching them is what makes "this glob is live" mean the same thing as "discovery would have
 * found this file".
 *
 * `dot: true` is load-bearing, not cosmetic: every surface this linter checks lives under a dot
 * directory, and with picomatch's default `dot: false` a perfectly ordinary `**\/*.md` does not
 * match `.claude/skills/x/SKILL.md` at all (measured, picomatch 4.0.7, 2026-09-05). A rule that
 * called such a glob dead would be a false positive on the most common input there is.
 */
export const MATCH_OPTIONS = Object.freeze({ dot: true, posix: true });

/**
 * One distinct activation glob this document declares, and every key that carries it.
 *
 * `pair` belongs to the FIRST key in `keys` — the occurrence a diagnostic blames — so it is the
 * argument `locOfPattern` needs and not a description of the other keys.
 */
export interface DeclaredGlob {
	readonly pattern: string;
	/** document order, never empty */
	readonly keys: readonly string[];
	readonly pair: ScalarPair;
}

/**
 * Every distinct activation glob this document declares, one entry per pattern however many keys
 * carry it. Entries come in first-occurrence order: keys in document order (from
 * `collectScalarPairs`, which walks the mapping's items), patterns within a key in the deduped,
 * sorted order `readScope` returns them in; a pattern met again under a later key adds that key
 * to the entry it already has instead of opening a second one. Neither order depends on anything
 * a user can reshuffle without changing what the document means.
 *
 * Grouping by pattern is what keeps a document that carries one glob under both `paths` and
 * `globs` — every `[claude-code, cursor]` rules file, and a Cursor skill mid-migration — from
 * being told about the same dead glob twice.
 *
 * Two shapes are dropped here rather than reported:
 *
 * - **a value that is neither a string nor a list of strings** (`globs: {}`). `readScope` hands
 *   back type violations for it; this reader discards them. Value types are not its callers' job:
 *   `skill/frontmatter-schema` reports one only when the key is `required`, and
 *   `activation/consistent-scope` only where two dialects on the surface activate, so reporting
 *   it here too would say nothing new. Known gap, stated rather than hidden: anywhere else
 *   nothing reports such a value at all today.
 * - **a negated pattern** (`!**\/*.test.ts`). No vendor documents negation for any activation
 *   key — not Claude Code's `paths`, not Cursor's `paths`/`globs`, not Copilot's `applyTo`
 *   (all re-checked 2026-09-05; see `dialects.ts` for each page and date). picomatch DOES honour
 *   a leading `!` by inverting the match, so treating such a pattern as an ordinary glob would
 *   make it "live" precisely when it excludes everything. Neither trusted nor flagged: skipped,
 *   and recorded here so the omission is a decision rather than an oversight.
 *
 * The result and everything reachable from it except `pair`'s yaml nodes is frozen.
 */
export function declaredGlobs(
	doc: Document,
	fm: Frontmatter,
): readonly DeclaredGlob[] {
	const activation = activationKeys(doc);
	const grouped = new Map<
		string,
		{ pattern: string; keys: string[]; pair: ScalarPair }
	>();
	for (const [key, pair] of collectScalarPairs(fm)) {
		const isPrimary = activation.get(key);
		if (isPrimary === undefined) {
			continue;
		}
		// `"parse"`: unlike `consistent-scope`, `no-unmatched-globs` reads a legacy key's value
		// rather than treating it as opaque — see that rule's JSDoc for the inference.
		const outcome = readScope(fm, { key, pair, isPrimary }, "parse");
		if (outcome.kind !== "scope" || outcome.scope.kind !== "patterns") {
			continue;
		}
		for (const pattern of outcome.scope.patterns) {
			if (pattern.startsWith("!")) {
				continue;
			}
			const seen = grouped.get(pattern);
			if (seen === undefined) {
				grouped.set(pattern, { pattern, keys: [key], pair });
			} else {
				seen.keys.push(key);
			}
		}
	}
	return Object.freeze(
		[...grouped.values()].map(({ pattern, keys, pair }) =>
			Object.freeze({ pattern, keys: Object.freeze(keys), pair }),
		),
	);
}

/**
 * The yaml node a diagnostic about `pattern` should blame.
 *
 * A real YAML sequence has one node per pattern, so the report points straight at the offending
 * item. A comma-separated scalar (`globs: "docs/**, src/**"`) has no per-piece node to point at —
 * the pieces exist only after `splitActivationScalar` — so every piece of one scalar is blamed on
 * that scalar, and the message is what tells the two apart.
 *
 * The item lookup is by trimmed value, not by index: `readScope` dedupes and sorts the patterns
 * it returns, so the position of a pattern in that list says nothing about which item it came
 * from. Ties (the same glob written twice) collapse to the first occurrence, which is also the
 * only one still in the deduped list.
 */
export function locOfPattern(
	fm: Frontmatter,
	pair: ScalarPair,
	pattern: string,
): Loc {
	const { value, locNode } = resolveValueAndLoc(fm, pair);
	if (isSeq(value)) {
		for (const item of value.items) {
			const resolved = resolveValueAndLoc(fm, { key: item, value: item });
			if (
				isScalar(resolved.value) &&
				typeof resolved.value.value === "string" &&
				resolved.value.value.trim() === pattern
			) {
				return locOf(fm, resolved.locNode);
			}
		}
	}
	return locOf(fm, locNode);
}
