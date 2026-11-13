import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	collectNotices,
	type Notice,
	packageRootOf,
	renderNotices,
	splitPackageKey,
} from "./third-party-notices.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "skillslurp-notices-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writePackage(
	root: string,
	manifest: Record<string, unknown>,
	files: Readonly<Record<string, string>> = {},
): void {
	const dir = join(cwd, root);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
	for (const [file, content] of Object.entries(files)) {
		writeFileSync(join(dir, file), content);
	}
}

function simplePackage(
	name: string,
	version = "1.0.0",
	root = `node_modules/${name}`,
): void {
	writePackage(
		root,
		{ name, version, license: "MIT" },
		{ LICENSE: `license of ${name}` },
	);
}

function licensesByName(notices: readonly Notice[]): Record<string, string> {
	return Object.fromEntries(notices.map((n) => [n.name, n.license]));
}

function textsByName(notices: readonly Notice[]): Record<string, string> {
	return Object.fromEntries(notices.map((n) => [n.name, n.text]));
}

test("packageRootOf returns the package directory after the last node_modules segment", () => {
	const table: [string, string | undefined][] = [
		["node_modules/a/x.js", "node_modules/a"],
		["node_modules/@s/b/lib/x.js", "node_modules/@s/b"],
		[
			"node_modules/a/node_modules/@s/b/x.js",
			"node_modules/a/node_modules/@s/b",
		],
		["src/cli.ts", undefined],
		["node_modules\\a\\x.js", "node_modules/a"],
	];
	for (const [input, root] of table) {
		expect({ input, root: packageRootOf(input) }).toEqual({ input, root });
	}
});

test("several inputs from one package produce one notice", () => {
	simplePackage("alpha");
	const notices = collectNotices(
		[
			"node_modules/alpha/index.js",
			"node_modules/alpha/lib/deep/x.js",
			"node_modules/alpha/other.js",
		],
		cwd,
	);
	expect(notices.map((n) => `${n.name}@${n.version}`)).toEqual(["alpha@1.0.0"]);
});

test("the same name at two versions produces two notices ordered by version", () => {
	simplePackage("dup", "2.0.0");
	simplePackage("host", "3.0.0");
	writePackage(
		"node_modules/host/node_modules/dup",
		{ name: "dup", version: "1.0.0", license: "ISC" },
		{ LICENSE: "nested dup license" },
	);
	const notices = collectNotices(
		[
			"node_modules/dup/index.js",
			"node_modules/host/index.js",
			"node_modules/host/node_modules/dup/index.js",
		],
		cwd,
	);
	expect(notices.map((n) => `${n.name}@${n.version}:${n.license}`)).toEqual([
		"dup@1.0.0:ISC",
		"dup@2.0.0:MIT",
		"host@3.0.0:MIT",
	]);
});

test("inputs given out of order come out sorted by name", () => {
	simplePackage("zeta");
	simplePackage("alpha");
	simplePackage("mid");
	const notices = collectNotices(
		[
			"node_modules/zeta/index.js",
			"node_modules/alpha/index.js",
			"node_modules/mid/index.js",
		],
		cwd,
	);
	expect(notices.map((n) => n.name)).toEqual(["alpha", "mid", "zeta"]);
});

test("LICENSE, license.md, LICENCE and LICENSE-MIT are license files; licenses.json is not", () => {
	const names: Record<string, string> = {
		upper: "LICENSE",
		markdown: "license.md",
		british: "LICENCE",
		suffixed: "LICENSE-MIT",
	};
	for (const [pkg, file] of Object.entries(names)) {
		writePackage(
			`node_modules/${pkg}`,
			{ name: pkg, version: "1.0.0", license: "MIT" },
			{ [file]: `text in ${file}` },
		);
	}
	const notices = collectNotices(
		Object.keys(names).map((pkg) => `node_modules/${pkg}/index.js`),
		cwd,
	);
	expect(textsByName(notices)).toEqual({
		upper: "text in LICENSE",
		markdown: "text in license.md",
		british: "text in LICENCE",
		suffixed: "text in LICENSE-MIT",
	});

	writePackage(
		"node_modules/onlyjson",
		{ name: "onlyjson", version: "1.0.0", license: "MIT" },
		{ "licenses.json": "[]" },
	);
	expect(() => collectNotices(["node_modules/onlyjson/index.js"], cwd)).toThrow(
		"onlyjson@1.0.0",
	);
});

test("a package with several license files gets all texts, sorted by file name", () => {
	// non-ASCII names make JS's default sort and a byte-order sort disagree, so the expected order below is the explicit sort's, not whatever readdir returns
	writePackage(
		"node_modules/multi",
		{ name: "multi", version: "1.0.0", license: "MIT AND Apache-2.0" },
		{
			"LICENSE-APACHE": "apache text",
			"LICENSE-Ａ": "fullwidth text",
			LICENSE: "main text",
			"LICENSE-\u{1F600}": "emoji text",
		},
	);
	const notices = collectNotices(["node_modules/multi/index.js"], cwd);
	expect(notices.map((n) => n.text)).toEqual([
		"main text\n\napache text\n\nemoji text\n\nfullwidth text",
	]);
});

test("the license field shapes are normalised and a missing one is not declared", () => {
	const manifests: Record<string, Record<string, unknown>> = {
		asstring: { license: "MIT" },
		asobject: {
			license: { type: "BSD-3-Clause", url: "https://example.test" },
		},
		asarray: { license: [{ type: "MIT" }, { type: "ISC" }] },
		aslicenses: {
			licenses: [{ type: "Apache-2.0", url: "u" }, { type: "BSD-2-Clause" }],
		},
		missing: {},
	};
	for (const [name, fields] of Object.entries(manifests)) {
		writePackage(
			`node_modules/${name}`,
			{ name, version: "1.0.0", ...fields },
			{ LICENSE: "text" },
		);
	}
	const notices = collectNotices(
		Object.keys(manifests).map((name) => `node_modules/${name}/index.js`),
		cwd,
	);
	expect(licensesByName(notices)).toEqual({
		asstring: "MIT",
		asobject: "BSD-3-Clause",
		asarray: "MIT OR ISC",
		aslicenses: "Apache-2.0 OR BSD-2-Clause",
		missing: "not declared",
	});
});

test("format@0.2.2 without a license file gets the recorded MIT text", () => {
	writePackage(
		"node_modules/format",
		{
			name: "format",
			version: "0.2.2",
			licenses: [{ type: "MIT", url: "http://sjs.mit-license.org" }],
		},
		{ "Readme.md": "## License\n\nMIT" },
	);
	const [notice, ...rest] = collectNotices(
		["node_modules/format/index.js"],
		cwd,
	);
	expect(rest).toEqual([]);
	expect(notice?.license).toBe("MIT");
	expect(notice?.text).toStartWith("format 0.2.2 ships no license file");
	expect(notice?.text).toContain("Sami Samhuri");
	expect(notice?.text).toContain("Permission is hereby granted");
});

test("a package with no license file and no recorded text throws", () => {
	writePackage(
		"node_modules/nolicense",
		{ name: "nolicense", version: "1.0.0", license: "MIT" },
		{ "Readme.md": "hello" },
	);
	expect(() =>
		collectNotices(["node_modules/nolicense/index.js"], cwd),
	).toThrow(
		/nolicense@1\.0\.0 \(node_modules\/nolicense\) ships no license text/,
	);
});

test("an empty license file counts as no license text and throws", () => {
	writePackage(
		"node_modules/emptylicense",
		{ name: "emptylicense", version: "1.0.0", license: "MIT" },
		{ LICENSE: "  \n\n" },
	);
	expect(() =>
		collectNotices(["node_modules/emptylicense/index.js"], cwd),
	).toThrow(
		/emptylicense@1\.0\.0 \(node_modules\/emptylicense\) ships no license text/,
	);
});

test("citty's vendored scule is found under every install layout and path separator", () => {
	const layouts = [
		"node_modules/citty",
		"node_modules/.bun/citty@0.2.2/node_modules/citty",
		"node_modules/.pnpm/citty@0.2.2/node_modules/citty",
	];
	for (const root of layouts) simplePackage("citty", "0.2.2", root);
	const inputs = [
		...layouts.map((root) => `${root}/dist/_chunks/libs/scule.mjs`),
		"node_modules\\citty\\dist\\_chunks\\libs\\scule.mjs",
	];
	for (const input of inputs) {
		const notices = collectNotices([input], cwd);
		expect({
			input,
			notices: notices.map((n) => `${n.name}@${n.version}:${n.license}`),
		}).toEqual({ input, notices: ["citty@0.2.2:MIT", "scule@1.3.0:MIT"] });
		const scule = notices.find((n) => n.name === "scule");
		expect(scule?.text).toStartWith("Bundled by citty 0.2.2 in ");
		expect(scule?.text).toContain("Pooya Parsa");
		expect(scule?.text).toContain("Permission is hereby granted");
	}
});

test("another file from citty yields citty's own notice only", () => {
	simplePackage("citty", "0.2.2");
	const notices = collectNotices(["node_modules/citty/dist/index.mjs"], cwd);
	expect(notices.map((n) => `${n.name}@${n.version}`)).toEqual(["citty@0.2.2"]);
});

test("citty at a version EXTRA_NOTICES does not record throws", () => {
	simplePackage("citty", "0.3.0");
	const run = (): Notice[] =>
		collectNotices(["node_modules/citty/dist/index.mjs"], cwd);
	expect(run).toThrow("citty is bundled at 0.3.0");
	expect(run).toThrow("records only 0.2.2");
});

test("zod's adapted code yields the Jaen gist and valibot notices next to zod's own", () => {
	simplePackage("zod", "4.6.7");
	const both = collectNotices(
		[
			"node_modules/zod/v4/core/visit.js",
			"node_modules/zod/v4/core/schemas.js",
		],
		cwd,
	);
	expect(both.map((n) => `${n.name}@${n.version}:${n.license}`)).toEqual([
		"valibot@:MIT",
		"zod@4.6.7:MIT",
		"zod-deep-strict-partial.ts (gist by Jaen)@:Apache-2.0",
	]);
	const gist = both.find((n) => n.name.startsWith("zod-deep"));
	expect(gist?.text).toContain("Copyright 2024, Jaen");
	expect(gist?.text).toContain("Apache License");
	expect(gist?.text).toContain("Version 2.0, January 2004");
	const valibot = both.find((n) => n.name === "valibot");
	expect(valibot?.text).toContain("Copyright (c) Fabian Hiller");

	const visitOnly = collectNotices(["node_modules/zod/v4/core/visit.js"], cwd);
	expect(visitOnly.map((n) => n.name)).toEqual([
		"zod",
		"zod-deep-strict-partial.ts (gist by Jaen)",
	]);
	const schemasOnly = collectNotices(
		["node_modules/zod/v4/core/schemas.js"],
		cwd,
	);
	expect(schemasOnly.map((n) => n.name)).toEqual(["valibot", "zod"]);
	const other = collectNotices(["node_modules/zod/index.js"], cwd);
	expect(other.map((n) => n.name)).toEqual(["zod"]);
});

test("CRLF in a license file becomes LF and surrounding whitespace is trimmed", () => {
	writePackage(
		"node_modules/crlf",
		{ name: "crlf", version: "1.0.0", license: "MIT" },
		{ LICENSE: "\r\n  \r\n  Copyright X\r\nsecond line\r\n\r\n  " },
	);
	const notices = collectNotices(["node_modules/crlf/index.js"], cwd);
	expect(notices.map((n) => n.text)).toEqual(["Copyright X\nsecond line"]);
});

test("renderNotices output is pinned", () => {
	const notices: Notice[] = [
		{ name: "alpha", version: "1.0.0", license: "MIT", text: "alpha text" },
		{
			name: "beta",
			version: "2.1.0",
			license: "ISC OR MIT",
			text: "beta line 1\nbeta line 2",
		},
		{ name: "gamma", version: "", license: "MIT", text: "gamma text" },
	];
	expect(
		renderNotices(notices),
	).toBe(`Third-party software bundled into dist/cli.js

skillslurp's own license is in LICENSE. Each package below is bundled into dist/cli.js; its
license notice follows as the package ships it, or as recorded from its source where noted.

--------------------------------------------------------------------------------
alpha 1.0.0 (MIT)
--------------------------------------------------------------------------------

alpha text

--------------------------------------------------------------------------------
beta 2.1.0 (ISC OR MIT)
--------------------------------------------------------------------------------

beta line 1
beta line 2

--------------------------------------------------------------------------------
gamma (MIT)
--------------------------------------------------------------------------------

gamma text
`);
});

test("the real bundle yields a notice for every bundled package and the extra notices", async () => {
	const result = await Bun.build({
		entrypoints: [join(REPO_ROOT, "src/cli.ts")],
		target: "node",
		metafile: true,
	});
	expect(result.success).toBe(true);
	if (result.metafile === undefined) throw new Error("no metafile");
	const inputs = Object.keys(result.metafile.inputs).map((key) =>
		relative(REPO_ROOT, resolve(process.cwd(), key)),
	);
	const roots = new Set<string>();
	for (const input of inputs) {
		const root = packageRootOf(input);
		if (root !== undefined) roots.add(root);
	}

	const notices = collectNotices(inputs, REPO_ROOT);

	const names = notices.map((n) => n.name);
	for (const expected of [
		"zod",
		"yaml",
		"picocolors",
		"format",
		"scule",
		"valibot",
		"zod-deep-strict-partial.ts (gist by Jaen)",
	]) {
		expect(names).toContain(expected);
	}
	expect(notices).toHaveLength(roots.size + 3);
	expect(notices.filter((n) => n.text.length === 0).map((n) => n.name)).toEqual(
		[],
	);
});

test("splitPackageKey splits at the last @, so a scoped name keeps its own", () => {
	expect(splitPackageKey("citty@0.2.2")).toEqual({
		name: "citty",
		version: "0.2.2",
	});
	expect(splitPackageKey("@scope/pkg@1.0.0")).toEqual({
		name: "@scope/pkg",
		version: "1.0.0",
	});
});
