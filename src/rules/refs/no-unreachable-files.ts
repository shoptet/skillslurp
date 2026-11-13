import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Root } from "mdast";
import picomatch from "picomatch";
import type { RuleContext } from "../../context.js";
import { DOCS_URL } from "../../diagnostic.js";
import { type Document, parseSource } from "../../document.js";
import { collectLinkTargets, resolveTarget } from "../../links.js";
import {
	collectRootAliases,
	type Mention,
	type RootAlias,
	readMentions,
	rewriteToTarget,
} from "../../mentions.js";
import { pathKey, resolveRealDirectory, toPosixPath } from "../../paths.js";
import { freezeRule, type ProjectRule, type RuleReport } from "../../rule.js";

/**
 * The extensions the walk parses and follows through; everything else it reaches is a leaf.
 *
 * A frozen ARRAY plus `includes`, not a `Set`: `Object.freeze(new Set(...))` does not stop
 * `.add`/`.delete` — a Set's contents live in internal slots, not in own properties — so a frozen
 * Set would look locked and not be, which is the exact "`Readonly<T>` is a type, not a lock"
 * failure this repo has already been bitten by twice. Three entries make the linear scan free.
 *
 * `.mdc` earns its place because a Cursor rule file IS markdown with frontmatter (`DEFAULT_INCLUDE
 * .rules` is `**\/*.mdc`, dialects.ts) and this repo already parses one with the same processor
 * every `.md` goes through.
 */
const WALKABLE_EXTENSIONS: readonly string[] = Object.freeze([
	".md",
	".mdc",
	".markdown",
]);

/**
 * Whether the walk parses `path` and follows its links, or treats it as a leaf.
 *
 * Lower-cased, which is the permissive reading and deliberately so: a `NOTES.MD` reached by the
 * walk gets parsed, so whatever IT links stays reachable too. The strict reading could only turn
 * files that are genuinely linked into reported orphans, and this rule leans away from that
 * everywhere it has the choice.
 */
function isWalkable(path: string): boolean {
	return WALKABLE_EXTENSIONS.includes(posix.extname(path).toLowerCase());
}

/**
 * Lexical containment, the same three-way test `resolveTarget` and `createTrackedFileIndex`
 * (links.ts), `classifyLinks` (rules/index/shared.ts) and `validateSurfaces` (discover.ts) each
 * spell out for themselves: outside means it has to climb (`..`, or `..` + separator) or that no
 * relative path exists at all (`isAbsolute` — on Windows, two different drives). Path strings
 * only; nothing here asks the filesystem anything.
 */
function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Ascending string order, the comparator every rule in this repo sorts its own reports with. */
function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One item: a directory under the surface root that a discovered entry document sits directly in.
 *
 * `roots` is every entry document directly in `dir`, all of which seed the walk. Normally there is
 * exactly one — a skill directory has one `SKILL.md`, a rule directory one rule file — and the
 * per-item design assumes as much. A surface configured with a broad `include` (`**\/*.md`)
 * breaks that assumption, and the alternative reading — each entry
 * document its own separate item, all sharing one directory — would make every such entry an
 * orphan of every other, a false positive manufactured out of nothing but a config choice. So the
 * item is the DIRECTORY and its entries are its roots, collectively.
 *
 * `primary` is the path-sorted first of `roots`, and only the diagnostic message uses it: a report
 * names one entry document, not a list, and the sorted-first one is the deterministic choice.
 */
interface Item {
	readonly dir: string;
	readonly primary: Document;
	readonly roots: readonly Document[];
}

/**
 * Whether `dir` is a STRICT subdirectory of `root` — the definition of "this entry has an item
 * directory": `.claude/skills/foo/SKILL.md` → `.claude/skills/foo`, but a flat
 * `.cursor/rules/foo.mdc` has `dirname === root` and therefore no item directory at all.
 *
 * `root === "."` (a surface rooted at the repository root) is its own branch because the repo root
 * has no `"./"` spelling in this path space: `Document.path` is `posix.join(posixRoot, match)`
 * (discover.ts), so joining against `"."` yields a bare `match` and `posix.dirname` of it is
 * either `"."` (flat) or a real directory name that is under the root by construction.
 */
function isStrictSubdirectory(dir: string, root: string): boolean {
	if (dir === root) {
		return false;
	}
	return root === "." ? true : dir.startsWith(`${root}/`);
}

/**
 * Groups this surface's entry documents into items, dropping every flat entry.
 *
 * Sorted by directory, and each item's `roots` sorted by path, so that everything downstream —
 * which item is walked first, which entry a message names — is a function of the repository's
 * contents and not of discovery's iteration order.
 */
function collectItems(
	entryDocs: readonly Document[],
	surfaceRoot: string,
): Item[] {
	const byDir = new Map<string, Document[]>();
	for (const doc of entryDocs) {
		const dir = posix.dirname(doc.path);
		if (!isStrictSubdirectory(dir, surfaceRoot)) {
			continue;
		}
		const bucket = byDir.get(dir);
		if (bucket === undefined) {
			byDir.set(dir, [doc]);
		} else {
			bucket.push(doc);
		}
	}

	const items: Item[] = [];
	for (const [dir, docs] of byDir) {
		const roots = [...docs].sort((a, b) => compareStrings(a.path, b.path));
		const [primary] = roots;
		if (primary === undefined) {
			// Unreachable: a bucket exists only because something was pushed into it. Present
			// because `noUncheckedIndexedAccess` types `roots[0]` as possibly absent and a
			// non-null assertion here would be a claim the type checker cannot verify.
			continue;
		}
		items.push({ dir, primary, roots });
	}
	return items.sort((a, b) => compareStrings(a.dir, b.dir));
}

/**
 * The item that owns `path`: the DEEPEST item directory `path` sits under, or none.
 *
 * "Deepest" is what makes a nested entry document own its own subtree instead of the enclosing
 * item owning it too — `.claude/skills/outer/inner/asset.md` belongs to `inner`, so `outer` never
 * reports it. Walks `path`'s own ancestors right to left, the identical idiom (and the identical
 * `> 0` guard, for the same reason) `createTrackedFileIndex` uses in links.ts.
 */
function ownerOf(
	path: string,
	itemsByDir: ReadonlyMap<string, Item>,
): Item | undefined {
	let slash = path.lastIndexOf("/");
	while (slash > 0) {
		const item = itemsByDir.get(pathKey(path.slice(0, slash)));
		if (item !== undefined) {
			return item;
		}
		slash = path.lastIndexOf("/", slash - 1);
	}
	return undefined;
}

/** A parsed document the walk can follow: its mdast, its raw text, and the directory its links resolve against. */
interface Walkable {
	readonly ast: Root;
	readonly dir: string;
	readonly raw: string;
}

/**
 * The walk's per-`check` document cache: `null` for a path that could not be read or parsed, so a
 * repeated visit costs no second syscall.
 *
 * Per `check` and never module-level: a rule object is a singleton shared by every run in the
 * process (see `GitCapability.trackedFileIndex`'s own doc for the same reasoning about lifetime),
 * so a cache outliving one run would answer the next one with the previous run's file contents.
 */
type DocumentCache = Map<string, Walkable | null>;

/**
 * Reads and parses one walkable path, or gives up quietly.
 *
 * Quietly is the point: a tracked file deleted from the working tree, one this process cannot
 * read, or one whose symlink leaves the repository are all "the walk learns nothing here", which
 * is the same non-answer an unresolvable link already gets. None of them is this rule's
 * diagnostic to raise, and a `check` that threw would take the whole run down (engine.ts rethrows
 * a rule's error as a bug) over a file that is at worst an under-count of reachability.
 *
 * This applies the same containment check to the same class of input for the same reason
 * `loadIndexAnalysis` (rules/index/shared.ts) applies it: `git ls-files` lists a tracked symlink
 * by its own path whatever it points at (`TrackedFileIndex`'s own doc says so), so a tracked
 * `notes.md -> /elsewhere/secret.md` would otherwise be read, parsed, and have ITS links walked —
 * an out-of-repo file steering which files this rule calls reachable. `realpath` also gives the
 * directory a relative link inside a symlinked file must resolve against, which is why `dir`
 * comes off the real path and not off the lexical one.
 */
async function loadWalkable(
	ctx: RuleContext,
	path: string,
	cache: DocumentCache,
): Promise<Walkable | undefined> {
	const cached = cache.get(path);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	let realAbsPath: string;
	let raw: string;
	try {
		realAbsPath = await realpath(resolve(ctx.root, path));
		if (!isWithinRoot(ctx.root, realAbsPath)) {
			throw new Error("reference file escapes the repository");
		}
		raw = await readFile(realAbsPath, "utf8");
	} catch {
		cache.set(path, null);
		return undefined;
	}

	// `ctx.surface` only because `parseSource` requires SOME surface to tag the result with; this
	// function reads `.ast` off it and nothing else, and a reference file is by construction not a
	// discovered document of any surface. Same use, same reason, as `loadIndexAnalysis`'s call.
	const walkable: Walkable = {
		ast: parseSource(path, realAbsPath, raw, ctx.surface).ast,
		dir: dirname(realAbsPath),
		raw,
	};
	cache.set(path, walkable);
	return walkable;
}

/** What one `check` shares between every item's walk: the cache, and what is compiled once. */
interface Shared {
	readonly trackedFiles: ReadonlySet<string>;
	readonly cache: DocumentCache;
	readonly mentions: Map<string, readonly Mention[]>;
	readonly matchers: Map<string, (path: string) => boolean>;
	readonly aliases: readonly RootAlias[];
}

function mentionsOf(
	path: string,
	walkable: Walkable,
	shared: Shared,
): readonly Mention[] {
	let mentions = shared.mentions.get(path);
	if (mentions === undefined) {
		mentions = readMentions(walkable.raw);
		shared.mentions.set(path, mentions);
	}
	return mentions;
}

function matcherFor(
	pattern: string,
	matchers: Map<string, (path: string) => boolean>,
): (path: string) => boolean {
	let matcher = matchers.get(pattern);
	if (matcher === undefined) {
		matcher = picomatch(pattern, { dot: true, posix: true });
		matchers.set(pattern, matcher);
	}
	return matcher;
}

function mentionBases(
	mention: Mention,
	docDir: string,
	itemDir: string,
): readonly string[] {
	if (mention.base === "item") {
		return [itemDir];
	}
	return mention.base === "root" ? ["."] : [docDir, itemDir, "."];
}

/**
 * Every tracked path reachable from `item`'s entry documents, as a fixpoint over resolved local
 * link targets and over the paths the item's own documents mention.
 *
 * The visited set is both the termination guarantee and the answer: a path is added exactly once,
 * before it is ever enqueued, so a cycle between two reference files (or a document linking
 * itself) terminates with each of them visited once. The entry documents seed it, which is what
 * makes "the entry document is never an orphan of itself" true by construction rather than by a
 * special case at report time.
 *
 * Three shapes reach nothing through a link, and the walk cannot tell the last two apart —
 * deliberately, because neither is its diagnostic to raise:
 *
 * - **a target that is not a path at all** (a scheme URL, protocol-relative, anchor-only,
 *   query-only, empty, or escaping the repository) — `resolveTarget` says so and the walk stops;
 * - **a link to a directory** (`[the docs](reference/)`) — git has no index entry for a directory,
 *   so it is absent from the tracked FILE set and reaches nothing. That is the intended answer,
 *   not a side effect: one directory link must not excuse every file underneath it, which is
 *   precisely what a rule looking for unreferenced files would be unable to see afterwards;
 * - **a link that resolves to nothing tracked** — skipped silently. `links/resolve` already owns
 *   that diagnostic, and reporting it a second time under this rule's id would tell the reader
 *   nothing new.
 *
 * Link traversal is NOT fenced to the item's own directory. Per-item scoping lives in the
 * roots (each item walks only from its own entries) and in ownership (`ownerOf`), which is what
 * makes the cross-item case work: a file linked only from a DIFFERENT item's entry document is
 * still reported, because this item's walk never starts at that entry. Fencing the traversal on
 * top of that would additionally call a file unreachable when a genuine chain of links leads to it
 * from this item's own entry document, just because the chain passes through a neighbour — a
 * report the repository's own contents contradict. This rule takes the permissive side of every
 * such choice; see the rule JSDoc.
 *
 * Mentions ARE fenced, on both ends: only a document inside the item is read for them, and only a
 * file inside the item can be reached by one (`inside`: what the item owns, plus the ignored paths
 * it holds, which are walked but never reported). A mention-reached file is parsed and read for
 * mentions in turn when it is markdown, and is a leaf otherwise.
 */
async function reachableFrom(
	ctx: RuleContext,
	item: Item,
	inside: ReadonlyMap<string, string>,
	shared: Shared,
): Promise<ReadonlySet<string>> {
	const visited = new Set<string>();
	const queue: string[] = [];
	for (const root of item.roots) {
		const key = pathKey(root.path);
		if (!visited.has(key)) {
			visited.add(key);
			queue.push(root.path);
		}
	}

	const reachOwned = (key: string): void => {
		const path = inside.get(key);
		if (path === undefined || visited.has(key)) {
			return;
		}
		visited.add(key);
		if (isWalkable(path)) {
			queue.push(path);
		}
	};
	const itemPrefix = `${pathKey(item.dir)}/`;
	const appliedGlobs = new Set<string>();
	const reachGlob = (dir: string, pattern: string): void => {
		const prefix = pathKey(rewriteToTarget(`${dir}/`, shared.aliases));
		const applied = `${prefix}\0${pattern}`;
		if (appliedGlobs.has(applied)) {
			return;
		}
		appliedGlobs.add(applied);
		const matches = matcherFor(pathKey(pattern), shared.matchers);
		for (const key of inside.keys()) {
			if (key.startsWith(prefix) && matches(key.slice(prefix.length))) {
				reachOwned(key);
			}
		}
	};

	while (queue.length > 0) {
		const current = queue.pop();
		if (current === undefined) {
			break;
		}
		const walkable = await loadWalkable(ctx, current, shared.cache);
		if (walkable === undefined) {
			continue;
		}
		// `keepFootnoteDefinitions` — the one option this walk sets. See `CollectLinkTargetsOptions`
		// (links.ts) for why the two callers of this walk answer the same ambiguity in opposite
		// directions.
		for (const target of collectLinkTargets(walkable.ast, {
			keepFootnoteDefinitions: true,
		})) {
			const resolution = resolveTarget(target.url, ctx.root, walkable.dir);
			if (resolution.kind !== "path") {
				continue;
			}
			const path = toPosixPath(relative(ctx.root, resolution.absPath));
			const key = pathKey(path);
			if (!shared.trackedFiles.has(key) || visited.has(key)) {
				continue;
			}
			visited.add(key);
			if (isWalkable(path)) {
				queue.push(path);
			}
		}

		if (!pathKey(current).startsWith(itemPrefix)) {
			continue;
		}
		const docDir = toPosixPath(relative(ctx.root, walkable.dir));
		for (const mention of mentionsOf(current, walkable, shared)) {
			for (const base of mentionBases(mention, docDir, item.dir)) {
				if (mention.kind === "glob") {
					reachGlob(posix.join(base, mention.dir), mention.pattern);
				} else {
					const path = posix.join(base, mention.path);
					reachOwned(pathKey(rewriteToTarget(path, shared.aliases)));
				}
			}
		}
	}

	return visited;
}

/**
 * A reference file that sits inside an item's own directory but that nothing in that item ever
 * links to or mentions is dead weight: nobody reading the entry document will ever be told it exists, and
 * nobody deleting the item's real content has any way to notice it was left behind. This rule
 * finds it.
 *
 * `error` in both tiers, for the same reason `activation/no-unmatched-globs` is: an unreferenced
 * file inside a skill directory is not style guidance a repo can reasonably tune, it is content
 * that contradicts its own entry point.
 *
 * ## What an item is
 *
 * An item is a DIRECTORY under the surface root that a discovered entry document sits directly
 * in — `.claude/skills/foo/SKILL.md` makes `.claude/skills/foo` an item. An entry whose directory
 * IS the surface root (`.cursor/rules/foo.mdc`) has no item directory, so this rule is a plain
 * no-op for it. Measured, so the claim is the true one rather than the obvious one: because an
 * item's roots are ALL the entry documents in its directory, letting the surface root count as an
 * item would not make two sibling `.mdc` files orphan each other — they would both seed the same
 * walk. What it would do is turn every non-entry file sitting at the surface root (a `README.md`
 * next to the rules, say) into an orphan of whichever entry sorts first, which is a report about a
 * file that was never part of any item.
 *
 * A nested entry document owns its own subtree (`ownerOf` takes the DEEPEST item directory), so an
 * outer item never reports a file that belongs to an item nested inside it.
 *
 * ## Reachability is scoped per item, not per surface, and that is deliberate
 *
 * Each item's entry documents are the roots of their own fixpoint walk, and any tracked file the
 * item owns that the walk never reaches is reported. A file reachable only from a DIFFERENT item's
 * entry document is therefore still reported. That is the design, stated here so it is not
 * mistaken for an oversight: cross-referencing between two skill directories is not the pattern
 * this rule checks for, and a repo-wide reachability graph would let any file anywhere excuse any
 * other file anywhere — at which point the rule can no longer answer the question it exists for.
 *
 * ## Reachability through mentions
 *
 * A file is reached by a link, or by a MENTION: a path or glob written in the raw text of a
 * document of the item. The scan is lexical, so prose, inline and fenced code, frontmatter and
 * HTML comments all count — the question is whether the document names the file, not whether any
 * tool loads it. Vendor facts: https://agentskills.io/specification (fetched 2026-10-01): "When
 * referencing other files in your skill, use relative paths from the skill root:", followed by an
 * example that is a markdown link plus a bare `scripts/extract.py` line;
 * https://code.claude.com/docs/en/skills (fetched 2026-10-01) documents `${CLAUDE_SKILL_DIR}` (the
 * directory containing the skill's `SKILL.md`) and `${CLAUDE_PROJECT_DIR}` (the project root) as
 * substitutions in a skill's markdown. Not documented in anything read, so not claimed here:
 * whether `@path` is expanded in a skill, whether an agent follows a bare basename, a directory
 * mention or a glob, and how deep a skill-root-relative reference may sit.
 *
 * A path token is tried against the mentioning document's directory, the item directory and the
 * repository root; `@path` is the same with the `@` stripped; `${CLAUDE_SKILL_DIR}/…` is tried
 * against the item directory alone and `${CLAUDE_PROJECT_DIR}/…` against the repository root
 * alone, and any other `$…` token is skipped. A mention written through a surface alias (a
 * symlinked root, a declared or detected spoke) is rewritten onto the real root first
 * (`collectRootAliases`). A token only counts when it names a tracked file inside the item, so:
 *
 * - **a bare basename that resolves from none of the three bases reaches nothing** — `README.md`
 *   in prose does not excuse a `README.md` somewhere else in the item;
 * - **a directory mention (`notes/`, `@notes/`) reaches nothing** — the same posture as a
 *   directory link: one directory mention must not excuse every file underneath it;
 * - **a glob reaches the owned files it matches, but only with a literal directory prefix**: a
 *   `/` after at least one real directory name and before the first `*`, `?` or `{`. So
 *   `notes/*.md` and `scripts/{a,b}.sh` count, and `*.md`, `*` and `**\/*.md` in prose excuse
 *   nothing. It is matched only against the files inside the item, never against every tracked file;
 * - **absolute paths, `~/…`, scheme URLs and a `..` that leaves the item are not mentions**;
 * - **a path with a space in it is not recognized**: a run ends at whitespace, which errs in the
 *   strict direction, and the fix for the author is to link the file.
 *
 * Mentions are fenced to the item on both ends, while link traversal is not: only a document
 * inside the item is read for mentions, and only a file inside the item can be reached by one. An
 * ignored file there is reached and walked, but never reported, exactly as one reached by a link
 * is. A mention of a neighbour's file therefore reaches nothing, and a neighbour's document reached by a
 * LINK is not read for mentions, whereas the links in it are still followed. A mention-reached
 * markdown file is read for mentions and links in turn; any other file is a leaf, so a script's
 * own text is never scanned.
 *
 * ## "Present" means tracked by git
 *
 * The files an item is judged on come from `ctx.git.trackedFiles()`, never from a directory walk.
 * A gitignored scratch file is not an orphan and an untracked-but-present asset is not reported
 * either — a fresh checkout of the repository does not contain them, so neither does the question.
 * Same CI-faithful posture `links/resolve` and `index/*` took when they moved off `stat`
 * (`TrackedFileIndex`, links.ts).
 *
 * `TrackedFileIndex` is deliberately NOT the lookup here, which is the one place this rule departs
 * from its siblings, so the reason is worth stating precisely rather than overstating. It is not
 * that the index would give a wrong answer: it is that this rule needs the LIST — "which tracked
 * files does this item own" is an enumeration, and `TrackedFileIndex` exposes only `has`. Having
 * the list, "did the walk reach a tracked FILE" is one `Set` lookup over that same data, so
 * building the index alongside it would be a second structure over one listing. It is also the
 * narrower question of the two: `has` answers "a tracked file, **or** a directory holding one",
 * and a directory is not something this walk can reach *through* (see `reachableFrom`). Measured,
 * and recorded so nobody has to re-derive it: swapping in `has` would change no diagnostic today
 * either, because a directory path can never appear in the owned set it is compared against.
 *
 * ## What "owned" excludes
 *
 * A tracked path matching the run's top-level `ignore:` list is not owned by any item, so it is
 * never reported. `ignore` is already this project's word for "these tracked paths are not the
 * linter's business", and it means that repo-wide for the scan corpus too;
 * someone who ignores `vendor/**` no more wants an orphan diagnostic out of `vendor/` than a
 * dangling-path one. The rule adds no option and no vocabulary of its own for this — one list,
 * one meaning, asked through `ctx.isIgnored` so the corpus and this rule share one matcher.
 *
 * Three consequences, each deliberate:
 *
 * - **Repo-root-relative patterns**, exactly as the corpus reads them, never surface-relative.
 *   Discovery reads the same list relative to each SURFACE root, an asymmetry `CorpusScope.ignore`
 *   documents as unavoidable; a third reading would not be. So a top-level `skills/widgets/**` can
 *   leave an item with no owned files while its entry document is still discovered and still
 *   linted by every `file` rule — which is the honest outcome of the two readings, not a bug.
 * - **`DEFAULT_IGNORE` counts**, because the list is the merged one (`ResolvedConfig.ignore`): a
 *   tracked `node_modules/` inside an item stopped being an orphan here.
 * - **The walk is NOT filtered.** `reachableFrom` resolves links against the full tracked set, so
 *   an ignored reference file that is reached still contributes its own links, and so does one a
 *   mention reaches inside the item. Filtering it there would let an `ignore` entry MANUFACTURE
 *   orphans out of files nothing else changed, which is the wrong direction for a rule whose
 *   ambiguities all resolve toward reporting fewer (below).
 *
 * Only the top-level list is read. `ResolvedSurface.ignore` stays discovery-only, and no per-rule
 * `exclude` option exists: both wait for a consumer case `ignore` cannot express.
 *
 * ## Ambiguity resolves toward reporting fewer orphans — with one stated exception
 *
 * A footnote body that might be a link (`CollectLinkTargetsOptions.keepFootnoteDefinitions`), an
 * unusual extension casing (`isWalkable`), a link chain that leaves and re-enters the item
 * (`reachableFrom`), a mention inside an HTML comment: each is decided the way that marks MORE
 * files reachable. Under-reporting an
 * orphan costs a file nobody cleaned up; over-reporting one tells an author to delete a file their
 * own repository links to.
 *
 * The exception, called out rather than glossed: a reference file the walk cannot read
 * (`loadWalkable` — unreadable, or a symlink leaving the repository) contributes no links, which
 * can only make MORE files look unreachable. That is the strict direction, and it is taken
 * knowingly — the alternative is letting a file outside the repository decide whether a file
 * inside it counts as referenced.
 *
 * ## What gets reported
 *
 * One diagnostic per orphan, `file` = the orphan itself and NO `loc` — there is no node, line or
 * column to point at, because the finding is about a file's absence from every other file, not
 * about anything written inside it. The message names the entry document the file should have been
 * reachable from, since that is where the fix goes: either link it, or delete it.
 */
export const noUnreachableFiles: ProjectRule = freezeRule({
	kind: "project",
	meta: {
		id: "refs/no-unreachable-files",
		description:
			"A tracked supporting file that its entry document neither links to nor mentions, so nothing leads the tool to it.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	async check(ctx: RuleContext): Promise<RuleReport[]> {
		const documents = await ctx.documents();
		// `doc.surface === ctx.surface` is the identity-keyed idiom `RuleContext.surface` exists
		// for, the same one `resolveEnabledBySurface` (engine.ts) and `loadIndexAnalysis`
		// (rules/index/shared.ts) already scope a project rule down to its own surface with.
		const entryDocs = documents.filter((doc) => doc.surface === ctx.surface);
		if (entryDocs.length === 0) {
			return [];
		}

		// Realpath'd, matching the root discovery itself globbed from (rules/index/shared.ts
		// has the long version): `Document.path` is built from the surface root's OWN realpath, so
		// comparing it against the configured spelling of a symlinked hub root
		// (`.agents/skills -> ../.claude/skills`) would find no entry inside the surface at all and
		// silently make this rule a no-op for exactly the layout it is most useful on.
		const surfaceAbsRoot = resolve(ctx.root, ctx.surface.root);
		const surfaceRoot = toPosixPath(
			relative(
				ctx.root,
				(await resolveRealDirectory(surfaceAbsRoot)) ?? surfaceAbsRoot,
			),
		);

		const items = collectItems(entryDocs, surfaceRoot);
		// Behind this guard rather than at the top, the same posture `activation/no-unmatched-globs`
		// takes: a surface whose entries are all flat has nothing for this rule to ask git about,
		// and must not make the run shell out for an answer it will not read. (`trackedFiles()` is
		// memoized per run — context.ts — so the cost is one subprocess per run regardless.)
		if (items.length === 0) {
			return [];
		}
		const trackedList = await ctx.git.trackedFiles();

		const itemsByDir = new Map(items.map((item) => [pathKey(item.dir), item]));
		const ownedByDir = new Map<string, string[]>();
		const ignoredByDir = new Map<string, string[]>();
		for (const path of trackedList) {
			const owner = ownerOf(path, itemsByDir);
			if (owner === undefined) {
				continue;
			}
			// An ignored path is not a file this item OWNS — see the rule JSDoc's
			// "What owned excludes". It is kept apart rather than dropped, because a mention may
			// still walk through it; `trackedFiles` below stays the full list for the same reason.
			const byDir = ctx.isIgnored(path) ? ignoredByDir : ownedByDir;
			const bucket = byDir.get(owner.dir);
			if (bucket === undefined) {
				byDir.set(owner.dir, [path]);
			} else {
				bucket.push(path);
			}
		}

		// Seeded with every already-parsed document of the run, across surfaces: a reference file
		// of one item can be a discovered entry document of another (a nested item), and re-reading
		// and re-parsing a file the engine has already read would be pure waste.
		const cache: DocumentCache = new Map();
		for (const doc of documents) {
			cache.set(doc.path, {
				ast: doc.ast,
				dir: dirname(doc.absPath),
				raw: doc.raw,
			});
		}
		const shared: Shared = {
			trackedFiles: new Set(trackedList.map(pathKey)),
			cache,
			mentions: new Map(),
			matchers: new Map(),
			aliases: await collectRootAliases(ctx),
		};

		const orphans: { path: string; entryPath: string }[] = [];
		for (const item of items) {
			const owned = ownedByDir.get(item.dir);
			if (owned === undefined) {
				continue;
			}
			const inside = [...owned, ...(ignoredByDir.get(item.dir) ?? [])];
			const reached = await reachableFrom(
				ctx,
				item,
				new Map(inside.map((path) => [pathKey(path), path])),
				shared,
			);
			for (const path of owned) {
				if (!reached.has(pathKey(path))) {
					orphans.push({ path, entryPath: item.primary.path });
				}
			}
		}

		// Belt-and-suspenders, and said out loud rather than claimed as verified (the same honesty
		// already forced on `index/complete`'s sort): `items` is already directory-sorted and
		// `git ls-files` already prints ascending paths, so this comparator changes nothing today
		// and no test can currently observe it — `runEngine` re-sorts every diagnostic by
		// (file, line, col, ruleId, message) before returning it. It stays as the rule's own
		// statement that its output order is a property of the repository, not of two upstream
		// orders it does not control (CLAUDE.md's determinism guardrail).
		orphans.sort((a, b) => compareStrings(a.path, b.path));

		return orphans.map(
			({ path, entryPath }): RuleReport => ({
				message: `Reference file "${path}" is not reachable from entry document "${entryPath}"`,
				file: path,
			}),
		);
	},
});
