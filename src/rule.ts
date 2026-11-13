import type { ZodType } from "zod";
import type { RepoRuleContext, RuleContext } from "./context.js";
import type { Loc, Severity } from "./diagnostic.js";
import type { Document } from "./document.js";

export type RuleKind = "file" | "project" | "scan" | "shape";
export type Tier = "recommended" | "strict";

/**
 * The tiers a config may `extend`. The list and the `Tier` union are the same fact, so
 * `config.ts` validates `extends` against this rather than restating the names — and a rule's
 * membership comes from its own `meta.tiers`, never from a table elsewhere. Ordering carries no
 * meaning: `extends` is applied in the order written, and a tier only ever contributes a rule's
 * own `meta.defaultSeverity`, so no order of tiers can produce a different result.
 */
export const TIERS: readonly Tier[] = Object.freeze(["recommended", "strict"]);
export type MaybePromise<T> = T | Promise<T>;

export interface RuleMeta<O = unknown> {
	readonly id: string;
	readonly description: string;
	readonly docsUrl: string;
	readonly tiers: readonly Tier[];
	readonly defaultSeverity: Severity;
	/** default fixability; a report may narrow it per violation */
	readonly fixable: boolean;
	/**
	 * Validated against config `options` by `loadConfig` (positioned) and again by the engine
	 * (as a backstop); undefined = the rule takes no options.
	 *
	 * Put defaults on the *fields*, never on the schema as a whole. A rule enabled without an
	 * `options:` block is parsed as `{}`, not as `undefined`, so a top-level `.default(...)`
	 * never fires and the rule becomes impossible to enable without restating its own defaults
	 * in the config. `z.strictObject({ max: z.number().default(500) })`, not
	 * `z.strictObject({ max: z.number() }).default({ max: 500 })`.
	 */
	readonly optionsSchema?: ZodType<O>;
}

export interface RuleReport {
	message: string;
	loc?: Loc;
	/**
	 * file rules: defaults to the document under check. Other kinds: required.
	 * repo-relative, posix separators (same contract as Diagnostic.file).
	 */
	file?: string;
	fixable?: boolean;
	/**
	 * Never set. This is what makes `Report` (below) an EXCLUSIVE union rather than a union in
	 * name only, and it is not decoration: without it, `ConfigReport` is structurally assignable
	 * to `RuleReport` — it has `message`, and its `file`/`loc` are compatible, so its extra
	 * `problem` key is simply ignored by an assignability check. Measured before this field
	 * existed: `spyOn` (testing/rule-tester.ts) kept its `Promise<RuleReport[]>` annotation and
	 * compiled clean while silently passing `ConfigReport`s through it, and any rule helper
	 * still typed `RuleReport[]` would have swallowed one the same way.
	 *
	 * `problem?: never` says "may be absent; may not be present with a value", which is exactly
	 * the fact `isConfigReport` tests for at runtime — so the type-level and runtime
	 * discriminations are now the same statement rather than two that happen to agree.
	 */
	problem?: never;
}

/**
 * A rule saying "your CONFIGURATION is wrong", not "your repository is wrong".
 *
 * Three rules need this distinction and none of them could express it before: `index/*` with a
 * configured `file` that does not exist (shipped as a stopgap at the rule's own
 * severity), the allowlist-staleness guard `refs/no-dangling-paths` uses, and
 * `docs/contract-sync`'s missing/malformed configured document. A stale allowlist entry is an
 * error UNCONDITIONALLY — at a rule configured `warn` it would not be, which is why severity
 * is not the rule's to choose here.
 *
 * What the engine does with one (`toConfigDiagnostic`, engine.ts, the single place this is
 * decided):
 * - `ruleId` is `config/<problem>` — the engine's own reserved namespace, NOT the reporting
 *   rule's id. `RESERVED_NAMESPACES` (config.ts) still blocks a rule from *registering* a
 *   `config/` id and that is unchanged and deliberate: the engine is not a rule, and it is the
 *   engine that emits these.
 * - `severity` is `error`, whatever the rule is configured at.
 * - Exit is 1, not 2 — this is found while linting, not before it, so the rest of the run's
 *   diagnostics still print (contrast a `ConfigError`, which aborts the run at exit 2 before a
 *   single rule has looked at a single file).
 *
 * `problem` is the `<problem>` half of that id, and nothing more: lowercase, digits and single
 * hyphens (`missing-file`, `stale-allowlist`) — the shape every id in this project already has,
 * validated by the engine, because a rule that returned `"../etc"` would otherwise mint a
 * `Diagnostic.ruleId` of `config/../etc`.
 *
 * `file` defaults to this run's config file (which is what a config problem is normally ABOUT)
 * and `loc` to `ctx.surface.loc` (where that surface was written in the yaml); a `shape` rule has
 * no `ctx.surface`, so its report gets no position unless it sets `loc`. A rule sets them
 * only when it can point somewhere better — `docs/contract-sync`'s block-level problems live in
 * a configured DOCUMENT, not in the config file. Both defaults, and the `file` contract itself,
 * are exactly `RuleReport`'s (repo-relative, posix separators).
 */
export interface ConfigReport {
	/** `<problem>` in the `config/<problem>` id the engine emits; `^[a-z0-9]+(-[a-z0-9]+)*$` */
	problem: string;
	message: string;
	/** defaults to the run's config file; repo-relative, posix (same contract as `RuleReport.file`) */
	file?: string;
	/** defaults to `ctx.surface.loc` (absent for an auto-detected surface); none for a `shape` rule */
	loc?: Loc;
}

/** What every `check` returns: an ordinary violation, or a config-shaped problem. */
export type Report = RuleReport | ConfigReport;

/**
 * Discriminates the `Report` union on the presence of the `problem` KEY, not on its value being
 * a usable string — deliberately, and it is why CLAUDE.md's "never build an object as
 * `{ key: maybeUndefined }`" habit is load-bearing rather than stylistic here. A report built as
 * `{ message, problem: someMaybeUndefined }` has an own `problem` key, so this returns true and
 * the engine then rejects the undefined value as the rule bug it is. The alternative test
 * (`typeof report.problem === "string"`) would instead let that same object through as an
 * ordinary `RuleReport`, silently emitting the rule's own id at the rule's own severity — the
 * exact "your repository is wrong" framing the reporting rule was trying not to use.
 */
export function isConfigReport(report: Report): report is ConfigReport {
	return "problem" in report;
}

export interface FileRule<O = unknown> {
	readonly kind: "file";
	readonly meta: RuleMeta<O>;
	// NOT `readonly`: `readonly` is illegal on a method declaration, and the property form
	// (`readonly check: (...) => ...`) makes the parameter contravariant under
	// `strictFunctionTypes`, at which point `FileRule<Options>` stops being assignable to
	// `Rule<unknown>` and the whole `readonly Rule[]` registry fails to typecheck (measured:
	// 20+ errors across five files). Method syntax keeps the bivariance the registry needs.
	// `freezeRule` locks the property at runtime, which is the half that actually matters.
	check(doc: Document, ctx: RuleContext<O>): MaybePromise<Report[]>;
}
export interface ProjectRule<O = unknown> {
	readonly kind: "project";
	readonly meta: RuleMeta<O>;
	/** not `readonly` — see `FileRule.check` */
	check(ctx: RuleContext<O>): MaybePromise<Report[]>;
}
export interface ScanRule<O = unknown> {
	readonly kind: "scan";
	readonly meta: RuleMeta<O>;
	/** not `readonly` — see `FileRule.check` */
	check(ctx: RuleContext<O>): MaybePromise<Report[]>;
}
export interface ShapeRule<O = unknown> {
	readonly kind: "shape";
	readonly meta: RuleMeta<O>;
	/**
	 * Dispatched exactly once per run, never once per surface — `ctx` carries
	 * `surfaces`, not a single `surface`. Not `readonly` — see `FileRule.check`.
	 */
	check(ctx: RepoRuleContext<O>): MaybePromise<Report[]>;
}

export type Rule<O = unknown> =
	| FileRule<O>
	| ProjectRule<O>
	| ScanRule<O>
	| ShapeRule<O>;

/**
 * Locks a rule singleton: the rule object, its `meta`, and `meta.tiers`.
 *
 * `Readonly<T>` is a type, not a lock, and a rule is among the most widely shared values in the
 * process — one array handed whole to `loadConfig`, to `runEngine`, and to every test,
 * reused for every surface and every document of a run. `Object.freeze(builtinRules)` locked the
 * ARRAY and nothing in it: until this existed, a rule (or a test, or any consumer of the exported
 * registry) could write `builtinRules[0].meta.defaultSeverity = "off"` and silently reconfigure
 * that rule for the rest of the process. The `readonly` markers on `RuleMeta` and the rule
 * interfaces are the compile-time half of the same statement; this is the half that holds for a
 * plain JS consumer and for a cast.
 *
 * Shallow in one deliberate respect: `meta.optionsSchema` is NOT frozen. It is a zod schema, and
 * zod caches internally while parsing — freezing it would trade a mutation nobody performs for a
 * crash on the first `safeParse`.
 *
 * Every built-in applies it at its own definition site rather than in `rules/index.ts`, so a rule
 * imported directly (which every rule test does) is as locked as one reached through the
 * registry, with no dependence on module evaluation order. `rules/index.test.ts` asserts it held
 * for every registered rule, so any rule that forgets the call fails there — that assertion loops
 * over `builtinRules` rather than naming a count, so it needs no edit as the registry grows.
 */
export function freezeRule<O, R extends Rule<O>>(rule: R): R {
	Object.freeze(rule.meta.tiers);
	Object.freeze(rule.meta);
	return Object.freeze(rule);
}
