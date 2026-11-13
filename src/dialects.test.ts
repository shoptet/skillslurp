import { describe, expect, test } from "bun:test";
import { CANDIDATE_TABLE } from "./detect.js";
import {
	BUILTIN_DIALECT_IDS,
	BUILTIN_DIALECTS,
	CURSOR_RULE_EXTENSION,
	DEFAULT_INCLUDE,
	type DialectId,
	defaultInclude,
	dialectsSupportingKind,
	type FrontmatterContract,
	isDialectId,
	mergeContractList,
	mergeContracts,
	type NameConstraints,
	readerAt,
	SKILL_NAME_PATTERN,
	SURFACE_KINDS,
	type SurfaceKind,
} from "./dialects.js";

/**
 * Transcribed independently of `dialects.ts` — including the regex literal and the pattern
 * wording, which are deliberately NOT imported. The point is that changing a built-in contract
 * has to be done twice, on purpose, instead of drifting in unnoticed behind a passing suite.
 */
const ASCII_NAME = {
	pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
	patternDescription:
		"lowercase letters, digits and single hyphens, with no leading, trailing or consecutive hyphens",
};

const SPEC_MAX_LENGTHS = { name: 64, description: 1024, compatibility: 500 };

const EXPECTED: readonly {
	id: DialectId;
	kind: SurfaceKind;
	contract: FrontmatterContract;
}[] = [
	{
		id: "generic",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: ["name", "description"],
			allowed: [
				"name",
				"description",
				"license",
				"compatibility",
				"metadata",
				"allowed-tools",
			],
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: SPEC_MAX_LENGTHS,
			toolUnknownKeyPolicy: "error",
		},
	},
	{
		id: "claude-code",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: [],
			allowed: [
				"name",
				"description",
				"when_to_use",
				"argument-hint",
				"arguments",
				"disable-model-invocation",
				"user-invocable",
				"allowed-tools",
				"disallowed-tools",
				"model",
				"effort",
				"context",
				"agent",
				"background",
				"hooks",
				"paths",
				"shell",
				"metadata",
				"license",
				"compatibility",
			],
			nameMatchesDir: "decoupled",
			frontmatter: "optional",
			maxLengths: { compatibility: 500 },
			activation: { key: "paths", splitter: "list-or-string" },
		},
	},
	{
		id: "claude-code",
		kind: "rules",
		contract: {
			include: ["**/*.md"],
			required: [],
			allowed: ["paths"],
			nameMatchesDir: "decoupled",
			frontmatter: "optional",
			activation: { key: "paths", splitter: "list-or-string" },
			toolUnknownKeyPolicy: "ignore",
		},
	},
	{
		id: "cursor",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: ["name", "description"],
			allowed: [
				"name",
				"description",
				"paths",
				"globs",
				"disable-model-invocation",
				"icon",
				"color",
				"metadata",
			],
			nameMatchesDir: "must",
			name: ASCII_NAME,
			activation: {
				key: "paths",
				splitter: "list-or-string",
				legacyKeys: ["globs"],
			},
		},
	},
	{
		id: "cursor",
		kind: "rules",
		contract: {
			include: ["**/*.mdc"],
			location: { path: ".cursor/rules", extension: ".mdc" },
			required: [],
			allowed: ["description", "globs", "alwaysApply"],
			nameMatchesDir: "decoupled",
			activation: {
				key: "globs",
				splitter: "comma-scalar",
				nonActivatingShapes: ["flow-sequence"],
			},
		},
	},
	{
		id: "copilot",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: ["name", "description"],
			allowed: ["name", "description", "license", "allowed-tools"],
			nameMatchesDir: "should",
			name: ASCII_NAME,
		},
	},
	{
		id: "copilot",
		kind: "instructions",
		contract: {
			include: ["**/*.instructions.md"],
			required: [],
			allowed: ["applyTo", "excludeAgent", "name", "description"],
			nameMatchesDir: "decoupled",
			activation: { key: "applyTo", splitter: "comma-scalar" },
		},
	},
	{
		id: "opencode",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: ["name", "description"],
			allowed: ["name", "description", "license", "compatibility", "metadata"],
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: { name: 64, description: 1024 },
			toolUnknownKeyPolicy: "ignore",
		},
	},
	{
		id: "codex",
		kind: "skills",
		contract: {
			include: ["**/SKILL.md"],
			required: ["name", "description"],
			allowed: [
				"name",
				"description",
				"license",
				"compatibility",
				"metadata",
				"allowed-tools",
			],
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: SPEC_MAX_LENGTHS,
		},
	},
];

interface Entry {
	id: DialectId;
	kind: string;
	contract: FrontmatterContract;
}

/**
 * Every (dialect, kind) pair that actually has a contract. Enumerated from each dialect's own
 * `contracts` keys rather than from `SURFACE_KINDS`, so a contract filed under a kind nobody
 * listed still shows up here — and then fails the coverage test below instead of hiding.
 */
function allContracts(): Entry[] {
	const out: Entry[] = [];
	for (const id of BUILTIN_DIALECT_IDS) {
		const { contracts } = BUILTIN_DIALECTS[id];
		for (const kind of Object.keys(contracts).sort()) {
			const contract = contracts[kind as SurfaceKind];
			if (contract) {
				out.push({ id, kind, contract });
			}
		}
	}
	return out;
}

const entryKey = (e: { id: string; kind: string }) => `${e.id}/${e.kind}`;

describe("built-in dialect contracts", () => {
	for (const { id, kind, contract } of EXPECTED) {
		test(`${id} / ${kind} matches the documented contract verbatim`, () => {
			expect(BUILTIN_DIALECTS[id].contracts[kind]).toEqual(contract);
		});
	}

	test("the expected table covers every contract that exists, and no others", () => {
		expect(allContracts().map(entryKey).sort()).toEqual(
			EXPECTED.map(entryKey).sort(),
		);
	});

	test("no contract is filed under a kind outside SurfaceKind", () => {
		const known = new Set<string>(SURFACE_KINDS);
		expect(
			allContracts()
				.filter(({ kind }) => !known.has(kind))
				.map(entryKey),
		).toEqual([]);
	});

	test("frontmatter is optional for claude-code skills and rules and required for every other contract", () => {
		const optional = new Set(["claude-code/rules", "claude-code/skills"]);
		const policies = Object.fromEntries(
			allContracts().map((entry) => [
				entryKey(entry),
				entry.contract.frontmatter ?? "required",
			]),
		);
		expect(policies).toEqual(
			Object.fromEntries(
				allContracts().map((entry) => [
					entryKey(entry),
					optional.has(entryKey(entry)) ? "optional" : "required",
				]),
			),
		);
	});

	test("every dialect's id field agrees with its registry key", () => {
		for (const id of BUILTIN_DIALECT_IDS) {
			expect(BUILTIN_DIALECTS[id].id).toBe(id);
		}
	});

	// `toEqual` above treats a key holding `undefined` as absent; this is the strict half: Claude
	// Code documents no `name` for a rule and no cap for `paths`, so neither key may exist at all.
	test("claude-code / rules carries no name constraint and no length caps, not even as undefined keys", () => {
		const contract = BUILTIN_DIALECTS["claude-code"].contracts.rules;
		if (!contract) {
			throw new Error("claude-code/rules contract is missing");
		}
		expect(Object.keys(contract).sort()).toEqual([
			"activation",
			"allowed",
			"frontmatter",
			"include",
			"nameMatchesDir",
			"required",
			"toolUnknownKeyPolicy",
		]);
	});
});

/**
 * Each invariant collects every offending (dialect, kind) rather than failing on the first, so
 * a bad edit reports all of its damage in one run and the diff names the culprit.
 */
describe("contract invariants", () => {
	function offenders(predicate: (entry: Entry) => boolean): string[] {
		return allContracts().filter(predicate).map(entryKey);
	}

	test("every required key is also allowed", () => {
		expect(
			offenders(({ contract }) =>
				contract.required.some((key) => !contract.allowed.includes(key)),
			),
		).toEqual([]);
	});

	test("no allowed list repeats a key", () => {
		expect(
			offenders(
				({ contract }) =>
					new Set(contract.allowed).size !== contract.allowed.length,
			),
		).toEqual([]);
	});

	/**
	 * Both the primary key and every `legacyKeys` entry: a fallback key the tool still honours is
	 * a key the tool documents, so flagging it as unknown would be a false positive on valid
	 * input — and `activation/consistent-scope` reads exactly these names off the contract, so a
	 * legacy key missing from `allowed` would make the two rules disagree about the same file.
	 */
	test("an activation key — primary or legacy — is always part of its own allowed set", () => {
		expect(
			offenders(({ contract }) => {
				const { activation } = contract;
				if (activation === undefined) {
					return false;
				}
				return [activation.key, ...(activation.legacyKeys ?? [])].some(
					(key) => !contract.allowed.includes(key),
				);
			}),
		).toEqual([]);
	});

	/**
	 * A "fallback" that is the primary key is a data typo, not a fallback: it would make the
	 * primary look like a legacy key to any consumer walking `legacyKeys` (and, in
	 * `activation/consistent-scope`, turn a perfectly comparable pattern list into an
	 * uncomparable opaque scope).
	 */
	test("no legacy activation key repeats its own contract's primary key", () => {
		expect(
			offenders(({ contract }) => {
				const { activation } = contract;
				if (activation === undefined) {
					return false;
				}
				return (activation.legacyKeys ?? []).includes(activation.key);
			}),
		).toEqual([]);
	});

	/**
	 * `nonActivatingShapes` is set only from a vendor statement or a dated hand check, so every
	 * other contract leaves the key out, never an empty list: omitted means nothing is known.
	 */
	test("only the cursor rules contract records a non-activating shape, and every other contract omits the field", () => {
		expect(
			allContracts()
				.filter(
					({ contract }) =>
						contract.activation !== undefined &&
						"nonActivatingShapes" in contract.activation,
				)
				.map(
					(e) =>
						`${entryKey(e)}=${(e.contract.activation?.nonActivatingShapes ?? ["<unset>"]).join(",")}`,
				),
		).toEqual(["cursor/rules=flow-sequence"]);
	});

	test("a dialect that constrains `name` also allows a `name` key", () => {
		expect(
			offenders(
				({ contract }) =>
					contract.name !== undefined && !contract.allowed.includes("name"),
			),
		).toEqual([]);
	});

	test("every capped key is an allowed key, and every cap is a positive integer", () => {
		expect(
			offenders(({ contract }) =>
				Object.entries(contract.maxLengths ?? {}).some(
					([key, max]) =>
						!contract.allowed.includes(key) ||
						!Number.isInteger(max) ||
						max <= 0,
				),
			),
		).toEqual([]);
	});

	/**
	 * An earlier placeholder allowed-set invented a `version` key. No vendor documents one, so it is
	 * an unknown key everywhere now — pinned here because the mistake was silent last time.
	 */
	test("`version` is not an allowed key in any dialect", () => {
		expect(
			offenders(({ contract }) => contract.allowed.includes("version")),
		).toEqual([]);
	});

	/**
	 * `toolUnknownKeyPolicy` is only set where a vendor states the behaviour in so many words.
	 * Guessing it for the other contracts would put unsourced data behind a passing test.
	 */
	test("only the three vendor-documented unknown-key policies are set", () => {
		expect(
			allContracts()
				.filter(({ contract }) => contract.toolUnknownKeyPolicy !== undefined)
				.map((e) => `${entryKey(e)}=${e.contract.toolUnknownKeyPolicy}`),
		).toEqual([
			"claude-code/rules=ignore",
			"generic/skills=error",
			"opencode/skills=ignore",
		]);
	});

	test("every contract selects at least one file, and no include repeats a pattern", () => {
		expect(
			offenders(
				({ contract }) =>
					contract.include.length === 0 ||
					new Set(contract.include).size !== contract.include.length,
			),
		).toEqual([]);
	});
});

describe("contract locations", () => {
	const located = allContracts().filter(
		({ contract }) => contract.location !== undefined,
	);

	test("only the cursor rules contract has a location", () => {
		expect(located.map(entryKey)).toEqual(["cursor/rules"]);
	});

	test("the cursor rules location is .cursor/rules under .mdc, and frozen", () => {
		const location = BUILTIN_DIALECTS.cursor.contracts.rules?.location;
		if (location === undefined) {
			throw new Error("cursor/rules has no location");
		}
		expect(location).toStrictEqual({
			path: ".cursor/rules",
			extension: ".mdc",
		});
		expect(Object.isFrozen(location)).toBe(true);
		expect(() => {
			(location as { extension: string }).extension = ".md";
		}).toThrow(TypeError);
		expect(CURSOR_RULE_EXTENSION).toBe(location.extension);
	});

	test("a contract's include is every file with the location's extension, so the two cannot disagree", () => {
		expect(located.length).toBeGreaterThan(0);
		for (const { id, kind, contract } of located) {
			expect({ id, kind, include: contract.include }).toEqual({
				id,
				kind,
				include: [`**/*${contract.location?.extension}`],
			});
		}
	});

	test("locations are unique within a kind", () => {
		const seen = new Set<string>();
		for (const { kind, contract } of located) {
			const key = `${kind}:${contract.location?.path}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});

	test("every location is a zero-config candidate row of the same kind and dialect", () => {
		for (const { id, kind, contract } of located) {
			const rows = CANDIDATE_TABLE.filter(
				(row) => row.root === contract.location?.path && row.kind === kind,
			);
			expect(rows.map((row) => row.dialects)).toEqual([[id]]);
		}
	});

	test("readerAt finds the reader of an exact path, for its own kind only", () => {
		const reader = readerAt("rules", ".cursor/rules");
		expect(reader).toStrictEqual({
			dialect: "cursor",
			path: ".cursor/rules",
			extension: ".mdc",
			include: ["**/*.mdc"],
		});
		expect(readerAt("skills", ".cursor/rules")).toBeUndefined();
		expect(readerAt("instructions", ".cursor/rules")).toBeUndefined();
	});

	test("readerAt matches the whole path: no suffix, no other spelling, no other tool", () => {
		for (const path of [
			"packages/web/.cursor/rules",
			".cursor/rules/",
			".cursor/rules/sub",
			".Cursor/rules",
			".claude/rules",
			".cursor/skills",
			"",
		]) {
			expect(readerAt("rules", path)).toBeUndefined();
		}
	});

	test("readerAt hands out frozen data", () => {
		const reader = readerAt("rules", ".cursor/rules");
		if (reader === undefined) {
			throw new Error("no reader at .cursor/rules");
		}
		expect(Object.isFrozen(reader)).toBe(true);
		expect(Object.isFrozen(reader.include)).toBe(true);
		expect(() => {
			(reader as { extension: string }).extension = ".md";
		}).toThrow(TypeError);
		expect(readerAt("rules", ".cursor/rules")?.extension).toBe(".mdc");
	});
});

describe("registry access", () => {
	test("ids are sorted and match the registry keys", () => {
		expect(BUILTIN_DIALECT_IDS).toEqual([
			"claude-code",
			"codex",
			"copilot",
			"cursor",
			"generic",
			"opencode",
		]);
		expect([...BUILTIN_DIALECT_IDS].sort()).toEqual([...BUILTIN_DIALECT_IDS]);
	});

	test("isDialectId accepts built-ins and rejects everything else", () => {
		for (const id of BUILTIN_DIALECT_IDS) {
			expect(isDialectId(id)).toBe(true);
		}
		expect(isDialectId("Claude-Code")).toBe(false);
		expect(isDialectId("")).toBe(false);
		// inherited Object.prototype members must not read as dialects
		expect(isDialectId("toString")).toBe(false);
		expect(isDialectId("constructor")).toBe(false);
		expect(isDialectId("__proto__")).toBe(false);
	});
});

describe("SURFACE_KINDS", () => {
	test("lists every member of the SurfaceKind union, exactly once", () => {
		// The Record literal is the compile-time half: adding a member to `SurfaceKind` without
		// adding it here fails `tsc`. The assertion is the runtime half.
		const everyKind: Record<SurfaceKind, true> = {
			skills: true,
			rules: true,
			instructions: true,
		};
		expect([...SURFACE_KINDS].sort()).toEqual(
			[...Object.keys(everyKind)].sort() as SurfaceKind[],
		);
		expect(new Set(SURFACE_KINDS).size).toBe(SURFACE_KINDS.length);
		expect(SURFACE_KINDS).toEqual(["skills", "rules", "instructions"]);
	});

	test("is frozen", () => {
		expect(() => {
			(SURFACE_KINDS as SurfaceKind[]).push("skills");
		}).toThrow(TypeError);
	});
});

describe("DEFAULT_INCLUDE", () => {
	/**
	 * CLAUDE.md names this exact constant as having already been a freeze regression once:
	 * `Object.freeze` on the record, or on any one of its three arrays, can be removed without a
	 * single one of the 332 tests that existed before this one failing — `freezeSurface`
	 * (config.ts) freezes the *copy* it hands out as `surface.include`, which can never see
	 * whether the shared array `DEFAULT_INCLUDE[kind]` underneath it was itself locked. Every
	 * detected surface, and every written surface with no `include:` of its own, hands this exact
	 * array out to a caller (`surface.include`), so an unfrozen source array is a real, shared
	 * mutable value reachable from outside this module, not a theoretical one.
	 */
	test("the record and every array in it are frozen", () => {
		expect(Object.isFrozen(DEFAULT_INCLUDE)).toBe(true);
		for (const kind of SURFACE_KINDS) {
			expect(Object.isFrozen(DEFAULT_INCLUDE[kind])).toBe(true);
			expect(() => {
				(DEFAULT_INCLUDE[kind] as string[]).push("**/*.evil");
			}).toThrow(TypeError);
		}
		expect(() => {
			(DEFAULT_INCLUDE as Record<SurfaceKind, readonly string[]>).skills = [
				"**/*.evil",
			];
		}).toThrow(TypeError);
	});
});

describe("defaultInclude", () => {
	test("a Claude Code rules surface selects nested .md files, a Cursor one .mdc files", () => {
		expect(defaultInclude("rules", ["claude-code"])).toEqual(["**/*.md"]);
		expect(defaultInclude("rules", ["cursor"])).toEqual(["**/*.mdc"]);
	});

	test("both rules dialects give the union, sorted, whichever order they are listed in", () => {
		const both = ["**/*.md", "**/*.mdc"];
		expect(defaultInclude("rules", ["claude-code", "cursor"])).toEqual(both);
		expect(defaultInclude("rules", ["cursor", "claude-code"])).toEqual(both);
	});

	test("a repeated dialect, and dialects that agree, give each pattern once", () => {
		expect(defaultInclude("rules", ["claude-code", "claude-code"])).toEqual([
			"**/*.md",
		]);
		expect(defaultInclude("skills", BUILTIN_DIALECT_IDS)).toEqual([
			"**/SKILL.md",
		]);
	});

	test("a dialect with no contract for the kind adds nothing, and no dialects at all select nothing", () => {
		expect(defaultInclude("rules", ["cursor", "copilot"])).toEqual([
			"**/*.mdc",
		]);
		expect(defaultInclude("rules", ["copilot"])).toEqual([]);
		expect(defaultInclude("instructions", [])).toEqual([]);
	});

	// Pinned per kind and dialect so that moving the table onto the contracts changed no default:
	// every skills dialect, Cursor rules and Copilot instructions answer what they always did.
	test("the skills and instructions defaults are what they were before the include moved onto the contracts", () => {
		for (const id of dialectsSupportingKind("skills")) {
			expect(defaultInclude("skills", [id])).toEqual(["**/SKILL.md"]);
		}
		expect(defaultInclude("instructions", ["copilot"])).toEqual([
			"**/*.instructions.md",
		]);
		expect(DEFAULT_INCLUDE).toEqual({
			skills: ["**/SKILL.md"],
			rules: ["**/*.mdc"],
			instructions: ["**/*.instructions.md"],
		});
	});

	test("the returned arrays are frozen, for one dialect and for a union", () => {
		for (const ids of [["cursor"], ["claude-code", "cursor"], []] as const) {
			const result = defaultInclude("rules", ids);
			expect(Object.isFrozen(result)).toBe(true);
			expect(() => {
				(result as string[]).push("**/*.evil");
			}).toThrow(TypeError);
		}
	});

	test("answering never changes a contract's own include", () => {
		defaultInclude("rules", ["cursor", "claude-code"]);
		expect(BUILTIN_DIALECTS.cursor.contracts.rules?.include).toEqual([
			"**/*.mdc",
		]);
		expect(BUILTIN_DIALECTS["claude-code"].contracts.rules?.include).toEqual([
			"**/*.md",
		]);
	});
});

describe("SKILL_NAME_PATTERN", () => {
	const ACCEPTED = ["a", "1", "pdf", "pdf-tools", "x1", "a-b-c", "skill-2-go"];

	const REJECTED = [
		"",
		"-lead",
		"trail-",
		"double--hyphen",
		"Upper",
		"snake_case",
		"with space",
		"dot.name",
		"trailing\n", // JS `$` is strict end-of-input (unlike Python/PCRE); pinned so it stays so
		"my-plugin:fancy", // a valid Claude Code plugin display name, not a valid spec name
		"přehled", // Unicode: the spec's prose says a-z0-9 only
		"café",
	];

	test("accepts every well-formed name", () => {
		expect(ACCEPTED.filter((n) => !SKILL_NAME_PATTERN.test(n))).toEqual([]);
	});

	test("rejects every malformed name", () => {
		expect(REJECTED.filter((n) => SKILL_NAME_PATTERN.test(n))).toEqual([]);
	});

	test("is stateless across calls (no `g` flag, so `lastIndex` never advances)", () => {
		expect(SKILL_NAME_PATTERN.global).toBe(false);
		expect(SKILL_NAME_PATTERN.sticky).toBe(false);
		expect(SKILL_NAME_PATTERN.test("pdf-tools")).toBe(true);
		expect(SKILL_NAME_PATTERN.test("pdf-tools")).toBe(true);
	});

	/**
	 * The nested quantifier `(-[a-z0-9]+)*` looks like a backtracking hazard but is not: an
	 * iteration can only begin at `-`, which `[a-z0-9]` cannot match, so no input decomposes
	 * ambiguously. Pinned with the worst shapes at 100k characters — a hostile `SKILL.md` in a
	 * scanned repo is untrusted input, and a linter must not hang on it.
	 */
	test("does not backtrack catastrophically on adversarial input", () => {
		const n = 100_000;
		const inputs = [
			`${"a".repeat(n)}!`,
			`${"a-".repeat(n / 2)}!`,
			`a${"-a".repeat(n / 2)}-!`,
			`${"-".repeat(n)}x`,
		];
		const started = performance.now();
		for (const input of inputs) {
			expect(SKILL_NAME_PATTERN.test(input)).toBe(false);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe("dialect data is frozen", () => {
	test("the registry, a dialect, a contract and an allowed list all reject mutation", () => {
		const generic = BUILTIN_DIALECTS.generic;
		const contract = generic.contracts.skills;
		// Narrowed rather than `?.`-ed: an absent contract must fail the test here, not turn the
		// assertions below into TypeErrors thrown for the wrong reason.
		if (!contract) {
			throw new Error("generic/skills contract is missing");
		}

		expect(() => {
			(BUILTIN_DIALECTS as Record<string, unknown>).generic = undefined;
		}).toThrow(TypeError);
		expect(() => {
			(generic as { id: string }).id = "hacked";
		}).toThrow(TypeError);
		expect(() => {
			(contract as { nameMatchesDir: string }).nameMatchesDir = "decoupled";
		}).toThrow(TypeError);
		expect(() => {
			(contract.allowed as string[]).push("version");
		}).toThrow(TypeError);
		expect(() => {
			(contract.maxLengths as Record<string, number>).name = 9999;
		}).toThrow(TypeError);

		// Nothing above landed: the freeze rejected the writes rather than silently dropping them.
		expect(contract.nameMatchesDir).toBe("must");
		expect(contract.allowed).not.toContain("version");
		expect(contract.maxLengths?.name).toBe(64);
	});

	test("a shared sub-object frozen through one owner is frozen for every owner", () => {
		// `ASCII_NAME` and `SPEC_MAX_LENGTHS` are each referenced by several contracts; the
		// visited-set in `deepFreeze` must not cause the second visit to skip freezing.
		for (const { contract } of allContracts()) {
			if (contract.name) {
				expect(Object.isFrozen(contract.name)).toBe(true);
			}
			if (contract.maxLengths) {
				expect(Object.isFrozen(contract.maxLengths)).toBe(true);
			}
			expect(Object.isFrozen(contract.allowed)).toBe(true);
			expect(Object.isFrozen(contract.required)).toBe(true);
			expect(Object.isFrozen(contract.include)).toBe(true);
		}
	});
});

describe("non-activating shapes are frozen", () => {
	test("the cursor rules list rejects mutation, and nothing lands", () => {
		const activation = BUILTIN_DIALECTS.cursor.contracts.rules?.activation;
		const shapes = activation?.nonActivatingShapes;
		if (shapes === undefined) {
			throw new Error("cursor/rules records no non-activating shape");
		}
		expect(Object.isFrozen(shapes)).toBe(true);
		expect(() => {
			(shapes as string[]).push("flow-sequence");
		}).toThrow(TypeError);
		expect(shapes).toEqual(["flow-sequence"]);
	});
});

describe("dialectsSupportingKind", () => {
	test("names the built-ins that define a contract for each kind", () => {
		expect(dialectsSupportingKind("skills")).toEqual([
			"claude-code",
			"codex",
			"copilot",
			"cursor",
			"generic",
			"opencode",
		]);
		expect(dialectsSupportingKind("rules")).toEqual(["claude-code", "cursor"]);
		expect(dialectsSupportingKind("instructions")).toEqual(["copilot"]);
	});

	test("returns ids in BUILTIN_DIALECT_IDS order, and only real speakers", () => {
		for (const kind of SURFACE_KINDS) {
			const supporting = dialectsSupportingKind(kind);
			expect(supporting).toEqual(
				BUILTIN_DIALECT_IDS.filter((id) => supporting.includes(id)),
			);
			for (const id of supporting) {
				expect(BUILTIN_DIALECTS[id].contracts[kind]).toBeDefined();
			}
		}
	});
});

describe("mergeContracts", () => {
	test("required is the union over claude-code (empty) and generic for skills", () => {
		const merged = mergeContracts(["claude-code", "generic"], "skills");
		expect(merged?.required).toEqual(["name", "description"]);
	});

	test("allowed is the union, and claude-code's allowed set already contains every generic key by name", () => {
		const merged = mergeContracts(["claude-code", "generic"], "skills");
		// generic contributes nothing new here — every one of its 6 keys is already in
		// claude-code's allowed list — so the union equals claude-code's own list verbatim, in
		// claude-code's order (the pair that actually exercises new items is the ordering test
		// below, with copilot + generic).
		expect(merged?.allowed).toEqual(
			BUILTIN_DIALECTS["claude-code"].contracts.skills?.allowed,
		);
	});

	test("ordering is deterministic: first-seen order follows the `ids` array, not alphabetical", () => {
		const forward = mergeContracts(["copilot", "generic"], "skills");
		const backward = mergeContracts(["generic", "copilot"], "skills");

		expect(forward?.allowed).toEqual([
			"name",
			"description",
			"license",
			"allowed-tools",
			"compatibility",
			"metadata",
		]);
		expect(backward?.allowed).toEqual([
			"name",
			"description",
			"license",
			"compatibility",
			"metadata",
			"allowed-tools",
		]);
		expect(forward?.allowed).not.toEqual(backward?.allowed);
	});

	// Named for what this actually pins, not for the min-per-key polarity: no pair of built-in
	// dialects documents two DIFFERENT caps for the same key (see `mergeContractList`'s own tests
	// in this file for that), so this only proves the other half — that a dialect's silence on a
	// key is not itself a wider limit.
	test("a dialect documenting no cap for a key does not loosen another dialect's cap for it", () => {
		// claude-code documents only `compatibility` (500); generic documents `name` (64),
		// `description` (1024) and `compatibility` (500) too. claude-code's silence on
		// `name`/`description` must not erase generic's caps for them, and generic's identical
		// `compatibility` cap must survive the min unchanged.
		const merged = mergeContracts(["claude-code", "generic"], "skills");
		expect(merged?.maxLengths).toEqual({
			compatibility: 500,
			name: 64,
			description: 1024,
		});
	});

	test("names dedupe: every built-in skills dialect that constrains name shares the one ASCII_NAME object, so the merge collapses to a single entry", () => {
		const merged = mergeContracts(
			["generic", "cursor", "opencode", "codex"],
			"skills",
		);
		expect(merged?.names.length).toBe(1);
		expect(merged?.names[0]?.pattern.source).toBe(SKILL_NAME_PATTERN.source);
	});

	test("frontmatter is optional only when every merged contract says so", () => {
		const frontmatterOf = (ids: readonly DialectId[], kind: SurfaceKind) =>
			mergeContracts(ids, kind)?.frontmatter;
		expect(frontmatterOf(["claude-code"], "skills")).toBe("optional");
		expect(frontmatterOf(["claude-code"], "rules")).toBe("optional");
		expect(frontmatterOf(["claude-code", "generic"], "skills")).toBe(
			"required",
		);
		expect(frontmatterOf(["generic", "claude-code"], "skills")).toBe(
			"required",
		);
		expect(frontmatterOf(["claude-code", "cursor"], "rules")).toBe("required");
		expect(frontmatterOf(["cursor", "claude-code"], "rules")).toBe("required");
		expect(frontmatterOf(["cursor"], "rules")).toBe("required");
		expect(frontmatterOf(["generic"], "skills")).toBe("required");
	});

	test("nameMatchesDir: must beats decoupled, in either order", () => {
		expect(
			mergeContracts(["generic", "claude-code"], "skills")?.nameMatchesDir,
		).toBe("must");
		expect(
			mergeContracts(["claude-code", "generic"], "skills")?.nameMatchesDir,
		).toBe("must");
	});

	test("nameMatchesDir: should beats decoupled, in either order", () => {
		expect(
			mergeContracts(["copilot", "claude-code"], "skills")?.nameMatchesDir,
		).toBe("should");
		expect(
			mergeContracts(["claude-code", "copilot"], "skills")?.nameMatchesDir,
		).toBe("should");
	});

	test("nameMatchesDir: must beats should, in either order", () => {
		expect(
			mergeContracts(["generic", "copilot"], "skills")?.nameMatchesDir,
		).toBe("must");
		expect(
			mergeContracts(["copilot", "generic"], "skills")?.nameMatchesDir,
		).toBe("must");
	});

	test("undefined when no listed dialect defines a contract for the kind", () => {
		expect(mergeContracts(["claude-code"], "instructions")).toBeUndefined();
		expect(mergeContracts(["copilot"], "rules")).toBeUndefined();
		expect(
			mergeContracts(["claude-code", "cursor"], "instructions"),
		).toBeUndefined();
	});

	test("a rules surface naming both rules dialects allows the keys of each and requires none", () => {
		const merged = mergeContracts(["claude-code", "cursor"], "rules");
		expect([...(merged?.allowed ?? [])].sort()).toEqual([
			"alwaysApply",
			"description",
			"globs",
			"paths",
		]);
		expect(merged?.required).toEqual([]);
		expect(merged?.nameMatchesDir).toBe("decoupled");
		expect(merged?.names).toEqual([]);
		expect(merged?.maxLengths).toEqual({});
	});

	test("the result is frozen: top-level, both string arrays, names, and the maxLengths record", () => {
		const merged = mergeContracts(["generic"], "skills");
		if (!merged) {
			throw new Error("expected a merged contract");
		}

		expect(Object.isFrozen(merged)).toBe(true);
		expect(Object.isFrozen(merged.required)).toBe(true);
		expect(Object.isFrozen(merged.allowed)).toBe(true);
		expect(Object.isFrozen(merged.names)).toBe(true);
		expect(Object.isFrozen(merged.maxLengths)).toBe(true);

		expect(() => {
			(merged.allowed as string[]).push("evil");
		}).toThrow(TypeError);
		expect(() => {
			(merged.required as string[]).push("evil");
		}).toThrow(TypeError);
		expect(() => {
			(merged as { nameMatchesDir: string }).nameMatchesDir = "decoupled";
		}).toThrow(TypeError);
		expect(() => {
			(merged.maxLengths as Record<string, number>).name = 9999;
		}).toThrow(TypeError);

		expect(merged.allowed).not.toContain("evil");
		expect(merged.maxLengths.name).toBe(64);
	});
});

/**
 * `mergeContractList` exists specifically because no pair of real built-in dialects can pin the
 * min-per-key (`maxLengths`) or all-patterns-apply (`names`) polarities against their opposites —
 * see the function's own JSDoc in dialects.ts. These tests inject synthetic contracts to do what
 * `mergeContracts`'s own tests, built entirely from `BUILTIN_DIALECTS`, structurally cannot.
 */
describe("mergeContractList", () => {
	function contract(
		overrides: Partial<FrontmatterContract>,
	): FrontmatterContract {
		return {
			include: ["**/*.md"],
			required: [],
			allowed: ["description", "name"],
			nameMatchesDir: "decoupled",
			...overrides,
		};
	}

	test("maxLengths is the min per key: two synthetic contracts documenting genuinely different caps for the same key, in both argument orders", () => {
		const looser = contract({ maxLengths: { description: 100 } });
		const tighter = contract({ maxLengths: { description: 50 } });

		expect(mergeContractList([looser, tighter])?.maxLengths).toEqual({
			description: 50,
		});
		expect(mergeContractList([tighter, looser])?.maxLengths).toEqual({
			description: 50,
		});
	});

	test("names: every distinct pattern among synthetic contracts is kept, in first-seen order", () => {
		const onlyA: NameConstraints = {
			pattern: /^a+$/,
			patternDescription: "only the letter a, one or more times",
		};
		const onlyB: NameConstraints = {
			pattern: /^b+$/,
			patternDescription: "only the letter b, one or more times",
		};

		const merged = mergeContractList([
			contract({ name: onlyA }),
			contract({ name: onlyB }),
		]);
		expect(merged?.names.length).toBe(2);
		expect(merged?.names).toEqual([onlyA, onlyB]);

		const reversed = mergeContractList([
			contract({ name: onlyB }),
			contract({ name: onlyA }),
		]);
		expect(reversed?.names).toEqual([onlyB, onlyA]);
	});

	test("frontmatter: a contract that says nothing counts as required, and one required contract makes the merge required", () => {
		const optional = contract({ frontmatter: "optional" });
		expect(mergeContractList([optional])?.frontmatter).toBe("optional");
		expect(mergeContractList([optional, optional])?.frontmatter).toBe(
			"optional",
		);
		expect(mergeContractList([optional, contract({})])?.frontmatter).toBe(
			"required",
		);
		expect(mergeContractList([contract({}), optional])?.frontmatter).toBe(
			"required",
		);
	});

	test("undefined for an empty contract list", () => {
		expect(mergeContractList([])).toBeUndefined();
	});
});
