import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Notice {
	name: string;
	version: string;
	license: string;
	text: string;
}

const DASHES = "-".repeat(80);
const LICENSE_FILE = /^licen[cs]e([.-].*)?$/i;

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function readLicenseText(file: string): string {
	return readFileSync(
		fileURLToPath(new URL(`./licenses/${file}`, import.meta.url)),
		"utf8",
	)
		.replaceAll("\r\n", "\n")
		.trim();
}

const APACHE_2_0_TEXT = readLicenseText("Apache-2.0.txt");
const JAENS_GIST_HEADER = readLicenseText("jaens-gist-header.txt");
const VALIBOT_LICENSE = readLicenseText("valibot-LICENSE.md");

// format@0.2.2 ships no license file: copyright from its Readme.md "License" section, which links http://sjs.mit-license.org
const MISSING_LICENSE_FILES: Readonly<Record<string, string>> = Object.freeze({
	"format@0.2.2": `format 0.2.2 ships no license file; recorded from the "License" section of its Readme.md.\n\nMIT License\n\nCopyright 2010 - 2014 Sami Samhuri sami@samhuri.net\n\n${MIT_TEXT}`,
});

interface ExtraNotice {
	path: string;
	notice: Notice;
}

function extra(path: string, notice: Notice): ExtraNotice {
	return Object.freeze({ path, notice: Object.freeze(notice) });
}

const EXTRA_NOTICES: Readonly<Record<string, readonly ExtraNotice[]>> =
	Object.freeze({
		// citty vendors scule without its notice; text from https://github.com/unjs/scule/blob/v1.3.0/LICENSE (fetched 2026-11-10)
		"citty@0.2.2": Object.freeze([
			extra("dist/_chunks/libs/scule.mjs", {
				name: "scule",
				version: "1.3.0",
				license: "MIT",
				text: `Bundled by citty 0.2.2 in dist/_chunks/libs/scule.mjs without this notice.\n\nMIT License\n\nCopyright (c) Pooya Parsa <pooya@pi0.io>\n\n${MIT_TEXT}`,
			}),
		]),
		"zod@4.6.7": Object.freeze([
			// zod's v4/core/visit.js names this gist (Apache-2.0) as its source; header and license text in scripts/licenses/, fetched 2026-11-10
			extra("v4/core/visit.js", {
				name: "zod-deep-strict-partial.ts (gist by Jaen)",
				version: "",
				license: "Apache-2.0",
				text: `zod 4.6.7 adapts the traversal pattern in v4/core/visit.js from https://gist.github.com/jaens/7e15ae1984bb338c86eb5e452dee3010, whose header reads:\n\n${JAENS_GIST_HEADER}\n\n${APACHE_2_0_TEXT}`,
			}),
			// zod's v4/core/schemas.js says its Luhn check is adapted from valibot (MIT); license text in scripts/licenses/, fetched 2026-11-10
			extra("v4/core/schemas.js", {
				name: "valibot",
				version: "",
				license: "MIT",
				text: `zod 4.6.7 adapts its Luhn check in v4/core/schemas.js from valibot.\n\n${VALIBOT_LICENSE}`,
			}),
		]),
	});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function compare(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

export function packageRootOf(input: string): string | undefined {
	const segments = input.replaceAll("\\", "/").split("/");
	for (let i = segments.length - 2; i >= 0; i--) {
		if (segments[i] !== "node_modules") continue;
		const first = segments[i + 1];
		if (first === undefined) return undefined;
		const length = first.startsWith("@") ? i + 3 : i + 2;
		if (length > segments.length) return undefined;
		return segments.slice(0, length).join("/");
	}
	return undefined;
}

function licenseOf(pkg: Record<string, unknown>): string {
	const { license, licenses } = pkg;
	if (typeof license === "string") return license;
	if (isRecord(license) && typeof license.type === "string")
		return license.type;
	const list: unknown = Array.isArray(license) ? license : licenses;
	if (!Array.isArray(list)) return "not declared";
	const entries: readonly unknown[] = list;
	const types: string[] = [];
	for (const entry of entries) {
		if (isRecord(entry) && typeof entry.type === "string")
			types.push(entry.type);
	}
	return types.length > 0 ? types.join(" OR ") : "not declared";
}

function readNotice(root: string, cwd: string): Notice {
	const dir = join(cwd, root);
	const pkg: unknown = JSON.parse(
		readFileSync(join(dir, "package.json"), "utf8"),
	);
	if (!isRecord(pkg))
		throw new Error(`${root}/package.json is not a JSON object`);
	const { name, version } = pkg;
	if (typeof name !== "string" || typeof version !== "string") {
		throw new Error(`${root}/package.json has no string name and version`);
	}
	const texts = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
		.map((entry) => entry.name)
		.sort()
		.map((file) =>
			readFileSync(join(dir, file), "utf8").replaceAll("\r\n", "\n").trim(),
		)
		.filter((text) => text !== "");
	let text: string;
	if (texts.length > 0) {
		text = texts.join("\n\n");
	} else {
		const missing = MISSING_LICENSE_FILES[`${name}@${version}`];
		if (missing === undefined) {
			throw new Error(
				`${name}@${version} (${root}) ships no license text; check its license by hand and add it to MISSING_LICENSE_FILES in scripts/third-party-notices.ts`,
			);
		}
		text = missing;
	}
	return { name, version, license: licenseOf(pkg), text };
}

export function collectNotices(
	inputs: readonly string[],
	cwd: string,
): Notice[] {
	const byKey = new Map<string, Notice>();
	const add = (notice: Notice): void => {
		const key = `${notice.name}@${notice.version}`;
		if (!byKey.has(key)) byKey.set(key, notice);
	};
	const packages = new Map<string, Notice>();
	for (const input of inputs) {
		const path = input.replaceAll("\\", "/");
		const root = packageRootOf(path);
		if (root === undefined) continue;
		let pkg = packages.get(root);
		if (pkg === undefined) {
			pkg = readNotice(root, cwd);
			packages.set(root, pkg);
		}
		add(pkg);
		const key = `${pkg.name}@${pkg.version}`;
		const extras = Object.hasOwn(EXTRA_NOTICES, key)
			? EXTRA_NOTICES[key]
			: undefined;
		if (extras === undefined) continue;
		const rel = path.slice(root.length + 1);
		for (const entry of extras) {
			if (entry.path === rel) add(entry.notice);
		}
	}
	assertExtraNoticesCurrent([...packages.values()]);
	return [...byKey.values()].sort(
		(a, b) => compare(a.name, b.name) || compare(a.version, b.version),
	);
}

export function splitPackageKey(key: string): {
	name: string;
	version: string;
} {
	const at = key.lastIndexOf("@");
	return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function assertExtraNoticesCurrent(bundled: readonly Notice[]): void {
	const recordedByName = new Map<string, string[]>();
	for (const key of Object.keys(EXTRA_NOTICES)) {
		const { name, version } = splitPackageKey(key);
		const versions = recordedByName.get(name) ?? [];
		versions.push(version);
		recordedByName.set(name, versions);
	}
	const sorted = [...bundled].sort(
		(a, b) => compare(a.name, b.name) || compare(a.version, b.version),
	);
	for (const { name, version } of sorted) {
		const recorded = recordedByName.get(name);
		if (recorded === undefined || recorded.includes(version)) continue;
		throw new Error(
			`${name} is bundled at ${version}, but EXTRA_NOTICES in scripts/third-party-notices.ts records only ${recorded.join(", ")}; re-check what it bundles from other projects and update the entry`,
		);
	}
}

export function renderNotices(notices: readonly Notice[]): string {
	let out =
		"Third-party software bundled into dist/cli.js\n\nskillslurp's own license is in LICENSE. Each package below is bundled into dist/cli.js; its\nlicense notice follows as the package ships it, or as recorded from its source where noted.\n";
	for (const notice of notices) {
		const title =
			notice.version === "" ? notice.name : `${notice.name} ${notice.version}`;
		out += `\n${DASHES}\n${title} (${notice.license})\n${DASHES}\n\n${notice.text}\n`;
	}
	return out;
}
