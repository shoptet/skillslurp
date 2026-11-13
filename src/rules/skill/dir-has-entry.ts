import type { RuleContext } from "../../context.js";
import { DOCS_URL } from "../../diagnostic.js";
import { SKILL_ENTRY_FILENAME } from "../../dialects.js";
import { matcher } from "../../matcher.js";
import { collectRootAliases, realRootOf } from "../../mentions.js";
import { pathKey } from "../../paths.js";
import { freezeRule, type ProjectRule, type RuleReport } from "../../rule.js";

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A directory strictly under the surface root, in git's spelling; the flags describe its tracked files. */
interface Dir {
	readonly path: string;
	readonly rel: string;
	readonly key: string;
	readonly children: Map<string, Dir>;
	/** holds, at any depth, a tracked file the top-level `ignore` does not match */
	unignored: boolean;
	/** holds, at any depth, a discovered document or a tracked file the surface's `include` matches */
	holdsEntry: boolean;
	/** the same, but directly in this directory */
	entryHere: boolean;
}

function newDir(path: string, rel: string): Dir {
	return {
		path,
		rel,
		key: pathKey(path),
		children: new Map(),
		unignored: false,
		holdsEntry: false,
		entryHere: false,
	};
}

/**
 * Reports a directory sitting in the `<skill-name>` position of a `skills` surface that holds
 * tracked files but no entry document: a `notes.md` and nothing else, or a `SKILL.md` renamed to
 * `README.md`. `error` in both tiers, no options.
 *
 * Vendor facts. https://code.claude.com/docs/en/skills (fetched 2026-10-01): "Every skill needs a
 * `SKILL.md` file with two parts: …"; its supporting-files tree marks the file "`├── SKILL.md
 * (required - overview and navigation)`"; its location table gives "Project |
 * `.claude/skills/<skill-name>/SKILL.md`". https://agentskills.io/specification (fetched
 * 2026-10-01): "A skill is a directory containing, at minimum, a `SKILL.md` file" and "A skill
 * directory may contain any files and directories beyond the required `SKILL.md`."
 *
 * Not documented in either, so not claimed: what a tool does with a directory in the skills
 * location that has no `SKILL.md` (skipped silently, or warned about), whether a directory of
 * shared helpers may sit there, and whether skill directories may be grouped below
 * `<skill-name>`. The rule asserts only that the directory sits in the `<skill-name>` position
 * and is not a skill, never that any tool rejects it; a repository whose directory is meant to
 * be there says so with an `ignore` entry.
 *
 * ## What is reported
 *
 * The top-most directory under the surface's real root (a symlinked root is judged where it
 * resolves) that meets all of the following, once, with `file` = the directory and no position:
 *
 * - it holds at least one tracked file that the top-level `ignore` list does not match, so an
 *   empty or untracked-only directory, which a fresh checkout does not contain, is not reported;
 * - it holds no discovered document of this surface at any depth, so a grouping directory over
 *   `group/a/SKILL.md` is fine while its entry-less sibling `group/b` is reported;
 * - it holds no tracked file the surface's `include` matches, so an entry git has but discovery
 *   left out (deleted from the working tree, say) is not reported as missing;
 * - the surface's own `ignore` does not match it, read the way discovery prunes directories:
 *   `wip`, `wip/` and `wip/**` all do;
 * - it is not the root or a spoke of another surface and holds none, so a rules surface rooted
 *   inside a skills root is left alone.
 *
 * Two kinds of directory are looked through rather than reported, and the directories below
 * them are judged on their own: a grouping, which holds entries only deeper down, and one that
 * holds another surface's root or spoke. A directory with an entry directly in it is a skill
 * (an item), and everything inside it belongs to that skill and is never judged, so
 * `foo/references/` is clean next to `foo/SKILL.md`, and stays clean when `foo/SKILL.md` is
 * tracked but missing from the working tree.
 *
 * A surface root with a `SKILL.md` directly in it is itself the one skill (`root: "skills/foo"`
 * over `skills/foo/SKILL.md`), however it is reached, and nothing under it is judged. Only the
 * `SKILL.md` name counts there: a flat command file at the root of a commands hub (`deploy.md`
 * under `include: ["**\/*.md"]`) is one entry among many, and the hub's other directories are still
 * judged. A file directly at the surface root is not in any directory, and a tracked symlink
 * directly at the root is a file in git's listing, so neither is reported. Only a `skills` surface is judged:
 * on any other kind an entry is a file, not a directory, and the rule reports nothing. It runs in
 * full under `--diff-base`, like every `project` rule.
 */
export const dirHasEntry: ProjectRule = freezeRule({
	kind: "project",
	meta: {
		id: "skill/dir-has-entry",
		description:
			"A folder in a skills directory that holds files but no `SKILL.md`.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	async check(ctx: RuleContext): Promise<RuleReport[]> {
		const { surface } = ctx;
		if (surface.kind !== "skills") {
			return [];
		}
		const real = await realRootOf(ctx, surface);
		if (real === undefined) {
			return [];
		}

		const rootKeys = real.rel === "." ? [] : real.rel.split("/").map(pathKey);
		const depth = rootKeys.length;
		const underRoot = (segments: readonly string[]): boolean =>
			segments.length > depth &&
			rootKeys.every((key, i) => pathKey(segments[i] ?? "") === key);

		const included = matcher(surface.include);
		const ignoredBySurface = matcher(surface.ignore);

		let rootHoldsEntry = false;
		const top = new Map<string, Dir>();
		for (const path of await ctx.git.trackedFiles()) {
			const segments = path.split("/");
			if (segments.length === depth + 1 && underRoot(segments)) {
				const name = segments[depth];
				if (name === SKILL_ENTRY_FILENAME && included(name)) {
					rootHoldsEntry = true;
				}
				continue;
			}
			if (segments.length < depth + 2 || !underRoot(segments)) {
				continue;
			}
			const unignored = !ctx.isIgnored(path);
			const matchesInclude = included(segments.slice(depth).join("/"));
			let level = top;
			for (let i = depth; i < segments.length - 1; i++) {
				const dirPath = segments.slice(0, i + 1).join("/");
				const key = pathKey(dirPath);
				let dir = level.get(key);
				if (dir === undefined) {
					dir = newDir(dirPath, segments.slice(depth, i + 1).join("/"));
					level.set(key, dir);
				}
				if (unignored) {
					dir.unignored = true;
				}
				if (matchesInclude) {
					dir.holdsEntry = true;
					if (i === segments.length - 2) {
						dir.entryHere = true;
					}
				}
				level = dir.children;
			}
		}
		if (top.size === 0) {
			return [];
		}

		for (const doc of await ctx.documents()) {
			if (doc.surface !== surface) {
				continue;
			}
			const segments = doc.path.split("/");
			if (!underRoot(segments)) {
				continue;
			}
			if (segments.length === depth + 1) {
				if (segments[depth] === SKILL_ENTRY_FILENAME) {
					rootHoldsEntry = true;
				}
				continue;
			}
			let level = top;
			for (let i = depth; i < segments.length - 1; i++) {
				const dir = level.get(pathKey(segments.slice(0, i + 1).join("/")));
				if (dir === undefined) {
					break;
				}
				dir.holdsEntry = true;
				if (i === segments.length - 2) {
					dir.entryHere = true;
				}
				level = dir.children;
			}
		}

		if (rootHoldsEntry) {
			return [];
		}

		const claimed = new Set<string>();
		const holdsClaimed = new Set<string>();
		for (const { alias, target } of await collectRootAliases(ctx)) {
			if (target === real.rel) {
				continue;
			}
			for (const path of [alias, target]) {
				claimed.add(pathKey(path));
				for (
					let slash = path.lastIndexOf("/");
					slash > 0;
					slash = path.lastIndexOf("/", slash - 1)
				) {
					holdsClaimed.add(pathKey(path.slice(0, slash)));
				}
			}
		}

		const found: Dir[] = [];
		const visit = (dir: Dir): void => {
			if (
				ignoredBySurface(dir.rel) ||
				claimed.has(dir.key) ||
				!dir.unignored ||
				dir.entryHere
			) {
				return;
			}
			if (dir.holdsEntry || holdsClaimed.has(dir.key)) {
				for (const child of dir.children.values()) {
					visit(child);
				}
				return;
			}
			found.push(dir);
		};
		for (const dir of top.values()) {
			visit(dir);
		}

		const patterns = surface.include.join(", ");
		return found
			.sort((a, b) => compareStrings(a.path, b.path))
			.map(
				(dir): RuleReport => ({
					message: `Directory "${dir.path}" under skills root "${real.rel}" has no entry document (${patterns})`,
					file: dir.path,
				}),
			);
	},
});
