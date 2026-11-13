/**
 * RuleTester.
 *
 * Runs a `FileRule`/`ProjectRule`/`ScanRule`/`ShapeRule`'s test cases through the real engine
 * (`runEngine`), not through `rule.check` directly. Each case materializes a temp dir from an
 * inline `files` map, builds a hand-written `ResolvedConfig` carrying one synthesized
 * `ResolvedSurface`, and calls `runEngine(config, [spyRule])`, where `spyRule` wraps the rule
 * under test to record whether `check` ran at all — and, for a `FileRule`, which document it
 * ran on. A case that needs git (`needsGit`, defaulting to `rule.kind !== "file"`) additionally
 * `git init`s the temp dir and commits every written file and symlink before the engine runs, so
 * the rule under test can call `ctx.git`/`ctx.grep` against a real (if minimal) checkout — see
 * `gitInitAndCommit` below — and `worktree` then changes the checkout AFTER that commit, leaving
 * the changes uncommitted. A `shape` rule is configured in the top-level `rules` only (never on
 * the surface) and must run exactly once, even over a case with no documents. A rule whose
 * kind is none of the four is rejected, both by the type and
 * again at runtime (`assertTestableKind`): see that function's own doc for why the type alone
 * is not enough.
 *
 * Why go through the engine instead of calling `rule.check` directly: `resolveEnabledBySurface`
 * (engine.ts) is the one place that resolves a file/project/scan rule's options and severity per
 * (rule, surface) — `resolveRepoRules` does the same once per run for a shape rule —
 * `deepFreeze`s the resolved options, and it is discovery (discover.ts) plus `readDocument`
 * (document.ts) that thread `doc.surface` and produce the deterministic per-document,
 * per-diagnostic ordering a rule test relies on. A tester that reimplemented any slice of that
 * merge locally could drift from the engine's own behavior — exactly the class of bug the
 * engine's own JSDoc warns a second implementation would reintroduce. Going through `runEngine`
 * means a rule test exercises the rule under the exact resolution the CLI itself uses, never a
 * tester-local approximation of it.
 *
 * Why not a real `skillslurp.json` + `loadConfig`: `loadConfig`'s only value beyond a
 * hand-built `ResolvedConfig` is reporting yaml *positions* for a config mistake — no rule test
 * asserts on a config-file position, only on a rule's own diagnostics — plus dropping a rule set
 * to `off` from `rules`, which a hand-built config never contains (`assertShapeSeverity` refuses
 * an `off` shape case for that reason). A hand-built `ResolvedConfig` is also exactly the shape
 * engine.ts's own JSDoc blesses for a caller that
 * skips `loadConfig` (its loc-less options-validation backstop exists specifically for such a
 * caller), so this module leans on that contract instead of adding a config-writing step that
 * would buy nothing a rule test needs.
 *
 * `bun:test` imports (`describe`, `test`, `expect`) are used in this file even though it lives
 * in `src/`: `bun build src/cli.ts` (the `build` script) bundles from the CLI entry point only,
 * so nothing that is not reachable from `cli.ts` — this module included — ends up in `dist`.
 * `tsc`'s `include` is all of `src`, so this file is still typechecked to the same strict,
 * no-`any` bar as shipped code; it just never ships.
 */

import { describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
	CONFIG_FILENAME,
	DEFAULT_IGNORE,
	freezeSurface,
	type ResolvedConfig,
	type ResolvedRule,
	type ResolvedSpoke,
	type ResolvedSurface,
	sealMap,
} from "../config.js";
import type { RuleContext } from "../context.js";
import type { Diagnostic, Severity } from "../diagnostic.js";
import {
	BUILTIN_DIALECTS,
	type DialectId,
	defaultInclude,
	dialectsSupportingKind,
	type SurfaceKind,
} from "../dialects.js";
import { discoverFiles } from "../discover.js";
import { CONFIG_REPORT_NAMESPACE, runEngine } from "../engine.js";
import { runGit } from "../git.js";
import { pathKey } from "../paths.js";
import type {
	FileRule,
	ProjectRule,
	Report,
	Rule,
	ScanRule,
	ShapeRule,
} from "../rule.js";

/**
 * Changes applied to the checkout AFTER the fixture commit and left uncommitted, in this order:
 * `remove`, then `files`, then `symlinks` — so `remove` plus `symlinks` on one path swaps a
 * tracked file for an uncommitted link. Needs git (the commit is what it is applied after).
 */
export interface WorktreeChanges {
	/** repo-relative posix path -> content; untracked unless the path is already tracked */
	files?: Readonly<Record<string, string>>;
	/** repo-relative posix path -> link target text, exactly as `ln -s` would take it */
	symlinks?: Readonly<Record<string, string>>;
	/** repo-relative posix paths of tracked files or links to delete from disk (never directories) */
	remove?: readonly string[];
}

export interface RuleTestCase {
	name: string;
	/** repo-relative posix path -> file content; parent dirs are created */
	files: Readonly<Record<string, string>>;
	/**
	 * repo-relative posix path -> link target text, exactly as `ln -s` would take it. Created after
	 * `files` and before the fixture commit, so git records each one as a symlink (mode 120000).
	 * The path must be inside the temp dir; the TARGET may be dangling or point anywhere — a link
	 * is only text, nothing is ever created at its target.
	 */
	symlinks?: Readonly<Record<string, string>>;
	worktree?: WorktreeChanges;
	/**
	 * Raw options blob exactly as a user would write it in config yaml; validated through the
	 * rule's own `optionsSchema` by the engine, same as a real run.
	 */
	options?: unknown;
	/** default: rule.meta.defaultSeverity */
	severity?: Severity;
	/**
	 * The TOP-LEVEL `ignore:` list, merged with `DEFAULT_IGNORE` exactly as `loadConfig` merges a
	 * real one — distinct from `surface.ignore` below, which is this surface's own list, and
	 * distinct in READING too: the top-level list reaches the scan corpus and
	 * `Capabilities.isIgnored` matched relative to the REPO root, while discovery matches both
	 * lists relative to the SURFACE root (`CorpusScope.ignore` has the full account of that
	 * asymmetry). A case that means "do not discover this file" wants `surface.ignore`; a case
	 * that means "this path is not the linter's business at all" wants this.
	 *
	 * Omitted, a case gets `DEFAULT_IGNORE` alone.
	 */
	ignore?: readonly string[];
	surface?: {
		/** default "." */
		root?: string;
		/** default "skills" */
		kind?: SurfaceKind;
		/** default ["generic"] */
		dialects?: readonly DialectId[];
		/** default defaultInclude(kind, dialects) */
		include?: readonly string[];
		/** default [] */
		ignore?: readonly string[];
		/**
		 * Spokes declared on the surface, repo-relative posix, in this order. Each carries a
		 * synthetic `loc`, which is what marks a spoke as written by the user in a config.
		 * Default [].
		 */
		spokes?: readonly string[];
		/**
		 * Spokes WITHOUT a `loc`, as a surface nobody wrote in a config would carry them: listed
		 * after `spokes`. Default [].
		 */
		undeclaredSpokes?: readonly string[];
	};
	/**
	 * Opt-in: this case's documents are expected to produce diagnostics not produced by the rule
	 * under test (today, the only such diagnostic is `parse/frontmatter`: the registry a case
	 * runs against is exactly `[the rule under test]`, so any diagnostic carrying a different
	 * `ruleId` is an engine pseudo-rule by construction, not a second rule under test), so those
	 * diagnostics become assertable instead of failing the case.
	 *
	 * At least one document must still be clean. The engine skips every file rule on a document
	 * whose frontmatter failed to parse, so a case where ALL documents are broken never invokes
	 * the rule at all and stops on the "never invoked" guard below — a real limitation, not a
	 * bug: there is nothing about the rule left for such a case to prove.
	 */
	expectParseErrors?: boolean;
	/**
	 * Whether this case's temp directory becomes an ephemeral git repository — `git init` plus
	 * one commit of everything `files` and `symlinks` wrote — before the engine runs. The fixture
	 * must not pre-create a `.git` entry of its own: the harness refuses one (`assertNoFixtureGit`).
	 *
	 * Default: `rule.kind !== "file"`. `project`/`scan`/`shape` rules exist to ask repository-wide
	 * questions, so they need the repo by construction; the hundreds of `file`-rule cases
	 * in this repo do not, and three subprocesses apiece is not a cost to pay for nothing.
	 *
	 * That default is not the whole truth, which is why this is an explicit
	 * option rather than a `kind` check hidden inside `runCase`: `links/resolve` is a `file` rule
	 * that resolves every target against `ctx.git.trackedFileIndex()`, so its cases set
	 * `needsGit: true` (once, on the suite — see `RuleTestCases.needsGit`). Setting it `false` on
	 * a `project`/`scan`/`shape` case is equally allowed and is how a case proves what happens when
	 * the checkout is missing.
	 *
	 * A case that opts in also opts into a real behavioural consequence, not just a slower setup:
	 * only what `files` and `symlinks` write is committed, so a fixture cannot rely on anything
	 * else being present, and any rule reading the index sees exactly that set.
	 */
	needsGit?: boolean;
}

/** A case with no `errors` — the engine must produce zero diagnostics for it. */
export type ValidCase = RuleTestCase;

export interface ExpectedDiagnostic {
	message: string;
	line?: number;
	col?: number;
	endLine?: number;
	endCol?: number;
	/** defaults to the single discovered document; required when a case discovers more than one */
	file?: string;
	/** default: rule.meta.id */
	ruleId?: string;
	/** default: the case's resolved severity (`severity` override, else rule.meta.defaultSeverity) */
	severity?: Severity;
	/** default: rule.meta.fixable */
	fixable?: boolean;
}

export interface InvalidCase extends RuleTestCase {
	errors: readonly ExpectedDiagnostic[];
}

export interface RuleTestCases {
	readonly valid: readonly ValidCase[];
	readonly invalid: readonly InvalidCase[];
	/**
	 * `RuleTestCase.needsGit` for every case in this suite that does not state its own — because
	 * "does this rule read git" is a fact about the RULE, and repeating it on every one of
	 * `links/resolve`'s cases would mean a newly added case silently forgets it and fails for a
	 * reason that has nothing to do with what it was written to prove.
	 */
	readonly needsGit?: boolean;
}

/**
 * The kinds `RuleTester` accepts: `file`, `project`, `scan` and `shape` —
 * every `Rule<O>` member. The union is kept as its own type so a future kind stays unsupported
 * until it is added here on purpose; see `assertTestableKind` for the runtime half.
 */
type TestableRule<O = unknown> =
	| FileRule<O>
	| ProjectRule<O>
	| ScanRule<O>
	| ShapeRule<O>;

/**
 * Runtime backstop for the kind restriction `TestableRule<O>` already encodes at the type level.
 * A type-checked caller can never construct a call that reaches the `throw` below — passing a
 * rule of a kind outside `TestableRule<O>` is a compile error before this function ever runs.
 * But `Readonly<T>` being "a type, not a lock" (AGENTS.md) applies here too:
 * a cast, or a caller with no type checker at all (a plain JS consumer of this module, or some
 * future dynamic-import-based rule loader), can still hand this function a rule the type system
 * would have rejected, and it must fail loudly rather than be tested as if supported. Checked
 * again here for the same reason `RuleMeta.optionsSchema` is validated by both `loadConfig`
 * (positioned) and the engine itself (a backstop, per that field's own doc): a broken first
 * layer must not leave zero layers standing.
 *
 * Takes `Rule<O>`, the same four-kind union as `TestableRule<O>`, and compares a `string`-widened
 * `kind`: the union is exhaustive, so a comparison on `rule.kind` itself would be provably
 * unreachable to the type checker.
 */
function assertTestableKind<O>(rule: Rule<O>): void {
	// Widened to `string`: every `Rule<O>` kind is testable now, so comparing `rule.kind` itself
	// would narrow `rule` to `never` inside the throw.
	const kind: string = rule.kind;
	if (
		kind !== "file" &&
		kind !== "project" &&
		kind !== "scan" &&
		kind !== "shape"
	) {
		throw new Error(
			`rule "${rule.meta.id}": RuleTester only supports "file", "project", "scan" and "shape" rules — "${kind}" rules are not supported yet`,
		);
	}
}

/**
 * `resolveRepoRules` (engine.ts) takes a shape rule's severity verbatim, with no `off` gate of its
 * own: `loadConfig` never leaves an `off` entry in `ResolvedConfig.rules`, so a hand-built config
 * that did would run the rule and report at a severity no real run can produce. The other kinds
 * go through `resolveEnabledBySurface`, which skips `off` and trips the "never invoked" guard
 * instead. The string widening mirrors `assertTestableKind`: the cast this catches is exactly
 * what the type forbids.
 */
function assertShapeSeverity<O>(rule: Rule<O>, testCase: RuleTestCase): void {
	if (rule.kind !== "shape") {
		return;
	}
	const severity: string = testCase.severity ?? rule.meta.defaultSeverity;
	if (severity !== "error" && severity !== "warn") {
		throw new Error(
			`rule "${rule.meta.id}", case "${testCase.name}": severity "${severity}" is not "error" or "warn" — the engine runs a "shape" rule at whatever its resolved entry says and does not treat "off" as disabled, while a real config drops an "off" rule before it gets there`,
		);
	}
}

/**
 * The shape both an actual `Diagnostic` and an `ExpectedDiagnostic` are normalized into before
 * comparison. `docsUrl` is deliberately absent: it is a meta-level fact about the rule (or the
 * engine's own `parse/frontmatter` pseudo-rule), already covered by a rule's own meta tests, not
 * something every single rule-test case should have to restate to avoid a spurious mismatch.
 *
 * Every positional field is a REQUIRED key holding `number | undefined`, not an optional key,
 * and each side reads its own source directly (`toComparable` from the `Diagnostic`,
 * `normalizeExpected` from the `ExpectedDiagnostic`) rather than through one shared copy helper.
 * That is deliberate and load-bearing: bun's `toEqual` ignores an own key whose value is
 * `undefined`, so a shared helper that dropped a field — say `col` — would drop it from BOTH
 * sides and every `col` assertion in every rule test built on this harness would pass
 * vacuously, self-cancelling exactly the way AGENTS.md's "tests that passed for the wrong
 * reason" habit warns about (an earlier draft of this file had that shape, and stripping `col`
 * from it kept the whole suite green). With two independent reads, any correct invalid case that
 * asserts a position is itself the guard: break either read and that case fails.
 */
interface ComparableDiagnostic {
	ruleId: string;
	severity: Severity;
	message: string;
	file: string;
	line: number | undefined;
	col: number | undefined;
	endLine: number | undefined;
	endCol: number | undefined;
	fixable: boolean;
}

function toComparable(d: Diagnostic): ComparableDiagnostic {
	return {
		ruleId: d.ruleId,
		severity: d.severity,
		message: d.message,
		file: d.file,
		line: d.line,
		col: d.col,
		endLine: d.endLine,
		endCol: d.endCol,
		fixable: d.fixable,
	};
}

/**
 * Rejects every path key a case hands the tester that would land outside the temp dir (absolute,
 * or escaping via `..`) or that no filesystem call accepts (a NUL byte) — `files`, `symlinks` and
 * everything under `worktree` — and a fixture with
 * nothing in it. The tester writes straight to disk from these keys, so a typo has to fail loudly
 * here rather than silently write somewhere the case did not intend. A symlink TARGET is never
 * checked: a link is only text, and a test may need one that dangles or escapes.
 */
function assertSafeFiles(ruleId: string, testCase: RuleTestCase): void {
	const where = `rule "${ruleId}", case "${testCase.name}"`;
	const symlinks = testCase.symlinks ?? {};
	if (
		Object.keys(testCase.files).length === 0 &&
		Object.keys(symlinks).length === 0
	) {
		throw new Error(
			`${where}: "files" must not be empty (a case with no "files" needs at least one "symlinks" entry)`,
		);
	}
	const worktree = testCase.worktree ?? {};
	const groups: readonly (readonly [string, readonly string[]])[] = [
		["files key", Object.keys(testCase.files)],
		["symlinks key", Object.keys(symlinks)],
		["worktree.files key", Object.keys(worktree.files ?? {})],
		["worktree.symlinks key", Object.keys(worktree.symlinks ?? {})],
		["worktree.remove entry", worktree.remove ?? []],
	];
	for (const [label, keys] of groups) {
		for (const key of keys) {
			if (key.includes("\0")) {
				throw new Error(
					`${where}: ${label} ${JSON.stringify(key)} must not contain a NUL byte`,
				);
			}
			if (posix.isAbsolute(key)) {
				throw new Error(
					`${where}: ${label} "${key}" must be a repo-relative path, not absolute`,
				);
			}
			const normalized = posix.normalize(key);
			if (normalized === ".." || normalized.startsWith("../")) {
				throw new Error(
					`${where}: ${label} "${key}" escapes the temp dir via ".."`,
				);
			}
		}
	}
	assertDisjoint(where, "files", testCase.files, "symlinks", symlinks);
	assertDisjoint(
		where,
		"worktree.files",
		worktree.files ?? {},
		"worktree.symlinks",
		worktree.symlinks ?? {},
	);
}

function assertDisjoint(
	where: string,
	leftName: string,
	left: Readonly<Record<string, string>>,
	rightName: string,
	right: Readonly<Record<string, string>>,
): void {
	const taken = new Set(Object.keys(left).map((key) => posix.normalize(key)));
	for (const key of Object.keys(right)) {
		if (taken.has(posix.normalize(key))) {
			throw new Error(
				`${where}: "${key}" is listed in both "${leftName}" and "${rightName}" — a path is one or the other`,
			);
		}
	}
}

/**
 * Rejects a write whose path runs through a symlink already on disk (the leaf too, when
 * `includeLeaf`): `mkdir`/`writeFile`/`unlink` follow links, so a fixture link pointing outside the
 * temp dir would otherwise redirect a later write out of it.
 */
async function assertNoLinkOnPath(
	where: string,
	label: string,
	root: string,
	relPath: string,
	includeLeaf: boolean,
): Promise<void> {
	const segments = posix.normalize(relPath).split("/");
	let current = root;
	for (const segment of includeLeaf ? segments : segments.slice(0, -1)) {
		current = join(current, segment);
		const stats = await lstat(current).catch((err: unknown) => {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") {
				return undefined;
			}
			throw err;
		});
		if (stats === undefined) {
			return;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`${where}: ${label} "${relPath}" passes through a symlink — it would be written through the link, possibly outside the temp dir`,
			);
		}
	}
}

/**
 * Writes every entry of a path -> content map to disk, wrapping the underlying fs error (if any)
 * with the rule id, the case name and the offending key: `""`/`"."` (`EISDIR` — they resolve to
 * `root` itself, already a directory), `"SKILL.md/"` (`ENOENT` — no such directory), and two keys
 * where one is the other's parent (`EEXIST`) all otherwise fail with a bare errno a case author
 * has to reverse-engineer back to which key caused it. `guardLinks` is for writes made while
 * symlinks already exist (`worktree.files`); the plain `files` pass runs before any does.
 */
async function writeFileMap(
	where: string,
	label: string,
	root: string,
	files: Readonly<Record<string, string>>,
	guardLinks: boolean,
): Promise<void> {
	for (const [relPath, content] of Object.entries(files)) {
		if (guardLinks) {
			await assertNoLinkOnPath(where, label, root, relPath, true);
		}
		const target = join(root, relPath);
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
		} catch (err) {
			throw new Error(`${where}: failed to write ${label} "${relPath}"`, {
				cause: err,
			});
		}
	}
}

async function writeFiles(
	ruleId: string,
	testCase: RuleTestCase,
	root: string,
): Promise<void> {
	await writeFileMap(
		`rule "${ruleId}", case "${testCase.name}"`,
		"files key",
		root,
		testCase.files,
		false,
	);
}

async function writeSymlinkMap(
	where: string,
	label: string,
	root: string,
	links: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [relPath, linkTarget] of Object.entries(links)) {
		await assertNoLinkOnPath(where, label, root, relPath, false);
		const target = join(root, relPath);
		try {
			await mkdir(dirname(target), { recursive: true });
			await symlink(linkTarget, target);
		} catch (err) {
			throw new Error(`${where}: failed to create ${label} "${relPath}"`, {
				cause: err,
			});
		}
	}
}

/**
 * Applies `worktree` after the fixture commit: removals first, then files, then symlinks, so
 * `remove` plus `symlinks` on one path swaps a tracked file for an uncommitted link. `unlink`, not
 * `rm`: a directory entry fails instead of deleting a tree (or the temp root itself).
 */
async function applyWorktree(
	ruleId: string,
	testCase: RuleTestCase,
	root: string,
): Promise<void> {
	const worktree = testCase.worktree;
	if (worktree === undefined) {
		return;
	}
	const where = `rule "${ruleId}", case "${testCase.name}"`;
	for (const relPath of worktree.remove ?? []) {
		await assertNoLinkOnPath(
			where,
			"worktree.remove entry",
			root,
			relPath,
			false,
		);
		try {
			await unlink(join(root, relPath));
		} catch (err) {
			throw new Error(
				`${where}: failed to remove worktree.remove entry "${relPath}" — it must be an existing file or symlink, never a directory`,
				{ cause: err },
			);
		}
	}
	await writeFileMap(
		where,
		"worktree.files key",
		root,
		worktree.files ?? {},
		true,
	);
	await writeSymlinkMap(
		where,
		"worktree.symlinks key",
		root,
		worktree.symlinks ?? {},
	);
}

/**
 * A focused check, factored out so its failure message can be precise about what went wrong:
 * this is NOT "`root` is not a git checkout" (`toGitError`, git.ts, already owns that message
 * and that failure mode) — `root` at this point unquestionably *is* a checkout, since `git
 * init` immediately above just ran there without error. What this asks is a narrower, second
 * question: is it the checkout `gitInitAndCommit` believes it just created, or did that `git
 * init` land somewhere else entirely?
 *
 * `git rev-parse --absolute-git-dir` (git-rev-parse(1): "Like `--git-dir`, but its output is
 * always the canonicalized absolute path") is compared against `realpath(root)/.git`, not
 * `root/.git` unresolved: `--absolute-git-dir`'s own output already has every symlink resolved
 * (measured, 2026-09-04, on this machine's tmp layout: `/tmp/x/.git` reports as
 * `/private/tmp/x/.git`), so comparing it against an unresolved `root` would false-positive on
 * exactly the same macOS `/var` → `/private/var` symlink `runCase` already realpath's around
 * once, up front, before ever calling this function (see that call site). This function does
 * its own realpath anyway rather than trusting a caller to have done it — this check exists
 * precisely because "the caller already validated this" is the assumption the inherited-GIT_DIR
 * bug broke.
 *
 * A mismatch here is exactly the shape the inherited-GIT_DIR bug reproduced destructively: an
 * inherited `GIT_DIR`/`GIT_WORK_TREE` (or, without any environment variable at all, a stray
 * `.git` already present at `root` — e.g. a symlink into another repo, planted by whatever
 * created this temp dir) making every later `git` call in this function operate on the wrong
 * repository. `runGit`'s own env scrub (git.ts's `GIT_ENV_SCRUB_KEYS`) should already prevent
 * the environment-variable half of that from ever reaching here — this assertion is the second,
 * independent layer that does not need to trust the first one: it is the layer that would have
 * caught that bug before it ate a branch, and it still catches the non-environment half the
 * scrub was never able to address in the first place.
 */
async function assertGitDirMatchesRoot(root: string): Promise<void> {
	const buf = await runGit(root, ["rev-parse", "--absolute-git-dir"]);
	const actualGitDir = buf.toString("utf8").trim();
	const expectedGitDir = join(await realpath(root), ".git");
	if (actualGitDir !== expectedGitDir) {
		throw new Error(
			`gitInitAndCommit: refusing to "git add"/"git commit" into "${root}" — "git rev-parse --absolute-git-dir" resolved to "${actualGitDir}", not "${expectedGitDir}" (the repo this call just ran "git init" against). Aborting before this function writes anything, rather than committing into whatever repository "${actualGitDir}" names.`,
		);
	}
}

/**
 * Refuses a fixture that already has anything at `<root>/.git`, checked on the DISK with `lstat`
 * rather than on the key names so `.GIT` on a case-insensitive filesystem is caught too. A `.git`
 * symlink written by `symlinks` would otherwise redirect `git init`/`git add`/`git commit` into
 * whatever it points at, outside the temp dir — `assertGitDirMatchesRoot` only notices AFTER
 * `git init` has already written there. Lives in `runCase`, not in `gitInitAndCommit`, which
 * `rule-tester.test.ts` drives directly against a planted `.git` to prove that second layer.
 */
async function assertNoFixtureGit(where: string, root: string): Promise<void> {
	const present = await lstat(join(root, ".git")).then(
		() => true,
		(err: unknown) => {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") {
				return false;
			}
			throw err;
		},
	);
	if (present) {
		throw new Error(
			`${where}: the fixture wrote an entry at ".git" (via "files" or "symlinks", any casing on a case-insensitive filesystem) — the harness creates the repository itself, and a pre-existing one would redirect "git init" and "git commit" to wherever it points`,
		);
	}
}

/**
 * `git init`s `root` and commits every file and symlink the fixture just wrote to it — one
 * ephemeral git repository per case, so a case's rule can call `ctx.git`/`ctx.grep` against a
 * real (if minimal) checkout rather than against a stub the harness would have to keep honest.
 * Called from `runCase` for a case whose `needsGit` resolves true (default: `rule.kind !==
 * "file"`) — see that call site for why most `"file"` cases skip this entirely, and
 * `RuleTestCase.needsGit` for the one that does not.
 * Exported (only) so `rule-tester.test.ts` can drive it directly for its own "refuses to write
 * into the wrong repository" regression test, the same reason `runCase` below is exported — no
 * production caller reaches for this export.
 *
 * Reuses `runGit` (git.ts), not a second subprocess mechanism — one code path, two callers, by
 * design; `git.ts`'s own doc on `runGit` already names this function as its second caller. That
 * shared code path is also why the config-injection fix lives in `git.ts`, not here: `runGit`
 * now scrubs every git repo-location and config-injection environment variable
 * (`GIT_ENV_SCRUB_KEYS`) it might have inherited, for EVERY call below, unconditionally — this
 * function does not need to (and does not) repeat that list.
 *
 * `envOverrides` points `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at `/dev/null` (git ≥ 2.32,
 * this repo's own dev/CI baseline is 2.5x) for every call below, so none of them consults the
 * operator's own `~/.gitconfig` or a machine-wide `/etc/gitconfig` at all. Deliberate, not
 * merely convenient: this repo's own `user.name`/`user.email`/`commit.gpgsign` overrides just
 * below are LOCAL config and would already win over conflicting *values* for those three keys
 * in a global file — but a global file can also set `core.hooksPath` to a hook this harness
 * knows nothing about (a secret-scanner some organizations wire in globally, for one concrete
 * example), which would then run, unasked, on every temp repo this harness ever creates. Losing
 * every OTHER legitimate global setting along with it (e.g. a developer's own `core.editor`) is
 * an acceptable cost — nothing this function does is interactive, and nothing it does needs any
 * global setting at all — for a materialization step whose whole point is to be identical on
 * every machine, matching AGENTS.md's "output is deterministic" guardrail extended to this
 * harness's own test fixtures, not just to what `skillslurp` itself reports.
 *
 * `git add -A`, not a path list built from `testCase.files`: `assertSafeFiles` has already
 * vetted every key in that map, but handing the very same list to `git add` a second time would
 * only duplicate that vetting, not add to it, and `-A` from the repo root adds everything
 * `files` and `symlinks` just wrote and nothing else — nothing else exists in this temp dir yet.
 *
 * `-c core.hooksPath=` and `--no-verify` on the `commit` call only (belt-and-braces): of
 * the six git invocations in this function, `commit` is the only one that consults hooks at all
 * in stock git (`pre-commit`/`commit-msg`/`post-commit`) — `init`, `config` and `add` never do.
 * `runGit`'s env scrub should already stop a hostile `core.hooksPath` (via
 * `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`) or a hook-shipping template dir (via
 * `GIT_TEMPLATE_DIR`) from ever reaching this repo — these two flags are a second, independent
 * layer, same rationale as `assertGitDirMatchesRoot` above: assume the first layer has a gap.
 * Verified independently (2026-09-04), each against a real
 * `GIT_CONFIG_PARAMETERS="'core.hooksPath'='/tmp/evil-hooks'"` with a hook planted at
 * `/tmp/evil-hooks/pre-commit`: `-c core.hooksPath=` alone suppresses the hook, and
 * `--no-verify` alone also suppresses it — either flag independently defeats this specific
 * attack; kept together as the two do not overlap in what else they cover (`-c core.hooksPath=`
 * also blanks a *legitimately configured* hooksPath this harness has no business running,
 * `--no-verify` also skips a hook that reached `.git/hooks` some other way, e.g. copied in by a
 * template dir this scrub missed).
 */
export async function gitInitAndCommit(root: string): Promise<void> {
	const envOverrides = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
	await runGit(root, ["init", "--quiet", "-b", "main"], envOverrides);
	await assertGitDirMatchesRoot(root);
	await runGit(
		root,
		["config", "user.name", "skillslurp RuleTester"],
		envOverrides,
	);
	await runGit(
		root,
		["config", "user.email", "ruletester@skillslurp.invalid"],
		envOverrides,
	);
	await runGit(root, ["config", "commit.gpgsign", "false"], envOverrides);
	await runGit(root, ["add", "-A"], envOverrides);
	await runGit(
		root,
		[
			"-c",
			"core.hooksPath=",
			"commit",
			"--quiet",
			"--no-verify",
			"-m",
			"RuleTester fixture",
		],
		envOverrides,
	);
}

/**
 * Builds the case's one synthesized surface. No `loc` — nothing here was "written" by a user in
 * yaml, so discover.ts's `config/no-files` zero-match check opts out on the same basis a
 * zero-config auto-detected surface does (see discover.ts's own comment on that field); `runCase`
 * does its own, clearer emptiness check below instead. `rules: new Map()`: the rule under test's
 * severity/options live in `ResolvedConfig.rules`/`ruleOptions`, not in a per-surface override —
 * a case has exactly one surface and nothing to override.
 *
 * Rejects a surface a real config could never express: `loadConfig` requires `dialects` to be
 * non-empty (`SurfaceSchema`) and rejects any dialect with no contract for the surface's `kind`
 * (its own id-stage check in `loadConfig`) — a case that skipped both checks could pass here and
 * fail only at exit 2 for an actual user. Dialects are deduped the same way `loadConfig` resolves
 * them (`[...new Set(...)]`), so listing one twice changes nothing here either.
 */
function buildSurface(ruleId: string, testCase: RuleTestCase): ResolvedSurface {
	const input = testCase.surface ?? {};
	const kind: SurfaceKind = input.kind ?? "skills";
	const dialects: DialectId[] = [
		...new Set<DialectId>(input.dialects ?? ["generic"]),
	];
	if (dialects.length === 0) {
		throw new Error(
			`rule "${ruleId}", case "${testCase.name}": surface.dialects must not be empty — list at least one dialect, or omit the key to use this kind's default`,
		);
	}
	for (const dialect of dialects) {
		if (BUILTIN_DIALECTS[dialect].contracts[kind] === undefined) {
			throw new Error(
				`rule "${ruleId}", case "${testCase.name}": dialect "${dialect}" has no contract for surface kind "${kind}" (kind "${kind}" is spoken by: ${dialectsSupportingKind(kind).join(", ")}) — a real config would reject this surface`,
			);
		}
	}
	const spokes: ResolvedSpoke[] = [
		...(input.spokes ?? []).map((path) => ({ path, loc: { line: 1, col: 1 } })),
		...(input.undeclaredSpokes ?? []).map((path) => ({ path })),
	];
	// `freezeSurface`/`sealMap` are config.ts's own passes, exported for exactly this call, not
	// reimplemented here: a real run hands every rule a deep-frozen surface with a sealed rules
	// map, so a rule that mutates `doc.surface` (rewriting the dialects the next document is
	// judged against, or pushing onto `include`) throws in production. Building a plain, mutable
	// object here would let that rule pass every rule test and fail only for a user — the precise
	// tester-versus-engine drift this module exists to avoid.
	return freezeSurface({
		root: input.root ?? ".",
		kind,
		dialects,
		include: input.include ?? defaultInclude(kind, dialects),
		ignore: input.ignore ?? [],
		spokes,
		rules: sealMap(new Map()),
	});
}

/** Builds the single-rule, single-surface `ResolvedConfig` a case runs under. */
function buildConfig(
	root: string,
	ruleId: string,
	options: unknown,
	surface: ResolvedSurface,
	resolvedSeverity: Severity,
	ignore: readonly string[] | undefined,
): ResolvedConfig {
	// Field-by-field, never `{ options: maybeUndefined }`: a spread would give `resolvedRule` an
	// own `options: undefined` key even for a case that wrote none, which the engine's own
	// `"options" in rule`-shaped checks would then read as "explicitly set to nothing" instead
	// of "not set at all" (CLAUDE.md's habit; `resolveRuleSetting`/`resolveSurfaceRules` in
	// config.ts follow the identical pattern for the same reason).
	const resolvedRule: ResolvedRule = { severity: resolvedSeverity };
	if (options !== undefined) {
		resolvedRule.options = options;
	}
	const ruleOptions = new Map<string, unknown>();
	if (options !== undefined) {
		ruleOptions.set(ruleId, options);
	}

	return {
		root,
		origin: "config",
		configFile: join(root, CONFIG_FILENAME),
		// `DEFAULT_IGNORE`, not `[]`: a real `loadConfig` always merges this in (see its own
		// JSDoc), so a case with a `.git/` or `node_modules/` fixture file must not see it linted
		// here when a real run never would. A case's own `ignore` list is MERGED with it, in the
		// same order and with the same dedupe+freeze `loadConfig` applies
		// (`[...new Set([...parsed.ignore, ...DEFAULT_IGNORE])]`, config.ts), never substituted
		// for it — otherwise writing one `ignore` entry would silently re-enable linting
		// `node_modules/`, which is precisely the drift this whole module exists to avoid.
		ignore:
			ignore === undefined
				? DEFAULT_IGNORE
				: Object.freeze([...new Set([...ignore, ...DEFAULT_IGNORE])]),
		// Frozen like `loadConfig`'s own list: `ctx.surfaces` of a `shape` rule IS this array.
		surfaces: Object.freeze([surface]),
		rules: new Map([[ruleId, resolvedRule]]),
		ruleOptions,
		skippedCandidates: [],
	};
}

/**
 * Wraps `rule` in a same-kind `TestableRule<O>` that behaves identically but records that
 * `check` ran, so `runCase` can tell "the rule ran and found nothing" apart from "the rule
 * never ran at all" — covering `check(ctx)` (no `doc` parameter) alongside the
 * original `check(doc, ctx)`.
 *
 * `filePaths` is populated ONLY for a `"file"` rule, one entry per `check` call (`doc.path`, in
 * dispatch order). A `"project"`/`"scan"` rule's `check` gets no
 * document at all, so there is nothing path-shaped to record for it; `invoked` (shared across
 * both branches) is the only signal such a case's "never invoked" guard needs, and is also set
 * for a `"file"` rule so `runCase` has one flag it can read regardless of kind. A `"shape"`
 * rule's spy also counts its calls in `invoked.count`: the engine dispatches that kind exactly
 * once per run, and `runCase` asserts it.
 *
 * Built as explicit object literals per kind, never `{ ...rule, check: ... }`: `Rule` is a
 * discriminated union keyed on `kind`, and spreading a union member does not carry the same
 * guarantee that the result's `kind` is still exactly the narrowed literal the spy's own type
 * annotation asserts; spelling out the literal keeps the spy an honest `TestableRule<O>`, not a
 * spread that merely resembles one. The `rule.kind === "project" ? ... : ...` at the bottom
 * exists for the identical reason: `{ kind: rule.kind, meta, check }` would type as `{ kind:
 * "project" | "scan"; ... }`, which is NOT assignable to `ProjectRule<O> | ScanRule<O>` (a union
 * discriminant has to narrow to exactly one member, not restate the union) — the ternary forces
 * the literal per branch instead.
 *
 * That same ternary reads as `rule.kind === "project" ? ... : { kind: "scan", ... }` —
 * for a rule whose `kind` is somehow none of `"file"`, `"shape"` and `"project"` (only
 * reachable via a cast, since the type already excludes it), this silently dispatches it AS a
 * `ScanRule`, running whatever its `check` does, rather than refusing to run it at all. Decided
 * NOT to restructure the ternary itself into a throwing `switch`/`if` chain: once the branches
 * above have narrowed `rule`, the extra comparison would be provably unreachable to the type
 * checker unless `kind` were widened to `string` as `assertTestableKind` does — a bigger, more
 * invasive change than the risk warrants for a path that is, today, provably unreachable in this
 * module. Instead: call `assertTestableKind` again
 * here, as the very first statement, so a rule whose actual runtime `kind` disagrees with its
 * declared `TestableRule<O>` type is rejected by name before it ever reaches the "file" check,
 * let alone the ternary — the identical backstop `runCase`/`runRuleTests` already apply before
 * `spyOn` is called at all, applied a second time at `spyOn`'s own boundary, so a future direct
 * caller of `spyOn` that skips both of today's entry points still cannot reach the silent
 * `"scan"` coercion described above. Exported (only) so `rule-tester.test.ts` can drive
 * this specific line directly — through `runCase`/`runRuleTests`, `assertTestableKind` always
 * throws before `spyOn` is ever called, so there is no way to observe THIS call's own effect
 * without calling `spyOn` itself, same reasoning as `gitInitAndCommit`'s export above.
 */
export function spyOn<O>(
	rule: TestableRule<O>,
	filePaths: string[],
	invoked: { called: boolean; count?: number },
): TestableRule<O> {
	assertTestableKind(rule);
	if (rule.kind === "file") {
		return {
			kind: "file",
			meta: rule.meta,
			check: async (doc, ctx) => {
				filePaths.push(doc.path);
				invoked.called = true;
				return await rule.check(doc, ctx);
			},
		};
	}
	if (rule.kind === "shape") {
		return {
			kind: "shape",
			meta: rule.meta,
			check: async (ctx) => {
				invoked.called = true;
				invoked.count = (invoked.count ?? 0) + 1;
				return await rule.check(ctx);
			},
		};
	}

	const check = async (ctx: RuleContext<O>): Promise<Report[]> => {
		invoked.called = true;
		return await rule.check(ctx);
	};
	return rule.kind === "project"
		? { kind: "project", meta: rule.meta, check }
		: { kind: "scan", meta: rule.meta, check };
}

/**
 * Normalizes one `ExpectedDiagnostic` into a `ComparableDiagnostic`, applying every default the
 * case shape documents. `file` defaults only when the case discovered exactly one document
 * (`only` set, `rest` empty); with more than one, an omitted `file` throws rather than guessing
 * which document the expectation meant.
 */
function normalizeExpected(
	ruleId: string,
	ruleFixable: boolean,
	caseName: string,
	resolvedSeverity: Severity,
	discoveredPaths: readonly string[],
	expected: ExpectedDiagnostic,
): ComparableDiagnostic {
	let file: string;
	if (expected.file !== undefined) {
		file = expected.file;
	} else {
		const [only, ...rest] = discoveredPaths;
		if (only !== undefined && rest.length === 0) {
			file = pathKey(only);
		} else {
			throw new Error(
				`rule "${ruleId}", case "${caseName}": expected diagnostic "${expected.message}" omits "file", but this case discovered ${discoveredPaths.length} documents (${discoveredPaths.join(", ")}) — name the file explicitly`,
			);
		}
	}

	return {
		ruleId: expected.ruleId ?? ruleId,
		severity: expected.severity ?? resolvedSeverity,
		message: expected.message,
		file,
		line: expected.line,
		col: expected.col,
		endLine: expected.endLine,
		endCol: expected.endCol,
		fixable: expected.fixable ?? ruleFixable,
	};
}

/**
 * Runs one case end to end: materializes a temp dir, builds the engine's real inputs, runs
 * `runEngine` over a spy wrapping `rule`, and asserts the resulting diagnostics equal `expected`
 * (empty for a valid case, via `expect(actual).toEqual(expected)` so bun prints a real diff on
 * mismatch). Exported so `rule-tester.test.ts` can drive it directly and assert on a thrown
 * message, without going through `describe`/`test`.
 *
 * Throws on every failure mode: an unsupported rule kind, a `shape` case whose severity is not
 * `error`/`warn`, an unsafe path key (`files`, `symlinks`, `worktree`; absolute, `..`-escaping or
 * holding a NUL), a path in both `files` and `symlinks` (or in both `worktree.files` and
 * `worktree.symlinks`), an empty fixture, `worktree` on a case with no git step, a fixture that
 * pre-creates `.git`, a git-needing case's git-init-and-commit step failing, zero discovered
 * files (not for a `shape` rule), an unexpected diagnostic not from the rule under test (today:
 * `parse/frontmatter`), the rule never having run, an ambiguous expected `file`, or a genuine
 * diagnostic mismatch.
 *
 * Deliberately unconstrained beyond that: unlike `runRuleTests`'s invalid loop (see its own
 * JSDoc), `runCase` does not require `expected` to be non-empty or to name `rule.meta.id` even
 * once. It is the lower-level primitive this harness's own tests drive directly — e.g. the
 * `expectParseErrors` case at rule-tester.test.ts:407-431 ("broken yaml frontmatter WITH
 * expectParseErrors ...") passes an `expected` list holding one `parse/frontmatter` diagnostic
 * and nothing naming the rule under test, which is a legitimate use of `runCase` and would be
 * rejected by `runRuleTests`'s stricter, case-authoring-time guard.
 */
export async function runCase<O>(
	rule: TestableRule<O>,
	testCase: RuleTestCase,
	expected: readonly ExpectedDiagnostic[],
): Promise<void> {
	assertTestableKind(rule);
	assertShapeSeverity(rule, testCase);
	assertSafeFiles(rule.meta.id, testCase);
	const needsGit = testCase.needsGit ?? rule.kind !== "file";
	if (testCase.worktree !== undefined && !needsGit) {
		throw new Error(
			`rule "${rule.meta.id}", case "${testCase.name}": "worktree" changes the checkout after the fixture commit, but this case has no git step (needsGit resolves to false)`,
		);
	}

	const dir = await mkdtemp(join(tmpdir(), "skillslurp-ruletest-"));
	try {
		// realpath'd once, up front: macOS's tmpdir sits under `/var`, itself a symlink to
		// `/private/var`, so a rule comparing `doc.absPath` (derived from this root) against
		// `ctx.root` (this same root, handed straight through) must not see two spellings of
		// the identical directory.
		const root = await realpath(dir);
		await writeFiles(rule.meta.id, testCase, root);
		await writeSymlinkMap(
			`rule "${rule.meta.id}", case "${testCase.name}"`,
			"symlinks key",
			root,
			testCase.symlinks ?? {},
		);

		// `needsGit`, defaulting to the kind gate: a `"project"`/`"scan"`/`"shape"`
		// case gets an ephemeral git repo so its rule can call `ctx.git`/`ctx.grep`, a `"file"`
		// case gets no git step at all — no slowdown for the hundreds of existing file-rule cases
		// that never touch `ctx.git`. The gate is an explicit option because
		// `links/resolve` is a `file` rule that DOES read the index; see `RuleTestCase.needsGit`,
		// and `rule-tester.test.ts`'s own proof that neither the default nor the override is
		// theoretical.
		if (needsGit) {
			await assertNoFixtureGit(
				`rule "${rule.meta.id}", case "${testCase.name}"`,
				root,
			);
			await gitInitAndCommit(root);
		}
		await applyWorktree(rule.meta.id, testCase, root);

		const surface = buildSurface(rule.meta.id, testCase);
		const resolvedSeverity = testCase.severity ?? rule.meta.defaultSeverity;
		const config = buildConfig(
			root,
			rule.meta.id,
			testCase.options,
			surface,
			resolvedSeverity,
			testCase.ignore,
		);

		const discovered = await discoverFiles(config);
		// A `shape` rule asks about the repository, not its documents, and the engine runs it
		// even over none; the invocation count below is its "did it run" guard instead.
		if (discovered.length === 0 && rule.kind !== "shape") {
			throw new Error(
				`rule "${rule.meta.id}", case "${testCase.name}": discovered no files — "files" keys must match surface.include (${surface.include.join(", ")}) and not be excluded by surface.ignore (${surface.ignore.length > 0 ? surface.ignore.join(", ") : "none"})`,
			);
		}
		// discoverFiles's own contract: sorted, repo-relative, posix.
		const discoveredPaths = discovered.map((f) => f.path);

		const filePaths: string[] = [];
		const invoked: { called: boolean; count?: number } = { called: false };
		const spy = spyOn(rule, filePaths, invoked);

		const { diagnostics } = await runEngine(config, [spy]);

		if (!testCase.expectParseErrors) {
			// The registry this case ran against is exactly `[spy]` (wrapping `rule`), so any
			// diagnostic NOT carrying `rule.meta.id` cannot have come from the rule under test —
			// it is an engine pseudo-rule (today, only `parse/frontmatter`) by construction. Not
			// `d.ruleId === "parse/frontmatter"`: that only ever matches the one id spelled out,
			// so a second engine pseudo-rule under a different id would silently slip past this
			// guard, and `"parse/frontmatter".startsWith("parse/")` would be equally true for
			// a typo'd id that happened to share the namespace but not the rule.
			//
			// `config/*` is the one exception, and it is not a hole: a `ConfigReport`
			// IS the rule under test's own output, minted under an engine-owned id precisely
			// because the engine — not the rule — decides the id and the severity. Letting it
			// past this guard costs nothing in strictness: an unexpected `config/*` diagnostic
			// still fails the `toEqual` comparison at the end of this function, which is where
			// every diagnostic is actually asserted. What this guard adds is a better-worded
			// error for the ONE case a bare diff explains badly, and that case is
			// `parse/frontmatter`.
			const engineDiagnostics = diagnostics.filter(
				(d) =>
					d.ruleId !== rule.meta.id &&
					!d.ruleId.startsWith(CONFIG_REPORT_NAMESPACE),
			);
			if (engineDiagnostics.length > 0) {
				throw new Error(
					`rule "${rule.meta.id}", case "${testCase.name}": document(s) produced diagnostics not from the rule under test (today: "parse/frontmatter", emitted when the engine skips every file rule on a document whose frontmatter failed to parse) — ${engineDiagnostics.map((d) => `${d.ruleId} ${d.file}: ${d.message}`).join("; ")} — fix the fixture, or set expectParseErrors: true to assert on these diagnostics instead`,
				);
			}
		}

		// Kind-aware: a "file" rule's `check` runs per eligible document, so "never invoked"
		// means "ran on none of them" (still read off `filePaths`,
		// which only a "file" spy ever populates — see `spyOn`). A "project"/"scan" rule's
		// `check` gets no document at all and runs at most once per case (this module builds
		// exactly one surface), so there is nothing document-shaped to name — `invoked.called`
		// alone says whether it ran.
		if (rule.kind === "file") {
			if (filePaths.length === 0) {
				throw new Error(
					`rule "${rule.meta.id}", case "${testCase.name}": discovered ${discovered.length} file(s) but the rule was never invoked on any of them — every discovered document either failed to parse (with expectParseErrors set, keep at least one clean document) or was excluded by surface.include/ignore`,
				);
			}
		} else if (rule.kind === "shape" && invoked.count !== 1) {
			// Unreachable without an engine regression: the engine dispatches a shape rule once.
			throw new Error(
				`rule "${rule.meta.id}", case "${testCase.name}": a "shape" rule's "check" must run exactly once per run, but ran ${invoked.count ?? 0} time(s)`,
			);
		} else if (!invoked.called) {
			throw new Error(
				`rule "${rule.meta.id}", case "${testCase.name}": a "${rule.kind}" rule's "check" was never invoked for this case's surface — verify the rule id registered here ("${rule.meta.id}") is the one the engine actually enabled (this is an internal-consistency guard; it should not be reachable through a well-formed case)`,
			);
		}

		const actual = diagnostics.map(toComparable);
		const normalizedExpected = expected.map((e) =>
			normalizeExpected(
				rule.meta.id,
				rule.meta.fixable,
				testCase.name,
				resolvedSeverity,
				discoveredPaths,
				e,
			),
		);
		expect(actual).toEqual(normalizedExpected);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assertUniqueNames(
	ruleId: string,
	group: "valid" | "invalid",
	cases: readonly { readonly name: string }[],
): void {
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.name)) {
			throw new Error(
				`rule "${ruleId}": duplicate ${group} case name "${c.name}" — a duplicate name makes a failure ambiguous`,
			);
		}
		seen.add(c.name);
	}
}

/**
 * Registration-time guard for `runRuleTests`'s invalid loop only (see that function's JSDoc for
 * why `runCase` itself stays unconstrained): an invalid case must assert *something* about the
 * rule under test, not merely run it.
 *
 * Two shapes otherwise slip past every other guard in this module and still register as a
 * passing "invalid" case: `errors: []` (indistinguishable from a valid case — the engine
 * reporting zero diagnostics satisfies it exactly as it would `expected: []`), and a case whose
 * every expectation names a different rule id via `ExpectedDiagnostic.ruleId` (e.g. only the
 * engine's own `parse/frontmatter` diagnostic, via `expectParseErrors`) — the rule under test is
 * still invoked (so the "never invoked" guard in `runCase` does not fire), but nothing in
 * `errors` constrains what it reports.
 *
 * A `config/*` expectation counts as targeting the rule under test, for the same reason
 * `runCase`'s engine-diagnostic guard lets one through: a `ConfigReport` IS this rule's output —
 * the rule decided to report it, and decided its `problem` and its `message` — it merely reaches
 * the user under an engine-owned id, because the engine and not the rule is what fixes the id
 * and the severity. `index/complete`'s "configured file is missing" cases produce nothing BUT a
 * `config/missing-file` diagnostic, and they are among the most load-bearing cases that rule
 * has; refusing them here would have forced a contrived second expectation into every one of
 * them purely to satisfy this guard.
 */
function assertInvalidCaseTargetsRule(
	ruleId: string,
	testCase: InvalidCase,
): void {
	if (testCase.errors.length === 0) {
		throw new Error(
			`rule "${ruleId}", case "${testCase.name}": an invalid case's "errors" must not be empty — it is otherwise indistinguishable from a valid case`,
		);
	}
	const targetsRule = testCase.errors.some((e) => {
		const id = e.ruleId ?? ruleId;
		return id === ruleId || id.startsWith(CONFIG_REPORT_NAMESPACE);
	});
	if (!targetsRule) {
		throw new Error(
			`rule "${ruleId}", case "${testCase.name}": every expectation in "errors" names a different rule id via "ruleId" than the rule under test ("${ruleId}"), and none is a "${CONFIG_REPORT_NAMESPACE}*" problem the rule itself reported — this case asserts nothing about it`,
		);
	}
}

/**
 * Applies `RuleTestCases.needsGit` to one case, without ever writing the key when neither the
 * case nor the suite set it. A case's own value always wins.
 *
 * Spelled out as three branches rather than `{ ...testCase, needsGit: testCase.needsGit ??
 * suiteNeedsGit }` because of CLAUDE.md's "never build an object as `{ key: maybeUndefined }`":
 * that spread would give every case an OWN `needsGit` key holding `undefined`, and `runCase`'s
 * `testCase.needsGit ?? rule.kind !== "file"` would still read it correctly today — but it would
 * make `"needsGit" in testCase` lie for any future guard, and `exactOptionalPropertyTypes` (on
 * in this repo) rejects it outright.
 */
function withSuiteNeedsGit<C extends RuleTestCase>(
	testCase: C,
	suiteNeedsGit: boolean | undefined,
): C {
	if (testCase.needsGit !== undefined || suiteNeedsGit === undefined) {
		return testCase;
	}
	return { ...testCase, needsGit: suiteNeedsGit };
}

/**
 * Registers `describe(rule.meta.id, ...)`, with a `describe("valid")`/`describe("invalid")`
 * sub-block per non-empty group and one `test(case.name, ...)` per case.
 *
 * Only a `FileRule`/`ProjectRule`/`ScanRule`/`ShapeRule` is accepted. `TestableRule<O>` makes a
 * case for any other kind impossible to write for a
 * type-checked caller instead of merely undocumented, and `assertTestableKind` below is the same
 * guard again, for a caller that is not.
 *
 * Registration throws synchronously (never inside a `test(...)` callback) for a structural
 * mistake in `rule` or `cases` — an unsupported rule kind, both groups empty, a duplicate name
 * within one group, or an invalid case that asserts nothing about the rule under test (see
 * `assertInvalidCaseTargetsRule`: an empty `errors`, or every expectation naming a different rule
 * id) — so the problem surfaces at the point `runRuleTests` is called, not as a confusing runtime
 * failure, and never as a silently-passing test. `runCase` itself enforces none of this — see its
 * own JSDoc — because it is the lower-level primitive this module's own tests drive directly;
 * the stricter rule belongs at the case-authoring boundary `runRuleTests` is, not at `runCase`'s.
 */
export function runRuleTests<O>(
	rule: TestableRule<O>,
	cases: RuleTestCases,
): void {
	assertTestableKind(rule);
	if (cases.valid.length === 0 && cases.invalid.length === 0) {
		throw new Error(
			`rule "${rule.meta.id}": runRuleTests needs at least one valid or invalid case`,
		);
	}
	assertUniqueNames(rule.meta.id, "valid", cases.valid);
	assertUniqueNames(rule.meta.id, "invalid", cases.invalid);
	for (const testCase of cases.invalid) {
		assertInvalidCaseTargetsRule(rule.meta.id, testCase);
	}

	describe(rule.meta.id, () => {
		if (cases.valid.length > 0) {
			describe("valid", () => {
				for (const testCase of cases.valid) {
					const prepared = withSuiteNeedsGit(testCase, cases.needsGit);
					test(testCase.name, () => runCase(rule, prepared, []));
				}
			});
		}
		if (cases.invalid.length > 0) {
			describe("invalid", () => {
				for (const testCase of cases.invalid) {
					const prepared = withSuiteNeedsGit(testCase, cases.needsGit);
					test(testCase.name, () => runCase(rule, prepared, testCase.errors));
				}
			});
		}
	});
}
