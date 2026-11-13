import { resolve } from "node:path";
import { z } from "zod";
import { DOCS_URL } from "../../diagnostic.js";
import {
	collectRootAliases,
	GLOB_CHARS,
	PATH_RUN,
	type RootAlias,
	rewriteToTarget,
	trimTrailingPunctuation,
} from "../../mentions.js";
import {
	freezeRule,
	type Report,
	type RuleReport,
	type ScanRule,
} from "../../rule.js";
import { AllowlistSchema, createAllowlistTracker } from "./allowlist.js";

const RULE_ID = "refs/no-dangling-paths";

export const OptionsSchema = z.strictObject({
	/**
	 * Entries are whole candidate paths spelled exactly as this rule reports them:
	 * repo-root-relative, posix, and already stripped of the sentence punctuation
	 * `trimTrailingPunctuation` removes (`.claude/skills/acme-retired`, never
	 * `.claude/skills/acme-retired.`).
	 *
	 * The only option there is: a path carries its own surface root, so there is nothing a user
	 * has to supply before the rule can say something true, which is what puts this rule in both
	 * tiers. An unconfigured run gets `allowlist: []` from the field default — see
	 * `AllowlistSchema` on why the default is on the field and not on the schema.
	 */
	allowlist: AllowlistSchema,
});
export type Options = z.infer<typeof OptionsSchema>;

/**
 * Escapes every character that carries meaning inside a regex, so a surface root can be spliced
 * into `pathPattern`'s alternation as a literal.
 *
 * Not decoration: every built-in surface root begins with `.` (`.claude/skills`,
 * `.cursor/rules`), and an unescaped `.` matches ANY character — an unescaped alternation would
 * read `Xclaude/skills/foo` as a hit on `.claude/skills`. A root is a user-supplied config value
 * on top of that, so it is untrusted input to a `new RegExp` either way.
 */
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The scan pattern: a root alias (`collectRootAliases`), a slash, and at least one more character.
 *
 * **Not preceded by `/`, `~` or a word character.** `~/.claude/skills/foo` (a user-level skill
 * directory — the single commonest path mention in agent-facing documentation) and
 * `/abs/.claude/skills/foo` are not this repository's paths and are skipped, and the word
 * character keeps `mydocs/skills/x` from matching a `docs/skills` root. Written as a lookbehind
 * so `GrepHit.col` still points at the path itself rather than at the character in front of it.
 *
 * **At least one character after the slash**, which is what makes a bare surface root mentioned
 * in prose (`files under .claude/skills are…`, or `.claude/skills/` with nothing after it) not an
 * item reference: there is no item there to have gone missing.
 *
 * **The whole match IS the candidate path**, root included, so which alternation branch won is
 * never something the caller has to be told: `rewriteToTarget` reads the alias back off the text.
 *
 * Lexical, for the same reason any `scan` rule is: it reads every tracked file's raw text, most
 * of which is not markdown, so there is no parse to lean on.
 */
function pathPattern(aliases: readonly RootAlias[]): RegExp {
	const alternation = aliases.map(({ alias }) => escapeRegExp(alias)).join("|");
	return new RegExp(`(?<![\\w/~])(?:${alternation})/${PATH_RUN}`, "g");
}

/**
 * A literal path pointing into a known surface root that resolves to nothing — the mention a
 * moved or renamed item directory leaves behind in a script, a CI file or a paragraph of prose.
 *
 * A path names its own surface root, so a literal mention of one is unambiguous on its own — no
 * code-span requirement, no required option, and both tiers.
 *
 * ## What it reads, and what "exists" means
 *
 * The corpus is `ctx.grep`'s — every tracked file's raw text, not just markdown, minus this run's
 * own `skillslurp.json` and anything the top-level `ignore` excludes. The
 * config-file exclusion is what makes the staleness guard below reachable at all: without it
 * every `allowlist` entry would match its own literal in the config file that declares it, and no
 * entry could ever stop matching.
 *
 * A candidate exists iff `ctx.git.trackedFileIndex()` has it — a tracked file, or a directory
 * some tracked path sits under. Git's index, not the filesystem, for the reason
 * `links/resolve` uses the same index: a CI checkout only has tracked files, so an existing but
 * untracked path is not one a reader of this repository can follow. The strict-prefix case stays
 * a violation and gets no accidental pass — `.claude/skills/foo` when only
 * `.claude/skills/foo-bar` exists is not a directory anything is tracked under, because the index
 * holds a path's real ancestors and never a prefix of one of its segments.
 *
 * ## Spokes and symlinked roots
 *
 * A mention may name a surface's root through a spelling git has no entries for: a spoke
 * (`spokes` on the surface, declared in a config or found by zero-config detection) or a root
 * that is itself a symlink. Git lists a symlink under its own path and nothing below it, so
 * `.claude/skills/foo/SKILL.md` can never be found in the index as written, however valid it is.
 * Every such spelling (see `collectRootAliases`) is recognized and its head is rewritten onto the
 * surface's real root before the index is asked, so the mention is judged against the hub item it
 * reaches. A run with no spokes and no symlinked root is judged exactly as before.
 *
 * A mention is found when EITHER the path as written or the rewritten one is tracked: an
 * item-level spoke is a real directory, and what git tracks in it besides the item links (a
 * README) is tracked under the spoke's own path, which only the written spelling can find. A
 * directory-level spoke that is a symlink to anywhere else than the hub is no spelling of the
 * hub and is not recognized (`isAliasOfHub`).
 *
 * Only the lookup sees the rewritten path. The diagnostic keeps the spelling the user wrote, and
 * so does the allowlist: an entry is matched against the mention as it stands in the file.
 *
 * ## Order of the two gates
 *
 * Existence first, allowlist second: an entry counts as used only when it actually suppressed a
 * violation, so the staleness guard holds in both halves (the mention disappeared, or
 * the path came back).
 *
 * ## What gets reported
 *
 * One diagnostic per HIT, spanning the trimmed path (so a sentence's full stop is not highlighted
 * as part of it). Stale allowlist entries follow, as `config/stale-allowlist` at `error` whatever
 * this rule is configured at (`allowlist.ts`), because they are a statement about the
 * configuration rather than about the repository.
 *
 * Report order is `ctx.grep`'s own (file, line, col), not re-sorted here, then the stale entries
 * in the order they were configured.
 *
 * ## Known and bounded
 *
 * The message embeds the matched path verbatim, and the run it comes from is bounded only by
 * whitespace (`GrepHit.text`'s own doc warns about exactly this): a tracked, non-ignored file
 * with one enormous unwrapped line that happens to contain a surface root would produce one
 * enormous message. Left as-is rather than capped at a number nobody could justify.
 *
 * A `scan` rule dispatches once per surface it is enabled on while the corpus is repo-wide,
 * so two surfaces produce two identical diagnostics for one hit and `dedupeDiagnostics` collapses
 * them; two surfaces with different allowlists do not, and an allowlist is therefore a property
 * of one surface's dispatch rather than a repo-wide mute button.
 */
export const noDanglingPaths: ScanRule<Options> = freezeRule({
	kind: "scan",
	meta: {
		id: RULE_ID,
		description:
			"A path written out in the text, such as `.claude/skills/<skill>/reference.md` in inline code, that points into a linted directory at a file that is missing or not tracked by Git.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	check: async (ctx) => {
		const allowlist = createAllowlistTracker(ctx.options.allowlist);
		const aliases = await collectRootAliases(ctx);
		const tracked = await ctx.git.trackedFileIndex();
		// Guarded rather than handed to `pathPattern`: an empty alternation is `(?:)`, which
		// matches the empty string, so the pattern would degrade to "any `/`-prefixed run not
		// preceded by a word character" and report most of the repository. Unreachable through
		// `runEngine` (see `collectRootAliases`), and the allowlist is deliberately left
		// untouched on this path, so an entry that suppressed nothing is still stale.
		const hits =
			aliases.length === 0 ? [] : await ctx.grep(pathPattern(aliases));

		const reports: Report[] = [];
		for (const hit of hits) {
			const candidate = trimTrailingPunctuation(hit.text);
			if (GLOB_CHARS.test(candidate)) {
				continue;
			}
			const target = rewriteToTarget(candidate, aliases);
			if (
				tracked.has(resolve(ctx.root, candidate)) ||
				tracked.has(resolve(ctx.root, target))
			) {
				continue;
			}
			if (allowlist.allows(candidate)) {
				continue;
			}
			reports.push({
				message: `Path "${candidate}" does not exist or is not tracked by git`,
				file: hit.file,
				loc: {
					line: hit.line,
					col: hit.col,
					endLine: hit.line,
					// Exclusive, matching mdast's own `position.end.column` convention that every
					// other `Loc` in this project is built from (`locOfNode`, links.ts). The
					// TRIMMED length: the span is the path, not the sentence punctuation behind
					// it.
					endCol: hit.col + candidate.length,
				},
			} satisfies RuleReport);
		}
		reports.push(...allowlist.staleReports(RULE_ID));
		return reports;
	},
});
