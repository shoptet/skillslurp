import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Definition, Nodes, Root } from "mdast";
import { type Loc, START_LOC } from "./diagnostic.js";
import { pathKey, toPosixPath } from "./paths.js";

/**
 * Link-target extraction and resolution: "every inline/reference-style `link`, `image` and
 * `definition` target in a document, resolved against that document's own path" (the same
 * computation `links/resolve` names in its own JSDoc), factored out for reuse rather than
 * copied — `index/complete`/`index/no-missing-targets` compare an index document's links against
 * a surface's discovered entry documents, and `refs/no-unreachable-files` walks resolved
 * local targets transitively to find files no entry document ever reaches; both need exactly
 * this, over a document that is not necessarily the one `links/resolve` itself is checking.
 *
 * Lives at the top level, next to `yaml-loc.ts` — a shared helper that is not itself a rule —
 * rather than under `rules/`: two of this module's three consumers (`index/*`) already live
 * under `rules/`, so a copy placed there too would be a `rules/` → `rules/` import between
 * unrelated rule families, and `links/resolve` itself would then import sideways from a
 * directory named after a different rule's namespace.
 *
 * Extracted behavior-preserving from `links/resolve.ts` — factored out for reuse by the
 * rules above, never reimplemented alongside it: every comment on the exports below is
 * carried verbatim from there, including the vendor-sourced facts (RFC 3986, CommonMark, and
 * measurements against this project's own processor, each with its own fetch/measurement date)
 * that make this code reviewable rather than merely plausible. What did NOT move — `NOUNS`, the
 * message wording, the `check` body, `meta` — is `links/resolve`'s own business, not this
 * module's: it is the one rule built on this file that also decides what to report and how to
 * word it.
 */

/** The three mdast node types that carry a `url` this rule has anything to say about. */
export type LinkNodeKind = "link" | "image" | "definition";

/** One `url` found in the document, with the node type it came from and that node's position. */
export interface LinkTarget {
	readonly kind: LinkNodeKind;
	/** exactly as written in the document — never decoded, never resolved (see the rule's JSDoc) */
	readonly url: string;
	readonly loc: Loc;
}

/**
 * A URL carrying a scheme, per RFC 3986 §3.1's own production:
 * `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` followed by `:`
 * (datatracker.ietf.org/doc/html/rfc3986#section-3.1, fetched 2026-09-03). Matching the grammar
 * rather than an allow-list of `http|https|mailto|tel` is deliberate: this rule's job is to
 * recognize "not a filesystem path", and every scheme — `ftp:`, `slack:`, `vscode:`, a private
 * `git+ssh:` — is equally not one. An allow-list would report a perfectly good `tel:` link the
 * day someone writes one, which is the invented-constraint failure mode this repo weighs heaviest.
 *
 * The `i` flag is the spec's too — "Although schemes are case-insensitive, the canonical form is
 * lowercase" (same section) — so `HTTPS:` and `MailTo:` skip exactly like their lowercase
 * spellings.
 *
 * Stated limitation: on Windows a link written as `C:/docs/x.md` matches this production and is
 * skipped as a scheme URL rather than checked as a path. That is not a bug this rule can fix from
 * the string alone — `c:` is a syntactically valid scheme and a markdown renderer would treat it
 * as one too — and a repo-relative link is what every dialect this tool checks documents, so an
 * absolute drive path is already outside what the rule is for.
 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A node's own span, or file 1:1 when it has none.
 *
 * The fallback is unreachable in practice and kept only because mdast types `Node.position` as
 * optional: measured against this project's own processor (`unified().use(remarkParse)
 * .use(remarkFrontmatter, ["yaml"])`, document.ts) on 2026-09-03, every `link`, `image` and
 * `definition` node it produced carried a full start/end position. `START_LOC` is reused rather
 * than a second frozen `{ line: 1, col: 1 }` being declared here — its own JSDoc frames it around
 * a document with no frontmatter, and this widens it to "there is no node position to point at",
 * which is the same statement about the same file coordinate; two copies of it could only drift.
 *
 * Exported for the same reason it is shared inside this module: `docs/contract-sync`
 * positions its reports at an mdast `code` node, which is the identical mdast-position-to-`Loc`
 * conversion down to the off-by-one nobody wants to re-derive (mdast's `column`, 1-based, is
 * `Loc.col`). It takes `Nodes`, the whole mdast union, so it was never link-specific — only its
 * callers were.
 */
export function locOfNode(node: Nodes): Loc {
	const pos = node.position;
	if (!pos) {
		return START_LOC;
	}
	return {
		line: pos.start.line,
		col: pos.start.column,
		endLine: pos.end.line,
		endCol: pos.end.column,
	};
}

/**
 * Whether a `definition` node is really a GFM footnote definition that a GFM-less parse mistook
 * for a link reference definition.
 *
 * document.ts's processor is `unified().use(remarkParse).use(remarkFrontmatter, ["yaml"])` — no
 * `remark-gfm` — so it reads plain CommonMark, in which `[^1]: unverified` is a perfectly
 * well-formed link reference definition: label `^1`, destination `unverified`. Measured
 * 2026-09-03 against that exact processor: `[^1]: unverified` and `[^note]: TODO` each yield one
 * root-level `definition` node, while `[^1]: See the docs.` yields a `paragraph` instead, because
 * a multi-word body cannot parse as destination + optional title. Single-token footnote bodies are
 * therefore the ones the rule saw — and it reported each as a link definition pointing at a
 * missing file named `unverified`.
 *
 * Under GFM — which GitHub, Claude Code and every mainstream renderer of these documents apply —
 * `[^x]:` is a footnote definition and can never be a link reference definition, so what looks
 * like a destination here is prose. A diagnostic about it names a file the author never wrote and
 * cannot sensibly create.
 *
 * **Why skip rather than report**, in this repo's own terms: skipping risks missing a genuine
 * CommonMark link reference definition whose label happens to begin with `^` — vanishingly rare,
 * unusable in any renderer that supports footnotes, and in the worst case a *miss*. Not skipping
 * produces a false positive at `error` severity on ordinary footnote syntax in a correct document.
 * dialects.ts's module header states which way this repo leans between those two: "A linter that
 * invents a constraint produces false positives on valid input, which is worse than missing a
 * violation."
 *
 * Keyed off `identifier` rather than `label` because `identifier` is the field that is always
 * there: `@types/mdast` 4.x types `Association.identifier` as a required `string` and
 * `Association.label` as `string | null | undefined`. Measured 2026-09-03, both are in fact
 * populated by this processor and both read `^1` for `[^1]: x`; they differ only in normalization
 * (`[Ref Label]: ./a.md` → `label: "Ref Label"`, `identifier: "ref label"`), and collapsing
 * whitespace plus case-folding cannot add or remove a leading `^`.
 *
 * Stated limitation: this is a syntactic test on a label, not GFM parsing. The durable fix is to
 * add `remark-gfm` to document.ts's processor, after which a footnote parses as a
 * `footnoteDefinition` node and never reaches this walk at all. That is a new dependency, which
 * CLAUDE.md requires be flagged before it is added, so it is not taken here.
 */
function isFootnoteDefinition(node: Definition): boolean {
	return node.identifier.startsWith("^");
}

/** Per-call knobs for `collectLinkTargets`; every field defaults to the walk described there. */
export interface CollectLinkTargetsOptions {
	/**
	 * Keep the `^`-labelled `definition` nodes `isFootnoteDefinition` otherwise drops.
	 *
	 * Exactly one caller sets it, and only because the two callers weigh the SAME measured
	 * ambiguity in opposite directions. `[^1]: notes.md` parses, under this GFM-less processor,
	 * as a `definition` carrying `url: "notes.md"` — which is either a link to a real file or a
	 * footnote whose body happens to be one word, and nothing in the tree says which.
	 *
	 * - `links/resolve` asks "does this target exist?", and a wrong guess there INVENTS a
	 *   diagnostic about a file the author never meant to name. It leaves this unset and keeps
	 *   filtering, per `isFootnoteDefinition`'s own reasoning.
	 * - `refs/no-unreachable-files` asks "is this file reachable?", where the same wrong guess
	 *   would invent a diagnostic about the *other* file — the perfectly ordinary `notes.md`
	 *   sitting next to the footnote, reported as an orphan nobody links. Counting the footnote
	 *   body as a link can only mark MORE files reachable, i.e. report fewer orphans, so it errs
	 *   the one direction that cannot manufacture a false positive.
	 *
	 * Both readings answer to the same rule dialects.ts's module header states: a linter that
	 * invents a constraint is worse than one that misses a violation. Costed, not assumed:
	 * `remark-gfm` is NOT the fix for this and would make it strictly worse — measured
	 * 2026-09-05, under GFM the same source yields a `footnoteDefinition` holding a bare `text`
	 * node with no `url` and no `link`/`definition` node at all, so this walk would see less than
	 * it does today (`src/document.gfm.test.ts` pins the GFM-less half of that measurement).
	 */
	readonly keepFootnoteDefinitions?: boolean;
}

/**
 * Every `link`, `image` and `definition` in the tree, in document order.
 *
 * Pre-order depth-first: a node is recorded before its children, which for these three types is
 * exactly source order — the one nesting that can occur, an image inside a link
 * (`[![alt](img.png)](target.md)`), has the link's `[` before the image's `!`.
 *
 * **Why this is exported rather than left private**, in the same spirit as `outOfSyncMessage`
 * (consistent-scope.ts): the ordering it guarantees is invisible end to end. `runEngine` sorts
 * every diagnostic by (file, line, col, ruleId, message) before returning it (engine.ts's
 * `compareDiagnostics`), so a `RuleTester` case cannot tell walk order from any other order —
 * measured: reversing this function's result leaves every one of this rule's end-to-end cases
 * green, and fails only the two ordering tests that call it directly. A test that means to pin
 * document order therefore has to call the walk, and this is the function it calls. It is also
 * the cheapest place to pin *which* nodes exist at all (an undefined reference, raw HTML and a
 * code fence each produce none — see the rule's JSDoc), with no temp directory in the way.
 *
 * `linkReference` and `imageReference` are deliberately absent: they carry no `url` of their own,
 * only an `identifier` pointing at a `definition` this walk already visits directly. Checking the
 * definition once is both sufficient (a reference cannot resolve anywhere else) and strictly more
 * thorough — it is what makes an *unused* definition's broken target still get reported.
 *
 * A `definition` whose label begins with `^` is also absent **by default**: it is a GFM footnote
 * definition that this GFM-less processor parsed as a link definition, and its "destination" is
 * prose — see `isFootnoteDefinition`. Filtered here rather than in `check` so that the unit half
 * of this rule's tests can state it directly against a parsed tree. One caller opts back in; see
 * `CollectLinkTargetsOptions.keepFootnoteDefinitions`.
 */
export function collectLinkTargets(
	root: Root,
	options?: CollectLinkTargetsOptions,
): LinkTarget[] {
	const keepFootnotes = options?.keepFootnoteDefinitions === true;
	const targets: LinkTarget[] = [];
	const walk = (node: Nodes): void => {
		if (
			node.type === "link" ||
			node.type === "image" ||
			(node.type === "definition" &&
				(keepFootnotes || !isFootnoteDefinition(node)))
		) {
			targets.push({ kind: node.type, url: node.url, loc: locOfNode(node) });
		}
		if ("children" in node) {
			for (const child of node.children) {
				walk(child);
			}
		}
	};
	walk(root);
	return targets;
}

/**
 * What one url turned out to be:
 *
 * - `skip` — not a filesystem path at all (a scheme URL, protocol-relative, anchor-only);
 * - `empty` — nothing to resolve;
 * - `outside` — it resolves out of the repository, so it is reported without ever being looked up;
 * - `path` — an absolute path inside the repository, for `TrackedFileIndex.has` to look up.
 */
export type Resolution =
	| { readonly kind: "skip" }
	| { readonly kind: "empty" }
	| { readonly kind: "outside" }
	| { readonly kind: "path"; readonly absPath: string };

const SKIP: Resolution = Object.freeze({ kind: "skip" });
const EMPTY: Resolution = Object.freeze({ kind: "empty" });
const OUTSIDE: Resolution = Object.freeze({ kind: "outside" });

/**
 * Percent-decodes a link target, or hands back the raw string when it cannot.
 *
 * `[a](my%20file.md)` is how a markdown author writes a link to `my file.md`, and mdast stores the
 * url exactly as written (measured 2026-09-03: `url === "my%20file.md"`), so a rule that stat'd
 * the raw string would report a false positive on a perfectly good link.
 *
 * A malformed escape makes `decodeURIComponent` throw a `URIError` (measured 2026-09-03:
 * `decodeURIComponent("bad%zz.md")` throws). A file may genuinely be *named* `bad%zz.md`, and a
 * `%` that is not an escape is just a `%` — so the raw string is used literally rather than the
 * link being reported or the whole run crashing.
 *
 * Stated limitation: decoding is applied to the whole path at once, so a percent-encoded slash
 * (`a%2Fb.md`) decodes to `a/b.md` and is then resolved as two path segments rather than as one
 * segment containing a slash. Harmless in practice — no filesystem this tool runs on can hold a
 * file whose own name contains `/`, so the decoded reading is the only one that could ever match
 * something real, and decoding per segment instead would only change WHICH nonexistent path gets
 * reported.
 */
function decodePath(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/**
 * The path component of a relative reference: everything before the first `#` **or** `?`.
 *
 * RFC 3986 §3 gives the generic syntax as, verbatim
 * (datatracker.ietf.org/doc/html/rfc3986#section-3, fetched 2026-09-03):
 *
 * ```abnf
 * URI         = scheme ":" hier-part [ "?" query ] [ "#" fragment ]
 * ```
 *
 * and §4.2 the relative form a markdown link actually writes, verbatim
 * (datatracker.ietf.org/doc/html/rfc3986#section-4.2, fetched 2026-09-03):
 *
 * ```abnf
 * relative-ref  = relative-part [ "?" query ] [ "#" fragment ]
 * ```
 *
 * The query is a URI component in exactly the sense the fragment is — optional, delimited, and not
 * part of the path — so stripping it is the spec's own parse of the string, not a convenience this
 * rule invented. It is also load-bearing in practice: `?plain=1` is GitHub's documented view
 * modifier and `?v=2` is ordinary cache-busting, and both render and resolve to the file the path
 * names. Without this, `[a](reference.md?plain=1)` was reported as missing while `reference.md`
 * sat next to the document.
 *
 * **The earliest delimiter wins, whichever of the two it is.** The grammar orders the components —
 * query before fragment — so a `?` after the first `#` is part of the fragment, not a query
 * delimiter: `x.md#a?b` has path `x.md` and fragment `a?b`. Cutting at the `?` there would leave
 * `x.md#a`, a path nothing can match. Scanning for the earlier index is the whole of that rule;
 * both single-delimiter branches and the two-delimiter branch have their own test.
 *
 * Stated limitation, and the same trade-off this file already made once for `#`: a file whose name
 * literally contains `?` must be linked as `%3F`, exactly as a file whose name contains `#` must be
 * linked as `%23`. Both characters are URI delimiters before they are filename characters, every
 * markdown renderer reads them that way, and treating them as literals instead would break every
 * legitimate fragment and query in a repository to accommodate a filename that is unspellable in a
 * URL anyway. `decodePath` runs after this, so the `%3F` spelling resolves.
 */
function pathComponent(url: string): string {
	const hash = url.indexOf("#");
	const question = url.indexOf("?");
	if (hash === -1) {
		return question === -1 ? url : url.slice(0, question);
	}
	if (question === -1) {
		return url.slice(0, hash);
	}
	return url.slice(0, Math.min(hash, question));
}

/**
 * Turns one url into a `Resolution`, without touching the filesystem.
 *
 * The four skips are tested against the url **as written**, before any stripping or decoding, and
 * in the order the rule's JSDoc lists them. Order is not load-bearing between them (no url can
 * match two: a scheme needs a letter first, `//` a slash, an anchor a `#`, a query-only reference
 * a `?`), but it is the order a reader checks them in.
 *
 * The emptiness test is deliberately made against the STRIPPED `target` rather than the raw `url`,
 * even though with the `#` and `?` skips in place the two are the same test: `target` can only be
 * empty when `url` is, since anything else that strips to nothing had to start with one of those
 * two delimiters. Written this way it is a real backstop — were either skip dropped, `[x](#section)`
 * or `[x](?plain=1)` would be reported as an empty target instead of silently resolving to the
 * document's own directory, which exists, and passing. Mutation-checked in both directions.
 */
export function resolveTarget(
	url: string,
	root: string,
	docDir: string,
): Resolution {
	if (SCHEME_URL.test(url)) {
		return SKIP;
	}
	// Protocol-relative (`//example.com/x`): a URL that inherits the page's scheme. It has no
	// scheme of its own to match above, and it is emphatically not a path — resolving it
	// root-relative would look for a directory named after the host.
	if (url.startsWith("//")) {
		return SKIP;
	}
	// Anchor-only (`#section`): a jump inside this same document. Whether the anchor exists is a
	// question this rule does not ask (see the rule's JSDoc on anchors).
	if (url.startsWith("#")) {
		return SKIP;
	}
	// Query-only (`?plain=1`): per RFC 3986 §4.2 a relative reference whose `relative-part` is
	// empty — this same document under a different query, the query counterpart of `#section`.
	// It names no other file, so there is nothing to resolve and nothing to report. This clause
	// arrived with the query strip below and exists because of it: without it, stripping at the
	// `?` would turn a valid same-document reference into an "empty target" error, trading one
	// false positive for another.
	if (url.startsWith("?")) {
		return SKIP;
	}

	const target = pathComponent(url);
	if (target === "") {
		return EMPTY;
	}

	const decoded = decodePath(target);
	const absPath = decoded.startsWith("/")
		? // Repo-root-relative, NOT filesystem-absolute: `/docs/x.md` in a repo document means
			// `<repo>/docs/x.md`, the same way it does on a site rendered from that repo, and
			// resolving it against `/` instead would send the linter off to read the machine's real
			// root. The leading slashes are stripped rather than passed through, because
			// `resolve(root, "/docs/x.md")` returns the ABSOLUTE argument verbatim and would
			// silently reintroduce exactly that escape.
			resolve(root, decoded.replace(/^\/+/, ""))
		: // Everything else is relative to the document's own directory, which is what a markdown
			// renderer, a git forge and an editor's ctrl-click all do.
			resolve(docDir, decoded);

	// Containment is LEXICAL: `relative` compares path strings, it does not ask the filesystem
	// anything. A resolved path is outside when it has to climb (`..`, or `..` + separator) or when
	// no relative path exists at all (`isAbsolute` — on Windows, `relative` returns an absolute
	// path when the two sides are on different drives). The empty string, `relative(root, root)`,
	// is INSIDE: a link to `/` points at the repository root directory itself.
	//
	// Consequence, stated rather than left to be discovered: a symlink that lives inside the repo
	// and points outside it is not detected. The link's own text resolves inside, so this check
	// passes, and the target is then looked up by that same lexical path. Detecting it needs a
	// `realpath` per target — a second syscall on every link, on a check whose whole point is to
	// be cheap — and `TrackedFileIndex` below does NOT close it either: `git ls-files` lists a
	// tracked symlink by its own path whatever it points at, so an index lookup answers "is this
	// path in the index", not "does it stay inside the repo". (An earlier version of this comment
	// claimed the tracked-file check would make the question moot. It does not.)
	const rel = relative(root, absPath);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return OUTSIDE;
	}
	return { kind: "path", absPath };
}

/**
 * The one lookup both `links/resolve` and `index/complete`/`index/no-missing-targets` resolve a link
 * target against: git's index, not the filesystem.
 *
 * ## Why the index and not `stat`
 *
 * A CI checkout holds exactly the tracked files, spelled exactly as git records them, on a
 * filesystem that is almost always case-sensitive. `stat` answers a different question on the
 * machine the author is sitting at: measured on this machine (APFS, the macOS default),
 * `stat("Reference.md")` succeeds when the file on disk is `reference.md`, so a wrong-case link
 * passed locally and failed on Linux CI — the problem this replaces `stat` to
 * close. Asking git instead gives the CI-faithful answer on every OS, from one exact-case list.
 *
 * Two behaviour changes follow, both intended and both visible in the rules' own messages:
 *
 * - a link to a file that is **present but untracked** (gitignored, or simply not `git add`ed
 *   yet) no longer resolves — a fresh checkout would not have it;
 * - a link to a **directory** (`[the reference docs](reference/)`) is no longer answered by
 *   `stat` succeeding on it, because git has no index entry for a directory at all. It resolves
 *   iff some tracked path has `<target>/` as a prefix, i.e. iff the directory holds at least one
 *   tracked file at any depth — which is exactly when the directory exists in a fresh checkout,
 *   since git stores no empty directories.
 *
 * ## What it does NOT answer
 *
 * "Is this path in git's index" is not "does this path stay inside the repository". `git
 * ls-files` lists a tracked symlink by its own path whatever it points at, so a symlink inside
 * the repo pointing outside it still resolves — the same gap `resolveTarget`'s lexical
 * containment already has, left standing here rather than quietly claimed closed.
 *
 * It is also the *index*, not the working tree: a file staged but not yet committed is tracked
 * (and resolves), and a tracked file deleted from the working tree without that deletion being
 * staged is still an index entry (and resolves too). Both readings match what a checkout of the
 * repository would contain far more closely than `stat` on one dirty working copy does.
 *
 * ## Shape
 *
 * `has` is synchronous and O(1): the ancestor directories of every tracked path are precomputed
 * into a second `Set` at construction, rather than each lookup scanning the tracked list for a
 * `<target>/` prefix. The two are equivalent — `target + "/"` prefixes a tracked path exactly
 * when `target` is one of that path's ancestor directories — and the set form keeps a document
 * with many links from costing O(links × tracked files).
 */
export interface TrackedFileIndex {
	/**
	 * Whether git is tracking something at `absPath`: a tracked file, or a directory holding at
	 * least one tracked file at any depth. `absPath` is an OS-native absolute path (what
	 * `resolveTarget` returns for a `"path"` resolution); anything outside `root` is `false`.
	 */
	readonly has: (absPath: string) => boolean;
}

/**
 * Builds a `TrackedFileIndex` from one `ctx.git.trackedFiles()` listing.
 *
 * `root` is `Capabilities.root` — absolute and canonical — and `trackedFiles` is
 * root-relative posix and root-scoped, that capability's own documented contract (`git ls-files`
 * is invoked with `-C root`). So the lookup key is `relative(root, absPath)` mapped to posix,
 * and both sides meet in one path space with no separator confusion on Windows.
 *
 * The repository root itself is registered as a directory — `toPosixPath("")` is `"."`, so the
 * root is spelled `"."` here — whenever there is at least one tracked path: `[the repo root](/)`
 * resolves to `relative(root, root)`, and it names a directory every checkout has. It is the one
 * place this deviates from the literal `<target>/`-prefix rule above, which would ask for `"/"`
 * and match nothing; stated here rather than left to be discovered as a regression.
 *
 * The escape check comes first, and it is the identical three-way lexical test `resolveTarget`
 * runs (`..`, a `..` + separator prefix, or no relative path at all — `isAbsolute`, which on
 * Windows is `relative`'s answer for two different drives). Both callers hand in a path
 * `resolveTarget` already proved is inside `root`, so it is a backstop rather than a live
 * branch; without it a future caller that skipped that step would look up `"../secrets.md"` as a
 * literal key and get a confident `false` rather than a rejection.
 */
export function createTrackedFileIndex(
	root: string,
	trackedFiles: readonly string[],
): TrackedFileIndex {
	const files = new Set<string>(trackedFiles.map(pathKey));
	const directories = new Set<string>();
	for (const rawPath of trackedFiles) {
		const path = pathKey(rawPath);
		directories.add(".");
		// Walks the path's own ancestors right to left. `> 0`, not `>= 0`: a leading slash would
		// make the outermost "ancestor" the empty string, and `git ls-files` never emits one (its
		// output is relative by construction), so this only guards a caller who hands in
		// something that is not an ls-files listing.
		let slash = path.lastIndexOf("/");
		while (slash > 0) {
			directories.add(path.slice(0, slash));
			slash = path.lastIndexOf("/", slash - 1);
		}
	}
	// Frozen, like everything else this codebase hands out of a module (CLAUDE.md): one index is
	// shared by every rule and every document in a run, so no caller may replace `has` for
	// everyone that comes after it.
	return Object.freeze({
		has: (absPath: string): boolean => {
			const rel = relative(root, absPath);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
				return false;
			}
			const key = pathKey(toPosixPath(rel));
			return files.has(key) || directories.has(key);
		},
	});
}
