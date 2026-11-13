import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";

/**
 * Lexical containment: true when `target` sits inside (or equal to) `root`, comparing PATH
 * STRINGS only — no filesystem access, no symlink resolution of its own. A caller whose real
 * question is "does this escape after symlinks are followed" passes in an already-realpath'd
 * `root`/`target` pair (`loadConfiguredDocument`'s symlink check, `classifyLinks`'s
 * `surfaceAbsRoot` bound after resolving symlinks); this function only ever answers the STRING
 * question, matching `links.ts`'s `resolveTarget` and `discover.ts`'s `validateSurfaces`, which
 * each inline the identical three-way test (`".."`, a `".." + sep` prefix, or no relative path at
 * all — `isAbsolute`, which on Windows is `relative`'s answer when the two sides are on
 * different drives). The empty string — `relative(root, root)` — is INSIDE: a target that IS
 * `root` is not an escape.
 *
 * Lives here rather than in `rules/index/shared.ts` (where it started) because that
 * file's two consumers were split apart: the symlink-containment check moved out to
 * `rules/configured-document.ts` while `classifyLinks` stayed behind, and a shared non-rule
 * module importing a rule's private sibling for one three-line test would be the wrong-direction
 * edge `displayPath` above already refused to create. `paths.ts` imports nothing project-local,
 * so both can depend on it.
 */
export function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Converts an OS-native path to posix separators, for building repo-relative path strings.
 * Normalizes first (collapsing `.`/`..` segments and repeated separators, e.g. `"./a/b"` →
 * `"a/b"`, `"a//b"` → `"a/b"`, `""` → `"."`) — this is the single canonical implementation;
 * do not re-derive a divergent local copy (document.ts once did, verbatim; it now imports this).
 */
export function toPosixPath(p: string): string {
	return normalize(p).split(sep).join("/");
}

/**
 * `abs` relative to `root`, in posix form: the space `trackedFiles()` and `pathKey` keys live in.
 * Lexical only; it neither resolves symlinks nor checks that `abs` is inside `root`.
 */
export function repoRelative(root: string, abs: string): string {
	return toPosixPath(relative(root, abs));
}

/**
 * `posixPath` without its trailing slashes, unless that would turn an absolute path into a
 * relative one: the drive root `C:/` is absolute, `C:` is the working directory of that drive.
 * Absoluteness is judged before stripping, by `isAbsolutePath` (a parameter, so the Windows
 * flavour can be exercised on any platform).
 */
export function stripTrailingSlashes(
	posixPath: string,
	isAbsolutePath: (p: string) => boolean,
): string {
	if (posixPath.length <= 1) {
		return posixPath;
	}
	const stripped = posixPath.replace(/\/+$/, "");
	return isAbsolutePath(posixPath) && !isAbsolutePath(stripped)
		? posixPath
		: stripped;
}

/**
 * A comparison key only — never use this for file I/O. Git's listing and filesystem discovery
 * can spell the same name in different Unicode normalization forms (macOS precomposes to NFC,
 * `readdir` returns whatever the disk has); on Linux the raw bytes also open the file.
 */
export function pathKey(path: string): string {
	return path.normalize("NFC");
}

/**
 * Renders `file` relative to `root` for display, converted to posix separators; left as-is if
 * not absolute.
 *
 * Lives here rather than in run.ts (where it started, and from where run.ts still re-exports it
 * for its own existing importers) because engine.ts needs the identical rendering for the ONE
 * value a `ConfigReport` defaults its `file` to — `ResolvedConfig.configFile`, an absolute path
 * that has to reach `Diagnostic.file` repo-relative and posix, exactly as
 * `configErrorDiagnostics` already renders `ConfigError.file`. engine.ts cannot import it from
 * run.ts: run.ts imports `runEngine`, so that edge would be an import cycle (biome's
 * `noImportCycles` is an error here). Copying the four lines into engine.ts was the alternative,
 * and the lexical repo-escape test already exists in several copies — one more copy of a path
 * helper is the same mistake, one module earlier.
 *
 * `paths.ts` imports nothing project-local, so every layer can depend on it without creating a
 * cycle (see `resolveRealDirectory`'s own note just below).
 */
export function displayPath(root: string, file: string): string {
	if (!isAbsolute(file)) {
		return toPosixPath(file);
	}
	const rel = relative(root, file);
	return toPosixPath(rel === "" ? file : rel);
}

/**
 * Resolves `absPath` to its real, symlink-free absolute path — collapsing a symlinked root to
 * its target, and (on case-insensitive filesystems, e.g. darwin's default APFS) any case
 * variant to the on-disk casing. Returns `undefined` if the path does not exist, or exists but
 * is not a directory; never throws.
 *
 * The one fs-touching helper in this otherwise pure module: it lives here, rather than in
 * discover.ts (where it started) or detect.ts (which duplicated it), because both need the
 * identical realpath-and-check-directory logic and neither can import the other — discover.ts
 * imports config.ts, and config.ts imports detect.ts (for zero-config auto-detection), so
 * discover.ts → detect.ts would close a three-way cycle. `paths.ts` imports nothing project-
 * local, so both can depend on it without creating one.
 */
export async function resolveRealDirectory(
	absPath: string,
): Promise<string | undefined> {
	try {
		const real = await realpath(absPath);
		const info = await stat(real);
		return info.isDirectory() ? real : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The guard every path this tool reads *because a repository named it* has to pass: `lstat` the
 * path and refuse anything that is not a regular file. Returns `undefined` when the path is safe
 * to read — which includes a path that is not there at all, since "absent" is a normal, non-error
 * answer for both callers (no config file means auto-detection, no baseline means no baseline)
 * and each of them already handles the `ENOENT` its own read produces. Otherwise returns the
 * clause explaining the refusal, for the caller to put inside its own error type, under its own
 * name for the file.
 *
 * `skillslurp.json` and `skillslurp-baseline.json` are chosen by the repository under
 * lint, not by the operator: `git clone <untrusted> && skillslurp .` reads whatever those two
 * names point at, with no flag involved, and on a fork-PR CI job the PR author picks them.
 * Measured 2026-09-06 against a plain `node dist/cli.js <repo>` before this guard existed:
 *
 * - a symlink to a readable file echoes its first bytes back (`"skillslurp-baseline.json" is not
 *   valid JSON: Unexpected token 'A', "AKIAIOSFOD"...`) or, when the target parses, its complete
 *   top-level key list (`Unrecognized keys: "type", "project_id", "private_key_id",
 *   "client_email"`) — and for the config file that lands on STDOUT, the machine-readable sink,
 *   not stderr;
 * - a symlink to a FIFO with no writer blocks forever: still running at 15s, killed, for both
 *   paths — an indefinite CI hang produced by repository content alone;
 * - a symlink to `/dev/zero` reaches `Invalid string length` only after 718 MB of resident set
 *   size, which is an OOM kill on a memory-capped runner;
 * - and even with nothing read, the errno is an oracle: absent (exit 0, silence), `EACCES`,
 *   `EISDIR` and "parsed fine" are four distinguishable answers about a file the operator never
 *   named.
 *
 * `isWithinRoot` above already refuses an escaping symlink inside the SCAN corpus for exactly
 * this reason; these two paths are read before that corpus is ever built, and were the gap.
 *
 * Deliberately not race-free: between this `lstat` and the caller's own read the path could be
 * swapped. What this guards is committed repository CONTENT, which does not race: an attacker
 * who can swap the path mid-run already owns the working tree and reads whatever they like
 * regardless of this check. The window could still be closed — `open(O_RDONLY | O_NOFOLLOW |
 * O_NONBLOCK)` returns immediately even on a FIFO, then `fstat` the resulting handle — but that
 * would harden against a threat this guard was never meant to cover.
 */
export async function repoFileRefusal(
	path: string,
	// Only the symlink clause names the direction, and it has to: "would read outside the path
	// you asked to lint" and "would write outside" are different harms — disclosure versus
	// destruction — and the write side's wording is byte-pinned by its own test.
	verb: "read" | "write" = "read",
): Promise<string | undefined> {
	const info = await lstat(path).catch(() => undefined);
	// Absent, or unreachable for a reason the caller's own read will report identically
	// (`ENOTDIR` when a parent is a file, `EACCES` on the parent directory).
	if (info === undefined || info.isFile()) {
		return undefined;
	}
	if (info.isSymbolicLink()) {
		// Both the read and the write side get this wording from this one function; `verb` is
		// the only thing that differs between them.
		return `it is a symbolic link, and following it would ${verb} outside the path you asked to lint`;
	}
	// Named so the message stays useful for the case an operator actually hits by accident;
	// everything else (FIFO, socket, character or block device) is only ever deliberate.
	if (info.isDirectory()) {
		return "it is a directory, not a regular file";
	}
	return "it is not a regular file";
}
