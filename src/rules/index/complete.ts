import { DOCS_URL, START_LOC } from "../../diagnostic.js";
import { freezeRule, type ProjectRule, type RuleReport } from "../../rule.js";
import {
	type IndexOptions,
	IndexOptionsSchema,
	loadIndexAnalysis,
} from "./shared.js";

export const OptionsSchema = IndexOptionsSchema;
export type Options = IndexOptions;

/**
 * Every entry document a surface discovers must be linked from that surface's configured index
 * file — the companion to `index/no-missing-targets`, which checks the opposite direction (every
 * link in the index must resolve to something real). Together they make an index file trustworthy
 * as a table of contents: `complete` alone would tolerate an index whose links are all broken as
 * long as it merely LOOKS like it mentions everything; `no-missing-targets` alone would tolerate a
 * perfectly accurate index that quietly forgot to mention half the surface.
 *
 * Opt-in only (`tiers: []`, `file` required — see `IndexOptionsSchema` in `shared.ts`: there is
 * no index file every surface would want, so a tier claiming this rule would make an
 * unconfigured run exit 2), and written per surface:
 *
 * ```json
 * {
 *   "surfaces": [
 *     {
 *       "root": ".claude/skills",
 *       "rules": {
 *         "index/complete": {
 *           "severity": "error",
 *           "options": { "file": "SKILLS.md" }
 *         }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * An "entry" is a markdown link, not a name in prose or a table cell — deliberate, and the only
 * form that is resolvable at all: `classifyLinks` (`shared.ts`) walks `link`/`image`/`definition`
 * nodes and resolves each node's `url` to a path, which a bare name in prose does not give it. What
 * actually happens, end to end, lives in `loadIndexAnalysis`/`classifyLinks` (`shared.ts`): this
 * file only decides what to report once that analysis exists.
 *
 * ## What gets reported
 *
 * One diagnostic per discovered entry document (`doc.surface === ctx.surface`, see `shared.ts`
 * for the consequence of leaning on that) that is not the resolved target of at least one link
 * inside the index file — sorted by path before being returned (see the comment at the sort
 * call: this repo's rules order their own reports rather than lean on an incidental upstream
 * order, per CLAUDE.md's determinism habit). Two or more links to the same entry are fine: this
 * rule only asks "at least one", never "exactly one".
 *
 * A link to a DIRECTORY that merely contains an entry document — `[widgets](skills/widgets/)`,
 * a very ordinary index style — satisfies nothing: it resolves inside the surface root and
 * exists, but its resolved target is the directory itself, not `skills/widgets/SKILL.md`, so
 * the entry is still reported unlinked. The author gets no more specific hint than that —
 * a deliberate non-fix, not an oversight: counting a directory link as satisfying the entry it
 * contains would be a real contract change (which entry document, if a directory ever held more
 * than one?), not a quiet behavior change here.
 *
 * The configured `file` itself not existing on disk (or resolving outside the repository) is NOT
 * one of these per-entry diagnostics, and it is not even one of this rule's own: it is a single
 * `config/missing-file` diagnostic against the config file, at `error` whatever severity this
 * rule is configured at, naming the configured path in its message (`missingFileReport`,
 * `rules/configured-document.ts` — see that function's doc for why this is a `ConfigReport`
 * rather than a diagnostic at this rule's own severity).
 */
export const indexComplete: ProjectRule<Options> = freezeRule({
	kind: "project",
	meta: {
		id: "index/complete",
		description:
			"An entry document that the configured index does not link to.",
		docsUrl: DOCS_URL,
		// Opt-in: `file` has no sensible default, so a tier claiming this rule would make an
		// unconfigured run exit 2. See `IndexOptionsSchema` (shared.ts).
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

		const unlinked = result.entryDocs.filter(
			(doc) => !result.linkedEntryPaths.has(doc.path),
		);
		// Explicit, not incidental — and genuinely load-bearing, not merely belt-and-suspenders:
		// `runEngine` re-sorts every diagnostic by (file, line, col, ...) before
		// returning it, so no case run through `RuleTester` can ever tell this sort from its
		// absence — measured, reversing or deleting this comparator leaves every end-to-end case
		// in `complete.test.ts` green. What DOES discriminate is calling `check(ctx)` directly
		// with a hand-built `ctx.documents()` that returns entries out of path order —
		// `complete.test.ts`'s "direct check() call" section does exactly that, and fails the
		// moment this comparator is reversed or removed. Discovery happens to hand back entry
		// documents already path-sorted (discover.ts) today, but nothing in `ctx.documents()`'s
		// own contract forces that to stay true for every caller — a hand-built context (this
		// rule's own direct-call test; any future one) is free to return any order at all — so
		// this rule keeps ordering its own output rather than trusting an upstream order it does
		// not control, per CLAUDE.md's determinism habit.
		const sorted = [...unlinked].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		);

		return sorted.map(
			(doc): RuleReport => ({
				message: `Entry document "${doc.path}" is not linked from index file "${result.indexPath}"`,
				file: doc.path,
				loc: START_LOC,
			}),
		);
	},
});
