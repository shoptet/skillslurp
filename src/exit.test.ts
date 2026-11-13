import { expect, test } from "bun:test";
import type { Diagnostic } from "./diagnostic.js";
import {
	computeExitCode,
	EXIT_CLEAN,
	EXIT_ERROR,
	EXIT_VIOLATIONS,
} from "./exit.js";

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

test("EXIT_CLEAN, EXIT_VIOLATIONS, EXIT_ERROR are 0, 1, 2 respectively", () => {
	expect(EXIT_CLEAN).toBe(0);
	expect(EXIT_VIOLATIONS).toBe(1);
	expect(EXIT_ERROR).toBe(2);
});

test("computeExitCode([]) is EXIT_CLEAN", () => {
	expect(computeExitCode([])).toBe(EXIT_CLEAN);
});

test("computeExitCode is EXIT_CLEAN when every diagnostic is a warning", () => {
	const diagnostics = [
		makeDiagnostic({ severity: "warn" }),
		makeDiagnostic({ severity: "warn", file: "other.md" }),
	];

	expect(computeExitCode(diagnostics)).toBe(EXIT_CLEAN);
});

test("computeExitCode is EXIT_VIOLATIONS when at least one diagnostic is an error, even mixed with warnings", () => {
	const diagnostics = [
		makeDiagnostic({ severity: "warn" }),
		makeDiagnostic({ severity: "error", file: "other.md" }),
	];

	expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
});

test("computeExitCode is EXIT_VIOLATIONS when every diagnostic is an error", () => {
	const diagnostics = [makeDiagnostic({ severity: "error" })];

	expect(computeExitCode(diagnostics)).toBe(EXIT_VIOLATIONS);
});
