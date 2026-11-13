import { lstat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { ResolvedSurface } from "./config.js";
import type { Capabilities } from "./context.js";
import { isWithinRoot, resolveRealDirectory, toPosixPath } from "./paths.js";

/** What alias collection reads of a rule context: the linted root and the run's documents. */
type MentionContext = Pick<Capabilities, "root" | "documents">;

/**
 * The surface root as it appears at the head of a path mention.
 *
 * `ResolvedSurface.root` is the raw string the user wrote, not a normalized one — `discover.ts`
 * computes its own normalized `posixRoot` from `realpath` and keeps it to itself — so a config
 * that writes `root: .claude/skills/` or `root: ./.claude/skills` would otherwise build a
 * pattern with a doubled or leading-`./` prefix that no mention in any file could ever match.
 *
 * `posix.normalize` keeps a trailing slash, so it is stripped afterwards; a root that normalizes
 * to nothing at all becomes `.`, the same spelling `discover.ts` gives the repo root.
 */
function normalizeSurfaceRoot(root: string): string {
	const normalized = posix.normalize(root);
	const withoutTrailingSlash = normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
	return withoutTrailingSlash === "" ? "." : withoutTrailingSlash;
}

/**
 * One spelling a path mention may carry at its head, and the real repo-relative root it stands for.
 * `target` is the spelling git tracks items under; `alias` is what a reader may write instead.
 */
export interface RootAlias {
	readonly alias: string;
	readonly target: string;
}

/** A surface root after symlinks: the absolute path, and the same relative to the linted directory. */
export interface RealRoot {
	readonly abs: string;
	readonly rel: string;
}

/**
 * The surface's root as a path git can be asked about: `surface.root` resolved through symlinks,
 * relative to the linted directory, posix (`.` for the directory itself), next to its absolute
 * form. `undefined` when the root cannot be resolved or leaves the linted directory — discovery
 * refuses both before any rule runs, so this is a backstop, and the surface then stands for its
 * written root alone.
 */
export async function realRootOf(
	ctx: MentionContext,
	surface: ResolvedSurface,
): Promise<RealRoot | undefined> {
	const abs = await resolveRealDirectory(resolve(ctx.root, surface.root));
	if (abs === undefined || !isWithinRoot(ctx.root, abs)) {
		return undefined;
	}
	return { abs, rel: toPosixPath(relative(ctx.root, abs)) };
}

/**
 * Whether a symlink is one of the components of `abs` below `root`, walked with `lstat`. What
 * tells a root that reaches its directory through a link from one that merely spells it with other
 * casing than the disk does: `realpath` differs from the written path in both, but only the first
 * has a second spelling git can ever have entries under. A component that does not exist ends the
 * walk with no link found.
 */
async function crossesSymlink(root: string, abs: string): Promise<boolean> {
	if (!isWithinRoot(root, abs)) {
		return false;
	}
	let current = root;
	for (const segment of relative(root, abs).split(sep)) {
		if (segment === "") {
			continue;
		}
		current = join(current, segment);
		const info = await lstat(current).catch(() => undefined);
		if (info === undefined) {
			return false;
		}
		if (info.isSymbolicLink()) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a spoke is a second spelling of the hub. A directory-level spoke (the spoke
 * path itself is a symlink) is one only when it resolves to the hub's real root: a link that leads
 * anywhere else, or nowhere, makes every path through it a path into some other directory, and
 * `hub/symlinks` is the rule that reports the spoke itself. A spoke that is not a symlink is an
 * item-level spoke (a real directory holding one link per hub item) or does not exist yet, and
 * stays an alias: the item links inside it lead to the hub, and what is missing is for
 * `hub/symlinks` to say. Without a resolvable hub there is nothing to compare with, so the spoke
 * is kept.
 */
async function isAliasOfHub(
	ctx: MentionContext,
	spoke: string,
	hub: RealRoot | undefined,
): Promise<boolean> {
	if (hub === undefined) {
		return true;
	}
	const abs = resolve(ctx.root, spoke);
	const info = await lstat(abs).catch(() => undefined);
	if (info === undefined || !info.isSymbolicLink()) {
		return true;
	}
	return (await resolveRealDirectory(abs)) === hub.abs;
}

/**
 * Longest first, then UTF-16 code-unit order (what `<` compares), so one configuration always
 * builds one pattern and one lookup order.
 */
function compareAliases(a: RootAlias, b: RootAlias): number {
	if (a.alias.length !== b.alias.length) {
		return b.alias.length - a.alias.length;
	}
	return a.alias < b.alias ? -1 : 1;
}

/**
 * Every spelling a mention can start with, from EVERY surface's documents, not just
 * `ctx.surface`'s — each mapped to the real root it stands for, longest alias first.
 *
 * `ctx.documents()` is the whole run's documents (the engine builds it from `discoverFiles` over
 * `config.surfaces`, all of them), so one dispatch of this rule checks every root a repository
 * has. That is not merely tidy: a `scan` rule dispatches once per surface it is ENABLED on,
 * so a repo that switches this rule off for one surface would, under per-surface roots,
 * stop checking paths into that surface's root altogether — even though the corpus being scanned
 * is repo-wide and the other surface's dispatch is reading the very same files.
 *
 * Reading roots off the documents rather than off a surface list is not a shortcut around a
 * missing capability: `discoverFiles` turns an explicitly configured surface that matches zero
 * files into a `config/no-files` `ConfigError` and auto-detection never synthesizes one, so
 * every surface that reaches a rule has at least one document to be found through.
 *
 * A surface contributes up to three kinds of alias, all mapped to its REAL root: the root as
 * written, the root as it resolves through symlinks (only when a symlink is actually among the
 * written root's components — a root that differs from its `realpath` by filesystem case folding
 * alone has no second spelling), and each spoke that stands for the hub (`isAliasOfHub`), whether
 * a config declared it or zero-config detection found it. Git tracks nothing below a symlinked
 * directory — the index holds the link under its own path — so a mention written through a
 * spoke, or through a root that is itself a link, can only be judged after it is rewritten onto
 * the real root. A surface with no spokes and no symlinked root contributes its written root
 * alone, mapped to itself.
 *
 * Longest first so `rewriteToTarget` lets `.claude/skills/nested` win over `.claude/skills`; the
 * pattern itself does not care, since every branch is followed by the same greedy run and a
 * nested pair yields the identical whole match whichever branch wins. Two surfaces can never
 * claim one alias in a configuration discovery accepts, so the first claim is kept and nothing
 * else about the order matters.
 */
export async function collectRootAliases(
	ctx: MentionContext,
): Promise<readonly RootAlias[]> {
	const surfaces = new Set<ResolvedSurface>();
	for (const doc of await ctx.documents()) {
		surfaces.add(doc.surface);
	}
	const targets = new Map<string, string>();
	const claim = (alias: string, target: string): void => {
		if (!targets.has(alias)) {
			targets.set(alias, target);
		}
	};
	for (const surface of surfaces) {
		const written = normalizeSurfaceRoot(surface.root);
		const hub = await realRootOf(ctx, surface);
		const real = hub?.rel ?? written;
		claim(written, real);
		if (await crossesSymlink(ctx.root, resolve(ctx.root, surface.root))) {
			claim(real, real);
		}
		for (const spoke of surface.spokes) {
			if (await isAliasOfHub(ctx, spoke.path, hub)) {
				claim(normalizeSurfaceRoot(spoke.path), real);
			}
		}
	}
	return [...targets]
		.map(([alias, target]) => ({ alias, target }))
		.sort(compareAliases);
}

/**
 * `candidate` with its leading alias replaced by the real root it stands for, which is the spelling
 * `ctx.git.trackedFileIndex()` can answer for. `aliases` is longest first, so the alias that wins
 * is the most specific one written in front of the `/`; a candidate no alias heads is returned
 * as it is, which the pattern makes unreachable.
 */
export function rewriteToTarget(
	candidate: string,
	aliases: readonly RootAlias[],
): string {
	for (const { alias, target } of aliases) {
		if (candidate.startsWith(`${alias}/`)) {
			return `${target}${candidate.slice(alias.length)}`;
		}
	}
	return candidate;
}

/**
 * The run of characters that may follow `<root>/` in a path mention: everything except
 * whitespace and the three quoting delimiters.
 *
 * Whitespace is what the refined edge cases assume — "trailing `.`/`,`/`;`/`:`/`)`/`]` BEFORE
 * WHITESPACE OR END-OF-LINE are trimmed" only needs saying if the run swallows them in the first
 * place, which it does exactly because it stops at whitespace and nowhere else.
 *
 * The backtick, `"` and `'` are excluded on top of that, and this is a deliberate addition to the
 * refined grammar rather than an oversight in it — it removes a false-positive class instead of
 * creating one. A path is mentioned in inline code (`` `.claude/skills/foo` ``) far more often
 * than it is mentioned bare, and it is quoted in every yaml, json and shell file this scan reads;
 * with those three characters in the run, the candidate would carry the closing delimiter, never
 * resolve, and the rule would report a violation against a perfectly good mention. As a bonus the
 * English possessive (`.claude/skills/foo's config`) ends the run where a reader would.
 *
 * The cost is bounded and stated rather than hidden: a real path containing one of those three
 * characters (`.claude/skills/foo/don't.md`) is truncated at it, and the truncated prefix is what
 * gets looked up. `|` stays in the run: it was named alongside `<` and `>` below, but no
 * measurement here says how often it wraps a path relative to appearing inside one (a markdown
 * table cell wraps in whitespace either side, so the run already ends before the `|`), so a
 * mention wrapped in `|` is judged by the trim rules alone. `<` and `>` do NOT stay in the run any
 * more: a repository was measured (2026-09-06) linting itself with `.claude/skills/<name>/SKILL.md`
 * in a prose paragraph, and every such placeholder was reported as a dangling path, because no
 * literal `<name>` directory is ever tracked — a false positive on every input, not a missed
 * violation. `<` now marks a run as a placeholder or HTML tag rather than a literal path
 * (`GLOB_CHARS`, below); `>` now joins the trailing punctuation `trimTrailingPunctuation` strips,
 * the same status as the `)` and `]` a mention is wrapped in. The new cost is the mirror of the
 * backtick/quote one above and just as bounded: `<code>.claude/skills/foo</code>` (no space before
 * the closing tag) is now SKIPPED rather than reported, because trimming only the run's final `>`
 * still leaves the `<` from `</code>` in the candidate. Before, that mention was a false positive
 * on every input (`foo</code>` can never resolve); now it is a possible false negative on a path
 * genuinely spelled that way. Per CLAUDE.md, a false positive on valid input is worse than a
 * missed violation.
 */
export const PATH_RUN = "[^\\s`'\"]+";

/**
 * Sentence punctuation the run swallowed on its way to the next space: `.claude/skills/foo.` at
 * the end of a sentence, `foo,` in a list, `foo)` or `foo]` closing a bracket a mention was
 * wrapped in.
 *
 * Trailing only, so `.claude/skills/foo/SKILL.md` keeps its extension and an interior dot is
 * never touched.
 *
 * Returns an empty string only when the whole input is punctuation, as an `@...` import's run
 * can be. A path mention never trims to nothing, which is why its caller does not guard for it:
 * `/` is not in the set, so trimming always stops at the slash the pattern requires after the
 * surface root.
 */
export function trimTrailingPunctuation(raw: string): string {
	return raw.replace(/[.,;:)\]>]+$/, "");
}

/**
 * A run holding any of these is a glob, an interpolation, a placeholder or an HTML tag — not a
 * literal path (`.claude/skills/*\/SKILL.md`, `.claude/skills/${name}`, `.claude/skills/<name>`,
 * `.claude/skills/foo</code>`) — and there is no file to look up.
 *
 * Tested AFTER `trimTrailingPunctuation`, and the order is load-bearing rather than arbitrary:
 * `]` is in both sets, so testing first would make a mention wrapped in brackets
 * (`[.claude/skills/foo]`) read as a glob and silently skip a check the trim set exists to make
 * possible. Trimming first leaves each set with a job the other cannot do — a trailing `]` is
 * punctuation, an interior one is a character class. `<` and `>` do not repeat that trap: unlike
 * `]`, neither sits in both sets — `<` only ever means "glob/placeholder/tag" here and `>` only
 * ever means "trailing wrapper punctuation" — so which runs first does not change what either one
 * matches. The one case that still leans on the order is a placeholder at the very end of a run
 * (`.claude/skills/<name>`, no trailing text after it): `trimTrailingPunctuation` strips the
 * closing `>` first, and what is left for this test to see is `<` alone — `<` by itself, not the
 * `<…>` pair, is what marks a run as a placeholder.
 */
export const GLOB_CHARS = Object.freeze(/[*?[\]{}$<]/);

/** Where a mentioned path is read from; `any` is a path written without a documented prefix. */
export type MentionBase = "any" | "item" | "root";

/**
 * One path a document's text names. `any` mentions are tried against the mentioning document's
 * directory, the item directory and the repository root; `item` is `${CLAUDE_SKILL_DIR}/…` and
 * `root` is `${CLAUDE_PROJECT_DIR}/…`, each tried against its own base alone.
 *
 * A `glob` has a literal `dir` (the segments before the one holding the first glob character, at
 * least one of them a real directory name) and a `pattern` relative to it. A glob with no such
 * directory is not a mention at all: `*.md` in prose names no location.
 */
export type Mention =
	| {
			readonly kind: "path";
			readonly base: MentionBase;
			readonly path: string;
	  }
	| {
			readonly kind: "glob";
			readonly base: MentionBase;
			readonly dir: string;
			readonly pattern: string;
	  };

const MENTION_RUN = Object.freeze(new RegExp(PATH_RUN, "g"));
const MENTION_EMPHASIS: readonly string[] = Object.freeze([
	"**",
	"__",
	"*",
	"_",
]);
const MENTION_LINE_SUFFIX = Object.freeze(/:\d+(?::\d+)?$/);
const MENTION_LEADING = Object.freeze(/^[[<@|]+/);
const MENTION_TRAILING_BAR = Object.freeze(/\|+$/);
const MENTION_TRAILING_MARK = Object.freeze(/[?!]+$/);
const MENTION_SCHEME = Object.freeze(/^[A-Za-z][A-Za-z0-9+.-]*:/);
const MENTION_GLOB_START = Object.freeze(/[*?{}]/);
const MENTION_UNREADABLE = Object.freeze(/[$<>[\]]/);
const SKILL_DIR_PREFIX = `\${CLAUDE_SKILL_DIR}/`;
const PROJECT_DIR_PREFIX = `\${CLAUDE_PROJECT_DIR}/`;

function peelMention(piece: string): string {
	let token = piece;
	for (;;) {
		let next = token;
		const hash = next.indexOf("#");
		if (hash !== -1) {
			next = next.slice(0, hash);
		}
		next = trimTrailingPunctuation(next)
			.replace(MENTION_TRAILING_BAR, "")
			.replace(MENTION_LINE_SUFFIX, "")
			.replace(MENTION_LEADING, "");
		for (const marker of MENTION_EMPHASIS) {
			if (
				next.length > 2 * marker.length &&
				next.startsWith(marker) &&
				next.endsWith(marker)
			) {
				next = next.slice(marker.length, -marker.length);
				break;
			}
		}
		if (next === token) {
			return token;
		}
		token = next;
	}
}

function classifyMention(token: string): Mention | undefined {
	if (token === "" || MENTION_SCHEME.test(token)) {
		return undefined;
	}
	let base: MentionBase = "any";
	let path = token;
	if (token.startsWith(SKILL_DIR_PREFIX)) {
		base = "item";
		path = token.slice(SKILL_DIR_PREFIX.length);
	} else if (token.startsWith(PROJECT_DIR_PREFIX)) {
		base = "root";
		path = token.slice(PROJECT_DIR_PREFIX.length);
	}
	if (
		path === "" ||
		path.startsWith("/") ||
		path.startsWith("~") ||
		path.endsWith("/") ||
		MENTION_UNREADABLE.test(path)
	) {
		return undefined;
	}
	const firstGlob = path.search(MENTION_GLOB_START);
	if (firstGlob === -1) {
		return Object.freeze({ kind: "path", base, path });
	}
	const slash = path.lastIndexOf("/", firstGlob);
	if (slash === -1) {
		return undefined;
	}
	const dir = path.slice(0, slash);
	if (!dir.split("/").some((s) => s !== "" && s !== "." && s !== "..")) {
		return undefined;
	}
	return Object.freeze({
		kind: "glob",
		base,
		dir,
		pattern: path.slice(slash + 1),
	});
}

/**
 * The relative paths and globs a document's raw text may name, distinct, in order of first
 * appearance; a plain word is one too (`LICENSE` can name a file), and it is the caller's lookup
 * that tells which ones do. The scan is lexical: prose, code, frontmatter and comments all count, because the
 * question is whether the document names a file, not whether a tool would load it.
 *
 * Skipped, with no error: scheme URLs, absolute and `~` paths, directory mentions (a trailing
 * `/`), any `$…` other than the two documented substitutions, placeholders (`<name>`), bracket
 * classes, and a path with a space in it (a run ends at whitespace). `(` and `)` split a run, and
 * sentence punctuation, `**`/`__`/`*`/`_` emphasis, a `#fragment` and a `:line[:col]` suffix are
 * peeled off first. A token ending in `?` or `!` (`Have you read references/forms.md?`) is read as
 * written and again with those marks peeled, so the sentence's `?` is not mistaken for a glob.
 */
export function readMentions(raw: string): readonly Mention[] {
	const found = new Map<string, Mention>();
	for (const [run] of raw.matchAll(MENTION_RUN)) {
		for (const piece of run.split(/[()]/)) {
			const token = peelMention(piece);
			const tokens = [token];
			const unmarked = token.replace(MENTION_TRAILING_MARK, "");
			if (unmarked !== token) {
				tokens.push(peelMention(unmarked));
			}
			for (const candidate of tokens) {
				const mention = classifyMention(candidate);
				if (mention === undefined) {
					continue;
				}
				const key =
					mention.kind === "path"
						? `p\0${mention.base}\0${mention.path}`
						: `g\0${mention.base}\0${mention.dir}\0${mention.pattern}`;
				if (!found.has(key)) {
					found.set(key, mention);
				}
			}
		}
	}
	return Object.freeze([...found.values()]);
}
