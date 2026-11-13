import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
	pathKey,
	resolveRealDirectory,
	stripTrailingSlashes,
	toPosixPath,
} from "./paths.js";

// Pins the single canonical implementation's normalizing behavior on inputs where the two
// pre-fix, divergently-named local copies (discover.ts's — normalizing — and run.ts's — a bare
// separator swap) disagreed: "./a/b" (leading "./"), "a//b" (repeated
// separator), and "" (empty string, node:path's normalize maps this to ".").
test('toPosixPath normalizes a leading "./" away', () => {
	expect(toPosixPath("./a/b")).toBe("a/b");
});

test("toPosixPath collapses a repeated separator", () => {
	expect(toPosixPath("a//b")).toBe("a/b");
});

test('toPosixPath maps the empty string to "."', () => {
	expect(toPosixPath("")).toBe(".");
});

test('toPosixPath collapses an internal ".." segment', () => {
	expect(toPosixPath("a/b/../c")).toBe("a/c");
});

test("toPosixPath leaves an already-clean relative path unchanged", () => {
	expect(toPosixPath("a/b/c")).toBe("a/b/c");
});

test("stripTrailingSlashes drops trailing slashes from a relative or absolute path", () => {
	expect(stripTrailingSlashes("a/b/", posix.isAbsolute)).toBe("a/b");
	expect(stripTrailingSlashes("a/b//", posix.isAbsolute)).toBe("a/b");
	expect(stripTrailingSlashes("/etc/skills/", posix.isAbsolute)).toBe(
		"/etc/skills",
	);
	expect(stripTrailingSlashes("C:/a/", win32.isAbsolute)).toBe("C:/a");
});

test("stripTrailingSlashes keeps a root: the drive root C:/ is absolute, C: is not", () => {
	expect(win32.isAbsolute("C:/")).toBe(true);
	expect(win32.isAbsolute("C:")).toBe(false);
	expect(stripTrailingSlashes("C:/", win32.isAbsolute)).toBe("C:/");
	expect(stripTrailingSlashes("/", posix.isAbsolute)).toBe("/");
	expect(stripTrailingSlashes(".", posix.isAbsolute)).toBe(".");
});

test("stripTrailingSlashes strips C:/ on a platform where it is a relative name", () => {
	expect(stripTrailingSlashes("C:/", posix.isAbsolute)).toBe("C:");
});

// ---------------------------------------------------------------------------
// pathKey
// ---------------------------------------------------------------------------

// Literal escapes, not `String.prototype.normalize` calls on a shared literal — same idiom as
// `name-matches-dir.test.ts`'s `PRECOMPOSED_CAFE`/`DECOMPOSED_CAFE`, so neither this file's own
// encoding nor an editor's normalization can quietly change what is being compared.
const PRECOMPOSED_CAFE = "caf\u00e9";
const DECOMPOSED_CAFE = "cafe\u0301";

test("pathKey folds an NFD-decomposed path to its NFC-precomposed spelling", () => {
	expect(pathKey(DECOMPOSED_CAFE)).toBe(PRECOMPOSED_CAFE);
});

test("pathKey leaves an already-NFC path unchanged", () => {
	expect(pathKey(PRECOMPOSED_CAFE)).toBe(PRECOMPOSED_CAFE);
});

// Two paths differing only in Unicode normalization form are ONE key — this
// is `pathKey`'s whole purpose, pinned directly rather than left implicit in the sites that call
// it.
test("two paths differing only by Unicode normalization form produce the identical pathKey", () => {
	expect(DECOMPOSED_CAFE).not.toBe(PRECOMPOSED_CAFE);
	expect(pathKey(DECOMPOSED_CAFE)).toBe(pathKey(PRECOMPOSED_CAFE));
});

// ---------------------------------------------------------------------------
// resolveRealDirectory
// ---------------------------------------------------------------------------

/** Creates a fresh temp dir, runs `body`, and always cleans it up afterwards. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-paths-"));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * `resolveRealDirectory` moved here (from discover.ts, then detect.ts, which each duplicated
 * it) as part of an import-cycle fix, and gained no direct test of its own in the
 * move — every existing assertion on its behaviour was really testing `discoverFiles` or
 * `detectSurfaces` one layer up. These five cases are the function's own contract: a real
 * directory, a symlink to one, a file, a path that does not exist, and a symlink loop — the
 * last three all resolving to `undefined` rather than throwing, which is the whole point of the
 * function (both of its callers rely on "never throws" to treat a bad candidate as absent
 * rather than crashing detection or discovery outright).
 */
test("resolveRealDirectory resolves a real directory to its own real path", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "a-directory");
		await mkdir(target);

		const real = await resolveRealDirectory(target);

		expect(real).toBe(await realpath(target));
	});
});

test("resolveRealDirectory resolves a symlink to a real directory to the target's real path", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "real-target");
		await mkdir(target);
		const link = join(dir, "link");
		await symlink(target, link, "dir");

		const real = await resolveRealDirectory(link);

		expect(real).toBe(await realpath(target));
	});
});

test("resolveRealDirectory resolves a file (not a directory) to undefined", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "a-file.txt");
		await writeFile(file, "x", "utf8");

		expect(await resolveRealDirectory(file)).toBeUndefined();
	});
});

test("resolveRealDirectory resolves a path that does not exist to undefined", async () => {
	await withTempDir(async (dir) => {
		expect(
			await resolveRealDirectory(join(dir, "does-not-exist")),
		).toBeUndefined();
	});
});

test("resolveRealDirectory resolves a circular symlink to undefined, without throwing", async () => {
	await withTempDir(async (dir) => {
		const loop = join(dir, "loop");
		await symlink(loop, loop, "dir");

		expect(await resolveRealDirectory(loop)).toBeUndefined();
	});
});
