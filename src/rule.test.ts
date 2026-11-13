import { describe, expect, test } from "bun:test";
import type { Rule } from "./rule.js";

function describeKind(rule: Rule): string {
	switch (rule.kind) {
		case "file":
			return "file";
		case "project":
			return "project";
		case "scan":
			return "scan";
		case "shape":
			return "shape";
		default: {
			// Compile-time exhaustiveness guarantee: if `Rule` ever gains a kind
			// without a case above, `rule` here narrows to something other than
			// `never` and `bun run typecheck` fails.
			const exhaustive: never = rule;
			throw new Error(`unhandled rule kind: ${String(exhaustive)}`);
		}
	}
}

describe("Rule discriminated union", () => {
	test("switch on the top-level rule.kind narrows exhaustively and dispatches", () => {
		const fileRule: Rule = {
			kind: "file",
			meta: {
				id: "test/minimal-file-rule",
				description: "minimal file rule for narrowing test",
				docsUrl: "https://example.invalid/docs",
				tiers: ["recommended"],
				defaultSeverity: "error",
				fixable: false,
			},
			check: () => [],
		};

		expect(describeKind(fileRule)).toBe("file");
	});
});
