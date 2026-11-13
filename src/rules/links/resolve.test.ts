import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freezeSurface, type ResolvedSurface, sealMap } from "../../config.js";
import { createCapabilities, type RuleContext } from "../../context.js";
import { DEFAULT_INCLUDE } from "../../dialects.js";
import { type Document, parseSource } from "../../document.js";
import { collectLinkTargets, createTrackedFileIndex } from "../../links.js";
import { gitInitAndCommit, runRuleTests } from "../../testing/rule-tester.js";
import { linksResolve } from "./resolve.js";

/**
 * The three parts of this file exist for different reasons, and the split is the point — the same
 * shape `activation/consistent-scope.test.ts` uses, for an analogous reason.
 *
 * **(A) `runRuleTests`** drives the rule end to end through the engine and a real temp directory,
 * which is the only way to test a rule whose whole question is "is that file on disk".
 *
 * **(B) direct unit tests of `collectLinkTargets`**, because two things it guarantees are
 * invisible from (A). Document order is re-established by `runEngine`'s own sort by (file, line,
 * col, …) whatever order the rule returns its reports in, so no end-to-end case can tell the walk
 * order from any other order; and "which nodes exist at all" (an undefined reference, raw HTML, a
 * code fence and a GFM footnote definition produce none) is cheaper and far more direct to state
 * against a parsed tree than against a temp directory — though the code-fence and footnote halves
 * are *also* pinned end to end, because those are properties of the parser this rule silently
 * depends on.
 *
 * **(C) direct calls of `linksResolve.check`** for the one property that is about the rule's
 * *lifetime* rather than about a document: the tracked-file index lives for exactly one run —
 * memoized within it, never across it. `runRuleTests` invokes the rule once per case in a
 * directory it built for that case, so it cannot see the difference between a per-run index and
 * a module-level one, nor whether the index was rebuilt between two documents.
 *
 * (A) also carries `needsGit: true`, which every case in this file depends on: this
 * rule resolves targets against git's index, so a case's temp directory has to be a checkout
 * whose index holds the files the case wrote.
 */

/**
 * Frontmatter every fixture carries, so each one is a plausible skill file rather than a bare
 * fragment. Four lines plus a blank one, so a fixture body's first line is always **file line 6**
 * — every position asserted below is derived from that, plus the column arithmetic of the link
 * text itself (a node's span is `[start, start + text.length)`, 1-based).
 */
const FM =
	"---\nname: widgets\ndescription: A fixture skill for the links/resolve rule tests.\n---\n\n";

const doc = (body: string): string => `${FM}${body}`;

// --- (A) end to end, over a real temp directory ---

runRuleTests(linksResolve, {
	// The reason this suite differs from every other `file`-rule suite in the repo:
	// `links/resolve` resolves its targets against `ctx.git.trackedFileIndex()`, so each case
	// needs a real checkout whose index holds exactly the files that case wrote. Set once, on the
	// suite, so a case added later inherits it — see `RuleTestCases.needsGit`.
	needsGit: true,
	valid: [
		{
			name: "a relative target that exists",
			files: {
				"widgets/SKILL.md": doc("[the reference](./reference.md)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// The entry document itself lives in an NFD-decomposed directory
			// (what `readdir` returns on the filesystem this bug lives on), and links a sibling
			// by its own ASCII name — no authored Unicode text needed to trigger this, since
			// `resolution.absPath` inherits the NFD spelling from `dirname(doc.absPath)`, while
			// `ctx.git.trackedFileIndex()` (`createTrackedFileIndex` in links.ts) lists
			// the committed tree NFC-precomposed. Without the `pathKey` fix at both `has()` and
			// its index build, this sibling file is reported missing despite being committed.
			name: "a relative target beside an NFD-decomposed entry directory resolves against git's NFC-precomposed listing",
			files: {
				[`${"cafe\u0301"}/SKILL.md`]: doc("[ref](ref.md)\n"),
				[`${"cafe\u0301"}/ref.md`]: "# Ref\n",
			},
		},
		{
			// No `./` prefix, and one directory deeper: resolution is relative to the document's
			// own directory either way.
			name: "a target in a subdirectory of the document's own directory",
			files: {
				"widgets/SKILL.md": doc("[deep](sub/deep.md)\n"),
				"widgets/sub/deep.md": "# Deep\n",
			},
		},
		{
			// A directory is a legitimate link target (a git forge renders it as a listing). The
			// question is not `stat` but "does some tracked path sit under it" —
			// `widgets/sub/deep.md` does, so `widgets/sub` resolves. The invalid counterpart, a
			// directory holding only untracked files, is at the end of this suite.
			name: "a directory target counts as existing",
			files: {
				"widgets/SKILL.md": doc("[the folder](sub)\n"),
				"widgets/sub/deep.md": "# Deep\n",
			},
		},
		{
			// `..` that stays inside the repository is ordinary and must not be confused with an
			// escape: the containment check is about where the path LANDS, not about how it got
			// there. `shared/notes.md` is not a `SKILL.md`, so it is a file on disk and not a
			// second discovered document.
			name: "a relative target that climbs into a sibling directory but stays in the repo",
			files: {
				"widgets/SKILL.md": doc("[notes](../shared/notes.md)\n"),
				"shared/notes.md": "# Notes\n",
			},
		},
		{
			name: "a repo-root-absolute target that exists",
			files: {
				"widgets/SKILL.md": doc("[the guide](/docs/guide.md)\n"),
				"docs/guide.md": "# Guide\n",
			},
		},
		{
			// `relative(root, root)` is the empty string, which is inside the repository, not an
			// escape: a link to `/` points at the repository root directory itself.
			name: "a link to the repository root itself",
			files: { "widgets/SKILL.md": doc("[the repo root](/)\n") },
		},
		{
			name: "a fragment on an existing file checks the file part only",
			files: {
				"widgets/SKILL.md": doc("[section](./reference.md#section)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// Nothing to resolve: whether the heading exists is a question this rule does not ask.
			name: "an anchor-only link",
			files: { "widgets/SKILL.md": doc("[section](#section)\n") },
		},
		{
			// RFC 3986 §3: the query hangs off the path, it is not part of it — the same status the
			// fragment above has. `?v=1` is ordinary cache-busting and the file it names is right
			// there; before the query strip this was an `error` on a link that resolves everywhere.
			name: "a query string on an existing file checks the file part only",
			files: {
				"widgets/SKILL.md": doc("[the reference](./reference.md?v=1)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// A multi-parameter query, `&` included. Measured 2026-09-03: mdast keeps it verbatim
			// (`url === "reference.md?a=1&b=2"`), so the strip has to take everything from the `?`,
			// not just up to the next delimiter.
			name: "a multi-parameter query string is stripped whole",
			files: {
				"widgets/SKILL.md": doc("[the reference](reference.md?a=1&b=2)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// Query then fragment, the grammar's own order. The `?` is the earlier delimiter, so it
			// cuts first and the fragment never reaches the path either.
			name: "a query followed by a fragment strips both",
			files: {
				"widgets/SKILL.md": doc("[the reference](reference.md?q#frag)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// The ordering case. A `?` AFTER the first `#` belongs to the fragment (`a?b`), so the
			// path is still `reference.md`. Cutting at the `?` regardless of position — or at the
			// LAST delimiter rather than the first — leaves `reference.md#a` and reports a file
			// that is on disk.
			name: "a question mark inside a fragment is part of the fragment, not a query",
			files: {
				"widgets/SKILL.md": doc("[the reference](reference.md#a?b)\n"),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// The trade-off `pathComponent` states out loud: a `?` in a filename has to be written
			// `%3F`, exactly as a `#` has to be written `%23`. The strip runs before `decodePath`,
			// so the escape survives it and resolves to the file literally named `q?.md`.
			name: "a file whose name contains a question mark resolves when written %3F",
			files: {
				"widgets/SKILL.md": doc("[odd](q%3F.md)\n"),
				"widgets/q?.md": "# Odd\n",
			},
		},
		{
			// The query counterpart of `#section`: RFC 3986 §4.2's relative reference with an empty
			// `relative-part`, meaning this same document under a different query. Nothing to
			// resolve. Without its own skip it strips to the empty string and is reported as an
			// empty target — one false positive traded for another.
			name: "a query-only link",
			files: { "widgets/SKILL.md": doc("[plain](?plain=1)\n") },
		},
		{
			name: "scheme URLs are skipped, whatever the scheme",
			files: {
				"widgets/SKILL.md": doc(
					"[a](https://example.com/x)\n[b](http://example.com/x)\n[c](mailto:someone@example.com)\n[d](tel:+420123456789)\n",
				),
			},
		},
		{
			// RFC 3986 §3.1: "Although schemes are case-insensitive, the canonical form is
			// lowercase" — hence `SCHEME_URL`'s `i` flag. Without it these two resolve as
			// relative paths and are reported as missing.
			name: "an uppercase scheme is skipped exactly like its lowercase spelling",
			files: {
				"widgets/SKILL.md": doc(
					"[a](HTTPS://example.com/x)\n[b](MailTo:someone@example.com)\n",
				),
			},
		},
		{
			// The three punctuation characters RFC 3986 allows inside a scheme name. `git+ssh` is
			// the one that pins the `+`; `x-custom.scheme` pins the `-` and the `.`.
			name: "a scheme containing +, - or . is still a scheme",
			files: {
				"widgets/SKILL.md": doc(
					"[a](git+ssh://git@example.com/repo.git)\n[b](x-custom.scheme:payload)\n",
				),
			},
		},
		{
			// Not a path: resolving it root-relative would look for a directory named after the
			// host.
			name: "a protocol-relative url is skipped",
			files: { "widgets/SKILL.md": doc("[a](//example.com/x)\n") },
		},
		{
			// Fence awareness is free — there is no `link` node inside a code block to find. The
			// three code shapes are pinned separately because they are three different parser
			// productions, and this rule would start reporting every example link in every code
			// sample if any of them ever produced a link node.
			name: "a link inside a fenced code block is not a link",
			files: {
				"widgets/SKILL.md": doc("```\n[x](./missing.md)\n```\n"),
			},
		},
		{
			name: "a link inside an indented code block is not a link",
			files: { "widgets/SKILL.md": doc("    [x](./missing.md)\n") },
		},
		{
			name: "a link inside an inline code span is not a link",
			files: {
				"widgets/SKILL.md": doc("`[x](./missing.md)` is how you write it.\n"),
			},
		},
		{
			// mdast stores the url exactly as written, so the rule has to decode before it stats.
			name: "a percent-encoded path resolves to the decoded file",
			files: {
				"widgets/SKILL.md": doc("[spaced](my%20file.md)\n"),
				"widgets/my file.md": "# Spaced\n",
			},
		},
		{
			// `decodeURIComponent` throws a URIError on `%zz`. A `%` that is not an escape is just
			// a `%`, and a file may genuinely be named this — so the raw string is used literally
			// and nothing is reported. Without the try/catch, `check()` rejects and this case
			// fails with the URIError rather than with a diagnostic mismatch.
			name: "a malformed percent escape is used literally",
			files: {
				"widgets/SKILL.md": doc("[odd](bad%zz.md)\n"),
				"widgets/bad%zz.md": "# Odd\n",
			},
		},
		{
			name: "an image with an existing target",
			files: {
				"widgets/SKILL.md": doc("![a diagram](./diagram.png)\n"),
				"widgets/diagram.png": "not really a png\n",
			},
		},
		{
			// The reference itself carries no url; its definition does, and that is the node
			// checked. One resolving definition, no diagnostics.
			name: "a used reference-style link whose definition resolves",
			files: {
				"widgets/SKILL.md": doc(
					"[the reference][ref]\n\n[ref]: ./reference.md\n",
				),
				"widgets/reference.md": "# Reference\n",
			},
		},
		{
			// A GFM footnote definition. document.ts's processor carries no `remark-gfm`, so plain
			// CommonMark reads this as a link reference definition with label `^1` and destination
			// `unverified` (measured 2026-09-03) — and the rule reported it as a broken link to a
			// file named `unverified` until `isFootnoteDefinition` excluded it.
			name: "a GFM footnote definition is not a link definition",
			files: {
				"widgets/SKILL.md": doc("Some prose.[^1]\n\n[^1]: unverified\n"),
			},
		},
		{
			// A word label rather than a number: the skip keys off the leading `^` of the label,
			// never off what the body happens to look like.
			name: "a named GFM footnote definition is not a link definition",
			files: {
				"widgets/SKILL.md": doc("Some prose.[^note]\n\n[^note]: TODO\n"),
			},
		},
		{
			// The measured boundary of the false positive, and already silent before the skip
			// existed: a multi-word body cannot parse as destination + optional title, so
			// CommonMark leaves the whole line a paragraph and there is no definition node at all.
			// Pinned so the boundary is a fact in the suite rather than a claim in a comment.
			name: "a multi-word footnote body was never a definition in the first place",
			files: {
				"widgets/SKILL.md": doc("Some prose.[^1]\n\n[^1]: See the docs.\n"),
			},
		},
		{
			// Stated limitation 1: CommonMark leaves a reference with no matching definition as
			// literal text, so there is no node to check. Both spellings are pinned; if remark
			// ever started producing a `linkReference` for them, this case would start failing and
			// the rule's JSDoc would need rewriting.
			name: "an undefined reference is literal text, so there is nothing to check",
			files: {
				"widgets/SKILL.md": doc(
					"[text][no-such-ref] and [no-such-ref] again.\n",
				),
			},
		},
		{
			// Stated limitation 2: raw HTML becomes `html` nodes carrying a string, never
			// `link`/`image` — both the inline and the block form.
			name: "raw HTML anchors and images are not checked",
			files: {
				"widgets/SKILL.md": doc(
					'Inline <a href="./missing.md">text</a> here.\n\n<img src="./missing.png">\n',
				),
			},
		},
	],
	invalid: [
		{
			name: "a missing relative target",
			files: { "widgets/SKILL.md": doc("[the reference](./reference.md)\n") },
			errors: [
				{
					message:
						'Link target "./reference.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 32,
				},
			],
		},
		{
			// Exactly one diagnostic, positioned on the DEFINITION rather than on the reference
			// that uses it: the definition is the node that carries the url, and reporting the
			// reference too would bill one mistake twice.
			name: "a missing target reached through a link definition",
			files: {
				"widgets/SKILL.md": doc(
					"[the reference][ref]\n\n[ref]: ./reference.md\n",
				),
			},
			errors: [
				{
					message:
						'Link definition target "./reference.md" does not exist or is not tracked by git',
					line: 8,
					col: 1,
					endLine: 8,
					endCol: 22,
				},
			],
		},
		{
			// The case that proves definitions are checked in their own right rather than only
			// through whatever references them: nothing in this document uses `[unused]`.
			name: "an unused definition with a missing target is still checked",
			files: {
				"widgets/SKILL.md": doc(
					"Nothing references this definition.\n\n[unused]: ./gone.md\n",
				),
			},
			errors: [
				{
					message:
						'Link definition target "./gone.md" does not exist or is not tracked by git',
					line: 8,
					col: 1,
					endLine: 8,
					endCol: 20,
				},
			],
		},
		{
			name: "a missing image target",
			files: { "widgets/SKILL.md": doc("![a diagram](./diagram.png)\n") },
			errors: [
				{
					message:
						'Image target "./diagram.png" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 28,
				},
			],
		},
		{
			// An empty url is its own diagnostic, never an attempt to resolve the empty string
			// (which would land on the document's own directory and quietly pass).
			name: "an empty target",
			files: { "widgets/SKILL.md": doc("[the reference]()\n") },
			errors: [
				{
					message: "Link has an empty target",
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 18,
				},
			],
		},
		{
			name: "a target that escapes the repository",
			files: { "widgets/SKILL.md": doc("[outside](../../outside.md)\n") },
			errors: [
				{
					message:
						'Link target "../../outside.md" resolves outside the repository',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 28,
				},
			],
		},
		{
			// The boundary case of the containment check: this resolves to the repository's own
			// parent DIRECTORY, so `relative(root, …)` is the bare string `".."` — which does not
			// start with `"../"` and needs its own clause. The parent of a temp dir always exists,
			// so a containment check missing that clause reports nothing here at all.
			name: "a target that resolves to the repository's own parent directory",
			files: { "widgets/SKILL.md": doc("[up](../..)\n") },
			errors: [
				{
					message: 'Link target "../.." resolves outside the repository',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 12,
				},
			],
		},
		{
			name: "a missing repo-root-absolute target",
			files: { "widgets/SKILL.md": doc("[docs](/docs/guide.md)\n") },
			errors: [
				{
					message:
						'Link target "/docs/guide.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 23,
				},
			],
		},
		{
			// The message quotes the url AS WRITTEN — fragment included — even though only the
			// part before the `#` was resolved. That string is what the author has to search the
			// file for.
			name: "a fragment on a missing file quotes the url as written",
			files: { "widgets/SKILL.md": doc("[section](./reference.md#section)\n") },
			errors: [
				{
					message:
						'Link target "./reference.md#section" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 34,
				},
			],
		},
		{
			// Same contract as the fragment case: the url is quoted AS WRITTEN, query included,
			// even though only the part before the `?` was resolved.
			name: "a query string on a missing file quotes the url as written",
			files: {
				"widgets/SKILL.md": doc("[the reference](./reference.md?v=1)\n"),
			},
			errors: [
				{
					message:
						'Link target "./reference.md?v=1" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 36,
				},
			],
		},
		{
			// The skip is by label, not by node type. One footnote definition and one real link
			// definition in the same document: exactly the real one is reported. Skipping every
			// `definition` loses this diagnostic; skipping none adds a second one for `[^1]`.
			name: "a footnote definition beside a broken definition reports only the real one",
			files: {
				"widgets/SKILL.md": doc(
					"Prose.[^1] And [a reference][ref].\n\n[^1]: unverified\n\n[ref]: ./gone.md\n",
				),
			},
			errors: [
				{
					message:
						'Link definition target "./gone.md" does not exist or is not tracked by git',
					line: 10,
					col: 1,
					endLine: 10,
					endCol: 17,
				},
			],
		},
		{
			// The only invalid case whose link spans two lines, and the only thing pinning
			// `locOfNode`'s `line: pos.start.line`. Every other fixture link sits on one line,
			// which makes start and end indistinguishable — measured: reporting `pos.end.line`
			// instead leaves the whole suite green. Same trap as CLAUDE.md's "ordering assertion
			// whose fixture happened to be sorted already", in a different costume. A diagnostic
			// has to point at where the link STARTS.
			name: "a link whose text wraps onto a second line is reported at its first line",
			files: { "widgets/SKILL.md": doc("[link\ntext](./gone.md)\n") },
			errors: [
				{
					message:
						'Link target "./gone.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 7,
					endCol: 17,
				},
			],
		},
		{
			// The `outside` message quotes the url as written too — the third message shape, and
			// the one with no coverage of that contract: every other escaping fixture uses a url
			// with nothing to decode, which leaves `decodePath(target.url)` in this branch green
			// (measured) while printing a string the document does not contain.
			name: "an escaping target with a percent escape is quoted as written",
			files: { "widgets/SKILL.md": doc("[outside](../../my%20file.md)\n") },
			errors: [
				{
					message:
						'Link target "../../my%20file.md" resolves outside the repository',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 30,
				},
			],
		},
		{
			// The stat is shared between these two links; the diagnostic is not. Two mistakes at
			// two positions get two reports — a cache that deduped reports as well as syscalls
			// would silently hide the second one.
			name: "two links to the same missing target are two diagnostics at two positions",
			files: {
				"widgets/SKILL.md": doc("[first](./gone.md)\n\n[second](./gone.md)\n"),
			},
			errors: [
				{
					message:
						'Link target "./gone.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 19,
				},
				{
					message:
						'Link target "./gone.md" does not exist or is not tracked by git',
					line: 8,
					col: 1,
					endLine: 8,
					endCol: 20,
				},
			],
		},
		{
			// Decoded to resolve (`my file.md`), quoted as written (`my%20file.md`).
			name: "a percent-encoded path whose decoded target is missing",
			files: { "widgets/SKILL.md": doc("[spaced](my%20file.md)\n") },
			errors: [
				{
					message:
						'Link target "my%20file.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 23,
				},
			],
		},
		{
			// All three nouns in one document, each on its own node, all pointing at targets that
			// are not there.
			name: "a link, an image and a definition each get their own noun",
			files: {
				"widgets/SKILL.md": doc(
					"![img](./gone.png) then [link](./gone.md)\n\n[def]: ./gone.md\n",
				),
			},
			errors: [
				{
					message:
						'Image target "./gone.png" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 19,
				},
				{
					message:
						'Link target "./gone.md" does not exist or is not tracked by git',
					line: 6,
					col: 25,
					endLine: 6,
					endCol: 42,
				},
				{
					message:
						'Link definition target "./gone.md" does not exist or is not tracked by git',
					line: 8,
					col: 1,
					endLine: 8,
					endCol: 17,
				},
			],
		},
		// --- the three cases that only a tracked-file lookup can decide ---
		{
			// The headline case this rule was moved off `stat` for. `reference.md` IS tracked;
			// the link spells it `Reference.md`. On APFS/NTFS `stat` accepts that and the rule
			// used to pass, while Linux CI rejected the very same repository — see the "before"
			// half asserted directly in section (D) below, which is what makes this case a
			// before/after pair rather than a bare assertion about today.
			name: "a link whose case differs from the tracked path is reported on every OS",
			files: {
				"widgets/SKILL.md": doc("[the reference](./Reference.md)\n"),
				"widgets/reference.md": "# Reference\n",
			},
			errors: [
				{
					message:
						'Link target "./Reference.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 32,
				},
			],
		},
		{
			// Present on disk, absent from the index — a CI checkout would not have it. `stat`
			// succeeds here on EVERY filesystem, so this is the portable half of the before/after
			// pair: this case passed under `stat` everywhere, and fails under the index everywhere.
			// `.gitignore` is what keeps `git add -A` (rule-tester.ts's `gitInitAndCommit`) from
			// committing `notes.md` along with the rest.
			name: "a link to a file that exists but is not tracked is reported, and the message says so",
			files: {
				".gitignore": "widgets/notes.md\n",
				"widgets/SKILL.md": doc("[the notes](./notes.md)\n"),
				"widgets/notes.md": "# Notes\n",
			},
			errors: [
				{
					message:
						'Link target "./notes.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 24,
				},
			],
		},
		{
			// The other side of the "a directory target counts as existing" valid case above: a
			// directory resolves iff some TRACKED path sits under it. `widgets/drafts/` is a real
			// directory on disk holding a real file, and `stat` would have accepted it — but a
			// fresh checkout has neither the file nor, therefore, the directory, since git stores
			// no empty directories.
			name: "a link to a directory whose only contents are untracked is reported",
			files: {
				".gitignore": "widgets/drafts/\n",
				"widgets/SKILL.md": doc("[the drafts](./drafts)\n"),
				"widgets/drafts/wip.md": "# WIP\n",
			},
			errors: [
				{
					message:
						'Link target "./drafts" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 23,
				},
			],
		},
	],
});

// --- the "no scope gate" claim, proved: this rule reports on a surface that is not `skills` ---

// A `valid` case on a non-skills surface cannot prove this — it looks identical whether the
// contract was consulted and the file was clean or the rule never ran at all. These two are
// `invalid`, so they fail the moment the rule stops running: adding
// `if (doc.surface.kind !== "skills") return [];` to the top of `check` turns both red. Before
// they existed, that mutation left the whole suite green, because every non-`skills` case in the
// repo was a `valid` one.
runRuleTests(linksResolve, {
	needsGit: true,
	valid: [],
	invalid: [
		{
			name: "rules kind + cursor: a broken relative link in a .mdc is the same defect and is reported",
			surface: { kind: "rules", dialects: ["cursor"] },
			files: {
				"style.mdc":
					"---\ndescription: Style rules for the docs tree.\nglobs: docs/**/*.md\n---\n\n[the reference](./reference.md)\n",
			},
			errors: [
				{
					message:
						'Link target "./reference.md" does not exist or is not tracked by git',
					line: 6,
					col: 1,
					endLine: 6,
					endCol: 32,
				},
			],
		},
		{
			name: "instructions kind + copilot: a broken relative link in a .instructions.md is reported too",
			surface: { kind: "instructions", dialects: ["copilot"] },
			files: {
				"ts.instructions.md":
					'---\napplyTo: "**/*.ts"\n---\n\n[the guide](./guide.md)\n',
			},
			errors: [
				{
					message:
						'Link target "./guide.md" does not exist or is not tracked by git',
					line: 5,
					col: 1,
					endLine: 5,
					endCol: 24,
				},
			],
		},
	],
});

// --- (B) the walk itself, over inputs whose ordering the engine's sort would hide ---

/**
 * A surface identical in shape to the one `RuleTester` synthesizes (`buildSurface`), built the
 * same way — through config.ts's own `freezeSurface`/`sealMap` — so these unit tests parse their
 * markdown through the real `parseSource` (and therefore the real processor from document.ts)
 * rather than through a second, locally-configured unified pipeline that could drift from it.
 */
const SURFACE: ResolvedSurface = freezeSurface({
	root: ".",
	kind: "skills",
	dialects: ["generic"],
	include: DEFAULT_INCLUDE.skills,
	ignore: [],
	spokes: [],
	rules: sealMap(new Map()),
});

const targetsOf = (
	body: string,
): { kind: string; url: string; line: number; col: number }[] =>
	collectLinkTargets(
		parseSource("widgets/SKILL.md", "/nowhere/widgets/SKILL.md", body, SURFACE)
			.ast,
	).map((t) => ({
		kind: t.kind,
		url: t.url,
		line: t.loc.line,
		col: t.loc.col,
	}));

describe("collectLinkTargets", () => {
	test("returns link, image and definition nodes in document order", () => {
		// Source order is definition → image → link, which is neither alphabetical by kind nor by
		// url — so any reordering (including a reversal, which `runEngine`'s own sort would hide
		// end to end) changes this list.
		expect(
			targetsOf(
				doc("[zzz]: ./a.md\n\nText ![img](./b.png) and [link](./c.md).\n"),
			),
		).toEqual([
			{ kind: "definition", url: "./a.md", line: 6, col: 1 },
			{ kind: "image", url: "./b.png", line: 8, col: 6 },
			{ kind: "link", url: "./c.md", line: 8, col: 26 },
		]);
	});

	test("an image nested inside a link is visited after the link that contains it", () => {
		// The one nesting these three types can produce. Pre-order is document order here: the
		// link's `[` comes before the image's `!`.
		expect(targetsOf(doc("[![alt](./img.png)](./target.md)\n"))).toEqual([
			{ kind: "link", url: "./target.md", line: 6, col: 1 },
			{ kind: "image", url: "./img.png", line: 6, col: 2 },
		]);
	});

	test("a node's loc is its own full span", () => {
		const [only, ...rest] = collectLinkTargets(
			parseSource(
				"widgets/SKILL.md",
				"/nowhere/widgets/SKILL.md",
				doc("Hello [a](./x.md) there.\n"),
				SURFACE,
			).ast,
		);
		expect(rest).toEqual([]);
		expect(only?.loc).toEqual({ line: 6, col: 7, endLine: 6, endCol: 18 });
	});

	test("a linkReference contributes nothing of its own; its definition is the node found", () => {
		expect(targetsOf(doc("[the reference][ref]\n\n[ref]: ./a.md\n"))).toEqual([
			{ kind: "definition", url: "./a.md", line: 8, col: 1 },
		]);
	});

	test("an unused definition is found exactly like a used one", () => {
		expect(targetsOf(doc("[unused]: ./a.md\n"))).toEqual([
			{ kind: "definition", url: "./a.md", line: 6, col: 1 },
		]);
	});

	test("a footnote definition is skipped and a real one beside it is not", () => {
		// Both are `definition` nodes to this GFM-less processor (measured 2026-09-03: label and
		// identifier both `"^1"`, url `"unverified"`). Stating it here as well as end to end is
		// what distinguishes "the skip is by label" from "the skip is by node type": broaden it to
		// every definition and this list goes empty.
		expect(targetsOf(doc("[^1]: unverified\n\n[ref]: ./a.md\n"))).toEqual([
			{ kind: "definition", url: "./a.md", line: 8, col: 1 },
		]);
	});

	test("an undefined reference yields no node at all", () => {
		expect(targetsOf(doc("[text][no-such] and [no-such] again.\n"))).toEqual(
			[],
		);
	});

	test("raw HTML yields no node at all", () => {
		expect(
			targetsOf(doc('Inline <a href="./x.md">t</a>.\n\n<img src="./y.png">\n')),
		).toEqual([]);
	});

	test("fenced, indented and inline code yield no nodes at all", () => {
		expect(targetsOf(doc("```\n[x](./x.md)\n```\n"))).toEqual([]);
		expect(targetsOf(doc("    [x](./x.md)\n"))).toEqual([]);
		expect(targetsOf(doc("`[x](./x.md)` is the syntax.\n"))).toEqual([]);
	});

	test("a document with no links at all yields nothing", () => {
		expect(targetsOf(doc("Just prose, no links.\n"))).toEqual([]);
	});
});

// --- (C) the tracked-file index's lifetime, which no fixture can observe ---

const MISSING_REFERENCE =
	'Link target "./reference.md" does not exist or is not tracked by git';

describe("the tracked-file index lives for exactly one run", () => {
	test("one run answers from one index; the next run builds its own", async () => {
		// Two properties, neither of which any `runRuleTests` case can see, because that harness
		// builds a fresh temp directory per case and invokes the rule once.
		//
		// 1. WITHIN a run the answer is fixed. Two `check` calls on one capabilities object see
		//    one git index however much the repository moves underneath them, which is what a
		//    run reporting one consistent set of diagnostics depends on.
		//    Mutation-checked, and the result corrected what this comment first claimed: the memo
		//    this observes is `trackedFiles()`'s (`lazy`, context.ts), NOT
		//    `trackedFileIndex()`'s. Removing the latter's own `lazy` leaves this green, because
		//    a rebuilt index over the same memoized list answers identically — that one is a
		//    cost property, and it is pinned by object identity in context.test.ts instead.
		// 2. ACROSS runs nothing is memoized at module level. A rule object is a module-level
		//    singleton shared by every run in the process, so a cache hanging off one would
		//    answer the second run with the first run's git index — stale the moment the fix is
		//    applied, and leaking between two tests that happen to use the same path. (This is
		//    the same property the per-`check()` stat cache used to own before the index replaced it;
		//    the memoization moved, so its test moved with it.)
		//
		// Calling `linksResolve.check` directly is the "exported for a test real fixtures cannot
		// reach" precedent this file already sets with `collectLinkTargets`, and `dialects.ts`
		// with `mergeContractList`.
		//
		// `realpath` because macOS resolves `/var` to `/private/var`: the containment check
		// compares `ctx.root` against a path resolved from `doc.absPath`, and the two must be the
		// same spelling of the same directory. Same reason `rule-tester.ts` does it.
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "skillslurp-links-index-")),
		);
		try {
			const absPath = join(dir, "widgets", "SKILL.md");
			await mkdir(dirname(absPath), { recursive: true });
			const source = doc("[the reference](./reference.md)\n");
			await writeFile(absPath, source, "utf8");
			await gitInitAndCommit(dir);

			const document = parseSource(
				"widgets/SKILL.md",
				absPath,
				source,
				SURFACE,
			);
			// One call = one run's worth of capabilities, exactly what `runEngine` builds once per
			// run and shares across every (rule, surface) pair.
			const startRun = (): RuleContext => ({
				...createCapabilities(dir, async () => [document]),
				options: {},
				surface: SURFACE,
			});

			const firstRun = startRun();
			expect(
				(await linksResolve.check(document, firstRun)).map((r) => r.message),
			).toEqual([MISSING_REFERENCE]);

			// The file now exists AND is tracked — the repository genuinely changed under both
			// contexts below.
			await writeFile(
				join(dir, "widgets", "reference.md"),
				"# Reference\n",
				"utf8",
			);
			await gitInitAndCommit(dir);

			// Property 1: same capabilities object, same answer. Drop `trackedFiles()`'s own
			// `lazy` and this flips to `[]` — the second `check` shells out to `git ls-files`
			// again and sees the file that has since been added.
			expect(
				(await linksResolve.check(document, firstRun)).map((r) => r.message),
			).toEqual([MISSING_REFERENCE]);

			// Property 2: a new run, a new index, the current truth. Hoist the memo to module
			// level and this stays at the stale miss.
			expect(await linksResolve.check(document, startRun())).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// --- (D) the two behaviour changes, with the BEFORE half asserted and not merely
// asserted about, plus the index itself as a unit ---

/** `stat` succeeds at `absPath` — the exact existence question this rule used to ask. */
async function statAccepts(absPath: string): Promise<boolean> {
	try {
		await stat(absPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether the filesystem under `dir` folds case, probed against a file of this helper's OWN
 * making rather than against the fixture — so the expectation it feeds is an independent fact
 * about the machine, not a restatement of the thing under test.
 */
async function foldsCase(dir: string): Promise<boolean> {
	const probe = join(dir, "case-probe.tmp");
	await writeFile(probe, "", "utf8");
	try {
		return await statAccepts(join(dir, "CASE-PROBE.TMP"));
	} finally {
		await rm(probe, { force: true });
	}
}

/** A fixture repo with `files` written, then `git init`ed and committed; returns its real root. */
async function trackedFixture(
	prefix: string,
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	for (const [relPath, content] of Object.entries(files)) {
		const target = join(dir, ...relPath.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	return dir;
}

/** A `RuleContext` over `dir` whose only document is `widgets/SKILL.md`, parsed from `source`. */
function contextFor(
	dir: string,
	source: string,
): { document: Document; ctx: RuleContext } {
	const absPath = join(dir, "widgets", "SKILL.md");
	const document = parseSource("widgets/SKILL.md", absPath, source, SURFACE);
	return {
		document,
		ctx: {
			...createCapabilities(dir, async () => [document]),
			options: {},
			surface: SURFACE,
		},
	};
}

describe("the two behaviour changes the tracked-file lookup makes", () => {
	test("an untracked file: stat accepts it — the old answer, on every filesystem — and the index does not", async () => {
		// The portable half of the before/after pair. `stat` succeeding on `widgets/notes.md` is
		// not a claim about this machine: the file is genuinely there, so the check this rule
		// used to make passed here on Linux, macOS and Windows alike. Everything that
		// changed is which question gets asked.
		const source = doc("[the notes](./notes.md)\n");
		const dir = await trackedFixture("skillslurp-links-untracked-", {
			".gitignore": "widgets/notes.md\n",
			"widgets/SKILL.md": source,
			"widgets/notes.md": "# Notes\n",
		});
		try {
			await gitInitAndCommit(dir);

			// BEFORE: `stat` says the target is there.
			expect(await statAccepts(join(dir, "widgets", "notes.md"))).toBe(true);

			// AFTER: git does not, and the message says which of the two things went wrong.
			const { document, ctx } = contextFor(dir, source);
			expect(
				(await linksResolve.check(document, ctx)).map((r) => r.message),
			).toEqual([
				'Link target "./notes.md" does not exist or is not tracked by git',
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a wrong-case link: stat follows the filesystem's case folding, the index never does", async () => {
		// The half that only bites on a case-insensitive filesystem — which is exactly why it
		// survived: green on the author's APFS, red on Linux CI, over one identical
		// repository. `foldsCase` is probed rather than assumed, so this asserts a real
		// implication on both kinds of machine: wherever the filesystem folds case, the check
		// this rule used to make ACCEPTED `./Reference.md`, and the one it makes now does not.
		const source = doc("[the reference](./Reference.md)\n");
		const dir = await trackedFixture("skillslurp-links-case-", {
			"widgets/SKILL.md": source,
			"widgets/reference.md": "# Reference\n",
		});
		try {
			const caseFolding = await foldsCase(dir);
			await gitInitAndCommit(dir);

			// BEFORE: `stat`'s answer is the filesystem's, nothing more.
			expect(await statAccepts(join(dir, "widgets", "Reference.md"))).toBe(
				caseFolding,
			);

			// AFTER: the index is an exact-case list, so the answer is the same everywhere —
			// which is the whole point of the change, and is asserted unconditionally.
			const { document, ctx } = contextFor(dir, source);
			expect(
				(await linksResolve.check(document, ctx)).map((r) => r.message),
			).toEqual([
				'Link target "./Reference.md" does not exist or is not tracked by git',
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createTrackedFileIndex", () => {
	// `resolve("/repo")` rather than a literal: it is `/repo` on posix and `C:\repo` on Windows,
	// so every `join` below stays in the platform's own path space, which is what `has` compares
	// against. No filesystem is touched at all — the point of these cases is that the index
	// answers from the LIST, never from disk.
	const ROOT = resolve("/repo");
	const TRACKED = Object.freeze([
		"README.md",
		"docs/guide.md",
		"docs/deep/nested/page.md",
	]);
	const index = createTrackedFileIndex(ROOT, TRACKED);

	test("a tracked file resolves", () => {
		expect(index.has(join(ROOT, "docs", "guide.md"))).toBe(true);
	});

	test("a differently-cased spelling of a tracked file does not", () => {
		expect(index.has(join(ROOT, "docs", "Guide.md"))).toBe(false);
	});

	test("a directory holding a tracked file resolves, at any depth", () => {
		expect(index.has(join(ROOT, "docs"))).toBe(true);
		expect(index.has(join(ROOT, "docs", "deep"))).toBe(true);
		expect(index.has(join(ROOT, "docs", "deep", "nested"))).toBe(true);
	});

	test("a directory holding nothing tracked does not resolve", () => {
		expect(index.has(join(ROOT, "docs", "drafts"))).toBe(false);
	});

	test("a path that merely shares a string prefix with a tracked path does not resolve", () => {
		// `"docs/guide.md".startsWith("doc")` is true, and a prefix test written that way would
		// resolve a link to a directory named `doc` that no checkout has. The boundary is a
		// separator, which is why the index is built from real ancestors rather than from
		// `startsWith`.
		expect(index.has(join(ROOT, "doc"))).toBe(false);
		expect(index.has(join(ROOT, "docs", "guide"))).toBe(false);
	});

	test("the repository root resolves while anything at all is tracked", () => {
		expect(index.has(ROOT)).toBe(true);
	});

	test("the repository root does not resolve in a repository with nothing tracked", () => {
		expect(createTrackedFileIndex(ROOT, []).has(ROOT)).toBe(false);
	});

	test("a path outside the root does not resolve, whatever it is called", () => {
		// `resolveTarget` already rejects these before `has` is ever reached; this pins the
		// backstop, so the guard cannot be deleted as provably-dead code.
		expect(index.has(resolve(ROOT, "..", "README.md"))).toBe(false);
		expect(
			index.has(resolve(ROOT, "..", "elsewhere", "docs", "guide.md")),
		).toBe(false);
	});

	// Literal NFC/NFD escapes on both sides (see `name-matches-dir.test.ts`'s identical
	// idiom), so this is platform-independent: no real filesystem or git process involved, unlike
	// `engine.test.ts`'s `--diff-base` NFD pin, which needs both to demonstrate the same bug.
	const PRECOMPOSED_CAFE = "caf\u00e9";
	const DECOMPOSED_CAFE = "cafe\u0301";

	test("a file listed NFC-precomposed (git's spelling) resolves for an NFD-decomposed lookup (fs discovery's spelling), and vice versa", () => {
		const nfcListed = createTrackedFileIndex(
			ROOT,
			Object.freeze([`${PRECOMPOSED_CAFE}/SKILL.md`]),
		);
		expect(nfcListed.has(join(ROOT, DECOMPOSED_CAFE, "SKILL.md"))).toBe(true);

		const nfdListed = createTrackedFileIndex(
			ROOT,
			Object.freeze([`${DECOMPOSED_CAFE}/SKILL.md`]),
		);
		expect(nfdListed.has(join(ROOT, PRECOMPOSED_CAFE, "SKILL.md"))).toBe(true);
	});

	test("directory membership under a Unicode-named ancestor is form-insensitive", () => {
		const index = createTrackedFileIndex(
			ROOT,
			Object.freeze([`${DECOMPOSED_CAFE}/nested/SKILL.md`]),
		);
		expect(index.has(join(ROOT, PRECOMPOSED_CAFE))).toBe(true);
		expect(index.has(join(ROOT, PRECOMPOSED_CAFE, "nested"))).toBe(true);
	});
});

describe("links/resolve meta", () => {
	test("is an error in both tiers, takes no options, and claims no fix", () => {
		expect(linksResolve.meta.id).toBe("links/resolve");
		expect(linksResolve.meta.tiers).toEqual(["recommended", "strict"]);
		expect(linksResolve.meta.defaultSeverity).toBe("error");
		expect(linksResolve.meta.fixable).toBe(false);
		expect(linksResolve.meta.optionsSchema).toBeUndefined();
	});
});
