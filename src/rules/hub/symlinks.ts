import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, posix, relative, resolve } from "node:path";
import { glob } from "tinyglobby";
import type { ResolvedSurface } from "../../config.js";
import type { RepoRuleContext } from "../../context.js";
import { DOCS_URL } from "../../diagnostic.js";
import { type Reader, readerAt } from "../../dialects.js";
import { matcher } from "../../matcher.js";
import {
	pathKey,
	repoRelative,
	resolveRealDirectory,
	toPosixPath,
} from "../../paths.js";
import { freezeRule, type RuleReport, type ShapeRule } from "../../rule.js";
import {
	CHECKED_OUT_AS_FILE,
	climbsOutOfRoot,
	inspectLink,
	type LinkState,
	placeInIndex,
	SYMLINK_MODE,
	type SymlinkState,
} from "../../symlinks.js";

const MOVE_OR_REMOVE = "move it into the hub and link it, or remove it";

/**
 * Checks that every spoke declared on a surface really mirrors that surface's root (the hub),
 * and that what git committed is what is on disk. `recommended` and `strict`, `error`, no
 * options; repository-wide (a `shape` rule), so it is configured in the top-level `rules` only.
 *
 * It acts only on spokes the user wrote (`ResolvedSpoke.loc`): a spoke without a position was
 * not declared in a config, and this rule has no opinion about it. A repository that declares no
 * spokes gets no diagnostics and no git call.
 *
 * No diagnostic carries a position: the position of the declaration belongs to the config file,
 * which is not what is wrong. Each one is filed against the path it is about, the spoke's or an
 * item's. What gets reported, per spoke and in this order:
 *
 * - it does not exist, or is neither a directory nor a symlink; or it is a regular file that git's
 *   index records as a symlink (the change is not staged, or `core.symlinks` was off at checkout);
 * - it is a symlink on disk that git does not track as one (tracked as something else, or not
 *   tracked at all). Git records a link under the path of its REAL parent directory, never under
 *   a symlinked ancestor's, so that is where the index is asked; a link whose real parent is
 *   outside the linted directory is reported as outside instead;
 * - it is a symlink with an absolute target (a relative one stays valid in every checkout);
 * - it is a symlink that does not resolve; or resolves outside the linted directory, or has a
 *   target text that climbs above it on the way even if it comes back in (a checkout named
 *   `app` does not make `../../app/x` a link that stays inside); or resolves somewhere inside
 *   it that is not the hub. The hub is compared by `realpath`, never by its written path, so a
 *   hub reached through a symlink is still the hub. At most one of these three is reported: a
 *   link that does not resolve is reported only as that, even when its target also leaves the
 *   tree, because the lexical "outside" judgement is the weaker of the two and three findings
 *   on one broken absolute link would bury the one fix;
 * - the spoke is reached through a symlinked ancestor (`.claude -> .agents`, spoke
 *   `.claude/skills`) that git does not track as a symlink, or that itself sits outside the linted
 *   directory: only the nearest symlinked ancestor is checked, once per spoke, whatever form an
 *   existing spoke takes.
 *
 * A real directory that is not the hub is an item-level spoke: one symlink per hub item. A hub
 * item is the immediate child of the hub root on the path to a discovered entry document of the
 * surface (`foo` for `foo/SKILL.md`, `group` for `group/foo/SKILL.md`, `a.mdc` for a file entry
 * at the root), so the list comes from discovery, including an item git does not track yet. For
 * each item, `<spoke>/<item>` is checked like a directory-level spoke, against the item's own
 * `realpath`, plus one finding when it is missing and one when it is a real copy instead of a
 * link. (`<item>` is the link's name; a spoke at a tool's reading place can rename it, see the
 * last paragraph.) Entries of the spoke that are not hub items are reported in two cases only. A
 * symlink git tracks is reported when it does not resolve, leaves the linted directory, is a
 * second link to a hub item, or points at something the surface's `include` would lint and no
 * discovered document covers (discovery does not follow links, so nothing does); any other
 * symlink is left alone, and so is one git does not track, which CI never sees.
 * Real content is reported when git tracks it, the surface's `include` matches it from the
 * spoke's root, neither `ignore` list skips it (the surface's is matched from the spoke's root,
 * as discovery matches it from the surface's; the top-level one from the repository root), and no
 * discovered document covers it; untracked content is
 * never seen by CI and so is not reported. Anything else in the directory (a README,
 * `.DS_Store`) is ignored. A declared spoke nested inside another is checked on its own and is
 * not an unexpected entry of the outer one. Item-level findings are against the specific path
 * and come ordered by entry name; a real subfolder's findings come in place of its entry.
 *
 * A spoke declared at exactly the place a tool reads that kind of document (`readerAt`: today
 * `.cursor/rules` on a rules surface, where Cursor reads `.mdc` files and ignores a plain `.md`
 * one) is read by that tool, whichever dialects the surface lists and whatever the hub calls its
 * files. Every other spoke, a nested `packages/web/.cursor/rules` included, keeps the same-name
 * rule above unchanged. For such a spoke:
 *
 * - a hub item that is a file is expected as `<stem><extension>`, `x.md` as `x.mdc` (the last
 *   extension is replaced, or one is appended when there is none; compared case-sensitively, like
 *   the glob). An item already ending in the extension keeps its name, and so does a directory
 *   item, whose entry may instead be a real directory (below), since a link to a directory cannot
 *   rename what is inside it. Keeping the stem is this tool's naming choice; the vendor lets a
 *   rule be named anything. When two items would need one name, the item that already carries it
 *   owns it (else the first by name does) and each other is reported once, at the spoke, as
 *   unlinkable there, never counted as linked by the owner's link;
 * - a directory item whose entry is a real directory, never a link, is a level of its own, to any
 *   depth, unless it is itself a declared spoke, which is checked on its own and gets no report
 *   here. The subfolder is checked like the spoke against the hub directory, with the same checks
 *   and names, worked out within the level (`x.md` beside `backend/x.md` is no collision; a
 *   collision is reported at the subfolder). Its items are the discovered documents beneath the
 *   hub directory, so `include` and `ignore` apply, and a hub directory with no discovered
 *   document expects nothing: its counterpart in the spoke is an entry that is not a hub item,
 *   whose links are never inspected and whose real content is reported once, at that entry.
 *   Real content is found by one walk of the spoke's root, the surface's `ignore` matched from
 *   there. Findings come in place of the subfolder's entry, are filed at the paths inside it, and
 *   name the declared spoke and hub, not the subfolder's;
 * - a link under the hub item's own name that points at the item, when the expected name is
 *   missing, is the one report for the item (rename the link), instead of that and "does not
 *   exist". With the expected link present it is a second link to the item, as always;
 * - a spoke that links the whole hub, and has no other report, is reported once, at the spoke,
 *   when some of the hub's documents are not read by the tool: with the count of them and the first
 *   path through the spoke;
 * - a directory item whose link has no other report is reported once, at the item, with the count
 *   of documents beneath it that the tool does not read, advising to make it a directory of
 *   per-file links;
 * - content of the spoke that is not a hub item is judged by the tool's `include` instead of the
 *   surface's, since that is what the tool reads there; the file name of a link's target is still
 *   judged by the surface's `include`, and a target inside the hub that the surface's `ignore`
 *   skips is skipped too, matched by its path in the hub because the spoke's name no longer
 *   mirrors it.
 */
export const hubSymlinks: ShapeRule = freezeRule({
	kind: "shape",
	meta: {
		id: "hub/symlinks",
		description:
			"A declared spoke that does not mirror its hub through committed, relative symlinks: one link to the whole hub, or one per hub item named as the reading tool expects, with a real folder of such links in place of a hub folder where the tool renames files.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	async check(ctx: RepoRuleContext): Promise<RuleReport[]> {
		const reports: RuleReport[] = [];
		const spokePaths = ctx.surfaces.flatMap((surface) =>
			surface.spokes
				.filter((spoke) => spoke.loc !== undefined)
				.map((spoke) => spoke.path),
		);
		for (const surface of ctx.surfaces) {
			const declared = surface.spokes.filter(
				(spoke) => spoke.loc !== undefined,
			);
			if (declared.length === 0) {
				continue;
			}
			const hubAbs = resolve(ctx.root, surface.root);
			const hubReal = await resolveRealDirectory(hubAbs);
			// Discovery already refused a surface whose root is missing or not a directory.
			if (hubReal === undefined) {
				continue;
			}
			const hub = { path: repoRelative(ctx.root, hubAbs), real: hubReal };
			const modes = await ctx.git.trackedModes();
			for (const spoke of declared) {
				reports.push(
					...(await checkSpoke(
						ctx,
						surface,
						hub,
						spoke.path,
						modes,
						spokePaths,
					)),
				);
			}
		}
		return reports;
	},
});

interface Hub {
	readonly path: string;
	readonly real: string;
}

type Modes = ReadonlyMap<string, string>;

type Reporter = (text: string) => RuleReport;

async function checkSpoke(
	ctx: RepoRuleContext,
	surface: ResolvedSurface,
	hub: Hub,
	spoke: string,
	modes: Modes,
	declared: readonly string[],
): Promise<RuleReport[]> {
	const root = ctx.root;
	const report: Reporter = (text) => ({
		message: `Spoke "${spoke}" of hub "${hub.path}" ${text}`,
		file: spoke,
	});
	const state = await inspectLink(root, spoke);

	const reader = readerAt(surface.kind, spoke);
	if (state.disk === "symlink") {
		const reports = [
			...(await checkLink(
				root,
				{ path: spoke, real: hub.real, label: "the hub" },
				state,
				modes,
				report,
			)),
			...(await checkAncestor(root, spoke, modes, report)),
		];
		if (reports.length === 0 && reader !== undefined) {
			reports.push(...(await checkWholeHub(ctx, surface, hub, reader, report)));
		}
		return reports;
	}
	if (state.disk === "missing") {
		return [report("does not exist")];
	}
	if (state.disk === "file" && (await isCommittedLink(root, spoke, modes))) {
		return [report(CHECKED_OUT_AS_FILE)];
	}
	if (state.disk !== "directory") {
		const kind = state.disk === "file" ? "a regular file" : "a special file";
		return [report(`is neither a directory nor a symlink (it is ${kind})`)];
	}

	const spokeReal = await realpath(resolve(root, spoke));
	const ancestor = await checkAncestor(root, spoke, modes, report);
	if (spokeReal !== hub.real) {
		return [
			...ancestor,
			...(await checkItems(
				ctx,
				surface,
				hub,
				{ path: spoke, real: spokeReal },
				reader,
				modes,
				declared,
			)),
		];
	}
	if (ancestor.length === 0 && reader !== undefined) {
		return checkWholeHub(ctx, surface, hub, reader, report);
	}
	return ancestor;
}

async function checkWholeHub(
	ctx: RepoRuleContext,
	surface: ResolvedSurface,
	hub: Hub,
	reader: Reader,
	report: Reporter,
): Promise<RuleReport[]> {
	const documents = await hubDocuments(ctx, surface, hub);
	const unread = unreadBy(reader, documents);
	const [first] = unread;
	if (first === undefined) {
		return [];
	}
	return [
		report(
			`links the whole hub, but "${reader.dialect}" reads only "${reader.extension}" files there and ignores ${unread.length} of its ${documents.length} ${surface.kind} (first: "${posix.join(reader.path, first)}"); ${perItemAdvice(reader)}`,
		),
	];
}

function perItemAdvice(reader: Reader): string {
	return `make it a directory with one link per hub item, naming each one "<name>${reader.extension}"`;
}

interface Link {
	readonly path: string;
	readonly real: string;
	readonly label: string;
}

async function checkLink(
	root: string,
	link: Link,
	state: SymlinkState,
	modes: Modes,
	report: Reporter,
): Promise<RuleReport[]> {
	const placed = await placeInIndex(root, link.path);
	if (!placed.inside) {
		return [
			report(
				`is itself outside the linted directory (its parent directory resolves to "${repoRelative(root, placed.parent)}")`,
			),
		];
	}
	const reports: RuleReport[] = [];
	if (modes.get(placed.key) !== SYMLINK_MODE) {
		reports.push(
			report(
				`is not committed as a symlink (${describeGitState(modes, placed.key)})`,
			),
		);
	}
	if (isAbsolute(state.target)) {
		reports.push(
			report(
				`is a symlink with the absolute target "${state.target}"; use a relative target so the link stays valid in every checkout`,
			),
		);
	}
	if (state.real === undefined) {
		reports.push(report(`points at "${state.target}", which does not resolve`));
	} else if (
		state.escapes ||
		climbsOutOfRoot(root, placed.parent, state.target)
	) {
		reports.push(
			report(
				`points at "${state.target}", which is outside the linted directory`,
			),
		);
	} else if (state.real !== link.real) {
		reports.push(
			report(
				`points at "${repoRelative(root, state.real)}", not at ${link.label}`,
			),
		);
	}
	return reports;
}

async function checkAncestor(
	root: string,
	spoke: string,
	modes: Modes,
	report: Reporter,
): Promise<RuleReport[]> {
	const ancestor = await nearestSymlinkedAncestor(root, spoke);
	if (ancestor === undefined) {
		return [];
	}
	const placed = await placeInIndex(root, ancestor);
	if (!placed.inside) {
		return [
			report(
				`is reached through "${ancestor}", which is itself outside the linted directory`,
			),
		];
	}
	if (modes.get(placed.key) === SYMLINK_MODE) {
		return [];
	}
	return [
		report(
			`is reached through "${ancestor}", which is not committed as a symlink (${describeGitState(modes, placed.key)})`,
		),
	];
}

interface ItemSpoke {
	readonly path: string;
	readonly real: string;
}

interface ItemScope {
	readonly ctx: RepoRuleContext;
	readonly surface: ResolvedSurface;
	readonly hub: Hub;
	readonly spoke: ItemSpoke;
	readonly reader: Reader | undefined;
	readonly modes: Modes;
	readonly dir: string;
	readonly label: { readonly spoke: string; readonly hub: string };
	readonly hubRoot: string;
	readonly documents: readonly string[];
	readonly nested: readonly string[];
	readonly unlinted: readonly string[];
	readonly items: readonly string[];
	readonly linted: ReadonlySet<string>;
	readonly included: (path: string) => boolean;
	readonly nameIncluded: (path: string) => boolean;
	readonly ignoredBySurface: (path: string) => boolean;
}

interface HubItem {
	readonly name: string;
	readonly directory: boolean;
}

interface ExpectedLink {
	readonly name: string;
	readonly item: string;
}

interface Collision {
	readonly item: string;
	readonly name: string;
	readonly owner: string;
}

type Entry =
	| { readonly kind: "link"; readonly name: string; readonly item: string }
	| { readonly kind: "stray"; readonly name: string };

/**
 * The name a link to the file hub item `item` carries where a tool reads only `extension` files:
 * the last extension replaced, or appended when the name has none. Compared case-sensitively.
 */
export function linkNameFor(item: string, extension: string): string {
	const current = posix.extname(item);
	const stem = current === "" ? item : item.slice(0, -current.length);
	return `${stem}${extension}`;
}

function planLinks(
	items: readonly HubItem[],
	reader: Reader | undefined,
): { links: ExpectedLink[]; collisions: Collision[] } {
	const wanted = new Map<string, string[]>();
	for (const item of items) {
		const name =
			reader !== undefined && !item.directory
				? linkNameFor(item.name, reader.extension)
				: item.name;
		const group = wanted.get(name);
		if (group === undefined) {
			wanted.set(name, [item.name]);
		} else {
			group.push(item.name);
		}
	}
	const links: ExpectedLink[] = [];
	const collisions: Collision[] = [];
	for (const [name, group] of wanted) {
		const owner = group.includes(name)
			? name
			: [...group].sort(compareNames)[0];
		if (owner === undefined) {
			continue;
		}
		links.push({ name, item: owner });
		for (const item of group) {
			if (item !== owner) {
				collisions.push({ item, name, owner });
			}
		}
	}
	collisions.sort((a, b) => compareNames(a.item, b.item));
	return { links, collisions };
}

async function checkItems(
	ctx: RepoRuleContext,
	surface: ResolvedSurface,
	hub: Hub,
	spoke: ItemSpoke,
	reader: Reader | undefined,
	modes: Modes,
	declared: readonly string[],
): Promise<RuleReport[]> {
	const documents = await hubDocuments(ctx, surface, hub);
	const nested = declared
		.filter((path) => path.startsWith(`${spoke.path}/`))
		.map((path) => path.slice(spoke.path.length + 1));
	const linted = new Set((await ctx.documents()).map((doc) => doc.absPath));
	const unlinted = await unlintedEntries({
		ctx,
		surface,
		spoke,
		reader,
		modes,
		nested,
		linted,
	});
	return checkLevel({
		ctx,
		surface,
		hub,
		spoke,
		reader,
		modes,
		dir: "",
		label: { spoke: spoke.path, hub: hub.path },
		hubRoot: hub.real,
		documents,
		nested,
		unlinted,
		items: hubItems(documents).map((item) => item.name),
		linted,
		included: matcher(surface.include),
		nameIncluded: matcher(reader?.include ?? surface.include),
		ignoredBySurface: matcher(surface.ignore),
	});
}

async function checkLevel(scope: ItemScope): Promise<RuleReport[]> {
	const { ctx, surface, hub, spoke, reader, modes, documents, label } = scope;
	const items = hubItems(documents);
	const { links, collisions } = planLinks(items, reader);
	const linkKeys = new Set(links.map((link) => pathKey(link.name)));
	const present = await readdir(spoke.real);
	const presentKeys = new Set(present.map(pathKey));
	const strays = present.filter((name) => !linkKeys.has(pathKey(name)));
	const unlinted = namesAt(scope.unlinted, scope.dir);
	const directories = new Set(
		items.filter((item) => item.directory).map((item) => item.name),
	);
	const hubNamed = await hubNamedLinks(scope, links);

	const entries: Entry[] = [
		...links.map((link): Entry => ({ kind: "link", ...link })),
		...strays.map((name): Entry => ({ kind: "stray", name })),
	].sort((a, b) => compareNames(a.name, b.name));
	const reports: RuleReport[] = [];
	if (reader !== undefined) {
		for (const collision of collisions) {
			reports.push({
				message: `Spoke "${label.spoke}" of hub "${label.hub}": the hub item "${posix.join(hub.path, collision.item)}" cannot be linked there, because its "${reader.extension}" name "${collision.name}" is also the name of the hub item "${posix.join(hub.path, collision.owner)}"; rename one of them`,
				file: spoke.path,
			});
		}
	}
	for (const entry of entries) {
		if (entry.kind === "link" && hubNamed.covered.has(pathKey(entry.name))) {
			continue;
		}
		const path = posix.join(spoke.path, entry.name);
		const report: Reporter = (text) => ({
			message: `Spoke "${label.spoke}" of hub "${label.hub}": "${path}" ${text}`,
			file: path,
		});
		const state = await inspectLink(ctx.root, path);
		if (entry.kind === "link") {
			if (
				reader !== undefined &&
				directories.has(entry.item) &&
				state.disk === "directory" &&
				presentKeys.has(pathKey(entry.name))
			) {
				if (!scope.nested.includes(posix.join(scope.dir, entry.item))) {
					reports.push(
						...(await checkLevel(await childScope(scope, entry.item))),
					);
				}
				continue;
			}
			const found = await checkItem(
				ctx.root,
				hub,
				entry.item,
				path,
				state,
				modes,
				report,
			);
			reports.push(...found);
			if (
				found.length === 0 &&
				reader !== undefined &&
				directories.has(entry.item)
			) {
				const beneath = documents.filter((doc) =>
					doc.startsWith(`${entry.item}/`),
				);
				const unread = unreadBy(reader, beneath);
				const [first] = unread;
				if (first !== undefined) {
					reports.push(
						report(
							`is a link to the hub item "${posix.join(hub.path, entry.item)}", but "${reader.dialect}" reads only "${reader.extension}" files there and ignores ${unread.length} of its ${beneath.length} ${surface.kind} (first: "${posix.join(spoke.path, first)}"); a link to a directory cannot rename what is inside it, so ${perItemAdvice(reader)}`,
						),
					);
				}
			}
		} else if (state.disk === "symlink") {
			const renamed = hubNamed.names.get(pathKey(entry.name));
			if (renamed !== undefined && reader !== undefined) {
				reports.push(
					report(
						`is named like the hub item "${posix.join(hub.path, entry.name)}", but "${reader.dialect}" reads only "${reader.extension}" files there; name the link "${renamed}"`,
					),
				);
			} else if (
				!isNested(scope.nested, posix.join(scope.dir, entry.name)) &&
				(await isTracked(ctx.root, path, modes))
			) {
				const stray = await judgeStray(scope, entry.name, state, report);
				if (stray !== undefined) {
					reports.push(stray);
				}
			}
		} else if (unlinted.has(entry.name)) {
			reports.push(
				report(`is not a hub item and no surface lints it; ${MOVE_OR_REMOVE}`),
			);
		}
	}
	return reports;
}

async function childScope(scope: ItemScope, item: string): Promise<ItemScope> {
	const documents = below(scope.documents, item);
	return {
		...scope,
		dir: posix.join(scope.dir, item),
		hub: {
			path: posix.join(scope.hub.path, item),
			real: await realpath(resolve(scope.hub.real, item)),
		},
		spoke: {
			path: posix.join(scope.spoke.path, item),
			real: await realpath(resolve(scope.spoke.real, item)),
		},
		documents,
		items: hubItems(documents).map((entry) => entry.name),
	};
}

function below(documents: readonly string[], item: string): string[] {
	const prefix = `${item}/`;
	return documents
		.filter((doc) => doc.startsWith(prefix))
		.map((doc) => doc.slice(prefix.length));
}

function isNested(nested: readonly string[], path: string): boolean {
	return nested.some((entry) => entry === path || entry.startsWith(`${path}/`));
}

async function hubNamedLinks(
	scope: ItemScope,
	links: readonly ExpectedLink[],
): Promise<{
	names: ReadonlyMap<string, string>;
	covered: ReadonlySet<string>;
}> {
	const { ctx, hub, spoke, modes } = scope;
	const names = new Map<string, string>();
	const covered = new Set<string>();
	for (const link of links) {
		if (link.name === link.item) {
			continue;
		}
		const expected = await inspectLink(
			ctx.root,
			posix.join(spoke.path, link.name),
		);
		if (expected.disk !== "missing") {
			continue;
		}
		const path = posix.join(spoke.path, link.item);
		const named = await inspectLink(ctx.root, path);
		if (
			named.disk === "symlink" &&
			named.real === resolve(hub.real, link.item) &&
			(await isTracked(ctx.root, path, modes))
		) {
			names.set(pathKey(link.item), link.name);
			covered.add(pathKey(link.name));
		}
	}
	return { names, covered };
}

async function checkItem(
	root: string,
	hub: Hub,
	item: string,
	path: string,
	state: LinkState,
	modes: Modes,
	report: Reporter,
): Promise<RuleReport[]> {
	const hubItem = posix.join(hub.path, item);
	if (state.disk === "missing") {
		return [
			report(
				`does not exist, but "${hubItem}" is a hub item that needs a link there`,
			),
		];
	}
	if (state.disk === "file" && (await isCommittedLink(root, path, modes))) {
		return [report(CHECKED_OUT_AS_FILE)];
	}
	if (state.disk !== "symlink") {
		const what = state.disk === "other" ? "a special file" : "a copy";
		return [report(`is ${what}, not a link to the hub item "${hubItem}"`)];
	}
	return checkLink(
		root,
		{
			path,
			real: resolve(hub.real, item),
			label: `the hub item "${hubItem}"`,
		},
		state,
		modes,
		report,
	);
}

async function judgeStray(
	scope: ItemScope,
	name: string,
	state: SymlinkState,
	report: Reporter,
): Promise<RuleReport | undefined> {
	const { ctx, hub, spoke } = scope;
	const stray = `is a symlink, but "${name}" is not a hub item`;
	if (state.real === undefined) {
		return report(
			`${stray} (it points at "${state.target}", which does not resolve)`,
		);
	}
	if (state.escapes || climbsOutOfRoot(ctx.root, spoke.real, state.target)) {
		return report(
			`${stray} (it points at "${state.target}", which is outside the linted directory)`,
		);
	}
	const alias = scope.items.find(
		(item) => resolve(hub.real, item) === state.real,
	);
	if (alias !== undefined) {
		return report(
			`is a second link to the hub item "${posix.join(hub.path, alias)}"`,
		);
	}
	if (await wouldBeLinted(scope, name, state.real)) {
		return report(
			`${stray} and no surface lints what it points at ("${repoRelative(ctx.root, state.real)}"); ${MOVE_OR_REMOVE}`,
		);
	}
	return undefined;
}

async function wouldBeLinted(
	scope: ItemScope,
	name: string,
	real: string,
): Promise<boolean> {
	const { ctx, surface, spoke, linted } = scope;
	const entry = posix.join(scope.dir, name);
	const skipped = (path: string, abs: string): boolean =>
		scope.ignoredBySurface(path) || ctx.isIgnored(repoRelative(ctx.root, abs));
	const info = await stat(real).catch(() => undefined);
	if (info?.isDirectory()) {
		const matches = await glob(surface.include, {
			cwd: real,
			dot: true,
			followSymbolicLinks: false,
			expandDirectories: false,
		});
		return matches.some(
			(match) =>
				(scope.reader === undefined ||
					scope.nameIncluded(`${entry}/${match}`)) &&
				!skipped(`${entry}/${match}`, resolve(spoke.real, name, match)) &&
				!ignoredInHub(scope, resolve(real, match)) &&
				!linted.has(resolve(real, match)),
		);
	}
	return (
		info?.isFile() === true &&
		scope.nameIncluded(entry) &&
		scope.included(basename(real)) &&
		!skipped(entry, resolve(spoke.real, name)) &&
		!ignoredInHub(scope, real) &&
		!linted.has(real)
	);
}

function ignoredInHub(scope: ItemScope, abs: string): boolean {
	if (scope.reader === undefined) {
		return false;
	}
	const inHub = toPosixPath(relative(scope.hubRoot, abs));
	if (
		inHub === "" ||
		inHub === ".." ||
		inHub.startsWith("../") ||
		isAbsolute(inHub)
	) {
		return false;
	}
	return scope.ignoredBySurface(inHub);
}

async function hubDocuments(
	ctx: RepoRuleContext,
	surface: ResolvedSurface,
	hub: Hub,
): Promise<string[]> {
	const paths: string[] = [];
	for (const doc of await ctx.documents()) {
		if (doc.surface === surface) {
			paths.push(toPosixPath(relative(hub.real, doc.absPath)));
		}
	}
	return paths.sort(compareNames);
}

function hubItems(documents: readonly string[]): HubItem[] {
	const items = new Map<string, boolean>();
	for (const path of documents) {
		const [first, ...rest] = path.split("/");
		if (first !== undefined) {
			items.set(first, rest.length > 0);
		}
	}
	return [...items].map(([name, directory]) => ({ name, directory }));
}

function unreadBy(reader: Reader, documents: readonly string[]): string[] {
	const reads = matcher(reader.include);
	return documents.filter((path) => !reads(path));
}

async function unlintedEntries(
	scope: Pick<
		ItemScope,
		"ctx" | "surface" | "spoke" | "reader" | "modes" | "nested" | "linted"
	>,
): Promise<string[]> {
	const { ctx, surface, spoke, modes, nested, linted } = scope;
	const matches = await glob(scope.reader?.include ?? surface.include, {
		cwd: spoke.real,
		ignore: [...surface.ignore],
		dot: true,
		followSymbolicLinks: false,
		expandDirectories: false,
	});
	const paths: string[] = [];
	for (const match of matches) {
		const abs = resolve(spoke.real, match);
		if (
			nested.some((path) => match === path || match.startsWith(`${path}/`)) ||
			ctx.isIgnored(repoRelative(ctx.root, abs)) ||
			linted.has(abs) ||
			!modes.has(pathKey(repoRelative(ctx.root, abs)))
		) {
			continue;
		}
		paths.push(match);
	}
	return paths;
}

function namesAt(paths: readonly string[], dir: string): ReadonlySet<string> {
	const prefix = dir === "" ? "" : `${dir}/`;
	const names = new Set<string>();
	for (const path of paths) {
		if (!path.startsWith(prefix)) {
			continue;
		}
		const [first] = path.slice(prefix.length).split("/");
		if (first !== undefined) {
			names.add(first);
		}
	}
	return names;
}

function compareNames(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

async function nearestSymlinkedAncestor(
	root: string,
	spoke: string,
): Promise<string | undefined> {
	for (
		let dir = posix.dirname(spoke);
		dir !== "." && dir !== "/";
		dir = posix.dirname(dir)
	) {
		if ((await inspectLink(root, dir)).disk === "symlink") {
			return dir;
		}
	}
	return undefined;
}

async function isTracked(
	root: string,
	path: string,
	modes: Modes,
): Promise<boolean> {
	const placed = await placeInIndex(root, path);
	return placed.inside && modes.has(placed.key);
}

async function isCommittedLink(
	root: string,
	path: string,
	modes: Modes,
): Promise<boolean> {
	const placed = await placeInIndex(root, path);
	return placed.inside && modes.get(placed.key) === SYMLINK_MODE;
}

function describeGitState(modes: Modes, key: string): string {
	const mode = modes.get(key);
	if (mode === "100644" || mode === "100755") {
		return "git tracks it as a regular file";
	}
	if (mode === "160000") {
		return "git tracks it as a submodule";
	}
	if (mode !== undefined) {
		return `git tracks it with mode ${mode}`;
	}
	const prefix = `${key}/`;
	for (const tracked of modes.keys()) {
		if (tracked.startsWith(prefix)) {
			return "git tracks it as a directory";
		}
	}
	return "it is not tracked by git";
}
