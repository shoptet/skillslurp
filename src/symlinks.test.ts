import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectLink, placeInIndex } from "./symlinks.js";

const MKFIFO_AVAILABLE = await (async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-symlinks-mkfifo-probe-"),
	);
	try {
		await promisify(execFileCb)("mkfifo", [join(dir, "probe.fifo")]);
		return true;
	} catch {
		return false;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

/**
 * Whether `chmod 0o000` on a directory this process owns actually denies this process a `stat`
 * of something inside it — false when running as root, which ignores owner permission bits
 * entirely. Same rationale as context.test.ts's `CHMOD_DENIES_OWNER`: the test built on this
 * premise must not pass for the wrong reason, or fail in an environment it was never about.
 */
const CHMOD_DENIES_DIR = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-symlinks-chmod-probe-"));
	try {
		const locked = join(dir, "locked");
		await mkdir(join(locked, "inner"), { recursive: true });
		await chmod(locked, 0o000);
		try {
			await stat(join(locked, "inner"));
			return false;
		} catch {
			return true;
		} finally {
			await chmod(locked, 0o755);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

/**
 * Runs `body` with `<parent>/repo` as the root and `parent` (the realpath of it) as a place for
 * things that must sit OUTSIDE the root. No git involved: `inspectLink` reads the filesystem only.
 */
async function withRoot(
	body: (root: string, parentReal: string) => Promise<void>,
): Promise<void> {
	const parent = await mkdtemp(join(tmpdir(), "skillslurp-symlinks-"));
	try {
		const root = join(parent, "repo");
		await mkdir(root);
		await body(root, await realpath(parent));
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

test("inspectLink: an absent path is reported as missing, not thrown", async () => {
	await withRoot(async (root) => {
		expect(await inspectLink(root, "nope.md")).toEqual({ disk: "missing" });
	});
});

test("inspectLink: a path under a parent that is a regular file (ENOTDIR) is missing", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "file.md"), "x", "utf8");
		expect(await inspectLink(root, "file.md/child")).toEqual({
			disk: "missing",
		});
	});
});

test("inspectLink: a regular file and a directory each report their own kind, with no symlink fields at all", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "file.md"), "x", "utf8");
		await mkdir(join(root, "dir"));

		const file = await inspectLink(root, "file.md");
		const directory = await inspectLink(root, "dir");

		expect(file).toEqual({ disk: "file" });
		expect(directory).toEqual({ disk: "directory" });
		// `{ target: undefined }` would be an own key and read as "set".
		expect(Object.keys(file)).toEqual(["disk"]);
	});
});

test("inspectLink: the plain results (missing, file, directory) are frozen", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "file.md"), "x", "utf8");
		await mkdir(join(root, "dir"));

		for (const path of ["nope.md", "file.md", "dir"]) {
			expect(Object.isFrozen(await inspectLink(root, path))).toBe(true);
		}
	});
});

test.skipIf(!MKFIFO_AVAILABLE)(
	"inspectLink: a FIFO is neither opened nor mistaken for a file — it reports other",
	async () => {
		await withRoot(async (root) => {
			await promisify(execFileCb)("mkfifo", [join(root, "pipe")]);
			expect(await inspectLink(root, "pipe")).toEqual({ disk: "other" });
		});
	},
);

test("inspectLink: a relative symlink reports its target text verbatim, the resolved path, and does not escape", async () => {
	await withRoot(async (root) => {
		await mkdir(join(root, "real"));
		await mkdir(join(root, "docs"));
		await writeFile(join(root, "real", "a.md"), "x", "utf8");
		await symlink("../real/a.md", join(root, "docs", "link.md"));
		const rootReal = await realpath(root);

		const state = await inspectLink(root, "docs/link.md");

		expect(state).toEqual({
			disk: "symlink",
			target: "../real/a.md",
			real: join(rootReal, "real", "a.md"),
			escapes: false,
		});
		expect(Object.isFrozen(state)).toBe(true);
	});
});

test("inspectLink: a link to a link reports only its own readlink text, and the final resolution", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "real.md"), "x", "utf8");
		await symlink("real.md", join(root, "mid"));
		await symlink("mid", join(root, "top"));
		const rootReal = await realpath(root);

		expect(await inspectLink(root, "top")).toEqual({
			disk: "symlink",
			target: "mid",
			real: join(rootReal, "real.md"),
			escapes: false,
		});
	});
});

test("inspectLink: a dangling symlink has no `real` key, does not escape, and does not throw", async () => {
	await withRoot(async (root) => {
		await symlink("nowhere.md", join(root, "dangling"));

		const state = await inspectLink(root, "dangling");

		expect(state).toEqual({
			disk: "symlink",
			target: "nowhere.md",
			escapes: false,
		});
		expect("real" in state).toBe(false);
	});
});

test("inspectLink: a dangling symlink whose target text leaves the root escapes, judged lexically from the link's own directory", async () => {
	await withRoot(async (root) => {
		await mkdir(join(root, "docs"));
		await symlink("../../outside/x", join(root, "docs", "gone"));
		await symlink("../docs/x", join(root, "docs", "inside"));
		await symlink("/skillslurp-no-such-dir/x", join(root, "abs"));

		expect(await inspectLink(root, "docs/gone")).toEqual({
			disk: "symlink",
			target: "../../outside/x",
			escapes: true,
		});
		expect(await inspectLink(root, "docs/inside")).toEqual({
			disk: "symlink",
			target: "../docs/x",
			escapes: false,
		});
		expect(await inspectLink(root, "abs")).toEqual({
			disk: "symlink",
			target: "/skillslurp-no-such-dir/x",
			escapes: true,
		});
	});
});

test("inspectLink: a dangling link with a target component longer than NAME_MAX (ENAMETOOLONG) is reported, not thrown", async () => {
	await withRoot(async (root) => {
		const target = `${"x".repeat(300)}/y`;
		await symlink(target, join(root, "long"));

		const state = await inspectLink(root, "long");

		expect(state).toEqual({ disk: "symlink", target, escapes: false });
		expect("real" in state).toBe(false);
	});
});

test.skipIf(!CHMOD_DENIES_DIR)(
	"inspectLink: a link into a directory the process may not search (EACCES) is reported without `real`, not thrown",
	async () => {
		await withRoot(async (root, parentReal) => {
			const locked = join(parentReal, "locked");
			await mkdir(join(locked, "inner"), { recursive: true });
			await symlink("../locked/inner", join(root, "leak"));
			await chmod(locked, 0o000);
			try {
				const state = await inspectLink(root, "leak");

				expect(state).toEqual({
					disk: "symlink",
					target: "../locked/inner",
					escapes: true,
				});
				expect("real" in state).toBe(false);
			} finally {
				await chmod(locked, 0o755);
			}
		});
	},
);

test("inspectLink: a symlink to a directory inside the root resolves to that directory's realpath and does not escape", async () => {
	await withRoot(async (root) => {
		await mkdir(join(root, ".agents", "skills"), { recursive: true });
		await mkdir(join(root, ".claude"));
		await symlink("../.agents/skills", join(root, ".claude", "skills"));
		const rootReal = await realpath(root);

		expect(await inspectLink(root, ".claude/skills")).toEqual({
			disk: "symlink",
			target: "../.agents/skills",
			real: join(rootReal, ".agents", "skills"),
			escapes: false,
		});
	});
});

test("inspectLink: a symlink whose existing target is outside the repository escapes", async () => {
	await withRoot(async (root, parentReal) => {
		await writeFile(join(parentReal, "outside.txt"), "secret", "utf8");
		await symlink("../outside.txt", join(root, "leak"));

		expect(await inspectLink(root, "leak")).toEqual({
			disk: "symlink",
			target: "../outside.txt",
			real: join(parentReal, "outside.txt"),
			escapes: true,
		});
	});
});

test("inspectLink: an absolute target that points inside the repository keeps its absolute text and does not escape", async () => {
	await withRoot(async (root) => {
		const rootReal = await realpath(root);
		await writeFile(join(root, "real.md"), "x", "utf8");
		await symlink(join(rootReal, "real.md"), join(root, "abs"));

		expect(await inspectLink(root, "abs")).toEqual({
			disk: "symlink",
			target: join(rootReal, "real.md"),
			real: join(rootReal, "real.md"),
			escapes: false,
		});
	});
});

test("inspectLink: a symlink loop (a -> b -> a) is reported without `real`, not thrown as ELOOP", async () => {
	await withRoot(async (root) => {
		await symlink("b", join(root, "a"));
		await symlink("a", join(root, "b"));

		const state = await inspectLink(root, "a");

		expect(state).toEqual({ disk: "symlink", target: "b", escapes: false });
		expect("real" in state).toBe(false);
		// `lstat` of a path THROUGH the loop is ELOOP too, and is just as unreachable.
		expect(await inspectLink(root, "a/child")).toEqual({ disk: "missing" });
	});
});

test("inspectLink: containment is judged against the realpath of the root, so a root reached through a symlink does not make inside links look like escapes", async () => {
	await withRoot(async (root, parentReal) => {
		await writeFile(join(root, "real.md"), "x", "utf8");
		await symlink("real.md", join(root, "link"));
		const viaSymlink = join(parentReal, "root-alias");
		await symlink(root, viaSymlink);

		const state = await inspectLink(viaSymlink, "link");

		expect(state).toEqual({
			disk: "symlink",
			target: "real.md",
			real: join(await realpath(root), "real.md"),
			escapes: false,
		});
	});
});

test("placeInIndex: both answers are frozen, because one is shared by every caller that asks", async () => {
	await withRoot(async (_root, parentReal) => {
		const realRoot = join(parentReal, "repo");
		await mkdir(join(realRoot, "dir"));
		await mkdir(join(parentReal, "elsewhere"));
		await symlink(join(parentReal, "elsewhere"), join(realRoot, "out"));

		const inside = await placeInIndex(realRoot, "dir/file.md");
		const outside = await placeInIndex(realRoot, "out/file.md");

		expect(inside.inside).toBe(true);
		expect(outside.inside).toBe(false);
		expect(Object.isFrozen(inside)).toBe(true);
		expect(Object.isFrozen(outside)).toBe(true);
	});
});
