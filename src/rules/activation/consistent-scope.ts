import { isMap } from "yaml";
import { DOCS_URL } from "../../diagnostic.js";
import {
	type ActivationKey,
	BUILTIN_DIALECTS,
	type DialectId,
} from "../../dialects.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import {
	type ActivationScope,
	type ChosenKey,
	normalizeActivationPatterns,
	readScope,
	splitActivationScalar,
} from "../activation.js";
import { collectScalarPairs, locOf, type ScalarPair } from "../frontmatter.js";

/**
 * `ActivationScope`, the two normalizers and `readScope` moved to `rules/activation.ts`,
 * when `activation/no-unmatched-globs` became the second rule that has to read the same keys — one
 * parser, two rules, per that module's own header. Re-exported here so every existing importer
 * (this rule's own test suite, which pins both normalizers directly) keeps working unchanged.
 */
export type { ActivationScope };
export { normalizeActivationPatterns, splitActivationScalar };

/** One dialect of the surface, plus what that dialect reads out of the document. */
export interface ActivationView {
	readonly dialect: DialectId;
	readonly scope: ActivationScope;
}

/**
 * The equality key two scopes must share to count as "the same activation". Two dialects agree
 * iff their scopes produce the same string here:
 *
 * - both unscoped (`absent` or `empty`, in any combination) — nothing limits the document in
 *   either tool, so there is nothing out of sync;
 * - both `patterns` with the identical normalized list. The KEY NAME is deliberately not part of
 *   this: two tools reading different key names that both resolve to `["docs/**"]` scope the
 *   document identically, which is precisely the state this rule wants to see;
 * - both `opaque` on the SAME key name. Same key on the same document means the same value,
 *   whatever shape that value has, so they cannot disagree.
 *
 * The asymmetry worth stating out loud: `opaque` is never equal to `absent`/`empty` or to
 * `patterns`, and two `opaque`s on DIFFERENT keys are never equal either. That is not a claim
 * that they differ — with no documented value shape, an `opaque` value cannot be *proven* equal
 * to anything — and this rule reports what it cannot prove consistent. The alternative
 * (assume-equal) turns the one divergence today's built-ins can actually produce — a Cursor
 * skill scoped by legacy `globs` that Claude Code reads as unscoped — into a silent pass, which
 * is the false green the rule exists to prevent.
 *
 * `JSON.stringify` of a tagged tuple rather than a hand-joined string: a pattern containing the
 * separator (globs legitimately contain almost any character) must not be able to collide with
 * another scope's key.
 */
function scopeKey(scope: ActivationScope): string {
	switch (scope.kind) {
		case "absent":
		case "empty":
			return JSON.stringify(["none"]);
		case "patterns":
			return JSON.stringify(["patterns", scope.patterns]);
		case "opaque":
			return JSON.stringify(["opaque", scope.key]);
	}
}

/** How one group of agreeing dialects is described in the diagnostic message. */
function describeScope(scope: ActivationScope): string {
	switch (scope.kind) {
		case "absent":
			return "unscoped (no activation key present)";
		case "empty":
			return `unscoped ("${scope.key}" is empty)`;
		case "patterns":
			return `"${scope.key}" = ${scope.patterns.join(", ")}`;
		case "opaque":
			return `scoped by "${scope.key}" (legacy key; its value shape is undocumented, so it cannot be compared)`;
	}
}

interface ScopeGroup {
	/** every dialect whose scope has this group's equality key; sorted at render time */
	readonly dialects: DialectId[];
	/** the scope of the lexicographically-first dialect in `dialects` (see `outOfSyncMessage`) */
	scope: ActivationScope;
	/** the id whose scope `scope` currently is, so a later, smaller id can take its place */
	lead: DialectId;
}

/**
 * The message for a set of views, or `undefined` when every view agrees (`scopeKey`) — the pure
 * core of this rule's comparison, over views that are already normalized.
 *
 * **Why this is exported rather than left private**, in the same spirit as `mergeContractList`
 * (dialects.ts): no combination of REAL built-in dialects can exercise most of what it does.
 * Two surface kinds have two activating dialects, `skills` and `rules`, both as `claude-code` +
 * `cursor`. On `skills` they name the same primary key `paths` with the same splitter, so where
 * `paths` is present the two views are identical BY CONSTRUCTION; the divergences a real skill
 * can produce are a Cursor skill setting the legacy `globs` with no `paths`. On `rules` they name
 * different primary keys (`paths` and `globs`) with different splitters, so a rule file scoped by
 * only one of them, or by two different lists, diverges for real. All of that is covered end to
 * end by the rule's own `RuleTester` cases. A three-way disagreement, or two `opaque` scopes on
 * different keys, is still unreachable there: no kind has three activating dialects, and
 * `RuleTester`'s `surface.dialects` accepts built-in `DialectId`s only. A test has to hand this
 * function synthetic views to pin those, and this is the function such a test calls.
 *
 * Rendering, all of it deterministic:
 *
 * - views are grouped by `scopeKey`, so dialects that agree are named together;
 * - a group prints its dialect ids sorted and comma-joined, then the description of the scope
 *   belonging to the FIRST of those ids. The only way two members of one group can describe
 *   themselves differently is `absent` vs `empty` (equal, since both mean unscoped), so the
 *   choice is cosmetic — but it is still pinned to the lexicographically-first id rather than to
 *   insertion order, because insertion order is the surface's `dialects:` order, which a user
 *   can reshuffle without changing what the document means;
 * - groups are ordered by their sorted id list. Every dialect lands in exactly one group, so no
 *   two groups can share that key and the order is total.
 */
export function outOfSyncMessage(
	views: readonly ActivationView[],
): string | undefined {
	const groups = new Map<string, ScopeGroup>();
	for (const { dialect, scope } of views) {
		const key = scopeKey(scope);
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, { dialects: [dialect], scope, lead: dialect });
			continue;
		}
		group.dialects.push(dialect);
		if (dialect < group.lead) {
			group.lead = dialect;
			group.scope = scope;
		}
	}

	if (groups.size <= 1) {
		return undefined;
	}

	const rendered = [...groups.values()]
		.map((group) => {
			const dialects = [...group.dialects].sort();
			return {
				order: dialects.join(","),
				text: `${dialects.join(", ")}: ${describeScope(group.scope)}`,
			};
		})
		.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));

	return `Activation is out of sync across this surface's dialects — ${rendered
		.map((group) => group.text)
		.join("; ")}`;
}

/**
 * Which key a dialect reads: its primary key when present, otherwise the first of its
 * `legacyKeys` that is present, otherwise nothing.
 *
 * The primary always wins, and when it is present the legacy keys are not even looked at. That
 * is the vendor's own framing — Cursor calls `globs` "a fallback", and a fallback applies when
 * the primary is absent — recorded once, on `ActivationKey.legacyKeys` (dialects.ts), so this
 * rule and any future reader cannot drift apart on it. Consequence, pinned by a test: on a
 * `[claude-code, cursor]` skills surface a document carrying BOTH `paths` and `globs` is in
 * sync, because `paths` is the primary key of both dialects and neither one ever looks at
 * `globs`.
 */
function chooseKey(
	activation: ActivationKey,
	pairs: ReadonlyMap<string, ScalarPair>,
): ChosenKey | undefined {
	const primary = pairs.get(activation.key);
	if (primary !== undefined) {
		return { key: activation.key, pair: primary, isPrimary: true };
	}
	for (const legacy of activation.legacyKeys ?? []) {
		const pair = pairs.get(legacy);
		if (pair !== undefined) {
			return { key: legacy, pair, isPrimary: false };
		}
	}
	return undefined;
}

/**
 * Every dialect on the surface must end up scoping the document the same way. A skill that is
 * path-scoped in one tool and always-eligible in another is not a skill the repo can claim
 * works in both.
 *
 * The surface's `dialects` list is the repo's own claim that this document has to work in every
 * tool it names. This rule checks that claim against the document's activation keys, which is
 * why `defaultSeverity` is `"error"` and not the `"warn"` `file/max-lines` carries: an over-long
 * file is style guidance a repo can reasonably tune, while a document that activates in one
 * listed tool and not in another contradicts the configuration outright — the file simply does
 * not do what the surface says it does.
 *
 * ## What it compares
 *
 * For each dialect in `doc.surface.dialects`, the contract for `doc.surface.kind` supplies an
 * `activation` key (dialects.ts). The document is read once per dialect into an `ActivationView`
 * — see `ActivationScope` for the four shapes — and the views are compared by `scopeKey`. All
 * equal: nothing to say. Otherwise ONE report for the document (never one per pair), naming each
 * group of agreeing dialects and what it sees, positioned on the KEY node of the
 * earliest-starting activation key present in the document.
 *
 * ## The gate, and the reading it deliberately rejects
 *
 * A dialect whose contract defines NO activation key at all (`generic`, `codex`, `opencode`, and
 * `copilot`'s skills contract) is EXCLUDED from the comparison — not treated as a dialect that
 * sees the document as always-eligible. Fewer than two remaining dialects and the rule reports
 * nothing, which is why a single-dialect surface never produces a diagnostic even though the
 * rule still runs on its documents.
 *
 * The broader reading (a dialect with no activation key is "always eligible", so any scoped
 * document diverges from it) was considered and rejected because it
 * would report every path-scoped skill on the extremely common `[claude-code, generic]` surface,
 * where narrowing a skill to `paths:` is a deliberate, documented choice rather than a defect.
 * That is a rule nobody could leave on. The narrow scope catches strictly less, and what it does
 * catch is a genuine contradiction between two tools that BOTH document an activation key.
 *
 * ## Type violations short-circuit the comparison
 *
 * If any dialect's primary key holds something that is neither a string nor a list of strings,
 * the rule reports only that — deduped by key name, so two dialects reading the same broken key
 * produce one report, in document order — and skips the comparison entirely. A second diagnostic
 * saying two dialects disagree about a value nobody can read adds confusion, not information;
 * fix the value and the comparison becomes meaningful.
 *
 * Values this rule stays quiet about, because another rule owns them or nothing does: a document
 * with no frontmatter, or with frontmatter that is not a mapping (`skill/frontmatter-schema`
 * reports both, and a second diagnostic would say nothing new), and a LEGACY key's value of any
 * shape (see `readScope`).
 *
 * ## Stated limitation: an empty primary key silences the legacy fallback
 *
 * `chooseKey` keys off key PRESENCE, not usefulness, so a present-but-empty primary (`paths:`,
 * `paths: ""`, `paths: []`) is still the key its dialect reads and the `legacyKeys` fallback is
 * never consulted — even when `globs` right below it carries real patterns. Every dialect then
 * reads the same unscoped document, they agree, and nothing is reported. That silence is
 * deliberate; pinned by one `valid` case per spelling.
 *
 * Reporting instead would mean assuming Cursor treats an empty `paths` as absent and therefore
 * falls back to `globs`. Cursor documents neither half of that, and the assumption is exactly the
 * undocumented guess `dialects.ts`'s module header forbids: a linter that invents a constraint
 * produces false positives on valid input, which is worse than missing a violation.
 *
 * The tension with the `opaque` stance above is real, and naming it is better than smoothing it
 * over: there this rule reports what it cannot prove consistent, here it stays quiet about
 * something it equally cannot prove. What separates them is WHICH question is undocumented.
 * `opaque` is a value whose SHAPE is unknown while its presence is certain — a key is there, and
 * it scopes the document somehow. This case is about whether a key counts as present at all, and
 * for that question the conservative reading (present means present) happens to also be the
 * literal one.
 *
 * The cost, stated plainly rather than left to be discovered: a half-finished migration that
 * empties `paths` but leaves `globs` populated is a shape this rule will not catch.
 *
 * ## Stated limitation: the two splitters are indistinguishable here
 *
 * `ActivationSplitter`'s two values (`comma-scalar`, `list-or-string`) are behaviourally
 * IDENTICAL for this rule. Both document a comma-separated scalar; the only documented
 * difference is that `comma-scalar` does not document a YAML sequence — and treating an
 * undocumented sequence as a type violation would be exactly the invented constraint
 * `dialects.ts`'s header rules out, so a sequence is accepted under both. For a block sequence
 * that is now backed by evidence: a check of 2026-10-19 (Cursor 3.25.9) saw a rule
 * with a block-sequence `globs` attach. The same check saw a flow sequence (`globs: [a]`) not
 * attach. That is recorded as `nonActivatingShapes` on the cursor rules `activation` key rather
 * than as a splitter, because `comma-scalar` is also `copilot`'s `applyTo`, which nobody checked,
 * and `activation/value-shape` reports it. This rule, `activation/no-unmatched-globs` and
 * `activation/max-glob-share` still read `globs: [a]` as the pattern `a`. The field stays in the
 * dialect data because it records what each vendor documents. `activation/no-unmatched-globs`
 * was the candidate that might have needed the distinction and turned out not to: it
 * matches each pattern against the tracked-file list one at a time, and how a value was split
 * into patterns is settled before it ever sees them. Nothing branches on the splitter anywhere,
 * and this rule's tests can only pin that both values are handled the same way, never that they
 * differ.
 */
export const consistentScope: FileRule = freezeRule({
	kind: "file",
	meta: {
		id: "activation/consistent-scope",
		description:
			"A file whose activation keys disagree between the formats that read it, such as `globs` set for Cursor but no `paths` for Claude Code.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	check(doc: Document): RuleReport[] {
		const fm = doc.frontmatter;
		if (fm === null) {
			return [];
		}
		// Frontmatter that is not a mapping (a bare scalar, a list, an empty block) belongs to
		// `skill/frontmatter-schema`, which already reports it; a second diagnostic would say
		// nothing new. Stated as an explicit early return rather than left implicit — but it is a
		// SHORT-CIRCUIT, not a behaviour: `collectScalarPairs` returns an empty map for a
		// non-mapping, from which every dialect reads an `absent` scope and they all agree, so
		// deleting these three lines cannot change a single answer (measured: the whole suite
		// stays green without them). Kept because the ownership claim is worth writing where a
		// reader looks for it, not because anything downstream depends on it.
		if (!isMap(fm.doc.contents)) {
			return [];
		}

		// A dialect with no contract for the surface's kind is skipped defensively — `loadConfig`
		// and the RuleTester's `buildSurface` both reject such a surface before a `Document` can
		// carry it — while a contract with no `activation` is skipped by design (see the gate in
		// this rule's JSDoc).
		const activating: { id: DialectId; activation: ActivationKey }[] = [];
		for (const id of doc.surface.dialects) {
			const activation =
				BUILTIN_DIALECTS[id].contracts[doc.surface.kind]?.activation;
			if (activation !== undefined) {
				activating.push({ id, activation });
			}
		}
		if (activating.length < 2) {
			return [];
		}

		const pairs = collectScalarPairs(fm);

		const views: ActivationView[] = [];
		/**
		 * key name -> its reports. Keying by the key NAME is the dedupe: two dialects reading the
		 * same broken key must complain once, not once each. Overwriting rather than
		 * first-write-wins is safe and left unguarded on purpose — for one key name there is only
		 * ever one possible report list, since `readScope` is a pure function of the frontmatter
		 * and the chosen key, and the one thing that can differ between two dialects choosing the
		 * same name (primary versus legacy) never produces a violation on the legacy side.
		 */
		const violations = new Map<string, readonly RuleReport[]>();
		/** every key name some dialect actually reads, for the report's position */
		const involved = new Set<string>();

		for (const { id, activation } of activating) {
			const chosen = chooseKey(activation, pairs);
			if (chosen === undefined) {
				views.push({ dialect: id, scope: { kind: "absent" } });
				continue;
			}
			involved.add(chosen.key);
			// `"opaque"`: this rule COMPARES two dialects' scopes, and a value whose shape no
			// vendor documents cannot be proven equal to anything — see `LegacyValuePolicy`
			// (rules/activation.ts) and `scopeKey` above.
			const outcome = readScope(fm, chosen, "opaque");
			if (outcome.kind === "violations") {
				violations.set(chosen.key, outcome.reports);
				continue;
			}
			views.push({ dialect: id, scope: outcome.scope });
		}

		if (violations.size > 0) {
			// Document order, taken from `pairs` (a Map filled by walking the mapping's items in
			// order) rather than re-sorting by node range: every violating key came out of that
			// same map, so iterating it is both the order the keys appear in the file and a
			// guarantee that nothing is missed.
			const reports: RuleReport[] = [];
			for (const key of pairs.keys()) {
				const forKey = violations.get(key);
				if (forKey !== undefined) {
					reports.push(...forKey);
				}
			}
			return reports;
		}

		const message = outOfSyncMessage(views);
		if (message === undefined) {
			return [];
		}

		// The earliest activation key present in the document, by the same document-order
		// argument as above. At least one key IS present whenever the views disagree: with none
		// present, every view would be `absent`, they would all be equal, and `outOfSyncMessage`
		// would have returned `undefined` — so this loop always finds one, and the `undefined`
		// that would otherwise flow into `locOf` (where it degrades to the frontmatter block's
		// own position) is unreachable rather than a branch worth writing.
		let blamed: unknown;
		for (const [key, pair] of pairs) {
			if (involved.has(key)) {
				blamed = pair.key;
				break;
			}
		}

		return [{ message, loc: locOf(fm, blamed) }];
	},
});
