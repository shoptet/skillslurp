import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
	isMap,
	isScalar,
	LineCounter,
	parseDocument,
	type Scalar,
	type Document as YamlDocument,
} from "yaml";
import type { ResolvedSurface } from "./config.js";
import {
	locFromRange,
	type ParseProblem,
	parseMarkdown,
	parseSource,
	readDocument,
} from "./document.js";
import { describeYamlError } from "./yaml-loc.js";

/**
 * A minimal surface for documents built by hand. Defined per test file rather than shared:
 * `skill/frontmatter-schema`'s tests give their surfaces specific dialects, and the shapes
 * diverge from there.
 */
const TEST_SURFACE: ResolvedSurface = {
	root: ".",
	kind: "skills",
	dialects: ["generic"],
	include: ["**/SKILL.md"],
	ignore: [],
	spokes: [],
	rules: new Map(),
};

function findPair(doc: YamlDocument, key: string) {
	const contents = doc.contents;
	if (!isMap<Scalar, unknown>(contents)) {
		throw new Error("expected frontmatter to be a mapping");
	}
	for (const item of contents.items) {
		if (isScalar(item.key) && item.key.value === key) {
			return item;
		}
	}
	throw new Error(`key "${key}" not found`);
}

function keyRange(
	doc: YamlDocument,
	key: string,
): readonly [number, number, number] {
	const item = findPair(doc, key);
	const range = item.key.range;
	if (!range) {
		throw new Error(`expected key "${key}" to have a range`);
	}
	return range;
}

function valueRange(
	doc: YamlDocument,
	key: string,
): readonly [number, number, number] {
	const item = findPair(doc, key);
	const value = item.value;
	if (!isScalar(value) || !value.range) {
		throw new Error(
			`expected key "${key}"'s value to be a scalar with a range`,
		);
	}
	return value.range;
}

test("parses frontmatter and maps a key to exact line/col", () => {
	const raw = "---\nname: x\ndescription: hello\n---\n\nBody.\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(fm.data).toEqual({ name: "x", description: "hello" });

	const loc = locFromRange(fm, keyRange(fm.doc, "description"));
	expect(loc.line).toBe(3);
	expect(loc.col).toBe(1);
});

test("CRLF line endings do not skew the mapped column", () => {
	const raw = "---\r\nname: x\r\ndescription: hello\r\n---\r\n\r\nBody.\r\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	const loc = locFromRange(fm, keyRange(fm.doc, "description"));
	expect(loc.line).toBe(3);
	expect(loc.col).toBe(1);
});

test("CRLF: endCol of a mapped range does not overshoot the trailing \\r", () => {
	const raw = "---\r\nname: x\r\ndescription: hello\r\n---\r\n\r\nBody.\r\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	// "name"'s value is `x`, immediately followed by \r\n; the mapped end must land right
	// after `x` (col 8, where \r sits), not past the \r into col 9 or the next line.
	const loc = locFromRange(fm, valueRange(fm.doc, "name"));
	expect(loc.line).toBe(2);
	expect(loc.endLine).toBe(2);
	expect(loc.endCol).toBe(8);
});

test("broken yaml produces a positioned parse error inside the frontmatter block", () => {
	const raw = "---\nname: [unclosed\n---\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(fm.errors.length).toBeGreaterThan(0);
	const [first] = fm.errors;
	if (!first) throw new Error("expected at least one error");
	// yaml-local offset 15 is EOF on line 1 of "name: [unclosed" (no closing `]`);
	// lineOffset is 1 (the opening fence is file line 1), so the error lands on file line 2.
	expect(first.loc.line).toBe(2);
});

test("duplicate key becomes a single-line ParseProblem; last value wins in data", () => {
	const raw = "---\nname: a\nname: b\n---\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(fm.data).toEqual({ name: "b" });
	expect(fm.errors.length).toBeGreaterThan(0);
	const [first] = fm.errors;
	if (!first) throw new Error("expected at least one error");
	expect(first.message).toBe("Map keys must be unique");
	expect(first.message).not.toContain("\n");
});

test("an unresolved alias (e.g. markdown emphasis read as *alias*) is a ParseProblem, not a throw", () => {
	const raw = "---\ndescription: *important*\n---\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(fm.data).toBeUndefined();
	expect(fm.errors.length).toBe(1);
});

test("an alias-count bomb is a ParseProblem, not a throw", () => {
	const lines = ["a: &a [1,2,3,4,5,6,7,8,9]"];
	let prev = "a";
	const letters = "bcdefgh";
	for (const letter of letters) {
		const refs = Array.from({ length: 9 }, () => `*${prev}`).join(",");
		lines.push(`${letter}: &${letter} [${refs}]`);
		prev = letter;
	}
	const raw = `---\n${lines.join("\n")}\n---\n`;
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(fm.data).toBeUndefined();
	expect(fm.errors.length).toBe(1);
	const [first] = fm.errors;
	if (!first) throw new Error("expected at least one error");
	expect(first.message).toContain("alias count");
	// no `pos` on this thrown error, so the loc falls back to the frontmatter block start.
	expect(first.loc).toEqual({ line: 1, col: 1 });
});

test("block scalar (|) value: endLine maps correctly", () => {
	const raw = "---\nname: |\n  line1\n  line2\ndescription: hi\n---\n\nBody.\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	const loc = locFromRange(fm, valueRange(fm.doc, "name"));
	expect(loc.line).toBe(2);
	expect(loc.endLine).toBe(5);
});

test("a key on the last line of the block with no trailing newline still maps", () => {
	const raw = "---\nname: x\n---\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	const range = valueRange(fm.doc, "name");
	expect(range[1]).toBe(fm.raw.length);

	const loc = locFromRange(fm, range);
	expect(loc.line).toBe(2);
});

test("a BOM before the fence does not prevent frontmatter detection", () => {
	const withBom = "﻿---\nname: x\ndescription: hello\n---\n\nBody.\n";
	const withoutBom = "---\nname: x\ndescription: hello\n---\n\nBody.\n";

	const docBom = parseSource(
		"skill.md",
		"/repo/skill.md",
		withBom,
		TEST_SURFACE,
	);
	const docPlain = parseSource(
		"skill.md",
		"/repo/skill.md",
		withoutBom,
		TEST_SURFACE,
	);

	expect(docBom.frontmatter).not.toBeNull();
	expect(docPlain.frontmatter).not.toBeNull();
	const fmBom = docBom.frontmatter;
	const fmPlain = docPlain.frontmatter;
	if (!fmBom || !fmPlain) throw new Error("expected frontmatter in both");

	const locBom = locFromRange(fmBom, keyRange(fmBom.doc, "description"));
	const locPlain = locFromRange(fmPlain, keyRange(fmPlain.doc, "description"));
	expect(locBom).toEqual(locPlain);
	expect(locBom.line).toBe(3);
	expect(locBom.col).toBe(1);
});

test("no frontmatter at all", () => {
	const raw = "Just a body.\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).toBeNull();
	expect(doc.ast.children.length).toBeGreaterThan(0);
});

test("empty frontmatter block parses to null data", () => {
	const raw = "---\n---\nBody\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).not.toBeNull();
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");
	expect(fm.data).toBeNull();
});

test("a `---` block not at the very start of the file is not frontmatter", () => {
	const raw = "\n---\nname: x\n---\n\nBody.\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);

	expect(doc.frontmatter).toBeNull();
});

test("readDocument reads a file from disk with a posix-relative path", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-document-"));
	try {
		const raw = "---\nname: x\n---\n\nBody.\n";
		const relPath = join("skills", "example.md");
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(join(dir, relPath), raw, "utf8");

		const doc = await readDocument(dir, {
			path: relPath,
			surface: TEST_SURFACE,
		});

		expect(doc.path).toBe(relPath.split(sep).join("/"));
		expect(doc.path).not.toContain("\\");
		expect(doc.raw).toBe(raw);
		expect(doc.absPath).toBe(join(dir, relPath));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readDocument rejects with ENOENT for a missing file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-document-"));
	try {
		await expect(
			readDocument(dir, { path: "does-not-exist.md", surface: TEST_SURFACE }),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readDocument normalizes a relPath with a leading ./ and internal .. into clean posix", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-document-"));
	try {
		const raw = "---\nname: x\n---\n\nBody.\n";
		await mkdir(join(dir, "skills"), { recursive: true });
		await writeFile(join(dir, "skills", "example.md"), raw, "utf8");

		const messyRelPath = `.${sep}skills${sep}nested${sep}..${sep}example.md`;
		const doc = await readDocument(dir, {
			path: messyRelPath,
			surface: TEST_SURFACE,
		});

		expect(doc.path).toBe("skills/example.md");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * Shallow freeze. The vector that matters is one rule reassigning a top-level
 * field and every later rule seeing the lie — `Document` and `Frontmatter` are shared across
 * every rule in a run. Going deeper was rejected: `frontmatter.doc` is a yaml `Document` with
 * internal state, and `frontmatter.data` may be cyclic through anchors.
 */
test("Document and Frontmatter are frozen, so a rule cannot rewrite them for the next one", () => {
	const raw = "---\nname: x\ndescription: d\n---\n\nBody.\n";
	const doc = parseSource("skill.md", "/repo/skill.md", raw, TEST_SURFACE);
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	expect(Object.isFrozen(doc)).toBe(true);
	expect(Object.isFrozen(fm)).toBe(true);
	expect(() => {
		(doc as { path: string }).path = "elsewhere/SKILL.md";
	}).toThrow(TypeError);
	expect(() => {
		(doc as { frontmatter: unknown }).frontmatter = null;
	}).toThrow(TypeError);
	expect(() => {
		(fm as { raw: string }).raw = "";
	}).toThrow(TypeError);
	expect(doc.path).toBe("skill.md");
	expect(doc.frontmatter).toBe(fm);
});

test("the freeze is deliberately shallow — the yaml Document keeps its own state", () => {
	const doc = parseSource(
		"skill.md",
		"/repo/skill.md",
		"---\nname: x\n---\n",
		TEST_SURFACE,
	);
	const fm = doc.frontmatter;
	if (!fm) throw new Error("expected frontmatter");

	// not frozen on purpose: freezing it would break yaml's internals, and `data` may be cyclic
	expect(Object.isFrozen(fm.doc)).toBe(false);
	expect(Object.isFrozen(doc.ast)).toBe(false);
	// `errors` IS frozen, though — the engine skips every rule on a document whose errors are
	// non-empty, so a rule appending to another document's errors would silence it
	expect(Object.isFrozen(fm.errors)).toBe(true);
	expect(() => {
		(fm.errors as ParseProblem[]).push({
			message: "injected",
			loc: { line: 1, col: 1 },
		});
	}).toThrow(TypeError);
});

test("a document carries the surface that claimed it", () => {
	const doc = parseSource("skill.md", "/repo/skill.md", "Body\n", TEST_SURFACE);

	expect(doc.surface).toBe(TEST_SURFACE);
	expect(doc.surface.dialects).toEqual(["generic"]);
});

test("parseMarkdown parses without a surface and yields the tree parseSource builds on", () => {
	const raw = "---\nname: x\n---\n\nSee @AGENTS.md.\n";
	const ast = parseMarkdown(raw);

	expect(ast.children.map((node) => node.type)).toEqual(["yaml", "paragraph"]);
	expect(ast).toEqual(parseSource("x.md", "/repo/x.md", raw, TEST_SURFACE).ast);
});

const NESTED_MAPPING_MESSAGE =
	'A value contains an unquoted ": ", which YAML reads as the start of a nested mapping; wrap the whole value in quotes';

function frontmatterProblems(
	lines: readonly string[],
	eol = "\n",
): readonly ParseProblem[] {
	const raw = `---${eol}${lines.join(eol)}${eol}---${eol}`;
	const fm = parseSource(
		"rule.mdc",
		"/repo/rule.mdc",
		raw,
		TEST_SURFACE,
	).frontmatter;
	if (!fm) throw new Error("expected frontmatter");
	return fm.errors;
}

function oneProblem(problems: readonly ParseProblem[]): ParseProblem {
	const [only, ...rest] = problems;
	if (!only || rest.length > 0) {
		throw new Error(`expected exactly one problem, got ${problems.length}`);
	}
	return only;
}

test('an unquoted ": " in a value is named and pointed at the colon, not at the start of the value', () => {
	const problem = oneProblem(
		frontmatterProblems([
			"description: Rules for API handlers: applies when editing tests",
		]),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 36, endLine: 2, endCol: 37 });
});

test('two unquoted ": " in one value give two diagnostics, each at its own colon', () => {
	const problems = frontmatterProblems([
		"name: x",
		"description: Keep styles out: they belong in the bundle. Note: always.",
	]);

	expect(problems.map((p) => [p.message, p.loc.line, p.loc.col])).toEqual([
		[NESTED_MAPPING_MESSAGE, 3, 29],
		[NESTED_MAPPING_MESSAGE, 3, 62],
	]);
});

test("a colon at the end of a line is the colon, whether another line follows or the block ends", () => {
	const followed = oneProblem(
		frontmatterProblems(["description: Foo bar:", "name: x"]),
	);
	expect(followed.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(followed.loc).toEqual({ line: 2, col: 21, endLine: 2, endCol: 22 });

	const last = oneProblem(frontmatterProblems(["description: Foo bar:"]));
	expect(last.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(last.loc).toEqual({ line: 2, col: 21, endLine: 2, endCol: 22 });
});

test("a colon followed by a tab is the colon", () => {
	const problem = oneProblem(
		frontmatterProblems(["description: Foo bar:\tbaz"]),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 21, endLine: 2, endCol: 22 });
});

test("CRLF: a colon followed by \\r is the colon, not a later one", () => {
	const problem = oneProblem(
		frontmatterProblems(["description: Foo bar:", "name: x"], "\r\n"),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 21, endLine: 2, endCol: 22 });
});

test("a colon not followed by whitespace is part of the text: `a:b: c` points at the second colon", () => {
	const problem = oneProblem(frontmatterProblems(["description: a:b: c"]));

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 17, endLine: 2, endCol: 18 });
});

test("a multi-line plain scalar: the nested-mapping error moves to the colon on the second line, the multiline-key error keeps yaml's text and position", () => {
	const problems = frontmatterProblems(["description: Foo", "  bar: baz"]);

	expect(problems).toHaveLength(2);
	const nested = problems.find((p) => p.message === NESTED_MAPPING_MESSAGE);
	expect(nested?.loc).toEqual({ line: 3, col: 6, endLine: 3, endCol: 7 });
	const multiline = problems.find(
		(p) => p.message === "Implicit keys need to be on a single line",
	);
	expect(multiline?.loc).toEqual({ line: 2, col: 14, endLine: 3, endCol: 6 });
});

test('an unquoted ": " inside a list item is pointed at', () => {
	const problem = oneProblem(
		frontmatterProblems(["tags:", "  - foo: bar: baz"]),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 3, col: 13, endLine: 3, endCol: 14 });
});

test('an unquoted ": " inside a nested mapping is pointed at', () => {
	const problem = oneProblem(
		frontmatterProblems(["metadata:", "  note: a: b"]),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 3, col: 10, endLine: 3, endCol: 11 });
});

test("a quoted key's own colon is not the one reported", () => {
	const problem = oneProblem(frontmatterProblems(['"description": a: b']));

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 17, endLine: 2, endCol: 18 });
});

test("a value starting with a double-quoted span: the colon after the closing quote is the one reported, not one inside the quotes", () => {
	const problem = oneProblem(frontmatterProblems(['description: "a: b": c']));
	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 20, endLine: 2, endCol: 21 });

	const second = frontmatterProblems(['description: "a: b": c: d']);
	expect(second.map((p) => [p.message, p.loc.line, p.loc.col])).toEqual([
		[NESTED_MAPPING_MESSAGE, 2, 20],
		[NESTED_MAPPING_MESSAGE, 2, 23],
	]);
});

test("a value starting with a single-quoted span: `''` stays inside it and a backslash is literal", () => {
	const plain = oneProblem(frontmatterProblems(["description: 'a: b': c"]));
	expect(plain.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(plain.loc).toEqual({ line: 2, col: 20, endLine: 2, endCol: 21 });

	const doubled = oneProblem(
		frontmatterProblems(["description: 'it''s: x': c"]),
	);
	expect(doubled.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(doubled.loc).toEqual({ line: 2, col: 24, endLine: 2, endCol: 25 });

	const backslash = oneProblem(frontmatterProblems(["description: 'a\\': c"]));
	expect(backslash.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(backslash.loc).toEqual({ line: 2, col: 18, endLine: 2, endCol: 19 });
});

test('a `\\"` inside a double-quoted span does not close it', () => {
	const problem = oneProblem(
		frontmatterProblems(['description: "it\\"s: x": c']),
	);

	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 24, endLine: 2, endCol: 25 });
});

test("an unterminated quote keeps yaml's own message and position", () => {
	const real = oneProblem(frontmatterProblems(['description: "a: b: c']));
	expect(real.message).toBe('Missing closing "quote');
	expect(real.loc).toEqual({ line: 2, col: 22, endLine: 2, endCol: 23 });

	const message = "Nested mappings are not allowed in compact mappings";
	for (const source of ['description: "a: b: c', "description: 'a: b: c"]) {
		const lineCounter = new LineCounter();
		parseDocument(source, { lineCounter });
		expect(
			describeYamlError(
				source,
				{ code: "BLOCK_AS_IMPLICIT_KEY", message, pos: [13, 14] },
				lineCounter,
				0,
			),
		).toEqual({
			message,
			loc: { line: 1, col: 14, endLine: 1, endCol: 15 },
		});
	}
});

test('a ": " inside a comment is not a diagnostic, and does not stand in for the real colon', () => {
	expect(frontmatterProblems(["description: ok # a: b", "name: y"])).toEqual(
		[],
	);

	const problem = oneProblem(
		frontmatterProblems(["description: Foo: bar # note: x"]),
	);
	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);
	expect(problem.loc).toEqual({ line: 2, col: 17, endLine: 2, endCol: 18 });
});

test("an astral character before the colon counts as two columns, as in every other mapped range", () => {
	const problem = oneProblem(
		frontmatterProblems(["description: \u{1F600} x: y"]),
	);
	expect(problem.message).toBe(NESTED_MAPPING_MESSAGE);

	const valid = parseSource(
		"rule.mdc",
		"/repo/rule.mdc",
		"---\ndescription: \u{1F600} x\n---\n",
		TEST_SURFACE,
	).frontmatter;
	if (!valid) throw new Error("expected frontmatter");
	const valueEnd = locFromRange(valid, valueRange(valid.doc, "description"));

	expect(problem.loc.col).toBe(18);
	expect(valueEnd.endCol).toBe(problem.loc.col);
});

test("describeYamlError keeps yaml's message and position when no colon after the error qualifies", () => {
	const message = "Nested mappings are not allowed in compact mappings";
	const code = "BLOCK_AS_IMPLICIT_KEY";

	const plain = "no colon here";
	const plainCounter = new LineCounter();
	parseDocument(plain, { lineCounter: plainCounter });
	expect(
		describeYamlError(plain, { code, message, pos: [3, 4] }, plainCounter, 1),
	).toEqual({
		message,
		loc: { line: 2, col: 4, endLine: 2, endCol: 5 },
	});

	const behind = "a: b\nplain";
	const behindCounter = new LineCounter();
	parseDocument(behind, { lineCounter: behindCounter });
	expect(
		describeYamlError(behind, { code, message, pos: [5, 6] }, behindCounter, 0),
	).toEqual({
		message,
		loc: { line: 2, col: 1, endLine: 2, endCol: 2 },
	});
});

test("inside a flow collection yaml's own error is kept untouched", () => {
	const problem = oneProblem(frontmatterProblems(["description: [a: b: c]"]));

	expect(problem.message).toBe(
		"Block collections are not allowed within flow collections",
	);
	expect(problem.loc).toEqual({ line: 2, col: 18, endLine: 2, endCol: 22 });
});
