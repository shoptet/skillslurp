import { github, githubRules } from "./github.js";
import { json, jsonRules } from "./json.js";
import { stylish, stylishRules } from "./stylish.js";
import type { Reporter, RuleLister } from "./types.js";

export type { Reporter, ReporterOptions, RuleLister } from "./types.js";

/**
 * The reporter table the CLI resolves `--reporter` against. Frozen and `Readonly<>` for the reason
 * `SURFACE_KINDS`, `DEFAULT_INCLUDE` and the rule singletons are: it is a module-level object
 * handed to every caller, so one consumer writing `reporters.json = somethingElse` would rewrite
 * the output format for the whole process. `Readonly<T>` alone is a type, not a lock.
 */
export const reporters: Readonly<
	Record<"stylish" | "json" | "github", Reporter>
> = Object.freeze({
	stylish,
	json,
	github,
});

export type ReporterName = keyof typeof reporters;

/**
 * The `--list-rules` half of the same table, keyed by the SAME names, so one `--reporter` value
 * selects the renderer for whichever question the user asked.
 *
 * `Record<ReporterName, RuleLister>` — rather than a second independent key list — is what makes
 * "every reporter can also list" a compile-time fact: a third reporter added above without a
 * lister here fails to typecheck, instead of turning `--list-rules --reporter github` into a
 * runtime `undefined` that the CLI's own `isReporterName` guard would have waved through.
 * Frozen for the reason `reporters` is.
 */
export const ruleListers: Readonly<Record<ReporterName, RuleLister>> =
	Object.freeze({
		stylish: stylishRules,
		json: jsonRules,
		github: githubRules,
	});
