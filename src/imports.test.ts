import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Root } from "mdast";
import { parseMarkdown } from "./document.js";
import { collectImports, resolveImport } from "./imports.js";

const ROOT = resolve("/repo");
const DOC = join(ROOT, "CLAUDE.md");

function imports(raw: string) {
	return collectImports(parseMarkdown(raw), raw);
}

function specs(raw: string): string[] {
	return imports(raw).map((entry) => entry.spec);
}

test("an import alone on a line is found", () => {
	expect(specs("# Title\n\n@AGENTS.md\n")).toEqual(["AGENTS.md"]);
});

test("a ./-relative import resolves to the sibling of the importing file", () => {
	expect(specs("@./AGENTS.md\n")).toEqual(["./AGENTS.md"]);
	expect(resolveImport("./AGENTS.md", DOC, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "AGENTS.md"),
	});
});

test("a relative import resolves against the importing file's directory, not the root", () => {
	const nested = join(ROOT, "pkg", "CLAUDE.md");

	expect(resolveImport("docs/x.md", nested, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "pkg", "docs", "x.md"),
	});
	expect(resolveImport("../shared.md", nested, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "shared.md"),
	});
});

test("a relative import that climbs out of the root is outside", () => {
	expect(
		resolveImport("../../up.md", join(ROOT, "pkg", "CLAUDE.md"), ROOT),
	).toEqual({ kind: "outside", absPath: resolve(ROOT, "..", "up.md") });
});

test("a ~/ import is a home import, carrying its spec", () => {
	expect(specs("@~/.claude/my-project-instructions.md\n")).toEqual([
		"~/.claude/my-project-instructions.md",
	]);
	expect(resolveImport("~/x.md", DOC, ROOT)).toEqual({
		kind: "home",
		path: "~/x.md",
	});
});

test("only ~/ is a home import; ~user/ and a bare ~ are relative", () => {
	expect(resolveImport("~user/x.md", DOC, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "~user", "x.md"),
	});
	expect(resolveImport("~", DOC, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "~"),
	});
});

test("an absolute import is a path inside the root and outside beyond it", () => {
	const inside = join(ROOT, "inside", "root.md");
	const outside = resolve("/elsewhere", "x.md");

	expect(resolveImport(inside, DOC, ROOT)).toEqual({
		kind: "path",
		absPath: inside,
	});
	expect(resolveImport(outside, DOC, ROOT)).toEqual({
		kind: "outside",
		absPath: outside,
	});
});

test("an @ with a non-space in front of it is not an import", () => {
	expect(specs("me@example.com\n")).toEqual([]);
	expect(specs("mail me@example.com, see @AGENTS.md\n")).toEqual(["AGENTS.md"]);
});

test("an @ right after markup punctuation is not an import", () => {
	expect(specs("**@x.md** and [@y.md](u.md) and (@z.md)\n")).toEqual([]);
	expect(specs("**bold**@x.md\n")).toEqual([]);
	expect(specs("**bold** @x.md\n")).toEqual(["x.md"]);
});

test("a code span is not scanned", () => {
	expect(specs("Use `@AGENTS.md` or `see @AGENTS.md` here\n")).toEqual([]);
});

test("a fenced or indented code block is not scanned", () => {
	expect(specs("```\n@AGENTS.md\n```\n")).toEqual([]);
	expect(specs("~~~md\nsee @AGENTS.md\n~~~\n")).toEqual([]);
	expect(specs("text\n\n    @AGENTS.md\n")).toEqual([]);
});

test("an HTML comment, block-level or inline, is not scanned", () => {
	expect(specs("<!-- @AGENTS.md -->\n")).toEqual([]);
	expect(specs("<!--\n@AGENTS.md\n-->\n\ntext\n")).toEqual([]);
	expect(specs("text <!-- @x.md --> more\n")).toEqual([]);
	expect(specs("text <!-- @x.md --> @y.md\n")).toEqual(["y.md"]);
});

test("trailing sentence punctuation is trimmed, interior dots are kept", () => {
	expect(specs("See @AGENTS.md.\n")).toEqual(["AGENTS.md"]);
	expect(specs("(see @AGENTS.md)\n")).toEqual(["AGENTS.md"]);
	expect(specs("@a.md, then @docs/a.b.md;\n")).toEqual(["a.md", "docs/a.b.md"]);
});

test("two imports on one line are both found, in order", () => {
	const found = imports("@a.md @b.md\n");

	expect(found.map((entry) => entry.spec)).toEqual(["a.md", "b.md"]);
	expect(found.map((entry) => entry.loc.col)).toEqual([1, 7]);
});

test("imports come back in document order across nested nodes", () => {
	expect(
		specs("# H @a.md\n\n- @b.md\n\n> @c.md\n\n[x @d.md](u.md) @e.md\n"),
	).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
});

test("a bare @, an @ before a space, or an @ that trims to nothing is not an import", () => {
	expect(specs("@\n\n@ \n\nat @ sign\n\n@.\n\n@...\n")).toEqual([]);
});

test("an import in a heading or in link text counts", () => {
	expect(specs("# Title @h.md\n\n[see @l.md](u.md)\n")).toEqual([
		"h.md",
		"l.md",
	]);
});

test("image alt text is not scanned", () => {
	expect(specs("![see @img.md](a.png)\n")).toEqual([]);
});

test("frontmatter is not scanned", () => {
	const found = imports("---\ndescription: read @x.md\n---\n\n@y.md\n");

	expect(found.map((entry) => entry.spec)).toEqual(["y.md"]);
	expect(found[0]?.loc.line).toBe(5);
});

test("an escaped @ or one spelled as a character reference is not an import", () => {
	expect(specs("\\@x.md &#64;y.md\n")).toEqual([]);
});

test("a backslash before a space keeps the space in the path; spec stays verbatim, path decodes it", () => {
	const found = imports(
		"- API conventions @Design\\ Docs/api-conventions.md\n",
	);

	expect(found).toEqual([
		{
			spec: "Design\\ Docs/api-conventions.md",
			path: "Design Docs/api-conventions.md",
			loc: { line: 1, col: 19, endLine: 1, endCol: 51 },
		},
	]);
});

test("every escaped space in a path is decoded", () => {
	expect(imports("@My\\ Design\\ Docs/a\\ b.md\n")[0]?.path).toBe(
		"My Design Docs/a b.md",
	);
});

test("an escaped-space import resolves to the file with the space in its name", () => {
	const entry = imports("@Design\\ Docs/api-conventions.md\n")[0];

	expect(entry?.path).toBe("Design Docs/api-conventions.md");
	expect(resolveImport(entry?.path ?? "", DOC, ROOT)).toEqual({
		kind: "path",
		absPath: join(ROOT, "Design Docs", "api-conventions.md"),
	});
});

test("without the backslash the path ends at the first space", () => {
	expect(specs("@Design Docs/api.md\n")).toEqual(["Design"]);
	expect(imports("@Design Docs/api.md\n")[0]?.path).toBe("Design");
});

test("a path wrapped in quotes is not an import, with or without backslashes", () => {
	expect(specs('@"Design Docs/api.md"\n')).toEqual([]);
	expect(specs('@"Design\\ Docs/api.md"\n')).toEqual([]);
	expect(specs("@'Design Docs/api.md'\n")).toEqual([]);
});

test("an @ inside an escaped-space path is part of it, not a second import", () => {
	expect(specs("@a\\ @b.md\n")).toEqual(["a\\ @b.md"]);
	expect(specs("@a\\ @b.md @c.md\n")).toEqual(["a\\ @b.md", "c.md"]);
});

test("emphasis characters inside a path do not cut it", () => {
	expect(specs("@docs/__init__.md\n")).toEqual(["docs/__init__.md"]);
	expect(specs("@a/_b_/c.md\n")).toEqual(["a/_b_/c.md"]);
	expect(specs("@a*b*c.md\n")).toEqual(["a*b*c.md"]);
	expect(imports("@docs/__init__.md\n")[0]?.loc).toEqual({
		line: 1,
		col: 1,
		endLine: 1,
		endCol: 18,
	});
});

test("a path immediately followed by a code span stops at its backtick", () => {
	expect(specs("@docs/`x`\n")).toEqual(["docs/"]);
	expect(specs("@a.md`x`\n")).toEqual(["a.md"]);
});

test("a link, inline HTML or a hard break right after the path ends it", () => {
	expect(specs("@a.md[x](u.md)\n")).toEqual(["a.md"]);
	expect(specs("@a.md<!-- n -->\n")).toEqual(["a.md"]);
	expect(specs("@a.md\\\nb\n")).toEqual(["a.md"]);
});

test("the closing marker of the node holding the @ is not part of the path", () => {
	expect(specs("**see @a.md**\n")).toEqual(["a.md"]);
	expect(specs("*see @a.md* and _see @b.md_\n")).toEqual(["a.md", "b.md"]);
});

test("glob-like characters stay in the spec verbatim", () => {
	const raw =
		"@docs/*.md @a/[b]/c.md @d/$HOME/x.md @e/?.md @g/{a,b}.md @f/<1.md\n";

	expect(specs(raw)).toEqual([
		"docs/*.md",
		"a/[b]/c.md",
		"d/$HOME/x.md",
		"e/?.md",
		"g/{a,b}.md",
		"f/<1.md",
	]);
});

test("a < that opens an inline HTML tag ends the path at it", () => {
	expect(specs("@e/<n>.md\n")).toEqual(["e/"]);
});

test("loc is exact: line, col and an exclusive end", () => {
	expect(imports("# T\n\nsee @a.md\n")).toEqual([
		{
			spec: "a.md",
			path: "a.md",
			loc: { line: 3, col: 5, endLine: 3, endCol: 10 },
		},
	]);
});

test("loc on a node's first line is offset by where the node starts", () => {
	expect(imports("# Title @h.md\n")[0]?.loc).toEqual({
		line: 1,
		col: 9,
		endLine: 1,
		endCol: 14,
	});
	expect(imports("*a* @x.md\n")[0]?.loc).toMatchObject({ line: 1, col: 5 });
});

test("loc accounts for a list item's continuation indent", () => {
	expect(imports("- item\n  @b.md\n")[0]?.loc).toEqual({
		line: 2,
		col: 3,
		endLine: 2,
		endCol: 8,
	});
});

test("loc accounts for a blockquote's continuation prefix", () => {
	expect(imports("> q\n> @d.md\n")[0]?.loc).toEqual({
		line: 2,
		col: 3,
		endLine: 2,
		endCol: 8,
	});
});

test("loc is not shifted by an escape in front of the import", () => {
	expect(imports("foo\\_bar @e.md\n")[0]?.loc).toEqual({
		line: 1,
		col: 10,
		endLine: 1,
		endCol: 15,
	});
});

test("loc counts UTF-16 code units, like mdast", () => {
	expect(imports("\u{1F600} @f.md\n")[0]?.loc.col).toBe(4);
});

test("CRLF and lone CR line endings are line breaks for loc", () => {
	expect(imports("a\r\n@b.md\r\n")[0]?.loc).toMatchObject({ line: 2, col: 1 });
	expect(imports("a\r@b.md\n")[0]?.loc).toMatchObject({ line: 2, col: 1 });
});

test("a leading BOM shifts neither the spec nor the loc", () => {
	expect(imports("﻿@x.md\n")).toEqual([
		{
			spec: "x.md",
			path: "x.md",
			loc: { line: 1, col: 1, endLine: 1, endCol: 6 },
		},
	]);
	expect(imports("﻿a\n\nb @y.md\n")[0]?.loc).toMatchObject({
		line: 3,
		col: 3,
	});
});

test("a text node without source offsets is refused, not skipped", () => {
	const ast: Root = {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [{ type: "text", value: "@x.md" }],
			},
		],
	};

	expect(() => collectImports(ast, "@x.md")).toThrow(
		"text node without a source offset",
	);
});

test("results are frozen", () => {
	const found = imports("@a.md\n");

	expect(Object.isFrozen(found)).toBe(true);
	expect(Object.isFrozen(found[0])).toBe(true);
	expect(Object.isFrozen(found[0]?.loc)).toBe(true);
	expect(Object.isFrozen(resolveImport("a.md", DOC, ROOT))).toBe(true);
	expect(Object.isFrozen(resolveImport("~/a.md", DOC, ROOT))).toBe(true);
	expect(Object.isFrozen(resolveImport("../../a.md", DOC, ROOT))).toBe(true);
});

test("no import is found in a document that has none", () => {
	expect(imports("")).toEqual([]);
	expect(imports("Just prose.\n")).toEqual([]);
});
