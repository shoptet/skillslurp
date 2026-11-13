import { expect, test } from "bun:test";
import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";
import {
	type Reporter,
	type RuleLister,
	reporters,
	ruleListers,
} from "./index.js";

/** Builds a `Diagnostic` with sensible defaults, overridable per test. */
function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		ruleId: "rule/id",
		severity: "error",
		message: "message",
		file: "file.md",
		fixable: false,
		docsUrl: "https://example.invalid/docs",
		...overrides,
	};
}

const ONE_DIAGNOSTIC: Diagnostic[] = [
	makeDiagnostic({
		ruleId: "rule/a",
		severity: "error",
		message: "message",
		file: "a.md",
		line: 1,
		col: 1,
	}),
];

/**
 * The table is a module-level object every caller shares, so one consumer writing
 * `reporters.json = somethingElse` would change the output format for the whole process. Frozen
 * for the same reason `SURFACE_KINDS`, `DEFAULT_INCLUDE` and the rule singletons are — and, like
 * those, it was `Readonly<>` in the type long before it was locked at runtime, which is a type,
 * not a lock.
 */
test("the reporter table is frozen, so one caller cannot swap a format out for the next", () => {
	expect(Object.isFrozen(reporters)).toBe(true);
	expect(() => {
		(reporters as Record<string, Reporter>).json = reporters.stylish;
	}).toThrow(TypeError);
	expect(() => {
		(reporters as Record<string, Reporter>).github = reporters.stylish;
	}).toThrow(TypeError);

	// Nothing landed: `reporters.json` still parses as json.
	expect(() => JSON.parse(reporters.json([], { color: false }))).not.toThrow();
});

test("reporters.stylish maps to the stylish implementation, not the json one", () => {
	const out = reporters.stylish(ONE_DIAGNOSTIC, { color: false });

	expect(out).toContain("a.md");
	expect(out).toContain("  1:1  error  message  rule/a");
	// not the json shape
	expect(() => JSON.parse(out)).toThrow();
});

test("reporters.json maps to the json implementation, not the stylish one", () => {
	const out = reporters.json(ONE_DIAGNOSTIC, { color: false });

	const parsed = JSON.parse(out);
	expect(parsed.version).toBe(1);
	expect(parsed.summary).toEqual({ problems: 1, errors: 1, warnings: 0 });
	expect(parsed.diagnostics[0].ruleId).toBe("rule/a");
});

// A third format, distinct from both. The detailed escaping/format contract is
// `github.test.ts`'s job; this only pins that the registry actually routes to it.
test("reporters.github maps to the github implementation, not stylish or json", () => {
	const out = reporters.github(ONE_DIAGNOSTIC, { color: false });

	expect(out).toContain("::error file=a.md,line=1,col=1,title=rule/a::message");
	expect(out).not.toContain("\x1b");
	expect(() => JSON.parse(out)).toThrow();
});

// ---------------------------------------------------------------------------------------------
// `ruleListers` — the `--list-rules` half of the same table.
// ---------------------------------------------------------------------------------------------

const ONE_RULE: readonly Rule[] = [
	{
		kind: "file",
		meta: {
			id: "rule/a",
			description: "listing description",
			docsUrl: "https://example.invalid/docs",
			tiers: ["recommended"],
			defaultSeverity: "error",
			fixable: false,
		},
		check: () => [],
	},
];

/**
 * The whole point of `--list-rules` composing with `--reporter` is that ONE name selects the
 * renderer for either question. Derived from `reporters` rather than typed out: a reporter added
 * to one table and forgotten in the other is caught here at runtime, as well as by
 * `Record<ReporterName, RuleLister>` at compile time.
 */
test("every reporter name has a lister, and no lister exists for a name that is not a reporter", () => {
	expect(Object.keys(ruleListers).sort()).toEqual(
		Object.keys(reporters).sort(),
	);
	// The table now names three formats, not two. The generic equality above
	// would still pass if both tables shrank or grew together, so this pins the literal set —
	// a format added to one table and forgotten in the other fails here even if it fails to
	// break the equality check (e.g. both tables missing the same entry).
	expect(Object.keys(reporters).sort()).toEqual(["github", "json", "stylish"]);
});

test("the lister table is frozen, so one caller cannot swap a listing format out for the next", () => {
	expect(Object.isFrozen(ruleListers)).toBe(true);
	expect(() => {
		(ruleListers as Record<string, RuleLister>).json = ruleListers.stylish;
	}).toThrow(TypeError);

	// Nothing landed: `ruleListers.json` still parses as json.
	expect(() =>
		JSON.parse(ruleListers.json([], { color: false })),
	).not.toThrow();
});

test("ruleListers.stylish maps to the stylish listing, not the json one", () => {
	const out = ruleListers.stylish(ONE_RULE, { color: false });

	expect(out).toBe(
		"rule/a  file  recommended  error  -  listing description  https://example.invalid/docs",
	);
	expect(() => JSON.parse(out)).toThrow();
});

test("ruleListers.json maps to the json listing, not the stylish one", () => {
	const parsed = JSON.parse(ruleListers.json(ONE_RULE, { color: false })) as {
		id: string;
		kind: string;
	}[];

	expect(parsed).toHaveLength(1);
	expect(parsed[0]?.id).toBe("rule/a");
	expect(parsed[0]?.kind).toBe("file");
});
