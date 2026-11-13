import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";
import {
	ConfigError,
	type ConfigProblem,
	describeSurface,
	RESERVED_NAMESPACES,
	type ResolvedConfig,
	type ResolvedSpoke,
	type ResolvedSurface,
} from "./config.js";
import type { Loc } from "./diagnostic.js";
import { isWithinRoot, resolveRealDirectory, toPosixPath } from "./paths.js";

/**
 * One discovered file, carrying the surface that claimed it. The surface is what tells later
 * stages which dialects apply, which is why discovery hands back pairs rather than paths: a
 * bare path would force the engine to re-derive the owner, and the answer has to be the same
 * one discovery used.
 */
export interface DiscoveredFile {
	/** repo-relative, posix separators */
	readonly path: string;
	readonly surface: ResolvedSurface;
}

/**
 * The surface's own position as a spreadable fragment, empty when it has none (a surface
 * synthesized by zero-config detection has no yaml to blame). Mirrors `locFields` in
 * diagnostic.ts: an own key holding `undefined` is not the same as no key, and
 * `exactOptionalPropertyTypes` rejects the shorter spelling.
 */
function locOf(surface: ResolvedSurface): { loc?: Loc } {
	return surface.loc === undefined ? {} : { loc: surface.loc };
}

/** Like `locOf`, for one entry of `surface.spokes`; falls back to the surface's `root` position. */
function spokeLocOf(
	surface: ResolvedSurface,
	spoke: ResolvedSpoke,
): { loc?: Loc } {
	const loc = spoke.loc ?? surface.loc;
	return loc === undefined ? {} : { loc };
}

/** True for an already posix-joined path that is absolute or climbs above its start via `..`. */
function escapesRepoPosix(p: string): boolean {
	return posix.isAbsolute(p) || p === ".." || p.startsWith("../");
}

interface ValidatedSurface {
	surface: ResolvedSurface;
	/** position in `config.surfaces`, so a message can tell two same-named surfaces apart */
	index: number;
	/** real, symlink-free absolute path — used as the glob's cwd */
	rootReal: string;
	/** posix path from the repo root to `rootReal` (or "." if they're the same directory) */
	posixRoot: string;
}

/**
 * One-arg wrapper around config.ts's `describeSurface` so this file's many call sites — all of
 * which already have a `ValidatedSurface` in hand — don't have to keep unpacking it themselves.
 * Named differently from the import it delegates to: TypeScript has no way to have both a
 * same-named import and a same-named local function in one module.
 */
function describeValidatedSurface({
	surface,
	index,
}: ValidatedSurface): string {
	return describeSurface(surface, index);
}

const NO_FILES_RULE_ID = "config/no-files";

// Import-time assert (mirrors engine.ts's PARSE_FRONTMATTER_RULE_ID and run.ts's
// CONFIG_INVALID_RULE_ID asserts): if RESERVED_NAMESPACES and this id ever drift apart, fail
// loudly at import time instead of silently letting a configured rule collide with this
// engine-owned pseudo-rule.
if (!RESERVED_NAMESPACES.some((ns) => NO_FILES_RULE_ID.startsWith(ns))) {
	throw new Error(
		`internal error: NO_FILES_RULE_ID "${NO_FILES_RULE_ID}" must start with a reserved namespace`,
	);
}

type Overlap = "equal" | "inside" | "containing";

/** `outer` is `inner` or a parent of it; posix repo-relative paths, where `.` is the repo root. */
function posixCovers(outer: string, inner: string): boolean {
	return outer === "." || inner === outer || inner.startsWith(`${outer}/`);
}

/** How `a` sits relative to `b` — equal, inside it, or containing it — or `undefined` if apart. */
function overlapOf(
	a: string,
	b: string,
	covers: (outer: string, inner: string) => boolean,
): Overlap | undefined {
	if (a === b) {
		return "equal";
	}
	if (covers(b, a)) {
		return "inside";
	}
	if (covers(a, b)) {
		return "containing";
	}
	return undefined;
}

const OVERLAP_VERB: Readonly<Record<Overlap, string>> = Object.freeze({
	equal: "is",
	inside: "is inside",
	containing: "contains",
});

async function isSymlink(absPath: string): Promise<boolean> {
	try {
		return (await lstat(absPath)).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * `absPath` resolved through symlinks, or `undefined` when it does not exist or is itself a
 * symlink. A spoke that is a symlink resolves to its target by design — usually the hub, and
 * comparing that with the roots would flag every correct directory-level spoke whose target is
 * one — so only a spoke that is NOT a symlink is compared by its real path.
 */
async function realPathUnlessSymlink(
	absPath: string,
): Promise<string | undefined> {
	if (await isSymlink(absPath)) {
		return undefined;
	}
	try {
		return await realpath(absPath);
	} catch {
		return undefined;
	}
}

/** The surface's root as a posix path from the repo root, as written — no symlink resolved. */
function lexicalRootOf(configRoot: string, surface: ResolvedSurface): string {
	return toPosixPath(relative(configRoot, resolve(configRoot, surface.root)));
}

/** A surface's root resolved through symlinks, as `validateSurfaces` computes it. */
interface RealRoot {
	absolute: string;
	/** posix path from the repo root, `.` for the repo root itself */
	posix: string;
}

const VIA_SYMLINKS = " (after resolving symlinks)";

/**
 * Checks the `spokes` every surface declares, in config order then declaration order, reporting
 * at most one problem per spoke at the line the user wrote it. A spoke is a tool directory
 * that should mirror its surface's root (the hub) through symlinks, so it is a problem when it:
 *
 * - is absolute or climbs out of the repo (lexical);
 * - equals, sits inside, or contains its own surface's root, as written and as that root
 *   resolves through symlinks (`.agents/skills -> ../.claude/skills` makes `.claude/skills` the
 *   hub itself). The spoke is never compared by ITS real path here: a spoke under a symlinked
 *   ancestor that leads to the hub (`.claude -> .agents`, spoke `.claude/skills`) is a working
 *   mirror, and resolving it would flag exactly that;
 * - exists, is not itself a symlink, and resolves outside the repo;
 * - is already declared by another surface, by its written path or, when it exists and is not
 *   itself a symlink, by its real path (`.cursor -> .claude` makes `.claude/skills` and
 *   `.cursor/skills` one directory) — named with both;
 * - equals, sits inside, or contains ANOTHER surface's root — lexically, and also through
 *   `realpath` when the spoke exists on disk and is not itself a symlink (see
 *   `realPathUnlessSymlink`). A spoke that IS a symlink is never compared by its target, so one
 *   that points at another surface's root is not a config problem: whether it points where the
 *   hub is, is for the `hub/symlinks` rule to say. A root that also holds this surface's own
 *   root (`.` next to `.agents/skills`) is skipped for "inside": it is a broader surface that
 *   holds hub and spoke alike, and nested roots are accepted everywhere else. A spoke whose real
 *   path is its own surface's real root (reached through a symlinked ancestor, `.agents -> .claude`)
 *   is the hub itself, so it is not compared by that path at all: it would "contain" every surface
 *   nested inside the hub, which are accepted.
 *
 * A spoke that does not exist is fine here for the same reason. `realRoots` maps a surface's
 * position to its real root, for the surfaces whose roots `validateSurfaces` could resolve;
 * a surface missing from it is still compared lexically.
 */
async function validateSpokes(
	config: ResolvedConfig,
	repoReal: string,
	realRoots: ReadonlyMap<number, RealRoot>,
): Promise<ConfigProblem[]> {
	const problems: ConfigProblem[] = [];
	const lexicalRoots = config.surfaces.map((surface) => {
		const root = lexicalRootOf(config.root, surface);
		return escapesRepoPosix(root) ? undefined : root;
	});
	interface Declaration {
		surface: string;
		index: number;
		spoke: string;
	}
	const declaredBy = new Map<string, Declaration>();
	const declaredByReal = new Map<string, Declaration>();

	for (const [index, surface] of config.surfaces.entries()) {
		const me = describeSurface(surface, index);
		const ownRoot = lexicalRoots[index];
		const ownReal = realRoots.get(index);
		for (const declared of surface.spokes) {
			const spoke = declared.path;
			const at = spokeLocOf(surface, declared);
			const report = (message: string) => {
				problems.push({ message, ...at });
			};
			const subject = `spoke "${spoke}" of ${me}`;

			if (posix.isAbsolute(spoke) || isAbsolute(spoke)) {
				report(
					`${subject} is an absolute path; write it relative to the repository root`,
				);
				continue;
			}
			if (escapesRepoPosix(spoke)) {
				report(`${subject} escapes the repository root`);
				continue;
			}

			let own =
				ownRoot === undefined
					? undefined
					: overlapOf(spoke, ownRoot, posixCovers);
			let ownVia = "";
			if (own === undefined && ownReal !== undefined) {
				own = overlapOf(spoke, ownReal.posix, posixCovers);
				ownVia = VIA_SYMLINKS;
			}
			if (own !== undefined) {
				report(
					`${subject} ${OVERLAP_VERB[own]} its own root${ownVia}; a spoke is a separate directory that mirrors the hub`,
				);
				continue;
			}

			const spokeReal = await realPathUnlessSymlink(
				resolve(config.root, spoke),
			);
			if (spokeReal !== undefined && !isWithinRoot(repoReal, spokeReal)) {
				report(`${subject} escapes the repository root${VIA_SYMLINKS}`);
				continue;
			}

			const first = declaredBy.get(spoke);
			if (first !== undefined && first.index !== index) {
				report(
					`spoke "${spoke}" is declared by both ${first.surface} and ${me}; a directory mirrors exactly one hub`,
				);
				continue;
			}
			const firstReal =
				spokeReal === undefined ? undefined : declaredByReal.get(spokeReal);
			if (firstReal !== undefined && firstReal.index !== index) {
				report(
					`${subject} is the same directory as spoke "${firstReal.spoke}" of ${firstReal.surface}${VIA_SYMLINKS}; a directory mirrors exactly one hub`,
				);
				continue;
			}
			const declaration = { surface: me, index, spoke };
			if (first === undefined) {
				declaredBy.set(spoke, declaration);
			}
			if (spokeReal !== undefined && firstReal === undefined) {
				declaredByReal.set(spokeReal, declaration);
			}

			const spokeIsOwnRealRoot =
				ownReal !== undefined && spokeReal === ownReal.absolute;
			for (const [otherIndex, other] of config.surfaces.entries()) {
				if (otherIndex === index) {
					continue;
				}
				const otherRoot = lexicalRoots[otherIndex];
				const otherReal = realRoots.get(otherIndex);
				const holdsOwnRoot =
					(otherRoot !== undefined &&
						ownRoot !== undefined &&
						posixCovers(otherRoot, ownRoot)) ||
					(otherReal !== undefined &&
						ownReal !== undefined &&
						isWithinRoot(otherReal.absolute, ownReal.absolute));
				const judged = (overlap: Overlap | undefined) =>
					overlap === "inside" && holdsOwnRoot ? undefined : overlap;

				let overlap = judged(
					otherRoot === undefined
						? undefined
						: overlapOf(spoke, otherRoot, posixCovers),
				);
				let via = "";
				if (
					overlap === undefined &&
					otherReal !== undefined &&
					spokeReal !== undefined &&
					!spokeIsOwnRealRoot
				) {
					overlap = judged(
						overlapOf(spokeReal, otherReal.absolute, isWithinRoot),
					);
					via = VIA_SYMLINKS;
				}
				if (overlap !== undefined) {
					report(
						`${subject} ${OVERLAP_VERB[overlap]} the root of ${describeSurface(other, otherIndex)}${via}; a spoke may not overlap another surface's root`,
					);
					break;
				}
			}
		}
	}
	return problems;
}

/**
 * What to offer besides listing dialects, for two surfaces whose roots are one directory. Nothing
 * when both are spellings of the same path: no symlink is involved, so there is no spoke to
 * declare. When exactly one root is itself a symlink, it is the spoke and the other root is the
 * hub; otherwise the direction is the user's to pick.
 */
async function spokeAlternative(
	config: ResolvedConfig,
	a: ValidatedSurface,
	b: ValidatedSurface,
): Promise<string> {
	const rootA = lexicalRootOf(config.root, a.surface);
	const rootB = lexicalRootOf(config.root, b.surface);
	if (rootA === rootB) {
		return " instead";
	}
	const [linkA, linkB] = await Promise.all([
		isSymlink(resolve(config.root, a.surface.root)),
		isSymlink(resolve(config.root, b.surface.root)),
	]);
	if (linkA === linkB) {
		return ", or declare one directory as the other's spoke";
	}
	return `, or declare "${linkA ? rootA : rootB}" as a spoke of the surface rooted at "${a.posixRoot}"`;
}

/**
 * Validates every surface root against the repo root, in config order, collecting every
 * problem found (not just the first) into one `ConfigError` — matching the collect-all
 * convention `loadConfig` uses within a stage. A surface root is a problem if it does not
 * exist, is not a directory, or — once resolved through `realpath` on both sides — falls
 * outside the repo root (an absolute path elsewhere on disk, or a `..`-escaping relative
 * path). `realpath` on both sides also means a surface root that is itself a symlink
 * resolves through to its target: if the target is inside the repo, discovery proceeds
 * using the target's real path; if not, that surface is reported as escaping. The declared
 * `spokes` are checked afterwards (`validateSpokes`), so their problems follow the root ones.
 */
async function validateSurfaces(
	config: ResolvedConfig,
): Promise<readonly ValidatedSurface[]> {
	const repoReal = await realpath(config.root);
	const problems: ConfigProblem[] = [];
	const validated: ValidatedSurface[] = [];

	const byRealRoot = new Map<string, ValidatedSurface>();
	const realRoots = new Map<number, RealRoot>();

	for (const [index, surface] of config.surfaces.entries()) {
		const absRoot = resolve(config.root, surface.root);
		const rootReal = await resolveRealDirectory(absRoot);
		if (rootReal === undefined) {
			problems.push({
				message: `surface root "${surface.root}" does not exist or is not a directory`,
				...locOf(surface),
			});
			continue;
		}

		const rel = relative(repoReal, rootReal);
		const escapesRepo =
			rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
		if (escapesRepo) {
			problems.push({
				message: `surface root "${surface.root}" escapes the repository root`,
				...locOf(surface),
			});
			continue;
		}

		const entry: ValidatedSurface = {
			surface,
			index,
			rootReal,
			posixRoot: rel === "" ? "." : toPosixPath(rel),
		};
		realRoots.set(index, { absolute: rootReal, posix: entry.posixRoot });

		// Two roots that resolve to the same real directory are one directory named twice —
		// a symlinked hub (`.agents/skills` → `.claude/skills`) is the common shape. Reporting
		// it as a per-file overlap would advise "list several dialects on one surface", which
		// is not the fix when the user has two real directory entries; say what is actually
		// wrong instead, once, rather than once per file underneath.
		const twin = byRealRoot.get(rootReal);
		if (twin) {
			problems.push({
				message: `${describeValidatedSurface(twin)} and ${describeValidatedSurface(entry)} resolve to the same directory; a directory belongs to exactly one surface — list several dialects on one surface${await spokeAlternative(config, twin, entry)}`,
				...locOf(surface),
			});
			continue;
		}
		byRealRoot.set(rootReal, entry);
		validated.push(entry);
	}

	problems.push(...(await validateSpokes(config, repoReal, realRoots)));

	if (problems.length > 0) {
		throw new ConfigError(config.configFile, problems);
	}
	return validated;
}

/**
 * Discovers files across all configured surfaces, in config order: globs each surface's
 * `include` patterns (scoped to `surface.root`'s real, symlink-resolved directory,
 * `surface.ignore` and the global `config.ignore` merged into `ignore` — both matched
 * relative to that surface's root, not the repo root: a pattern like `dist/**` excludes
 * `<surface-root>/dist/**` for every surface, never a single `dist/` at the repo root),
 * maps matches to repo-relative posix paths, and returns them paired with the surface that
 * claimed each one, in a deterministic (lexicographically sorted by path) order.
 *
 * **A file may belong to exactly one surface.** Two surfaces matching the same file used to be
 * silently deduped; it is now a `ConfigError`, because the surface is what decides which
 * dialects a file is checked against and "whichever surface came first in the config" is not an
 * answer anyone would choose on purpose. Sharing one directory between tools is expressed as a
 * single surface listing several `dialects`. Two differently-spelled roots resolving to the same
 * real directory land here too — same file, two claimants.
 *
 * A surface root that does not exist, is not a directory, or escapes the repo root (see
 * `validateSurfaces`) is a config mistake — not a silent empty run — and throws `ConfigError`
 * with every such surface collected, not just the first. Directory symlinks *inside* a surface
 * are not traversed (`followSymbolicLinks: false`); `expandDirectories: false` keeps a
 * bare-directory `include` pattern from silently expanding to every file under it. A zero-match
 * *explicitly configured* surface (one the user actually wrote a `surfaces:` entry for) IS an
 * error here — see the `config/no-files` stage below. Zero matches overall, when every surface
 * in the run was synthesized by zero-config auto-detection rather than written by the user,
 * is not: there is no `surfaces:` entry to have gotten wrong.
 *
 * A surface's own `include` patterns are untrusted the same way its `root` is: an absolute
 * pattern (`/etc/passwd`) or a `..`-escaping one (`../../outside/x.md`) can make tinyglobby
 * match a file outside the repository even though `rootReal` itself is safely inside it —
 * every such match is collected (across all surfaces) into one `ConfigError`, matching
 * `validateSurfaces`'s collect-all convention, instead of silently leaking an out-of-repo
 * path into `Document.path` / `Diagnostic.file`.
 */
export async function discoverFiles(
	config: ResolvedConfig,
): Promise<readonly DiscoveredFile[]> {
	const validated = await validateSurfaces(config);

	const claimed = new Map<string, ValidatedSurface>();
	// Keyed and sorted by path before anything is reported: tinyglobby's match order is not
	// stable between runs (verified — the same glob over the same directory returns a different
	// order), so building the problem list in match order made the output, and the test pinning
	// it, nondeterministic. Discovery's own result was always sorted; its errors were not.
	const perFile = new Map<string, ConfigProblem>();

	for (const entry of validated) {
		const { surface, rootReal, posixRoot } = entry;
		const matches = await glob(surface.include, {
			cwd: rootReal,
			ignore: [...surface.ignore, ...config.ignore],
			dot: true,
			followSymbolicLinks: false,
			expandDirectories: false,
		});

		for (const match of matches) {
			const joined = posix.join(posixRoot, match);
			if (escapesRepoPosix(joined)) {
				perFile.set(joined, {
					message: `include pattern of ${describeValidatedSurface(entry)} matches a file outside the repository: ${joined}`,
					...locOf(surface),
				});
				continue;
			}
			const owner = claimed.get(joined);
			if (owner === undefined) {
				claimed.set(joined, entry);
				continue;
			}
			perFile.set(joined, {
				message: `"${joined}" is matched by ${describeValidatedSurface(owner)} and ${describeValidatedSurface(entry)}; a file belongs to exactly one surface — list several dialects on one surface instead of overlapping two`,
				...locOf(surface),
			});
		}
	}

	if (perFile.size > 0) {
		throw new ConfigError(
			config.configFile,
			[...perFile.keys()]
				.sort()
				.map((path) => perFile.get(path) as ConfigProblem),
		);
	}

	// Third stage, strictly after the overlap check above: order matters. A surface whose every
	// file was claimed by an *earlier* surface has a claimed-count of zero too, and looks
	// exactly like a surface that matched nothing on its own — but it isn't a second, distinct
	// mistake, it's the same overlap already reported. Diagnosing it again here as "matched no
	// files" would be a bogus second diagnosis of one problem, so this stage never runs unless
	// the overlap check above found nothing to throw on.
	const claimedCounts = new Map<number, number>();
	for (const entry of claimed.values()) {
		claimedCounts.set(entry.index, (claimedCounts.get(entry.index) ?? 0) + 1);
	}
	const noFilesProblems: ConfigProblem[] = [];
	for (const entry of validated) {
		// `loc` doubles here as "the user actually wrote this surface in yaml": zero-config
		// auto-detection synthesizes surfaces straight from the directory layout and gives them
		// no `loc` (nothing to blame), and its contract is "notice on stderr + exit 0" even for
		// an empty detected directory — turning that into a `ConfigError` here would break it.
		// Side effect, and it is test-visible: a surface a test builds by hand without a `loc`
		// silently opts out of this check too, same as a detected one.
		if (entry.surface.loc === undefined) {
			continue;
		}
		if ((claimedCounts.get(entry.index) ?? 0) > 0) {
			continue;
		}
		const { include } = entry.surface;
		// The effective `ignore` list belongs in the message too: without it, the message names
		// only `include` — unfixable advice
		// when it was actually `ignore` that filtered out the one file that matched (e.g.
		// `ignore: ["**/a/**"]` over a surface whose only file is `skills/a/SKILL.md`, where the
		// message used to blame `**/SKILL.md`, the pattern that DOES match the file). Same order
		// discovery itself passes to `glob` above (surface's own `ignore`, then `config.ignore`),
		// so the two lists a user reads here are never reordered relative to what actually ran.
		// Printed unconditionally, never branched on emptiness: `loadConfig` always merges in the
		// always-on defaults (`DEFAULT_IGNORE`), so in a normal run this list is never empty.
		const ignoreList = [...entry.surface.ignore, ...config.ignore];
		const message =
			include.length === 0
				? `${describeValidatedSurface(entry)} matched no files; its include list is empty; ignore patterns: ${ignoreList.join(", ")}`
				: `${describeValidatedSurface(entry)} matched no files; include patterns: ${include.join(", ")}; ignore patterns: ${ignoreList.join(", ")}`;
		noFilesProblems.push({
			message,
			ruleId: NO_FILES_RULE_ID,
			...locOf(entry.surface),
		});
	}
	if (noFilesProblems.length > 0) {
		throw new ConfigError(config.configFile, noFilesProblems);
	}

	return [...claimed.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, entry]) => ({ path, surface: entry.surface }));
}
