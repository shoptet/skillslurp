import type { Diagnostic } from "./diagnostic.js";

/** 0 = clean, 1 = lint violations found, 2 = the CLI's catch-path for thrown errors. */
export const EXIT_CLEAN = 0 as const;
export const EXIT_VIOLATIONS = 1 as const;
export const EXIT_ERROR = 2 as const;

/** 1 iff any diagnostic has severity "error"; warnings alone (or zero diagnostics) → 0. */
export function computeExitCode(diagnostics: readonly Diagnostic[]): 0 | 1 {
	return diagnostics.some((d) => d.severity === "error")
		? EXIT_VIOLATIONS
		: EXIT_CLEAN;
}
