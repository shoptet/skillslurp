/**
 * The suppression baseline: `skillslurp-baseline.json` at the repo root, next to
 * `skillslurp.json`, auto-loaded whenever it is present.
 *
 * ## The key
 *
 * `file → ruleId → normalizedMessage → count`. Three names and a number, no line and no column
 * — a baselined violation must survive an unrelated edit above it, and a key carrying a
 * position could not (PHPStan's baseline drops line numbers for exactly this reason:
 * <https://phpstan.org/user-guide/baseline>, fetched 2026-09-06 — "No line numbers … The
 * baseline can only say that a certain number of errors instances occurred in a certain file").
 * skill-check's `--baseline` keys on `file|ruleId|line|column|message` and is the negative
 * example, not the model.
 *
 * `count` is what a line-free key costs: two occurrences of one violation in one file collapse
 * onto one key, so the file has to remember how many there were. Excess occurrences are
 * REPORTED (M > N reports M − N of them), never suppressed wholesale — ESLint's undocumented
 * all-or-nothing behaviour would report fifty-one problems for one new violation in a file with
 * fifty baselined ones.
 *
 * ## Digits are normalized, and what that costs
 *
 * `normalizeMessage` replaces every run of ASCII digits with `#` before the message becomes a
 * key. Three rule messages embed numbers that change on edits that have nothing to do with the
 * violation — `file/max-lines`'s "File has 512 lines, over the limit of 500",
 * `skill/frontmatter-schema`'s "…(found 1200)" and `rules/activation.ts`'s "…item 3 is a…" — so
 * an un-normalized key would go stale every time a baselined file grew by one line. That is the
 * whole benefit. (A fourth volatile message, `skill/frontmatter-schema`'s "Unexpected
 * frontmatter key … (allowed: …)", changes when a DIALECT gains a key; no digits are involved
 * and nothing here helps it — it is the cost of keying on the message text, paid on upgrade.)
 *
 * The cost is a coarser key, and it is paid in one direction only: two DIFFERENT violations
 * whose messages differ solely in a digit share one entry, so their counts are pooled. A pooled
 * count can hide *which* of the two a remaining occurrence is; it can never hide that an
 * occurrence exists, because the count still has to add up. Everything else in a message is
 * literal — changing a rule's wording makes its entries stale on upgrade.
 *
 * ## Stale entries are exit 1, not exit 2
 *
 * An entry expecting more occurrences than the repo still produces is a `baseline/stale` error
 * on `skillslurp-baseline.json` itself, and it exits 1 like any other lint finding. ESLint exits
 * 2 for unused suppressions (<https://eslint.org/docs/latest/use/suppressions>, fetched
 * 2026-09-06); this project reserves exit 2 for a crash or a config error, and a baseline
 * that has drifted from the repository is neither — it is a fact about the repository, found by
 * linting it, which is the definition of exit 1 here.
 *
 * The stale diagnostics are produced AFTER suppression and are never candidates for it, so a
 * baseline cannot mute its own staleness guard: an entry filed under `baseline/stale` matches
 * nothing, which makes it stale in its turn. Everything the engine emits IS baselinable
 * otherwise, `config/*` and `parse/frontmatter` included — one rule, no special cases, with the
 * consequence that a baseline can mute a `config/stale-allowlist` guard recorded knowingly
 * (PHPStan's baseline has the same reach).
 *
 * ## Prototype safety
 *
 * A parsed baseline is user data with user-chosen keys. Nothing here ever writes a parsed key
 * into a plain object: the schema's output is copied into `Map`s via `Object.entries` (own
 * enumerable keys only) the moment it is validated, and every lookup afterwards is `Map.get`.
 * Measured against zod 4.4.3 on 2026-09-06: `z.record` DROPS a `__proto__` key entirely (so an
 * entry filed under it is silently absent — it suppresses nothing and reports nothing) and
 * keeps `constructor` as an ordinary key; `Object.prototype` is untouched either way.
 *
 * That drop used to be inert, and no longer is: `--update-baseline` can MINT the key from a
 * repository file, rule id or normalized message literally named `__proto__`, writing it into
 * `skillslurp-baseline.json` in the ordinary course of adopting the tool. The very next plain run
 * then drops it on the way back in — silently, forever — so the entry suppresses nothing and
 * reports no staleness, and nothing in the output explains why. `__proto__` is therefore refused
 * LOUDLY, at the `file`, `ruleId` and `message` levels alike, on both sides: `serializeBaseline`
 * refuses to produce a string containing the key, and `loadBaseline` walks the raw parsed JSON
 * for the key BEFORE the zod parse that would otherwise drop it silently. `constructor` is
 * unaffected by either guard and keeps loading as an ordinary key, as measured above.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Diagnostic, DOCS_URL } from "./diagnostic.js";
import { repoFileRefusal } from "./paths.js";

/**
 * Fixed name, at the repo root, mirroring `skillslurp.json`'s own fixed name. No
 * `--baseline <path>` and no `baseline:` config key — both wait for a consumer that cannot live
 * with one file per linted root.
 */
export const BASELINE_FILENAME = "skillslurp-baseline.json";

/**
 * The rule id every stale-entry diagnostic carries — engine-owned, like `parse/frontmatter` and
 * the `config/` namespace (`CONFIG_REPORT_NAMESPACE`, engine.ts), and not configurable:
 * `rules: { baseline/stale: <anything> }` is rejected by `loadConfig` at exit 2 (measured
 * 2026-09-06).
 *
 * `baseline/` is in `RESERVED_NAMESPACES` (config.ts), which closes both halves. The user-facing
 * half was never the weak one — an id outside the registry was already rejected. The half that
 * was open: `validateRegistry` would have ACCEPTED a
 * BUILT-IN rule registering `baseline/stale`, and a build that did would mint two kinds of
 * diagnostic under one id, with a `rules:` entry that configures only one of them. It is now
 * rejected at registry-validation time, so the id cannot be minted twice by construction rather
 * than by nobody having done it yet.
 */
export const BASELINE_STALE_RULE_ID = "baseline/stale";

/** normalized message → how many occurrences the baseline blesses. Always a positive integer. */
export type BaselineCounts = ReadonlyMap<string, number>;

/** ruleId → its baselined messages. */
export type BaselineRules = ReadonlyMap<string, BaselineCounts>;

/**
 * A loaded, validated baseline. `Map`s rather than the schema's plain records: they cannot be
 * reached through `Object.prototype`, their iteration is explicit, and a missing key is a
 * `Map.get` miss rather than an inherited property (see the module JSDoc's prototype note).
 */
export interface Baseline {
	readonly version: 1;
	readonly files: ReadonlyMap<string, BaselineRules>;
}

/** What `applyBaseline` produces; see its own JSDoc for why `kept` and `stale` stay separate. */
export interface AppliedBaseline {
	/** the diagnostics the baseline did not suppress, in the input's own order */
	readonly kept: readonly Diagnostic[];
	/** how many diagnostics the baseline suppressed — the stderr notice's first number */
	readonly suppressedCount: number;
	/** one `baseline/stale` diagnostic per entry the repository no longer produces */
	readonly stale: readonly Diagnostic[];
}

/**
 * A baseline file that exists but cannot be used: unreadable, not JSON, or not shaped like a
 * baseline. Thrown out of `loadBaseline`, which `runCli` calls OUTSIDE `runEngine` precisely so
 * this reaches the CLI's outer catch as itself — stderr plus exit 2 — instead of being wrapped
 * in a rule-crash message that would blame the engine for a typo in a JSON file.
 */
export class BaselineError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BaselineError";
	}
}

/**
 * `{ version: 1, files: { <file>: { <ruleId>: { <message>: <count> } } } }`, strictly.
 *
 * `strictObject` at the top level so a typo'd key (`file:` for `files:`) is an error rather than
 * a baseline that silently suppresses nothing. `version` is a literal, not a range: a future
 * format change gets a loud "this file was written by a different skillslurp" instead of a
 * best-effort read. `count` is a positive integer — `0` would be an entry that blesses nothing
 * and is therefore permanently stale, which is a mistake worth reporting, not honouring.
 */
const BaselineSchema = z.strictObject({
	version: z.literal(1),
	files: z.record(
		z.string(),
		z.record(z.string(), z.record(z.string(), z.int().positive())),
	),
});

/** Absolute path of the baseline file for a run rooted at `root` (canonical). */
export function baselineFilePath(root: string): string {
	return join(root, BASELINE_FILENAME);
}

/**
 * Every run of ASCII digits → `#`. `\d` in JS is ASCII-only, which is what this wants: a
 * message's digits are counts and limits the engine printed, never localized numerals.
 *
 * `\d+` (a RUN), not `\d` (one digit): `512` must normalize to `#`, not `###`, or a file
 * crossing from 99 to 100 lines would change its own key.
 */
export function normalizeMessage(message: string): string {
	return message.replace(/\d+/g, "#");
}

/**
 * The three-part key as one string. `JSON.stringify` of the triple rather than a joined string:
 * a rule message can contain any character at all, and a separator that can appear inside a part
 * is a separator that can make two different keys collide.
 */
function groupKey(file: string, ruleId: string, message: string): string {
	return JSON.stringify([file, ruleId, message]);
}

/** Bytewise by key — the same `<` comparison `compareDiagnostics` (engine.ts) orders files by. */
function sortedEntries<V>(map: ReadonlyMap<string, V>): [string, V][] {
	return [...map.entries()].sort(([a], [b]) => {
		if (a === b) {
			return 0;
		}
		return a < b ? -1 : 1;
	});
}

interface Candidate {
	/** position in the input array — the last tie-break, so the order is total, not merely stable */
	readonly index: number;
	readonly diagnostic: Diagnostic;
}

/**
 * Orders the occurrences inside ONE key so that "suppress the first N" means the same thing on
 * every run: lowest position first, then message, then input order.
 *
 * `file` and `ruleId` are equal for every member of a group by construction, and the normalized
 * messages are equal too — but the RAW messages need not be (that is what normalization buys),
 * so they are compared here as well. An explicit total order rather than a reliance on the
 * engine's own sort having run first: `applyBaseline` is called with an array, not with a
 * promise that the array is sorted.
 */
function compareInGroup(a: Candidate, b: Candidate): number {
	const lineDiff = (a.diagnostic.line ?? 0) - (b.diagnostic.line ?? 0);
	if (lineDiff !== 0) {
		return lineDiff;
	}
	const colDiff = (a.diagnostic.col ?? 0) - (b.diagnostic.col ?? 0);
	if (colDiff !== 0) {
		return colDiff;
	}
	if (a.diagnostic.message !== b.diagnostic.message) {
		return a.diagnostic.message < b.diagnostic.message ? -1 : 1;
	}
	return a.index - b.index;
}

/**
 * One `baseline/stale` diagnostic. No position: the entry's line in the JSON file is not stable
 * across a regeneration, and the fix is never "edit line 7" but "run `--update-baseline`".
 * `file` is the baseline itself, repo-relative like every other `Diagnostic.file`.
 */
function staleDiagnostic(
	file: string,
	ruleId: string,
	expected: number,
	current: number,
): Diagnostic {
	return {
		ruleId: BASELINE_STALE_RULE_ID,
		severity: "error",
		message: `Baseline entry for rule "${ruleId}" in "${file}" expects ${expected} occurrence(s) but ${current} remain — run \`skillslurp --update-baseline\` to prune it`,
		file: BASELINE_FILENAME,
		fixable: false,
		docsUrl: DOCS_URL,
	};
}

/**
 * Matches `diagnostics` against `baseline` and splits them into what survives and what the
 * baseline blessed.
 *
 * Per key, with N blessed and M produced: the M occurrences are ordered (`compareInGroup`) and
 * the first `min(N, M)` are suppressed — lowest position first, which is the only choice a
 * line-free key leaves open, and a deterministic one. `M − N` excess occurrences stay.
 *
 * Staleness is `N − M > 0`, measured against the diagnostics that came IN, not against what is
 * left after suppression — every match would otherwise erase itself and every entry would read
 * as expecting N and finding 0. A key with no current diagnostics at all (M = 0, e.g. a file
 * that no longer exists) is stale too, which is why the iteration is over the BASELINE's keys
 * rather than over the diagnostics'.
 *
 * `kept` and `stale` come back separately, unmerged and unsorted against each other: merging
 * them is the caller's job (`run.ts`, with the engine's own `compareDiagnostics`), and keeping
 * them apart here is what makes it structurally impossible for a stale diagnostic to be fed back
 * through suppression — the property `run.test.ts` pins. It also keeps this module free of any import
 * from engine.ts, which imports `BASELINE_FILENAME` from here (biome's `noImportCycles` is an
 * error in this repo).
 *
 * `checkStale` is `false` under `--diff-base`: a run that deliberately looks at a subset of
 * the documents cannot tell a pruned entry from an unexamined one.
 */
export function applyBaseline(
	diagnostics: readonly Diagnostic[],
	baseline: Baseline,
	options: { readonly checkStale: boolean },
): AppliedBaseline {
	const groups = new Map<string, Candidate[]>();
	for (const [index, diagnostic] of diagnostics.entries()) {
		const key = groupKey(
			diagnostic.file,
			diagnostic.ruleId,
			normalizeMessage(diagnostic.message),
		);
		const bucket = groups.get(key);
		if (bucket === undefined) {
			groups.set(key, [{ index, diagnostic }]);
		} else {
			bucket.push({ index, diagnostic });
		}
	}

	const suppressed = new Set<number>();
	const stale: Diagnostic[] = [];
	// Sorted at all three levels so the stale list has one deterministic order regardless of the
	// order the keys were written in the file.
	for (const [file, rules] of sortedEntries(baseline.files)) {
		for (const [ruleId, counts] of sortedEntries(rules)) {
			for (const [message, expected] of sortedEntries(counts)) {
				const group = groups.get(groupKey(file, ruleId, message)) ?? [];
				const current = group.length;
				const ordered = [...group].sort(compareInGroup);
				for (const candidate of ordered.slice(0, Math.min(expected, current))) {
					suppressed.add(candidate.index);
				}
				if (options.checkStale && expected > current) {
					stale.push(staleDiagnostic(file, ruleId, expected, current));
				}
			}
		}
	}

	return {
		kept: diagnostics.filter((_, index) => !suppressed.has(index)),
		suppressedCount: suppressed.size,
		stale,
	};
}

/**
 * The inverse of `applyBaseline`'s matching: every diagnostic becomes (or increments) its own
 * key. Used by `--update-baseline` — a full regeneration, never a merge, so what it blesses
 * is exactly what the run just found.
 */
export function buildBaseline(diagnostics: readonly Diagnostic[]): Baseline {
	const files = new Map<string, Map<string, Map<string, number>>>();
	for (const diagnostic of diagnostics) {
		let rules = files.get(diagnostic.file);
		if (rules === undefined) {
			rules = new Map();
			files.set(diagnostic.file, rules);
		}
		let counts = rules.get(diagnostic.ruleId);
		if (counts === undefined) {
			counts = new Map();
			rules.set(diagnostic.ruleId, counts);
		}
		const message = normalizeMessage(diagnostic.message);
		counts.set(message, (counts.get(message) ?? 0) + 1);
	}
	return Object.freeze({ version: 1, files });
}

/** One indentation step of the serialized file: two spaces, JSON's ordinary house style. */
const INDENT = "  ";

/**
 * Refuses a `__proto__` key at any of the three levels before it can reach the string this
 * module hands back to be written. `serializeBaseline` is the one place every write goes
 * through regardless of how the `Baseline` value was built — today always `buildBaseline`, but
 * checking here rather than there means a future caller that assembles a `Baseline` some other
 * way inherits the guard for free instead of having to remember it.
 *
 * The key itself is harmless to a `Map` (there is no accessor to trip, unlike a plain object's
 * `__proto__`) — this is not the prototype-pollution guard, it exists solely so
 * `skillslurp-baseline.json` never ends up holding a key that the read side's own guard, or an
 * older zod, would then drop silently (see the module JSDoc's "Prototype safety" section).
 */
function assertRepresentable(
	level: "file" | "rule id" | "message",
	key: string,
): void {
	if (key === "__proto__") {
		throw new BaselineError(
			`baseline cannot record ${level} "__proto__": the key is not representable in ${BASELINE_FILENAME}`,
		);
	}
}

/**
 * Serializes a baseline: 2-space indent, keys sorted bytewise at every level, one trailing
 * newline — the same file for the same findings on every machine and every run.
 *
 * Written by hand rather than via `JSON.stringify(obj, null, 2)`, and that is not a preference:
 * a plain object hands integer-like keys back FIRST and in numeric order, so a repo with files
 * named `9` and `10` would serialize them as `9, 10` where bytewise order is `10, 9` — the sort
 * would be quietly overruled by the property-order rules of the language. Every key and every
 * count still goes through `JSON.stringify` individually, so escaping is JSON's, not ours.
 */
export function serializeBaseline(baseline: Baseline): string {
	const lines: string[] = ["{", `${INDENT}"version": ${baseline.version},`];
	const fileEntries = sortedEntries(baseline.files);
	if (fileEntries.length === 0) {
		lines.push(`${INDENT}"files": {}`);
	} else {
		lines.push(`${INDENT}"files": {`);
		for (const [fileIndex, [file, rules]] of fileEntries.entries()) {
			assertRepresentable("file", file);
			lines.push(`${INDENT.repeat(2)}${JSON.stringify(file)}: {`);
			const ruleEntries = sortedEntries(rules);
			for (const [ruleIndex, [ruleId, counts]] of ruleEntries.entries()) {
				assertRepresentable("rule id", ruleId);
				lines.push(`${INDENT.repeat(3)}${JSON.stringify(ruleId)}: {`);
				const countEntries = sortedEntries(counts);
				for (const [countIndex, [message, count]] of countEntries.entries()) {
					assertRepresentable("message", message);
					const comma = countIndex === countEntries.length - 1 ? "" : ",";
					lines.push(
						`${INDENT.repeat(4)}${JSON.stringify(message)}: ${count}${comma}`,
					);
				}
				lines.push(
					`${INDENT.repeat(3)}}${ruleIndex === ruleEntries.length - 1 ? "" : ","}`,
				);
			}
			lines.push(
				`${INDENT.repeat(2)}}${fileIndex === fileEntries.length - 1 ? "" : ","}`,
			);
		}
		lines.push(`${INDENT}}`);
	}
	lines.push("}");
	return `${lines.join("\n")}\n`;
}

/**
 * True for a rejection carrying `code: "ENOENT"` — "there is no baseline file", the overwhelming
 * majority of runs, and the one read failure that is not an error. Same shape and same cast
 * justification as `isSkippableReadError` (context.ts).
 */
function isNotFound(err: unknown): boolean {
	if (!(err instanceof Error) || !("code" in err)) {
		return false;
	}
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Renders one zod issue's path as the JSON path a user can find in their file —
 * `files["a.md"]["refs/no-dangling-paths"]["Path # …"]` — rather than as a line number, which a
 * regenerated file would invalidate anyway. The first segment is bare (`files`, `version`) and
 * every later one is bracketed and JSON-quoted, so a key containing a `.` or a `/` (rule ids
 * contain both) cannot be misread as a path separator.
 */
function jsonPath(path: readonly PropertyKey[]): string {
	let rendered = "";
	for (const segment of path) {
		// zod v4 types `issue.path` as `PropertyKey[]`; a symbol segment cannot come from
		// `JSON.parse` output, so dropping it loses nothing (config.ts filters the same way).
		if (typeof segment === "symbol") {
			continue;
		}
		if (rendered.length === 0 && typeof segment === "string") {
			rendered = segment;
			continue;
		}
		rendered += `[${JSON.stringify(segment)}]`;
	}
	return rendered;
}

/** `<json path>: <zod message>` per issue, `; `-joined, in zod's own (deterministic) order. */
function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => {
			const path = jsonPath(issue.path);
			return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
		})
		.join("; ");
}

/**
 * `value` narrowed to a walkable own-keys record, or `undefined` if it is not one. Excludes
 * arrays and `null` even though `typeof` calls both `"object"`, since neither has the shape a
 * `files`/rule-id/message level of a baseline can take — `BaselineSchema` reports that mistake in
 * its own words once `assertNoProtoKey` returns.
 */
function plainRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/**
 * Walks the raw, just-`JSON.parse`d value for a `__proto__` own key at any of the three baseline
 * levels — `files`, then a file's rule ids, then a rule's messages — and throws before
 * `BaselineSchema.safeParse` gets a chance to drop it (module JSDoc, "Prototype safety").
 *
 * `JSON.parse` creates `__proto__` as an ordinary OWN property (measured 2026-09-06:
 * `Object.keys(JSON.parse('{"__proto__":1}'))` is `["__proto__"]` — `JSON.parse` assigns via
 * `[[DefineOwnProperty]]`, never through the inherited accessor `Object.prototype.__proto__`
 * that an ordinary `obj.__proto__ = 1` would trip), which is exactly why this walk sees the key
 * that zod's `z.record` later discards without a trace. `Object.keys` throughout, never `in`: a
 * key is rejected only when it is the parsed object's OWN property, not merely reachable through
 * the prototype chain.
 *
 * Everything else about the shape is left to the schema: a `files` (or deeper level) that is not
 * a walkable record just ends the walk on that branch, since `BaselineSchema.safeParse` reports
 * that mistake in its own words a few lines below. This function's only job is the one failure
 * mode zod cannot see because the key is already gone by the time zod looks.
 */
function assertNoProtoKey(parsed: unknown): void {
	const files = plainRecord(plainRecord(parsed)?.files);
	if (files === undefined) {
		return;
	}
	for (const file of Object.keys(files)) {
		if (file === "__proto__") {
			throw new BaselineError(
				`invalid "${BASELINE_FILENAME}": ${jsonPath(["files", file])}: the key "__proto__" cannot be represented in a baseline`,
			);
		}
		const rules = plainRecord(files[file]);
		if (rules === undefined) {
			continue;
		}
		for (const ruleId of Object.keys(rules)) {
			if (ruleId === "__proto__") {
				throw new BaselineError(
					`invalid "${BASELINE_FILENAME}": ${jsonPath(["files", file, ruleId])}: the key "__proto__" cannot be represented in a baseline`,
				);
			}
			const counts = plainRecord(rules[ruleId]);
			if (counts === undefined) {
				continue;
			}
			for (const message of Object.keys(counts)) {
				if (message === "__proto__") {
					throw new BaselineError(
						`invalid "${BASELINE_FILENAME}": ${jsonPath(["files", file, ruleId, message])}: the key "__proto__" cannot be represented in a baseline`,
					);
				}
			}
		}
	}
}

/**
 * Copies the schema's plain records into `Map`s. `Object.entries` — own enumerable keys only,
 * and nothing inherited — is the whole reason a hostile key in the file cannot become a
 * property of anything this process later reads through a prototype.
 */
function toBaseline(data: z.infer<typeof BaselineSchema>): Baseline {
	const files = new Map<string, BaselineRules>();
	for (const [file, rules] of Object.entries(data.files)) {
		const ruleMap = new Map<string, BaselineCounts>();
		for (const [ruleId, counts] of Object.entries(rules)) {
			ruleMap.set(ruleId, new Map(Object.entries(counts)));
		}
		files.set(file, ruleMap);
	}
	// Frozen because it is handed out of this module and read by two callers (`run.ts`'s notice
	// and `applyBaseline`) — `Readonly<T>` is a type, not a lock (CLAUDE.md). The `Map`s inside
	// are freshly built per load and never shared with a caller that could hold one past the run.
	return Object.freeze({ version: 1, files });
}

/**
 * Reads `<root>/skillslurp-baseline.json` if it is there. A missing file is `undefined` — the
 * normal case, and never an error, since the baseline is opt-in by existence.
 *
 * Every other failure is a `BaselineError` naming the file by its repo-relative name — the same
 * posture `displayPath` gives every other user-facing message here, since a machine-absolute
 * path says nothing extra about a file whose location is fixed — with the underlying cause
 * chained so `formatError` renders it (an errno's own absolute path still comes through THERE,
 * deliberately; see `formatError`).
 * The distinction matters at the CLI: `undefined` means "run without a baseline", while a
 * present-but-broken file stops the run at exit 2 rather than silently linting as though the
 * user had never written one.
 *
 * A path that exists but is not a REGULAR file — a symlink above all, but equally a FIFO, a
 * device or a directory — is refused before a single byte is read, and is the one failure whose
 * message carries no cause: there is nothing about the target the operator should be told. See
 * `repoFileRefusal` (paths.ts) for why, and for the same guard on `skillslurp.json`.
 */
export async function loadBaseline(
	root: string,
): Promise<Baseline | undefined> {
	const file = baselineFilePath(root);
	// Before the read, not after: this path is named by the repository under lint, so a symlink
	// or a FIFO here is content an attacker committed, and `readFile` would follow either — see
	// `repoFileRefusal` for the four disclosure and denial-of-service shapes measured through
	// this exact call. `undefined` covers "absent", which the `isNotFound` branch below still
	// owns as the ordinary no-baseline case.
	const refusal = await repoFileRefusal(file);
	if (refusal !== undefined) {
		throw new BaselineError(
			`refusing to read "${BASELINE_FILENAME}": ${refusal}`,
		);
	}
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		if (isNotFound(err)) {
			return undefined;
		}
		throw new BaselineError(`failed to read "${BASELINE_FILENAME}"`, {
			cause: err,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new BaselineError(`"${BASELINE_FILENAME}" is not valid JSON`, {
			cause: err,
		});
	}
	// Before the zod parse, not after: `z.record` drops a `__proto__` key rather than reporting
	// it, so by the time `safeParse` ran this walk would already be too late (see
	// `assertNoProtoKey` and the module JSDoc's "Prototype safety" section).
	assertNoProtoKey(parsed);
	const result = BaselineSchema.safeParse(parsed);
	if (!result.success) {
		throw new BaselineError(
			`invalid "${BASELINE_FILENAME}": ${formatIssues(result.error.issues)}`,
		);
	}
	return toBaseline(result.data);
}
