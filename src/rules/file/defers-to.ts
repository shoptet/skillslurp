import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import type { Nodes, Root } from "mdast";
import picomatch from "picomatch";
import { z } from "zod";
import type { RepoRuleContext } from "../../context.js";
import { DOCS_URL, type Loc } from "../../diagnostic.js";
import { parseMarkdown } from "../../document.js";
import { collectImports, type Import, resolveImport } from "../../imports.js";
import { pathKey, repoRelative } from "../../paths.js";
import {
	type ConfigReport,
	freezeRule,
	type Report,
	type RuleReport,
	type ShapeRule,
} from "../../rule.js";
import {
	CHECKED_OUT_AS_FILE,
	climbsOutOfRoot,
	inspectLink,
	type LinkState,
	placeInIndex,
	SYMLINK_MODE,
	type SymlinkState,
} from "../../symlinks.js";
import { normalizeConfiguredPath } from "../configured-document.js";

/** Same options discovery matches with; see `activation/no-unmatched-globs` for the measurements. */
const MATCH_OPTIONS = Object.freeze({ dot: true, posix: true });

const UNMATCHED_PAIR = "unmatched-pair";

const CANONICAL_OUTSIDE = "canonical-outside";

const GITLINK_MODE = "160000";

const UNCOMPUTABLE = /[([\\]/;

const MAX_ALTERNATIVES = 256;

/**
 * The alternatives of the non-nested `{a,b}` groups in `glob`, or undefined for anything else a
 * brace can be (nested, a range, a single item, unbalanced) or for more than `MAX_ALTERNATIVES`.
 */
function expandBraces(glob: string): readonly string[] | undefined {
	const open = glob.indexOf("{");
	const close = glob.indexOf("}");
	if (open === -1 && close === -1) {
		return [glob];
	}
	if (open === -1 || close < open) {
		return undefined;
	}
	const inner = glob.slice(open + 1, close);
	if (inner.includes("{") || !inner.includes(",")) {
		return undefined;
	}
	const head = glob.slice(0, open);
	const tail = glob.slice(close + 1);
	const expanded: string[] = [];
	for (const alternative of inner.split(",")) {
		const rest = expandBraces(head + alternative + tail);
		if (rest === undefined) {
			return undefined;
		}
		expanded.push(...rest);
		if (expanded.length > MAX_ALTERNATIVES) {
			return undefined;
		}
	}
	return expanded;
}

function plainDepth(glob: string): number {
	const named = glob
		.split("/")
		.filter((part) => part !== "" && part !== "." && part !== "**").length;
	return Math.max(0, named - 1);
}

/**
 * How many directories below the repository root the shallowest file `glob` can match sits, or
 * undefined when that cannot be told. A lower bound, never an over-estimate: a `**` segment may
 * match nothing, and the least depth across the alternatives of a simple brace group is taken.
 * Negation, an extglob or other group (`(`), a bracket expression (`[`) and an escape (`\`) can
 * hide a `/`, so a glob using one has no computable depth, and neither does a brace group that is
 * nested, a range, or expands to too many alternatives.
 */
function shallowestDepth(glob: string): number | undefined {
	if (glob.startsWith("!") || UNCOMPUTABLE.test(glob)) {
		return undefined;
	}
	const alternatives = expandBraces(glob);
	if (alternatives === undefined) {
		return undefined;
	}
	return Math.min(...alternatives.map(plainDepth));
}

const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

/** Not `win32.isAbsolute`: in a glob a leading backslash is an escape (`\[draft\]/CLAUDE.md`), not a root. */
function isAbsoluteGlob(glob: string): boolean {
	return posix.isAbsolute(glob) || DRIVE_LETTER.test(glob);
}

function escapesRepository(path: string): boolean {
	return posix.isAbsolute(path) || path === ".." || path.startsWith("../");
}

function leadingClimbs(path: string): number {
	let climbs = 0;
	for (const part of path.split("/")) {
		if (part !== "..") {
			break;
		}
		climbs += 1;
	}
	return climbs;
}

const PairSchema = z
	.strictObject({
		files: z
			.string()
			.min(1)
			.refine((glob) => !glob.includes("\0"), {
				message: "must not contain a NUL byte",
			})
			.refine((glob) => !isAbsoluteGlob(glob), {
				message: "must be relative to the repository root, not absolute",
			}),
		canonical: z
			.string()
			.min(1)
			.refine((path) => !path.includes("\0"), {
				message: "must not contain a NUL byte",
			})
			.refine((path) => !win32.isAbsolute(normalizeConfiguredPath(path)), {
				message:
					"must be relative to the directory of each matched file, not absolute",
			}),
		allow: z.enum(["either", "symlink", "import"]).default("either"),
	})
	.superRefine((pair, ctx) => {
		const climbs = leadingClimbs(normalizeConfiguredPath(pair.canonical));
		if (climbs === 0) {
			return;
		}
		const levels = `${climbs} level${climbs === 1 ? "" : "s"}`;
		const depth = shallowestDepth(pair.files);
		if (depth === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["canonical"],
				message: `climbs ${levels} up, but the depth of the files this "files" glob can match cannot be computed (it uses negation, an extglob, an escape, a bracket expression or braces that are not simple {a,b} groups), so the path might leave the repository`,
			});
		} else if (climbs > depth) {
			ctx.addIssue({
				code: "custom",
				path: ["canonical"],
				message: `climbs ${levels} up, but "files" can match a file only ${depth} level${depth === 1 ? "" : "s"} below the repository root, so the path would leave the repository`,
			});
		}
	});

export const OptionsSchema = z.strictObject({
	pairs: z.array(PairSchema).min(1),
});
export type Options = z.infer<typeof OptionsSchema>;
type Pair = Options["pairs"][number];

interface Finding {
	readonly reason: string;
	readonly loc?: Loc;
}

function finding(reason: string, loc?: Loc): Finding {
	const found: { reason: string; loc?: Loc } = { reason };
	if (loc !== undefined) {
		found.loc = loc;
	}
	return found;
}

interface Scope {
	readonly root: string;
	readonly modes: ReadonlyMap<string, string>;
	readonly pair: Pair;
}

const NO_INDENT = /[^ \t]/;

const COMMENTS_ONLY = /^\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/;

/**
 * Requires every file a pair's `files` glob matches to defer to a canonical file next to it, so
 * that one file holds the instructions and the others only point at it: `CLAUDE.md` deferring to
 * `AGENTS.md`, say. Opt-in (`tiers: []`) with a required option, `pairs`; repository-wide (a
 * `shape` rule), so it is configured in the top-level `rules` only:
 *
 * ```json
 * {
 *   "rules": {
 *     "file/defers-to": {
 *       "options": { "pairs": [{ "files": "**\/CLAUDE.md", "canonical": "AGENTS.md" }] }
 *     }
 *   }
 * }
 * ```
 *
 * A file defers in one of two forms: it is a symlink to the canonical file, or it holds nothing
 * but one `@import` of it. A pair's `allow` narrows that to `"symlink"` or `"import"`; the
 * default is `"either"`. `canonical` is a path relative to the directory of EACH matched file, so
 * `packages/a/CLAUDE.md` defers to `packages/a/AGENTS.md`. A matched file that is the canonical
 * file itself is skipped. Files under the top-level `ignore` are skipped; the ignored files
 * still count as matches for the "matches nothing" problem below.
 *
 * Vendor facts, from https://code.claude.com/docs/en/memory, fetched 2026-09-30:
 *
 * - "Relative paths resolve relative to the file containing the import, not the working
 *   directory." "A path wrapped in quotes isn't imported at all."
 * - A `CLAUDE.md` holding `@AGENTS.md` next to an `AGENTS.md`, and `ln -s AGENTS.md CLAUDE.md`,
 *   are both documented ways to keep `AGENTS.md` as the one file every tool shares.
 * - On Windows, "Git checks a committed symlink out as a plain text file unless `core.symlinks`
 *   is enabled". The page's own example puts Claude-specific text below the import; requiring
 *   the import to be the file's only content is this rule's choice, not the vendor's.
 * - "Block-level HTML comments (`<!-- maintainer notes -->`) in CLAUDE.md files are stripped
 *   before the content is injected into Claude's context." So a top-level HTML block that holds
 *   nothing but comments is not content here; any other HTML, and a comment inside a paragraph,
 *   is.
 *
 * What gets reported, per pair in order, then per file in path order. The pair's glob matching no
 * tracked file at all is a `config/unmatched-pair` problem, not a diagnostic. For a file,
 * at most one of the canonical file's problems, else the problems of the form the file is in.
 * That form is what git committed (index mode 120000, looked up under the file's real parent),
 * not what is on disk:
 *
 * - the canonical file does not exist or cannot be inspected, is a symlink that does not resolve
 *   or leads outside the linted directory (or whose target text climbs out of it on the way),
 *   resolves to a directory (itself, or through a link), is
 *   outside the linted directory, or is not tracked by git. Tracked-ness is
 *   asked of git's index under the canonical file's real parent, so a canonical reached through a
 *   committed directory link counts. A pair whose `canonical` resolves outside the repository for
 *   some matched file is a `config/canonical-outside` problem, once per pair, and the filesystem
 *   is not asked about that path;
 * - a symlink in git's index that is a regular file on disk (the change is not staged, or
 *   `core.symlinks` was off at checkout), before the form is judged;
 * - the form is not allowed by `allow`;
 * - a symlink with an absolute target; one that does not resolve; one that resolves outside the
 *   linted directory, or whose target text climbs out of it on the way; one that resolves inside
 *   it to something other than the canonical file. Both ends are compared by `realpath`, so a
 *   chain of links, or a canonical file that is itself a link, still counts. The comparison runs
 *   on the filesystem the linter runs on: on a case-insensitive one a mis-cased target resolves;
 * - a regular file with no `@import`, with several, or with content besides the one import and
 *   blank lines, reported at the first such line. The text is read after a BOM is dropped and
 *   line endings are normalized. `collectImports` decides what an import is, so one inside a
 *   fenced block or code span is not one; a file holding only that has no import. A `- @x.md`
 *   list item, or `@x.md.` with its trailing dot, carries extra content. The import must resolve
 *   to the canonical file (compared by resolved path, then by `realpath`), not to a `~/` path or a
 *   path outside the repository, and its path must be relative, like a symlink target, even when an
 *   absolute one resolves to the canonical file. It must not hold a NUL byte, which is reported
 *   without the filesystem being asked;
 * - a matched file whose parent directory resolves outside the linted directory, or a
 *   regular-file entry that is a symlink on disk, is reported and never read.
 *
 * `files` and `canonical` are validated when the config loads: no NUL byte, not absolute, and
 * `canonical` may climb with `..` no further than the shallowest file `files` can match is deep.
 * That depth is taken as the least over the alternatives of simple `{a,b}` groups; a glob with
 * negation, `(`, `[` or `\`, or a group that is nested, a range or very large, has no computable
 * depth and admits no climbing `canonical`.
 *
 * A tracked entry that is missing from the working tree, is a directory there, or is a gitlink
 * (a submodule) has nothing to judge and is skipped.
 */
export const fileDefersTo: ShapeRule<Options> = freezeRule({
	kind: "shape",
	meta: {
		id: "file/defers-to",
		description:
			"A configured file that does not defer to its canonical file (for instance `CLAUDE.md` to `AGENTS.md`) by being a symlink to it or holding only an `@import` of it.",
		docsUrl: DOCS_URL,
		tiers: [],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	async check(ctx: RepoRuleContext<Options>): Promise<Report[]> {
		const tracked = await ctx.git.trackedFiles();
		const scopeBase = {
			root: ctx.root,
			modes: await ctx.git.trackedModes(),
		};
		const reports: Report[] = [];
		for (const [index, pair] of ctx.options.pairs.entries()) {
			const matches = picomatch(pair.files, MATCH_OPTIONS);
			const matched = tracked.filter((path) => matches(path));
			if (matched.length === 0) {
				reports.push(unmatchedPair(index, pair));
				continue;
			}
			const canonical = normalizeConfiguredPath(pair.canonical);
			const scope: Scope = { ...scopeBase, pair };
			const candidates = matched
				.filter((path) => !ctx.isIgnored(path))
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			let escaped = false;
			for (const file of candidates) {
				const target = posix.join(posix.dirname(file), canonical);
				if (escapesRepository(target)) {
					if (!escaped) {
						reports.push(canonicalOutside(index, pair, file));
						escaped = true;
					}
					continue;
				}
				if (pathKey(target) === pathKey(file)) {
					continue;
				}
				for (const item of await checkFile(scope, file, target)) {
					const report: RuleReport = {
						message: `File "${file}" does not defer to "${target}": ${item.reason}`,
						file,
					};
					if (item.loc !== undefined) {
						report.loc = item.loc;
					}
					reports.push(report);
				}
			}
		}
		return reports;
	},
});

function unmatchedPair(index: number, pair: Pair): ConfigReport {
	return {
		problem: UNMATCHED_PAIR,
		message: `Pair ${index + 1} of "file/defers-to" (files "${pair.files}", canonical "${pair.canonical}") matches no tracked file`,
	};
}

function canonicalOutside(
	index: number,
	pair: Pair,
	file: string,
): ConfigReport {
	return {
		problem: CANONICAL_OUTSIDE,
		message: `Pair ${index + 1} of "file/defers-to" (files "${pair.files}", canonical "${pair.canonical}") resolves to a path outside the repository for "${file}"`,
	};
}

async function checkFile(
	scope: Scope,
	file: string,
	canonical: string,
): Promise<Finding[]> {
	const { root, pair } = scope;
	const state = await inspectLink(root, file);
	if (
		state.disk === "missing" ||
		state.disk === "directory" ||
		state.disk === "other"
	) {
		return [];
	}
	const placed = await placeInIndex(root, file);
	if (!placed.inside) {
		return [
			finding(
				`it is outside the linted directory (its parent directory resolves to "${repoRelative(root, placed.parent)}")`,
			),
		];
	}
	const mode = scope.modes.get(placed.key);
	if (mode === GITLINK_MODE) {
		return [];
	}
	const missing = await canonicalProblem(scope, canonical);
	if (missing !== undefined) {
		return [finding(missing)];
	}
	if (mode === SYMLINK_MODE) {
		if (state.disk !== "symlink") {
			return [finding(`it ${CHECKED_OUT_AS_FILE}`)];
		}
		if (pair.allow === "import") {
			return [
				finding(
					'it is a symlink, but this pair allows only a file whose sole content is an @import (allow: "import")',
				),
			];
		}
		return await symlinkFindings(root, placed.parent, state, canonical);
	}
	if (state.disk === "symlink") {
		return [
			finding(
				"it is a symlink on disk but git tracks it as a regular file; commit the change or restore the file",
			),
		];
	}
	if (pair.allow === "symlink") {
		return [
			finding(
				'it is a regular file, but this pair allows only a symlink (allow: "symlink")',
			),
		];
	}
	return await importFindings(root, file, canonical);
}

async function isDirectoryOnDisk(state: LinkState): Promise<boolean> {
	if (state.disk === "directory") {
		return true;
	}
	if (state.disk !== "symlink" || state.real === undefined) {
		return false;
	}
	return (await stat(state.real)).isDirectory();
}

async function canonicalProblem(
	scope: Scope,
	canonical: string,
): Promise<string | undefined> {
	const { root, modes } = scope;
	try {
		const state = await inspectLink(root, canonical);
		if (state.disk === "missing") {
			return "the canonical file does not exist";
		}
		if (state.disk === "symlink" && state.real === undefined) {
			return `the canonical file is a symlink that does not resolve ("${state.target}")`;
		}
		if (state.disk === "symlink") {
			const { parent } = await placeInIndex(root, canonical);
			if (state.escapes || climbsOutOfRoot(root, parent, state.target)) {
				return `the canonical file is a symlink that leads outside the linted directory ("${state.target}")`;
			}
		}
		if (await isDirectoryOnDisk(state)) {
			return "the canonical path is a directory, not a file";
		}
		const placed = await placeInIndex(root, canonical);
		if (!placed.inside) {
			return `the canonical file is outside the linted directory (its parent directory resolves to "${repoRelative(root, placed.parent)}")`;
		}
		if (!modes.has(placed.key)) {
			return "the canonical file is not tracked by git";
		}
		return undefined;
	} catch {
		return "the canonical file cannot be inspected";
	}
}

async function realPathOf(path: string): Promise<string | undefined> {
	return await realpath(path).catch(() => undefined);
}

async function symlinkFindings(
	root: string,
	parent: string,
	state: SymlinkState,
	canonical: string,
): Promise<Finding[]> {
	const found: Finding[] = [];
	if (isAbsolute(state.target)) {
		found.push(
			finding(
				`it is a symlink with the absolute target "${state.target}"; use a relative target so the link stays valid in every checkout`,
			),
		);
	}
	if (state.real === undefined) {
		found.push(
			finding(`it points at "${state.target}", which does not resolve`),
		);
	} else if (state.escapes || climbsOutOfRoot(root, parent, state.target)) {
		found.push(
			finding(
				`it points at "${state.target}", which is outside the linted directory`,
			),
		);
	} else if (state.real !== (await realPathOf(resolve(root, canonical)))) {
		found.push(
			finding(`it points at "${repoRelative(root, state.real)}" instead`),
		);
	}
	return found;
}

async function importFindings(
	root: string,
	file: string,
	canonical: string,
): Promise<Finding[]> {
	const fileAbs = resolve(root, file);
	const raw = await readFile(fileAbs, "utf8");
	const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(
		/\r\n?/g,
		"\n",
	);
	const ast = parseMarkdown(text);
	const lines = withoutComments(text, ast).split("\n");
	const imports = collectImports(ast, text);
	const [first, second] = imports;
	if (first === undefined) {
		const reason = hasIndentedImport(ast, text)
			? "its only @import is inside an indented code block; unindent it"
			: "it contains no @import";
		return [finding(reason, firstContent(lines))];
	}
	if (second !== undefined) {
		return [
			finding(
				`it contains ${imports.length} @imports; it must contain exactly one`,
				second.loc,
			),
		];
	}
	const found: Finding[] = [];
	for (const wrong of await importProblems(
		root,
		fileAbs,
		resolve(root, canonical),
		first,
	)) {
		found.push(finding(wrong, first.loc));
	}
	const extra = extraContent(lines, first.loc);
	if (extra !== undefined) {
		found.push(
			finding(
				"it holds more than the @import; only blank lines may accompany it",
				extra,
			),
		);
	}
	return found;
}

const CODE_FENCE = /^(?:`{3,}|~{3,})/;
const SINGLE_IMPORT = /^@(?:\\ |\S)+$/;

function hasIndentedImport(node: Nodes, text: string): boolean {
	if (node.type === "code") {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		return (
			start !== undefined &&
			end !== undefined &&
			!CODE_FENCE.test(text.slice(start, end)) &&
			SINGLE_IMPORT.test(node.value.trim())
		);
	}
	return (
		"children" in node &&
		node.children.some((child) => hasIndentedImport(child, text))
	);
}

/** `text` with each top-level HTML comment block blanked out, newlines kept so positions still line up. */
function withoutComments(text: string, ast: Root): string {
	let masked = "";
	let at = 0;
	for (const node of ast.children) {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			node.type === "html" &&
			COMMENTS_ONLY.test(node.value) &&
			start !== undefined &&
			end !== undefined
		) {
			masked +=
				text.slice(at, start) + text.slice(start, end).replace(/[^\n]/g, " ");
			at = end;
		}
	}
	return masked + text.slice(at);
}

async function importProblems(
	root: string,
	fileAbs: string,
	canonicalAbs: string,
	imp: Import,
): Promise<string[]> {
	if (imp.path.includes("\0")) {
		return [
			`its import "@${imp.spec.replaceAll("\0", "\\0")}" contains a NUL byte`,
		];
	}
	const target = resolveImport(imp.path, fileAbs, root);
	if (target.kind === "home") {
		return [
			`it imports "@${imp.spec}", a path in the home directory, which differs per machine`,
		];
	}
	const problems: string[] = [];
	if (isAbsolute(imp.path)) {
		problems.push(
			`it imports "@${imp.spec}", an absolute path; use a relative path so the import stays valid in every checkout`,
		);
	}
	if (target.kind === "outside") {
		problems.push(`it imports "@${imp.spec}", which is outside the repository`);
		return problems;
	}
	if (target.absPath === canonicalAbs) {
		return problems;
	}
	const real = await realPathOf(target.absPath);
	if (real !== undefined && real === (await realPathOf(canonicalAbs))) {
		return problems;
	}
	problems.push(
		`it imports "${repoRelative(root, target.absPath)}" (written as "@${imp.spec}") instead`,
	);
	return problems;
}

function firstContent(lines: readonly string[]): Loc | undefined {
	for (const [index, line] of lines.entries()) {
		const col = line.search(NO_INDENT);
		if (col >= 0) {
			return { line: index + 1, col: col + 1 };
		}
	}
	return undefined;
}

/** The first position holding anything but spaces and tabs once the import's own span is set aside. */
function extraContent(lines: readonly string[], span: Loc): Loc | undefined {
	for (const [index, line] of lines.entries()) {
		const number = index + 1;
		if (number !== span.line) {
			const col = line.search(NO_INDENT);
			if (col >= 0) {
				return { line: number, col: col + 1 };
			}
			continue;
		}
		const before = line.slice(0, span.col - 1).search(NO_INDENT);
		if (before >= 0) {
			return { line: number, col: before + 1 };
		}
		const endCol = span.endCol ?? span.col;
		const after = line.slice(endCol - 1).search(NO_INDENT);
		if (after >= 0) {
			return { line: number, col: endCol + after };
		}
	}
	return undefined;
}
