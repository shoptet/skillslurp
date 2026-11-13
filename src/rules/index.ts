import type { Rule } from "../rule.js";
import { consistentScope } from "./activation/consistent-scope.js";
import { maxGlobShare } from "./activation/max-glob-share.js";
import { noUnmatchedGlobs } from "./activation/no-unmatched-globs.js";
import { valueShape } from "./activation/value-shape.js";
import { docsContractSync } from "./docs/contract-sync.js";
import { fileDefersTo } from "./file/defers-to.js";
import { fileMaxLines } from "./file/max-lines.js";
import { hubSymlinks } from "./hub/symlinks.js";
import { indexComplete } from "./index/complete.js";
import { indexNoMissingTargets } from "./index/no-missing-targets.js";
import { linksResolve } from "./links/resolve.js";
import { noDanglingPaths } from "./refs/no-dangling-paths.js";
import { noUnreachableFiles } from "./refs/no-unreachable-files.js";
import { dirHasEntry } from "./skill/dir-has-entry.js";
import { frontmatterSchema } from "./skill/frontmatter-schema.js";
import { nameMatchesDir } from "./skill/name-matches-dir.js";

/**
 * The registry the CLI passes to `loadConfig` and `runEngine`. Order carries no meaning —
 * `loadConfig` sorts the resolved rule map by id and the engine sorts diagnostics — so this
 * list is kept alphabetical by id for readability. A rule's tier membership lives in its own
 * `meta.tiers`, never here (`activation/max-glob-share`, `file/defers-to`, `index/complete`,
 * `index/no-missing-targets` and `docs/contract-sync` claim none: all five are opt-in, see their
 * own options).
 *
 * Two resolution hazards here, both verified rather than assumed. `./index/complete.js` and
 * `./index/no-missing-targets.js` sit under a directory named `index`, right next to this file's
 * own `index.ts`. `./activation/consistent-scope.js` and `./activation/no-unmatched-globs.js`
 * sit under a directory named `activation`, right next to the unrelated shared module
 * `./activation.js` (`src/rules/activation.ts`, the frontmatter-activation reader).
 * `tsc --noEmit`, `bun test`, `biome check` and `bun build` (the one most likely to resolve
 * a bare `./index` or `./activation` ambiguously) all resolve every import below to the file it
 * names, and the built `dist/cli.js` runs. Every import in this file, in `./index/shared.ts` and
 * in every file under `./activation/` (whose `../activation.js` is the sharpest case) spells out
 * its target file explicitly with a `.js` extension, never a bare `./index` or `./activation`,
 * which is what keeps either pair of same-named siblings from ever being ambiguous to resolve in
 * the first place.
 */
export const builtinRules: readonly Rule[] = Object.freeze([
	consistentScope,
	maxGlobShare,
	noUnmatchedGlobs,
	valueShape,
	docsContractSync,
	fileDefersTo,
	fileMaxLines,
	hubSymlinks,
	indexComplete,
	indexNoMissingTargets,
	linksResolve,
	noDanglingPaths,
	noUnreachableFiles,
	dirHasEntry,
	frontmatterSchema,
	nameMatchesDir,
]);
