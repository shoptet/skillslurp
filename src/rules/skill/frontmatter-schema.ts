import { isMap, isNode, isScalar, isSeq } from "yaml";
import { z } from "zod";
import { DOCS_URL } from "../../diagnostic.js";
import { mergeContracts } from "../../dialects.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import { activationKeys, readScope } from "../activation.js";
import {
	blockLoc,
	collectScalarPairs,
	describeType,
	FENCE_LOC,
	isEmptyValue,
	locOf,
	resolveValueAndLoc,
	START_LOC,
} from "../frontmatter.js";

export const OptionsSchema = z.strictObject({
	/**
	 * Overrides the surface's dialect-derived `required` list wholesale — it does not extend it.
	 * Omitted (the common case): falls back to `mergeContracts(doc.surface.dialects,
	 * doc.surface.kind)?.required`, or `[]` when the surface's dialects define no contract for
	 * its kind at all (see `mergeContracts`'s own JSDoc for why that is defensive, not a real
	 * CLI path). A required key is always allowed, even if a custom `allowed` omits it — see
	 * below.
	 */
	required: z.array(z.string()).optional(),
	/**
	 * Overrides the surface's dialect-derived `allowed` list wholesale — it does not extend it.
	 * Omitted: falls back to `mergeContracts(...)?.allowed`, which is `undefined` when the
	 * surface's dialects define no contract for its kind — and an `undefined` allowed set means
	 * "unknowable", not "empty": check 4 is skipped entirely rather than flagging every key (see
	 * `check`). Writing `allowed: []` explicitly is different from omitting the key: it makes the
	 * effective allowed set exactly `required` and check 4 still runs.
	 *
	 * The rule's *effective* allowed set is always the union of this list and `required` — a
	 * required key is always allowed, whether or not it is also listed here.
	 */
	allowed: z.array(z.string()).optional(),
});
export type Options = z.infer<typeof OptionsSchema>;

/**
 * Display form for a mapping key in a diagnostic message: a Scalar key prints as its plain
 * value (`String(key.value)`); a non-scalar (yaml collection) key — parses fine, so the engine
 * never short-circuits it away, but it can never match a string in `required`/`allowed` —
 * prints as a JSON-ish stringified form instead. Defensive edge case: a
 * `null` key (an explicit-key mapping entry with no key node at all, e.g. `?\n: x`) is handled
 * too, and `toJSON()` is guarded in case the key's content is cyclic or an unresolved alias.
 */
function keyDisplay(key: unknown): string {
	if (isScalar(key)) {
		return String(key.value);
	}
	if (isNode(key)) {
		try {
			return JSON.stringify(key.toJSON());
		} catch {
			return "?";
		}
	}
	return JSON.stringify(key);
}

/** Null, a blank string, an empty list or an empty mapping: a value that carries nothing. */
function isEmptyAnyShape(value: unknown): boolean {
	return (
		isEmptyValue(value) ||
		((isSeq(value) || isMap(value)) && value.items.length === 0)
	);
}

/**
 * Validates a skill's YAML frontmatter against its surface's dialect contract(s)
 * (`mergeContracts(doc.surface.dialects, doc.surface.kind)`), with `options.required`/
 * `options.allowed` as optional, wholesale overrides — never an addition to the dialect-derived
 * list. `required` falls back to `[]`, and an ABSENT `allowed` (no option, no dialect contract —
 * the latter only on the defensive path `mergeContracts` documents) means "unknowable", so
 * check 4 is skipped rather than flagging every key as unexpected. A surface naming several
 * dialects (`dialects: [claude-code, generic]`) is checked against their MERGE — `required` and
 * `allowed` are unions, so a key any listed tool demands or documents is required/allowed here
 * too (see `mergeContracts`'s own header table for the full polarity, including `name` patterns
 * and `maxLengths`).
 *
 * Eight checks. The order below is this function's own push order, not an external contract: the
 * engine's `compareDiagnostics` (engine.ts) always re-sorts the final diagnostic list by
 * file → line → col → ruleId → message before it leaves the engine, so this order is only ever
 * observable by a caller invoking `check()` directly. No rule *fixture* can be such a caller —
 * the RuleTester runs every case through `runEngine`, never `rule.check` — and the only direct
 * callers in the repo are two unit tests in `links/resolve.test.ts` that need one rule's raw,
 * unsorted output. Listed for the reader of the implementation below, not as a promise about
 * reported order:
 *
 * 1. no frontmatter block at all
 * 2. frontmatter present but not a YAML mapping
 * 3. a required key (options or dialect-derived) is missing
 * 4. a key outside the effective allowed set is present (skipped when `allowed` is unknowable)
 * 5. a required key that IS present has an empty value: null or a blank string; also an empty
 *    list or mapping unless a dialect on the surface requires or documents the key as a string;
 *    also a list of only blank or null items when the key is a primary activation key (`paths`,
 *    `globs`, `applyTo`)
 * 6. a required key that IS present has the wrong type, judged only where a source documents
 *    one: a key some dialect on the surface requires, or documents as a string by capping its
 *    length (`maxLengths`, for any key), must be a string; a primary activation key must be a
 *    string or a list of strings (messages from `rules/activation.ts`); any other required key is
 *    not type-checked
 * 7. `name` is present as a non-empty string and fails every dialect's charset pattern
 *    (`mergeContracts(...)?.names`) — independent of whether `name` is required: a dialect can
 *    leave `name` optional (claude-code) yet still constrain its shape when written, and a
 *    multi-dialect surface's stricter dialect (e.g. `generic`) applies its pattern regardless of
 *    whether the other dialect(s) on the same surface would have accepted it
 * 8. any key with a documented `maxLengths` cap (`name`, `description`, `compatibility`, or
 *    whatever else a future dialect caps) is present as a non-empty string and exceeds it
 *
 * Checks 1 and 2 are skipped for a document with no block or an empty one when the merged
 * contract's `frontmatter` is `optional` (every listed dialect says so: Claude Code's skills and
 * rules): such a document has no keys, so only a required key (the `required` option) is
 * reported missing, at 1:1 (no block) or on the opening fence (empty block). A bare scalar or a
 * list is still reported by check 2 there. Everywhere else the block is required.
 */
export const frontmatterSchema: FileRule<Options> = freezeRule({
	kind: "file",
	meta: {
		id: "skill/frontmatter-schema",
		description:
			"Frontmatter that breaks the configured formats: none where one is needed, a missing required key, a key the format does not allow, or a value of the wrong type where the format documents one.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	check(doc: Document, ctx): RuleReport[] {
		const fm = doc.frontmatter;
		// `merged` is `undefined` only on the defensive path `mergeContracts` itself documents:
		// both `loadConfig` and the RuleTester's `buildSurface` already reject any dialect with
		// no contract for `doc.surface.kind`, so every dialect in `doc.surface.dialects` — a
		// real config or a real rule test can never hand this `check` anything else — is
		// guaranteed to contribute a contract, making `merged` (here and at every `merged`/
		// `allowed`-unknowable branch below) unreachable through any path this rule's own tests
		// can construct. Handled anyway, not asserted away, on the same "no dialect-shaped input
		// should ever crash the rule" grounds `mergeContracts` gives for returning `undefined`
		// instead of throwing.
		const merged = mergeContracts(doc.surface.dialects, doc.surface.kind);

		// Deduped, first-occurrence order: a `required` list with a repeated entry (e.g.
		// `["name", "name"]`) must not make checks 3/5/6 visit that key twice and emit
		// byte-identical duplicate reports.
		const requiredKeys = [
			...new Set(ctx.options.required ?? merged?.required ?? []),
		];

		// A document the surface's tools read without any frontmatter (see `frontmatter` on the
		// contract) has no keys, so only a key the config demands anyway can be missing.
		if (
			merged?.frontmatter === "optional" &&
			(fm === null || fm.doc.contents === null)
		) {
			return requiredKeys.map((key) => ({
				message: `Missing required frontmatter key "${key}"`,
				loc: fm === null ? START_LOC : FENCE_LOC,
			}));
		}

		// Check 1: no frontmatter block at all — nothing else is checkable.
		if (fm === null) {
			return [{ message: "Missing YAML frontmatter block", loc: START_LOC }];
		}

		const contents = fm.doc.contents;

		// Check 2: present but not a mapping (empty/null block, a bare scalar, or a list).
		if (!isMap(contents)) {
			return [
				{ message: "Frontmatter must be a YAML mapping", loc: blockLoc(fm) },
			];
		}

		// undefined here means "unknowable" (no option, no dialect contract), not "empty" —
		// checked below, not folded into a `?? []` the way `required` is.
		const allowed = ctx.options.allowed ?? merged?.allowed;

		// First occurrence of each entry, keyed by `String(key.value)` — see
		// `collectScalarPairs` for what that key collapses and why. Checks 3/5/6/7/8 all read
		// this map; check 4 walks `contents.items` directly instead, so it still sees a
		// second, shadowed pair under the same stringified key.
		const scalarPairs = collectScalarPairs(fm);

		const reports: RuleReport[] = [];

		// Check 3: missing required keys, in options order.
		for (const key of requiredKeys) {
			if (!scalarPairs.has(key)) {
				reports.push({
					message: `Missing required frontmatter key "${key}"`,
					loc: FENCE_LOC,
				});
			}
		}

		// Check 4: unexpected keys, in mapping (document) order — skipped entirely when the
		// allowed set is unknowable (see `allowed`'s comment above), rather than flagging every
		// single key as unexpected.
		if (allowed !== undefined) {
			const effectiveAllowed = new Set([...allowed, ...requiredKeys]);
			const sortedAllowed = [...effectiveAllowed].sort();
			const allowedSuffix =
				sortedAllowed.length > 0
					? ` (allowed: ${sortedAllowed.join(", ")})`
					: "";

			for (const item of contents.items) {
				const keyStr = keyDisplay(item.key);
				if (effectiveAllowed.has(keyStr)) {
					continue;
				}
				reports.push({
					message: `Unexpected frontmatter key "${keyStr}"${allowedSuffix}`,
					loc: locOf(fm, item.key),
				});
			}
		}

		// Checks 5 & 6: every required key that IS present, in options order.
		const activation = activationKeys(doc);
		const stringKeys = new Set<string>(merged?.required);
		if (merged) {
			for (const key of Object.keys(merged.maxLengths)) {
				stringKeys.add(key);
			}
		}
		const emptyReport = (key: string, locNode: unknown): RuleReport => ({
			message: `Frontmatter key "${key}" must not be empty`,
			loc: locOf(fm, locNode),
		});
		for (const key of requiredKeys) {
			const pair = scalarPairs.get(key);
			if (!pair) {
				continue;
			}
			const { value, locNode } = resolveValueAndLoc(fm, pair);

			if (activation.get(key) === true) {
				const outcome = readScope(fm, { key, pair, isPrimary: true }, "parse");
				if (outcome.kind === "violations") {
					reports.push(...outcome.reports);
				} else if (outcome.scope.kind === "empty") {
					reports.push(emptyReport(key, locNode));
				}
				continue;
			}

			if (stringKeys.has(key)) {
				if (isEmptyValue(value)) {
					reports.push(emptyReport(key, locNode));
				} else if (!(isScalar(value) && typeof value.value === "string")) {
					reports.push({
						message: `Frontmatter key "${key}" must be a string, got ${describeType(value)}`,
						loc: locOf(fm, locNode),
					});
				}
				continue;
			}

			if (isEmptyAnyShape(value)) {
				reports.push(emptyReport(key, locNode));
			}
		}

		// Check 7: `name`'s format, against every distinct pattern the surface's dialects
		// document — independent of whether `name` is required (see the rule's own JSDoc).
		// Empty is check 5's job. A non-string is check 6's job only when `name` is required and
		// is a string key (a format requires it or caps its length); otherwise it is left
		// unreported (there is no format to test against a list or a number).
		if (merged && merged.names.length > 0) {
			const namePair = scalarPairs.get("name");
			if (namePair) {
				const { value, locNode } = resolveValueAndLoc(fm, namePair);
				if (
					!isEmptyValue(value) &&
					isScalar(value) &&
					typeof value.value === "string"
				) {
					const nameValue = value.value;
					for (const { pattern, patternDescription } of merged.names) {
						if (!pattern.test(nameValue)) {
							reports.push({
								message: `Frontmatter key "name" must contain only ${patternDescription}`,
								loc: locOf(fm, locNode),
							});
						}
					}
				}
			}
		}

		// Check 8: documented max lengths (name/description/compatibility, or any future
		// dialect-capped key), for every present key whose value is a non-empty string scalar.
		// Iterates `scalarPairs` (document order, one entry per distinct key) rather than
		// `merged.maxLengths`'s keys, so the report order is the file's own order, not the
		// contract's.
		if (merged) {
			for (const [key, pair] of scalarPairs) {
				// `Object.hasOwn`, not a bare `merged.maxLengths[key]` read: `mergeContractList`
				// (dialects.ts) already builds this record with `Object.create(null)` so a
				// prototype member can never answer a lookup by a frontmatter key that happens to
				// share its name; this guard is the read-side half of that hardening and becomes
				// live once a config-defined dialect can contribute its own `maxLengths`.
				if (!Object.hasOwn(merged.maxLengths, key)) {
					continue;
				}
				const cap = merged.maxLengths[key];
				if (cap === undefined) {
					continue;
				}
				const { value, locNode } = resolveValueAndLoc(fm, pair);
				if (
					isEmptyValue(value) ||
					!(isScalar(value) && typeof value.value === "string")
				) {
					continue;
				}
				// Code points (`[...value].length`), not UTF-16 units (`value.length`): a single
				// astral-plane character (e.g. an emoji outside the BMP) is one code point but two
				// UTF-16 code units, so `.length` alone would count it twice and flag a value one
				// character too long. Not grapheme clusters either — a ZWJ emoji sequence
				// (visually one glyph) still counts as several code points here.
				const length = [...value.value].length;
				if (length > cap) {
					reports.push({
						message: `Frontmatter key "${key}" must be at most ${cap} characters (found ${length})`,
						loc: locOf(fm, locNode),
					});
				}
			}
		}

		return reports;
	},
});
