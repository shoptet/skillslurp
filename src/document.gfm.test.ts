/**
 * A characterization test, not a specification. `document.ts`'s processor is
 * `unified().use(remarkParse).use(remarkFrontmatter,
 * ["yaml"])` — plain CommonMark, no `remark-gfm` — so every GFM construct below is read under the
 * wrong grammar. These tests pin exactly what mdast that produces TODAY, measured directly against
 * `parseSource` on 2026-09-04. They are not a claim that this behavior is desirable, and several of
 * the pinned shapes are actively surprising (a GFM table collapsing into one `paragraph`; `[^1]`
 * becoming a `linkReference` pointing at a `definition` that is not really a link).
 *
 * **Why this file exists as a tripwire.** The day someone adds `remark-gfm` to `document.ts`, every
 * assertion below must fail, loudly, because the node types change: a table becomes a `table` node
 * instead of a `paragraph`; a footnote reference becomes `footnoteReference` instead of
 * `linkReference`; a footnote definition becomes `footnoteDefinition` instead of `definition`; an
 * autolink literal becomes a `link` instead of bare `text`; strikethrough becomes `delete` instead
 * of bare `text`; a task-list item's `checked` becomes a boolean instead of `null`. Every assertion
 * here is written to the exact node type and the exact fields that change under GFM, not to a looser
 * shape both grammars would satisfy — a test that passed under both grammars would not force the
 * "every rule reading mdast needs re-checking" conversation this file exists to force.
 *
 * **What this measurement means for a rule walking `link` / `image` / `definition` nodes** (what
 * `links/resolve`, the shared link-extraction helper in `links.ts` and
 * `refs/no-unreachable-files` all do — see the analysis below each test):
 *
 * - the GFM **table**'s link survives: the table syntax collapses into a `paragraph`, but the link
 *   inside the cell is still ordinary CommonMark inline syntax and still produces a real `link`
 *   node. No false positive, no false negative from tables.
 * - the GFM **footnote** is the one construct that already produced a measured false positive
 *   (`links/resolve`'s `isFootnoteDefinition` workaround, `src/rules/links/resolve.ts`): a
 *   single-token footnote body (`[^1]: real-target.md`) parses as a `definition`, and the `[^1]`
 *   reference resolves to it as a `linkReference` — exactly link-shaped, but not a link. The
 *   workaround filters it out by label, which trades that false positive for a symmetric false
 *   negative: a footnote body that is genuinely a bare path to a real file is invisible to any walk
 *   that only sees `link`/`image`/`definition` nodes. A footnote body that contains a markdown link
 *   (`[^1]: See [the docs](./docs.md).`) is unaffected either way — multi-word bodies never parse as
 *   `definition` at all, so the embedded `link` node is untouched and still found.
 * - GFM **autolink literals** (bare `https://…`, bare `www…`) are invisible either way: under this
 *   processor they are plain `text`, never a `link` node, so nothing currently built on
 *   `link`/`image`/`definition` sees them — not a regression from missing `remark-gfm`, since a bare
 *   autolink always carries a scheme (or gets one synthesized for `www.`), and `links/resolve`'s
 *   `SCHEME_URL` skip means it would be ignored even if it *were* extracted as a `link`.
 * - GFM **task lists** and **strikethrough** carry no `url` in either grammar and are pinned only to
 *   confirm they produce neither a false `link`-shaped node nor hide one.
 */
import { expect, test } from "bun:test";
import type { Root } from "mdast";
import type { ResolvedSurface } from "./config.js";
import { parseSource } from "./document.js";

/** Minimal surface for hand-built documents — same idiom as document.test.ts's TEST_SURFACE. */
const TEST_SURFACE: ResolvedSurface = {
	root: ".",
	kind: "skills",
	dialects: ["generic"],
	include: ["**/SKILL.md"],
	ignore: [],
	spokes: [],
	rules: new Map(),
};

function parse(raw: string): Root {
	return parseSource("doc.md", "/repo/doc.md", raw, TEST_SURFACE).ast;
}

/** `arr[index]`, narrowed away from `undefined` — noUncheckedIndexedAccess is on. */
function at<T>(arr: readonly T[], index: number): T {
	const item = arr[index];
	if (item === undefined) {
		throw new Error(`expected an element at index ${index}, found none`);
	}
	return item;
}

test("GFM table containing a link: the table collapses to one paragraph, but the link inside the cell still parses as a real `link` node", () => {
	const raw = "| Name | Link |\n| --- | --- |\n| foo | [bar](./bar.md) |\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(1);
	const root0 = at(ast.children, 0);
	if (root0.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${root0.type}"`);
	}

	// No `table`/`tableRow`/`tableCell` node anywhere — the pipe syntax is read as literal text.
	expect(root0.children.length).toBe(3);

	const before = at(root0.children, 0);
	if (before.type !== "text") {
		throw new Error(`expected text, got "${before.type}"`);
	}
	expect(before.value).toBe("| Name | Link |\n| --- | --- |\n| foo | ");

	const link = at(root0.children, 1);
	if (link.type !== "link") {
		throw new Error(`expected a link, got "${link.type}"`);
	}
	expect(link.url).toBe("./bar.md");
	expect(link.children.length).toBe(1);
	const linkText = at(link.children, 0);
	if (linkText.type !== "text") {
		throw new Error(`expected text, got "${linkText.type}"`);
	}
	expect(linkText.value).toBe("bar");

	const after = at(root0.children, 2);
	if (after.type !== "text") {
		throw new Error(`expected text, got "${after.type}"`);
	}
	expect(after.value).toBe(" |");
});

test("GFM footnote, single-token body: `[^1]` resolves to a `linkReference`, and `[^1]: real-target.md` is a `definition` — link-shaped, not a link", () => {
	const raw = "See[^1] for details.\n\n[^1]: real-target.md\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(2);

	const paragraph = at(ast.children, 0);
	if (paragraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${paragraph.type}"`);
	}
	expect(paragraph.children.length).toBe(3);
	const ref = at(paragraph.children, 1);
	if (ref.type !== "linkReference") {
		throw new Error(`expected a linkReference, got "${ref.type}"`);
	}
	expect(ref.identifier).toBe("^1");
	expect(ref.label).toBe("^1");
	expect(ref.referenceType).toBe("shortcut");

	const definition = at(ast.children, 1);
	if (definition.type !== "definition") {
		throw new Error(`expected a definition, got "${definition.type}"`);
	}
	expect(definition.identifier).toBe("^1");
	// Exactly what `links/resolve`'s `isFootnoteDefinition` filters out: a footnote definition
	// carrying a `url` this GFM-less parse invented from the footnote's own body text.
	expect(definition.url).toBe("real-target.md");
});

test("GFM footnote, multi-word body, no link: both the reference and the definition line stay literal text (no `definition` is produced at all)", () => {
	const raw = "See[^1] for details.\n\n[^1]: The footnote body.\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(2);

	const first = at(ast.children, 0);
	if (first.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${first.type}"`);
	}
	expect(first.children.length).toBe(1);
	const firstText = at(first.children, 0);
	if (firstText.type !== "text") {
		throw new Error(`expected text, got "${firstText.type}"`);
	}
	expect(firstText.value).toBe("See[^1] for details.");

	const second = at(ast.children, 1);
	if (second.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${second.type}"`);
	}
	expect(second.children.length).toBe(1);
	const secondText = at(second.children, 0);
	if (secondText.type !== "text") {
		throw new Error(`expected text, got "${secondText.type}"`);
	}
	expect(secondText.value).toBe("[^1]: The footnote body.");
});

test("GFM footnote, multi-word body containing a link: the definition line is a paragraph, and the embedded link still parses as a real `link` node", () => {
	const raw = "See[^1] for details.\n\n[^1]: See [the docs](./docs.md).\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(2);

	// Same as the no-link case above: no matching single-token definition exists, so `[^1]` in
	// the first paragraph never resolves to a linkReference either.
	const first = at(ast.children, 0);
	if (first.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${first.type}"`);
	}
	expect(first.children.length).toBe(1);
	const firstText = at(first.children, 0);
	if (firstText.type !== "text") {
		throw new Error(`expected text, got "${firstText.type}"`);
	}
	expect(firstText.value).toBe("See[^1] for details.");

	const second = at(ast.children, 1);
	if (second.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${second.type}"`);
	}
	expect(second.children.length).toBe(3);

	const before = at(second.children, 0);
	if (before.type !== "text") {
		throw new Error(`expected text, got "${before.type}"`);
	}
	expect(before.value).toBe("[^1]: See ");

	const link = at(second.children, 1);
	if (link.type !== "link") {
		throw new Error(`expected a link, got "${link.type}"`);
	}
	expect(link.url).toBe("./docs.md");

	const after = at(second.children, 2);
	if (after.type !== "text") {
		throw new Error(`expected text, got "${after.type}"`);
	}
	expect(after.value).toBe(".");
});

test("bare autolink literal (no angle brackets, https): plain text, never a `link` node", () => {
	const raw = "Visit https://example.com for more.\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(1);
	const paragraph = at(ast.children, 0);
	if (paragraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${paragraph.type}"`);
	}
	expect(paragraph.children.length).toBe(1);
	const text = at(paragraph.children, 0);
	if (text.type !== "text") {
		throw new Error(`expected text, got "${text.type}"`);
	}
	expect(text.value).toBe("Visit https://example.com for more.");
});

test("bare autolink literal (no angle brackets, www.): plain text, never a `link` node", () => {
	const raw = "Visit www.example.com for more.\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(1);
	const paragraph = at(ast.children, 0);
	if (paragraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${paragraph.type}"`);
	}
	expect(paragraph.children.length).toBe(1);
	const text = at(paragraph.children, 0);
	if (text.type !== "text") {
		throw new Error(`expected text, got "${text.type}"`);
	}
	expect(text.value).toBe("Visit www.example.com for more.");
});

test("GFM task list: an ordinary list, `checked` is null (not a boolean), and the checkbox markup stays in the text", () => {
	const raw = "- [ ] todo\n- [x] done\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(1);
	const list = at(ast.children, 0);
	if (list.type !== "list") {
		throw new Error(`expected a list, got "${list.type}"`);
	}
	expect(list.children.length).toBe(2);

	const first = at(list.children, 0);
	expect(first.checked).toBeNull();
	expect(first.children.length).toBe(1);
	const firstParagraph = at(first.children, 0);
	if (firstParagraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${firstParagraph.type}"`);
	}
	const firstText = at(firstParagraph.children, 0);
	if (firstText.type !== "text") {
		throw new Error(`expected text, got "${firstText.type}"`);
	}
	expect(firstText.value).toBe("[ ] todo");

	const second = at(list.children, 1);
	expect(second.checked).toBeNull();
	const secondParagraph = at(second.children, 0);
	if (secondParagraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${secondParagraph.type}"`);
	}
	const secondText = at(secondParagraph.children, 0);
	if (secondText.type !== "text") {
		throw new Error(`expected text, got "${secondText.type}"`);
	}
	expect(secondText.value).toBe("[x] done");
});

test("GFM strikethrough: plain text, never a `delete` node", () => {
	const raw = "This is ~~gone~~ now.\n";
	const ast = parse(raw);

	expect(ast.children.length).toBe(1);
	const paragraph = at(ast.children, 0);
	if (paragraph.type !== "paragraph") {
		throw new Error(`expected a paragraph, got "${paragraph.type}"`);
	}
	expect(paragraph.children.length).toBe(1);
	const text = at(paragraph.children, 0);
	if (text.type !== "text") {
		throw new Error(`expected text, got "${text.type}"`);
	}
	expect(text.value).toBe("This is ~~gone~~ now.");
});
