import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	freezeSurface,
	type ResolvedSpoke,
	type ResolvedSurface,
	type SurfaceRuleOverride,
	sealMap,
} from "./config.js";
import { DEFAULT_INCLUDE } from "./dialects.js";
import { parseSource } from "./document.js";
import {
	collectRootAliases,
	GLOB_CHARS,
	PATH_RUN,
	type RootAlias,
	readMentions,
	rewriteToTarget,
	trimTrailingPunctuation,
} from "./mentions.js";

function surfaceOf(
	root: string,
	spokes: readonly ResolvedSpoke[] = [],
): ResolvedSurface {
	return freezeSurface({
		root,
		kind: "skills",
		dialects: ["generic"],
		include: DEFAULT_INCLUDE.skills,
		ignore: [],
		spokes,
		rules: sealMap(new Map<string, SurfaceRuleOverride>()),
	});
}

/** Directories and directory symlinks (path to relative target) laid down before aliases are read. */
interface Layout {
	readonly dirs?: readonly string[];
	readonly links?: Readonly<Record<string, string>>;
}

async function aliasesOf(
	surfaces: readonly ResolvedSurface[],
	layout: Layout = {},
): Promise<readonly RootAlias[]> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "mentions-")));
	try {
		for (const dir of layout.dirs ?? []) {
			await mkdir(join(root, dir), { recursive: true });
		}
		for (const [path, target] of Object.entries(layout.links ?? {})) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await symlink(target, join(root, path), "dir");
		}
		const documents = surfaces.map((surface) =>
			parseSource("a.md", join(root, "a.md"), "# a\n", surface),
		);
		return await collectRootAliases({
			root,
			documents: async () => documents,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("trimTrailingPunctuation", () => {
	test("strips each of the trailing sentence characters", () => {
		for (const mark of [".", ",", ";", ":", ")", "]", ">"]) {
			expect(trimTrailingPunctuation(`.claude/skills/foo${mark}`)).toBe(
				".claude/skills/foo",
			);
		}
	});

	test("strips a whole trailing run, not one character", () => {
		expect(trimTrailingPunctuation(".claude/skills/foo.),")).toBe(
			".claude/skills/foo",
		);
	});

	test("leaves an interior dot, an extension and a trailing slash alone", () => {
		expect(trimTrailingPunctuation(".claude/skills/foo/SKILL.md")).toBe(
			".claude/skills/foo/SKILL.md",
		);
		expect(trimTrailingPunctuation("a.b.c")).toBe("a.b.c");
		expect(trimTrailingPunctuation(".claude/skills/")).toBe(".claude/skills/");
	});

	test("trims to an empty string when the input is only punctuation", () => {
		expect(trimTrailingPunctuation("...")).toBe("");
	});
});

describe("GLOB_CHARS", () => {
	test("matches every character that makes a run a glob, placeholder or tag", () => {
		for (const char of ["*", "?", "[", "]", "{", "}", "$", "<"]) {
			expect(GLOB_CHARS.test(`.claude/skills/a${char}b`)).toBe(true);
		}
	});

	test("does not match a literal path or the closing `>`", () => {
		expect(GLOB_CHARS.test(".claude/skills/foo-bar_1/SKILL.md")).toBe(false);
		expect(GLOB_CHARS.test(".claude/skills/foo>")).toBe(false);
	});

	test("is frozen", () => {
		expect(Object.isFrozen(GLOB_CHARS)).toBe(true);
	});
});

describe("PATH_RUN", () => {
	const run = (text: string) => new RegExp(PATH_RUN).exec(text)?.[0];

	test("ends at whitespace, a backtick and either quote", () => {
		expect(run("a/b c")).toBe("a/b");
		expect(run("a/b\tc")).toBe("a/b");
		expect(run("a/b`c")).toBe("a/b");
		expect(run("a/b'c")).toBe("a/b");
		expect(run('a/b"c')).toBe("a/b");
	});

	test("keeps a pipe inside the run", () => {
		expect(run("a/b|c d")).toBe("a/b|c");
	});
});

describe("rewriteToTarget", () => {
	const aliases: readonly RootAlias[] = [
		{ alias: ".claude/skills/nested", target: ".agents/nested" },
		{ alias: ".claude/skills", target: ".agents/skills" },
	];

	test("rewrites the head of a candidate onto the real root", () => {
		expect(rewriteToTarget(".claude/skills/foo/SKILL.md", aliases)).toBe(
			".agents/skills/foo/SKILL.md",
		);
	});

	test("the first alias in the list that heads the candidate wins", () => {
		expect(rewriteToTarget(".claude/skills/nested/x.md", aliases)).toBe(
			".agents/nested/x.md",
		);
	});

	test("an alias matches up to the slash, never as a prefix of a longer name", () => {
		expect(rewriteToTarget(".claude/skills-extra/x.md", aliases)).toBe(
			".claude/skills-extra/x.md",
		);
	});

	test("a candidate no alias heads comes back as it is", () => {
		expect(rewriteToTarget("docs/x.md", aliases)).toBe("docs/x.md");
		expect(rewriteToTarget(".claude/skills", aliases)).toBe(".claude/skills");
	});
});

describe("collectRootAliases", () => {
	test("a written root is its own alias, normalized", async () => {
		expect(await aliasesOf([surfaceOf("./.claude/skills/")])).toEqual([
			{ alias: ".claude/skills", target: ".claude/skills" },
		]);
	});

	test("a spoke is an alias of the root whether or not a config declared it", async () => {
		const aliases = await aliasesOf([
			surfaceOf(".claude/skills", [
				{ path: ".codex/skills", loc: { line: 1, col: 1 } },
				{ path: ".cursor/skills" },
			]),
		]);

		expect(aliases).toEqual([
			{ alias: ".claude/skills", target: ".claude/skills" },
			{ alias: ".cursor/skills", target: ".claude/skills" },
			{ alias: ".codex/skills", target: ".claude/skills" },
		]);
	});

	test("an undeclared spoke that links to the hub is an alias, one that links elsewhere is not", async () => {
		const aliases = await aliasesOf(
			[
				surfaceOf(".agents/skills", [
					{ path: ".claude/skills" },
					{ path: ".codex/skills" },
				]),
			],
			{
				dirs: [".agents/skills", "other/skills"],
				links: {
					".claude/skills": "../.agents/skills",
					".codex/skills": "../other/skills",
				},
			},
		);

		expect(aliases).toEqual([
			{ alias: ".agents/skills", target: ".agents/skills" },
			{ alias: ".claude/skills", target: ".agents/skills" },
		]);
	});

	test("a declared spoke that links elsewhere than the hub is not an alias either", async () => {
		const aliases = await aliasesOf(
			[
				surfaceOf(".agents/skills", [
					{ path: ".codex/skills", loc: { line: 1, col: 1 } },
				]),
			],
			{
				dirs: [".agents/skills", "other/skills"],
				links: { ".codex/skills": "../other/skills" },
			},
		);

		expect(aliases).toEqual([
			{ alias: ".agents/skills", target: ".agents/skills" },
		]);
	});

	test("every surface with a document contributes, longest first, ties in code-unit order", async () => {
		const aliases = await aliasesOf([
			surfaceOf(".cursor/rules"),
			surfaceOf(".claude/skills"),
			surfaceOf(".agents/skills"),
		]);

		expect(aliases.map(({ alias }) => alias)).toEqual([
			".agents/skills",
			".claude/skills",
			".cursor/rules",
		]);
	});
});

describe("readMentions", () => {
	const paths = (raw: string) =>
		readMentions(raw).map((mention) =>
			mention.kind === "path"
				? `${mention.base}:${mention.path}`
				: `${mention.base}:${mention.dir}|${mention.pattern}`,
		);
	const pathLike = (raw: string) =>
		paths(raw).filter((mention) =>
			/[/.|]/.test(mention.slice(mention.indexOf(":"))),
		);

	test("reads a path from prose, inline code and a fenced command, once each in order of first appearance", () => {
		expect(
			pathLike(
				"See `references/a.md` and\nscripts/x.py\n```bash\npython3 skills/s/b.py\n```\nreferences/a.md again\n",
			),
		).toEqual(["any:references/a.md", "any:scripts/x.py", "any:skills/s/b.py"]);
	});

	test("an @ import is the same path without the @", () => {
		expect(pathLike("@references/a.md and (@scripts/x.sh)")).toEqual([
			"any:references/a.md",
			"any:scripts/x.sh",
		]);
	});

	test("a plain word is a token too: it names a file when the item has one called that", () => {
		expect(paths("See LICENSE.")).toEqual(["any:See", "any:LICENSE"]);
	});

	test("the two documented substitutions carry their own base and any other $ token is skipped", () => {
		expect(
			paths(
				`${"$"}{CLAUDE_SKILL_DIR}/a.sh ${"$"}{CLAUDE_PROJECT_DIR}/b/c.sh ${"$"}CLAUDE_SKILL_DIR/d.sh ${"$"}{OTHER}/e.sh ${"$"}HOME/f`,
			),
		).toEqual(["item:a.sh", "root:b/c.sh"]);
	});

	test("sentence punctuation, emphasis, a fragment and a line suffix are peeled off", () => {
		expect(
			paths(
				"a/b.md. (c/d.md) e/f.md, **g/h.md** [i/j.md] <k/l.md> m/n.md; o/p.md: q/r.md#top s/t.py:42 u/v.py:3:4 *w/x.md*",
			),
		).toEqual([
			"any:a/b.md",
			"any:c/d.md",
			"any:e/f.md",
			"any:g/h.md",
			"any:i/j.md",
			"any:k/l.md",
			"any:m/n.md",
			"any:o/p.md",
			"any:q/r.md",
			"any:s/t.py",
			"any:u/v.py",
			"any:w/x.md",
		]);
	});

	test("a token ending in ? or ! is also read with the marks peeled, so a sentence's ? is not only a glob", () => {
		expect(pathLike("Have you read references/forms.md?")).toEqual([
			"any:references|forms.md?",
			"any:references/forms.md",
		]);
		expect(pathLike("Then run references/check.md!")).toEqual([
			"any:references/check.md!",
			"any:references/check.md",
		]);
		expect(pathLike("Is it (references/forms.md)? Yes!")).toEqual([
			"any:references/forms.md",
		]);
		expect(pathLike("Really references/forms.md?!")).toEqual([
			"any:references|forms.md?!",
			"any:references/forms.md",
		]);
	});

	test("a glob that ends in ? still reads as a glob", () => {
		expect(paths("notes/a?")).toContain("any:notes|a?");
	});

	test("a glob needs a literal directory with a real name in front of its first glob character", () => {
		expect(
			paths(
				"notes/*.md scripts/{a,b}.sh a/b/**/*.md *.md * **/*.md ./*.md ../*.md notes*/x.md",
			),
		).toEqual(["any:notes|*.md", "any:scripts|{a,b}.sh", "any:a/b|**/*.md"]);
	});

	test("URLs, absolute and home paths, directories, placeholders and bracket classes are not mentions", () => {
		expect(
			paths(
				"https://host/a/b.md mailto:x@y.z /abs/a.md ~/a.md ~user/a.md notes/ @notes/ <skills-root>/<item>/x.py a/[ab].md a/<n>.md ./ . #anchor",
			),
		).toEqual([]);
	});

	test("a path with a space in it ends at the space", () => {
		expect(paths('"references/my notes.md"')).toEqual([
			"any:references/my",
			"any:notes.md",
		]);
	});

	test("CRLF line ends and a BOM are whitespace", () => {
		expect(paths("\uFEFFa/b.md\r\nc/d.md\r\n")).toEqual([
			"any:a/b.md",
			"any:c/d.md",
		]);
	});

	test("the list is frozen", () => {
		expect(Object.isFrozen(readMentions("a/b.md"))).toBe(true);
		expect(Object.isFrozen(readMentions("a/b.md")[0])).toBe(true);
	});
});
