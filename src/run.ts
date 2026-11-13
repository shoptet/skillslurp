import { resolve } from "node:path";
import {
	type AppliedBaseline,
	applyBaseline,
	BASELINE_FILENAME,
	baselineFilePath,
	buildBaseline,
	loadBaseline,
	serializeBaseline,
} from "./baseline.js";
import {
	CONFIG_FILENAME,
	ConfigError,
	loadConfig,
	NoSurfacesDetectedError,
	RESERVED_NAMESPACES,
	type ResolvedConfig,
} from "./config.js";
import { CANDIDATE_TABLE, type SkippedCandidate } from "./detect.js";
import { type Diagnostic, DOCS_URL, locFields } from "./diagnostic.js";
import { defaultInclude } from "./dialects.js";
import { compareDiagnostics, type EngineOptions, runEngine } from "./engine.js";
import { computeExitCode, EXIT_CLEAN, EXIT_ERROR } from "./exit.js";
import { displayPath } from "./paths.js";
import {
	type ReporterName,
	reporters,
	ruleListers,
} from "./reporters/index.js";
import {
	neutralizeWorkflowCommands,
	sanitizeControlChars,
} from "./reporters/text.js";
import { builtinRules } from "./rules/index.js";

// Moved to paths.ts so engine.ts can render `ResolvedConfig.configFile` the same way
// this module renders `ConfigError.file` (engine.ts cannot import run.ts — run.ts imports
// `runEngine`, so that edge is a cycle). Re-exported here because it was part of this module's
// surface first and `run.test.ts` still imports it from here.
export { displayPath };

export interface CliOptions {
	/** repo root to lint, as given on the command line (not yet resolved) */
	path: string;
	reporter: ReporterName;
	/** the CLI's TTY/NO_COLOR/TERM decision; ignored for the json reporter, which is always color: false */
	color: boolean;
	/**
	 * `--diff-base <ref>`. Absent — the KEY absent, never present-and-`undefined`
	 * (CLAUDE.md) — means a full run. See `EngineOptions.diffBase` for what it narrows and what
	 * it deliberately does not; the two extra things this layer owns are the stderr notice
	 * (`formatDiffBaseNotice`) and turning the baseline's staleness guard off.
	 */
	diffBase?: string;
	/**
	 * `--update-baseline`: regenerate `skillslurp-baseline.json` from this run instead of
	 * consulting the one on disk. Optional rather than required because absent and `false` mean
	 * exactly the same thing here — a normal run — and every caller that does not care about the
	 * baseline (most of `run.test.ts`) should not have to say so. `cli.ts` always passes a real
	 * boolean, since citty's own `default: false` makes the flag's absence a `false`, not a gap.
	 *
	 * Refused together with `diffBase`: see `runCli`'s own guard for why a partial run must not
	 * be allowed to write a file that claims to describe the whole repository.
	 */
	updateBaseline?: boolean;
}

export interface CliResult {
	/** already newline-terminated where appropriate ("" means nothing to print) */
	stdout: string;
	stderr: string;
	exitCode: number;
	/**
	 * The file `--update-baseline` produced, as data — present only on that path.
	 *
	 * `runCli` does not write it, and that is the whole point of returning it: this function is
	 * the one place every failure mode of a run is already funnelled into a `CliResult`, and it
	 * stays a pure "compute what this invocation should print and exit with" function that
	 * `run.test.ts` can call hundreds of times without a single side effect on disk. `cli.ts`
	 * performs the single write, before it writes stdout, so the report claiming a clean
	 * repository is never printed on the strength of a file that did not land.
	 */
	baseline?: {
		/** absolute path, `<config.root>/skillslurp-baseline.json` */
		readonly path: string;
		/** the whole file, already newline-terminated */
		readonly content: string;
	};
}

const CONFIG_INVALID_RULE_ID = "config/invalid";

// Structural link: mirrors engine.ts's identical assert for
// PARSE_FRONTMATTER_RULE_ID — if RESERVED_NAMESPACES and this id ever drift apart, fail
// loudly at import time instead of silently letting a configured rule collide with the
// engine-owned config/invalid pseudo-rule.
if (!RESERVED_NAMESPACES.some((ns) => CONFIG_INVALID_RULE_ID.startsWith(ns))) {
	throw new Error(
		`internal error: CONFIG_INVALID_RULE_ID "${CONFIG_INVALID_RULE_ID}" must start with a reserved namespace`,
	);
}

/**
 * `ConfigProblem.ruleId`'s own JSDoc says it must be a reserved namespace,
 * and each producer today asserts that for its own constant at import time (see
 * `PARSE_FRONTMATTER_RULE_ID`, `NO_FILES_RULE_ID`, `CONFIG_INVALID_RULE_ID`) — but that only
 * guards the constants that exist today. `configErrorDiagnostics` is the one place every
 * `ConfigProblem`, from every producer present and future, passes through before becoming a
 * diagnostic, so it is the one place a check catches all of them without relying on every new
 * producer remembering to add its own import-time assert. A future problem written as
 * `ruleId: "skill/frontmatter-schema"` would otherwise mint a diagnostic indistinguishable from
 * that registered rule's own output. Throws a plain `Error` — same posture as the engine's
 * rule-bug throws, an internal bug rather than a user-facing config problem — which `runCli`'s
 * outer catch already turns into exit 2 with the message and no stack trace.
 */
function assertReservedRuleId(ruleId: string): void {
	if (!RESERVED_NAMESPACES.some((ns) => ruleId.startsWith(ns))) {
		throw new Error(
			`internal error: ConfigProblem.ruleId "${ruleId}" is not in a reserved namespace (${RESERVED_NAMESPACES.join(", ")})`,
		);
	}
}

/**
 * Maps a `ConfigError` to the diagnostics the active reporter renders. Every problem becomes
 * one diagnostic under its own `ruleId` when the problem carries one (e.g. `config/no-files`,
 * so a user can recognize and look up that specific mistake), else the
 * generic `config/invalid`; a `ConfigError` with zero problems (e.g. a missing config file,
 * which fails before any positioned problem exists) falls back to a single `config/invalid`
 * diagnostic built from the error's own top-level message, so the user still sees something
 * instead of a silently empty report.
 */
export function configErrorDiagnostics(
	err: ConfigError,
	root: string,
): Diagnostic[] {
	const file = displayPath(root, err.file);
	if (err.problems.length === 0) {
		return [
			{
				ruleId: CONFIG_INVALID_RULE_ID,
				severity: "error",
				message: err.message,
				file,
				fixable: false,
				docsUrl: DOCS_URL,
			},
		];
	}
	return err.problems.map((problem) => {
		if (problem.ruleId !== undefined) {
			assertReservedRuleId(problem.ruleId);
		}
		return {
			ruleId: problem.ruleId ?? CONFIG_INVALID_RULE_ID,
			severity: "error",
			message: problem.message,
			file,
			...locFields(problem.loc),
			fixable: false,
			docsUrl: DOCS_URL,
		};
	});
}

/**
 * Renders ONE link of a `formatError` chain: an `Error`'s own message, a string as-is, and
 * everything else (a plain object, number, etc. — e.g. `{ code: "EACCES" }` from a wrapped
 * errno exception) via `JSON.stringify` so it reads as its actual shape instead of the
 * useless default `String()` coercion (`"[object Object]"`). Falls back to `String(cause)`
 * only if `JSON.stringify` itself throws (a cyclic structure). Named for what it does now
 * (one link, not necessarily a `.cause`) — `formatError` below is what walks the chain.
 */
function formatErrorLink(link: unknown): string {
	if (link instanceof Error) {
		return link.message;
	}
	if (typeof link === "string") {
		return link;
	}
	try {
		return JSON.stringify(link);
	} catch {
		return String(link);
	}
}

/**
 * `err.message`, plus `: <cause message>` for every link of `err.cause`'s chain, `": "`-joined —
 * never a stack trace.
 *
 * Walking the WHOLE chain, not just one level, matters for exactly the case the chaining
 * exists for: `engine.ts` wraps a rule crash as `rule "x" crashed while checking
 * ...` with the underlying failure as `cause` (`ruleCrashError`/`ruleCrashErrorForSurface`), and
 * that failure is very often ITSELF a wrapper — e.g. `runEngine`'s own `failed to read "<path>"`
 * around a raw `EACCES`/`ENOENT` — three links deep. The one-level-only version rendered only
 * the middle link ("crashed while checking ...: failed to read \"locked.md\"") and dropped the
 * innermost, ACTUAL cause (the errno message) entirely — the one thing that tells a user *why*
 * the read failed and what to fix.
 *
 * The innermost link of a real fs error contains a machine-absolute path (whatever the engine
 * passed to the syscall — `resolve(config.root, ...)`), which is exactly what the engine
 * keeps out of the OUTER, engine-owned wrapper messages by using a repo-relative
 * `doc.path` there instead. Rendered here anyway, deliberately: this is the ONE place in the
 * chain the path could ever come from (the OS error itself), it is the user's own machine and
 * their own filesystem, not a secret, and a permission/existence error is undiagnosable without
 * knowing which real path on disk was denied — "keep wrapping the errno without its path" would
 * make this fix a no-op in the one case (an EACCES read failure) it exists to solve. The
 * alternative (stop walking once a link's message contains something that looks like an
 * absolute path) was rejected: it cannot be done reliably without a path-sniffing heuristic that
 * would just as easily eat a legitimate message that happens to contain a `/`.
 */
export function formatError(err: unknown): string {
	if (!(err instanceof Error)) {
		return neutralizeWorkflowCommands(sanitizeControlChars(String(err)));
	}
	const parts: string[] = [err.message];
	// A cause chain is user/library-constructed data, not something this function controls, so a
	// cycle (`a.cause === a`, or a longer `a -> b -> a`) is only a bug ELSEWHERE away — closed
	// here with a visited set rather than trusted to never happen, since this function's whole
	// job is to render whatever chain shows up without becoming the next hang.
	const seen = new Set<Error>([err]);
	let link: unknown = err.cause;
	while (link !== undefined) {
		parts.push(formatErrorLink(link));
		if (!(link instanceof Error) || seen.has(link)) {
			break;
		}
		seen.add(link);
		link = link.cause;
	}
	// Sanitized HERE rather than at each stderr write, because this is the single funnel every
	// one of them goes through and the next producer of an error message should not have to
	// remember. Measured: a committed
	// `skillslurp-baseline.json` whose top-level key carries `ESC [2J ESC [1;1H CR LF ::error::…`
	// put those bytes on stderr verbatim from a plain clone — zod's `strictObject` message embeds
	// the offending key raw, and `baseline.ts`'s own `jsonPath` (which does neutralize keys via
	// JSON.stringify) is not on that path. Raw ANSI repaints the operator's terminal, and a raw
	// newline followed by `::` forges a workflow-command line in a CI log. Everything reaching a
	// terminal or a runner goes through `sanitizeControlChars`; stderr was the one sink that did
	// not.
	return neutralizeWorkflowCommands(sanitizeControlChars(parts.join(": ")));
}

/**
 * `sanitizeControlChars`, applied per line rather than to the whole assembled block: its own
 * character class (`\p{Cc}`) includes `\n` itself (measured: `sanitizeControlChars("a\nb")` is
 * `"a\\u{a}b"`), so running it across a multi-line string would escape the very newlines that
 * separate one notice from the next, turning several readable lines into one with a literal
 * `\u{a}` where each break used to be. Splitting first keeps every line's own break a structural
 * fact this function does not touch, while still escaping anything else a line's content
 * carries — including a raw ESC from a `--diff-base :/<text>` search, which is what this exists
 * for (see this function's one call site).
 */
function sanitizeStderrLines(s: string): string {
	return s
		.split("\n")
		.map((line) => neutralizeWorkflowCommands(sanitizeControlChars(line)))
		.join("\n");
}

/**
 * `stylish` is the only reporter and rule lister whose output this function terminates: it
 * appends a trailing newline for a non-empty stylish body, which otherwise has none. Every OTHER
 * reporter and rule lister — `json`, `github`, and any one added later — is expected to already
 * return output that ends in a newline of its own, and is returned here untouched; a new one
 * that does not is one byte short of the rest, not a case for this function to special-case.
 * `githubRules` (reporters/github.ts) had exactly that gap until it grew its own trailing
 * newline, measured directly against the byte-identical pin every other reporter already passed.
 */
function terminate(reporter: ReporterName, body: string): string {
	return reporter === "stylish" && body.length > 0 ? `${body}\n` : body;
}

/**
 * `SkippedCandidate.root` always names a `CANDIDATE_TABLE` row: `detectSurfaces` builds every
 * `SkippedCandidate` from a table entry's own `root`, never from a name a caller invented. The
 * throw below is an internal-error backstop, not a real failure mode — it exists so a future
 * change that breaks that invariant fails loudly instead of rendering `undefined` into a
 * user-facing message.
 */
function includePatternsFor(root: string): readonly string[] {
	const row = CANDIDATE_TABLE.find((c) => c.root === root);
	if (!row) {
		throw new Error(
			`internal error: unknown detection candidate root "${root}"`,
		);
	}
	return defaultInclude(row.kind, row.dialects);
}

/**
 * One line for a candidate that resolved to a real directory but produced no surface (see
 * `SkippedCandidate`, detect.ts) — shared between the detected-run announcement (a candidate
 * that contributed nothing alongside surfaces that DID get linted) and the none-found notice
 * (every candidate landed here). States the fact discovered, not a guessed cause: "no file
 * matched" covers a genuinely empty directory, a directory holding only non-matching files, and
 * one whose contents could not even be listed (e.g. `EACCES`) — detection cannot tell those
 * apart, so the message does not pretend to.
 */
function formatSkippedLine(candidate: SkippedCandidate): string {
	if (candidate.reason === "outside-repo") {
		return `  ${candidate.root} points outside the repository and was skipped`;
	}
	if (candidate.reason === "overlaps") {
		return `  ${candidate.root} overlaps ${candidate.keptRoot} and was skipped`;
	}
	const patterns = includePatternsFor(candidate.root).join(", ");
	return `  ${candidate.root} exists, but no file matched ${patterns}`;
}

/**
 * Renders the stderr announcement for a zero-config detected run. This — not config.ts or
 * detect.ts — is where the user-facing English lives: those two modules produce data (a
 * `ResolvedConfig`, a list of `ResolvedSurface`s), and `runCli` is the one place that decides
 * how the CLI speaks about it. stdout is untouched: the reporter still renders the run's actual
 * diagnostics, so the json reporter stays parseable and the stylish reporter stays clean on a
 * clean run.
 *
 * A surface that other candidates reached through symlinks lists them as `spokes`, in table order.
 *
 * Also lists any `skippedCandidates` (one line each, via `formatSkippedLine`): a run can find
 * real surfaces to lint AND still have an escaping symlink or an empty candidate sitting
 * alongside them, and that candidate contributing nothing is exactly what a user needs told,
 * not silently dropped because the run overall succeeded.
 *
 * Names the ruleset applied (`extends: ["recommended"]`) — the single most surprising fact
 * about a zero-config run, since it decides which diagnostics did and did not fire. Must stay
 * in sync with the literal `["recommended"]` `loadConfig` (config.ts) passes to
 * `resolveTierRules` on this exact path; there is no shared constant to import instead because
 * neither module may import a runtime value from the other's layer for this purpose.
 */
function formatDetectedAnnouncement(config: ResolvedConfig): string {
	const surfaceLines = config.surfaces.map((surface) => {
		const spokes =
			surface.spokes.length === 0
				? ""
				: `; spokes: ${surface.spokes.map((spoke) => spoke.path).join(", ")}`;
		return `  ${surface.root} (${surface.kind}, ${surface.dialects.join(", ")}${spokes})`;
	});
	const skippedLines = config.skippedCandidates.map(formatSkippedLine);
	return `${[
		`no ${CONFIG_FILENAME} found; linting auto-detected surfaces:`,
		...surfaceLines,
		...skippedLines,
		'using rules from extends: ["recommended"] (the built-in default).',
		`create ${CONFIG_FILENAME} to choose surfaces, rules and severities.`,
	].join("\n")}\n`;
}

/**
 * Renders the stderr notice for `NoSurfacesDetectedError`: nothing was found under any of the
 * candidate roots detection looked for, so the run has nothing to lint. Exit is 0 (see
 * `NoSurfacesDetectedError`'s own JSDoc for why it is not a `ConfigError`), and stdout still
 * carries the reporter's normal zero-diagnostics output — `[]` for json, `""` for stylish — so a
 * caller parsing stdout never has to special-case this outcome.
 *
 * Distinguishes a candidate that is simply not there (`also looked for:`, one line, no claim
 * beyond "not found") from one that resolved to a real directory but contributed nothing
 * (`err.skipped`, one line each via `formatSkippedLine`) — the bug this notice used to have:
 * "looked in: .claude/skills" read as "there is no such layout" even when `.claude/skills`
 * existed and simply matched zero files (a symlink-hub whose entries are directory symlinks,
 * which detection does not traverse, is the common real-world shape).
 */
function formatNoSurfacesNotice(err: NoSurfacesDetectedError): string {
	const skippedRoots = new Set(err.skipped.map((c) => c.root));
	const notFound = err.candidateRoots.filter((root) => !skippedRoots.has(root));
	// The symlink hint is a general statement about how discovery globs, printed once and only
	// when some candidate directory really did exist and matched nothing — it is NOT attached to
	// a specific line, because the far more common reason for an empty `.claude/skills` is that
	// it is empty. Stated as a fact about the tool rather than as a diagnosis of this run, it
	// helps the hub case without misleading the freshly-created-directory case.
	const anyEmpty = err.skipped.some((c) => c.reason === "no-match");
	return `${[
		`no known agent-skill layout found under ${err.root}; nothing to lint.`,
		...err.skipped.map(formatSkippedLine),
		...(notFound.length > 0 ? [`also looked for: ${notFound.join(", ")}`] : []),
		...(anyEmpty ? ["note: symlinks inside a surface are not followed."] : []),
		`create ${CONFIG_FILENAME} to lint a layout skillslurp does not detect.`,
	].join("\n")}\n`;
}

/**
 * The one stderr line a run with a baseline prints, whether or not anything was
 * suppressed: "there is a baseline and it was applied" is the fact a reader needs, and a notice
 * that appeared only when a number was non-zero would make an empty baseline look like no
 * baseline at all.
 *
 * stderr, not the report: no reporter has to know the baseline exists, the json document stays
 * byte-identical to a run without one (the json reporter's `summary` has no `suppressed`
 * count), and `summary.problems` keeps meaning
 * "what this run reports". Same contract as the zero-config detection announcement above.
 *
 * The parenthesized plurals are literal — "1 problem(s) suppressed, 0 stale entr(y|ies)" — and
 * that is deliberate rather than lazy: the line is a fixed shape whatever the counts are, so
 * anything grepping a CI log matches one string instead of four, and `--update-baseline`'s
 * sibling line can be written the same way.
 */
function formatBaselineNotice(applied: AppliedBaseline): string {
	return `${BASELINE_FILENAME}: ${applied.suppressedCount} problem(s) suppressed, ${applied.stale.length} stale entr(y|ies)\n`;
}

/**
 * The stderr line `--update-baseline` prints instead of `formatBaselineNotice`'s: the
 * two never appear together, because an updating run does not consult the file it is about to
 * overwrite. Deliberately shaped like its sibling — a fixed skeleton with literal `(s)` plurals,
 * so a CI log is grepped with one string rather than four.
 *
 * Says `wrote`, in the past tense, and is therefore only true once the write has happened —
 * which is why `cli.ts` drops the whole of `stderr` when the write fails, rather than printing
 * this line underneath the error explaining that it did not.
 *
 * Counts what went INTO the file, not what stdout shows: stdout on this path is the reporter
 * over an empty list (everything the run found has just been blessed), so without this line a
 * user has no way to tell "nothing was wrong" from "462 problems were baselined". The file count
 * is distinct paths, which is what a reader compares against the file they are about to commit.
 */
function formatUpdateBaselineNotice(
	diagnostics: readonly Diagnostic[],
): string {
	const files = new Set(diagnostics.map((d) => d.file));
	const errors = diagnostics.filter((d) => d.severity === "error").length;
	const warnings = diagnostics.length - errors;
	return `wrote ${BASELINE_FILENAME}: ${diagnostics.length} problem(s) in ${files.size} file(s) (${errors} errors, ${warnings} warnings)\n`;
}

/**
 * The stderr line printed, when `--diff-base` is set, on every run that reaches the engine —
 * whether or not anything was narrowed away. NOT on every `--diff-base` run, full stop: one
 * that never reaches the engine (zero-config detection finding no surfaces at all, `cli.ts`'s own
 * flag-combination refusals) prints a different notice, or none, instead. Two facts a reader
 * cannot get from the report itself: how much of the repository this run actually looked at, and
 * that the quiet half of the run was quiet by instruction rather than because it was clean.
 *
 * Says what still ran, not only what did not: "project, scan and shape rules ran in full" is the
 * answer to the question a narrowed run immediately raises — a `refs/no-dangling-paths` error
 * against an untouched README looks like a bug until you know the scan corpus was never narrowed.
 *
 * Printed AFTER `formatBaselineNotice` when both apply, so its `baseline staleness not checked`
 * clause sits directly under the `0 stale entr(y|ies)` it explains — that zero is otherwise
 * indistinguishable from "the baseline is perfectly in sync".
 *
 * `changedDocuments` is `number | undefined` only so this function can be the one place the
 * invariant is checked: `runEngine`'s `EngineResult` carries `changedDocuments` as an own key
 * whenever `diffBase` is set, so `undefined` here means the two have drifted apart. Loud
 * (through `runCli`'s outer catch: stderr, exit 2) rather than a notice quietly claiming zero
 * changed documents.
 */
function formatDiffBaseNotice(
	base: string,
	changedDocuments: number | undefined,
	baselineApplied: boolean,
): string {
	if (changedDocuments === undefined) {
		throw new Error(
			"internal error: runEngine reported no changed-document count for --diff-base",
		);
	}
	const staleness = baselineApplied ? "; baseline staleness not checked" : "";
	return `--diff-base ${base}: file rules limited to ${changedDocuments} changed document(s); project, scan and shape rules ran in full${staleness}\n`;
}

/**
 * `--list-rules`: renders the built-in registry through the requested reporter's lister. Always
 * exits clean — it answers a question about skillslurp itself, so there is no repository whose
 * state could make it fail.
 *
 * The parameter is `Omit<CliOptions, "path">` rather than `CliOptions`, deliberately: this path
 * performs no discovery, reads no config and never touches the repository being linted, and a
 * signature that CANNOT be handed a path is what states that at compile time instead of in a
 * comment somebody has to keep true. The CLI enforces the other half — an explicit positional
 * alongside `--list-rules` is a usage error there, not a silently ignored argument here.
 *
 * `builtinRules` is bound in this module, right beside `runCli`'s own use of it, so "which
 * registry does the CLI lint with" and "which registry does it list" cannot drift apart.
 */
export function listRulesCli(options: Omit<CliOptions, "path">): CliResult {
	const lister = ruleListers[options.reporter];
	return {
		// Same two mechanisms a normal run's stdout goes through: `terminate` supplies stylish's
		// trailing newline (json brings its own), and the json reporter is always color: false —
		// the CLI's TTY/NO_COLOR decision is for human-readable output only.
		stdout: terminate(
			options.reporter,
			lister(builtinRules, {
				color: options.reporter === "json" ? false : options.color,
			}),
		),
		stderr: "",
		exitCode: EXIT_CLEAN,
	};
}

/**
 * CLI-owned color decision: reporters never sniff TTY/env themselves. Per the NO_COLOR
 * spec (https://no-color.org/), only a NO_COLOR value that is *present and non-empty* disables
 * color — `NO_COLOR=` (set to the empty string) must NOT.
 */
export function resolveColor(): boolean {
	const noColor = process.env.NO_COLOR;
	const noColorRequested = noColor !== undefined && noColor !== "";
	return (
		process.stdout.isTTY === true &&
		!noColorRequested &&
		process.env.TERM !== "dumb"
	);
}

/**
 * Core CLI flow, factored out of `cli.ts` so it is testable without spawning a process: load
 * config, run the engine, and render diagnostics through the requested reporter. Never throws —
 * every failure mode (an unresolvable `path`, invalid config, a crash anywhere in
 * loadConfig/runEngine, or even a crash inside the reporter itself) is captured into
 * `CliResult`, so the caller only has to write `stdout`/`stderr` and set `process.exitCode`.
 * The outer try wraps everything, including `resolve(options.path)` (which can throw if the
 * process's own cwd was deleted out from under it) and the `ConfigError` branch's reporter call
 * (which is not otherwise guarded) — anything that still escapes the inner logic is caught here
 * and reported via `formatError`, the same as `cli.ts`'s own belt-and-braces catch.
 */
export async function runCli(options: CliOptions): Promise<CliResult> {
	try {
		// `cli.ts` refuses this pair before the run starts, so reaching it here means a
		// programmatic caller (or a future flag-parsing change) got past that check. Loud rather
		// than silently obeyed: `--diff-base` lints a subset of the documents, and a baseline
		// built from a subset would bless a fraction of the repository's findings while claiming,
		// by being a baseline, to describe all of them — every unvisited entry would then read as
		// a NEW problem on the next full run.
		if (options.updateBaseline === true && options.diffBase !== undefined) {
			throw new Error(
				"internal error: --update-baseline cannot be combined with --diff-base — a baseline records what a full run found",
			);
		}
		const root = resolve(options.path);
		const reporter = reporters[options.reporter];
		// The json reporter always gets color: false — the CLI's TTY/NO_COLOR decision is for
		// human-readable stylish output only.
		const reporterOptions = {
			color: options.reporter === "json" ? false : options.color,
		};

		// Visible to the catch block below: a `ConfigError` thrown AFTER `loadConfig` has already
		// resolved a detected config (e.g. `runEngine`'s `discoverFiles` call rejecting a detected
		// surface root that vanished after detection) must still announce that detection ran —
		// otherwise the user reads a caret pointing at a `skillslurp.json` that does not
		// exist, plus advice about a `surfaces:` block they never wrote, with no hint that
		// skillslurp invented the surfaces in the first place. Stays `undefined` when `loadConfig`
		// itself is what throws, since then nothing was ever resolved to announce.
		let config: ResolvedConfig | undefined;
		try {
			// The caller-supplied path, not the pre-resolved `root`: a relative path keeps
			// loadConfig's own not-found/EISDIR/ENOTDIR messages relative (see config.ts) —
			// loadConfig resolves internally for its own filesystem access regardless.
			config = await loadConfig(options.path, builtinRules);
			// Assembled field by field behind a `!== undefined` guard, never as
			// `{ diffBase: maybeUndefined }` (CLAUDE.md): an own `diffBase` key holding
			// `undefined` reads as "explicitly set" to anything asking with `in`, and
			// `runEngine`'s own `options?.diffBase === undefined` test is the only thing between
			// "no flag was given" and one git subprocess this run did not need. Annotated with a
			// local structural type plus `satisfies` rather than with `EngineOptions` directly,
			// because that interface's fields are `readonly` — as they should be for the callee —
			// and field-by-field assembly needs them writable here.
			const engineOptions: { diffBase?: string } = {};
			if (options.diffBase !== undefined) {
				engineOptions.diffBase = options.diffBase;
			}
			const { diagnostics, changedDocuments } = await runEngine(
				config,
				builtinRules,
				engineOptions satisfies EngineOptions,
			);
			// `--update-baseline` forks the run here, BEFORE `loadBaseline`: the file on
			// disk is about to be overwritten, so reading it would only risk suppressing the very
			// diagnostics the new file has to record. Regeneration, never a merge — an entry the
			// repository has outgrown disappears because this run did not find it, which is the
			// only way `baseline/stale` can ever be answered.
			//
			// Exit 0 and an empty report: everything this run found is now blessed, so a CI job
			// that ran the flag by mistake fails on the resulting diff, not on the exit code.
			// The file is returned as data and written by `cli.ts` — see `CliResult.baseline`.
			if (options.updateBaseline === true) {
				return {
					stdout: terminate(options.reporter, reporter([], reporterOptions)),
					stderr:
						(config.origin === "detected"
							? formatDetectedAnnouncement(config)
							: "") + formatUpdateBaselineNotice(diagnostics),
					exitCode: EXIT_CLEAN,
					// Written even when `diagnostics` is empty: one rule, and a user who typed
					// the flag asked for the file — an empty baseline is a committed statement
					// that the repository is clean, not a no-op.
					baseline: {
						path: baselineFilePath(config.root),
						content: serializeBaseline(buildBaseline(diagnostics)),
					},
				};
			}
			// The baseline is loaded HERE, between the engine and the reporter, and deliberately
			// not inside `runEngine`: a broken baseline file is not a lint finding and
			// not a rule crash — it is this process being unable to do what it was asked — so it
			// has to reach the outer catch as a `BaselineError` and exit 2 with its own message,
			// rather than as something the engine wraps in a rule's name. It is also the reason
			// `runEngine` stays a pure "lint this repository" function with no opinion about
			// suppression.
			const baseline = await loadBaseline(config.root);
			const applied =
				baseline === undefined
					? undefined
					: applyBaseline(diagnostics, baseline, {
							// A stale entry is the claim "the repository no longer
							// produces this", and only a full run can make that claim. Under
							// `--diff-base` most of the repository was never linted, so nearly
							// every entry would look outgrown — a report full of `baseline/stale`
							// errors for problems that are still very much there.
							checkStale: options.diffBase === undefined,
						});
			// Merged and re-sorted with the engine's OWN comparator, so a `baseline/stale` error
			// lands in the same total order as everything else instead of trailing the report.
			// `kept` alone (a filtered subsequence of an already-sorted array) is left untouched
			// when there is no baseline, so a run without one is byte-identical to before.
			const reported =
				applied === undefined
					? diagnostics
					: [...applied.kept, ...applied.stale].sort(compareDiagnostics);
			return {
				stdout: terminate(
					options.reporter,
					reporter(reported, reporterOptions),
				),
				// Zero-config auto-detection: stdout is exactly the same reporter output a
				// configured run would produce — the json reporter stays parseable, the stylish
				// reporter stays clean on a clean run — and the announcement is stderr-only, so
				// neither reporter has to know detection happened at all.
				//
				// Sanitized as ONE assembled string, not per notice: these three builders are the
				// other stderr sink `formatError`'s own funnel (above) does not cover, and
				// `formatDiffBaseNotice` interpolates the caller's own `--diff-base` revision
				// string (a `:/<text>` search accepts arbitrary bytes) straight onto stderr. Via
				// `sanitizeStderrLines`, not `sanitizeControlChars` directly, because this block
				// is multi-line and only the former leaves the line breaks alone; either one is
				// idempotent (text.test.ts), so a byte already sanitized elsewhere is unaffected
				// by going through again here.
				stderr: sanitizeStderrLines(
					(config.origin === "detected"
						? formatDetectedAnnouncement(config)
						: "") +
						(applied === undefined ? "" : formatBaselineNotice(applied)) +
						(options.diffBase === undefined
							? ""
							: formatDiffBaseNotice(
									options.diffBase,
									changedDocuments,
									applied !== undefined,
								)),
				),
				exitCode: computeExitCode(reported),
			};
		} catch (err) {
			if (err instanceof ConfigError) {
				// `config?.root`, not the lexical `root` above, whenever `loadConfig` already
				// succeeded: a `ConfigError` thrown downstream of it (`discoverFiles`'s overlap /
				// `config/no-files`) carries `config.configFile` as `err.file`, and that is now
				// canonical (same base as `config.root`) rather than lexical (same base as the
				// caller-supplied `root`) — see config.ts's own comment on `configFile` for why
				// the two must be compared in the same path space. `loadConfig`'s OWN thrown
				// `ConfigError`s (the only case `config` is still `undefined` here) stay paired
				// with the lexical `root`, since their `err.file` is built the same lexical way.
				const diagnostics = configErrorDiagnostics(err, config?.root ?? root);
				return {
					stdout: terminate(
						options.reporter,
						reporter(diagnostics, reporterOptions),
					),
					// Same condition as the success path above: a detected config can still fail
					// downstream (discovery's root checks, an option-validation backstop), and
					// the user needs the announcement exactly as much there as on a clean run —
					// see this function's `config` declaration for why.
					stderr:
						config?.origin === "detected"
							? formatDetectedAnnouncement(config)
							: "",
					exitCode: EXIT_ERROR,
				};
			}
			if (err instanceof NoSurfacesDetectedError) {
				// Deliberately not a ConfigError path: exit 0, and stdout is the reporter's own
				// zero-diagnostics rendering (`[]` for json, `""` for stylish) rather than
				// anything hand-built here, so a caller parsing stdout never has to special-case
				// this outcome.
				return {
					stdout: terminate(options.reporter, reporter([], reporterOptions)),
					stderr: formatNoSurfacesNotice(err),
					exitCode: EXIT_CLEAN,
				};
			}
			throw err;
		}
	} catch (err) {
		return {
			stdout: "",
			stderr: `${formatError(err)}\n`,
			exitCode: EXIT_ERROR,
		};
	}
}
