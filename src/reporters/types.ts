import type { Diagnostic } from "../diagnostic.js";
import type { Rule } from "../rule.js";

export interface ReporterOptions {
	/** Whether the reporter may emit ANSI color codes. The CLI decides this (TTY/NO_COLOR); reporters never sniff it themselves. */
	color: boolean;
}

/**
 * A reporter is a pure string producer: no `process`/stdout access, no env reads. This keeps
 * outputs pinnable in tests — the CLI decides color and does the actual writing.
 */
export type Reporter = (
	diagnostics: readonly Diagnostic[],
	options: ReporterOptions,
) => string;

/**
 * The `--list-rules` counterpart of `Reporter`, under the same purity contract and the same
 * `ReporterOptions`, selected by the same `--reporter` name: listing the registry is a different
 * question about the same tool, not a different tool, so a user must not have to learn a second
 * output-format flag to ask it.
 *
 * It has to be a second function type rather than a reuse of `Reporter` because the input is a
 * different thing: `Reporter` takes `Diagnostic[]`, and a rule is not a violation — squeezing one
 * into a `Diagnostic` would mean inventing a file, a severity-as-verdict and a message per rule,
 * every one of which a reader would reasonably take for the result of a lint that never ran.
 *
 * The type-only import of `Rule` is why this file may reference it at all: nothing in `rule.ts`'s
 * transitive graph imports `reporters/`, and the import is erased at build time regardless, so no
 * runtime edge (and no cycle for `noImportCycles`) is created.
 */
export type RuleLister = (
	rules: readonly Rule[],
	options: ReporterOptions,
) => string;
