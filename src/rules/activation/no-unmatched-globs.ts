import picomatch from "picomatch";
import { isMap } from "yaml";
import type { RuleContext } from "../../context.js";
import { DOCS_URL } from "../../diagnostic.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import { declaredGlobs, locOfPattern, MATCH_OPTIONS } from "../activation.js";

/**
 * True when `pattern` matches at least one path in `tracked`.
 *
 * Pure string matching: `tracked` is the repo-root-relative posix list `git ls-files` printed,
 * and nothing here touches the filesystem. That is what makes the awkward inputs free rather
 * than special cases — an absolute glob (`/etc/passwd`) and a `..`-escaping one
 * (`../outside/*.md`) simply match nothing in a root-relative list, with no `stat` on the way to
 * disagree with that answer.
 *
 * There is no try/catch, and that rests on one measured fact plus one invariant. Measured
 * (picomatch 4.0.7, 2026-09-05): a malformed pattern does not throw at the compile step — `(`,
 * `)`, `+(`, `@(a`, `{`, `a{b`, `[[:alpha:`, `a[b-` and `!(` each returned a matcher that simply
 * answered `false`, so a pattern nobody can parse is reported as dead, which is the answer a
 * user needs anyway. The one input that DOES throw is the empty string ("Expected pattern to be
 * a non-empty string"), and the invariant is that it cannot get here: three independent filters
 * in `rules/activation.ts` each drop an empty part — `readDocumentedValue`'s `isEmptyValue` skip
 * for a sequence item, `splitActivationScalar`'s length filter for a comma-separated scalar, and
 * `normalizeActivationPatterns`'s own, after both. Every pattern this function receives
 * therefore has at least one non-whitespace character. Verified by removing all three at once,
 * which does produce that TypeError.
 *
 * The options object is frozen and reused across every call; picomatch was checked against the
 * same list of patterns and did not write to it (same measurement).
 */
function isLive(pattern: string, tracked: readonly string[]): boolean {
	const matches = picomatch(pattern, MATCH_OPTIONS);
	for (const path of tracked) {
		if (matches(path)) {
			return true;
		}
	}
	return false;
}

/**
 * Every activation glob a document declares must still match something, so that a renamed or
 * deleted target cannot leave a document that silently never activates. A skill scoped to
 * `paths: "src/legacy/**"` after `src/legacy/` was deleted is not a narrowly-scoped skill; it is
 * a skill that is switched off, and nothing in the repo says so.
 *
 * `error` in both tiers, for the same reason `activation/consistent-scope` is: this is not style
 * guidance a repo can reasonably tune, it is configuration that contradicts the repo it sits in.
 *
 * ## Which keys
 *
 * Five built-in contracts declare an activation key (`dialects.ts`): claude-code skills `paths`;
 * claude-code rules `paths`; cursor skills `paths`, with the legacy `globs` as a fallback; cursor
 * rules `globs`; copilot instructions `applyTo`. Every one of those key names that is present on the document is
 * checked — including BOTH of a Cursor skill's, when it carries both; see `activationKeys` for
 * why this rule does not apply the vendor's primary-beats-legacy precedence the way
 * `consistent-scope` does. Splitting a value into patterns is `rules/activation.ts`'s job,
 * not a second parser here: a comma-separated scalar becomes one pattern per piece, a YAML
 * sequence one pattern per item.
 *
 * ## One report per dead pattern
 *
 * The same dead pattern under two keys (`paths` and `globs` on a `[claude-code, cursor]` rules
 * file) is one report: positioned on its first occurrence in document order, naming every key
 * that carries it, as `(frontmatter keys "paths", "globs")`. A pattern under a single key keeps
 * the wording `(frontmatter key "paths")`.
 *
 * ## The universe is the whole tracked list — documented for one key, inferred for the rest
 *
 * A glob is live iff it matches at least one path in `ctx.git.trackedFiles()`: repo-root-relative
 * posix paths, the entire list, NOT scoped to the surface's own root.
 *
 * **This is documented for one key, and inferred from vendor examples for the others.** Claude
 * Code's rules page (https://code.claude.com/docs/en/memory, fetched 2026-10-01) gives a pattern
 * table for `paths` with "`*.md` | Markdown files in the project root", which fixes the base for
 * a pattern in that key at the project root. It shows no pattern for a rules file in a nested
 * directory, so the base there is not documented and the whole-list reading below is what covers
 * it. Not one of the vendor quotes `dialects.ts` records for the other keys says what the globs
 * are relative to, and re-fetching Cursor's two pages on 2026-09-05 turned up no such sentence
 * either. The only evidence is Cursor's rules page (https://cursor.com/docs/rules, fetched at its
 * earlier address cursor.com/docs/context/rules on that date),
 * whose examples are workspace-root paths — `src/components/**\/*.tsx`, `docs/**\/*.md,
 * docs/**\/*.mdx`, `src/**`, and `*.ts` glossed as "All `.ts` files in the root". Those are the
 * only paths that make sense at all: a glob resolved against `.cursor/rules/` could never reach
 * `src/**`, which is the vendor's own first example. Recorded as an inference per this repo's
 * vendor-claim habit — if a vendor ever documents the base, this paragraph is what has to be
 * checked against it.
 *
 * The consequence is worth stating plainly, because it is the half a "globs are relative to the
 * surface" reading would get wrong: a glob that matches only files OUTSIDE the surface root
 * (`src/**\/*.ts` declared in `.cursor/rules/foo.mdc`) is live, and this rule says nothing about
 * it.
 *
 * ## Tracked, and nothing but tracked
 *
 * The tracked list is the universe in the strict sense: a glob whose only match is an untracked
 * file — gitignored, or new and not yet `git add`ed — is dead. That is the CI-faithful answer,
 * and the reason to prefer it: a CI checkout contains the tracked files and nothing else, so a
 * glob kept alive by a local, uncommitted file is a glob that is already dead everywhere the
 * repository is actually consumed.
 *
 * Matching is pure string matching — see `isLive`. No `stat`, no directory walk, nothing that
 * could make the answer depend on the machine the linter runs on.
 *
 * ## Reading the legacy key's value: an explicit inference
 *
 * `dialects.ts` records that Cursor documents no value shape at all for skills-`globs`, and that
 * "a future rule that genuinely has to parse a legacy key's value has to fetch a source first".
 * The source was re-fetched (cursor.com/docs/context/skills, 2026-09-05): the page still names
 * `globs` only in one sentence — "The legacy `globs` field is still accepted as a fallback for
 * older skills, but new skills should use `paths`." — and still gives it no shape. So this rule
 * reads it exactly the way it reads `paths`, and that is an inference, recorded here.
 *
 * What makes it a safe one is that it is the CONSERVATIVE reading, not merely the convenient
 * one. The only question the undocumented shape leaves open is whether a comma is a separator or
 * a literal character. Read as a separator, `globs: "docs/**, src/**"` is two patterns, each
 * checked on its own, and a violation is reported only for a piece that is genuinely dead. Read
 * as one literal pattern, the whole string `"docs/**, src/**"` could never match any real path,
 * so the same document would be reported no matter what its pieces point at. A comma inside a
 * balanced `{…}` group is not a separator, because neither vendor documents splitting there and
 * `src/*.{ts,tsx}` torn into two dead halves would report more than leaving it whole.
 *
 * ## Not this rule's business: "over-broad"
 *
 * A glob that matches too much is `activation/max-glob-share`'s to report, as an opt-in `warn`.
 * `RuleReport` carries no severity of its own (`rule.ts`), so one rule could not report both
 * halves at two severities; this one reports a glob that matches nothing, and only that.
 */
export const noUnmatchedGlobs: FileRule = freezeRule({
	kind: "file",
	meta: {
		id: "activation/no-unmatched-globs",
		description:
			"An activation pattern that matches no Git-tracked file, so the file never loads.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	async check(doc: Document, ctx: RuleContext): Promise<RuleReport[]> {
		const fm = doc.frontmatter;
		if (fm === null) {
			return [];
		}
		// Frontmatter that is not a mapping belongs to `skill/frontmatter-schema`, which already
		// reports it. A short-circuit, not a behaviour: `collectScalarPairs` returns an empty map
		// for a non-mapping, so `declaredGlobs` would find nothing anyway.
		if (!isMap(fm.doc.contents)) {
			return [];
		}

		const globs = declaredGlobs(doc, fm);
		// The git call is deliberately behind this guard rather than at the top: a document with
		// no activation key at all — the overwhelming majority — must not make the run shell out
		// to `git ls-files`. `trackedFiles()` is memoized for the whole run (context.ts), so the
		// cost is one subprocess per run, paid only if some document actually declares a glob.
		if (globs.length === 0) {
			return [];
		}
		const tracked = await ctx.git.trackedFiles();

		const reports: RuleReport[] = [];
		for (const { pattern, keys, pair } of globs) {
			if (isLive(pattern, tracked)) {
				continue;
			}
			const noun = keys.length === 1 ? "key" : "keys";
			const named = keys.map((key) => `"${key}"`).join(", ");
			reports.push({
				message: `Activation glob "${pattern}" (frontmatter ${noun} ${named}) matches no file tracked by git`,
				loc: locOfPattern(fm, pair, pattern),
			});
		}
		return reports;
	},
});
