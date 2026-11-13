import type { ExecFileException } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Generous, explicit ceiling for a git subprocess's stdout, replacing `execFile`'s 1 MiB
 * default. That default is not a silent truncation: Node kills the child and rejects with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` the instant stdout crosses it (measured empirically —
 * `git ls-files -z` over ~6,500 tracked files, average path length well under 200 bytes,
 * already trips it). `git ls-files -z` on a real repo with a few hundred thousand tracked
 * files, or `git diff --name-status -z` over a long-lived branch, can legitimately produce
 * several MiB of output — this module raises the ceiling to 64 MiB, which comfortably covers
 * a repo in the million-file range at typical path lengths, while still being a bounded,
 * documented number rather than unbounded.
 *
 * Buffering the whole output in memory (`execFile`) rather than streaming it incrementally
 * (`spawn`) is the deliberate, simpler choice: every command this module runs (`ls-files`,
 * `diff --name-status`) produces a bounded text listing, not an unbounded binary stream, and
 * none of this module's callers need partial results before the process exits — streaming would
 * only earn back the backpressure/incremental-NUL-splitting complexity it costs if one of them
 * did.
 */
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MiB

/**
 * Every environment variable that can change *which repository, working tree or config* a
 * `git` invocation actually operates on, independent of the `-C <root>` this module always
 * passes. Deleted from the child's env by `buildGitEnv` below, unconditionally, before
 * `envOverrides` (if any) is applied — this is the fix for an inherited `GIT_DIR` silently
 * redirecting `gitInitAndCommit`'s writes into an unrelated repo (reproduced: a host repo went
 * from 1 to 10 commits), and, by construction, also closes the config-injection variant
 * (`core.hooksPath` set via one of these rather than a global gitconfig file) for
 * every caller of `runGit` — `ctx.git` (context.ts), `gitInitAndCommit` (rule-tester.ts) and
 * `context.test.ts`'s own `initRepo` alike — with one shared list, not three.
 *
 * Repo-location variables — git 2.54.0's own docs (`git help git`, "ENVIRONMENT VARIABLES" →
 * "The Git Repository"; read from this machine's installed copy,
 * `/opt/homebrew/Cellar/git/2.54.0/share/doc/git-doc/git.adoc`, 2026-09-04):
 *  - `GIT_DIR` — "specifies a path to use instead of the default `.git`" (git.adoc:537-538).
 *  - `GIT_WORK_TREE` — "the path to the root of the working tree" (git.adoc:543).
 *  - `GIT_INDEX_FILE` — "an alternate index file" (git.adoc:507-509).
 *  - `GIT_OBJECT_DIRECTORY` — where "the sha1 directories are created" (git.adoc:518-521).
 *  - `GIT_ALTERNATE_OBJECT_DIRECTORIES` — additional object-search directories (git.adoc:524).
 *  - `GIT_COMMON_DIR` — where "non-worktree files ... normally in $GIT_DIR" are taken from
 *    instead (git.adoc:577-579).
 *  - `GIT_NAMESPACE` — "Set the Git namespace" (git.adoc:548).
 *
 * Config-injection variables:
 *  - `GIT_CONFIG_COUNT` (and, transitively, `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`) —
 *    `git help config`, "ENVIRONMENT" (`git-config.adoc:482-489`, same git version/date):
 *    "If `GIT_CONFIG_COUNT` is set to a positive number, all environment pairs
 *    `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` up to that number will be added ... An
 *    empty `GIT_CONFIG_COUNT` is treated the same as `GIT_CONFIG_COUNT=0`, namely no pairs are
 *    processed." Deleting `GIT_CONFIG_COUNT` alone is enough to disable the whole indexed
 *    family — confirmed empirically (2026-09-04): with `GIT_CONFIG_KEY_0=core.hooksPath
 *    GIT_CONFIG_VALUE_0=/tmp/evil-hooks` set but `GIT_CONFIG_COUNT` unset, `git config --get
 *    core.hooksPath` exits 1 (not found); with `GIT_CONFIG_COUNT=1` added back, the same
 *    command prints `/tmp/evil-hooks`. There is no bound on `<n>` to enumerate instead.
 *  - `GIT_TEMPLATE_DIR` — `git help init`, "TEMPLATE DIRECTORY" (`git-init.adoc`, same
 *    version/date): one of the three sources `git init` copies its `hooks/` (among other
 *    things) from; a template dir shipping a non-`.sample` hook file gets it copied straight
 *    into the new repo's `.git/hooks`, enabled.
 *  - `GIT_CONFIG_PARAMETERS` — NOT found in this git version's own shipped documentation
 *    (grepped exhaustively over `git.adoc`, `git-config.adoc` and every `.html` page under
 *    `/opt/homebrew/Cellar/git/2.54.0/share/doc/git-doc`, 2026-09-04): it is `git -c`'s own
 *    internal channel for propagating `-c`-supplied config into subprocesses, not a
 *    user-facing variable, and per this repo's own habit an undocumented detail is named as
 *    such rather than guessed. Included anyway because a direct reproduction proved it:
 *    `env GIT_CONFIG_PARAMETERS="'core.hooksPath'='/tmp/evil-hooks'"` made a temp repo's
 *    `commit` run a hook from `/tmp/evil-hooks` unasked; deleting this key from the child's env
 *    (verified again below, in this file's own fix) stops that.
 *  - `GIT_CONFIG` — `git help config`, "ENVIRONMENT" (`git-config.adoc:498-503`, same
 *    version/date): "If no `--file` option is provided to `git config`, use the file given by
 *    `GIT_CONFIG` as if it were provided via `--file`. This variable has no effect on other Git
 *    commands, and is mostly for historical compatibility." That "no effect on other Git
 *    commands" is exactly the gap: `initRepo` (context.test.ts) and `gitInitAndCommit`
 *    (rule-tester.ts) both call `git config user.name`/`user.email`/`commit.gpgsign`, and
 *    `GIT_CONFIG` redirects THAT WRITE, not a read — confirmed empirically (2026-09-04):
 *    `env GIT_CONFIG=/tmp/hijacked.conf git config user.name Hijacked` writes `[user]\n\tname =
 *    Hijacked` into `/tmp/hijacked.conf`, not into the repo's own `.git/config`, whose `[user]`
 *    section is left entirely absent. Silent, not a failure: the subsequent `git commit` still
 *    goes through, signing the commit with whatever identity resolution falls back to instead.
 *
 * Deliberately NOT included: `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM`
 * only affect git's *upward search* for a `.git` when the directory `-C` names does not itself
 * have one — which is exactly what happens when `root` names a subdirectory of a checkout
 * rather than its top level, a supported way to run this project. Measured 2026-09-06: with
 * `GIT_CEILING_DIRECTORIES=<repo>` set, running against `<repo>/sub` still exits 2 with the
 * correct `"<repo>/sub" is not a git checkout` — the ceiling stops the search before it would
 * reach `<repo>/.git`, but the only effect is that honest refusal, never a silent redirection
 * elsewhere. Left out of the scrub list for that reason: reachable for a subdirectory root, but
 * its worst case is a refusal this project already produces on purpose.
 */
const GIT_ENV_SCRUB_KEYS = Object.freeze([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_CONFIG_COUNT",
	"GIT_TEMPLATE_DIR",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG",
]);

/**
 * Builds the env object every `execFile("git", ...)` call in this module uses: a copy of
 * `process.env` with every key in `GIT_ENV_SCRUB_KEYS` deleted, `LC_ALL`/`LANGUAGE` pinned so
 * git's own messages are always English (see `isGitCheckout` and `toGitError` below for
 * why message text still matters even though it is no longer the *only* signal), and
 * `envOverrides` (if any) applied last, on top of the scrub — the one narrow, internal escape
 * hatch this module offers a trusted caller (today: `gitInitAndCommit`'s own
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` overrides), never exposed to untrusted input.
 *
 * Always returns a fresh object, never `process.env` itself: this module's only two callers of
 * `execFile` (`runGit` and `isGitCheckout`) each get their own copy, and neither mutates the
 * process's real environment.
 */
function buildGitEnv(
	envOverrides: Readonly<Record<string, string>> | undefined,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of GIT_ENV_SCRUB_KEYS) {
		delete env[key];
	}
	// Forces git's own stderr to untranslated English regardless of the operator's
	// locale — measured (2026-09-04): `env LANGUAGE=de LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8 git
	// ls-files` on a non-checkout prints "Schwerwiegend: Kein Git-Repository ..."; adding
	// `LC_ALL=C` on top of that same inherited environment is enough on its own to restore the
	// English "fatal: not a git repository ..." (glibc's gettext disables translation entirely
	// under the `C`/`POSIX` locale, which takes priority over `LANGUAGE`) — confirmed by also
	// trying `LANGUAGE=` alone with `LC_ALL` left at `de_DE.UTF-8`, which stayed German.
	// `LANGUAGE=""` is kept anyway, belt-and-braces, in case some git build's locale handling
	// ever treats `LANGUAGE` as taking priority over `LC_ALL` the other way around.
	env.LC_ALL = "C";
	env.LANGUAGE = "";
	if (envOverrides !== undefined) {
		Object.assign(env, envOverrides);
	}
	return env;
}

/**
 * Global `-c` overrides applied to EVERY `execFile("git", ...)` call in this module, inserted
 * right after `-C <root>` and before the subcommand — command-line `-c` always beats config
 * read from a file (`--help config`, "FILES": "the values in the last file given are used"; a
 * command-line `-c` is layered on top of, and wins over, every file source), so this is not
 * merely "the config skillslurp itself would want" but an actual override of whatever `root`'s
 * OWN `.git/config` says, no matter how it got there.
 *
 * Blocker, security — `core.fsmonitor=` (disabled): `git ls-files` — the FIRST command
 * `createCapabilities`'s `trackedFiles` runs, and therefore the first git invocation skillslurp
 * makes against a freshly-pointed-at directory — executes the program named by the repository's
 * own `core.fsmonitor`, unconditionally, as part of refreshing the index. Reproduced
 * (2026-09-04, git 2.54.0, real repo, no env-var trickery involved at all):
 *   $ git config core.fsmonitor /tmp/fsmon.sh   # a script that only touches a marker file
 *   $ rm -f MARKER; git ls-files -z >/dev/null; ls MARKER
 *   MARKER    <-- ran
 * This is arbitrary code execution the moment a user points skillslurp at a directory whose
 * `.git/config` is attacker-controlled — a tarball or zip that ships its own `.git/`, which the
 * user then extracts and owns like any other file on disk. Neither of this module's existing
 * defenses covers it: `safe.directory` is git's protection against operating on a repo owned by
 * a DIFFERENT user (irrelevant — the user owns the extracted archive), and the `GIT_ENV_SCRUB_KEYS`
 * scrub above closes environment-variable-borne config injection, but `core.fsmonitor` here is
 * set in the repository's own LOCAL config FILE, not via any environment variable at all — there
 * is no env var to scrub. Only a command-line override beats a repo's own file config.
 *
 * Spelling chosen — `core.fsmonitor=` (empty value), not `=false` — on the strength of
 * `git-config.html`'s own rendering of `core.adoc`'s "core.fsmonitor" entry (searched
 * `/opt/homebrew/Cellar/git/2.54.0/share/doc/git-doc/git-config.html`, 2026-09-04, the source
 * `.adoc` split-file for `core.*` is not shipped standalone on this machine so the combined HTML
 * is the citable artifact): "if you concurrently use multiple versions of Git, ... Git versions
 * 2.35.1 and prior will not understand the boolean values and will consider the `true` or
 * `false` values as hook pathnames to be invoked." That is: on a git predating 2.35.1 (released
 * 2022), the literal string `false` is not read as "disabled" at all — it is read as a hook
 * PATHNAME and git tries to invoke a program by that name. An empty string carries no such
 * documented alternate reading in any git version this was able to check, so it does not trade
 * one hook-invocation risk for a smaller one — both spellings were confirmed empirically to
 * suppress the marker script above under this machine's git (2.54.0); the empty-string spelling
 * is the one that stays "disabled" rather than "a different, still-plausible pathname" on an
 * older git this module has not tested against.
 *
 * Applied universally rather than only to the one call (`ls-files`) proven reachable, matching
 * this file's existing "one mechanism, every caller" shape (`buildGitEnv`, above) rather than a
 * second, narrower one: `core.fsmonitor` was spot-checked (2026-09-04, same repo) and found to
 * have NO effect on `rev-parse --is-inside-work-tree` or on `diff --name-status` over a
 * commit-to-commit `A...B` range (the shape `computeDiff` actually uses — a working-tree-vs-HEAD
 * `diff` with no explicit range DOES consult fsmonitor, refreshing the index, but this module
 * never invokes `diff` that way), so adding the override to those calls too is a no-op for
 * today's callers, not a workaround for a second reachable path — and it costs nothing to leave
 * the guard on in case a future caller adds one.
 */
const SAFE_CONFIG_ARGS = Object.freeze(["-c", "core.fsmonitor="]);

/**
 * Runs `git -C <root> <args>` and resolves with its raw stdout as a `Buffer`.
 *
 * The one subprocess entry point this module exposes, reused by both `ctx.git` (this file's
 * only production caller today) and `RuleTester`'s git-init-and-commit
 * materialization step for `project`/`scan` rule cases — one code path, two callers, by design:
 * a second spawn mechanism in the harness would be a second place for the argument-array
 * discipline and the environment scrub below to be got wrong, and only one of them would be
 * under review at a time.
 *
 * Argument-array only (`execFile`, `shell` never enabled — not even implicitly: `execFile`,
 * unlike `exec`, never spawns a shell unless `{ shell: true }` is explicitly passed, and this
 * call never passes it) closes *shell* injection: no argument's content is ever handed to a
 * shell for interpretation, so a hostile `base` string cannot chain a second command via `;`,
 * backticks, `$(...)`, etc. It does **not** close *argument* injection, a distinct threat:
 * `git` itself still parses each argv element, so a string starting with `-` (e.g.
 * `--upload-pack=/bin/sh`) is read as an *option*, not as data, regardless of how safely it
 * arrived in argv. Closing that is each caller's job — see `context.ts`'s `assertSafeRevision`,
 * which rejects a leading `-` in a CLI-supplied revision before it ever reaches this function.
 *
 * `root` is passed as `-C <root>`, which only sets git's *starting directory* for repository
 * discovery — by itself, that does NOT guarantee the command ends up operating on `root`'s
 * repository: an inherited `GIT_DIR` (or `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...) still wins
 * over `-C`, and `-C` cannot override or clear an environment variable, only a subprocess's
 * env can (this file used to claim otherwise; reproduction found the gap it missed — a
 * `gitInitAndCommit` run with an inherited `GIT_DIR` committed into that other repo while the
 * directory `-C` named never even grew a `.git`). What actually guarantees `root` is the repo
 * every call below queries is `buildGitEnv`, above: called for **every** invocation regardless
 * of whether a caller passes `envOverrides`, it deletes every git repo-location and
 * config-injection variable this process could have inherited before the child ever starts, so
 * none of them survives to compete with `-C <root>`.
 *
 * `envOverrides` (added for `RuleTester`'s git-init-and-commit step; no production
 * caller passes it) is applied on top of the scrubbed copy of `process.env` `buildGitEnv`
 * already built, never replacing it: the child still needs everything a normal subprocess
 * needs (`PATH` to find `git` itself, first and foremost), and this parameter exists to
 * override a handful of specific keys, not to sandbox the whole environment. The merged record
 * is always a real, defined object — never `{ env: maybeUndefined }` — so an absent
 * `envOverrides` reads as "no keys added on top of the scrub", not as "environment explicitly
 * cleared".
 *
 * Every failure this module distinguishes becomes one clear `Error` — never a raw subprocess
 * stack; `formatError` (run.ts) renders only `.message` (plus a one-line `.cause`), which is
 * what reaches the CLI's stderr at exit 2:
 *  - the `git` executable itself is missing (`ENOENT` on the spawn attempt, before git ever
 *    ran) — a distinct, actionable message, not "exited with code undefined";
 *  - the child never produced a real exit code at all (a non-`ENOENT` string `.code` — a bad
 *    argument Node rejected before spawning, a permissions error on the `git` binary itself, an
 *    output stream over `MAX_BUFFER`, ...) — reported as "failed to run", folding in
 *    `err.message` rather than printing that string where an exit code belongs;
 *  - `root` is not a git checkout at all — see `isGitCheckout`/`toGitError` below for how this
 *    is now decided;
 *  - any other real, numeric non-zero exit (a bad revision, a corrupt object, …) — reported
 *    with the exit code and git's own trimmed stderr, still no stack, and with no `.cause` at
 *    all when that stderr is empty (a previous version of this branch always attached
 *    `.cause`, which `formatError` renders as a dangling `": "` when it is empty).
 */
export async function runGit(
	root: string,
	args: readonly string[],
	envOverrides?: Readonly<Record<string, string>>,
): Promise<Buffer> {
	try {
		const { stdout } = await execFile(
			"git",
			["-C", root, ...SAFE_CONFIG_ARGS, ...args],
			{
				encoding: "buffer",
				maxBuffer: MAX_BUFFER,
				env: buildGitEnv(envOverrides),
			},
		);
		return stdout;
	} catch (err) {
		throw await toGitError(root, args, err);
	}
}

/** `exec.stderr`/`exec.stdout` are typed `string | Buffer | undefined` because `ExecFileException` covers every encoding this module could have been called with; this call always passes `encoding: "buffer"`, so at runtime it is always a `Buffer` — this only guards the type. */
function bufferToTrimmedText(value: string | Buffer | undefined): string {
	if (value === undefined) {
		return "";
	}
	return (Buffer.isBuffer(value) ? value.toString("utf8") : value).trim();
}

/**
 * Message-independent answer to "is `root` a git checkout at all", used by `toGitError`
 * to classify an otherwise-ambiguous exit code without parsing translatable text.
 *
 * Exit code alone cannot answer this: `git -C <root> <args>` exits 128 both when `root` is not
 * a checkout AND for plenty of unrelated fatal errors on a perfectly real checkout — measured
 * directly against this repo's own git (2.54.0): `git -C /tmp/notarepo ls-files -z` exits 128,
 * and so does `git -C <realRepo> rev-parse totally-bogus-branch` (a bad revision, exercised by
 * this module's own "not ENOENT, not 'not a git repository'" test in context.test.ts). Message
 * text used to be the only way to tell those two 128s apart, which is exactly what a translated
 * locale breaks.
 *
 * `rev-parse --is-inside-work-tree` sidesteps that ambiguity by construction: unlike the
 * caller's own `args` (which can legitimately name a bad revision, a missing path, ...), this
 * probe takes no caller-supplied argument that could itself be "wrong" — its only failure mode
 * when run against `-C root` is that `root` is not inside a git working tree at all (verified:
 * it fails with the identical "fatal: not a git repository" `root` itself already produces,
 * and also — a related but distinct case — with "fatal: cannot change to '<root>'" when `root`
 * does not even exist as a directory; this function reads both as "not a checkout"). So instead
 * of asking "does the stderr this specific command produced start with a fixed English
 * prefix", this asks git directly, via a command whose exit code alone is already the answer.
 * `--git-dir` was the other candidate investigated (git-rev-parse(1)) and behaves identically
 * for this purpose; `--is-inside-work-tree` was picked only because its `stdout` doubles as a
 * second, redundant confirmation (`"true\n"`) rather than a path this function does not need.
 *
 * Never throws: any failure of the probe itself (including, again, "not a checkout") resolves
 * to `false` rather than propagating — this function's only contract is "true means root is
 * provably a checkout", not "diagnose every possible way the probe could fail".
 */
async function isGitCheckout(root: string): Promise<boolean> {
	try {
		const { stdout } = await execFile(
			"git",
			["-C", root, ...SAFE_CONFIG_ARGS, "rev-parse", "--is-inside-work-tree"],
			{
				encoding: "buffer",
				maxBuffer: MAX_BUFFER,
				env: buildGitEnv(undefined),
			},
		);
		return bufferToTrimmedText(stdout) === "true";
	} catch {
		return false;
	}
}

/**
 * Builds an `Error` whose `.cause` is `stderr` when non-empty, and otherwise has no `.cause`
 * key at all: `formatError` (run.ts) renders `.message` plus `: <cause>` whenever
 * `.cause !== undefined`, so passing `{ cause: "" }` for a pre-exit failure that never produced
 * any stderr used to render as a dangling `"...: "` with nothing after the colon. Matches
 * CLAUDE.md's "never build an object as `{ key: maybeUndefined }`" habit: the two call shapes
 * below (`new Error(message)` vs `new Error(message, { cause: stderr })`) are spelled out
 * separately rather than passed as one options object that might carry an empty-but-present
 * `cause`.
 */
function errorWithOptionalCause(message: string, stderr: string): Error {
	return stderr === ""
		? new Error(message)
		: new Error(message, { cause: stderr });
}

/**
 * The one failure this module distinguishes by TYPE and not only by message: the path being
 * linted is not inside a git checkout at all.
 *
 * It needs a type because of where it surfaces. `links/resolve` — a `file` rule in
 * the `recommended` tier — resolves link targets against `git ls-files`, so on an unzipped
 * folder with no `.git` the very first `ctx.git` call throws this. `engine.ts` wraps anything a
 * rule throws as `rule "<id>" crashed while checking "<path>"`, which would tell the user that
 * `links/resolve` is broken when the actual, actionable fact is that `skillslurp` requires a git
 * checkout — a requirement kept deliberately, rather than silently
 * falling back to `stat` outside git. The engine recognises this class and reports the
 * requirement once, at the top, instead. Matching on a message string would have been the
 * alternative, and message strings are exactly what this module has already learned not to
 * depend on.
 *
 * `message` is unchanged from before the class existed (`"<root>" is not a git checkout`), so
 * every caller that only ever prints it — `formatError` (run.ts) renders `.message` plus the
 * `.cause` chain, never `.name` — reads identically.
 */
export class NotAGitCheckoutError extends Error {
	/**
	 * The path `runGit` was pointed at, kept as a field so a consumer can build its own sentence
	 * about it without parsing the message back apart.
	 */
	readonly root: string;

	constructor(root: string, options?: ErrorOptions) {
		super(`"${root}" is not a git checkout`, options);
		this.name = "NotAGitCheckoutError";
		this.root = root;
	}
}

/**
 * `errorWithOptionalCause`'s counterpart for `NotAGitCheckoutError`, spelled out as two separate
 * call shapes for the same reason that function is: `{ cause: "" }` is a PRESENT `cause` key,
 * which `formatError` renders as a dangling `": "` (CLAUDE.md's "never build an object
 * as `{ key: maybeUndefined }`").
 */
function notAGitCheckoutError(
	root: string,
	stderr: string,
): NotAGitCheckoutError {
	return stderr === ""
		? new NotAGitCheckoutError(root)
		: new NotAGitCheckoutError(root, { cause: stderr });
}

async function toGitError(
	root: string,
	args: readonly string[],
	err: unknown,
): Promise<Error> {
	if (!(err instanceof Error)) {
		// util.promisify's custom execFile wrapper only ever rejects with an Error (or a
		// subclass carrying the extra ExecFileException fields below) — this branch exists so
		// a future change to that contract fails loudly instead of reading `.code` off
		// something that is not even an Error.
		return new Error(`git ${args.join(" ")} in "${root}" failed`, {
			cause: err,
		});
	}
	// Cast, not narrowed: every field `ExecFileException` adds over `Error` is optional, so
	// `instanceof Error` is already the most TypeScript can prove here. The three reads below
	// all tolerate `undefined` explicitly rather than trusting the cast further — it says
	// "this is the shape execFile's rejections have", not "these fields are present".
	const exec = err as ExecFileException;
	if (exec.code === "ENOENT") {
		return new Error(
			`cannot run git for "${root}": the "git" executable was not found on PATH`,
			{ cause: err },
		);
	}
	const stderr = bufferToTrimmedText(exec.stderr);
	if (typeof exec.code === "string") {
		// Every OTHER string `.code` (`EACCES` — the `git` on PATH exists but is not
		// executable; `ERR_INVALID_ARG_VALUE` — e.g. a NUL byte in one of `args`, rejected by
		// Node before it ever spawned anything; `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` — stdout
		// crossed `MAX_BUFFER`) means the child never produced a real exit code at all: it is
		// one of Node's own error-class names, not git's. Reporting it as "exited with code
		// EACCES" is nonsensical (git never got the chance to exit with anything), and the
		// previous version of this branch also silently dropped `err.message` — the one place
		// e.g. "stdout maxBuffer length exceeded" actually lives. Folding it into the message
		// here, instead, is what surfaces it.
		return errorWithOptionalCause(
			`git ${args.join(" ")} in "${root}" failed to run: ${err.message}`,
			stderr,
		);
	}
	// `exec.code` is `number | undefined` from here on: a real exit code from a process that
	// did spawn and did exit, or (per ExecFileException's own optionality) no code was reported
	// at all, in which case none of the branches below match and this falls through to the
	// generic message with `String(undefined)` — still one clear line, never a raw stack.
	if (
		(exec.code === 128 || exec.code === 129) &&
		(!(await isGitCheckout(root)) ||
			(exec.code === 128 && stderr.startsWith("fatal: not a git repository")))
	) {
		// `isGitCheckout` (message-independent — see its own doc) is the primary
		// discriminator and is always awaited first (left operand: `||` never short-circuits
		// past it), so it decides every 128 AND every 129 on its own regardless of locale.
		// MEASURED (git 2.54.0, 2026-09-06): most commands (`ls-files` among them) report "no
		// repository here" as exit 128 with a `fatal: not a git repository ...` message, but
		// `diff` reports the very same condition as exit 129 with its own USAGE text — it
		// reads the missing repository as a bad invocation of `--no-index` and prints ~130
		// lines of help instead of a `fatal:` line. `isGitCheckout` classifies that 129
		// correctly on its own, since it never looks at the original command's stderr.
		//
		// The English-text prefix check only matters as a fallback for the one disagreement
		// `isGitCheckout` cannot resolve by itself: it reports `root` as a real checkout, yet
		// the *original* command's own stderr still claims otherwise (a TOCTOU between the
		// two subprocess calls, in principle) — in that narrow disagreement this still
		// classifies the failure as "not a git checkout" rather than trusting the more
		// optimistic of the two signals. Gated on `exec.code === 128` specifically, not on
		// the outer `if` alone: a 129's stderr is `diff --no-index`'s usage text, never the
		// `fatal: not a git repository` sentence this fallback looks for, so extending it to
		// 129 would only ever compare against text that cannot match.
		//
		// `exec.code === 128 || exec.code === 129` still gates the whole branch (128
		// unchanged from before; 129 added for `diff`'s own shape above): either code is
		// git's own signal that *something* fatal happened, and neither discriminator alone
		// is enough — an unrelated 128 or 129 on a real checkout (a bad revision, or a bad
		// flag, say) makes `isGitCheckout` true and the fallback false (128) or unreachable
		// (129), so it correctly falls through to the generic branch below.
		return notAGitCheckoutError(root, stderr);
	}
	return errorWithOptionalCause(
		`git ${args.join(" ")} in "${root}" exited with code ${String(exec.code)}`,
		stderr,
	);
}
