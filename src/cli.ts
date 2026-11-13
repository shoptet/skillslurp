#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { ArgsDef, CommandDef } from "citty";
import { defineCommand, renderUsage, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import { BASELINE_FILENAME } from "./baseline.js";
import { EXIT_ERROR } from "./exit.js";
import { repoFileRefusal } from "./paths.js";
import { type ReporterName, reporters } from "./reporters/index.js";
import {
	type CliOptions,
	type CliResult,
	formatError,
	listRulesCli,
	resolveColor,
	runCli,
} from "./run.js";

// A closed consumer (`skillslurp . | head -c 10`) is normal termination, not a crash: once
// stdout's write buffer is large enough that the kernel pipe actually fills (empirically
// ~129 KB+; smaller output never trips this), a downstream reader that has already exited
// makes the next write fail with EPIPE. Node surfaces that as an 'error' event and, left
// unhandled, an uncaught exception with a raw stack trace and exit code 1 — unlike Bun, which
// silently swallows it, so this divergence only shows up in the built dist/cli.js. Registered
// at module scope, before runMain, so it is listening before any write can occur.
process.stdout.on("error", (err) => {
	if ((err as NodeJS.ErrnoException).code === "EPIPE") {
		process.exit(process.exitCode ?? 0);
	}
	throw err;
});

const REPORTER_NAMES = new Set<string>(Object.keys(reporters));

function isReporterName(value: string): value is ReporterName {
	return REPORTER_NAMES.has(value);
}

// Only `_` (citty's raw positional list) plus the args this command actually declares.
// Anything else on the parsed args object came from a flag citty's non-strict parser accepted
// without us ever declaring it (a typo'd `--reportr`, a bare `-r`, `--help`/`--version` mixed
// with other args, ...) and must be rejected rather than silently ignored.
//
// `list-rules` is listed TWICE, in both spellings, and neither one is redundant: citty
// registers a camelCase alias for every hyphenated arg name and its parser writes the value
// under BOTH keys on every run, defaults included. Measured 2026-09-05 against the pinned citty
// 0.2.2, with a probe command declaring exactly these three args: `Object.keys(args)` comes back
// as `["_", "list-rules", "reporter", "listRules", "path"]` even when no flag at all is passed.
// Declaring only the hyphenated spelling would therefore make `findUnknownArgKeys` report
// `--listRules` as an unknown option on every single invocation, including a plain `skillslurp .`.
// `diff-base`/`diffBase` follow the same rule as `list-rules` above, with one measured
// difference worth stating: an arg declared `type: "string"` with NO default is absent from the
// parsed object entirely when the flag is not passed, and present under BOTH spellings when it
// is. Measured 2026-09-06 against the pinned citty 0.2.2 with a probe declaring exactly these
// four args: a bare `probe .` yields `["_", "list-rules", "reporter", "listRules", "path"]`,
// while `probe --diff-base main .` yields `["_", "diff-base", "list-rules", "reporter",
// "listRules", "diffBase", "path"]`. So omitting either spelling here makes every run that
// actually uses the flag exit 2 with "unknown option(s)".
const KNOWN_ARG_KEYS = new Set([
	"_",
	"path",
	"reporter",
	"list-rules",
	"listRules",
	"diff-base",
	"diffBase",
	"update-baseline",
	"updateBaseline",
]);

function findUnknownArgKeys(args: Record<string, unknown>): string[] {
	return Object.keys(args).filter((key) => !KNOWN_ARG_KEYS.has(key));
}

function formatFlagName(key: string): string {
	return key.length === 1 ? `-${key}` : `--${key}`;
}

/** Strips ANSI SGR escape sequences from `s` (byte pattern `ESC [ ... <letter>`). */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC control byte is the point
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Replaces citty's built-in `showUsage` (used for both `--help` and the `CLIError` path): citty
 * decides its own usage colors from an import-time env snapshot (a bare `NO_COLOR` env check,
 * ignorant of `isTTY` and of an empty-string `NO_COLOR=` — see run.ts's `resolveColor` for the
 * spec-compliant version), so a plain `--help | cat` still emits raw ANSI to a non-TTY pipe.
 * Rendering ourselves and stripping unless our own color decision says otherwise keeps `--help`
 * output consistent with every other command output this CLI produces.
 */
async function showUsage<T extends ArgsDef = ArgsDef>(
	cmd: CommandDef<T>,
	parent?: CommandDef<T>,
): Promise<void> {
	const usage = await renderUsage(cmd, parent);
	console.log(`${resolveColor() ? usage : stripAnsi(usage)}\n`);
}

/**
 * Writes the regenerated baseline, refusing to follow a symlink at its path.
 *
 * The path is `<root>/skillslurp-baseline.json`, so it is chosen by the REPOSITORY being linted,
 * not by the operator. Measured 2026-09-06, before this guard existed: a repository committing
 * `skillslurp-baseline.json` as a symlink to `../outside/secret.txt` had that file overwritten by
 * a plain `skillslurp --update-baseline <repo>`, exit 0, with the ordinary `wrote ...` notice. One
 * clone plus one documented flag destroyed a file outside the repository with the caller's own
 * permissions. `--update-baseline` is the second step of the adoption procedure this project
 * recommends, so "do not run it on a repository you distrust" is not an answer.
 *
 * Two guards, and the order matters because they cover different things:
 *
 * - `lstat` runs ALWAYS and is what produces the diagnosable message. It is technically racy — the
 *   path could become a symlink between the check and the open — but the threat here is a symlink
 *   COMMITTED into a repository, not an attacker racing a process on the operator's own machine.
 * - `O_NOFOLLOW` closes that race, on the platforms that have it. It is POSIX-only and Node leaves
 *   it undefined on Windows, which is exactly the shape this project distrusts: a missing flag
 *   OR-ed in as `0` is a protection that silently is not there. Hence it is the second guard and
 *   never the only one — on a platform without it, `lstat` still refuses, and the code says so
 *   rather than letting the reader assume the constant is always defined.
 *
 * A non-symlink file at the path is truncated and overwritten, which is the whole point of
 * "regenerate": the baseline describes the current run, never the union with an older one.
 */
async function writeBaselineFile(path: string, content: string): Promise<void> {
	// The same predicate `loadConfig` and `loadBaseline` use on the read side, so one file has
	// one rule rather than two that drifted apart. It also widens this guard past the symlink it
	// originally covered: a FIFO at the path made `open(O_WRONLY)` block forever with no reader,
	// which is an indefinite hang rather than a refusal.
	const refusal = await repoFileRefusal(path, "write");
	if (refusal !== undefined) {
		// `BASELINE_FILENAME`, not the caller-supplied `path` (always
		// `<root>/skillslurp-baseline.json`, an absolute path): the read side (`baseline.ts`) and
		// the config side (`config.ts`) both name their file repo-relative, since the location is
		// fixed and the operator's own machine-absolute layout says nothing a repo-relative name
		// does not already say.
		throw new Error(`refusing to write "${BASELINE_FILENAME}": ${refusal}`);
	}

	// `O_NOFOLLOW` is absent on Windows; `?? 0` there is deliberate and safe only because the
	// `lstat` above is unconditional. Do not reorder these.
	const noFollow: number = fsConstants.O_NOFOLLOW ?? 0;
	const handle = await open(
		path,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
	);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

const main = defineCommand({
	meta: {
		name: "skillslurp",
		version: pkg.version,
		description: pkg.description,
	},
	args: {
		path: {
			type: "positional",
			description: "repo root to lint",
			default: ".",
		},
		reporter: {
			type: "string",
			description: `reporter to use (${[...REPORTER_NAMES].join("|")})`,
			default: "stylish",
		},
		"list-rules": {
			type: "boolean",
			description:
				"print the built-in rules and exit, instead of linting (honors --reporter)",
			default: false,
		},
		// No `default`: absent has to stay distinguishable from any string a user could type,
		// and a default of `""` would be rejected by `assertSafeRevision` on every plain run.
		"diff-base": {
			type: "string",
			description:
				"limit file rules to documents committed since <ref> (project, scan and shape rules still run in full)",
		},
		"update-baseline": {
			type: "boolean",
			description:
				"regenerate skillslurp-baseline.json from this run and exit 0, instead of reporting",
			default: false,
		},
	},
	async run({ args }) {
		// Checked before the positional count: an unrecognized flag (`--reportr json`, `-r
		// json`) leaves its value stranded as a bogus extra positional too (citty's non-strict
		// parser has no "unknown flag" concept of its own), and naming the actual bad flag is
		// far more actionable than reporting its stranded value as an extra path.
		const unknownKeys = findUnknownArgKeys(args);
		if (unknownKeys.length > 0) {
			process.stderr.write(
				`skillslurp: unknown option(s): ${unknownKeys.map(formatFlagName).join(", ")}\n`,
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		// Checked BEFORE the extra-positional check below, not after: `--list-rules a b` would
		// otherwise be rejected with "only one path may be given", which is exactly wrong advice —
		// zero paths may be given.
		//
		// `args._` is citty's RAW positional list, and it is the only thing that can tell "no path
		// given" from "path given explicitly": `path` itself defaults to ".", so it is never
		// absent. Silently ignoring an explicit one would let `skillslurp --list-rules ./some/repo`
		// read as "list the rules that apply to that repo" — the listing is the built-in registry
		// and is byte-identical everywhere, so the user would be reading an answer to a question
		// they did not ask.
		const listRules = args["list-rules"] === true;
		const updateBaseline = args["update-baseline"] === true;
		const diffBase = args["diff-base"];

		// Checked before every combination check below, and before the flag ever reaches
		// `runCli`: an empty value is not "the flag was not given" (that is `undefined`, and
		// every check below already tests for it with `!== undefined`) but a malformed one, and
		// it deserves a message of its own rather than whatever validation happens to catch it
		// deepest. Measured (pinned citty 0.2.2): `--diff-base=` and a bare trailing `--diff-base`
		// both parse to the empty string, and without this check both fall all the way through to
		// `assertSafeRevision` (context.ts) — its message has no `skillslurp: ` prefix and never
		// names the flag, unlike every other CLI-level refusal here. `.trim()`, not `=== ""`: a
		// whitespace-only value reads as empty to `assertSafeRevision` too
		// (`base.trim() === ""`), so it gets the same early, well-named refusal instead of
		// reaching the same deep message by a different route.
		if (diffBase !== undefined && diffBase.trim() === "") {
			process.stderr.write(
				"skillslurp: --diff-base requires a git revision, e.g. --diff-base origin/main\n",
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		// Refused combinations, all three checked here rather than deeper down, because none of
		// them has a sensible half-way execution: nothing is read, nothing is written, and the
		// message names both flags and the reason. `--list-rules` sets the precedent (an explicit
		// path alongside it is an error, not a silently ignored argument): a flag this CLI accepts
		// and then ignores answers a question the user did not ask.
		if (updateBaseline && diffBase !== undefined) {
			process.stderr.write(
				"skillslurp: --update-baseline cannot be combined with --diff-base; a baseline records what a FULL run found, and a diff-scoped run never looked at most of the repository\n",
			);
			process.exitCode = EXIT_ERROR;
			return;
		}
		if (updateBaseline && listRules) {
			process.stderr.write(
				"skillslurp: --update-baseline cannot be combined with --list-rules; --list-rules prints the built-in rules and never reads a repository, so there is nothing to baseline\n",
			);
			process.exitCode = EXIT_ERROR;
			return;
		}
		// `--diff-base` alongside `--list-rules` was accepted and silently ignored, which is the
		// exact posture the two checks above and the explicit-path check below exist to refuse.
		if (listRules && diffBase !== undefined) {
			process.stderr.write(
				"skillslurp: --diff-base cannot be combined with --list-rules; --list-rules prints the built-in rules and never reads a repository\n",
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		const [firstPositional] = args._;
		if (listRules && firstPositional !== undefined) {
			process.stderr.write(
				`skillslurp: --list-rules takes no path (got "${firstPositional}"); it prints the built-in rules and never reads a repository\n`,
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		const extraPositionals = args._.slice(1);
		if (extraPositionals.length > 0) {
			process.stderr.write(
				`skillslurp: unexpected extra argument(s): ${extraPositionals.join(", ")} (only one path may be given)\n`,
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		const reporterArg = args.reporter;
		if (!isReporterName(reporterArg)) {
			process.stderr.write(
				`skillslurp: invalid --reporter "${reporterArg}" (valid: ${[...REPORTER_NAMES].join(", ")})\n`,
			);
			process.exitCode = EXIT_ERROR;
			return;
		}

		try {
			// Both branches produce a `CliResult`, so the exit-code-then-write discipline below
			// (and with it the EPIPE handler's contract) is written once and holds for both.
			let result: CliResult;
			if (listRules) {
				result = listRulesCli({
					reporter: reporterArg,
					color: resolveColor(),
				});
			} else {
				const runOptions: CliOptions = {
					path: args.path,
					reporter: reporterArg,
					color: resolveColor(),
					// Unconditional, unlike `diffBase` below: citty's `default: false` makes this a
					// real boolean on every run, so the key never holds `undefined`.
					updateBaseline,
				};
				// Assigned only when the flag was actually given, never as
				// `{ diffBase: args["diff-base"] }` (CLAUDE.md): an own key holding `undefined`
				// would read downstream as "the user asked for a diff-scoped run" and cost every
				// plain invocation a git subprocess plus a stderr notice about a ref nobody named.
				if (diffBase !== undefined) {
					runOptions.diffBase = diffBase;
				}
				result = await runCli(runOptions);
			}
			// Set before writing: if a write below fails with EPIPE, the handler above must
			// see the exit code this run actually computed, not the process default (0).
			process.exitCode = result.exitCode;
			// The one write this CLI performs (`--update-baseline`), and it goes first:
			// `runCli` returns the file as data precisely so this is the single, visible side
			// effect of the whole program (see `CliResult.baseline`).
			//
			// A failed write replaces BOTH of the run's outputs rather than being appended to
			// them, and that is the ordering's real reason: this path's stdout is the reporter over
			// an empty list — "nothing to report", true only because everything just went into the
			// baseline — and its stderr already says `wrote skillslurp-baseline.json: ...`. Printing
			// either one after an EACCES would state, on stdout in machine-readable form, that a
			// repository is clean on the strength of a file that does not exist.
			if (result.baseline !== undefined) {
				try {
					await writeBaselineFile(
						result.baseline.path,
						result.baseline.content,
					);
				} catch (err) {
					process.exitCode = EXIT_ERROR;
					process.stderr.write(`${formatError(err)}\n`);
					return;
				}
			}
			if (result.stdout.length > 0) {
				process.stdout.write(result.stdout);
			}
			if (result.stderr.length > 0) {
				process.stderr.write(result.stderr);
			}
		} catch (err) {
			// runCli is designed to never throw; this is a last-resort net so an unforeseen
			// bug still exits 2 with a concise message instead of a stack trace + exit 1
			// from citty's own top-level catch.
			process.stderr.write(`${formatError(err)}\n`);
			process.exitCode = EXIT_ERROR;
		}
	},
});

await runMain(main, { showUsage });
