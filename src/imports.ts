import { dirname, resolve } from "node:path";
import type { Nodes, Root, RootContent, Text } from "mdast";
import type { Loc } from "./diagnostic.js";
import { trimTrailingPunctuation } from "./mentions.js";
import { isWithinRoot } from "./paths.js";

/**
 * `@path` imports in a markdown document, the way Claude Code documents them, and a resolver for
 * one import's target. Shared by the rules that check `CLAUDE.md`-style files.
 *
 * Vendor facts, from https://code.claude.com/docs/en/memory, fetched 2026-09-29 and re-fetched
 * 2026-09-30 (the page's dateModified is 2026-09-30); the last two are as of the second fetch:
 *
 * - "CLAUDE.md files can import additional files using `@path/to/import` syntax."
 * - "Both relative and absolute paths are allowed. Relative paths resolve relative to the file
 *   containing the import, not the working directory. Imported files can recursively import other
 *   files, with a maximum depth of four hops."
 * - "Import parsing skips Markdown code spans and fenced code blocks. To mention a path in your
 *   CLAUDE.md without importing it, wrap it in backticks"
 * - A home import appears in an example: `@~/.claude/my-project-instructions.md`.
 * - "Block-level HTML comments (`<!-- maintainer notes -->`) in CLAUDE.md files are stripped
 *   before the content is injected into Claude's context."
 * - "To import a file whose path contains spaces, put a backslash before each space. Without the
 *   backslashes, the path ends at the first space, even when the import is on a line of its own. A
 *   path wrapped in quotes isn't imported at all, with or without the backslashes."
 * - "To pull in a README, package.json, and a workflow guide, reference them with `@` syntax
 *   anywhere in your CLAUDE.md"
 *
 * Not documented, so each is a reading pinned by a test rather than claimed as behaviour. Where
 * one is a choice between a narrower and a wider reading it is the narrower (fewer imports, never
 * an invented one), except the first:
 *
 * - Whether an `@` inside a heading or link text counts. It does, the wider reading, taken from
 *   "anywhere in your CLAUDE.md" above; both are `text` nodes.
 * - What a missing target does. Nothing here touches the filesystem; the caller decides what
 *   "exists" means, and how deep to follow imports.
 * - Whether anything but whitespace ends a path. A quote or a backtick does, and trailing sentence
 *   punctuation is trimmed.
 * - Whether `@` right after punctuation (`(@x.md)`, `**@x.md**`, `[@x.md](u)`, `me@example.com`),
 *   an escaped `\@`, or a character reference spelling `@` starts an import. None does: only
 *   `@` at the start of a line or after whitespace.
 * - Whether an inline HTML comment hides an import, and whether an indented code block does. Both
 *   do: neither is a `text` node.
 * - Whether `~user/x.md` or a bare `~` is a home path. Neither is; only `~/` is.
 *
 * The `@` has to sit in a `text` node, and its position is read from that node's SOURCE text
 * rather than its decoded `value`, for two reasons measured 2026-09-30 against document.ts's own
 * processor: `value` drops a list item's or blockquote's continuation-line prefix and decodes
 * escapes and character references, so a column computed from it is wrong after either; and the
 * character in front of an `@` is only visible in the source. The path after it is read from the
 * source too, past the node's end when emphasis markers sit inside it (`@a/_b_/c.md`), so `spec`
 * is verbatim: an escape (`@a\_b.md`) keeps its backslash, and glob-like characters (`*?[]{}$`, and
 * a `<` that does not open an inline HTML tag) stay in it for a consumer rule to judge. The one
 * escape read is `\ `, which `path` decodes.
 */

/** One `@path` import: the path as written, the path as read, and where `@path` sits in the source. */
export interface Import {
	/** after the `@`, trailing punctuation trimmed, verbatim: a `\ ` is still a backslash and a space */
	readonly spec: string;
	/** `spec` with each `\ ` read as a space: what `resolveImport` takes, never resolved here */
	readonly path: string;
	/** covers `@spec`; `endCol` is exclusive, like mdast's */
	readonly loc: Loc;
}

// A backslash-escaped space is part of the path; any other whitespace, a quote or a backtick ends it.
const IMPORT_RUN = /^(?:\\ |[^\s`'"])+/;

const ESCAPED_SPACE = /\\ /g;

const LINE_BREAK = /\r\n|\r|\n/g;

function startsToken(source: string, offset: number): boolean {
	return offset === 0 || /\s/.test(source.charAt(offset - 1));
}

// The only siblings whose markers can sit inside a path; a link, image, code span or HTML node ends it.
function continuesPath(node: RootContent): boolean {
	return (
		node.type === "text" || node.type === "emphasis" || node.type === "strong"
	);
}

/**
 * The run after the `@` at `at`, read from `source` up to `limit`, the end of the text node the `@`
 * is in. A run that reaches `limit` goes on through the next sibling when it starts right there
 * and is text or emphasis, so `@a/_b_/c.md` is one path; it never goes past the closing marker of
 * the enclosing node, so `**see @a.md**` is `a.md`.
 */
function readRun(
	source: string,
	at: number,
	limit: number,
	siblings: readonly RootContent[],
	next: number,
): string {
	let end = limit;
	let index = next;
	for (;;) {
		const run = IMPORT_RUN.exec(source.slice(at + 1, end))?.[0] ?? "";
		const sibling = siblings[index];
		const position = sibling?.position;
		if (
			at + 1 + run.length < end ||
			sibling === undefined ||
			!continuesPath(sibling) ||
			position?.start.offset !== end ||
			position.end.offset === undefined
		) {
			return run;
		}
		end = position.end.offset;
		index += 1;
	}
}

/** `covered` is the source offset the last import's run reached, so a later `@` inside it is not one. */
interface Scan {
	readonly found: Import[];
	covered: number;
}

function scanText(
	node: Text,
	siblings: readonly RootContent[],
	index: number,
	source: string,
	scan: Scan,
): void {
	const start = node.position?.start;
	const end = node.position?.end;
	if (
		!start ||
		!end ||
		start.offset === undefined ||
		end.offset === undefined
	) {
		// remark always attaches offsets when parsing with default settings; a missing one means the
		// tree did not come from document.ts's processor.
		throw new Error("remark yielded a text node without a source offset");
	}
	const slice = source.slice(start.offset, end.offset);
	const breaks = slice.matchAll(LINE_BREAK);
	let pending = breaks.next();
	let line = start.line;
	// Slice index where the current line's column 1 would sit; only the first line's is negative.
	let origin = 1 - start.column;
	for (const match of slice.matchAll(/@/g)) {
		const at = start.offset + match.index;
		if (at < scan.covered || !startsToken(source, at)) {
			continue;
		}
		const run = readRun(source, at, end.offset, siblings, index + 1);
		const spec = trimTrailingPunctuation(run);
		if (spec === "") {
			continue;
		}
		scan.covered = at + 1 + run.length;
		while (
			!pending.done &&
			pending.value.index + pending.value[0].length <= match.index
		) {
			line += 1;
			origin = pending.value.index + pending.value[0].length;
			pending = breaks.next();
		}
		const col = match.index - origin + 1;
		scan.found.push(
			Object.freeze({
				spec,
				path: spec.replace(ESCAPED_SPACE, " "),
				loc: Object.freeze({
					line,
					col,
					endLine: line,
					endCol: col + 1 + spec.length,
				}),
			}),
		);
	}
}

/**
 * Every `@path` import in the tree, in document order.
 *
 * Walks the tree and scans `text` nodes only, so code spans, fenced and indented code blocks, HTML
 * (comments included), frontmatter and image alt text are excluded by construction, not by a
 * filter that could miss a node type.
 *
 * An import is `@` at the start of the file, at the start of a line, or after whitespace, then a
 * non-empty run of characters up to the next whitespace, backtick or quote, minus trailing
 * `.,;:)]>`; a backslash before a space keeps the space in the run. The run continues through
 * emphasis markers (`@a*b*c.md` is `a*b*c.md`) but not past the closing marker of the node the `@`
 * is in (`*see @a.md*` is `a.md`).
 *
 * `raw` must be the exact string `ast` was parsed from: positions are offsets into it. A leading
 * BOM is skipped because micromark numbers offsets from after it.
 */
export function collectImports(ast: Root, raw: string): readonly Import[] {
	const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const scan: Scan = { found: [], covered: 0 };
	const walk = (node: Nodes): void => {
		if (!("children" in node)) {
			return;
		}
		const siblings: readonly RootContent[] = node.children;
		siblings.forEach((child, index) => {
			if (child.type === "text") {
				scanText(child, siblings, index, source, scan);
			} else {
				walk(child);
			}
		});
	};
	walk(ast);
	return Object.freeze(scan.found);
}

/**
 * What one import's spec names, without touching the filesystem:
 *
 * - `path` — an absolute path inside the root, for the caller to look up;
 * - `home` — `~/…`, the user's home directory, carried as given; left unresolved because it is
 *   outside the repository by definition and differs per machine;
 * - `outside` — resolves out of the root, so it is never looked up.
 */
export type ImportTarget =
	| { readonly kind: "path"; readonly absPath: string }
	| { readonly kind: "home"; readonly path: string }
	| { readonly kind: "outside"; readonly absPath: string };

/**
 * Resolves an import's `path` (`Import.path`, not its `spec`) the way the docs say: relative to
 * the directory of the importing file, never the root or the working directory; an absolute path
 * is taken as it is. Containment is lexical (`isWithinRoot`): a symlink that leaves the root is
 * the caller's to check.
 */
export function resolveImport(
	path: string,
	docAbsPath: string,
	root: string,
): ImportTarget {
	if (path.startsWith("~/")) {
		return Object.freeze({ kind: "home", path });
	}
	const absPath = resolve(dirname(docAbsPath), path);
	if (isWithinRoot(root, absPath)) {
		return Object.freeze({ kind: "path", absPath });
	}
	return Object.freeze({ kind: "outside", absPath });
}
