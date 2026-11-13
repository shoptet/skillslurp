import { dirname } from "node:path";
import { DOCS_URL } from "../../diagnostic.js";
import type { Document } from "../../document.js";
import {
	collectLinkTargets,
	type LinkNodeKind,
	resolveTarget,
	type TrackedFileIndex,
} from "../../links.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";

/**
 * The noun each node type is called by in a diagnostic. Frozen because it is module-level shared
 * data (CLAUDE.md's habit): a rule object is a singleton, so a table it reads on every document
 * must not be something one caller can rewrite for the next.
 *
 * "Link definition" rather than "Definition" for `definition`: the mdast type name means nothing
 * to someone reading a terminal, while CommonMark's own term for `[label]: destination` is a "link
 * reference definition" (spec.commonmark.org/0.31.2, §4.7, fetched 2026-09-03) — shortened by one
 * word here because the message already says what is wrong with it, and it is the phrase that
 * tells an author to go looking for a `[x]: …` line rather than for a `[x](…)` span.
 */
const NOUNS: Readonly<Record<LinkNodeKind, string>> = Object.freeze({
	link: "Link",
	image: "Image",
	definition: "Link definition",
});

/**
 * Every relative link, image and link definition in a document must point at something that is
 * actually there.
 *
 * A broken link is the one defect in this rule set that is unambiguously a defect: the file named
 * is not on disk, whatever tool reads the document and whatever the repo's conventions are. That
 * is why `defaultSeverity` is `"error"` rather than the `"warn"` `file/max-lines` carries — a line
 * count is guidance a repo tunes, a missing target is a fact — and why the rule is not `fixable`:
 * knowing a path is wrong says nothing about which path was meant.
 *
 * ## No scope gate
 *
 * Like `file/max-lines` — and like `skill/frontmatter-schema`, which despite its namespace gates
 * on nothing either — this one has no gate at all: no `doc.surface.kind` check, no dialect check,
 * no filename check. The `skill/*` rule it does contrast with is `name-matches-dir`, which gates
 * on the document's filename. It runs on every document any
 * surface discovers whose frontmatter parsed (the engine skips file rules on a document with
 * frontmatter parse errors — engine.ts step 4). A dangling `[see the API notes](api.md)` is the
 * same defect in a `SKILL.md`, a Cursor `.mdc` rule and a Copilot `.instructions.md` file, so the
 * namespace is `links/`, not `skill/`.
 *
 * This is also the first file rule that had to look outside the document it is handed, which is
 * why its `check` is `async` (`FileRule.check` already returns `MaybePromise<RuleReport[]>`) and
 * why `RuleTester` materializes a real temp directory for every case (a baseline for every
 * rule, chosen for exactly this rule's sake). What it looks at is
 * git's index rather than the filesystem, so it is also the first `file` rule that needs a git
 * checkout — which is why its own test cases set `needsGit: true` (`RuleTester` git-inits only
 * `project`/`scan` cases by default) and why a run against a directory that is not a checkout
 * stops with the engine's own one-sentence requirement instead of a rule crash
 * (`gitCheckoutRequiredError`, engine.ts).
 *
 * ## What is checked
 *
 * The mdast `link`, `image` and `definition` nodes, in document order (`collectLinkTargets`).
 * `linkReference`/`imageReference` are not checked and need no check: they hold an identifier, not
 * a url, and the `definition` they resolve through is checked directly — which is also why an
 * *unused* definition's target is still reported. A `definition` whose label begins with `^` is a
 * GFM footnote definition and is excluded (`isFootnoteDefinition`).
 *
 * A url is skipped, with no diagnostic, when it is:
 *
 * 1. a scheme URL — `SCHEME_URL`, so `http:`, `https:`, `mailto:`, `tel:`, and anything else that
 *    matches RFC 3986's `scheme` production. Whether an `https:` target is reachable is a network
 *    question, not a repository question, and a linter that made it one would fail in an air-gapped
 *    CI;
 * 2. protocol-relative — it starts with `//`;
 * 3. anchor-only — it starts with `#`, a jump inside this same document;
 * 4. query-only — it starts with `?`, this same document under a different query.
 *
 * Everything else is resolved (`resolveTarget`) and reported when it is empty, when it escapes the
 * repository, or when nothing exists at it.
 *
 * ## Resolution
 *
 * Everything from the first `#` **or** `?`, whichever comes first, is stripped: RFC 3986 gives both
 * the query and the fragment as components hanging off the path rather than as part of it, so
 * `file.md#anchor`, `file.md?plain=1` and `file.md?v=2#anchor` are all checked as `file.md` — see
 * `pathComponent` for the grammar and for the `%3F` / `%23` trade-off that follows from it.
 *
 * Whether the anchor names a real heading is deliberately NOT checked: it needs a slugging
 * algorithm, and every renderer has a different one (GitHub's differs from `remark-slug`'s on
 * punctuation and on duplicate headings), so any answer this rule gave would be right for one
 * renderer and wrong for the next. Post-v1, and out of scope here. The query is not
 * interpreted either — no renderer treats it as selecting a different file.
 *
 * The remainder is percent-decoded (`decodePath`), then resolved: a leading `/` against the
 * repository root, anything else against the document's own directory. Filesystem paths are built
 * with `node:path`'s platform functions (`resolve`, `relative`, `dirname`, `sep`, `isAbsolute`)
 * from `doc.absPath` and `ctx.root`, both of which the engine derives from the same `config.root`
 * — `doc.path`, the posix repo-relative spelling reporters use, is never mixed into path
 * arithmetic here, so there is no separator confusion to get wrong on Windows.
 *
 * Existence is a lookup in git's index (`TrackedFileIndex`, links.ts), NOT `stat`: a tracked
 * file, or a directory holding at least one tracked file at any depth. That is the answer a CI
 * checkout would give, on every OS — see `TrackedFileIndex`'s own doc for why, and for the two
 * behaviour changes it brings (an untracked file no longer resolves; a directory resolves by
 * prefix rather than by `stat`). The index is fetched lazily, on the first target that actually
 * needs it, so a document whose every link is an `https:` URL still costs no `git ls-files`.
 * Containment is lexical and does not follow symlinks — see `resolveTarget`.
 *
 * ## Messages
 *
 * Three parallel shapes, with the noun taken from the node type (`NOUNS`):
 *
 * - `<Noun> target "<url>" does not exist or is not tracked by git`
 * - `<Noun> has an empty target`
 * - `<Noun> target "<url>" resolves outside the repository`
 *
 * The first names both readings because the check cannot tell them apart and must not try: it
 * knows only that git has no entry for the path. Distinguishing them would mean a `stat` on the
 * failure path, and `stat` is what makes the answer differ between a case-insensitive macOS
 * checkout and Linux CI — the very split this rule was moved off the filesystem to end. Naming
 * git explicitly is also what makes the untracked case fixable: the file IS there, and `git add`
 * is the fix, which "does not exist" would never suggest.
 *
 * The url is quoted **exactly as written in the document**, never decoded and never resolved. That
 * is the string the author has to search the file for; `my file.md` is not findable in a document
 * that says `my%20file.md`. The resolved absolute path is deliberately left out too: it is
 * machine-specific, so putting it in a message would make pinned reporter output differ between
 * checkouts, and determinism is a CLAUDE.md guardrail.
 *
 * ## Known limitations, each measured against this project's own processor on 2026-09-03
 *
 * - **An undefined reference is invisible.** CommonMark leaves `[text][no-such-ref]` (and the
 *   shortcut form `[no-such-ref]`) as literal text when no matching definition exists, so remark
 *   produces a single `text` node and there is nothing for this rule to check. Measured: both
 *   forms parse to `paragraph > text`, with no `linkReference` node at all. A rule that wanted to
 *   catch them would have to re-scan the raw source with its own bracket parser.
 * - **Raw HTML is unchecked.** `<a href="x.md">` and `<img src="y.png">` become `html` nodes
 *   carrying a raw string, not `link`/`image`. Measured: the inline form yields
 *   `paragraph > html + text + html`, the block form a root-level `html` node. Parsing HTML out of
 *   those strings is a different job with a different dependency, and markdown link syntax is what
 *   every dialect's own docs use.
 * - **A symlink pointing out of the repository still resolves.** Containment is lexical
 *   (`resolveTarget`), and the index lookup does not close the gap either: `git ls-files` lists a
 *   tracked symlink by its own path whatever it points at, so `[x](notes.md)` resolves when
 *   `notes.md` is a tracked symlink to `/elsewhere/secret.md`. Closing it needs a `realpath` per
 *   target. The tracked-file switch closes the case-insensitivity gap
 *   but not this one.
 * - **An untracked file does not resolve, by design.** A link to a gitignored file, or to one
 *   that exists but has never been `git add`ed, is reported — a fresh CI checkout would not have
 *   it. It is the one change of this rule's behaviour that can fire on a repository that was
 *   clean before, which is why the message names git rather than only saying "does not exist".
 * - **GFM syntax is parsed as CommonMark.** document.ts's processor carries no `remark-gfm`, so
 *   constructs GFM adds are read under plain CommonMark rules. The one that reached this rule is
 *   the footnote definition — `[^1]: unverified` parses as a link reference definition with a
 *   destination — and it is excluded by label (`isFootnoteDefinition`). Anything else GFM adds
 *   either produces no link node at all or produces the same one CommonMark would. The durable fix
 *   is a `remark-gfm` dependency in document.ts, which is out of this rule's scope.
 * - **Code is free.** A link inside a fenced code block, an indented code block or an inline code
 *   span never produces a `link` node, so no fence-awareness logic is needed anywhere in this rule.
 *   Measured: ```` ```\n[x](./missing.md)\n``` ```` and its indented equivalent both parse to a
 *   single `code` node, and `` `[x](./missing.md)` `` to an `inlineCode` node — in all three the
 *   link text survives only as that node's `value` string. Pinned by tests anyway, because it is a
 *   property of the parser rather than of this file: were it ever to change, this rule would start
 *   reporting every example link in every code sample.
 */
export const linksResolve: FileRule = freezeRule({
	kind: "file",
	meta: {
		id: "links/resolve",
		description:
			"A local Markdown link, image or link definition whose target is missing or not tracked by Git.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	async check(doc: Document, ctx): Promise<RuleReport[]> {
		const targets = collectLinkTargets(doc.ast);
		if (targets.length === 0) {
			return [];
		}

		const docDir = dirname(doc.absPath);
		// Fetched on the FIRST target that resolves to a repository path, not up front: a
		// document whose links are all `https:`/`mailto:`/anchors has nothing to look up, and
		// eagerly asking for the index would make such a document require a git checkout for an
		// answer it never uses. `ctx.git.trackedFileIndex()` is memoized per run (context.ts), so
		// every later document — and every later target in this one — gets the same instance back
		// with no second `git ls-files` and no second index build.
		let tracked: TrackedFileIndex | undefined;
		const reports: RuleReport[] = [];

		for (const target of targets) {
			const noun = NOUNS[target.kind];
			const resolution = resolveTarget(target.url, ctx.root, docDir);
			switch (resolution.kind) {
				case "skip":
					break;
				case "empty":
					reports.push({
						message: `${noun} has an empty target`,
						loc: target.loc,
					});
					break;
				case "outside":
					reports.push({
						message: `${noun} target "${target.url}" resolves outside the repository`,
						loc: target.loc,
					});
					break;
				case "path":
					// Sequential rather than a `Promise.all` over the targets: `has` itself is a
					// synchronous set lookup, and the one `await` here resolves an already-
					// memoized promise after the first target, so there is nothing left for a
					// parallel map to win. Two links to the same missing file stay two mistakes
					// at two positions, and each still gets its own diagnostic.
					tracked ??= await ctx.git.trackedFileIndex();
					if (!tracked.has(resolution.absPath)) {
						reports.push({
							message: `${noun} target "${target.url}" does not exist or is not tracked by git`,
							loc: target.loc,
						});
					}
					break;
			}
		}

		return reports;
	},
});
