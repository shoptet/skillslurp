import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Root, Yaml } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Document as YamlDocument } from "yaml";
import { LineCounter, parseDocument } from "yaml";
import type { ResolvedSurface } from "./config.js";
import type { Loc } from "./diagnostic.js";
import type { DiscoveredFile } from "./discover.js";
import { toPosixPath } from "./paths.js";
import { describeYamlError, errorPos, locFromOffsets } from "./yaml-loc.js";

export interface ParseProblem {
	message: string;
	loc: Loc;
}

export interface Frontmatter {
	/** yaml source without the `---` fences */
	readonly raw: string;
	/** mdast node covering the whole block, fences included */
	readonly node: Yaml;
	/** yaml AST with source ranges retained */
	readonly doc: YamlDocument;
	/**
	 * doc.toJS() — may be null or a non-mapping; rules must not assume an object.
	 * May also be CYCLIC (yaml anchors, e.g. `a: &x\n  b: *x` resolve so that
	 * `js.a.b === js.a`): consumers must not deep-walk this without a visited set.
	 * `undefined` means `toJS()` threw (see `errors`) — e.g. an unresolved alias or
	 * an alias-count bomb.
	 */
	readonly data: unknown;
	/** add to yaml-local line numbers to get file lines */
	readonly lineOffset: number;
	readonly lineCounter: LineCounter;
	/** yaml syntax errors, already mapped to file coordinates */
	readonly errors: readonly ParseProblem[];
}

export interface Document {
	/** repo-relative, posix */
	readonly path: string;
	readonly absPath: string;
	readonly raw: string;
	/** mdast with positions */
	readonly ast: Root;
	readonly frontmatter: Frontmatter | null;
	/** the surface that claimed this file, and with it the dialects it is checked against */
	readonly surface: ResolvedSurface;
}

/** Single module-level processor: parse-only (no stringify/run), so it is safe to reuse. */
const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/**
 * Maps a yaml-source offset range (a yaml AST node's `range`, or a yaml error's `pos`) to
 * file coordinates, using the frontmatter's line counter and fence-line offset.
 */
export function locFromRange(
	fm: Frontmatter,
	range: readonly [number, number] | readonly [number, number, number],
): Loc {
	return locFromOffsets(fm.lineCounter, fm.lineOffset, range);
}

function parseFrontmatter(node: Yaml): Frontmatter {
	if (!node.position) {
		// remark always attaches positions when parsing with default settings; a missing
		// position here means the processor was misconfigured, not a document to report on.
		throw new Error(
			"remark-frontmatter yielded a yaml node without a position",
		);
	}
	const lineOffset = node.position.start.line;
	const lineCounter = new LineCounter();
	// prettyErrors: false keeps ParseProblem.message a plain single-line string; the
	// multi-line pretty format embeds yaml-local line numbers that would contradict the
	// file-coordinate `loc` we compute via locFromOffsets below. logLevel: "error" stops
	// yaml from printing a bare "Warning: ..." + stack trace straight to stderr for things
	// like collection keys — nothing surfaces those warnings, deliberately (see the doc.warnings
	// note below; `Frontmatter` carries no `warnings` field), so letting yaml print them would be
	// output no caller asked for and no reporter owns.
	const doc = parseDocument(node.value, {
		lineCounter,
		prettyErrors: false,
		logLevel: "error",
	});
	const errors: ParseProblem[] = doc.errors.map((err) =>
		describeYamlError(node.value, err, lineCounter, lineOffset),
	);
	// doc.warnings (e.g. TAG_RESOLVE_FAILED) are intentionally ignored for now.

	let data: unknown;
	try {
		// maxAliasCount guards against alias-bomb inputs; without it (and without this
		// try/catch) an unresolved alias or an excessive alias count throws out of toJS()
		// and crashes the caller instead of producing a diagnosable ParseProblem.
		data = doc.toJS({ maxAliasCount: 100 });
	} catch (err) {
		data = undefined;
		const pos = errorPos(err);
		errors.push({
			message: err instanceof Error ? err.message : String(err),
			loc: pos
				? locFromOffsets(lineCounter, lineOffset, pos)
				: { line: node.position.start.line, col: 1 },
		});
	}

	return Object.freeze({
		raw: node.value,
		node,
		doc,
		data,
		lineOffset,
		lineCounter,
		// Frozen, unlike `doc` and `data`: the engine skips every rule on a document whose
		// `errors` is non-empty, so a rule appending to another document's errors would both
		// fabricate a diagnostic and silence that document. Plain objects in a plain array, so
		// none of the reasons the freeze stays shallow elsewhere apply here.
		errors: Object.freeze(errors),
	});
}

/**
 * Surface-free parse of a markdown source: the mdast tree only, frontmatter node included. For a
 * file that belongs to no surface and so cannot become a `Document` (a `CLAUDE.md` read by path);
 * `parseSource` builds on it, so both see the same tree.
 */
export function parseMarkdown(raw: string): Root {
	// parse-only processor: `parse` always yields a Root
	return processor.parse(raw) as Root;
}

/**
 * Pure parse from an in-memory source string; no filesystem access.
 *
 * The returned `Document` and its `Frontmatter` are **shallow**-frozen. That kills
 * the realistic poison vector — one rule reassigning `doc.path` or `doc.frontmatter` and every
 * later rule seeing the lie — at no risk. A deep freeze was rejected: `frontmatter.doc` is a
 * yaml `Document` with internal state that freezing would break, and `frontmatter.data` may be
 * cyclic. Mutating a node inside the mdast or yaml tree therefore remains possible; every rule
 * is in-house in v1, and the day that changes this is the boundary to revisit.
 */
export function parseSource(
	path: string,
	absPath: string,
	raw: string,
	surface: ResolvedSurface,
): Document {
	const ast = parseMarkdown(raw);
	const first = ast.children[0];
	const frontmatter =
		first && first.type === "yaml" ? parseFrontmatter(first) : null;
	return Object.freeze({ path, absPath, raw, ast, frontmatter, surface });
}

/**
 * Thin wrapper around `parseSource`: resolves `file.path` against `root` (node:path
 * `resolve`) to read the file, and normalizes it (strip a leading `./`, collapse internal
 * `..`, posix separators) into a clean repo-relative `Document.path` — a stable key for
 * reporters and the baseline file. The surface travels with the path from discovery.
 */
export async function readDocument(
	root: string,
	file: DiscoveredFile,
): Promise<Document> {
	const absPath = resolve(root, file.path);
	const raw = await readFile(absPath, "utf8");
	// `paths.ts`'s shared implementation, not a second copy of it: this line used to spell out
	// `normalize(...).split(sep).join("/")` verbatim, which is exactly the divergent local copy
	// that module's own JSDoc forbids. No cycle to avoid — `paths.ts` imports nothing
	// project-local.
	const path = toPosixPath(file.path);
	return parseSource(path, absPath, raw, file.surface);
}
