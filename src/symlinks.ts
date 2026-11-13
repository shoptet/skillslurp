import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isWithinRoot, pathKey, repoRelative, toPosixPath } from "./paths.js";

/** The index mode git records for a symbolic link (`ctx.git.trackedModes()`). */
export const SYMLINK_MODE = "120000";

/** Two causes, one state: an unstaged symlink-to-file change looks exactly like `core.symlinks` off. */
export const CHECKED_OUT_AS_FILE =
	"is recorded as a symlink in git's index but is a regular file in the working tree (either the change is not staged, or core.symlinks is off in this checkout)";

export interface SymlinkState {
	readonly disk: "symlink";
	/** The `readlink` text, verbatim: relative or absolute exactly as it was committed. */
	readonly target: string;
	/** The fully resolved path; absent when the target does not resolve, for any reason. */
	readonly real?: string;
	/**
	 * The link leaves the realpath'd LINTED root (the CLI path), not the git repository. From
	 * `real` when it resolves; otherwise judged lexically from the target text, resolved against
	 * the link's own realpath'd directory. A `..` after a symlinked directory inside that text is
	 * judged by the string, not by what the directory points at.
	 */
	readonly escapes: boolean;
}

export interface PlainState {
	readonly disk: "missing" | "file" | "directory" | "other";
}

export type LinkState = SymlinkState | PlainState;

// Only for the PATH's own `lstat`, which walks the operator's tree. ENOENT: nothing there.
// ENOTDIR: a parent component is a file. ELOOP: a parent component is part of a symlink cycle.
// All three mean the path cannot be reached, which is a report, not a failure; anything else
// (EACCES, …) is a real problem and propagates. The link's TARGET is judged by another rule:
// committed content can name anything, so every `realpath` error on it just means "does not
// resolve".
const UNREACHABLE = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function isUnreachable(err: unknown): boolean {
	if (typeof err !== "object" || err === null || !("code" in err)) {
		return false;
	}
	// Cast justified by the `"code" in err` check just above — `NodeJS.ErrnoException` is the
	// standard shape node:fs rejections carry.
	return UNREACHABLE.has(String((err as NodeJS.ErrnoException).code));
}

/**
 * What is on disk at `path` — repo-relative and posix, the space `trackedFiles()` uses — and,
 * for a symlink, where it points and whether that stays inside `root`. Reads the filesystem
 * only; whether git COMMITTED the path as a symlink is `ctx.git.trackedModes()`'s question, and
 * the caller combines the two.
 *
 * Never throws for a missing path, or for a link whose target does not resolve — dangling, a
 * cycle (`a` -> `b` -> `a`, which `realpath` rejects with ELOOP), unreadable (EACCES) or
 * unnameable (ENAMETOOLONG): those are the states a caller is asking about. Any other error
 * from the path's own `lstat` (or from reading the link itself) is wrapped with the
 * repo-relative path, the same posture `readCorpusEntry` (context.ts) takes.
 *
 * Deliberately not race-free between the `lstat` and the `readlink`/`realpath` that follow:
 * what this inspects is committed repository content, and an attacker who can rewrite the
 * working tree mid-run already owns it.
 */
export async function inspectLink(
	root: string,
	path: string,
): Promise<LinkState> {
	const absPath = resolve(root, path);
	let isSymlink: boolean;
	let disk: PlainState["disk"] = "other";
	try {
		const info = await lstat(absPath);
		isSymlink = info.isSymbolicLink();
		if (info.isFile()) {
			disk = "file";
		} else if (info.isDirectory()) {
			disk = "directory";
		}
	} catch (err) {
		if (isUnreachable(err)) {
			return Object.freeze({ disk: "missing" });
		}
		throw new Error(`failed to inspect "${path}"`, { cause: err });
	}
	if (!isSymlink) {
		return Object.freeze({ disk });
	}

	let target: string;
	let rootReal: string;
	try {
		target = await readlink(absPath);
		rootReal = await realpath(root);
	} catch (err) {
		throw new Error(`failed to inspect "${path}"`, { cause: err });
	}
	const real = await realpath(absPath).catch(() => undefined);
	const state: { -readonly [K in keyof SymlinkState]: SymlinkState[K] } = {
		disk: "symlink",
		target,
		escapes: false,
	};
	if (real !== undefined) {
		state.real = real;
		state.escapes = !isWithinRoot(rootReal, real);
		return Object.freeze(state);
	}
	try {
		const parentReal = await realpath(dirname(absPath));
		state.escapes = !isWithinRoot(rootReal, resolve(parentReal, target));
	} catch (err) {
		throw new Error(`failed to inspect "${path}"`, { cause: err });
	}
	return Object.freeze(state);
}

/**
 * Where git's index knows a path: under its REAL parent directory, never under a symlinked
 * ancestor's. `inside` is false when that parent resolves outside `root`, and then no `key`
 * exists: git cannot be asked about a path it does not hold. `key` is `pathKey`-normalized, the
 * form `ctx.git.trackedModes()` is keyed by.
 */
export type PlacedInIndex =
	| { readonly inside: true; readonly parent: string; readonly key: string }
	| { readonly inside: false; readonly parent: string };

/**
 * `path`'s place in git's index (see `PlacedInIndex`), `root`-relative or absolute. Throws like
 * `realpath` when the parent directory is missing or unreachable: callers that cannot rule that
 * out inspect the path first.
 */
export async function placeInIndex(
	root: string,
	path: string,
): Promise<PlacedInIndex> {
	const abs = resolve(root, path);
	const parent = await realpath(dirname(abs));
	if (!isWithinRoot(root, parent)) {
		return Object.freeze({ inside: false, parent });
	}
	return Object.freeze({
		inside: true,
		parent,
		key: pathKey(repoRelative(root, join(parent, basename(abs)))),
	});
}

/**
 * True when the relative link text `target`, read segment by segment from `parent` (the link's
 * realpath'd directory), leaves `root` at any step, even if a later `..` would bring it back: a
 * checkout named `app` does not make `../../app/x` a link that stays inside. An absolute target
 * is not judged here.
 */
export function climbsOutOfRoot(
	root: string,
	parent: string,
	target: string,
): boolean {
	if (isAbsolute(target)) {
		return false;
	}
	let current = parent;
	for (const segment of toPosixPath(target).split("/")) {
		if (segment === "..") {
			current = dirname(current);
		} else if (segment !== ".") {
			current = join(current, segment);
		}
		if (!isWithinRoot(root, current)) {
			return true;
		}
	}
	return false;
}
