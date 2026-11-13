/**
 * Shared machinery for `index/complete` and `index/no-missing-targets`: both rules read the SAME
 * configured index document, resolve its links through `links.ts`'s shared helper, and classify
 * each in-surface-root target as either "a discovered entry document" or "a ghost" — they only
 * differ in which half of that classification they report on (`complete`: an entry with no
 * inbound link; `no-missing-targets`: a link with no real target). Factored here rather than
 * duplicated in both rule files, for the same reason `links.ts` itself was extracted out of
 * `links/resolve`: two copies of "read the index file, walk its links, resolve them" could only
 * drift.
 *
 * Not itself a rule — no `meta`, no `kind` — so it lives as a private sibling of `complete.ts`/
 * `no-missing-targets.ts` under `rules/index/`, the same shape `rules/frontmatter.ts` already has
 * for the `skill/*` rules.
 *
 * What is deliberately NOT here any more: reading the configured `file` at all. That
 * half — normalizing the option, refusing a path that escapes the repository, the symlink
 * containment check, the read, the parse, and the one `config/missing-file` report for every way
 * it can fail — is `rules/configured-document.ts`, because `docs/contract-sync` takes the
 * identical option and has the identical failure mode. Only the link half, which is what makes
 * these two rules an index pair rather than just two rules pointed at a file, stayed behind.
 */

import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { RuleContext } from "../../context.js";
import type { Document } from "../../document.js";
import {
	collectLinkTargets,
	type LinkTarget,
	resolveTarget,
	type TrackedFileIndex,
} from "../../links.js";
import { isWithinRoot, pathKey, resolveRealDirectory } from "../../paths.js";
import type { ConfigReport } from "../../rule.js";
import { loadConfiguredDocument } from "../configured-document.js";

/**
 * Required, and deliberately without a default: there is no index file every
 * surface would want, so a rule enabled with no `options.file` is a config mistake worth
 * stopping for (an absent `options:` block parses as `{}`, which fails this schema and becomes a
 * positioned `ConfigError`), and it is why both rules below claim no tier — a tier that pulled
 * either in would make every default run exit 2. `min(1)`, so `file: ""` is rejected too: an
 * empty string is not a repo-root-relative path to anything.
 */
export const IndexOptionsSchema = z.strictObject({
	file: z.string().min(1),
});
export type IndexOptions = z.infer<typeof IndexOptionsSchema>;

/** What `loadIndexAnalysis` found, `missing` covering both ways the configured `file` can fail. */
export type IndexLoadResult =
	| { readonly kind: "missing"; readonly report: ConfigReport }
	| {
			readonly kind: "analyzed";
			/** the configured `file`, normalized (`normalizeConfiguredPath`, configured-document.ts) */
			readonly indexPath: string;
			/** discovered entry documents that ARE the resolved target of ≥1 link in the index */
			readonly linkedEntryPaths: ReadonlySet<string>;
			/** in-surface-root link targets git is tracking nothing at (see `TrackedFileIndex`) */
			readonly ghosts: readonly LinkTarget[];
			readonly entryDocs: readonly Document[];
	  };

/**
 * Reads and analyzes the configured index file against `ctx.surface`'s discovered entry
 * documents. Shared by both rules' `check`, which each read only the half of `IndexLoadResult`
 * they report on.
 *
 * "Discovered entry documents" is exactly `(await ctx.documents()).filter((doc) => doc.surface
 * === ctx.surface)` — the identity-keyed idiom `RuleContext.surface` exists for, the same
 * one `resolveEnabledBySurface` (engine.ts) already relies on. Consequence worth stating where it
 * is decided, not only where it is used: an "entry document" here is whatever this surface's own
 * `include` patterns matched — nothing more, nothing less. A surface configured with `include:
 * ["**\/*.md"]` would make a skill's own `reference.md` an entry document exactly like its
 * `SKILL.md`, and `index/complete` would then demand a link to it too. That is a real behavioral
 * consequence of leaning on `ctx.surface`/`include` for "what counts as an entry", not a bug in
 * this function — flagged to the orchestrator as a candidate Finding rather than filed here.
 */
export async function loadIndexAnalysis<O extends IndexOptions>(
	ctx: RuleContext<O>,
): Promise<IndexLoadResult> {
	// The read-and-parse half lives in `rules/configured-document.ts`: normalizing the
	// option, refusing a path that escapes the repository, the symlink-containment check,
	// the read, the parse, and the single `config/missing-file` report every one of those
	// failures funnels into. `"Index"` is the only part of that report this rule family chooses.
	const loaded = await loadConfiguredDocument(ctx, "Index");
	if (loaded.kind === "missing") {
		return { kind: "missing", report: loaded.report };
	}
	// `loaded.doc.surface` is `ctx.surface` and is never read: the index file is not necessarily a
	// member of that surface at all — it can sit outside every surface root. Only `.ast`/`.absPath`
	// off it are used below, and `.absPath` is the file's REAL path, so a relative link written
	// inside a SYMLINKED index file resolves against its real directory.
	const { path: indexPath, doc: indexDoc } = loaded;
	const entryDocs = (await ctx.documents()).filter(
		(doc) => doc.surface === ctx.surface,
	);
	// Realpath'd, matching the root discovery itself resolved. `ResolvedSurface.root` is
	// the CONFIGURED spelling, but `discoverFiles` (discover.ts) globs from — and derives every
	// discovered `Document.path` from — `rootReal`, the surface root's OWN realpath: for a
	// symlinked hub (`.agents/skills -> ../.claude/skills`, discover.ts's own words: "the common
	// shape"), that is the TARGET directory, not the link. (`Document.absPath` is a SEPARATE
	// derivation — `document.ts`'s `readDocument` resolves `Document.path` against
	// `ResolvedConfig.root`/`ctx.root`, not against `rootReal` directly — the two only land in
	// the same real space because `ctx.root` is itself canonical; before that fix this
	// comment used to claim `.absPath` came from `rootReal` too, which `document.ts:161`
	// contradicts.) Comparing an entry's real `absPath` against the symlink's lexical path (the
	// bug: `resolve(ctx.root, ctx.surface.root)` with no `realpath`) made a genuinely linked
	// entry read as "outside the surface root" (a false-positive `complete` violation) and let a
	// genuine ghost past the bounds check entirely (a false-negative for `no-missing-targets`) —
	// measured, both directions, from one fixture. `resolveRealDirectory` is the cheapest
	// correct fix reachable from here; it does not close the underlying gap, since
	// `ResolvedSurface` has nowhere to carry the `rootReal`/`posixRoot` discovery already
	// computed, so every consumer that needs containment re-derives it exactly like this.
	// Flagged to the orchestrator as a candidate Finding: the durable fix is for discovery to
	// carry those two fields on the surface itself.
	const surfaceAbsRoot =
		(await resolveRealDirectory(resolve(ctx.root, ctx.surface.root))) ??
		resolve(ctx.root, ctx.surface.root);
	// Outside `loadConfiguredDocument`'s catch, deliberately, and this is why the tracked-file
	// lookup lives out here rather than being folded into that helper: the helper swallows any
	// read failure as "the configured index file is not there", and a `NotAGitCheckoutError`
	// funnelled into that would tell the user their `file` option is wrong when what is actually
	// missing is the git checkout. Left to propagate, it reaches the engine, which recognises it
	// and reports the requirement once (`gitCheckoutRequiredError`, engine.ts).
	const tracked = await ctx.git.trackedFileIndex();
	const { linkedEntryPaths, ghosts } = classifyLinks(
		ctx.root,
		surfaceAbsRoot,
		indexDoc,
		entryDocs,
		tracked,
	);

	return { kind: "analyzed", indexPath, linkedEntryPaths, ghosts, entryDocs };
}

/**
 * Walks every link/image/definition target in `indexDoc` (`collectLinkTargets`, the same walk
 * `links/resolve` runs over its own document) and sorts each into one of three buckets:
 *
 * - not a filesystem path at all, or resolves outside the repository, or resolves inside the
 *   repository but outside `surfaceAbsRoot` — ignored outright, contributing to neither bucket
 *   below. Not every link in an index doc is an index entry: a `../../LICENSE`, a scheme URL or
 *   a bare anchor is something this surface's index has no claim over, so neither rule speaks
 *   to it;
 * - resolves to a discovered entry document's own `absPath` — recorded in `linkedEntryPaths`
 *   (satisfies `index/complete` for that entry) and is, by construction, never a ghost;
 * - resolves inside the surface root but to something else — looked up in `tracked`, the SAME
 *   `TrackedFileIndex` `links/resolve` resolves its own targets against (both resolve against
 *   this one index rather than `stat`, so an index link and an in-document link can never
 *   disagree about whether a path is there). A tracked, non-entry file (e.g. a skill's own
 *   `reference.md`) is NOT a ghost — it just does not land in `linkedEntryPaths` either, so it satisfies neither
 *   rule. That third answer is deliberate, not an unhandled corner of the classification. A link
 *   to a file that is present but untracked IS a ghost now, which is the same intended behaviour
 *   change `links/resolve` took.
 *
 * Synchronous: `has` is a set lookup, so there is no per-target `await` left and no
 * per-call cache to thread through — the memoization moved up to `ctx.git.trackedFileIndex()`,
 * which is per RUN rather than per call.
 */
function classifyLinks(
	root: string,
	surfaceAbsRoot: string,
	indexDoc: Document,
	entryDocs: readonly Document[],
	tracked: TrackedFileIndex,
): {
	linkedEntryPaths: ReadonlySet<string>;
	ghosts: readonly LinkTarget[];
} {
	const targets = collectLinkTargets(indexDoc.ast);
	const docDir = dirname(indexDoc.absPath);
	const entryByAbsPath = new Map(
		entryDocs.map((doc) => [pathKey(doc.absPath), doc]),
	);
	const linkedEntryPaths = new Set<string>();
	const ghosts: LinkTarget[] = [];

	for (const target of targets) {
		const resolution = resolveTarget(target.url, root, docDir);
		if (resolution.kind !== "path") {
			// scheme URL / protocol-relative / anchor-only / query-only / empty / escapes the
			// repository entirely — none of these name a file inside the surface root.
			continue;
		}
		if (!isWithinRoot(surfaceAbsRoot, resolution.absPath)) {
			continue;
		}
		const entry = entryByAbsPath.get(pathKey(resolution.absPath));
		if (entry !== undefined) {
			linkedEntryPaths.add(entry.path);
			continue; // a real, discovered entry — satisfies `complete`, never a ghost
		}
		if (!tracked.has(resolution.absPath)) {
			ghosts.push(target);
		}
	}

	return { linkedEntryPaths, ghosts };
}
