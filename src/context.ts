import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { mapBounded } from "./concurrency.js";
import type { ResolvedSurface } from "./config.js";
import type { Document } from "./document.js";
import { runGit } from "./git.js";
import { createTrackedFileIndex, type TrackedFileIndex } from "./links.js";
import { pathKey } from "./paths.js";

export function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => (pending ??= Promise.resolve().then(factory));
}

/**
 * Like `lazy`, but keyed: each distinct `key` gets its own memoized pending promise, computed
 * at most once. The check-then-set pair never awaits in between, so two callers racing on the
 * same key before it resolves still only start one computation — and, matching `lazy`'s own
 * memoize-including-rejection semantics, a rejection is cached too (a repeat call with the same
 * bad key gets back the same rejected promise, not a retry).
 *
 * `ctx.git.diff` is one capability called with many different `base` values over a run (unlike
 * `trackedFiles`/`grep`'s corpus, which have no key at all), so a single `lazy()` would only
 * memoize the *first* `base` ever asked for.
 */
function keyedLazy<T>(
	compute: (key: string) => Promise<T>,
): (key: string) => Promise<T> {
	const cache = new Map<string, Promise<T>>();
	return (key: string) => {
		let pending = cache.get(key);
		if (pending === undefined) {
			pending = compute(key);
			cache.set(key, pending);
		}
		return pending;
	};
}

export interface ChangedFile {
	/**
	 * ROOT-relative (`Capabilities.root`, i.e. the CLI positional arg), posix, matching
	 * `trackedFiles()` and `Document.path` — NOT repo-relative (corrected from what this
	 * comment used to claim). For a rename/copy this is the NEW path — see `parseNameStatusZ`.
	 *
	 * The two bases genuinely disagree when `root` is a subdirectory of the git repository
	 * (`skillslurp packages/foo` in a monorepo): `git ls-files` (`trackedFiles()`'s own
	 * invocation) is already root-relative and root-scoped by construction (`-C root` alone),
	 * while plain `git diff --name-status` is repo-root-relative and reports paths OUTSIDE
	 * `root` too — confirmed empirically (2026-09-04): `git -C packages/foo diff --name-status
	 * -z $BASE...HEAD --` printed both `other/b.md` (outside `root` entirely) and
	 * `packages/foo/docs/a.md` (which should have read `docs/a.md` to match `ls-files`).
	 * `computeDiff` (below) passes `--relative` to close exactly that gap — root-relative,
	 * root-scoped, matching this field's own contract and `trackedFiles()` alike.
	 *
	 * Rejected alternative: making BOTH bases repo-root-relative instead (i.e. leaving `diff`
	 * as-is and changing `ls-files` to not use `-C`). Rejected because every other path in this
	 * system — `Document.path`, `trackedFiles()`, `grep()`'s `GrepHit.file` — is root-relative;
	 * repo-root-relative would be the odd one out, not `diff`'s corrected behaviour.
	 */
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
}

/**
 * One regex match found by `ctx.grep`. `line`/`col` are 1-based, matching this repo's `Loc`
 * convention (diagnostic.ts's own doc: "Zero is not a valid value for either"). Each object is
 * individually frozen (not just the containing array `grep()` returns) — the same "freeze
 * anything handed out of a module" habit `ChangedFile` already follows (CLAUDE.md).
 *
 * `text` is the matched substring (`match[0]`), deliberately NOT the whole line the way
 * `grep(1)` conventionally prints it: `file`/`line`/`col` already locate the hit precisely, so
 * the one thing a caller cannot recover without re-reading the file itself is what actually
 * matched — e.g. `refs/no-dangling-paths` needs exactly the dangling path, not the
 * sentence it sits in.
 *
 * `text` is UNBOUNDED: a broad pattern (e.g. `/.+/`) matched against one line of a large,
 * unwrapped (e.g. minified) tracked file hands the caller a multi-megabyte string. A rule that
 * embeds `hit.text` verbatim in a diagnostic message — exactly the use this field exists for —
 * should keep that in mind before doing so unconditionally.
 */
export interface GrepHit {
	file: string;
	line: number;
	col: number;
	text: string;
}

export interface GitCapability {
	readonly trackedFiles: () => Promise<readonly string[]>;
	/**
	 * `trackedFiles()`, indexed for the question a rule that resolves a PATH actually asks: "is
	 * git tracking something here". Memoized per run through the same `lazy` as `trackedFiles`
	 * itself, so a whole run costs one `git ls-files` AND one index build — `links/resolve` is a
	 * `file` rule, invoked once per discovered document, and rebuilding the two sets per document
	 * would be O(documents × tracked files) for an answer that cannot change mid-run.
	 *
	 * Derived rather than separate: it holds nothing `trackedFiles()` does not already say, and
	 * `createTrackedFileIndex` (links.ts) is the single implementation both `links/resolve` and
	 * `index/complete`/`index/no-missing-targets` look targets up in. Exposed on the capability instead of
	 * memoized module-side in links.ts so that its lifetime is exactly this run's — a rule object
	 * is a module-level singleton shared by every run in the process, and a cache hanging off one
	 * would answer the second run with the first run's git index.
	 */
	readonly trackedFileIndex: () => Promise<TrackedFileIndex>;
	/**
	 * Each tracked path's INDEX mode, as the octal string git prints: `"100644"`/`"100755"` for
	 * a regular file, `"120000"` for a symbolic link, `"160000"` for a gitlink (a submodule
	 * entry) — what git COMMITTED, not what is on disk now, which is why "is this path committed
	 * as a symlink" cannot be answered from `trackedFiles()` or from an `lstat` alone. Keys are
	 * `pathKey(path)` (paths.ts): git on macOS lists NFC while discovery yields whatever
	 * `readdir` returns, so a caller looks up `modes.get(pathKey(path))`, never the raw spelling.
	 *
	 * One `git ls-files -s -z` per run, memoized through the same `lazy` as `trackedFiles`. A
	 * path listed at several stages (a conflicted index) gets ONE entry: the lowest stage
	 * present, so a conflicted path keeps its lowest-stage mode (git may instead move another
	 * file type to a `path~side` name, which is then its own path). Two tracked names that
	 * differ only in Unicode normalization form share a key; the one git lists first at the
	 * lowest stage wins. The map refuses `set`/`delete`/`clear` and the `getOrInsert*` methods
	 * (a frozen `Map` does not), and `trackedFiles()` is unchanged.
	 *
	 * Vendor contract (https://git-scm.com/docs/git-ls-files, fetched 2026-09-30): `--stage`
	 * "Show staged contents' mode bits, object name and stage number in the output", as
	 * "[<tag> ]<mode> <object> <stage> <file>"; `-z` means "do not quote filenames"; for an
	 * unmerged path "the index records up to three such pairs; one from tree O in stage 1, A in
	 * stage 2, and B in stage 3". Mode values (https://git-scm.com/docs/index-format, fetched
	 * 2026-09-30): object type bits "1000 (regular file), 1010 (symbolic link) and 1110
	 * (gitlink)", with "Symbolic links and gitlinks have value 0" in the permission field.
	 */
	readonly trackedModes: () => Promise<ReadonlyMap<string, string>>;
	readonly diff: (base: string) => Promise<readonly ChangedFile[]>;
}

export interface Capabilities {
	/**
	 * Absolute AND canonical — this run's `ResolvedConfig.root`, which `loadConfig`
	 * `realpath`s (not merely resolves) before ever handing it out, precisely so this field, no
	 * longer "the CLI positional arg, resolved", is already symlink-free by the time it reaches
	 * here. Every rule that derives an absolute path from it (`resolve(ctx.root, ...)`) and then
	 * compares that against a `Document.absPath` (itself built from this same canonical root,
	 * `document.ts`'s `readDocument`) is relying on both sides already sharing one path space —
	 * see `ResolvedConfig.root`'s own doc comment for the regression this fixed.
	 */
	readonly root: string;
	readonly documents: () => Promise<readonly Document[]>;
	readonly git: GitCapability;
	readonly grep: (pattern: RegExp) => Promise<readonly GrepHit[]>;
	/**
	 * Whether `path` — root-relative and posix, the space `trackedFiles()`, `GrepHit.file` and
	 * `Document.path` share except for Unicode normalization form (git precomposes to NFC on
	 * macOS; discovery yields raw `readdir` bytes) — matches this run's top-level `ignore` list
	 * (`ResolvedConfig.ignore`: the user's patterns merged with `DEFAULT_IGNORE`), matched
	 * relative to the REPO root exactly as the scan corpus matches them.
	 *
	 * One matcher per run, built by `buildIgnoreMatcher` in `createCapabilities` and shared with
	 * `buildCorpus`, so "ignored" is one predicate in this process rather than two that could
	 * drift. The one reading that stays different is discovery's, and it is unavoidable rather
	 * than an oversight — see `CorpusScope.ignore`.
	 *
	 * `false` for every path when `createCapabilities` was given no `scope` (its test-only
	 * callers): no scope means no `ignore` list to honour, which is the same "widest possible
	 * corpus" answer `grep` already gives such a caller.
	 *
	 * Deliberately NOT applied to `trackedFiles()`/`trackedFileIndex()`: those answer "is git
	 * tracking something here", which link resolution depends on, and a link to an
	 * ignored-but-tracked file must still resolve. A rule that wants the list applied asks here,
	 * per path, about the paths it is about to judge — `refs/no-unreachable-files` filters the
	 * files it OWNS this way and leaves its reachability walk unfiltered.
	 */
	readonly isIgnored: (path: string) => boolean;
}

export interface RuleContext<O = unknown> extends Capabilities {
	/** per-rule options, already validated against meta.optionsSchema */
	readonly options: O;
	/**
	 * The surface this invocation is scoped to — identity-equal (`===`) to one of
	 * `config.surfaces`, never a lookalike copy (see engine.ts's `EnabledBySurface`, which keys
	 * off the very same reference). Purely additive: a `file` rule already knows its surface via
	 * `doc.surface` and can ignore this field. It exists for `project`/`scan` rules, which get no
	 * `doc` argument at all (engine.ts) and otherwise have no way to scope
	 * `ctx.documents()` down to "my surface's documents" — the idiom is
	 * `doc.surface === ctx.surface`, the same identity-keying `resolveEnabledBySurface` already
	 * relies on.
	 */
	readonly surface: ResolvedSurface;
}

/**
 * `RuleContext`'s counterpart for `"shape"` rules: this kind is dispatched exactly
 * once per RUN, never once per surface, so there is no single `surface` to hand out —
 * `surfaces` (identity-equal to `ResolvedConfig.surfaces`, already frozen there) is what a rule
 * that cares about surface boundaries (`hub/symlinks`, say) iterates itself.
 */
export interface RepoRuleContext<O = unknown> extends Capabilities {
	/** per-rule options, already validated against meta.optionsSchema */
	readonly options: O;
	/** identity-equal to `ResolvedConfig.surfaces`, in config order */
	readonly surfaces: readonly ResolvedSurface[];
}

/**
 * Splits `-z` output into its NUL-delimited fields, dropping exactly the one trailing empty
 * field every git command this module runs produces: `ls-files -z` and `diff --name-status -z`
 * were each checked empirically (see git.ts's callers below) and both terminate their LAST
 * record with a NUL too, not just the ones between records. Returns
 * `[]` for empty input rather than `[""]` — "no output" means "no records", not "one empty
 * record".
 */
function splitNulTerminated(raw: string): string[] {
	if (raw.length === 0) {
		return [];
	}
	const fields = raw.split("\0");
	if (fields[fields.length - 1] === "") {
		fields.pop();
	}
	return fields;
}

/**
 * Argument injection, a distinct threat from shell injection (see git.ts's `runGit` doc):
 * `diff` splices `base` straight into a revision-range string (`` `${base}...HEAD` ``), so a
 * `base` of e.g. `--upload-pack=/bin/sh` or `--output=/etc/passwd` produces a string starting
 * with `-`, which git's own argument
 * parser reads as an *option*, not as a revision — no shell is involved at all, and an
 * argument array (`execFile`) does nothing to stop it, since the injected text never leaves
 * argv. Rejected before it ever reaches `runGit`, loudly: a `--diff-base` value shaped like an
 * option is refused outright rather than passed through and hoping git's own parsing happens
 * to fail safely.
 *
 * An empty (or whitespace-only) `base` is rejected too, for an unrelated reason — it is
 * not an injection, it is a silent no-op landmine. `` `${base}...HEAD` `` with `base = ""` is
 * the literal string `"...HEAD"`, which git reads as `HEAD...HEAD` (both range endpoints
 * default to `HEAD` when omitted) — confirmed empirically (2026-09-04, real repo, real commits
 * either side of a would-be base): `git diff --name-status -z "...HEAD" --` exits 0 with empty
 * output, exactly as if there were nothing to report, rather than failing loudly.
 *
 * Both guards are now load-bearing rather than anticipatory: `--diff-base <ref>` is this
 * function's first real caller, and it hands over whatever the user typed. Measured 2026-09-06
 * against the pinned citty 0.2.2 — `--diff-base -x` arrives here as the string `"-x"` (citty does
 * not eat it as a short flag of its own), and both `--diff-base ""` and a bare trailing
 * `--diff-base` arrive as `""` — so each message below is reachable from the command line and is
 * pinned by a test (`cli.test.ts`, `run.test.ts`).
 */
function assertSafeRevision(base: string): void {
	if (base.trim() === "") {
		throw new Error(
			'git base revision must not be empty — an empty string is silently read as "HEAD...HEAD" (no changes), not as an error',
		);
	}
	if (base.startsWith("-")) {
		throw new Error(
			`git base revision "${base}" must not start with "-" — it would be parsed by git as an option, not a revision`,
		);
	}
}

/**
 * The non-`R`/`C` statuses `git diff --name-status` reports, each exactly one bare letter
 * (only `R`/`C` carry a numeric similarity-score suffix — see `parseNameStatusZ`).
 */
function mapPlainStatus(status: string): ChangedFile["status"] {
	switch (status) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "T":
			// Typechange (e.g. a regular file replaced by a symlink at the same path) — there
			// is no distinct `ChangedFile` status for this, and "the file's content changed"
			// is the closest true statement, so it collapses into `modified`.
			return "modified";
		default:
			// U (unmerged), X (unknown to git itself), B (pairing broken) — or a letter a
			// future git version invents. Mapping any of these to a plausible-looking status
			// would be a silent, confident lie about what happened; naming the raw letter and
			// refusing to guess is the honest failure. Deliberate, not an unhandled case: every
			// status this module's own git invocations can actually produce is enumerated above.
			throw new Error(
				`unrecognized "git diff --name-status" status "${status}" — refusing to guess a mapping`,
			);
	}
}

/**
 * Parses `git diff --name-status -z <range> --` output into `ChangedFile`s.
 *
 * A field-consuming loop, not a naive pairwise `[status, path, status, path, …]` chunking: a
 * rename/copy entry is `R<score>\0oldpath\0newpath\0` — THREE fields, not two (verified
 * empirically against a real temp repo) — and reading it as a pair would desynchronize every
 * entry after it in the stream, misreading `newpath` as the next entry's status. The status
 * letter alone decides the stride: only `R`/`C` carry a numeric similarity-score suffix, and
 * every other status is exactly one bare letter.
 *
 * Exported (not just used by `diff()` below) because two of the statuses it must handle can
 * never actually come out of *this module's own* git invocation: `C` needs an explicit `-C`
 * flag this module does not pass (copy detection is off by default), and `U`/`X`/`B` need a
 * real merge conflict or a genuinely broken git object — neither practical to reproduce in a
 * throwaway temp repo. Those branches are still real and still tested, just against this pure
 * function directly with hand-built input rather than against git's actual output (see
 * context.test.ts).
 */
export function parseNameStatusZ(raw: string): ChangedFile[] {
	const fields = splitNulTerminated(raw);
	const files: ChangedFile[] = [];
	let i = 0;
	while (i < fields.length) {
		const status = fields[i];
		if (status === undefined) {
			// Unreachable given the `while` guard above — noUncheckedIndexedAccess cannot see
			// that `i < fields.length` already proves this index exists, so this satisfies the
			// type without a cast.
			break;
		}
		const letter = status.charAt(0);
		if (letter === "R" || letter === "C") {
			const oldPath = fields[i + 1];
			const newPath = fields[i + 2];
			if (oldPath === undefined || newPath === undefined) {
				throw new Error(
					`malformed "git diff --name-status -z" output: status "${status}" at field ${i} is missing its old/new path`,
				);
			}
			files.push({
				path: newPath,
				status: letter === "R" ? "renamed" : "added",
			});
			i += 3;
			continue;
		}
		const path = fields[i + 1];
		if (path === undefined) {
			throw new Error(
				`malformed "git diff --name-status -z" output: status "${status}" at field ${i} is missing its path`,
			);
		}
		files.push({ path, status: mapPlainStatus(status) });
		i += 2;
	}
	return files;
}

/**
 * Parses `git ls-files -s -z` output into a `pathKey(file)` -> mode map, one entry per path.
 *
 * MEASURED (git 2.54.0, 2026-09-30): each record is `<mode> SP <object> SP <stage> TAB <file>
 * NUL`, and a name containing spaces or TABs comes through verbatim after the FIRST TAB — so the
 * record is split there and nowhere else. A path at several stages keeps its lowest stage's mode.
 *
 * Exported for the same reason as `parseNameStatusZ`: a real conflicted index is reproducible in
 * a temp repo, but pinning the stage rule and the key normalization against hand-built records
 * keeps them independent of the platform's own Unicode handling. Throws on a record that does not
 * match the documented shape rather than skipping it: a silently dropped entry would read as
 * "not tracked" to the caller.
 */
export function parseTrackedModes(raw: string): Map<string, string> {
	const modes = new Map<string, string>();
	const stages = new Map<string, number>();
	for (const record of splitNulTerminated(raw)) {
		const tab = record.indexOf("\t");
		const match =
			tab === -1 ? null : LS_FILES_STAGE_META.exec(record.slice(0, tab));
		const mode = match?.[1];
		const stageText = match?.[2];
		if (mode === undefined || stageText === undefined) {
			throw new Error(
				`malformed "git ls-files -s -z" output: record ${JSON.stringify(record)} is not "<mode> <object> <stage><TAB><file>"`,
			);
		}
		const key = pathKey(record.slice(tab + 1));
		const stage = Number(stageText);
		const seen = stages.get(key);
		if (seen === undefined || stage < seen) {
			stages.set(key, stage);
			modes.set(key, mode);
		}
	}
	return modes;
}

const LS_FILES_STAGE_META = /^([0-7]{6}) [0-9a-f]+ ([0-3])$/;

/**
 * `Object.freeze` on a `Map` leaves `set`/`delete`/`clear` working; shadowing them does not. The
 * `getOrInsert*` mutators (Bun 1.3.14, Node 26) are shadowed too. Known limit: `Map.prototype
 * .set.call(map, …)` still bypasses the seal.
 */
function sealModes(map: Map<string, string>): ReadonlyMap<string, string> {
	const refuse = (): never => {
		throw new TypeError("the tracked-modes map is read-only");
	};
	return Object.freeze(
		Object.assign(map, {
			set: refuse,
			delete: refuse,
			clear: refuse,
			getOrInsert: refuse,
			getOrInsertComputed: refuse,
		}),
	);
}

async function computeDiff(
	root: string,
	base: string,
): Promise<readonly ChangedFile[]> {
	assertSafeRevision(base);
	// `--relative`: the decision documented on `ChangedFile.path` — makes this call
	// root-relative and root-scoped instead of repo-root-relative, matching `trackedFiles()`.
	// A command-line flag, not a `-c diff.relative=...` override, but with the same effect:
	// an explicit CLI flag always beats a config FILE value (this repo's own
	// `-c` always beats config precedent, see git.ts), so an operator's own `diff.relative`
	// setting — true OR false — can no longer change this call's output at all. Confirmed
	// empirically (2026-09-04, real repo, root = a subdirectory): with a global
	// `diff.relative=false` in effect, passing `--relative` here still produces the scoped,
	// root-relative listing; with global `diff.relative=true` in effect, the result is
	// unchanged either way. Verified too against the case this comment warns about in
	// `ChangedFile.path` — a rename crossing `root`'s own boundary (in either direction) comes
	// out as a plain add/delete (`A`/`D`, two fields), never a three-field `R<score>` entry
	// mixing an in-scope and an out-of-scope path, so `parseNameStatusZ`'s existing R/C-vs-plain
	// stride logic needed no change for this.
	const buf = await runGit(root, [
		"diff",
		"--name-status",
		"--relative",
		"-z",
		`${base}...HEAD`,
		"--",
	]);
	const files = parseNameStatusZ(buf.toString("utf8"));
	return Object.freeze(files.map((file) => Object.freeze(file)));
}

interface CorpusEntry {
	readonly file: string;
	readonly lines: readonly string[];
}

function isSkippableReadError(err: unknown): boolean {
	if (!(err instanceof Error) || !("code" in err)) {
		return false;
	}
	// Cast justified by the `"code" in err` check just above — `NodeJS.ErrnoException` is the
	// standard shape node:fs rejections carry.
	const code = (err as NodeJS.ErrnoException).code;
	// ENOENT: a path git still tracks but that is missing from the worktree (removed without
	// `git rm`, or an incomplete/sparse checkout) — nothing to scan, not a crash. Checked at
	// every one of `readCorpusEntry`'s three fs calls per path (`realpath`, `stat`, `readFile`):
	// each can independently race a path disappearing between this and the previous check
	// (see `readCorpusEntry`'s own TOCTOU comment).
	//
	// EISDIR used to be caught here too — a submodule gitlink entry, which `ls-files` lists as
	// a tracked "file" but which is actually a directory on disk, made `readFile` fail with it.
	// That case is now caught EARLIER and more broadly by `readCorpusEntry`'s own `stats.isFile()`
	// gate (the same gate that stops a symlink-to-FIFO/character-device from hanging or
	// reading unboundedly), which runs before `readFile` is ever called — `readFile` can no
	// longer observe a directory at all, so `EISDIR` can no longer come out of it. Two
	// mechanisms answering the same "is this actually a regular file" question would only
	// drift; this function no longer needs to know about it.
	//
	// Any OTHER read error (e.g. EACCES) is NOT caught here and propagates out of `grep()` —
	// wrapped with the repo-relative path first (`readCorpusEntry`) — since a permissions
	// problem on a supposedly tracked file is worth failing loudly over, not swallowing.
	return code === "ENOENT";
}

/**
 * Lexical containment on two already-real (symlink-free) absolute paths: true when `target`
 * sits inside (or equal to) `root`. This is the `relative`-based three-way test (`".."`, a
 * `".." + sep` prefix, or an absolute `relative()` result — which happens on Windows when the
 * two sides are on different drives) that `paths.ts` now exports as `isWithinRoot`, and that
 * `links.ts`'s `resolveTarget`, `discover.ts`'s `validateSurfaces` and `detect.ts`'s candidate
 * walk each still inline verbatim.
 *
 * Kept as a private copy deliberately, not because the duplication went unnoticed: the fix that
 * introduced it here was scoped to this file, and collapsing every copy onto the shared helper
 * reaches across several modules — a consolidation commit of its
 * own, with its own review, rather than a side effect of an unrelated fix.
 */
function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * What `buildCorpus` needs from the run's `ResolvedConfig` to decide which tracked files are
 * scan targets. A narrow shape rather than the whole `ResolvedConfig`: the
 * capability layer answers questions about the repository, and coupling it to the config object
 * would give every capability reach into settings none of them has any business reading.
 *
 * Every field is REQUIRED — it is the whole `scope` argument that is optional
 * (`createCapabilities`), so a caller either states all of these facts or states none, and no
 * call site can silently supply half a scope.
 */
export interface CorpusScope {
	/**
	 * `ResolvedConfig.configFile` — absolute, and under this run's canonical `root`. Never
	 * a scan target.
	 *
	 * Without this, a `refs/no-dangling-paths` allowlist entry always matches its own
	 * literal in the very config file that declares it, so the allowlist staleness guard ("an entry
	 * that no longer applies … is itself an error") is not merely noisy but structurally UNREACHABLE —
	 * an entry could never stop matching. The same holds for any future rule that scans for strings
	 * a user configures.
	 */
	readonly configFile: string;
	/**
	 * `<root>/skillslurp-baseline.json` (`baselineFilePath`, baseline.ts) — absolute, under this
	 * run's canonical `root`. The second file of this run's own that is never a scan target, and
	 * excluded whether or not it exists, exactly as `configFile` is.
	 *
	 * The same argument as `configFile`'s, one field up: a baseline entry's key is the literal
	 * message of the diagnostic it suppresses, so the file is full of the very path literals
	 * `refs/no-dangling-paths` scans for. Left in the corpus, a baseline that suppresses "path X
	 * does not exist" would immediately re-report X from inside itself — a suppression file that
	 * manufactures the diagnostics it exists to suppress.
	 */
	readonly baselineFile: string;
	/**
	 * `ResolvedConfig.ignore` — the user's top-level `ignore:` merged with `DEFAULT_IGNORE`.
	 *
	 * Using it for the scan WIDENS what `ignore` means, so it is stated plainly here rather than
	 * left to be inferred: `ignore` used to be discovery-only (`discoverFiles` passes it to the
	 * globber, discover.ts) and `ctx.grep` scanned every tracked file regardless. It is now also
	 * a scan exclusion — someone who ignores `vendor/**` does not want dangling-path
	 * diagnostics out of `vendor/` either.
	 *
	 * One difference from discovery is unavoidable and deliberate: discovery matches these
	 * patterns relative to each SURFACE root (`glob({ cwd: rootReal, ignore: [...] })`), because
	 * a surface root is the only root it has. The corpus is repo-wide and has no surface, so it
	 * matches them relative to the REPO root — `vendor/**` here means `<repo>/vendor/**`, where
	 * on a surface it means `<surface-root>/vendor/**`.
	 *
	 * This list has a second consumer beyond the corpus, on the same reasoning and
	 * against the same repo-root-relative reading: `refs/no-unreachable-files` no longer treats
	 * an ignored path as a file an item OWNS, so someone who ignores `vendor/**` stops getting
	 * orphan diagnostics out of `vendor/` too. `file/defers-to` and `hub/symlinks` ask it as well.
	 * All four consumers go through `Capabilities.isIgnored` and therefore through one matcher —
	 * a third reading of one word is exactly what the asymmetry above buys the right to refuse.
	 */
	readonly ignore: readonly string[];
}

/**
 * Prepares one `ignore` pattern the way tinyglobby does before handing it to picomatch, so a
 * pattern excludes the same paths from the scan corpus as it does from discovery: a trailing
 * `/` is stripped, then the pattern is `posix.normalize`d.
 *
 * Read out of tinyglobby 0.2.17's own bundled `dist/index.mjs` (`normalizePattern`,
 * `processPatterns`, `buildCrawler`) on 2026-09-05, since none of this is in its documentation.
 * Two further steps that function performs are deliberately NOT replicated, each for a stated
 * reason: appending `/**` to a pattern not ending in `*` is gated on `expandDirectories`, which
 * `discoverFiles` sets to `false`; and rewriting an absolute or `../`-prefixed pattern relative
 * to the glob `cwd` is a surface-root-relative computation with no meaning for a repo-wide
 * corpus (see `CorpusScope.ignore` on that difference). A `!`-negated pattern is likewise not
 * special-cased: tinyglobby honours negation in `patterns`, never in `ignore`.
 */
function normalizeIgnorePattern(pattern: string): string {
	return posix.normalize(
		pattern.endsWith("/") ? pattern.slice(0, -1) : pattern,
	);
}

/**
 * Builds the "is this path excluded by the top-level `ignore` list" predicate, or `undefined` when
 * nothing is excluded (no scope, or an empty `ignore` list) so the corpus loop can skip the call
 * entirely.
 *
 * Called exactly once per run, by `createCapabilities`, which hands the result to `buildCorpus`
 * AND exposes it as `Capabilities.isIgnored` — the corpus and every rule that asks therefore
 * share one matcher over one list, which is the whole point of routing the second consumer
 * (`refs/no-unreachable-files`) through here rather than letting it build its own.
 *
 * `picomatch` directly, with the two options tinyglobby ends up passing for discovery's own
 * `ignore` list (`dot: true`, matching the `dot: true` `discoverFiles` globs with; `posix:
 * true`, which tinyglobby sets unconditionally) — the same matcher discovery already matches
 * globs with, so a glob means one thing in this project rather than two. The project also rules
 * out platform glob APIs (`path.matchesGlob`): the source stays runtime-agnostic between Bun and
 * Node ≥ 22, so glob matching always goes through `tinyglobby`/`picomatch` — the second reason
 * not to reach for one here.
 */
function buildIgnoreMatcher(
	scope: CorpusScope | undefined,
): ((path: string) => boolean) | undefined {
	if (scope === undefined) {
		return undefined;
	}
	// Empty patterns dropped before normalization, matching `processPatterns`'s own
	// `if (!pattern) continue` — `posix.normalize("")` is `"."`, so an empty string would
	// otherwise become a pattern aimed at the repo root.
	const patterns = scope.ignore
		.filter((pattern) => pattern.length > 0)
		.map(normalizeIgnorePattern);
	if (patterns.length === 0) {
		return undefined;
	}
	return picomatch(patterns, { dot: true, posix: true });
}

/**
 * How many tracked files `buildCorpus` reads concurrently. A full run used to loop over
 * every tracked path sequentially — `realpath`, then `stat`, then `readFile`, one path fully
 * awaited before the next even starts — and a CPU profile over a ~60k-tracked-file repo showed
 * why that was slow: 10.4–11.9s wall time with the main thread ~64% idle, i.e. mostly waiting on
 * I/O it had no other work scheduled to overlap with.
 *
 * Chosen by measurement (2026-09-29), not guessed: three full runs each of limits 16/32/64 over
 * a real checkout with ~60k tracked files took a mean 3.80s/3.59s/3.58s, so 32 is the smallest
 * limit within ~5% of the fastest. A higher one buys noise at the cost of more open file
 * descriptors, and an unbounded `Promise.all` over the whole corpus could hit `EMFILE`, which is
 * not skippable, on a machine with a low `ulimit -n`; the bound itself costs up to this many fds
 * on top of the process's own. After a fatal read error the remaining reads still finish before
 * the error is reported (`mapBounded` waits for every call).
 */
const CORPUS_READ_CONCURRENCY = 32;

/**
 * Reads one already-scope-filtered tracked path into a `CorpusEntry`, or `undefined` when the
 * path is not a scan target — the per-path body `buildCorpus` now runs through `mapBounded`
 * instead of a sequential loop, at most `CORPUS_READ_CONCURRENCY` calls at once.
 *
 * Four checks run before any byte of file content is trusted, in this order:
 *
 * 1. `realpath` — resolves every symlink in the path. A dangling symlink (or a path removed
 *    from the worktree without `git rm`) fails here with ENOENT, skipped the same as any other
 *    missing tracked path.
 * 2. Containment (security): `isWithinRoot` against this run's own realpath'd `root`. A
 *    tracked path is always REPO-relative and therefore lexically inside `root` by
 *    construction — but a SYMLINK at that path can point anywhere on disk, and `realpath`
 *    follows it there. Skipped silently, not reported: a path that leaves the repository is
 *    not this run's business, the same posture `classifyLinks` (`rules/index/shared.ts`) takes
 *    for a link target that resolves outside the bounds it was given. Checked BEFORE the
 *    file-type stat below, so a foreign path is never even statted, let alone opened.
 * 3. `stat` (follows symlinks) — only `isFile()` targets are read. A symlink to a FIFO or a
 *    character device (e.g. `/dev/zero`) would otherwise hang `readFile` forever (a blocking
 *    open with no writer) or stream unboundedly into memory; this also subsumes the
 *    directory case a submodule gitlink entry used to hit as `readFile`'s own `EISDIR`
 *    (`isSkippableReadError`'s doc has the full account).
 * 4. `readFile`, then a fatal UTF-8 decode — a file that fails to decode is skipped, not
 *    crashed on: binary files are expected in a real repo and are not scan targets. The
 *    converse is deliberately NOT handled specially: a binary file whose bytes *happen* to
 *    decode cleanly as UTF-8 is still read and scanned like any text file — there is no
 *    reliable, dependency-free way to tell "this decoded cleanly because it is text" from "this
 *    decoded cleanly by coincidence" from the bytes alone.
 *
 * A narrow TOCTOU window exists between step 3 and the `readFile` in step 4: the path could be
 * replaced — e.g. swapped for a FIFO, or repointed outside `root` — in the gap. Accepted, not
 * closed: closing it fully needs opening the file descriptor first (with `O_NONBLOCK`, to
 * avoid the very FIFO-open hang this fix exists to prevent) and `fstat`ing THAT fd before ever
 * reading from it, which is real added complexity for a race that requires an attacker who can
 * rewrite a tracked file while this exact scan is running — i.e. one who already has write
 * access inside the repository this process is trusted to read. Recorded as a known, bounded
 * gap (this project's own "known and bounded, not scheduled" habit), not silently ignored.
 * Running many of these concurrently (`buildCorpus`'s point) does not widen this
 * window for any ONE path — each path's own four steps still run in the same order, one after
 * another, exactly as they did in the old sequential loop; only DIFFERENT paths now race each
 * other, which this window's own reasoning never depended on being false.
 *
 * Any error from the three fs calls that is NOT ENOENT (a missing path) propagates — but
 * wrapped with the tracked path (repo-relative, never the raw absolute path alone) for context
 * first, the same way `runEngine` wraps `readDocument`'s own failures (`engine.ts`:
 * `` `failed to read "${file.path}"` ``) — an EACCES on a supposedly tracked file is worth
 * failing loudly over, not swallowing, but a bare `EACCES: permission denied, open '/abs/path'`
 * with no indication of which TRACKED file that was is a needlessly hard crash to debug. The one
 * exception is step 1 failing on a path that is itself a symlink: whatever it points at is
 * committed content the operator cannot fix, so it is skipped rather than failing the run.
 */
async function readCorpusEntry(
	root: string,
	rootReal: string,
	// Shared across concurrent calls: `decode` is synchronous, so no two calls are ever inside it
	// at once.
	decoder: TextDecoder,
	path: string,
): Promise<CorpusEntry | undefined> {
	const absPath = resolve(root, path);
	let real: string;
	try {
		real = await realpath(absPath);
	} catch (err) {
		if (isSkippableReadError(err)) {
			return undefined;
		}
		// A tracked SYMLINK whose target cannot be resolved (a loop, EACCES on a foreign
		// directory, an over-long name) is committed content, not a fault in this tree.
		const info = await lstat(absPath).catch(() => undefined);
		if (info?.isSymbolicLink()) {
			return undefined;
		}
		throw new Error(`failed to read "${path}"`, { cause: err });
	}
	if (!isWithinRoot(rootReal, real)) {
		return undefined; // a symlink at `path` points outside the repository — not a scan target
	}
	let stats: Stats;
	try {
		stats = await stat(real);
	} catch (err) {
		if (isSkippableReadError(err)) {
			return undefined;
		}
		throw new Error(`failed to read "${path}"`, { cause: err });
	}
	if (!stats.isFile()) {
		return undefined; // a FIFO, character device, directory, socket, … — not a scan target
	}
	let bytes: Buffer;
	try {
		bytes = await readFile(real);
	} catch (err) {
		if (isSkippableReadError(err)) {
			return undefined;
		}
		throw new Error(`failed to read "${path}"`, { cause: err });
	}
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		return undefined; // not valid UTF-8 — treated as binary, not a scan target
	}
	// \n and \r\n only — a lone \r (classic Mac OS 9 and earlier line endings) is not
	// treated as a line break. A pattern that spans a newline can never match here: each
	// line is tested independently against `pattern`, so `ctx.grep` structurally cannot
	// find a match straddling a line boundary — a limitation of line-by-line scanning, not
	// a bug to fix later.
	const lines = text.split(/\r\n|\n/);
	// `split` leaves exactly one trailing "" behind when `text` ends in a line
	// terminator — the same shape `splitNulTerminated` (above) already drops, and for the
	// same reason: it is not a genuine extra (empty) line, it is the artifact of "nothing
	// came after the last terminator". Dropped EXACTLY once, not "every trailing empty
	// string": "aaa\n\n" (a real blank LAST line, itself newline-terminated) must still
	// report two lines (`"aaa"`, `""`), losing only the split artifact that follows the
	// second newline — popping in a loop would also delete that genuine blank line, trading
	// one wrong answer (a phantom line after a single trailing newline) for another (a
	// silently dropped real line before a double trailing newline). Measured (2026-09-04):
	// `"aaa\n".split(/\r\n|\n/)` → `["aaa", ""]` (the phantom this fix removes);
	// `"aaa\n\n".split(/\r\n|\n/)` → `["aaa", "", ""]` (only the LAST "" is the artifact).
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return Object.freeze({ file: path, lines: Object.freeze(lines) });
}

/**
 * Reads every tracked file once, decodes it, and splits it into lines — the corpus every
 * `grep()` call scans. Built once per run (via `lazy`, in `createCapabilities`), because
 * several rules each call `grep()` with their own pattern; re-reading the whole repo per
 * call would make N rules cost N full-repo reads instead of one.
 *
 * Three `scope` exclusions (see `CorpusScope` for why each exists) run first, ahead of even the
 * `realpath` `readCorpusEntry` needs, and ahead of any
 * concurrency too: this loop is plain, synchronous `Array.prototype` filtering over the whole
 * tracked list, scheduling not one fs call, so an excluded path costs no syscall and no worker
 * slot at all. This run's own `skillslurp.json`, its own `skillslurp-baseline.json`, and any
 * path matching the top-level `ignore` list are all skipped silently here — not being a scan
 * target is not the same as being a problem worth reporting.
 *
 * What remains is read through `mapBounded`, at most `CORPUS_READ_CONCURRENCY` tracked
 * files' worth of `readCorpusEntry` in flight at once — see that function's own doc for the four
 * per-path checks and what each one guards against. `mapBounded` hands back one outcome per
 * candidate, in the SAME order `candidates` was built in (its own contract), which is
 * `trackedFiles()` order with the three exclusions above already removed; filtering out the
 * `undefined` (skipped) entries below cannot reorder what remains, so the corpus keeps
 * `trackedFiles()` order exactly as it did when this was one sequential loop — `runGrep`'s own
 * determinism (file, then line, then column) depends on that ordering, not merely on it being
 * SOME stable order.
 */
async function buildCorpus(
	root: string,
	trackedFiles: () => Promise<readonly string[]>,
	scope: CorpusScope | undefined,
	// The run's one matcher, built by `createCapabilities` from this same `scope` and shared
	// with `Capabilities.isIgnored`, rather than rebuilt here — see `buildIgnoreMatcher`.
	isIgnored: ((path: string) => boolean) | undefined,
): Promise<readonly CorpusEntry[]> {
	const paths = await trackedFiles();
	const candidates: string[] = [];
	for (const path of paths) {
		const absPath = resolve(root, path);
		// Lexical, not realpath'd, and that is the stronger test here rather than a shortcut:
		// `configFile` is `join(<canonical root>, "skillslurp.json")` (config.ts) and
		// every `path` is repo-relative inside that same root, so the two already share one path
		// space — while a realpath comparison would MISS the config file whenever it is itself a
		// symlink, since the tracked entry and the link target then have different real paths and
		// the config's own content would go straight back into the corpus.
		if (scope !== undefined && absPath === scope.configFile) {
			continue; // the config file is never a scan target
		}
		if (scope !== undefined && absPath === scope.baselineFile) {
			continue; // neither is the baseline file (see `CorpusScope.baselineFile`)
		}
		if (isIgnored?.(path)) {
			continue; // excluded from discovery, therefore excluded from the scan too
		}
		candidates.push(path);
	}

	// Realpath'd once, up front, matching this same posture already established elsewhere for
	// an identical "does a resolved path stay inside this root" question (`rule-tester.ts`'s
	// own `await realpath(root)` before its `expectedGitDir` comparison, `discover.ts`'s
	// `repoReal`). `root` itself was already validated as an existing, real directory by
	// `loadConfig`/`discoverFiles` before `createCapabilities` was ever called, so a failure
	// here would mean the directory vanished between then and now — not a case worth a bespoke
	// message, so it is left to propagate as-is.
	const rootReal = await realpath(root);
	const decoder = new TextDecoder("utf-8", { fatal: true });

	const outcomes = await mapBounded(
		candidates,
		CORPUS_READ_CONCURRENCY,
		(path) => readCorpusEntry(root, rootReal, decoder, path),
	);

	const entries: CorpusEntry[] = [];
	for (const outcome of outcomes) {
		if (outcome !== undefined) {
			entries.push(outcome);
		}
	}
	return Object.freeze(entries);
}

/**
 * Scans the corpus for `pattern`, line by line, returning every match in file (`trackedFiles`
 * order) then line then column order.
 *
 * Never mutates the caller's `pattern`: reporting every match on a line (not just the first)
 * needs the `g` flag and `lastIndex` advancement, so this clones `pattern`
 * (`new RegExp(pattern.source, …)`) and only ever mutates the CLONE's `lastIndex`. Calling
 * `.exec` on the caller's own global-flagged `RegExp` would leave it mutated after `grep()`
 * returns, so a caller reusing the same global pattern across two calls would get results that
 * depend on wherever the first call's scan happened to stop (see context.test.ts's mutation
 * test for the reproduction).
 *
 * Rejects a STICKY (`y`) pattern outright rather than cloning it in: combined with the
 * `g` flag this function always adds, `y` still anchors every attempt to exactly the current
 * `lastIndex`, so one non-matching position stops the scan dead instead of continuing across
 * the rest of the line — silently contradicting this very function's "every match" contract.
 * Measured (2026-09-04): `/a/y` scanned (with `g` added, the way this function would clone it)
 * over `"bab bab"` returns ZERO hits, where the equivalent non-sticky `/a/` returns two (col 2,
 * col 6) — confirmed via `bun -e` against both patterns directly. Rejecting loudly was chosen
 * over silently dropping `y`: a rule author who wrote `/pattern/gy` almost certainly did not
 * intend "only scan positions reachable by contiguous matches from the last one", and this
 * project's own posture for an ambiguous input is to name the problem and refuse to guess
 * (`mapPlainStatus`, `assertSafeRevision`), not to silently reinterpret it.
 *
 * Guards a zero-length match (e.g. a pattern built from `x*` with the global flag): `exec`
 * does not advance `lastIndex` on its own when a match consumes zero characters, which would
 * otherwise spin forever at the same offset — bumped by hand here, the same technique MDN
 * documents for this exact case. When `pattern.flags` includes `u` or `v` ("unicode-aware"),
 * the bump is by one CODE POINT, not one UTF-16 code unit: a bare `+= 1` splits a
 * surrogate pair, landing the next attempt — and therefore the next hit's `col` — inside half
 * of an astral character. Measured (2026-09-04, `"😀😀 x"`, a zero-length pattern, `u` flag):
 * `String.prototype.matchAll` (the spec-correct baseline) reports match indices `0,2,4,5,6`;
 * this function's OLD unconditional `+= 1` reported `0,1,2,3,4,5,6` — two extra hits, at
 * indices 1 and 3, each inside a surrogate pair; the code-point-aware bump below reproduces
 * `0,2,4,5,6` exactly. Not guarded for a caller who forgot `u`/`v` on an actually-unicode
 * pattern — this function goes by `pattern.flags` alone, the same way JS itself does.
 *
 * Deterministic by construction, not by an explicit sort afterward: the corpus is built by
 * iterating `trackedFiles()` (already sorted — `git ls-files`'s own contract) in order, and
 * within a file, lines are scanned top to bottom while `exec` walks a line strictly left to
 * right — so file, then line, then col all come out non-decreasing for free.
 */
async function runGrep(
	corpus: () => Promise<readonly CorpusEntry[]>,
	pattern: RegExp,
): Promise<readonly GrepHit[]> {
	if (pattern.flags.includes("y")) {
		throw new Error(
			'grep() does not support a sticky ("y") pattern: combined with the "g" flag this ' +
				"function always adds, sticky still anchors every attempt to exactly the current " +
				'position, so it silently finds fewer matches than "every match" (this function\'s ' +
				'own contract) promises — e.g. /a/y over "bab bab" finds nothing, where /a/ finds ' +
				'two. Remove the "y" flag before calling grep().',
		);
	}
	const entries = await corpus();
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const isUnicodeAware = flags.includes("u") || flags.includes("v");
	const scanner = new RegExp(pattern.source, flags);
	const hits: GrepHit[] = [];
	for (const entry of entries) {
		for (let lineIndex = 0; lineIndex < entry.lines.length; lineIndex++) {
			const line = entry.lines[lineIndex];
			if (line === undefined) {
				// Unreachable given the loop bound above — noUncheckedIndexedAccess cannot see
				// that.
				continue;
			}
			scanner.lastIndex = 0;
			let match = scanner.exec(line);
			while (match !== null) {
				hits.push(
					Object.freeze({
						file: entry.file,
						line: lineIndex + 1,
						col: match.index + 1,
						text: match[0],
					}),
				);
				if (match[0].length === 0) {
					if (isUnicodeAware) {
						const codePoint = line.codePointAt(scanner.lastIndex);
						// A code point above U+FFFF is encoded as a UTF-16 surrogate PAIR (two
						// code units) — advancing past it needs +2, not +1, or the next attempt
						// starts mid-pair. `undefined` (lastIndex at or past the end of `line`)
						// falls back to +1, same as the non-unicode-aware branch: there is
						// nothing left to split, and `exec` returning `null` next time ends the
						// loop regardless.
						scanner.lastIndex +=
							codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
					} else {
						scanner.lastIndex += 1;
					}
				}
				match = scanner.exec(line);
			}
		}
	}
	return Object.freeze(hits);
}

/**
 * Builds the capability set one run hands to every rule.
 *
 * `scope` is optional, and omitting it means "the corpus is every tracked file, and nothing is
 * ignored" (`isIgnored` then answers `false` for every path) — the behaviour
 * every caller got before scoping, and the right answer for a hand-built capability set in a test
 * that has no config file and no `ignore` list to speak of (several dozen such call sites exist
 * across `context.test.ts` and the rule tests). `runEngine` always passes a real one, and
 * `engine.test.ts` pins that it does, so the optionality cannot quietly become the production
 * path.
 */
export function createCapabilities(
	root: string,
	loadDocuments: () => Promise<readonly Document[]>,
	scope?: CorpusScope,
): Capabilities {
	const trackedFiles = lazy(async (): Promise<readonly string[]> => {
		const buf = await runGit(root, ["ls-files", "-z"]);
		// Buffer#toString("utf8") is lossy for a path that is not valid UTF-8 (e.g. a filename
		// byte-encoded in some other charset): invalid byte sequences become U+FFFD
		// replacement characters rather than throwing. Accepted rather than guarded against —
		// a repo-relative path already this mangled would be unusable for `resolve()`-based
		// file access downstream regardless, and detecting the mangling precisely would need a
		// dependency this repo doesn't have.
		return Object.freeze(splitNulTerminated(buf.toString("utf8")));
	});

	// One index per run, from the one `ls-files` above — see `GitCapability.trackedFileIndex`.
	// Same `lazy(() => build(...))` shape as `corpus` below, for the same reason: a structure
	// derived from the tracked list that several callers want and none should rebuild.
	const trackedFileIndex = lazy(async () =>
		createTrackedFileIndex(root, await trackedFiles()),
	);

	const trackedModes = lazy(async () => {
		const buf = await runGit(root, ["ls-files", "-s", "-z"]);
		return sealModes(parseTrackedModes(buf.toString("utf8")));
	});

	const diff = keyedLazy((base) => computeDiff(root, base));

	const git: GitCapability = Object.freeze({
		trackedFiles,
		trackedFileIndex,
		trackedModes,
		diff,
	});

	// Built once, here, and used by both consumers below: the corpus, and the `isIgnored`
	// capability every rule that asks goes through. Building it per `buildCorpus` call (where it
	// used to live) would be one matcher; building a second one inside a rule would be two
	// meanings of one `ignore:` list.
	const ignoreMatcher = buildIgnoreMatcher(scope);
	const isIgnored = (path: string): boolean => ignoreMatcher?.(path) ?? false;

	const corpus = lazy(() =>
		buildCorpus(root, trackedFiles, scope, ignoreMatcher),
	);
	const grep = (pattern: RegExp) => runGrep(corpus, pattern);

	// Frozen, matching every other capability this function hands out
	// (`trackedFiles`/`diff` above, `grep` below): `lazy` only memoizes the
	// awaited array, it does not protect it, and `RuleContext.documents()` hands the SAME array
	// instance to every (rule, surface) pair a run dispatches (`lazy`'s whole point). One rule
	// mutating it in place — even just `docs.length = 0` — was visible to every later caller,
	// silently truncating the corpus for the rest of the run; `index/complete` is a live
	// consumer, so this was a real false-negative vector, not a theoretical one.
	const documents = lazy(async () => Object.freeze(await loadDocuments()));

	return Object.freeze({
		root,
		documents,
		git,
		grep,
		isIgnored,
	});
}
