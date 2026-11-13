import picomatch from "picomatch";
import { isMap } from "yaml";
import { z } from "zod";
import type { RuleContext } from "../../context.js";
import { DOCS_URL } from "../../diagnostic.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import { declaredGlobs, locOfPattern, MATCH_OPTIONS } from "../activation.js";

export const OptionsSchema = z.strictObject({
	/**
	 * Required, with no default: a share of the tracked files means something different in every
	 * repository, so any default would be one repository's number. Exclusive on both ends: `0`
	 * would report every glob that matches a file, and `100` can never be exceeded.
	 */
	max: z.number().gt(0).lt(100),
});
export type Options = z.infer<typeof OptionsSchema>;

function countMatches(pattern: string, tracked: readonly string[]): number {
	const matches = picomatch(pattern, MATCH_OPTIONS);
	let count = 0;
	for (const path of tracked) {
		if (matches(path)) {
			count += 1;
		}
	}
	return count;
}

/**
 * Warns when one activation glob a document declares matches more than `max` percent of the
 * repository's tracked files: a rule scoped to `**` or to `src/**` in a repository that is mostly
 * `src/` is loaded for almost every file, which is what a rule without `paths` already is, and
 * the guidance it carries belongs in the always-loaded file instead. Opt-in (`tiers: []`) with a
 * required option, `max`, a percentage with `0 < max < 100`; `warn`, so it never changes the exit
 * status on its own.
 *
 * ## No threshold is documented, so none is built in
 *
 * Neither vendor page gives a share or a count of files above which a scoped document is too
 * broad (https://code.claude.com/docs/en/memory and https://cursor.com/docs/rules, both fetched
 * 2026-10-01). Claude Code says only that "Rules without `paths` frontmatter are loaded at launch"
 * and that a rule only for part of the codebase belongs in "a path-scoped rule". And a share is
 * not portable: `src/**\/*.ts` at 60% is ordinary in a fifty-file repository, and 5% of a
 * sixty-thousand-file monorepo is three thousand files. So `max` has no default, and enabling the
 * rule without it is a config error.
 *
 * ## What is counted
 *
 * Each distinct pattern of the document (`declaredGlobs`: every activation key a dialect of the
 * surface reads, a legacy key included, negations skipped, one entry per pattern however many keys
 * carry it) is matched against the WHOLE of `ctx.git.trackedFiles()`, with the matcher options
 * `activation/no-unmatched-globs` uses. The denominator is that whole list, not the files under
 * the surface's root. A pattern is reported when `count * 100 > max * tracked.length`: strictly,
 * so a pattern sitting exactly at the limit is not over it. `max * tracked.length` is rounded to
 * 15 significant digits first, because the float product of a decimal `max` is not always the
 * decimal one: `4.56 * 1250` is 5699.999999999999, which would put 57 of 1250 files, exactly
 * 4.56%, over a limit of 4.56.
 *
 * Counting a document's patterns one by one is deliberate: a union has no single node to point at,
 * and one pattern is what a user can narrow. A pattern under both `paths` and `globs` is one
 * report naming both keys, as `(frontmatter keys "paths", "globs")`, positioned on its first
 * occurrence; under one key the wording is `(frontmatter key "paths")`. Reports follow
 * `declaredGlobs`' order: keys in document order, a key's patterns sorted.
 *
 * A slash-less pattern is root-only, because both vendors document it so: "`*.md` | Markdown files
 * in the project root" (Claude Code) and "`*.ts` | All `.ts` files in the root" (Cursor), both
 * fetched 2026-10-01. `*.md` therefore counts `a.md` and not `x/a.md`; it is never widened to
 * `**\/*.md`. Dotfiles and dot directories count (`dot: true`, as discovery does).
 *
 * The share is rendered with one decimal, so a share just over the limit can read as the limit
 * itself (5.04% against `max: 5` renders `5.0%`, still "more than the limit of 5%").
 *
 * ## What is not this rule's business
 *
 * - A pattern that matches nothing: `activation/no-unmatched-globs` reports it. Its count is 0 and
 *   `max` is above 0, so it can never be over the limit.
 * - A document with no glob: the tracked list is not asked for at all, so a repository whose
 *   documents declare none never makes the run shell out to `git ls-files`.
 * - An empty tracked list: `0 > 0` is false, so nothing is reported and nothing is divided.
 * - The shape of an activation value: `skill/frontmatter-schema` reports it only when the key is
 *   `required`, `activation/consistent-scope` only where two dialects on the surface activate,
 *   and otherwise nothing does. A value that is neither a string nor a list of strings declares
 *   no pattern here.
 *
 * ## `--diff-base`
 *
 * This is a `file` rule, so a diff-scoped run checks it on changed documents only. An unchanged
 * document whose glob crosses the limit because other files were added goes unreported until the
 * next full run, which is the consequence `no-unmatched-globs` has too. A `project` rule would
 * report every pre-existing broad glob on every pull request instead.
 *
 * Enabled per surface like any rule: configured on a `rules` surface and absent on a `skills`
 * one, a skill's broad `paths` is not reported.
 */
export const maxGlobShare: FileRule<Options> = freezeRule({
	kind: "file",
	meta: {
		id: "activation/max-glob-share",
		description:
			"An activation pattern that matches more than `max` percent of the Git-tracked files, so the file loads almost everywhere.",
		docsUrl: DOCS_URL,
		tiers: [],
		defaultSeverity: "warn",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	async check(doc: Document, ctx: RuleContext<Options>): Promise<RuleReport[]> {
		const fm = doc.frontmatter;
		if (fm === null || !isMap(fm.doc.contents)) {
			return [];
		}

		const globs = declaredGlobs(doc, fm);
		if (globs.length === 0) {
			return [];
		}
		const tracked = await ctx.git.trackedFiles();

		const { max } = ctx.options;
		const limit = Number((max * tracked.length).toPrecision(15));
		const reports: RuleReport[] = [];
		for (const { pattern, keys, pair } of globs) {
			const count = countMatches(pattern, tracked);
			if (count * 100 > limit) {
				const noun = keys.length === 1 ? "key" : "keys";
				const named = keys.map((key) => `"${key}"`).join(", ");
				const share = ((count / tracked.length) * 100).toFixed(1);
				reports.push({
					message: `Activation glob "${pattern}" (frontmatter ${noun} ${named}) matches ${count} of ${tracked.length} tracked files (${share}%), more than the limit of ${max}%`,
					loc: locOfPattern(fm, pair, pattern),
				});
			}
		}
		return reports;
	},
});
