import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	applyBaseline,
	BASELINE_FILENAME,
	type Baseline,
	BaselineError,
	buildBaseline,
	loadBaseline,
	normalizeMessage,
	serializeBaseline,
} from "./baseline.js";
import type { Diagnostic } from "./diagnostic.js";
import { DOCS_URL } from "./diagnostic.js";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-baseline-unit-"));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		ruleId: "test/rule",
		severity: "error",
		message: "something",
		file: "a.md",
		fixable: false,
		docsUrl: DOCS_URL,
		...overrides,
	};
}

test("normalizeMessage: every RUN of ASCII digits collapses to a single #", () => {
	expect(normalizeMessage("a1b22c")).toBe("a#b#c");
	// The reason it is `\d+` and not `\d`: a file crossing from 99 to 100 lines must not change
	// its own key.
	expect(normalizeMessage("File has 99 lines, over the limit of 500")).toBe(
		normalizeMessage("File has 100 lines, over the limit of 500"),
	);
	// Nothing but digits is touched — a message is otherwise matched literally.
	expect(normalizeMessage("no digits here")).toBe("no digits here");
});

test("serializeBaseline: sorted bytewise at all three levels, 2-space indent, one trailing newline", () => {
	// Deliberately unsorted at every level, and with keys that a plain `JSON.stringify` would
	// reorder on its own: `10` and `9` are integer-like, so an object would hand them back
	// numerically (9 before 10) where bytewise order is "10" before "9".
	const baseline: Baseline = {
		version: 1,
		files: new Map([
			["9", new Map([["z/rule", new Map([["only one", 1]])]])],
			[
				"10",
				new Map([
					[
						"b/rule",
						new Map([
							["second message", 2],
							["first message", 1],
						]),
					],
					["a/rule", new Map([["only", 3]])],
				]),
			],
		]),
	};

	expect(serializeBaseline(baseline)).toBe(`{
  "version": 1,
  "files": {
    "10": {
      "a/rule": {
        "only": 3
      },
      "b/rule": {
        "first message": 1,
        "second message": 2
      }
    },
    "9": {
      "z/rule": {
        "only one": 1
      }
    }
  }
}
`);
});

test("serializeBaseline: an empty baseline is still valid, parseable JSON", () => {
	const text = serializeBaseline(buildBaseline([]));
	expect(JSON.parse(text)).toEqual({ version: 1, files: {} });
	expect(text.endsWith("}\n")).toBe(true);
});

test("buildBaseline: one key per (file, ruleId, normalized message), counting occurrences", () => {
	const baseline = buildBaseline([
		diagnostic({ message: "File has 10 lines", line: 1 }),
		diagnostic({ message: "File has 20 lines", line: 2 }),
		diagnostic({ message: "other", file: "b.md" }),
	]);

	expect(JSON.parse(serializeBaseline(baseline))).toEqual({
		version: 1,
		files: {
			"a.md": { "test/rule": { "File has # lines": 2 } },
			"b.md": { "test/rule": { other: 1 } },
		},
	});
});

// `serializeBaseline` refuses to produce a string a `__proto__` key can hide in, at
// each of the three levels. Built via `buildBaseline` from a diagnostic, like the write path
// (`run.ts`) actually does — a hand-built `Baseline` would test `serializeBaseline` in isolation,
// but the diagnostic route is what a real `--update-baseline` run would feed it.
test("serializeBaseline: refuses a `__proto__` file key rather than writing it", () => {
	const baseline = buildBaseline([diagnostic({ file: "__proto__" })]);
	expect(() => serializeBaseline(baseline)).toThrow(BaselineError);
	expect(() => serializeBaseline(baseline)).toThrow(
		'baseline cannot record file "__proto__": the key is not representable in skillslurp-baseline.json',
	);
});

test("serializeBaseline: refuses a `__proto__` rule id rather than writing it", () => {
	const baseline = buildBaseline([diagnostic({ ruleId: "__proto__" })]);
	expect(() => serializeBaseline(baseline)).toThrow(BaselineError);
	expect(() => serializeBaseline(baseline)).toThrow(
		'baseline cannot record rule id "__proto__": the key is not representable in skillslurp-baseline.json',
	);
});

test("serializeBaseline: refuses a `__proto__` message rather than writing it", () => {
	// `normalizeMessage` only touches digit runs, so "__proto__" reaches the key unchanged.
	const baseline = buildBaseline([diagnostic({ message: "__proto__" })]);
	expect(() => serializeBaseline(baseline)).toThrow(BaselineError);
	expect(() => serializeBaseline(baseline)).toThrow(
		'baseline cannot record message "__proto__": the key is not representable in skillslurp-baseline.json',
	);
});

test("loadBaseline: a `__proto__` file key is refused, not silently dropped", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, BASELINE_FILENAME),
			`{
  "version": 1,
  "files": {
    "__proto__": { "polluted/rule": { "pwned": 1 } },
    "a.md": { "test/rule": { "something": 1 } }
  }
}
`,
			"utf8",
		);

		const err = await loadBaseline(dir).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(BaselineError);
		const message = err instanceof Error ? err.message : String(err);
		expect(message).toBe(
			'invalid "skillslurp-baseline.json": files["__proto__"]: the key "__proto__" cannot be represented in a baseline',
		);

		// Rejected before anything downstream could touch it, but the probe stays as a belt: it
		// is what the pre-fix version of this test asserted, and it must keep passing.
		const probe: Record<string, unknown> = {};
		expect(probe.polluted).toBeUndefined();
		expect("polluted/rule" in probe).toBe(false);
		expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
		expect(Object.hasOwn(Object.prototype, "polluted/rule")).toBe(false);
	});
});

test("loadBaseline: a `__proto__` rule-id key is refused, naming its position", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, BASELINE_FILENAME),
			`{
  "version": 1,
  "files": {
    "a.md": { "__proto__": { "pwned": 1 } }
  }
}
`,
			"utf8",
		);

		await expect(loadBaseline(dir)).rejects.toThrow(BaselineError);
		await expect(loadBaseline(dir)).rejects.toThrow(
			'invalid "skillslurp-baseline.json": files["a.md"]["__proto__"]: the key "__proto__" cannot be represented in a baseline',
		);
	});
});

test("loadBaseline: a `__proto__` message key is refused, naming its position", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, BASELINE_FILENAME),
			`{
  "version": 1,
  "files": {
    "a.md": { "test/rule": { "__proto__": 1 } }
  }
}
`,
			"utf8",
		);

		await expect(loadBaseline(dir)).rejects.toThrow(BaselineError);
		await expect(loadBaseline(dir)).rejects.toThrow(
			'invalid "skillslurp-baseline.json": files["a.md"]["test/rule"]["__proto__"]: the key "__proto__" cannot be represented in a baseline',
		);
	});
});

test("loadBaseline: `constructor` (no `__proto__` sibling) still loads as an ordinary key", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, BASELINE_FILENAME),
			`{
  "version": 1,
  "files": {
    "constructor": { "c/rule": { "message": 2 } },
    "a.md": { "test/rule": { "something": 1 } }
  }
}
`,
			"utf8",
		);

		const baseline = await loadBaseline(dir);
		if (baseline === undefined) {
			throw new Error("baseline should have loaded");
		}

		// Pinned as MEASURED, not as expected: `constructor` survives `z.record` as an ordinary
		// key (unlike `__proto__`, which the guard above now refuses outright). A version bump
		// that changes that has to change this test on its way through.
		expect([...baseline.files.keys()].sort()).toEqual(["a.md", "constructor"]);

		// Nothing reached Object.prototype, through the JSON parse or through the copy into
		// Maps (`Object.entries`, own enumerable keys only).
		const probe: Record<string, unknown> = {};
		expect(probe.message).toBeUndefined();
		expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);

		// And the whole thing still applies, rather than throwing on the odd key.
		const applied = applyBaseline(
			[diagnostic({ message: "something" })],
			baseline,
			{ checkStale: true },
		);
		expect(applied.kept).toEqual([]);
		expect(applied.suppressedCount).toBe(1);
		expect(applied.stale.map((d) => d.message)).toEqual([
			'Baseline entry for rule "c/rule" in "constructor" expects 2 occurrence(s) but 0 remain — run `skillslurp --update-baseline` to prune it',
		]);
	});
});

test("loadBaseline: a missing file is `undefined`, not an error", async () => {
	await withDir(async (dir) => {
		expect(await loadBaseline(dir)).toBeUndefined();
	});
});

test("loadBaseline: a directory where the baseline file should be is a BaselineError naming it", async () => {
	await withDir(async (dir) => {
		await mkdir(join(dir, BASELINE_FILENAME));
		// Not swallowed as "no baseline": a path that exists and cannot be read is a reason to
		// stop, not to lint as though the user had never written one. Refused by the
		// regular-file guard now, ahead of the read that used to produce a bare `EISDIR` —
		// hence the message, which no longer quotes an errno back at the operator.
		await expect(loadBaseline(dir)).rejects.toThrow(BaselineError);
		await expect(loadBaseline(dir)).rejects.toThrow(
			'refusing to read "skillslurp-baseline.json": it is a directory, not a regular file',
		);
	});
});

/**
 * Whether this machine has a `mkfifo` binary on PATH — false on a platform without one (e.g.
 * Windows). The FIFO test below needs a REAL named pipe to reproduce the hang it guards against
 * (there is no portable, dependency-free way to make one from Node), and the probe's own absence
 * must not be mistaken for the fix passing. Same probe context.test.ts already carries for its
 * FIFO test.
 */
const MKFIFO_AVAILABLE = await (async () => {
	const dir = await mkdtemp(
		join(tmpdir(), "skillslurp-baseline-mkfifo-probe-"),
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
 * The read half of the symlink posture `writeBaselineFile` already had on the write half.
 * `skillslurp-baseline.json` is a name the REPOSITORY chooses, so `git clone <untrusted> &&
 * skillslurp .` — no flags — used to follow it: measured 2026-09-06, a link to a credentials
 * file came back as `"skillslurp-baseline.json" is not valid JSON: Unexpected token 'A',
 * "AKIAIOSFOD"...`, and a link to a service-account JSON came back with every top-level key
 * named in `Unrecognized keys: ...`, straight into the CI log.
 *
 * The target's content is asserted absent, not merely the error asserted present: a guard that
 * refused the link but still quoted the parse failure would pass a message-only assertion.
 */
test("loadBaseline: a symlinked baseline is refused, and nothing from the target is echoed", async () => {
	await withDir(async (dir) => {
		const secret = join(dir, "secret.txt");
		await writeFile(secret, "SLURPSECRET-do-not-echo\n", "utf8");
		await symlink(secret, join(dir, BASELINE_FILENAME));

		const err = await loadBaseline(dir).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(BaselineError);
		const message = err instanceof Error ? err.message : String(err);
		expect(message).toBe(
			'refusing to read "skillslurp-baseline.json": it is a symbolic link, and following it would read outside the path you asked to lint',
		);
		// The whole chain, not just the top message: `BaselineError` elsewhere carries a `cause`
		// that `formatError` renders, and a cause here would put the target's bytes back on
		// stderr through the back door.
		expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(
			"SLURPSECRET",
		);
	});
});

/**
 * The denial-of-service half, and the reason the guard is `!isFile()` rather than "not a
 * symlink": a FIFO with no writer blocks `readFile` forever. Measured 2026-09-06 on a plain run
 * against a repository carrying one, the process was still blocked at 15s and had to be
 * SIGKILLed — an indefinite CI hang expressible purely as repository content.
 *
 * The 5s per-test timeout is the point of the test as much as the assertion is: a regression
 * fails this one test loudly instead of hanging the suite (verified: bun aborts a test blocked
 * on a FIFO read at its timeout).
 */
/**
 * Releases a reader blocked on `fifo`, if there is one. Opening the write end with `O_NONBLOCK`
 * succeeds only when something IS blocked on the read end (`ENXIO` otherwise), and closing it
 * immediately sends that reader EOF. Never rejects: it is called from a timer.
 */
async function releaseFifoReader(fifo: string): Promise<void> {
	try {
		const handle = await open(
			fifo,
			fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
		);
		await handle.close();
	} catch {
		// no reader waiting, which is the green case
	}
}

test.skipIf(!MKFIFO_AVAILABLE)(
	"loadBaseline: a FIFO at the baseline path is refused rather than blocking forever",
	async () => {
		await withDir(async (dir) => {
			const fifo = join(dir, BASELINE_FILENAME);
			await promisify(execFileCb)("mkfifo", [fifo]);
			/**
			 * A watchdog, not just the test timeout, because a timeout cannot clean up: bun abandons the
			 * timed-out async function, so its `finally` never runs and the blocked `readFile` keeps the
			 * event loop alive — `bun test` prints the failure and then never exits, which is the "hangs the
			 * suite" outcome this test exists to prevent. Firing releases the leak AND records that there was
			 * one, so the regression fails on `blocked` even if some future refactor made the message match.
			 */
			let blocked = false;
			const watchdog = setTimeout(() => {
				blocked = true;
				void releaseFifoReader(fifo);
			}, 2_000);
			try {
				await expect(loadBaseline(dir)).rejects.toThrow(
					'refusing to read "skillslurp-baseline.json": it is not a regular file',
				);
			} finally {
				clearTimeout(watchdog);
			}
			expect(blocked).toBe(false);
		});
	},
	5_000,
);

/** And the guard must not have turned an ordinary baseline file into a refusal. */
test("loadBaseline: a real regular file at the baseline path still loads", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, BASELINE_FILENAME),
			JSON.stringify({
				version: 1,
				files: { "a.md": { "test/rule": { something: 1 } } },
			}),
			"utf8",
		);

		const baseline = await loadBaseline(dir);

		expect(
			baseline?.files.get("a.md")?.get("test/rule")?.get("something"),
		).toBe(1);
	});
});

test("applyBaseline: checkStale: false leaves every unmatched entry silent (the --diff-base posture)", () => {
	const baseline = buildBaseline([diagnostic(), diagnostic()]);

	const withGuard = applyBaseline([diagnostic()], baseline, {
		checkStale: true,
	});
	const without = applyBaseline([diagnostic()], baseline, {
		checkStale: false,
	});

	expect(withGuard.stale).toHaveLength(1);
	expect(without.stale).toEqual([]);
	// Suppression itself is unaffected by the flag — only the guard is.
	expect(without.kept).toEqual([]);
	expect(without.suppressedCount).toBe(1);
});
