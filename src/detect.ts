/**
 * Zero-config auto-detection.
 *
 * When no `skillslurp.json` exists, `loadConfig`'s ENOENT hook calls `detectSurfaces`
 * instead of failing outright: a fixed table of known agent-skill layouts is scanned, and every
 * directory that actually exists AND holds at least one matching file becomes a `DetectedSurface`,
 * which `loadConfig` then resolves into a `ResolvedSurface` exactly as if the user had written a
 * `surfaces:` entry for it.
 *
 * This module produces data only — it does not know what a `ResolvedSurface` is and must not
 * import anything from config.ts at runtime. That split is deliberate, not incidental: an
 * earlier version had `config.ts` import `detectSurfaces` from here while this module imported
 * `freezeSurface`/`sealMap`/`DEFAULT_INCLUDE`/`DEFAULT_IGNORE` back from `config.ts`, forming a
 * genuine ESM import cycle. It "worked" only because `sealMap`/`freezeSurface` happened to be
 * hoisted `function` declarations — evaluating `EMPTY_SURFACE_RULES = sealMap(new Map())` at
 * this module's top level, before `config.ts`'s body had run, was safe only by accident of
 * declaration style. Rewriting either as a `const` arrow function would have thrown a TDZ
 * `ReferenceError` at import time. Detection producing plain data, and `loadConfig` resolving
 * it, removes the cycle rather than legalizing it: this module now imports only `node:fs/
 * promises`, `node:path`, `tinyglobby`, `./paths.js`, and (type-only, plus one value)
 * `./dialects.js`.
 *
 * The constraint is enforced mechanically, not by convention: `biome.json` turns on Biome's
 * `lint/suspicious/noImportCycles` (`error`) repo-wide, so a future edit that reintroduces a
 * value edge back onto config.ts fails `bun run lint` the same way any other lint violation
 * does. An earlier version of this guarantee was a regex test on this file's own source text,
 * replaced because it could see a direct `import "./config.js"` but not an indirect cycle
 * through a third module, which is exactly the shape `noImportCycles` catches instead.
 *
 * The CANDIDATE_TABLE order is the determinism contract, not a stylistic choice: it decides the
 * order surfaces are announced in (run.ts), and it is the tie-break for two candidates that
 * resolve to the same real directory, or whose equally deep real directories share files (see
 * the two dedupe passes below) — the real directory wins, then table order.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { glob } from "tinyglobby";
import {
	type DialectId,
	defaultInclude,
	type SurfaceKind,
} from "./dialects.js";
import { resolveRealDirectory } from "./paths.js";

interface DetectionCandidate {
	/** relative to the repo root, posix-separated (matches how it is joined and displayed) */
	readonly root: string;
	readonly kind: SurfaceKind;
	/** exactly one dialect per table row; merge (below) may add more at a shared root */
	readonly dialects: readonly DialectId[];
}

/** Builds one frozen, correctly-typed table row; see `CANDIDATE_TABLE`. */
function candidate(
	root: string,
	kind: SurfaceKind,
	dialects: readonly DialectId[],
): DetectionCandidate {
	return Object.freeze({ root, kind, dialects: Object.freeze([...dialects]) });
}

/**
 * The detection table. Every row's dialect must actually define a contract for that row's
 * kind — asserted in detect.test.ts against `BUILTIN_DIALECTS`, so a typo here (e.g. pairing
 * `.cursor/rules` with a dialect that only speaks `skills`) cannot silently ship a surface with
 * nothing to check it against. Exported (frozen, table order preserved) for that test alone;
 * every runtime caller needs only `detectSurfaces` and `CANDIDATE_ROOTS`.
 */
export const CANDIDATE_TABLE: readonly DetectionCandidate[] = Object.freeze([
	candidate(".claude/skills", "skills", ["claude-code"]),
	candidate(".agents/skills", "skills", ["generic"]),
	candidate(".opencode/skills", "skills", ["opencode"]),
	candidate(".cursor/skills", "skills", ["cursor"]),
	candidate(".github/skills", "skills", ["copilot"]),
	candidate(".cursor/rules", "rules", ["cursor"]),
	candidate(".github/instructions", "instructions", ["copilot"]),
]);

/**
 * The candidate roots, in table order, exported so a "nothing detected" notice (run.ts) can
 * list exactly what was looked for without duplicating the table.
 */
export const CANDIDATE_ROOTS: readonly string[] = Object.freeze(
	CANDIDATE_TABLE.map((c) => c.root),
);

/**
 * A directory zero-config auto-detection found and matched against `CANDIDATE_TABLE` — plain
 * data, not yet a `ResolvedSurface`. `loadConfig` (config.ts) is what turns this into one,
 * filling in `include` (from `defaultInclude(kind, dialects)`), `ignore: []`, an empty sealed
 * `rules` map, and no `loc` — see `loadConfig`'s detected-origin branch for why each of those
 * fields takes the value it does.
 */
export interface DetectedSurface {
	/** relative to the repo root, posix-separated */
	readonly root: string;
	readonly kind: SurfaceKind;
	/** deduped, table order preserved */
	readonly dialects: readonly DialectId[];
	/** the other candidates that reached `root`'s real directory, in table order; often empty */
	readonly spokes: readonly DetectedSpoke[];
}

/** A candidate that reaches a detected surface's directory through a symlink; it has no `loc` key. */
export interface DetectedSpoke {
	/** relative to the repo root, posix-separated */
	readonly path: string;
}

/**
 * A table-order candidate that resolved to a real directory inside the repo but produced no
 * surface — distinct from a candidate whose directory simply is not there, which is not
 * reportable and does not appear here at all. `run.ts` reads this to tell "this layout does not
 * exist" (silence) apart from "this layout is sitting right there and something is wrong with
 * it" (a `SkippedCandidate` entry) in both the none-found notice and the detected-run
 * announcement.
 *
 * A union on `reason` so that the kept root exists only where it means something: an entry never
 * carries an own `keptRoot` key unless its reason is `"overlaps"`.
 */
export type SkippedCandidate =
	| {
			/** relative to the repo root, posix-separated — matches `DetectionCandidate.root` */
			readonly root: string;
			/**
			 * `"no-match"` — the directory exists but zero files matched `defaultInclude(kind, dialects)`.
			 * Covers both a genuinely empty (or non-matching) directory and one whose match glob
			 * silently returned nothing for another reason (e.g. `EACCES` on the directory itself
			 * — tinyglobby swallows the error and returns `[]`, indistinguishable from empty at
			 * this layer). `"outside-repo"` — the directory's real path resolves outside `absRoot`
			 * (a symlinked hub pointing elsewhere on disk).
			 */
			readonly reason: "no-match" | "outside-repo";
	  }
	| {
			readonly root: string;
			/**
			 * Its matched files intersect those of a candidate with a different real directory
			 * (e.g. `.agents/skills` symlinked to `.claude`, the parent of `.claude/skills`), and
			 * that candidate, named by `keptRoot`, won on depth.
			 */
			readonly reason: "overlaps";
			/** the `root` of the surviving candidate, as it appears in `DetectedSurface.root` */
			readonly keptRoot: string;
	  };

/** `detectSurfaces`'s full return value — see that function and `SkippedCandidate`. */
export interface DetectionResult {
	readonly surfaces: readonly DetectedSurface[];
	/** candidates that resolved to a real directory but produced no surface, in table order */
	readonly skipped: readonly SkippedCandidate[];
}

interface Hit {
	readonly candidate: DetectionCandidate;
	/** position in `CANDIDATE_TABLE` — the tie-break, and the order `skipped` is reported in */
	readonly index: number;
	/** real, symlink-free absolute path — the dedupe key */
	readonly rootReal: string;
	/** whether the candidate's own path is `rootReal`, i.e. no symlink lies on the way to it */
	readonly isReal: boolean;
	/** path segments of `rootReal` below the repo root, so a deeper directory has a larger number */
	readonly depth: number;
	/** every matched file as `rootReal` + match: the key two candidates collide on in discovery */
	readonly files: ReadonlySet<string>;
}

interface HitGroup {
	readonly kind: SurfaceKind;
	readonly dialects: DialectId[];
	/** the first hit for this real directory; its position and files stand for the group */
	readonly hit: Hit;
	/** `hit` plus every later same-kind hit merged into it, in table order */
	readonly members: Hit[];
}

interface MergedSurface extends HitGroup {
	readonly root: string;
	readonly spokes: readonly string[];
}

function sharesFile(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
	for (const file of smaller) {
		if (larger.has(file)) {
			return true;
		}
	}
	return false;
}

/**
 * Scans `CANDIDATE_TABLE` under `absRoot` and returns the surfaces that should be synthesized,
 * in table order, alongside the candidates that resolved to a real directory but produced
 * nothing (`skipped` — see `SkippedCandidate`).
 *
 * `ignore` is the glob-exclude list to scan candidate directories with — `loadConfig` passes its
 * own `DEFAULT_IGNORE` (the always-on `node_modules`/`.git` excludes), the same list discovery
 * will use moments later on these very surfaces. It arrives as a parameter rather than an import
 * specifically to keep this module free of a runtime edge onto `config.ts`, which owns that
 * constant.
 *
 * A candidate is synthesized only if its directory exists AND at least one file matches the
 * kind's default `include` patterns. An existing-but-empty `.claude/skills` must NOT become a
 * detected surface: if it did, a run where every candidate directory is empty would silently
 * report "clean" (zero surfaces, zero diagnostics) instead of telling the user nothing was
 * found at all — that distinction is exactly what `NoSurfacesDetectedError` (config.ts) exists
 * to preserve. It is not, however, silently dropped: it is recorded in `skipped` as
 * `"no-match"`, so a caller can report "this directory exists, but nothing in it matched"
 * rather than falsely implying the layout is not there at all — the bug this type exists to
 * fix. `followSymbolicLinks: false` (a deliberate, separate
 * discovery decision) means a symlink-hub whose skill
 * directories are themselves symlinks also lands here as `"no-match"`: the directory is real,
 * glob just never traverses into it.
 *
 * Two candidates whose real, symlink-resolved directories coincide (a symlinked hub, e.g.
 * `.agents/skills` → `.claude/skills`) are deduped rather than handed to discovery as two
 * surfaces — discovery would reject that with "two surfaces resolve to the same directory" (an
 * exit-2 `ConfigError`) on a run that has no `surfaces:` entry for the error's
 * own advice ("list several dialects on one surface") to point at:
 *   - same `kind` → merge: the candidate whose own path is already its real directory is the
 *     root (table order picks among several, and decides when none is real, as with a hub that is
 *     no candidate); every other candidate becomes a `spoke` of it, in table order. The root is
 *     never a spoke, so a spoke can never be the surface's own directory. The dialects of all of
 *     them are combined (deduped, table order preserved).
 *   - different `kind` → the earlier candidate wins outright; the later one is dropped. Two
 *     different file-shape contracts cannot become one surface, however the directories
 *     happened to line up on disk.
 *   Neither branch is recorded in `skipped`: both candidates are real hits, not a miss — the
 *   later one lost a dedupe decision, it did not resolve to nothing.
 *
 * Two candidates with DIFFERENT real directories can still claim the same file (`.agents/skills`
 * symlinked to `.claude`, the parent of `.claude/skills`): discovery rejects a file matched by
 * two surfaces with an exit-2 `ConfigError`. So the files each surviving candidate matched
 * (real directory + match) are compared, and where two sets intersect the candidate with the
 * deeper real directory is kept (equal depth: the earlier table entry) and the other is dropped
 * and recorded in `skipped` as `"overlaps"`, naming the kept root — unlike the dedupe above, the
 * dropped one may hold files nothing else lints. Candidates whose file sets are disjoint stay
 * separate surfaces however their directories nest.
 *
 * A candidate whose real path resolves OUTSIDE `absRoot` (e.g. `.claude/skills` symlinked to a
 * directory elsewhere on disk) is skipped outright, for the same class of reason: discovery
 * would otherwise report "surface root escapes the repository root" — another exit-2
 * `ConfigError` — for a layout skillslurp chose to lint on the user's behalf, not one they
 * configured. Recorded in `skipped` as `"outside-repo"`, since this too used to be invisible to
 * the user.
 */
export async function detectSurfaces(
	absRoot: string,
	ignore: readonly string[],
): Promise<DetectionResult> {
	const repoReal = await realpath(absRoot);

	const hits: Hit[] = [];
	const skippedAt: {
		readonly index: number;
		readonly entry: SkippedCandidate;
	}[] = [];
	for (const [index, candidate] of CANDIDATE_TABLE.entries()) {
		const rootReal = await resolveRealDirectory(join(absRoot, candidate.root));
		if (rootReal === undefined) {
			continue;
		}

		const rel = relative(repoReal, rootReal);
		const escapesRepo =
			rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
		if (escapesRepo) {
			skippedAt.push({
				index,
				entry: { root: candidate.root, reason: "outside-repo" },
			});
			continue;
		}

		const matches = await glob(
			defaultInclude(candidate.kind, candidate.dialects),
			{
				cwd: rootReal,
				ignore: [...ignore],
				dot: true,
				followSymbolicLinks: false,
				expandDirectories: false,
			},
		);
		if (matches.length === 0) {
			skippedAt.push({
				index,
				entry: { root: candidate.root, reason: "no-match" },
			});
			continue;
		}

		hits.push({
			candidate,
			index,
			rootReal,
			isReal: rootReal === join(repoReal, candidate.root),
			depth: rel === "" ? 0 : rel.split(sep).length,
			files: new Set(matches.map((match) => join(rootReal, match))),
		});
	}

	// A `Map` preserves insertion order, which is what makes it double as both the dedupe index
	// AND the output order: the first hit for a given real directory is the one that inserts a
	// key, so iterating `.values()` afterwards yields the groups in table order.
	const byRealRoot = new Map<string, HitGroup>();
	for (const hit of hits) {
		const existing = byRealRoot.get(hit.rootReal);
		if (existing === undefined) {
			byRealRoot.set(hit.rootReal, {
				kind: hit.candidate.kind,
				dialects: [...hit.candidate.dialects],
				hit,
				members: [hit],
			});
			continue;
		}
		if (existing.kind !== hit.candidate.kind) {
			continue;
		}
		existing.members.push(hit);
		for (const dialect of hit.candidate.dialects) {
			if (!existing.dialects.includes(dialect)) {
				existing.dialects.push(dialect);
			}
		}
	}

	const merged: MergedSurface[] = [...byRealRoot.values()].map((group) => {
		const rootHit = group.members.find((member) => member.isReal) ?? group.hit;
		return {
			...group,
			root: rootHit.candidate.root,
			spokes: group.members
				.filter((member) => member !== rootHit)
				.map((member) => member.candidate.root),
		};
	});
	const byPreference = [...merged].sort(
		(a, b) => b.hit.depth - a.hit.depth || a.hit.index - b.hit.index,
	);
	const kept = new Set<MergedSurface>();
	for (const surface of byPreference) {
		const winner = [...kept].find((other) =>
			sharesFile(other.hit.files, surface.hit.files),
		);
		if (winner === undefined) {
			kept.add(surface);
			continue;
		}
		for (const member of surface.members) {
			skippedAt.push({
				index: member.index,
				entry: {
					root: member.candidate.root,
					reason: "overlaps",
					keptRoot: winner.root,
				},
			});
		}
	}

	skippedAt.sort((a, b) => a.index - b.index);

	return Object.freeze({
		surfaces: Object.freeze(
			merged
				.filter((surface) => kept.has(surface))
				.map((surface) =>
					Object.freeze({
						root: surface.root,
						kind: surface.kind,
						dialects: Object.freeze(surface.dialects),
						spokes: Object.freeze(
							surface.spokes.map((path) => Object.freeze({ path })),
						),
					}),
				),
		),
		skipped: Object.freeze(skippedAt.map(({ entry }) => Object.freeze(entry))),
	});
}
