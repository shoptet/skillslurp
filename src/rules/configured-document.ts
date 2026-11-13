/**
 * Reading the ONE document a rule was configured to point at — the half of `index/*`'s
 * `loadIndexAnalysis` that has nothing to do with links, factored out here so
 * `docs/contract-sync` reads its configured contract document through the identical code path
 * rather than a second copy of it.
 *
 * Two rule families now take a required, repo-root-relative `file` option and have the identical
 * failure mode when it names nothing readable, so the normalization, the repo-containment test,
 * the symlink-escape check and the single `config/missing-file` report all live once, here. What
 * each family does with the parsed document afterwards is its own business and stays in its own
 * module (`rules/index/shared.ts`'s `classifyLinks`, `rules/docs/contract-sync.ts`'s block
 * comparison).
 *
 * Not itself a rule — no `meta`, no `kind` — so it sits directly under `rules/` next to the
 * other shared, family-spanning helpers (`rules/frontmatter.ts`, `rules/activation.ts`) rather
 * than under either family's own directory.
 */

import { readFile, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { RuleContext } from "../context.js";
import { type Document, parseSource } from "../document.js";
import { isWithinRoot, resolveRealDirectory } from "../paths.js";
import type { ConfigReport } from "../rule.js";

/**
 * The one option every rule reading a configured document takes. A structural type, not a zod
 * schema: each rule declares its OWN `optionsSchema` (`IndexOptionsSchema` in
 * `rules/index/shared.ts`, `OptionsSchema` in `rules/docs/contract-sync.ts`) so that its
 * user-facing validation errors and its JSDoc stay its own, and this is only the constraint
 * `loadConfiguredDocument` needs from whatever those schemas produce.
 */
export interface ConfiguredFileOptions {
	readonly file: string;
}

/**
 * Normalizes the `file` option to a posix, repo-root-relative path before it is used for
 * anything — resolved against `ctx.root`, compared against a discovered document's own `.path`,
 * or echoed back verbatim into a diagnostic's `file` field. The option's contract is
 * "repo-root-relative, posix", the same contract `ResolvedSurface.root` and `Document.path`
 * already keep — but unlike those two, this string comes straight out of a user's yaml with
 * nothing upstream enforcing it. `posix.normalize` alone collapses a `./` prefix
 * (`"./SKILLS.md"` → `"SKILLS.md"`) but does NOT collapse a backslash — backslash is not a posix
 * separator — so a Windows-authored `file: "skills\\SKILLS.md"` would otherwise resolve to a
 * literal, unmatchable path segment. Converting every backslash to `/` first is what keeps that
 * from happening silently.
 *
 * A trailing slash is stripped too: a directory is never a valid `file` for either rule
 * family (there is nothing to `readFile`), but `posix.normalize` does not treat one as noise the
 * way `resolve` does — measured, `posix.normalize("SKILLS.md/") === "SKILLS.md/"` while
 * `resolve(root, "SKILLS.md/")` drops it — so without this strip the file itself still reads
 * fine (the OS ignores it) while the trailing slash survives into the returned `path` and from
 * there into `Diagnostic.file`/message text as a spelling neither `Document.path` nor this
 * option's own contract recognizes. Guarded so the bare root `"/"` (already absolute, and
 * rejected as such by `isRepoRelative` below regardless of this function) is not collapsed to
 * the empty string.
 *
 * Deliberately NOT collapsed into the engine's own `normalizeReportFile` (engine.ts), which
 * looks similar: that one normalizes a report a rule is HANDING OUT, where a directory is a
 * perfectly ordinary value; this one normalizes a config OPTION, where it never is. The two
 * answer different questions about different values and are kept apart on purpose.
 */
export function normalizeConfiguredPath(raw: string): string {
	const normalized = posix.normalize(raw.replace(/\\/g, "/"));
	return normalized.length > 1 && normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
}

/**
 * True for an already-posix, normalized path that stays inside the repository — the same lexical
 * test `engine.ts`'s `escapesRepoPosix` runs on a rule's OUTGOING `RuleReport.file`, applied here
 * to an INCOMING config value instead: a `file` option normalizing to `../outside.md` or to an
 * absolute path names nothing a rule could ever check without reading outside the repository
 * being linted, so it is treated identically to a genuinely missing file rather than ever
 * reaching `resolve(ctx.root, ...)`.
 */
function isRepoRelative(path: string): boolean {
	return !posix.isAbsolute(path) && path !== ".." && !path.startsWith("../");
}

/**
 * The `<problem>` half of the `config/<problem>` id a configured-but-unreadable document is
 * reported under. One name for one mistake, shared by `index/*` and `docs/contract-sync` because
 * they share this whole loader.
 */
export const MISSING_FILE_PROBLEM = "missing-file";

/**
 * The report for a configured `file` that cannot be read — missing from disk entirely, or
 * normalizing to a path outside the repository (`isRepoRelative` above).
 *
 * A `ConfigReport`, not a `RuleReport`: the user's REPOSITORY is not wrong here, their
 * CONFIGURATION is — they pointed `options.file` at something that is not there — which is the
 * same statement `config/no-files` already makes about an explicitly configured surface
 * matching zero files. So the engine emits it as `config/missing-file` at `error`, whatever
 * severity the reporting rule is configured at, and every rule reading a configured document
 * reports it identically because they share this one function.
 *
 * Neither `file` nor `loc` is set, deliberately: the engine defaults them to the config file and
 * to `ctx.surface.loc` — where that surface is written in the config yaml — which is the thing
 * actually at fault and a position the user can go and edit. (`loc` is absent only for an
 * auto-detected surface, and no rule taking a required `file` option can be enabled on one: they
 * all claim no tier, so a detected run cannot turn them on.)
 *
 * **`path` still belongs in `message`, verbatim.** It is the spelling the user has to
 * search their config for, however it reads — `"../outside.md"`, `"/etc/passwd"`, even `".."` —
 * and `message` is the one field with no path contract to violate.
 *
 * `label` names the KIND of document for the reader ("Index", "Contract"); it is the only part
 * of this message either family gets to choose.
 */
function missingFileReport(label: string, path: string): ConfigReport {
	return {
		problem: MISSING_FILE_PROBLEM,
		message: `${label} file "${path}" does not exist`,
	};
}

/** What `loadConfiguredDocument` found; `missing` covers both ways the configured `file` fails. */
export type ConfiguredDocumentResult =
	| { readonly kind: "missing"; readonly report: ConfigReport }
	| {
			readonly kind: "loaded";
			/** the configured `file`, normalized (see `normalizeConfiguredPath`) */
			readonly path: string;
			/** parsed from the file's real path, so relative links inside it resolve correctly */
			readonly doc: Document;
	  };

/**
 * Reads and parses the single document `ctx.options.file` names, or reports why it could not be.
 *
 * Never throws for a bad path: a rule whose `check` threw would take the whole run down
 * (engine.ts rethrows a rule's error as a bug) over one unreadable configured path, so every
 * read failure — not only ENOENT — comes back as `{ kind: "missing" }` with the one
 * `config/missing-file` report above.
 *
 * The returned `Document.surface` is `ctx.surface` and callers must not read it: a configured
 * document is not necessarily a member of that surface, or of any surface — it can sit outside
 * every surface root, which is the whole point of it being configured by path. `ctx.surface` is
 * passed only because `parseSource` requires SOME `ResolvedSurface`.
 */
export async function loadConfiguredDocument<O extends ConfiguredFileOptions>(
	ctx: RuleContext<O>,
	label: string,
): Promise<ConfiguredDocumentResult> {
	const path = normalizeConfiguredPath(ctx.options.file);
	if (!isRepoRelative(path)) {
		return { kind: "missing", report: missingFileReport(label, path) };
	}

	const absPath = resolve(ctx.root, path);
	let raw: string;
	let realAbsPath: string;
	try {
		// Symlink containment, matching the posture `discover.ts` deliberately establishes
		// for every OTHER document it reads (`followSymbolicLinks: false` plus `realpath` on both
		// the surface root and the repo root, `validateSurfaces`) — this read used to go straight
		// off `absPath` with no such check, so a *tracked* symlink whose target lives outside the
		// repo (`notes.md -> /elsewhere/secret.md`, configured as `file: "notes.md"`) had its
		// content read, parsed, and reported on — an out-of-repo file's content reaching
		// user-visible diagnostics. `resolveRealDirectory` (paths.ts) is directory-only (see its
		// own doc), so it is reused here for exactly the half of this it can do — resolving the
		// REPO root's real path, the identical call `discover.ts`'s `validateSurfaces` makes on
		// `config.root` — falling back to `ctx.root` itself only if that somehow fails (it cannot,
		// in practice: the engine would not be running rules against a repo root it could not
		// resolve). `realpath` on `absPath` (a FILE, not a directory, so the helper above cannot
		// resolve it) is the one new syscall.
		const repoReal = (await resolveRealDirectory(ctx.root)) ?? ctx.root;
		realAbsPath = await realpath(absPath);
		if (!isWithinRoot(repoReal, realAbsPath)) {
			// Funnelled into the catch below on purpose: an escaping symlink is reported exactly
			// like a missing file — one message, no errno, no machine-absolute path (the property
			// this check exists to keep) — rather than a second, differently-worded report.
			throw new Error("configured file escapes the repository");
		}
		raw = await readFile(realAbsPath, "utf8");
	} catch {
		// Any read failure, not only ENOENT — a directory (EISDIR), a permission error, a broken
		// symlink — is read as "not there", because a rule whose `check` threw would take the whole
		// run down (engine.ts rethrows a rule's error as a bug) over one unreadable configured
		// path. This is deliberately the last filesystem access either caller makes to answer an
		// existence question: `index/*`'s link targets are resolved against git's index instead,
		// and the one error that must NOT be swallowed here, `NotAGitCheckoutError`, is
		// raised outside this function for exactly that reason.
		return { kind: "missing", report: missingFileReport(label, path) };
	}

	// `realAbsPath`, not the lexical `absPath` computed above, so a relative link written inside
	// a SYMLINKED document resolves against its real directory — the same posture the containment
	// check just established.
	return {
		kind: "loaded",
		path,
		doc: parseSource(path, realAbsPath, raw, ctx.surface),
	};
}
