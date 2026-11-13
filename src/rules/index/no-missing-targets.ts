import { DOCS_URL } from "../../diagnostic.js";
import { freezeRule, type ProjectRule, type RuleReport } from "../../rule.js";
import {
	type IndexOptions,
	IndexOptionsSchema,
	loadIndexAnalysis,
} from "./shared.js";

export const OptionsSchema = IndexOptionsSchema;
export type Options = IndexOptions;

/**
 * Every link inside a surface's configured index file, whose target falls within that surface's
 * root, must resolve to something real — the companion to `index/complete` (see that rule's own
 * JSDoc for how the two fit together and why neither alone is enough).
 *
 * Same opt-in shape as `index/complete`: `tiers: []`, `file` required, no default — see
 * `IndexOptionsSchema` (`shared.ts`). Configured identically:
 *
 * ```json
 * {
 *   "surfaces": [
 *     {
 *       "root": ".claude/skills",
 *       "rules": {
 *         "index/no-missing-targets": {
 *           "severity": "error",
 *           "options": { "file": "SKILLS.md" }
 *         }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * ## Scope: "ghost" is about existence, not about being an entry
 *
 * A link outside the surface root entirely (`../../LICENSE`, a scheme URL, an anchor) is ignored
 * outright — the same "not every link in an index doc is an index entry" decision
 * `index/complete` makes, computed once in `shared.ts`'s `classifyLinks` so the two rules cannot
 * quietly disagree about which links are in scope. Within the surface root, a link that resolves
 * to something git is TRACKING is never a ghost — including a tracked file that is not itself a
 * discovered entry document (a skill's own `reference.md`, say): that link satisfies neither
 * rule (it is not a ghost here, and it is not an entry document for `index/complete` to demand a
 * link to). "Real, but not an entry" is a deliberate third answer to the shared classification,
 * not a gap in it: the two rules ask different questions and this link answers neither.
 *
 * "Exists" means the git index, not `stat` (`TrackedFileIndex` in links.ts — the same
 * lookup `links/resolve` uses, so the two rules cannot disagree about a path). A wrong-case link
 * is a ghost on every OS rather than only on Linux CI; a link to a present-but-untracked file is
 * a ghost too, and the message says so.
 *
 * This rule does not reuse `links/resolve`'s own diagnostic for the same reason `links/resolve`
 * runs on every document regardless: they check different documents (this rule reads only the
 * one configured index file) and would otherwise double-report the identical broken link if the
 * index file itself is ever discovered as an ordinary document too.
 *
 * ## What gets reported
 *
 * One diagnostic per ghost link, positioned at that link's own span inside the index file
 * (`target.loc`) — not at file 1:1, unlike `index/complete`'s per-entry reports, because a ghost
 * IS a specific node in a specific document, and that is exactly what a diagnostic should point
 * at. Sorted by position (line, then column) before being returned, matching `index/complete`'s
 * own explicit-sort habit — see the comment at the sort call for why this is written as an
 * explicit step rather than assumed.
 *
 * The configured `file` itself missing (or escaping the repository) is, again, not one of these:
 * it is the same single `missingFileReport` (`rules/configured-document.ts`) `index/complete`
 * reports — a `config/missing-file` diagnostic against the config file at `error`, not a
 * diagnostic under this rule's own id at this rule's own severity.
 */
export const indexNoMissingTargets: ProjectRule<Options> = freezeRule({
	kind: "project",
	meta: {
		id: "index/no-missing-targets",
		description:
			"A link in the configured index to a file inside the linted directory that is missing or not tracked by Git.",
		docsUrl: DOCS_URL,
		// Opt-in: `file` has no sensible default. See `index/complete`'s identical note.
		tiers: [],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	check: async (ctx) => {
		const result = await loadIndexAnalysis(ctx);
		if (result.kind === "missing") {
			return [result.report];
		}

		// No sort here, deliberately — unlike `index/complete`'s own explicit sort, one
		// would be provably dead code, not merely unproven-but-harmless: `result.ghosts` is
		// built by `classifyLinks` (shared.ts) from `collectLinkTargets`'s walk over `indexDoc`,
		// and that walk visits a `link`/`image`/`definition` node in PRE-ORDER, which for these
		// three node types is exactly source order (`collectLinkTargets`'s own doc, links.ts,
		// pinned by `links/resolve.test.ts`'s "returns ... in document order" test) — a
		// filter preserves relative order, so `ghosts` cannot be anything but non-decreasing in
		// (line, col) no matter what markdown text produced it, since a linear text document has
		// no way to place a later link at an earlier position. There is no fixture, direct
		// `check(ctx)` call included, that could make this observable: measured, deleting the
		// comparator that used to sit here left every case in this suite green, including the
		// "multiple ghosts" ordering case below (which pins the RESULT order as a regression
		// test on `classifyLinks`, not on a sort this rule no longer has).
		return result.ghosts.map(
			(target): RuleReport => ({
				message: `Index link target "${target.url}" does not exist or is not tracked by git`,
				file: result.indexPath,
				loc: target.loc,
			}),
		);
	},
});
