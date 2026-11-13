import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BASELINE_FILENAME } from "./baseline.js";
import {
	type CorpusScope,
	createCapabilities,
	lazy,
	parseNameStatusZ,
	parseTrackedModes,
} from "./context.js";
import type { Document } from "./document.js";
import { NotAGitCheckoutError, runGit } from "./git.js";
import { pathKey } from "./paths.js";
import { formatError } from "./run.js";
import { inspectLink } from "./symlinks.js";

// Determinism (CLAUDE.md's habit): every git subprocess this file spawns
// must behave the same regardless of the developer's own ~/.gitconfig (a global `user.name`,
// a global `init.defaultBranch`, an alias, a signing requirement, …). `/dev/null` is a valid,
// always-empty "config file" on every platform this repo targets (Node >=22).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

async function initRepo(dir: string): Promise<void> {
	await runGit(dir, ["init", "-b", "main"]);
	await runGit(dir, ["config", "user.name", "Test User"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "commit.gpgsign", "false"]);
}

async function commitAll(dir: string, message: string): Promise<void> {
	await runGit(dir, ["add", "-A"]);
	await runGit(dir, ["commit", "-m", message]);
}

async function headRev(dir: string): Promise<string> {
	const buf = await runGit(dir, ["rev-parse", "HEAD"]);
	return buf.toString("utf8").trim();
}

/**
 * Whether `chmod 0o000` on a file this process owns actually denies this process its own
 * read access — false when running as root, which ignores owner permission bits entirely.
 * Computed once, mirrors detect.test.ts's `CHMOD_DENIES_OWNER` probe (same rationale: a test
 * built on this premise must not silently pass for the wrong reason, or fail in an environment
 * it was never about, e.g. CI running as root in a container).
 */
const CHMOD_DENIES_OWNER = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-chmod-probe-"));
	try {
		const probe = join(dir, "probe.txt");
		await writeFile(probe, "x", "utf8");
		await chmod(probe, 0o000);
		try {
			await readFile(probe);
			return false;
		} catch {
			return true;
		} finally {
			await chmod(probe, 0o644);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

/**
 * Whether this machine's `git` has a German (`de`) message catalog installed at all — false on
 * an NLS-less build, where `LANGUAGE=de` has no effect and the locale-independence test below
 * would otherwise pass vacuously (same rationale as `CHMOD_DENIES_OWNER` above). Probed
 * with `execFileCb`/`promisify` directly, not through `runGit`: `git.ts`'s own fix pins
 * `LC_ALL=C`/`LANGUAGE=` for every `runGit` call, which would make this probe always see
 * English regardless of what this machine's git can actually translate — exactly the outcome
 * this probe exists to rule out.
 */
const GIT_TRANSLATES_TO_GERMAN = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-locale-probe-"));
	try {
		const rawExecFile = promisify(execFileCb);
		try {
			await rawExecFile("git", ["-C", dir, "ls-files", "-z"], {
				encoding: "utf8",
				env: { ...process.env, LANGUAGE: "de" },
			});
			// `dir` is freshly created and never `git init`'d — "ls-files" must fail.
			return false;
		} catch (err) {
			const stderr =
				err !== null && typeof err === "object" && "stderr" in err
					? ((err as { stderr?: string }).stderr ?? "")
					: "";
			return stderr.includes("Schwerwiegend");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
})();

/**
 * Whether this machine has a `mkfifo` binary on PATH — false on a platform without one (e.g.
 * Windows), same rationale as the probes above: the FIFO test below needs a REAL named pipe to
 * reproduce the hang it guards against (there is no portable, dependency-free way to create
 * one from Node itself), and the probe's own absence must not be mistaken for the fix passing.
 */
const MKFIFO_AVAILABLE = await (async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-mkfifo-probe-"));
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
 * Races `promise` against a timeout, rejecting with a distinct error if `promise` has not
 * settled within `ms`. Used only by the FIFO-hang test: without this, a regression that makes
 * `ctx.grep` block forever on an unbounded read would hang that one test (and therefore the
 * whole suite) indefinitely rather than failing loudly in a few seconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`timed out after ${ms}ms`)),
				ms,
			);
			// Does not keep the process alive on its own — if `promise` really does hang
			// forever (the bug this guards against), the timer firing is what fails the test;
			// nothing here should ALSO keep the process itself alive past that.
			timer.unref();
		}),
	]);
}

// ---------------------------------------------------------------------------
// lazy()
// ---------------------------------------------------------------------------

test("lazy() invokes its factory exactly once for concurrent callers", async () => {
	let calls = 0;
	const thunk = lazy(async () => {
		calls++;
		return { id: calls };
	});

	const pendingA = thunk();
	const pendingB = thunk();
	const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

	expect(calls).toBe(1);
	expect(resultA).toBe(resultB);
});

test("lazy() memoizes a synchronously-throwing factory and both callers reject", async () => {
	let calls = 0;
	const thunk = lazy<never>(() => {
		calls++;
		throw new Error("boom");
	});

	const pendingA = thunk();
	const pendingB = thunk();

	await expect(pendingA).rejects.toThrow("boom");
	await expect(pendingB).rejects.toThrow("boom");
	expect(calls).toBe(1);
});

test("lazy() memoizes a rejecting async factory across concurrent callers", async () => {
	let calls = 0;
	const thunk = lazy<never>(async () => {
		calls++;
		throw new Error("async boom");
	});

	const pendingA = thunk();
	const pendingB = thunk();

	await expect(pendingA).rejects.toThrow("async boom");
	await expect(pendingB).rejects.toThrow("async boom");
	expect(calls).toBe(1);
});

test("the capability bag and its git sub-object are frozen", () => {
	const caps = createCapabilities("/repo", async () => []);

	expect(Object.isFrozen(caps)).toBe(true);
	expect(Object.isFrozen(caps.git)).toBe(true);
});

test("documents: the returned array is frozen — a mutation attempt throws instead of silently truncating what a later (rule, surface) pair sees", async () => {
	// Only `.length`/element identity matter to this test; the fields a real `Document` carries
	// (ast, frontmatter, surface, …) are never read here, so this narrow cast stands in for two
	// distinct instances rather than building two fully-shaped `Document`s through `parseSource`.
	const docA = { path: "a.md" } as unknown as Document;
	const docB = { path: "b.md" } as unknown as Document;
	const caps = createCapabilities("/repo", async () => [docA, docB]);

	const docs = await caps.documents();

	expect(Object.isFrozen(docs)).toBe(true);
	expect(() => {
		(docs as Document[]).length = 0;
	}).toThrow(TypeError);
	// `lazy` hands out the SAME memoized array instance to every caller (its whole point) — the
	// failed mutation attempt above must not have left it truncated for this second call to see.
	expect(await caps.documents()).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// git.trackedFiles()
// ---------------------------------------------------------------------------

test("git.trackedFiles: lists tracked files as sorted, repo-relative posix paths, including one containing a literal newline (proves NUL-, not newline-, separation)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-tracked-"));
	try {
		await initRepo(dir);
		// A path containing "\n": if this module split on newlines instead of the NUL `-z`
		// actually uses, this single tracked file would desynchronize into two bogus entries
		// and shift everything after it.
		await writeFile(join(dir, "a\nb.txt"), "hi", "utf8");
		await writeFile(join(dir, "normal.txt"), "hi2", "utf8");
		await commitAll(dir, "add files");

		const caps = createCapabilities(dir, async () => []);
		const files = await caps.git.trackedFiles();

		expect(files).toEqual(["a\nb.txt", "normal.txt"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// `trackedFiles()` must stay raw — it feeds file I/O downstream
// (`resolve(root, ...)`), so only a comparison KEY (`pathKey`, paths.ts) may normalize, never
// this function itself. `core.precomposeunicode` is pinned explicitly to `false` rather than
// left at the platform default (true on macOS, false elsewhere): this test is about OUR parse
// step, not git's own precomposition, so it must hold on every platform this repo targets.
test("git.trackedFiles: is not itself Unicode-normalized — an NFD-decomposed tracked name comes back exactly as committed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-nfd-"));
	try {
		await initRepo(dir);
		await runGit(dir, ["config", "core.precomposeunicode", "false"]);
		const decomposedName = "cafe\u0301.md";
		await writeFile(join(dir, decomposedName), "hi", "utf8");
		await commitAll(dir, "add NFD file");

		const caps = createCapabilities(dir, async () => []);
		const files = await caps.git.trackedFiles();

		expect(files).toEqual([decomposedName]);
		// Sanity: proves the fixture is genuinely decomposed, so the equality above could not
		// have passed by accident on a form-insensitive filesystem.
		expect(files[0]).not.toBe(decomposedName.normalize("NFC"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFiles: an empty repository (nothing staged) returns []", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-empty-"));
	try {
		await initRepo(dir);

		const caps = createCapabilities(dir, async () => []);
		expect(await caps.git.trackedFiles()).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFiles: memoized — two calls on the same capabilities share one underlying subprocess run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-memo-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "one.txt"), "x", "utf8");
		await commitAll(dir, "add one");

		const caps = createCapabilities(dir, async () => []);
		const first = await caps.git.trackedFiles();
		const second = await caps.git.trackedFiles();

		// Each real run builds a fresh array; identical *object* identity across two calls is
		// only possible if the underlying git invocation ran once and the result was cached,
		// not recomputed.
		expect(first).toBe(second);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFileIndex: memoized — two calls on the same capabilities hand back one index, built once", async () => {
	// The claim `links/resolve` rests on: one `git ls-files` AND one index build per RUN, not per
	// document. `links/resolve` is a `file` rule, so `check` runs once per discovered document
	// and asks for this every time — and no behavioural assertion can see the difference,
	// because `trackedFiles()` is memoized underneath and a rebuilt index would answer
	// identically. Object identity is what makes "built once" observable at all.
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-index-memo-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "one.txt"), "x", "utf8");
		await commitAll(dir, "add one");

		const caps = createCapabilities(dir, async () => []);
		expect(await caps.git.trackedFileIndex()).toBe(
			await caps.git.trackedFileIndex(),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFileIndex: answers from the tracked list — a tracked file and its directory resolve, an untracked file present on disk does not", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-index-"));
	try {
		await initRepo(dir);
		await mkdir(join(dir, "docs"), { recursive: true });
		await writeFile(join(dir, "docs", "guide.md"), "# Guide\n", "utf8");
		await commitAll(dir, "add the guide");
		// Written after the commit, so it is on disk and absent from the index — the case that
		// separates this capability from a `stat`.
		await writeFile(join(dir, "docs", "draft.md"), "# Draft\n", "utf8");

		const index = await createCapabilities(
			dir,
			async () => [],
		).git.trackedFileIndex();

		expect(index.has(join(dir, "docs", "guide.md"))).toBe(true);
		expect(index.has(join(dir, "docs"))).toBe(true);
		expect(index.has(join(dir, "docs", "draft.md"))).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFiles: the returned array is frozen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-frozen-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "one.txt"), "x", "utf8");
		await commitAll(dir, "add one");

		const caps = createCapabilities(dir, async () => []);
		expect(Object.isFrozen(await caps.git.trackedFiles())).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedFiles: raises execFile's 1 MiB default maxBuffer, proven against a repo whose `ls-files -z` output actually exceeds it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-maxbuf-"));
	try {
		await runGit(dir, ["init", "-b", "main"]);
		// ~191 bytes per NUL-terminated entry * 6500 ≈ 1.24 MiB — comfortably past execFile's
		// hard-coded 1 MiB default, well under this module's own 64 MiB ceiling.
		const COUNT = 6500;
		const nameFor = (i: number) =>
			`f${"a".repeat(180)}${String(i).padStart(6, "0")}.md`;
		await Promise.all(
			Array.from({ length: COUNT }, (_, i) =>
				writeFile(join(dir, nameFor(i)), ""),
			),
		);
		await runGit(dir, ["add", "-A"]);

		// Establish the premise empirically rather than asserting it on faith: execFile's own
		// default really does reject this repo's `ls-files -z` output, which is what makes the
		// assertion below (that our capability succeeds) meaningful rather than vacuous.
		const rawExecFile = promisify(execFileCb);
		await expect(
			rawExecFile("git", ["-C", dir, "ls-files", "-z"], {
				encoding: "buffer",
			}),
		).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });

		const caps = createCapabilities(dir, async () => []);
		const files = await caps.git.trackedFiles();
		expect(files).toHaveLength(COUNT);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// git.trackedModes()
// ---------------------------------------------------------------------------

const MODE_TEST_SHA = "0123456789abcdef0123456789abcdef01234567";

async function inTempRepo(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-modes-"));
	try {
		await initRepo(dir);
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("git.trackedModes: a regular file is 100644 and an executable is 100755", async () => {
	await inTempRepo(async (dir) => {
		await writeFile(join(dir, "plain.md"), "x", "utf8");
		await writeFile(join(dir, "run.sh"), "#!/bin/sh\n", "utf8");
		await chmod(join(dir, "run.sh"), 0o755);
		await commitAll(dir, "add files");

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.get("plain.md")).toBe("100644");
		expect(modes.get("run.sh")).toBe("100755");
	});
});

test("git.trackedModes: a committed symlink is 120000, and inspectLink reads its target, resolution and containment off the disk", async () => {
	await inTempRepo(async (dir) => {
		await mkdir(join(dir, "docs"));
		await mkdir(join(dir, "real"));
		await writeFile(join(dir, "real", "a.md"), "x", "utf8");
		await symlink("../real/a.md", join(dir, "docs", "link.md"));
		await commitAll(dir, "add symlink");

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.get("docs/link.md")).toBe("120000");
		expect(modes.get("real/a.md")).toBe("100644");
		expect(await inspectLink(dir, "docs/link.md")).toEqual({
			disk: "symlink",
			target: "../real/a.md",
			real: join(await realpath(dir), "real", "a.md"),
			escapes: false,
		});
	});
});

test("git.trackedModes: a gitlink (submodule entry) is 160000", async () => {
	await inTempRepo(async (dir) => {
		await writeFile(join(dir, "plain.md"), "x", "utf8");
		await runGit(dir, [
			"update-index",
			"--add",
			"--cacheinfo",
			`160000,${MODE_TEST_SHA},sub`,
		]);

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.get("sub")).toBe("160000");
	});
});

// MEASURED (git 2.54.0, 2026-09-30): after a content conflict in which only the merged-in side
// changed the mode, `ls-files -s` lists the path three times — stage 1 and 2 as 100644, stage 3
// as 100755 — so "keep the last record" and "keep the lowest stage" give different answers.
test("git.trackedModes: a path in a conflicted index gets ONE entry, the lowest stage's mode", async () => {
	await inTempRepo(async (dir) => {
		const file = join(dir, "f.txt");
		await writeFile(file, "base\n", "utf8");
		await commitAll(dir, "base");
		await runGit(dir, ["checkout", "-b", "other"]);
		await writeFile(file, "theirs\n", "utf8");
		await chmod(file, 0o755);
		await commitAll(dir, "theirs");
		await runGit(dir, ["checkout", "main"]);
		await writeFile(file, "ours\n", "utf8");
		await commitAll(dir, "ours");
		let mergeFailed = false;
		try {
			await runGit(dir, ["merge", "--no-edit", "other"]);
		} catch {
			mergeFailed = true;
		}
		const unmerged = (await runGit(dir, ["ls-files", "-u", "-z"])).toString(
			"utf8",
		);

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		// The fixture is a real three-stage conflict, so the single entry below is a choice.
		expect(mergeFailed).toBe(true);
		expect(unmerged.split("\0").filter((record) => record !== "")).toHaveLength(
			3,
		);
		expect([...modes]).toEqual([["f.txt", "100644"]]);
	});
});

test("git.trackedModes: a name containing a TAB, a space and non-ASCII characters is keyed verbatim", async () => {
	await inTempRepo(async (dir) => {
		const names = ["tab\tname.md", "sp ace.md", "café über.md"];
		for (const name of names) {
			await writeFile(join(dir, name), "x", "utf8");
		}
		await symlink("sp ace.md", join(dir, "link\twith tab"));
		await commitAll(dir, "add odd names");

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect([...modes.keys()].sort()).toEqual(
			[...names, "link\twith tab"].map(pathKey).sort(),
		);
		expect(modes.get("link\twith tab")).toBe("120000");
		expect(modes.get("tab\tname.md")).toBe("100644");
	});
});

test("git.trackedModes: an untracked symlink is absent from the map, while inspectLink still finds it on disk", async () => {
	await inTempRepo(async (dir) => {
		await writeFile(join(dir, "tracked.md"), "x", "utf8");
		await commitAll(dir, "add tracked");
		await symlink("tracked.md", join(dir, "loose"));

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.has("loose")).toBe(false);
		expect(await inspectLink(dir, "loose")).toMatchObject({
			disk: "symlink",
			target: "tracked.md",
		});
	});
});

test("git.trackedModes: reports what was COMMITTED — a tracked symlink replaced on disk by a regular file is still 120000", async () => {
	await inTempRepo(async (dir) => {
		await writeFile(join(dir, "real.md"), "x", "utf8");
		await symlink("real.md", join(dir, "link"));
		await commitAll(dir, "add symlink");
		await unlink(join(dir, "link"));
		await writeFile(join(dir, "link"), "now a file", "utf8");

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.get("link")).toBe("120000");
		expect(await inspectLink(dir, "link")).toEqual({ disk: "file" });
	});
});

test("git.trackedModes: a name git lists NFD (core.precomposeunicode=false) answers a lookup by its NFC spelling", async () => {
	await inTempRepo(async (dir) => {
		await runGit(dir, ["config", "core.precomposeunicode", "false"]);
		const decomposed = "café.md";
		await writeFile(join(dir, decomposed), "x", "utf8");
		await commitAll(dir, "add NFD file");

		const modes = await createCapabilities(
			dir,
			async () => [],
		).git.trackedModes();

		expect(modes.get(pathKey(decomposed.normalize("NFC")))).toBe("100644");
		expect(modes.get(pathKey(decomposed))).toBe("100644");
	});
});

test("git.trackedModes: a root that is not a git checkout fails as NotAGitCheckoutError", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-notgit-modes-"));
	try {
		const caps = createCapabilities(dir, async () => []);

		let caught: unknown;
		try {
			await caps.git.trackedModes();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(NotAGitCheckoutError);
		expect((caught as Error).message).toBe(`"${dir}" is not a git checkout`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.trackedModes: the map is memoized and refuses set, delete and clear (a frozen Map would not)", async () => {
	await inTempRepo(async (dir) => {
		await writeFile(join(dir, "a.md"), "x", "utf8");
		await commitAll(dir, "add a");
		const caps = createCapabilities(dir, async () => []);

		const modes = await caps.git.trackedModes();
		const writable = modes as Map<string, string>;

		expect(await caps.git.trackedModes()).toBe(modes);
		expect(() => writable.set("b.md", "120000")).toThrow(TypeError);
		expect(() => writable.delete("a.md")).toThrow(TypeError);
		expect(() => writable.clear()).toThrow(TypeError);
		expect([...modes]).toEqual([["a.md", "100644"]]);
	});
});

// Bun 1.3.14 and Node 26 ship these; older runtimes do not, so the assertion skips there.
const HAS_GET_OR_INSERT = "getOrInsert" in Map.prototype;
const HAS_GET_OR_INSERT_COMPUTED = "getOrInsertComputed" in Map.prototype;

interface Inserting {
	readonly getOrInsert: (key: string, value: string) => string;
	readonly getOrInsertComputed: (
		key: string,
		compute: (key: string) => string,
	) => string;
}

test.skipIf(!HAS_GET_OR_INSERT)(
	"git.trackedModes: the map refuses getOrInsert, which would insert a missing key",
	async () => {
		await inTempRepo(async (dir) => {
			await writeFile(join(dir, "a.md"), "x", "utf8");
			await commitAll(dir, "add a");
			const modes = await createCapabilities(
				dir,
				async () => [],
			).git.trackedModes();

			expect(() =>
				(modes as unknown as Inserting).getOrInsert("b.md", "120000"),
			).toThrow(TypeError);
			expect([...modes]).toEqual([["a.md", "100644"]]);
		});
	},
);

test.skipIf(!HAS_GET_OR_INSERT_COMPUTED)(
	"git.trackedModes: the map refuses getOrInsertComputed, which would insert a missing key",
	async () => {
		await inTempRepo(async (dir) => {
			await writeFile(join(dir, "a.md"), "x", "utf8");
			await commitAll(dir, "add a");
			const modes = await createCapabilities(
				dir,
				async () => [],
			).git.trackedModes();

			expect(() =>
				(modes as unknown as Inserting).getOrInsertComputed(
					"b.md",
					() => "120000",
				),
			).toThrow(TypeError);
			expect([...modes]).toEqual([["a.md", "100644"]]);
		});
	},
);

// parseTrackedModes is pinned against hand-built records too, so the stage rule, the key
// normalization and the TAB split do not depend on this machine's git or filesystem behaviour.
const record = (mode: string, stage: number, file: string): string =>
	`${mode} ${MODE_TEST_SHA} ${stage}\t${file}\0`;

test("parseTrackedModes: splits each record at the FIRST tab only, so a tab inside the name survives", () => {
	const modes = parseTrackedModes(
		record("100644", 0, "a\tb.md") + record("120000", 0, "sp ace\tx y"),
	);

	expect([...modes]).toEqual([
		["a\tb.md", "100644"],
		["sp ace\tx y", "120000"],
	]);
});

test("parseTrackedModes: keeps the lowest stage whatever order the records arrive in, and the lowest present when there is no stage 1", () => {
	const modes = parseTrackedModes(
		record("100755", 3, "f") +
			record("120000", 2, "f") +
			record("100644", 1, "f") +
			record("100755", 3, "g") +
			record("120000", 2, "g"),
	);

	expect([...modes]).toEqual([
		["f", "100644"],
		["g", "120000"],
	]);
});

test("parseTrackedModes: keys are NFC — a name listed NFD answers an NFC lookup, and an NFC-listed one answers an NFD lookup", () => {
	const nfc = "café.md";
	const nfd = "café.md";

	const listedNfd = parseTrackedModes(record("120000", 0, nfd));
	const listedNfc = parseTrackedModes(record("100644", 0, nfc));

	expect(listedNfd.get(pathKey(nfc))).toBe("120000");
	expect(listedNfd.get(pathKey(nfd))).toBe("120000");
	expect(listedNfc.get(pathKey(nfd))).toBe("100644");
});

test("parseTrackedModes: two names differing only in normalization form share one key — the first listed at the lowest stage wins", () => {
	const nfc = "caf\u00e9.md";
	const nfd = "cafe\u0301.md";

	const nfcFirst = parseTrackedModes(
		record("100644", 0, nfc) + record("120000", 0, nfd),
	);
	const nfdFirst = parseTrackedModes(
		record("120000", 0, nfd) + record("100644", 0, nfc),
	);
	const lowerStageLater = parseTrackedModes(
		record("100755", 2, nfc) + record("120000", 1, nfd),
	);

	expect([...nfcFirst]).toEqual([[nfc, "100644"]]);
	expect([...nfdFirst]).toEqual([[nfc, "120000"]]);
	expect([...lowerStageLater]).toEqual([[nfc, "120000"]]);
});

test("parseTrackedModes: empty output is an empty map, and a record off the documented shape throws instead of being skipped", () => {
	expect(parseTrackedModes("").size).toBe(0);
	expect(() => parseTrackedModes("garbage\0")).toThrow(
		'malformed "git ls-files -s -z" output',
	);
	expect(() =>
		parseTrackedModes(`100644 ${MODE_TEST_SHA} 0 no-tab.md\0`),
	).toThrow('malformed "git ls-files -s -z" output');
	expect(() =>
		parseTrackedModes(`10064 ${MODE_TEST_SHA} 0\tshort.md\0`),
	).toThrow('malformed "git ls-files -s -z" output');
});

// ---------------------------------------------------------------------------
// Environment/config isolation
// ---------------------------------------------------------------------------

test("git.trackedFiles: an inherited GIT_DIR does not redirect a read to a different repository's tracked files", async () => {
	const target = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fa1-target-"),
	);
	const victim = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fa1-victim-"),
	);
	const originalGitDir = process.env.GIT_DIR;
	try {
		await initRepo(target);
		await writeFile(join(target, "target-only.txt"), "x", "utf8");
		await commitAll(target, "target commit");

		await initRepo(victim);
		await writeFile(join(victim, "victim-only.txt"), "x", "utf8");
		await commitAll(victim, "victim commit");

		// `-C <target>` only sets git's *starting directory* (git.ts's own doc on `runGit`) —
		// an inherited `GIT_DIR` used to win over it outright. Measured directly against real
		// git, bypassing this module entirely: `env GIT_DIR=<victim>/.git git -C <target>
		// ls-files -z` exits 0 and prints `victim-only.txt`, not `target-only.txt` — the read
		// silently answers for the WRONG repository, no error at all. Setting it here mirrors
		// exactly that inherited-environment shape; `gitInitAndCommit`'s own "refuses to write
		// into the wrong repository" test (rule-tester.test.ts) covers the destructive *write*
		// half of the same root cause.
		process.env.GIT_DIR = join(victim, ".git");

		const caps = createCapabilities(target, async () => []);
		expect(await caps.git.trackedFiles()).toEqual(["target-only.txt"]);
	} finally {
		if (originalGitDir === undefined) {
			delete process.env.GIT_DIR;
		} else {
			process.env.GIT_DIR = originalGitDir;
		}
		await rm(target, { recursive: true, force: true });
		await rm(victim, { recursive: true, force: true });
	}
});

test("git.trackedFiles: a hostile core.fsmonitor set in the repo's OWN local config (not an env var — an extracted archive's own .git/config) is not executed by ls-files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-fb1-"));
	const markerDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fb1-marker-"),
	);
	const marker = join(markerDir, "ran.txt");
	try {
		await initRepo(dir);
		await writeFile(join(dir, "tracked.txt"), "x", "utf8");
		await commitAll(dir, "add tracked");

		const fsmonScript = join(markerDir, "fsmon.sh");
		await writeFile(
			fsmonScript,
			`#!/bin/sh\necho ran > "${marker}"\nexit 0\n`,
			"utf8",
		);
		await chmod(fsmonScript, 0o755);

		// Set directly in the repo's OWN local `.git/config` — unlike the environment-variable
		// cases above, this is NOT an environment variable at all, so nothing in
		// `GIT_ENV_SCRUB_KEYS` could ever cover it: a tarball or zip a user extracts can ship its
		// own `.git/config` with this already set, and the user owns that file just like any
		// other one in the archive.
		// `safe.directory` does not help either — that guards against a repo owned by a
		// DIFFERENT user, not this. Measured directly against real git (2026-09-04), bypassing
		// this module entirely: with this exact config set, a plain `git ls-files -z` (no `-c`
		// override) ran the script unasked, touching its marker file.
		await runGit(dir, ["config", "core.fsmonitor", fsmonScript]);

		const caps = createCapabilities(dir, async () => []);
		expect(await caps.git.trackedFiles()).toEqual(["tracked.txt"]);

		expect(existsSync(marker)).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(markerDir, { recursive: true, force: true });
	}
});

test("initRepo's config write is not redirected by an inherited GIT_CONFIG", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-fb2-"));
	const hijackDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fb2-hijack-"),
	);
	const hijackFile = join(hijackDir, "hijacked.conf");
	const originalGitConfig = process.env.GIT_CONFIG;
	try {
		// `GIT_CONFIG` (singular — distinct from `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`
		// above) redirects WHERE `git config` reads/writes when no `--file` is given —
		// `git-config.adoc:498-503`: "use the file given by GIT_CONFIG as if it were provided
		// via --file." Measured directly (2026-09-04), bypassing this module entirely: with
		// `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` isolated (this file's own module-scope
		// isolation, above) and no local `user.name` set, `env GIT_CONFIG=<hijack path> git
		// config user.name Hijacked` inside a fresh repo wrote `[user]\n\tname = Hijacked` into
		// the hijack path, leaving the repo's own `.git/config` with no `[user]` section at
		// all — and the commit that follows does NOT fail loudly: git silently falls back to a
		// machine-username/hostname-derived identity and still commits (exit 0), which is what
		// makes this a silent misattribution bug rather than a loud one.
		process.env.GIT_CONFIG = hijackFile;

		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");

		expect(existsSync(hijackFile)).toBe(false);
		const config = await readFile(join(dir, ".git", "config"), "utf8");
		expect(config).toContain("Test User");
	} finally {
		if (originalGitConfig === undefined) {
			delete process.env.GIT_CONFIG;
		} else {
			process.env.GIT_CONFIG = originalGitConfig;
		}
		await rm(dir, { recursive: true, force: true });
		await rm(hijackDir, { recursive: true, force: true });
	}
});

test("initRepo's commit does not run a hook injected via a hostile GIT_CONFIG_PARAMETERS", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-fa3-"));
	const hooksDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fa3-hooks-"),
	);
	const marker = join(hooksDir, "ran.txt");
	const originalParams = process.env.GIT_CONFIG_PARAMETERS;
	try {
		await writeFile(
			join(hooksDir, "pre-commit"),
			`#!/bin/sh\necho ran > "${marker}"\nexit 0\n`,
			"utf8",
		);
		await chmod(join(hooksDir, "pre-commit"), 0o755);

		// `GIT_CONFIG_GLOBAL=/dev/null` (this file's own module-scope isolation, above) closes
		// a global gitconfig FILE setting `core.hooksPath` — it does nothing against
		// `GIT_CONFIG_PARAMETERS`, `git -c`'s own internal channel for propagating config into
		// subprocesses, which is not a file at all. Measured directly (2026-09-04): before
		// git.ts's own fix, this exact assignment made a real `git commit` in a fresh repo run
		// a hook from an arbitrary directory, unasked.
		process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath'='${hooksDir}'`;

		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");

		expect(existsSync(marker)).toBe(false);
	} finally {
		if (originalParams === undefined) {
			delete process.env.GIT_CONFIG_PARAMETERS;
		} else {
			process.env.GIT_CONFIG_PARAMETERS = originalParams;
		}
		await rm(dir, { recursive: true, force: true });
		await rm(hooksDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Errors: not a git checkout / git missing / other non-zero exit (requirement A + G)
// ---------------------------------------------------------------------------

test("git.trackedFiles: a root that is not a git checkout fails with one clear message naming the absolute path, not a raw subprocess exit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-notgit-"));
	try {
		const caps = createCapabilities(dir, async () => []);

		let caught: unknown;
		try {
			await caps.git.trackedFiles();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as Error;
		expect(err.message).toContain(dir);
		// The two assertions above (`instanceof Error`, `.message` containing `dir`) are
		// also satisfied by the GENERIC "exited with code N" fallback — mutation-verified:
		// short-circuiting `toGitError`'s own "not a git checkout" branch to `if (false)` still
		// leaves both passing. Asserting the literal phrase is what actually pins "fails with
		// one clear message", not merely "fails with A message".
		expect(err.message).toBe(`"${dir}" is not a git checkout`);

		// What actually reaches the CLI's stderr at exit 2 (run.ts's `runCli`, via
		// `formatError`) is `.message` plus a one-line `.cause` — never a stack. Rendering it
		// here, with the real error this module produced, is what proves the one-clear-message
		// guarantee holds at the CLI boundary without needing a project/scan rule wired up to
		// reach it end to end.
		const rendered = formatError(err);
		expect(rendered).toContain(dir);
		expect(rendered.split("\n")).toHaveLength(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(!GIT_TRANSLATES_TO_GERMAN)(
	"git.trackedFiles: a root that is not a git checkout still fails with the exact same message under an inherited German LANGUAGE",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-notgit-de-"));
		const originalLanguage = process.env.LANGUAGE;
		try {
			// Measured directly against real git, bypassing this module (2026-09-04): `env
			// LANGUAGE=de git -C <dir> ls-files -z` on a non-checkout prints "Schwerwiegend:
			// Kein Git-Repository ...", not "fatal: not a git repository ..." — the exact
			// English prefix `toGitError`'s message-text check used to depend on exclusively.
			process.env.LANGUAGE = "de";

			const caps = createCapabilities(dir, async () => []);
			let caught: unknown;
			try {
				await caps.git.trackedFiles();
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(Error);
			// Same exact message as the English-locale case above — proving the caller-visible
			// behavior does not depend on the operator's locale. Mutation-checked (see this
			// task's own report, not reproduced here) that the two mechanisms genuinely
			// overlap for THIS scenario, rather than each independently proving itself: neither
			// disabling `isGitCheckout` (hardcoding it to `true`) NOR disabling `LC_ALL=C`/
			// `LANGUAGE=` alone breaks this test, because the other mechanism alone still
			// classifies it correctly — only short-circuiting `toGitError`'s whole "not a git
			// checkout" branch to `if (false)` does. This test still earns its place: it pins
			// the caller-visible contract (same message regardless of locale) that a reviewer
			// could otherwise regress by weakening EITHER mechanism at once, which single-line
			// mutation testing cannot observe on its own here.
			expect((caught as Error).message).toBe(`"${dir}" is not a git checkout`);
		} finally {
			if (originalLanguage === undefined) {
				delete process.env.LANGUAGE;
			} else {
				process.env.LANGUAGE = originalLanguage;
			}
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("git.trackedFiles: the git executable missing from PATH fails with a clear message naming PATH, not a bare ENOENT", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-noexec-"));
	const originalPath = process.env.PATH;
	try {
		// An empty string turned out NOT to reproduce this under Bun's runtime (unlike plain
		// Node) — Bun's own PATH search falls back to a default when the value is exactly ""
		// and still finds git, so this points PATH at a directory that provably does not
		// exist instead.
		process.env.PATH = "/definitely/not/a/real/dir/skillslurp-test";
		const caps = createCapabilities(dir, async () => []);
		await expect(caps.git.trackedFiles()).rejects.toThrow(
			/git.*not found on PATH/i,
		);
	} finally {
		process.env.PATH = originalPath;
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: a git failure that is neither ENOENT nor 'not a git repository' reports the exit code and git's own stderr, not a raw subprocess stack", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-badrev-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");

		const caps = createCapabilities(dir, async () => []);
		let caught: unknown;
		try {
			await caps.git.diff("totally-bogus-branch-name");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as Error;
		expect(err.message).toContain("exited with code 128");
		expect(formatError(err)).toContain("bad revision");
		expect(formatError(err).split("\n")).toHaveLength(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: a root that is not a git checkout fails as NotAGitCheckoutError, not the generic 'exited with code 129' `diff --no-index` falls into", async () => {
	// MEASURED (git 2.54.0, 2026-09-06): outside a checkout, `git diff` treats the missing
	// repository as a bad invocation of `--no-index` and exits 129 with usage text, not
	// `ls-files`'s 128-plus-`fatal:` shape — the case `toGitError` (git.ts) used to leave
	// unclassified, and the reason `engine.ts`'s `--diff-base` used to need its own probe.
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-notgit-diff-"));
	try {
		const caps = createCapabilities(dir, async () => []);

		let caught: unknown;
		try {
			await caps.git.diff("main");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(NotAGitCheckoutError);
		// Same one-sentence message as `trackedFiles()`'s own non-checkout case above — this
		// is `toGitError`'s single classification branch, not a second one only `diff` hits.
		expect((caught as Error).message).toBe(`"${dir}" is not a git checkout`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runGit: an exit 129 INSIDE a real checkout (an invalid flag, not a missing repository) is a generic failure, not NotAGitCheckoutError", async () => {
	// `caps.git.diff` cannot reach a 129 on a real checkout — `assertSafeRevision` refuses
	// any `base` shaped like a flag before it ever reaches git (see the "base starting with
	// '-'" tests above) — so this goes through `runGit` directly, the same path `toGitError`
	// classifies every call through, to reach the one 129 shape that must NOT become
	// `NotAGitCheckoutError`: a bad flag on a checkout that is real. MEASURED (git 2.54.0,
	// 2026-09-06): `git diff --this-flag-does-not-exist HEAD` inside a real repo exits 129
	// with git's own usage text, exactly like the outside-a-checkout case above — the two are
	// distinguishable only by asking `isGitCheckout`, never by exit code alone.
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-badflag-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");

		let caught: unknown;
		try {
			await runGit(dir, ["diff", "--this-flag-does-not-exist", "HEAD"]);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(NotAGitCheckoutError);
		const err = caught as Error;
		expect(err.message).toContain("exited with code 129");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runGit: a NUL byte in an argument fails with a message naming the real failure, not a fabricated exit code", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-nularg-"));
	try {
		await initRepo(dir);

		let caught: unknown;
		try {
			// Node's own argv validation rejects this before `git` is ever spawned — no exit
			// code exists for `toGitError` to report. `exec.code` on the resulting
			// `TypeError` is the STRING `"ERR_INVALID_ARG_VALUE"`, not a number; the previous
			// version of this branch printed that string where an exit code belongs
			// ("exited with code ERR_INVALID_ARG_VALUE") and silently dropped
			// `err.message` — the one place Node's own explanation ("must be a string
			// without null bytes") lives.
			await runGit(dir, ["diff", "totally\0bogus"]);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as Error;
		expect(err.message).toContain("failed to run");
		expect(err.message).toContain("null bytes");
		expect(err.message).not.toContain("exited with code");
		// Second half: the child never ran, so there is no stderr at all — `.cause` must
		// be entirely absent, not present-but-empty. `formatError` (run.ts) appends `:
		// <cause>` whenever `.cause !== undefined`, so a present-but-empty `.cause` would
		// render as a dangling `"...: "` with nothing after the colon; not ending in `": "` is
		// what proves `.cause` was omitted, not just empty.
		expect(formatError(err)).not.toMatch(/:\s*$/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runGit: output crossing this module's own 64 MiB ceiling fails with a message naming the real failure, not a fabricated exit code", async () => {
	// A non-executable "git" on PATH was the first shape tried for a second, distinct
	// string-`.code` case (`EACCES`, alongside the NUL-byte case above) — dropped: measured
	// (2026-09-04) that Bun's own PATH search (unlike plain Node's) resolves a non-executable,
	// or even a same-named directory, or a directory it cannot enter, straight to `ENOENT`
	// ("Executable not found in $PATH") without ever attempting the exec syscall that would
	// produce `EACCES` on Node — this suite runs under `bun test`, so that branch is not
	// reachable here. A giant `git log --format=%B -z` output is: crossing `MAX_BUFFER` is
	// the one string-`.code` shape (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) that IS reachable
	// under Bun, and cheaply — one commit with a ~70 MiB message clears this module's own
	// 64 MiB ceiling outright, far cheaper than generating enough FILES to do the same to
	// `ls-files -z` (the existing "raises execFile's 1 MiB default maxBuffer" test above does
	// that, but only far enough to clear execFile's 1 MiB default, two orders of magnitude
	// below this module's own ceiling).
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-overbuf-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);

		const bigMessagePath = join(dir, "big-message.txt");
		await writeFile(bigMessagePath, "x".repeat(70 * 1024 * 1024), "utf8");
		await writeFile(join(dir, "b.txt"), "b", "utf8");
		await runGit(dir, ["add", "-A"]);
		// `-F <file>`, not `-m <string>`: a ~70 MiB argv string risks the platform's own
		// ARG_MAX before it ever reaches this module's concern (the SUBPROCESS's stdout, not
		// its own argv).
		// `--quiet`: `git commit` without it echoes a summary that itself scales with the
		// message body — measured, this crossed `MAX_BUFFER` on the commit itself rather than
		// the later `git log`, which is not what this test is about.
		await runGit(dir, ["commit", "--quiet", "-F", bigMessagePath]);

		let caught: unknown;
		try {
			await runGit(dir, ["log", `${base}..HEAD`, "--format=%B", "-z", "--"]);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const err = caught as Error;
		expect(err.message).toContain("failed to run");
		expect(err.message).toContain("maxBuffer");
		expect(err.message).not.toContain("exited with code");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Argument injection (requirement B) — distinct from shell injection
// ---------------------------------------------------------------------------

test('git.diff: a base starting with "-" is rejected before it ever reaches git', async () => {
	// No real repo needed: the point of this test is that the rejection happens WITHOUT ever
	// touching git — proven by using a root that isn't even a real directory. If validation
	// happened too late (or not at all), this would instead surface as a "not a git checkout"
	// or ENOENT-flavored error, not this one.
	const caps = createCapabilities(
		"/definitely/does/not/exist/skillslurp-test",
		async () => [],
	);
	await expect(caps.git.diff("--upload-pack=/bin/sh")).rejects.toThrow(
		/must not start with "-"/,
	);
});

test('git.diff: an empty base is rejected rather than silently read as "HEAD...HEAD"', async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-fb5-diff-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");

		// A REAL repo, deliberately — not a nonexistent path: with `assertSafeRevision`'s empty
		// check removed, `` `${base}...HEAD` `` becomes the literal string `"...HEAD"`, which git
		// reads as `HEAD...HEAD` and happily resolves to `[]` (proven against real git above this
		// test's own source) rather than rejecting — so a nonexistent root would let a REMOVED
		// check hide behind an unrelated "not a git checkout" rejection instead of surfacing as a
		// resolved, empty-but-wrong result the way it would in production.
		const caps = createCapabilities(dir, async () => []);
		await expect(caps.git.diff("")).rejects.toThrow(/must not be empty/);
		await expect(caps.git.diff("   ")).rejects.toThrow(/must not be empty/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// git.diff()
// ---------------------------------------------------------------------------

test("git.diff: happy path — added, modified and deleted files against a real repo", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-diff-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "keep.txt"), "line one\n", "utf8");
		await writeFile(join(dir, "gone.txt"), "bye\n", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);

		await writeFile(join(dir, "keep.txt"), "line one\nline two\n", "utf8");
		await unlink(join(dir, "gone.txt"));
		await writeFile(join(dir, "new.txt"), "hello\n", "utf8");
		await commitAll(dir, "second");

		const caps = createCapabilities(dir, async () => []);
		const changed = await caps.git.diff(base);

		expect([...changed].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "gone.txt", status: "deleted" },
			{ path: "keep.txt", status: "modified" },
			{ path: "new.txt", status: "added" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: a pure rename is reported once, as `renamed` at the NEW path (three-field R<score> entry, not a naive status/path pair)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-rename-"));
	try {
		await initRepo(dir);
		await writeFile(
			join(dir, "orig.txt"),
			"line1\nline2\nline3\nline4\nline5\n",
			"utf8",
		);
		await commitAll(dir, "base");
		const base = await headRev(dir);

		await runGit(dir, ["mv", "orig.txt", "renamed.txt"]);
		await commitAll(dir, "rename");

		const caps = createCapabilities(dir, async () => []);
		const changed = await caps.git.diff(base);

		expect(changed).toEqual([{ path: "renamed.txt", status: "renamed" }]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: a typechange (regular file replaced by a symlink) maps to `modified`", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-typechange-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "target.txt"), "target content\n", "utf8");
		await writeFile(join(dir, "swap.txt"), "regular file\n", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);

		await unlink(join(dir, "swap.txt"));
		await symlink("target.txt", join(dir, "swap.txt"));
		await commitAll(dir, "typechange");

		const caps = createCapabilities(dir, async () => []);
		const changed = await caps.git.diff(base);

		expect(changed).toEqual([{ path: "swap.txt", status: "modified" }]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: is root-relative and root-scoped when root is a subdirectory of the repo, matching trackedFiles()", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "skillslurp-context-fb4-"));
	try {
		await initRepo(repoDir);
		await mkdir(join(repoDir, "packages", "foo", "docs"), { recursive: true });
		await mkdir(join(repoDir, "other"), { recursive: true });
		await writeFile(
			join(repoDir, "packages", "foo", "docs", "a.md"),
			"a\n",
			"utf8",
		);
		await writeFile(join(repoDir, "other", "b.md"), "b\n", "utf8");
		await commitAll(repoDir, "base");
		const base = await headRev(repoDir);

		// Modify a file INSIDE root and one OUTSIDE root, in the same commit.
		await writeFile(
			join(repoDir, "packages", "foo", "docs", "a.md"),
			"a\na2\n",
			"utf8",
		);
		await writeFile(join(repoDir, "other", "b.md"), "b\nb2\n", "utf8");
		await commitAll(repoDir, "second");

		const root = join(repoDir, "packages", "foo");
		const caps = createCapabilities(root, async () => []);
		const changed = await caps.git.diff(base);

		// Root-relative (matches `trackedFiles()`'s own basis: `docs/a.md`, not
		// `packages/foo/docs/a.md`) AND root-scoped: `other/b.md` — outside `root` entirely,
		// changed in the very same commit range — must not appear at all.
		expect(changed).toEqual([{ path: "docs/a.md", status: "modified" }]);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});

test("git.diff: a rename crossing root's own boundary is reported as a plain delete, not a cross-scope rename pair", async () => {
	const repoDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-fb4-rename-"),
	);
	try {
		await initRepo(repoDir);
		await mkdir(join(repoDir, "packages", "foo", "docs"), { recursive: true });
		await mkdir(join(repoDir, "other"), { recursive: true });
		await writeFile(
			join(repoDir, "packages", "foo", "docs", "a.md"),
			"line1\nline2\nline3\nline4\nline5\n",
			"utf8",
		);
		await commitAll(repoDir, "base");
		const base = await headRev(repoDir);

		// Rename OUT of root entirely.
		await runGit(repoDir, ["mv", "packages/foo/docs/a.md", "other/a-moved.md"]);
		await commitAll(repoDir, "move out");

		const root = join(repoDir, "packages", "foo");
		const caps = createCapabilities(root, async () => []);
		const changed = await caps.git.diff(base);

		// From root's own point of view the file simply disappeared — a `deleted`, never a
		// `renamed` naming a path outside `root` that `resolve(root, path)` (`buildCorpus`)
		// could not have opened anyway. Proves `--relative` degrades a cross-boundary rename to
		// a plain two-field entry rather than emitting the three-field `R<score>` form with one
		// path in scope and one not — which `parseNameStatusZ`'s R/C-vs-plain stride logic was
		// never written to expect.
		expect(changed).toEqual([{ path: "docs/a.md", status: "deleted" }]);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});

test("git.diff: an operator's own diff.relative=false cannot re-widen the scope back to repo-root-relative", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "skillslurp-context-fb3b-"));
	try {
		await initRepo(repoDir);
		await mkdir(join(repoDir, "packages", "foo"), { recursive: true });
		await writeFile(join(repoDir, "packages", "foo", "a.md"), "a\n", "utf8");
		await commitAll(repoDir, "base");
		const base = await headRev(repoDir);

		await writeFile(
			join(repoDir, "packages", "foo", "a.md"),
			"a\na2\n",
			"utf8",
		);
		await commitAll(repoDir, "second");

		// The repo's OWN local config, explicitly countermanding root-scoping — this module's
		// own `--relative` is a command-line flag, and a command-line flag always beats a
		// config FILE value (whichever way that file's own setting points). Measured directly
		// (2026-09-04, real repo, real local config file — not simulated via `-c`): with
		// `diff.relative=false` on file, `git -C <root> diff --name-status --relative -z
		// <range> --` still produced the scoped, root-relative result, not the repo-root-wide
		// one this config value would otherwise have restored.
		await runGit(repoDir, ["config", "diff.relative", "false"]);

		const root = join(repoDir, "packages", "foo");
		const caps = createCapabilities(root, async () => []);
		const changed = await caps.git.diff(base);

		expect(changed).toEqual([{ path: "a.md", status: "modified" }]);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});

test("git.diff: base === HEAD (no changes) returns []", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-diffempty-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);

		const caps = createCapabilities(dir, async () => []);
		expect(await caps.git.diff(base)).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: memoized per base — two calls with the same base share one underlying subprocess run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-diffmemo-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);
		await writeFile(join(dir, "b.txt"), "b", "utf8");
		await commitAll(dir, "second");

		const caps = createCapabilities(dir, async () => []);
		const first = await caps.git.diff(base);
		const second = await caps.git.diff(base);

		expect(first).toBe(second);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("git.diff: the returned array and its entries are frozen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-difffrozen-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "a", "utf8");
		await commitAll(dir, "base");
		const base = await headRev(dir);
		await writeFile(join(dir, "b.txt"), "b", "utf8");
		await commitAll(dir, "second");

		const caps = createCapabilities(dir, async () => []);
		const changed = await caps.git.diff(base);

		expect(Object.isFrozen(changed)).toBe(true);
		expect(changed.length).toBeGreaterThan(0);
		expect(Object.isFrozen(changed[0])).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// parseNameStatusZ() — statuses this module's own git invocation cannot itself produce
// (requirement D): C (needs an explicit -C flag we don't pass), U/X (need a real merge
// conflict / a broken git object), plus the malformed-stream and empty-input edge cases.
// Tested directly against the pure parser with hand-built input.
// ---------------------------------------------------------------------------

test("parseNameStatusZ: a copy (C<score>) maps to `added` at the new path", () => {
	const raw = "C100\0orig.txt\0copy.txt\0";
	expect(parseNameStatusZ(raw)).toEqual([
		{ path: "copy.txt", status: "added" },
	]);
});

test("parseNameStatusZ: an unrecognized status letter throws, naming the raw status, rather than guessing a mapping", () => {
	expect(() => parseNameStatusZ("U\0conflict.txt\0")).toThrow(/"U"/);
});

test("parseNameStatusZ: a rename entry missing its new-path field is a malformed-stream error, not a silently wrong parse", () => {
	expect(() => parseNameStatusZ("R100\0orig.txt\0")).toThrow(/malformed/);
});

test("parseNameStatusZ: empty input is []", () => {
	expect(parseNameStatusZ("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// grep()
// ---------------------------------------------------------------------------

test("grep: results are ordered by file (trackedFiles order), then line, then column — fixture is deliberately NOT pre-sorted on disk", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-order-"));
	try {
		await initRepo(dir);
		// "zzz-first.md" is written and staged FIRST; "aaa-second.md" second. `git ls-files`
		// still returns them alphabetically ("aaa-second.md" before "zzz-first.md") — if this
		// test's fixture were created in alphabetical order already, a bug that returned hits
		// in *creation* order instead of `trackedFiles()` order could pass by accident (the
		// exact failure mode CLAUDE.md records having happened once already).
		await writeFile(
			join(dir, "zzz-first.md"),
			"needle here\nsomething else\nneedle needle\n",
			"utf8",
		);
		await writeFile(join(dir, "aaa-second.md"), "needle\n", "utf8");
		await commitAll(dir, "add fixtures");

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);

		expect(hits).toEqual([
			{ file: "aaa-second.md", line: 1, col: 1, text: "needle" },
			{ file: "zzz-first.md", line: 1, col: 1, text: "needle" },
			{ file: "zzz-first.md", line: 3, col: 1, text: "needle" },
			{ file: "zzz-first.md", line: 3, col: 8, text: "needle" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: with ≥200 tracked files of varied size, hit order is deterministic and matches trackedFiles order, built twice (buildCorpus reads concurrently)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-scale-"));
	try {
		await initRepo(dir);
		const totalFiles = 220;
		// Zero-padded so alphabetical order (`git ls-files`'s own sort, i.e.
		// `trackedFiles()` order) is exactly ascending insertion order — "file-000.md" first,
		// "file-219.md" last.
		const names = Array.from(
			{ length: totalFiles },
			(_, i) => `file-${String(i).padStart(3, "0")}.md`,
		);
		for (const [i, name] of names.entries()) {
			// Padding runs OPPOSITE to trackedFiles order: the FIRST file is the LARGEST
			// (slowest to read and decode), the LAST is the smallest (fastest) — if
			// `buildCorpus` ever assembled the corpus in COMPLETION order instead of
			// `candidates`'/`trackedFiles()` order, the first file's hit would land near the
			// END of `hits` instead of the start, and the assertion below would fail loudly.
			const paddingLines = (totalFiles - i) * 5;
			const content = `needle\n${"filler line\n".repeat(paddingLines)}`;
			await writeFile(join(dir, name), content, "utf8");
		}
		await commitAll(dir, "add fixtures");

		const first = await createCapabilities(dir, async () => []).grep(/needle/);
		const second = await createCapabilities(dir, async () => []).grep(/needle/);

		expect(first.map((h) => h.file)).toEqual(names);
		expect(second).toEqual(first);
		for (const hit of first) {
			expect(hit.line).toBe(1);
			expect(hit.col).toBe(1);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

test("grep: line 1 col 1, and a hit immediately after a CRLF line ending, both report correct 1-based line/col", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-crlf-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "mixed.txt"), "foo\r\nbar", "utf8");
		await commitAll(dir, "add mixed");

		const caps = createCapabilities(dir, async () => []);
		// Anchored to end-of-line (`$`) deliberately: if the split left a trailing "\r" on
		// line 1 (i.e. treated only "\n" as a break), `/^foo$/` would NOT match "foo\r" and
		// this test would fail loudly instead of passing on an unrelated technicality.
		const hits = await caps.grep(/^foo$|^bar$/);

		expect(hits).toEqual([
			{ file: "mixed.txt", line: 1, col: 1, text: "foo" },
			{ file: "mixed.txt", line: 2, col: 1, text: "bar" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: a zero-length match (e.g. a pattern built from `x*`) does not infinite-loop, and reports one hit per position", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-zero-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "short.txt"), "ab", "utf8");
		await commitAll(dir, "add short");

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/x*/);

		expect(hits).toEqual([
			{ file: "short.txt", line: 1, col: 1, text: "" },
			{ file: "short.txt", line: 1, col: 2, text: "" },
			{ file: "short.txt", line: 1, col: 3, text: "" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: never mutates the caller's own RegExp (lastIndex is unchanged after the call)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-mutate-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "foo bar foo\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		const pattern = /foo/g;
		// Simulate the caller having already used this exact object for something of their
		// own before calling ctx.grep — a global RegExp's lastIndex is part of its own,
		// externally-visible state.
		pattern.exec("xxxfooxxx");
		const lastIndexBefore = pattern.lastIndex;
		expect(lastIndexBefore).toBeGreaterThan(0);

		await caps.grep(pattern);

		expect(pattern.lastIndex).toBe(lastIndexBefore);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: called twice with the same global-flagged pattern returns identical results both times", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-twice-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "foo\nfoo\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		const pattern = /foo/g;

		const first = await caps.grep(pattern);
		// Perturb the pattern's own state between calls, as an independent caller reusing it
		// elsewhere might.
		pattern.lastIndex = 999;
		const second = await caps.grep(pattern);

		expect(second).toEqual(first);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: skips a tracked file that fails to decode as UTF-8 without crashing, and still scans the rest", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-bin-"));
	try {
		await initRepo(dir);
		// "needle" itself, plus a trailing lone continuation byte (never valid UTF-8 on its
		// own) — deliberately so that if the fatal decode were ever skipped, this file would
		// ALSO produce a "needle" hit and this test would fail loudly instead of passing for
		// the wrong reason (the assertion below would then see two hits, not one).
		await writeFile(
			join(dir, "binary.dat"),
			Buffer.concat([Buffer.from("needle\n", "utf8"), Buffer.from([0xff])]),
		);
		await writeFile(join(dir, "text.txt"), "needle\n", "utf8");
		await commitAll(dir, "add both");

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);

		expect(hits).toEqual([
			{ file: "text.txt", line: 1, col: 1, text: "needle" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: skips a tracked-but-deleted-from-worktree path (ENOENT) without crashing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-enoent-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "ghost.txt"), "needle\n", "utf8");
		await writeFile(join(dir, "real.txt"), "needle\n", "utf8");
		await runGit(dir, ["add", "-A"]);
		// Removed from the worktree WITHOUT `git rm` — still tracked (still in the index /
		// `ls-files` output), but reading it off disk now fails with ENOENT.
		await unlink(join(dir, "ghost.txt"));

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);

		expect(hits).toEqual([
			{ file: "real.txt", line: 1, col: 1, text: "needle" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('grep: skips a submodule gitlink entry (EISDIR — a tracked "file" that is actually a directory) without crashing', async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-eisdir-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "real.txt"), "needle\n", "utf8");
		await runGit(dir, ["add", "real.txt"]);
		await mkdir(join(dir, "sub-thing"));
		await writeFile(join(dir, "sub-thing", "whatever.txt"), "needle\n", "utf8");
		// A raw gitlink entry (mode 160000), the same shape a real submodule reference has —
		// without an actual submodule checkout, so `readFile` on it hits a real directory.
		await runGit(dir, [
			"update-index",
			"--add",
			"--cacheinfo",
			"160000,1111111111111111111111111111111111111111,sub-thing",
		]);
		await runGit(dir, ["commit", "-m", "add gitlink"]);

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);

		// Only real.txt is scanned: sub-thing (EISDIR) is skipped, and the file underneath it
		// on disk is not itself a tracked path (git never traverses into a gitlink).
		expect(hits).toEqual([
			{ file: "real.txt", line: 1, col: 1, text: "needle" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(!CHMOD_DENIES_OWNER)(
	"grep: a read error that is NOT ENOENT (e.g. EACCES) propagates, wrapped with the repo-relative path",
	async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "skillslurp-context-grep-eacces-"),
		);
		try {
			await initRepo(dir);
			await writeFile(join(dir, "locked.txt"), "needle\n", "utf8");
			await commitAll(dir, "add locked");
			await chmod(join(dir, "locked.txt"), 0o000);

			const caps = createCapabilities(dir, async () => []);
			try {
				// The underlying EACCES is not swallowed (propagates as `.cause`), but it is
				// now wrapped with the tracked, repo-relative path — a bare
				// `EACCES: permission denied, open '/abs/path'` names no TRACKED file at all.
				await expect(caps.grep(/needle/)).rejects.toMatchObject({
					message: 'failed to read "locked.txt"',
					cause: { code: "EACCES" },
				});
			} finally {
				await chmod(join(dir, "locked.txt"), 0o644);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("grep: skips a committed symlink loop (ELOOP on realpath) without crashing, and still scans the rest", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-loop-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "real.txt"), "needle\n", "utf8");
		await symlink("b", join(dir, "a"));
		await symlink("a", join(dir, "b"));
		await commitAll(dir, "add loop");

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);

		expect(hits).toEqual([
			{ file: "real.txt", line: 1, col: 1, text: "needle" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(!CHMOD_DENIES_OWNER)(
	"grep: skips a committed symlink into a directory the process may not search (EACCES on realpath), and still scans the rest",
	async () => {
		const parent = await mkdtemp(
			join(tmpdir(), "skillslurp-context-grep-link-eacces-"),
		);
		const locked = join(parent, "locked");
		try {
			const dir = join(parent, "repo");
			await mkdir(dir);
			await initRepo(dir);
			await mkdir(join(locked, "inner"), { recursive: true });
			await writeFile(join(dir, "real.txt"), "needle\n", "utf8");
			await symlink("../locked/inner/secret.txt", join(dir, "leak"));
			await commitAll(dir, "add leak");
			await chmod(locked, 0o000);

			const caps = createCapabilities(dir, async () => []);
			const hits = await caps.grep(/needle/);

			expect(hits).toEqual([
				{ file: "real.txt", line: 1, col: 1, text: "needle" },
			]);
		} finally {
			await chmod(locked, 0o755).catch(() => undefined);
			await rm(parent, { recursive: true, force: true });
		}
	},
);

test.skipIf(!CHMOD_DENIES_OWNER)(
	"grep: a regular tracked file whose own realpath fails (EACCES on its directory) still fails loudly, unlike a symlink",
	async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "skillslurp-context-grep-dir-eacces-"),
		);
		try {
			await initRepo(dir);
			await mkdir(join(dir, "locked-dir"));
			await writeFile(join(dir, "locked-dir", "x.txt"), "needle\n", "utf8");
			await commitAll(dir, "add locked-dir");
			await chmod(join(dir, "locked-dir"), 0o000);

			const caps = createCapabilities(dir, async () => []);
			try {
				await expect(caps.grep(/needle/)).rejects.toMatchObject({
					message: 'failed to read "locked-dir/x.txt"',
					cause: { code: "EACCES" },
				});
			} finally {
				await chmod(join(dir, "locked-dir"), 0o755);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(!CHMOD_DENIES_OWNER)(
	"grep: with TWO unreadable tracked files, the thrown error names the earlier path in trackedFiles order (buildCorpus reads concurrently)",
	async () => {
		const dir = await mkdtemp(
			join(tmpdir(), "skillslurp-context-grep-eacces-order-"),
		);
		try {
			await initRepo(dir);
			await writeFile(join(dir, "a-locked.txt"), "needle\n", "utf8");
			await writeFile(join(dir, "mid.txt"), "needle\n", "utf8");
			await writeFile(join(dir, "z-locked.txt"), "needle\n", "utf8");
			await commitAll(dir, "add fixtures");
			await chmod(join(dir, "a-locked.txt"), 0o000);
			await chmod(join(dir, "z-locked.txt"), 0o000);

			const caps = createCapabilities(dir, async () => []);
			try {
				// Pins the integration, not the ordering rule: under bun both reads fail at their
				// first step, so time order rarely disagrees with index order here and this test
				// is not a reliable discriminator. The lowest-index rule itself is proven by
				// mapBounded's controlled-delay test.
				await expect(caps.grep(/needle/)).rejects.toMatchObject({
					message: 'failed to read "a-locked.txt"',
					cause: { code: "EACCES" },
				});
			} finally {
				await chmod(join(dir, "a-locked.txt"), 0o644);
				await chmod(join(dir, "z-locked.txt"), 0o644);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("grep: the corpus is read once per run — a file changed on disk after the first call is not re-read by the second", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-corpus-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		expect(await caps.grep(/hello/)).toEqual([
			{ file: "a.txt", line: 1, col: 1, text: "hello" },
		]);

		// Mutated directly on disk, bypassing git entirely — if the corpus were rebuilt per
		// `grep()` call instead of memoized once, this would be visible immediately.
		await writeFile(join(dir, "a.txt"), "goodbye\n", "utf8");

		expect(await caps.grep(/goodbye/)).toEqual([]);
		expect(await caps.grep(/hello/)).toEqual([
			{ file: "a.txt", line: 1, col: 1, text: "hello" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: the returned array is frozen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-frozen-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "needle\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		expect(Object.isFrozen(await caps.grep(/needle/))).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: each returned hit object is itself frozen, not just the containing array", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-hit-frozen-"),
	);
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "needle\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		const hits = await caps.grep(/needle/);
		const hit = hits[0];
		if (hit === undefined) {
			throw new Error("expected at least one hit");
		}
		expect(Object.isFrozen(hit)).toBe(true);
		// Matches ChangedFile's own element-wise freeze (CLAUDE.md's "freeze anything handed
		// out of a module" habit): a caller mutating a hit in place must fail loudly, the same
		// as it already does for the array itself. `GrepHit`'s own fields are plain,
		// mutable-looking TS types (matching `ChangedFile`'s own convention — enforcement is a
		// runtime `freeze`, not a `readonly` modifier), so `hit.line = 999` compiles today
		// regardless of this fix; only the RUNTIME behavior (strict-mode assignment to a
		// frozen object's own property throws) is what this test is actually about.
		expect(() => {
			hit.line = 999;
		}).toThrow(TypeError);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(!MKFIFO_AVAILABLE)(
	"grep: a tracked symlink to a FIFO is skipped, not read — hangs forever without the stat gate",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-fifo-"));
		try {
			await initRepo(dir);
			await writeFile(join(dir, "a.md"), "needle\n", "utf8");
			// The FIFO itself is never tracked (git has no way to store one) — only the
			// symlink pointing at it is. Opening a FIFO for reading blocks until some other
			// process opens its write end, which nothing here ever does — this is exactly the
			// hang the stat gate exists to prevent `ctx.grep` from hitting.
			await promisify(execFileCb)("mkfifo", [join(dir, "pipe.fifo")]);
			await symlink("pipe.fifo", join(dir, "pipe.md"));
			await commitAll(dir, "add fixtures");

			const caps = createCapabilities(dir, async () => []);
			// 5s hard timeout, well under bun's own 10s test timeout set below: a regression
			// here fails this ONE test in 5s instead of hanging the whole suite forever.
			const hits = await withTimeout(caps.grep(/needle/), 5_000);

			expect(hits).toEqual([{ file: "a.md", line: 1, col: 1, text: "needle" }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	10_000,
);

test("grep: a tracked symlink pointing outside the repository is skipped, not read (security)", async () => {
	const outsideDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-outside-"),
	);
	const repoDir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-escape-"),
	);
	try {
		// A file OUTSIDE the repo entirely — never tracked, never meant to be scanned. Its
		// name deliberately does not shadow any real credential file; the fixture only needs
		// to prove that its CONTENT is unreachable through the repo's own grep.
		const secretPath = join(outsideDir, "secret.txt");
		await writeFile(secretPath, "SECRETLINE\n", "utf8");

		await initRepo(repoDir);
		await writeFile(join(repoDir, "keep.md"), "needle\n", "utf8");
		// A symlink whose target escapes the repo root entirely.
		await symlink(secretPath, join(repoDir, "escape.md"));
		// A symlink whose target stays INSIDE the repo — must keep working normally, so this
		// fix is proven to be a containment check, not "skip every symlink".
		await symlink("keep.md", join(repoDir, "inside-link.md"));
		await commitAll(repoDir, "add fixtures");

		const caps = createCapabilities(repoDir, async () => []);

		expect(await caps.grep(/SECRETLINE/)).toEqual([]);
		expect(await caps.grep(/needle/)).toEqual([
			{ file: "inside-link.md", line: 1, col: 1, text: "needle" },
			{ file: "keep.md", line: 1, col: 1, text: "needle" },
		]);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	}
});

test("grep: a sticky (`y`) pattern is rejected outright rather than silently under-reporting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-sticky-"));
	try {
		await initRepo(dir);
		await writeFile(join(dir, "a.txt"), "bab bab\n", "utf8");
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		// Measured (2026-09-04, `bun -e`): cloning `/a/y` with `g` added (this function's own
		// cloning step) and scanning "bab bab" returns ZERO hits — sticky still anchors every
		// attempt to exactly `lastIndex`, so the very first non-matching position (index 0,
		// "b") stops the scan dead, where the non-sticky `/a/` finds two (col 2, col 6).
		// Silently returning `[]` here would be indistinguishable from "no matches in this
		// repo" — a false negative a scan rule could never tell apart from the truth — so
		// `grep()` refuses the pattern instead.
		await expect(caps.grep(/a/y)).rejects.toThrow(/sticky/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: a zero-length match on a `u`-flagged pattern advances by code point, not UTF-16 code unit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-astral-"));
	try {
		await initRepo(dir);
		// U+1F600 GRINNING FACE, twice, then a space and "x" — each emoji is one code point
		// but two UTF-16 code units (a surrogate pair). File written as raw UTF-8 bytes so the
		// on-disk content is unambiguous regardless of this source file's own encoding.
		await writeFile(
			join(dir, "a.txt"),
			Buffer.from("\u{1F600}\u{1F600} x\n", "utf8"),
		);
		await commitAll(dir, "add a");

		const caps = createCapabilities(dir, async () => []);
		// A pattern that always matches zero characters, `u`-flagged: the only way its
		// `col` values can reveal a code-unit-vs-code-point bug the same way the `/x*/`
		// fixture revealed the zero-length infinite-loop bug.
		const hits = await caps.grep(/(?:)/u);

		// Measured (2026-09-04, `bun -e`, `String.prototype.matchAll` as the spec-correct
		// baseline over the identical string): match indices `0,2,4,5,6` — cols `1,3,5,6,7`.
		// The OLD unconditional `lastIndex += 1` measured `0,1,2,3,4,5,6` instead (cols
		// `1,2,3,4,5,6,7`) — two extra hits, each landing inside a surrogate pair.
		expect(hits.map((h) => h.col)).toEqual([1, 3, 5, 6, 7]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: a file ending in exactly one newline reports no phantom line past EOF", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-eof-phantom-"),
	);
	try {
		await initRepo(dir);
		await writeFile(join(dir, "c.md"), "aaa\n", "utf8");
		await commitAll(dir, "add c");

		const caps = createCapabilities(dir, async () => []);
		// `/^/g` matches (zero-length) once at the start of every line this file actually
		// has — `"aaa\n".split(/\r\n|\n/)` produces `["aaa", ""]` before the phantom-line fix,
		// and the trailing "" is a split ARTIFACT ("nothing came after the last newline"), not a
		// real second, empty line — a phantom `{ line: 2, col: 1, text: "" }` is exactly what
		// the phantom-line fix removes.
		expect(await caps.grep(/^/g)).toEqual([
			{ file: "c.md", line: 1, col: 1, text: "" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("grep: a file ending in TWO newlines keeps its genuine blank last line (the case the naive fix loses)", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-eof-realblank-"),
	);
	try {
		await initRepo(dir);
		await writeFile(join(dir, "d.md"), "aaa\n\n", "utf8");
		await commitAll(dir, "add d");

		const caps = createCapabilities(dir, async () => []);
		// `"aaa\n\n".split(/\r\n|\n/)` produces `["aaa", "", ""]`: the file has TWO real
		// lines ("aaa", then a genuinely empty, newline-terminated second line) plus one
		// trailing split artifact. Dropping every trailing "" (instead of exactly one) would
		// also delete the genuine second line, under-reporting 1 hit instead of 2 — the
		// opposite-direction bug a careless fix for the phantom-line case above could
		// introduce.
		expect(await caps.grep(/^/g)).toEqual([
			{ file: "d.md", line: 1, col: 1, text: "" },
			{ file: "d.md", line: 2, col: 1, text: "" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// grep() corpus scope: the config file and the top-level `ignore`
// ---------------------------------------------------------------------------

/**
 * A `ctx.grep` over a fixture whose only hit is inside `skillslurp.json`
 * returns nothing, plus the control that makes it discriminating.
 *
 * The control is not optional here. `createCapabilities`'s `scope` argument is OPTIONAL, so a
 * test that only asserted the scoped call returns `[]` would pass just as happily against a
 * `buildCorpus` that had silently stopped reading the config file for some unrelated reason — or
 * against a fixture whose pattern never matched anything in the first place. Asserting that the
 * SAME fixture and the SAME pattern do find the hit without a scope is what pins the exclusion to
 * `CorpusScope.configFile` and nothing else.
 */
test("grep: the run's own skillslurp.json is not a scan target", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-config-"));
	try {
		await initRepo(dir);
		// The ONLY occurrence of the token in the whole repo sits in the config file — the shape
		// an allowlist entry has in real life, and the reason the allowlist staleness guard
		// would otherwise be unreachable: the entry always matches its own literal.
		await writeFile(
			join(dir, "skillslurp.json"),
			'{"surfaces":[{"root":"skills","rules":{"refs/no-dangling-paths":{"options":{"allow":["skills/ALLOWLISTED-TOKEN.md"]}}}}]}\n',
			"utf8",
		);
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(join(dir, "skills", "SKILL.md"), "# Skill\n", "utf8");
		await commitAll(dir, "base");

		const scope: CorpusScope = {
			configFile: join(dir, "skillslurp.json"),
			baselineFile: join(dir, BASELINE_FILENAME),
			ignore: [],
		};
		const scoped = createCapabilities(dir, async () => [], scope);
		expect(await scoped.grep(/ALLOWLISTED-TOKEN/)).toEqual([]);

		// Control: the identical fixture and pattern, with no scope, DOES see it.
		const unscoped = createCapabilities(dir, async () => []);
		expect(
			(await unscoped.grep(/ALLOWLISTED-TOKEN/)).map((hit) => hit.file),
		).toEqual(["skillslurp.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * The baseline file's half of the same argument: a baseline entry's key IS the message of the
 * diagnostic it suppresses, so `skillslurp-baseline.json` is full of the very path literals the
 * `refs/no-dangling-paths` scan looks for. Left in the corpus, a baseline that suppresses "path X does not
 * exist" re-reports X from inside itself.
 *
 * Same control as the config-file case above, and for the same reason: the scoped call returning
 * `[]` proves nothing on its own.
 */
test("grep: the run's own skillslurp-baseline.json is not a scan target", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-baseline-"),
	);
	try {
		await initRepo(dir);
		// The only occurrence of the token in the repo is inside the baseline file — the shape a
		// real entry has, since the key is the diagnostic's own message.
		await writeFile(
			join(dir, BASELINE_FILENAME),
			'{"version":1,"files":{"a.md":{"refs/no-dangling-paths":{"Path \\"skills/BASELINED-TOKEN.md\\" does not exist or is not tracked by git":1}}}}\n',
			"utf8",
		);
		await writeFile(join(dir, "a.md"), "# A\n", "utf8");
		await commitAll(dir, "base");

		const scope: CorpusScope = {
			configFile: join(dir, "skillslurp.json"),
			baselineFile: join(dir, BASELINE_FILENAME),
			ignore: [],
		};
		const scoped = createCapabilities(dir, async () => [], scope);
		expect(await scoped.grep(/BASELINED-TOKEN/)).toEqual([]);

		// Control: the identical fixture and pattern, with no scope, DOES see it.
		const unscoped = createCapabilities(dir, async () => []);
		expect(
			(await unscoped.grep(/BASELINED-TOKEN/)).map((hit) => hit.file),
		).toEqual([BASELINE_FILENAME]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * A `ctx.grep` over a fixture whose only hit is in an `ignore`d path returns nothing,
 * with the same control for the same reason as the case above.
 *
 * `vendor/**` rather than one of `DEFAULT_IGNORE`'s two entries on purpose: someone who ignores
 * `vendor/**` from discovery does not want dangling-path scans over it either (`ignore`
 * scopes the scan corpus too), and it is a USER-written pattern, which is the half that would
 * otherwise go untested — `**\/.git/**` is inert here (git never tracks paths under `.git`).
 */
test("grep: a tracked file matching the top-level ignore list is not a scan target", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-context-grep-ignore-"));
	try {
		await initRepo(dir);
		await mkdir(join(dir, "vendor", "lib"), { recursive: true });
		await writeFile(
			join(dir, "vendor", "lib", "notes.md"),
			"see `git-vendored` for details\n",
			"utf8",
		);
		await writeFile(join(dir, "README.md"), "# Readme\n", "utf8");
		await commitAll(dir, "base");

		const scope: CorpusScope = {
			configFile: join(dir, "skillslurp.json"),
			baselineFile: join(dir, BASELINE_FILENAME),
			ignore: ["vendor/**"],
		};
		const scoped = createCapabilities(dir, async () => [], scope);
		expect(await scoped.grep(/git-vendored/)).toEqual([]);

		const unscoped = createCapabilities(dir, async () => []);
		expect(
			(await unscoped.grep(/git-vendored/)).map((hit) => hit.file),
		).toEqual(["vendor/lib/notes.md"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * A path the ignore list does NOT match is still scanned, with an ignore list present — the
 * other half of the `ignore` scoping, and what separates "honours `ignore`" from "drops the corpus whenever an
 * `ignore` list is non-empty". Also pins that the pattern is matched relative to the REPO root,
 * not anchored loosely: `vendor/**` must not swallow `docs/vendor/notes.md`.
 */
test("grep: an ignore list does not exclude paths it does not match, and is repo-root-relative", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-ignore-neg-"),
	);
	try {
		await initRepo(dir);
		await mkdir(join(dir, "docs", "vendor"), { recursive: true });
		await writeFile(
			join(dir, "docs", "vendor", "notes.md"),
			"see `git-vendored` for details\n",
			"utf8",
		);
		await commitAll(dir, "base");

		const scope: CorpusScope = {
			configFile: join(dir, "skillslurp.json"),
			baselineFile: join(dir, BASELINE_FILENAME),
			ignore: ["vendor/**"],
		};
		const caps = createCapabilities(dir, async () => [], scope);
		expect((await caps.grep(/git-vendored/)).map((hit) => hit.file)).toEqual([
			"docs/vendor/notes.md",
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * `normalizeIgnorePattern` (context.ts) exists so an `ignore` pattern excludes the same paths
 * from the scan corpus as tinyglobby excludes from discovery, and its two steps are asserted here
 * with a pattern that is discriminating for each — measured against picomatch 4.0.7 directly on
 * 2026-09-05, `{ dot: true, posix: true }`, the options the corpus matcher uses:
 *
 * - `"vendor/**\/"` matches `vendor/notes.md` only AFTER the trailing slash is stripped (`false`
 *   raw, `true` as `"vendor/**"`).
 * - `"vendor/.\/**"` matches it only AFTER `posix.normalize` collapses the `.` segment (`false`
 *   raw, `true` as `"vendor/**"`).
 *
 * Delete either step and the corresponding half of this test reports the hit it should have
 * excluded — which is the real-world failure mode: one `ignore:` list quietly meaning one thing
 * to discovery and another to the scan.
 */
test("grep: an ignore pattern is normalized the way tinyglobby normalizes discovery's (trailing slash, and `.` segments)", async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-context-grep-ignore-norm-"),
	);
	try {
		await initRepo(dir);
		await mkdir(join(dir, "vendor"), { recursive: true });
		await writeFile(
			join(dir, "vendor", "notes.md"),
			"see `git-vendored` for details\n",
			"utf8",
		);
		await commitAll(dir, "base");

		const configFile = join(dir, "skillslurp.json");
		const baselineFile = join(dir, BASELINE_FILENAME);
		for (const pattern of ["vendor/**/", "vendor/./**"]) {
			const scope: CorpusScope = {
				configFile,
				baselineFile,
				ignore: [pattern],
			};
			const caps = createCapabilities(dir, async () => [], scope);
			expect([pattern, await caps.grep(/git-vendored/)]).toEqual([pattern, []]);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// isIgnored() — the same matcher the corpus uses, exposed per path
// ---------------------------------------------------------------------------

/**
 * `createCapabilities`'s `scope` is optional, so `isIgnored` has to answer SOMETHING for the
 * several dozen scope-less call sites in this repo's tests, and that answer is `false` for every
 * path — "no scope" means "no `ignore` list to honour", the same widest-corpus posture `grep`
 * already takes. Asserted against paths `DEFAULT_IGNORE` itself would match, since those are the
 * ones a reader is most likely to assume are excluded unconditionally: they are not, because
 * `DEFAULT_IGNORE` reaches a run through `ResolvedConfig.ignore` and therefore through `scope`.
 *
 * No filesystem and no git: `isIgnored` is a pure pattern match over a path string against a
 * matcher compiled once per run, which is why a rule can afford to ask it per tracked path.
 */
test("isIgnored: a capability set built with no scope ignores nothing", () => {
	const caps = createCapabilities("/repo", async () => []);

	for (const path of [
		"node_modules/left-pad/index.js",
		"skills/widgets/node_modules/x.js",
		".git/config",
		"vendor/lib/notes.md",
		"skills/widgets/SKILL.md",
		"",
	]) {
		expect([path, caps.isIgnored(path)]).toEqual([path, false]);
	}
});

/**
 * The control the case above needs to be worth anything: the SAME paths, with a scope, get the
 * answers the corpus would give them — including that the patterns are matched relative to the
 * REPO root (`vendor/**` excludes `vendor/lib/notes.md` and leaves `docs/vendor/notes.md` alone,
 * exactly as the `grep` case above asserts for the corpus) and that the list is taken as handed
 * over, `DEFAULT_IGNORE` included only because a real `ResolvedConfig.ignore` has already merged
 * it in.
 */
test("isIgnored: with a scope, it answers exactly what the corpus matcher answers", () => {
	const caps = createCapabilities("/repo", async () => [], {
		configFile: "/repo/skillslurp.json",
		baselineFile: join("/repo", BASELINE_FILENAME),
		ignore: ["vendor/**", "**/node_modules/**"],
	});

	expect(
		[
			"vendor/lib/notes.md",
			"skills/widgets/node_modules/x.js",
			"docs/vendor/notes.md",
			"skills/widgets/SKILL.md",
		].map((path) => [path, caps.isIgnored(path)]),
	).toEqual([
		["vendor/lib/notes.md", true],
		["skills/widgets/node_modules/x.js", true],
		["docs/vendor/notes.md", false],
		["skills/widgets/SKILL.md", false],
	]);
});
