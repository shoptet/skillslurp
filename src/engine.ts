import { posix } from "node:path";
import { baselineFilePath } from "./baseline.js";
import {
	ConfigError,
	type ConfigProblem,
	describeSurface,
	RESERVED_NAMESPACES,
	type ResolvedConfig,
	type ResolvedSurface,
	validateRegistry,
} from "./config.js";
import type {
	Capabilities,
	ChangedFile,
	CorpusScope,
	RepoRuleContext,
	RuleContext,
} from "./context.js";
import { createCapabilities } from "./context.js";
import {
	type Diagnostic,
	DOCS_URL,
	type Loc,
	locFields,
	type Severity,
} from "./diagnostic.js";
import { discoverFiles } from "./discover.js";
import type { Document } from "./document.js";
import { readDocument } from "./document.js";
import { NotAGitCheckoutError } from "./git.js";
import { displayPath, pathKey } from "./paths.js";
import type {
	ConfigReport,
	Report,
	Rule,
	RuleMeta,
	RuleReport,
} from "./rule.js";
import { isConfigReport } from "./rule.js";

// Re-exported for callers (e.g. engine.test.ts) that historically imported these from here.
// `DOCS_URL` lives in diagnostic.ts so rules can use it without a rules → engine import edge
// (see skill/frontmatter-schema.ts); `validateRegistry` moved to config.ts, because
// `loadConfig` now consumes the registry and must not be the one component that trusts it
// unchecked.
export { DOCS_URL, validateRegistry };

const PARSE_FRONTMATTER_RULE_ID = "parse/frontmatter";

// Structural link: if RESERVED_NAMESPACES and this id ever drift
// apart, fail loudly at import time instead of silently letting a configured rule collide
// with the engine-owned parse/frontmatter pseudo-rule.
if (
	!RESERVED_NAMESPACES.some((ns) => PARSE_FRONTMATTER_RULE_ID.startsWith(ns))
) {
	throw new Error(
		`internal error: PARSE_FRONTMATTER_RULE_ID "${PARSE_FRONTMATTER_RULE_ID}" must start with a reserved namespace`,
	);
}

/**
 * The prefix a `ConfigReport`'s `problem` is minted into a rule id under — `config/`,
 * an engine-owned reserved namespace no rule may REGISTER an id in (`validateRegistry`,
 * config.ts). That asymmetry is the whole point: a rule cannot call itself `config/anything`,
 * but it can ask the engine to emit under that namespace on its behalf, and the engine is the
 * one that decides the id, the severity and the file.
 *
 * Exported for `testing/rule-tester.ts`, whose "a diagnostic not carrying the rule under test's
 * id must be an engine pseudo-rule" guard has to recognize these as legitimate output of the
 * rule under test.
 */
export const CONFIG_REPORT_NAMESPACE = "config/";

// Same structural link as PARSE_FRONTMATTER_RULE_ID's just above, for the same reason.
if (!RESERVED_NAMESPACES.some((ns) => CONFIG_REPORT_NAMESPACE.startsWith(ns))) {
	throw new Error(
		`internal error: CONFIG_REPORT_NAMESPACE "${CONFIG_REPORT_NAMESPACE}" must start with a reserved namespace`,
	);
}

/**
 * The shape a `ConfigReport.problem` must have to become the second half of a rule id: the
 * lowercase-hyphenated form every id in this project already uses, engine-owned
 * (`config/no-files`, `config/invalid`, `parse/frontmatter`) and rule-owned
 * (`index/no-missing-targets`, `skill/name-matches-dir`) alike.
 *
 * Validated rather than trusted because `Diagnostic.ruleId` is user-facing and machine-read: a
 * rule handing back `"../etc"`, `""`, or a string with a slash in it would mint
 * `config/../etc` — an id no user could look up and no baseline could key on. The rejection is
 * a rule bug, routed through the same crash path as a throwing `check` (`runEngine` point 7),
 * not a diagnostic.
 */
const CONFIG_PROBLEM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `describeSurface`'s stand-in for a `"shape"` rule's crash/report messages: this
 * kind has no single surface to name, by construction — `ctx.surfaces` is the whole list, never
 * one entry — so every message that would otherwise say `surfaces[1] (".claude")` says this
 * instead.
 */
const REPO_RULE_DESCRIPTOR = "the repository";

interface EnabledRule {
	severity: Severity;
	/** built once per (rule, surface) — it does not depend on the document — and frozen, options and surface both included */
	ctx: RuleContext<unknown>;
}

/**
 * One enabled-rule map per surface, keyed by the `ResolvedSurface` object itself rather than by
 * `surface.root` or index. Identity keying is correct, not merely convenient: `discoverFiles`
 * puts the very `config.surfaces[i]` object on `DiscoveredFile.surface`, `readDocument` carries
 * that same reference through to `Document.surface`, and this map is built by iterating that
 * same `config.surfaces` array — so a document's surface reference IS one of this map's keys,
 * never a lookalike a `===` comparison would miss.
 */
type EnabledBySurface = ReadonlyMap<
	ResolvedSurface,
	ReadonlyMap<string, EnabledRule>
>;

/** `EnabledRule`'s `"shape"` counterpart: built once for the whole run, never per surface. */
interface EnabledRepoRule {
	readonly severity: Severity;
	readonly ctx: RepoRuleContext<unknown>;
}

/**
 * `resolveRepoRules`'s return value — the once-per-run counterpart of `EnabledBySurface`, keyed
 * by rule id rather than by surface since a `"shape"` rule has no surface to key on.
 */
interface RepoRules {
	readonly shape: ReadonlyMap<string, EnabledRepoRule>;
}

/**
 * Validates one rule's options blob against its own schema (or rejects it outright when the
 * rule takes none), producing the same problem shape `resolveEnabledBySurface`'s two call sites
 * both need — the global layer (once per rule) and each surface's own override (once per
 * (rule, surface) that writes one). `prefix`, when given, is prepended as `"<prefix>: "`; it is
 * the surface descriptor (`surfaces[1] (".agents/skills")`) for a surface-written blob, and
 * `undefined` for the global layer — without it, a surface's and the global layer's failures on
 * the same rule would produce indistinguishable messages. No `loc`: this is the engine's
 * loc-less backstop validation (see the function doc below), positions come from `loadConfig`.
 */
function validateRuleOptions(
	rule: Rule,
	options: unknown,
	prefix: string | undefined,
	problems: ConfigProblem[],
): { options: unknown } | undefined {
	const { optionsSchema, id } = rule.meta;
	const lead = prefix ? `${prefix}: ` : "";
	if (!optionsSchema) {
		if (options !== undefined) {
			problems.push({ message: `${lead}rule "${id}" accepts no options` });
			return undefined;
		}
		return { options: undefined };
	}
	// `options === undefined ? {} : options`, NOT `options ?? {}`: config.ts's
	// `checkRuleOptions` treats `null` as a mistake worth reporting, not a synonym for omitting
	// the key (`options:` with nothing after it is a typo, not "no options"). A
	// `??` here would swallow a hand-built `ResolvedConfig`'s `options: null` as `{}`, which is
	// exactly the kind of disagreement between this backstop and the real pipeline it is supposed
	// to back up — the same reason an inert override's options are validated below.
	const result = optionsSchema.safeParse(options === undefined ? {} : options);
	if (!result.success) {
		const issues = result.error.issues as readonly {
			path: readonly (string | number)[];
			message: string;
		}[];
		problems.push(
			...issues.map((issue) => {
				const path = issue.path.join(".");
				return {
					message: path
						? `${lead}rule "${id}" options.${path}: ${issue.message}`
						: `${lead}rule "${id}" options: ${issue.message}`,
				};
			}),
		);
		return undefined;
	}
	return { options: result.data };
}

/** Shadows a Map/Set's mutators with a throwing function, exactly like `sealMap` in config.ts. */
function refuseMutation(): never {
	throw new TypeError("rule options are read-only");
}

/**
 * Freezes `value` and, recursively, every object/array/Map/Set reachable from it. A rule that
 * mutates its own (cached, shared-across-documents) validated options must not poison every
 * subsequent document with an order-dependent side effect. Guards against cycles with a `seen`
 * set: options originate from a JSON config (via zod), which cannot express a cycle, but a
 * `ResolvedConfig` built in code can hand one in — and the same hazard is live for
 * `Frontmatter.data`, whose YAML can alias (document.ts).
 *
 * `Object.freeze` on a `Map` or `Set` is cosmetic — `Object.isFrozen` reports
 * `true`, but `set`/`add`/`delete`/`clear` keep working, because a collection's entries live in
 * internal slots rather than enumerable own properties that `Object.keys` (and `Object.freeze`
 * itself) can see. An options schema that transforms an array into a `Set` for O(1) lookups —
 * entirely ordinary, and reachable from plain config yaml — used to defeat this function
 * silently, and the engine makes the blast radius worse by sharing one validated options object *by
 * reference* across every surface that does not override a rule: one rule mutating a `Set` in
 * its own options would poison every later surface in the same run. Map/Set entries (keys and
 * values for a Map, values for a Set) are walked and frozen like any other reachable value, and
 * the mutators are shadowed with own, throwing properties — the same technique `sealMap`
 * already uses for the resolved config, referenced here rather than reinvented.
 *
 * Residual limitation, stated honestly rather than silently: an object with mutable internal
 * slots and no enumerable keys that this function does NOT shadow — a `Date` (`setTime`), a
 * class instance hiding state behind private fields — stays mutable. A rule mutating its own
 * options is a rule bug either way; this function locks the shapes a zod schema realistically
 * produces (plain objects, arrays, Maps, Sets), not every shape JavaScript can construct.
 */
function deepFreeze<T>(value: T, seen: Set<unknown> = new Set()): T {
	if (value === null || typeof value !== "object" || seen.has(value)) {
		return value;
	}
	seen.add(value);
	if (value instanceof Map) {
		for (const [k, v] of value) {
			deepFreeze(k, seen);
			deepFreeze(v, seen);
		}
		Object.assign(value, {
			set: refuseMutation,
			delete: refuseMutation,
			clear: refuseMutation,
		});
		return Object.freeze(value);
	}
	if (value instanceof Set) {
		for (const v of value) {
			deepFreeze(v, seen);
		}
		Object.assign(value, {
			add: refuseMutation,
			delete: refuseMutation,
			clear: refuseMutation,
		});
		return Object.freeze(value);
	}
	for (const key of Object.keys(value)) {
		deepFreeze((value as Record<string, unknown>)[key], seen);
	}
	return Object.freeze(value);
}

/**
 * Builds one enabled-rule map per surface. The "dialect → tier → global →
 * surface" chain is four layers on paper but only two are config-settings layers here: `loadConfig`
 * has already collapsed tier → global into `config.rules` (the base), so this function's whole
 * job is base + the surface delta. The dialect layer is NOT a rule-severity/options layer at
 * all — no dialect carries a severity or an options blob — it is consumed by rules themselves,
 * reading `doc.surface.dialects` directly (e.g. frontmatter-schema falls back to the
 * dialect contracts only when its own `required`/`allowed` options are absent). Stated here so
 * the next reader does not go hunting `ResolvedConfig` for a dialect-settings layer that was
 * never going to exist.
 *
 * Per rule id, per surface:
 * - Severity and options are validated and resolved as two INDEPENDENT layers, following ESLint: a bare severity changes the severity and keeps whatever options
 *   were already configured, rather than resetting them. `severity = override?.severity ??
 *   base?.severity`; `undefined` or `"off"` means the rule is not enabled on this surface. A
 *   surface `severity` can turn a globally-off/absent rule back on for that surface alone
 *   (`base` undefined, `override.severity` set) — see the options bullet below for what such a
 *   rule inherits. The reverse — a surface entry that writes only `options` on a rule that is
 *   off globally — leaves it off: options for a disabled rule are inert (ESLint-shaped), never
 *   an implicit enable — but are still validated, never merely ignored.
 * - Options: an override's own `options`, when present, are validated *as written*, ahead of
 *   and regardless of the severity gate above, and REPLACE the global blob wholesale —
 *   never a deep merge (decided in `loadConfig`'s comment on the same point) — so a field the
 *   surface does not mention falls back to the *schema* default, not to the global value.
 *   Otherwise, a rule with a `base` entry inherits the globally validated, already-frozen
 *   options object — shared, by reference, with every other surface that does not override it;
 *   re-validating a copy per surface would work but would silently stop being the same object,
 *   which is itself worth relying on (cheap to assert, and it is what makes the shared case
 *   actually shared instead of merely equal). A rule with neither a `base` entry nor override
 *   options (enabled by a surface's bare severity alone) validates `config.ruleOptions.get(id)`
 *   — the exact options blob the user wrote in the global `rules:` block for this id,
 *   even if that rule is `off` there, or `undefined` i.e. `{}` when no such blob exists at all —
 *   cached per id so N surfaces enabling the same rule this way do not re-validate (and, on
 *   failure, re-report) it N times.
 *
 * Each resulting `RuleContext` also carries `surface` — the very `ResolvedSurface` object
 * this pass of the outer `config.surfaces.forEach` is on, the same reference this function
 * keys `bySurface` with — so a `project`/`scan` rule dispatched with this context (which gets
 * no `doc` argument at all) still knows which surface it is scoped to.
 *
 * A rule whose *global* options fail validation is skipped in the per-surface pass entirely
 * (tracked in `globalFailed`): the run is already going to fail on that `ConfigError`, and
 * re-validating the same broken blob against every surface would only produce near-duplicate
 * problems for one mistake. Every rule id considered is looked up in `registry`; an id present
 * in `config.rules` or a surface's `rules` but absent from `registry` is silently skipped —
 * `loadConfig` already rejects unknown rule ids against the registry, so in practice this never
 * happens: a defensive fallback, not a second source of truth.
 *
 * All problems, from every rule and every surface, are collected into a single `ConfigError`
 * before any rule runs (matching the collect-all-within-a-stage convention `loadConfig` uses):
 * this function and `resolveRepoRules` push into one shared list that `runEngine` throws once,
 * this function's problems first.
 * Surfaces are processed in config order and each surface's rule ids in sorted order, so the
 * problem list — like everything else this engine produces — is deterministic.
 * `loadConfig` performs the equivalent validation first and positions every issue at its yaml
 * node, so in a normal run this pass never fires; it stays as a defensive backstop for a caller
 * that builds a `ResolvedConfig` without going through `loadConfig` (the engine's own tests do
 * exactly that), and its problems carry no `loc` because there is no document to point into. A
 * surface-written blob's problems are prefixed with that surface's descriptor
 * (`surfaces[1] (".agents/skills"): rule "x" options.max: …`) — without it, two surfaces'
 * failures on the same rule id would be indistinguishable.
 */
function resolveEnabledBySurface(
	config: ResolvedConfig,
	registry: readonly Rule[],
	caps: Capabilities,
	problems: ConfigProblem[],
): EnabledBySurface {
	const byId = new Map(registry.map((rule) => [rule.meta.id, rule] as const));

	// The base (tier → global) layer, validated once per id — the same computation the engine ran
	// before per-surface overrides existed, just renamed and reused as the shared starting point
	// for every surface below.
	// `"shape"` ids are skipped here: they are resolved once for the whole run by
	// `resolveRepoRules` instead, and validating their options here too would be pointless work
	// at best — this map is only ever read from the per-surface loop below, which itself never
	// enables one of these kinds — and a second, independent validation pass at worst.
	const globalOptions = new Map<string, unknown>();
	const globalFailed = new Set<string>();
	for (const [id, resolvedRule] of config.rules) {
		const rule = byId.get(id);
		if (!rule || rule.kind === "shape") {
			continue;
		}
		const validated = validateRuleOptions(
			rule,
			resolvedRule.options,
			undefined,
			problems,
		);
		if (validated === undefined) {
			globalFailed.add(id);
			continue;
		}
		globalOptions.set(id, deepFreeze(validated.options));
	}

	// Every id that could be enabled on at least one surface: the base layer, plus every id any
	// surface writes an override for. An id absent from both never gets a severity anywhere.
	const allIds = [
		...new Set([
			...config.rules.keys(),
			...config.surfaces.flatMap((surface) => [...surface.rules.keys()]),
		]),
	].sort();

	// Shared cache for a rule enabled by a bare surface severity with no override options of its
	// own: the inherited blob is `config.ruleOptions.get(id)` — a real options value when
	// the global `rules:` block wrote one, even for an `off` rule, else `undefined` i.e. `{}` —
	// and it is the same value for every such surface, so it is validated once per id (success
	// cached in `inheritedOptions`, failure in `inheritedFailed` so a broken schema is reported
	// once, not once per surface that happens to enable the rule this way).
	const inheritedOptions = new Map<string, unknown>();
	const inheritedFailed = new Set<string>();

	const bySurface = new Map<
		ResolvedSurface,
		ReadonlyMap<string, EnabledRule>
	>();

	config.surfaces.forEach((surface, index) => {
		const enabled = new Map<string, EnabledRule>();
		for (const id of allIds) {
			if (globalFailed.has(id)) {
				continue;
			}
			const rule = byId.get(id);
			if (!rule) {
				continue;
			}

			// `"shape"` rules are never enabled per surface: they are resolved once
			// for the whole run by `resolveRepoRules`. A surface `rules:` entry naming one is
			// a positioned `ConfigError` in `loadConfig` (`checkNoSurfaceRepoRules`, config.ts)
			// — this is the engine's own backstop for a hand-built `ResolvedConfig` that
			// skipped that check, applying the principle that a surface entry that can never do
			// anything should itself be an error. An id with no surface override at all (the ordinary
			// case — the rule is either off, or configured only in the global layer) is simply
			// skipped: it belongs to `resolveRepoRules`, not to this map.
			if (rule.kind === "shape") {
				if (surface.rules.has(id)) {
					problems.push({
						message: `${describeSurface(surface, index)}: rule "${id}" is repository-wide and must be configured in the top-level "rules"`,
					});
				}
				continue;
			}

			const base = config.rules.get(id);
			const override = surface.rules.get(id);

			// an override's own options are validated here, ahead of and
			// unconditionally of the severity gate below — even when this id ends up disabled on
			// this surface. `loadConfig` validates options written for a globally-off rule on
			// purpose (a typo must not survive an `off` that someone deletes later — see
			// `checkRuleOptions`'s JSDoc), and this loc-less backstop exists specifically for a
			// hand-built `ResolvedConfig` that skipped `loadConfig`; gating on severity first
			// let such a caller accept the exact typo the real pipeline rejects. A backstop that
			// disagrees with the pipeline it backs up is worse than no backstop at all.
			let overrideOptions: { options: unknown } | undefined;
			if (override?.options !== undefined) {
				overrideOptions = validateRuleOptions(
					rule,
					override.options,
					describeSurface(surface, index),
					problems,
				);
				if (overrideOptions === undefined) {
					continue;
				}
			}

			const severity = override?.severity ?? base?.severity;
			if (severity === undefined || severity === "off") {
				continue;
			}

			let options: unknown;
			if (overrideOptions !== undefined) {
				options = deepFreeze(overrideOptions.options);
			} else if (base !== undefined) {
				options = globalOptions.get(id);
			} else {
				if (!inheritedOptions.has(id) && !inheritedFailed.has(id)) {
					const validated = validateRuleOptions(
						rule,
						config.ruleOptions.get(id),
						undefined,
						problems,
					);
					if (validated === undefined) {
						inheritedFailed.add(id);
					} else {
						inheritedOptions.set(id, deepFreeze(validated.options));
					}
				}
				if (inheritedFailed.has(id)) {
					continue;
				}
				options = inheritedOptions.get(id);
			}

			const ctx: RuleContext<unknown> = Object.freeze({
				...caps,
				options,
				surface,
			});
			enabled.set(id, { severity, ctx });
		}
		bySurface.set(surface, enabled);
	});

	return bySurface;
}

/**
 * `resolveEnabledBySurface`'s counterpart for `"shape"` rules: resolved exactly ONCE
 * for the whole run, from the global layer only. There is no per-surface delta to apply — a
 * surface cannot enable, disable or configure one of these ids at all (enforced above, in
 * `resolveEnabledBySurface`, and positioned earlier still in `loadConfig`) — so the severity
 * and options that exist for one of these ids are entirely `config.rules`'s own entry, already
 * collapsed from tier → global by `loadConfig` (a tier contributes `meta.defaultSeverity`,
 * a top-level `rules:` entry overrides it). Options are validated once per id here, never once
 * per surface — the whole point of resolving this kind outside `resolveEnabledBySurface` in the
 * first place.
 */
function resolveRepoRules(
	config: ResolvedConfig,
	registry: readonly Rule[],
	caps: Capabilities,
	problems: ConfigProblem[],
): RepoRules {
	const shape = new Map<string, EnabledRepoRule>();

	for (const rule of registry) {
		if (rule.kind !== "shape") {
			continue;
		}
		const resolved = config.rules.get(rule.meta.id);
		if (resolved === undefined) {
			// Off, or never mentioned by a tier or the global `rules:` block — not enabled
			// anywhere. Matches `resolveEnabledBySurface`'s own "no entry" case.
			continue;
		}
		const validated = validateRuleOptions(
			rule,
			resolved.options,
			undefined,
			problems,
		);
		if (validated === undefined) {
			continue;
		}
		const options = deepFreeze(validated.options);
		const ctx: RepoRuleContext<unknown> = Object.freeze({
			...caps,
			options,
			surfaces: config.surfaces,
		});
		shape.set(rule.meta.id, { severity: resolved.severity, ctx });
	}

	return { shape };
}

/** Maps a document's yaml frontmatter parse errors to `parse/frontmatter` diagnostics. */
function frontmatterDiagnostics(doc: Document): Diagnostic[] {
	const fm = doc.frontmatter;
	if (!fm) {
		return [];
	}
	return fm.errors.map((problem) => ({
		ruleId: PARSE_FRONTMATTER_RULE_ID,
		severity: "error",
		message: problem.message,
		file: doc.path,
		...locFields(problem.loc),
		fixable: false,
		docsUrl: DOCS_URL,
	}));
}

/**
 * Normalizes a posix `RuleReport.file` value into the normal form `Diagnostic.file` should
 * always have carried. Backslashes are converted to `/` FIRST — the same order `paths.ts`'s
 * `toPosixPath` uses, and for the identical reason: a Windows-authored `"a\\b.md"` is not
 * touched by `posix.normalize` at all otherwise, since backslash is not a separator it
 * recognizes. `posix.normalize` then collapses `.`/`..` segments and repeated separators, so
 * `"./x.md"` and `"x.md"` (or `"a/./b.md"` and `"a/b.md"`) become the identical string — this is
 * the property this function exists to establish: two reports naming "the same file" two
 * different ways used to reach two different `Diagnostic.file` strings (measured), which
 * defeats grouping by file wherever a reporter, `compareDiagnostics`, or a baseline keys off
 * it. This is NOT `rules/index/shared.ts`'s `normalizeConfiguredPath`: that one normalizes an
 * INCOMING config value (and, unlike this function, strips a trailing slash — a directory is
 * never a valid index `file`); this one normalizes an OUTGOING rule report, a different input
 * with a different contract, so the two do not collapse into one function.
 */
function normalizeReportFile(file: string): string {
	return posix.normalize(file.replace(/\\/g, "/"));
}

/**
 * True for an already-`normalizeReportFile`d posix path that is unusable as a `Diagnostic.file`:
 * absolute or `..`-escaping (the pre-existing question — `"a/../../etc/passwd"`, `"./../x"` and
 * `"docs/../../x.md"` every one climb out of the repo while starting with neither `/` nor
 * `../`, so a prefix test against the RAW string called all three of them safe, measured; hence
 * normalizing first), or — new in this fix — empty, whitespace-only (normalize does not collapse
 * plain whitespace into anything, so this needs its own check), or exactly `"."` (what an empty
 * string, and a `..`-only navigation straight back to the repo root, both normalize to). None of
 * the second group names an actual file a diagnostic could point at. This is the same question
 * `rule-tester.ts`'s `assertSafeFiles` asks about a case's `files` keys (the escaping half only),
 * and `rules/index/shared.ts`'s `isRepoRelative` asks about an incoming config value.
 */
function isUnusableReportFile(normalized: string): boolean {
	return (
		normalized.trim() === "" ||
		normalized === "." ||
		posix.isAbsolute(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../")
	);
}

/** `isUnusableReportFile`'s two reasons, worded for the crash message; shared by both converters. */
function unusableReportFileReason(normalized: string): string {
	return normalized === "." || normalized.trim() === ""
		? "reported an empty file path"
		: "reported a file path outside the repository";
}

/**
 * Flattens a `RuleReport` (plus the engine-owned fields a rule cannot lie about) into a
 * `Diagnostic`. `report.file` is otherwise trusted from the rule (per the `RuleReport.file`
 * contract: repo-relative, posix separators) ONCE NORMALIZED (`normalizeReportFile`) — a rule
 * returning an absolute path, a `..`-escaping one, or a blank one is a rule bug, not a value to
 * silently forward into `Diagnostic.file`, so it throws here instead. The caller (the `"file"`
 * case in `runEngine`) wraps this in the same crash path as a throwing `check`, so it surfaces
 * as exit 2.
 */
function toDiagnostic(
	meta: RuleMeta,
	severity: Severity,
	report: RuleReport,
	docPath: string,
): Diagnostic {
	let file = docPath;
	if (report.file !== undefined) {
		const normalized = normalizeReportFile(report.file);
		if (isUnusableReportFile(normalized)) {
			throw new Error(
				`rule "${meta.id}" ${unusableReportFileReason(normalized)}: "${report.file}"`,
			);
		}
		file = normalized;
	}
	return {
		ruleId: meta.id,
		severity,
		message: report.message,
		file,
		...locFields(report.loc),
		fixable: report.fixable ?? meta.fixable,
		docsUrl: meta.docsUrl,
	};
}

/**
 * `toDiagnostic`'s `project`/`scan` counterpart — deliberately a sibling function, not an
 * overload or an optional `docPath`, so `toDiagnostic` itself stays exactly as it was for file
 * rules. A `docPath` fallback has no meaning here: a `project`/`scan` rule's `check` gets no
 * document at all (see `runEngine`'s second dispatch loop), so `RuleReport.file` is not merely
 * preferred, it is required — `RuleReport.file`'s own doc comment already says so ("file rules:
 * defaults to the document under check. Other kinds: required."). A report missing it is a rule
 * bug, not a value to invent a fallback for, so it throws here instead of ever reaching
 * `Diagnostic.file: undefined` — same posture as `toDiagnostic`'s escaping-file throw just
 * above, and routed through the same crash path by the same caller. `report.file` still goes
 * through `normalizeReportFile`/`isUnusableReportFile` once it is known to be present, so an
 * absolute, `..`-escaping, or blank path is rejected exactly as it would be for a file rule.
 * `surfaceDescriptor` (from `describeSurface`) names the surface in the missing-file message
 * only — it is never a source of a fallback `file` value.
 */
function toProjectDiagnostic(
	meta: RuleMeta,
	severity: Severity,
	report: RuleReport,
	surfaceDescriptor: string,
): Diagnostic {
	if (report.file === undefined) {
		throw new Error(
			`rule "${meta.id}" reported no file while checking ${surfaceDescriptor}: "file" is required on a "project"/"scan"/"shape" rule's report`,
		);
	}
	const normalized = normalizeReportFile(report.file);
	if (isUnusableReportFile(normalized)) {
		throw new Error(
			`rule "${meta.id}" ${unusableReportFileReason(normalized)}: "${report.file}"`,
		);
	}
	return {
		ruleId: meta.id,
		severity,
		message: report.message,
		file: normalized,
		...locFields(report.loc),
		fixable: report.fixable ?? meta.fixable,
		docsUrl: meta.docsUrl,
	};
}

/**
 * The one thing a rule can throw that is NOT a rule bug: `ctx.git` found no git checkout at the
 * path being linted.
 *
 * This function enforces a decision: a git checkout is a HARD requirement of the `recommended`
 * tier, and a run that has not got one reports the requirement rather than degrading quietly.
 *
 * `links/resolve` — `recommended` and `strict`, so it runs on the zero-config
 * flagship path — resolves link targets against `git ls-files`. Run `npx skillslurp .` on an
 * unzipped folder and its first `ctx.git` call throws `NotAGitCheckoutError`, which the two
 * crash wrappers below would otherwise dress up as `rule "links/resolve" crashed while checking
 * "<some document>"` — blaming a rule, naming an arbitrary document, and burying the one fact
 * that is actionable. So it is recognised by TYPE (never by message text — see `isGitCheckout`
 * in git.ts) and rethrown as one sentence naming the path and the requirement.
 *
 * Deliberately a fresh `Error` with no `cause`: `formatError` (run.ts) renders the whole cause
 * chain, and git's own `fatal: not a git repository ...` stderr underneath this sentence would
 * say the same thing a second time in git's words. It reaches the user through `runCli`'s outer
 * catch — stderr, exit 2 — and it happens once per run by construction, because throwing out of
 * `runEngine` ends the run.
 *
 * Deliberately NOT a fallback to `stat` outside git: that would be a silent semantic downgrade
 * (case-insensitive on macOS, untracked files accepted) that nobody running the tool could see.
 */
function gitCheckoutRequiredError(cause: unknown): Error | undefined {
	if (!(cause instanceof NotAGitCheckoutError)) {
		return undefined;
	}
	return new Error(
		`"${cause.root}" is not a git checkout — skillslurp resolves link targets against git's index, so the path it lints must be inside a git repository`,
	);
}

/**
 * The substring git's own stderr carries when a `<base>...HEAD` range has no merge base at all,
 * i.e. the two endpoints share no common ancestor.
 *
 * MEASURED, not quoted from a manual: `git-diff(1)` documents only that `A...B` "is equivalent
 * to `git diff $(git merge-base A B) B`" (<https://git-scm.com/docs/git-diff>, fetched
 * 2026-09-06) and says nothing about what happens when that merge base does not exist. Run
 * against git 2.54.0 on 2026-09-06, in a `git clone --depth 1 --no-single-branch --branch
 * feature file://<repo>` clone whose two grafted shallow commits have no common ancestor, the
 * exact stderr was:
 *
 *     fatal: origin/main...HEAD: no merge base
 *
 * exit 128 — reproduced identically on a NON-shallow repository with two orphan branches, which
 * is why the match is on the trailing `": no merge base"` rather than on anything shallow-
 * specific: the range text in the middle is the caller's own `<base>...HEAD` and the leading
 * `fatal: ` is git's generic prefix. `engine.test.ts` pins the measured line itself, so this
 * constant cannot drift away from the text it was derived from without a test failing.
 *
 * Matching on English text is safe here in a way `isGitCheckout` (git.ts) warns it generally is
 * not: `buildGitEnv` pins `LC_ALL=C`/`LANGUAGE=` on every invocation this codebase makes, so git's
 * stderr is untranslated regardless of the operator's locale. There is no exit code or error
 * class to use instead — git reports this as an ordinary 128, the same code a bad revision, a
 * missing object and a dozen other fatals use.
 */
const NO_MERGE_BASE_STDERR = ": no merge base";

/**
 * `gitCheckoutRequiredError`'s sibling for the one `--diff-base` failure that has an actionable
 * answer the user cannot guess: the base ref resolves, but its history and `HEAD`'s do not meet.
 *
 * In CI that is almost always one specific mistake, so the message names it: `actions/checkout`
 * "Only a single commit is fetched by default" and tells you to "Set `fetch-depth: 0`"
 * (<https://github.com/actions/checkout>, fetched 2026-09-06) — with a depth-1 checkout of the
 * PR head and a shallowly fetched base branch, the two grafted commits genuinely have no common
 * ancestor and every `--diff-base` run fails this way until the fetch depth changes.
 *
 * Deliberately a fresh `Error` with no `cause`, exactly like `gitCheckoutRequiredError`: git's
 * own `fatal: <range>: no merge base` underneath this sentence would restate it in git's words
 * and add nothing.
 */
function noMergeBaseError(base: string, cause: unknown): Error | undefined {
	if (
		!(cause instanceof Error) ||
		typeof cause.cause !== "string" ||
		!cause.cause.includes(NO_MERGE_BASE_STDERR)
	) {
		return undefined;
	}
	return new Error(
		`no merge base between "${base}" and HEAD — in GitHub Actions, actions/checkout fetches one commit by default; set fetch-depth: 0`,
	);
}

/**
 * Maps a failure of the `--diff-base` diff onto the clearest error available, in the same
 * "recognise it, or hand back what you were given" shape as `ruleCrashError` above.
 *
 * The pass-through case is the important one: an unknown ref keeps `runGit`'s own error exactly
 * as built — `git diff --name-status --relative -z <ref>...HEAD -- in "<root>" exited with code
 * 128`, with git's `fatal: bad revision '<ref>...HEAD'` as its cause. That already names the ref
 * twice and says what git thought was wrong, so wrapping it again would add a layer that says
 * strictly less.
 *
 * A `root` that is not a checkout needs no probe of its own here: `diff` reports it as exit 129
 * with usage text rather than `ls-files`'s 128-plus-`fatal:`, and `toGitError` (git.ts) classifies
 * both as `NotAGitCheckoutError`, which `gitCheckoutRequiredError` then recognises.
 */
function diffBaseError(base: string, cause: unknown): Error {
	const mapped =
		gitCheckoutRequiredError(cause) ?? noMergeBaseError(base, cause);
	if (mapped !== undefined) {
		return mapped;
	}
	return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * The set of document paths `--diff-base <ref>` narrows the per-document loop to: every path
 * `git diff <ref>...HEAD` reports, minus the deleted ones.
 *
 * Three-dot, not two-dot, because `ctx.git.diff` is three-dot (`computeDiff`, context.ts) and
 * that is the semantics this flag wants: `A...B` "is equivalent to `git diff $(git merge-base A
 * B) B`" (<https://git-scm.com/docs/git-diff>, fetched 2026-09-06), so a base branch that has
 * moved on since the current branch forked contributes nothing. Two-dot would report every file
 * the base changed in the meantime as "changed by this branch" and lint it — which is not merely
 * more work, it is the wrong answer on any repository where main moves.
 *
 * `deleted` is filtered out, and doing so changes nothing observable: a path deleted between the
 * base and `HEAD` is not in the working tree, so discovery never produced a `Document` for it and
 * this set is only ever asked about paths that exist. Verified by mutation — admitting
 * `deleted` paths fails no test. It is filtered anyway because the set's meaning is "documents
 * this run may lint" and a deleted path is not one; lint-staged's own default filter,
 * `--diff-filter=ACMR` (<https://github.com/lint-staged/lint-staged>, fetched 2026-09-06),
 * excludes `D` for the same reason. A rename arrives as a single entry at the NEW path
 * (`ChangedFile.path`), so a renamed document is linted where it now lives.
 */
async function changedDocumentPaths(
	caps: Capabilities,
	base: string,
): Promise<ReadonlySet<string>> {
	let changed: readonly ChangedFile[];
	try {
		changed = await caps.git.diff(base);
	} catch (err) {
		throw diffBaseError(base, err);
	}
	// git precomposes paths to NFC on macOS (`core.precomposeunicode`, git's default there),
	// while discovery yields raw `readdir` bytes — NFD when the directory was created that way.
	// A membership test must compare in one form, so this set, and both lookups against it
	// below, go through `pathKey`.
	const paths = new Set<string>();
	for (const file of changed) {
		if (file.status !== "deleted") {
			paths.add(pathKey(file.path));
		}
	}
	return paths;
}

/**
 * Renders `ResolvedConfig.configFile` as the repo-relative, posix `Diagnostic.file` a
 * `ConfigReport` defaults to — the same rendering `configErrorDiagnostics` (run.ts) gives
 * `ConfigError.file`, through the same shared `displayPath`, so every `config/*` diagnostic this
 * CLI produces names the config file the same way whether it came from `loadConfig` or from a
 * rule.
 *
 * Fixed at the source, pre-merge: `loadConfig` (config.ts) now builds `configFile` from the same
 * canonical `rootReal` as `root` at both its return sites, and `runCli` (run.ts) prefers
 * `config.root` over its own lexical `root` for `configErrorDiagnostics` once `loadConfig` has
 * actually returned one — the two had to move together, since canonicalizing `configFile` alone
 * would have moved the escape into every `ConfigError` raised after `loadConfig` returns
 * (`discoverFiles`'s overlap/`config/no-files` checks) instead of removing it. Before that fix,
 * `config.root`/`config.configFile` disagreed on every path reached through a symlink (the macOS
 * default `/tmp` -> `/private/tmp` is enough), and `relative()` between them climbed out of the
 * repository — measured on darwin, the naive rendering produced
 * `"../../../../../../../var/folders/.../skillslurp-run-config-report-hTdFBC/skillslurp.json"`.
 *
 * The `isUnusableReportFile` fallback below is now unreachable by construction — `config.root` and
 * `config.configFile` always share one canonical base — and is kept as a defensive backstop, not
 * because a live path to it is known: `posix.basename` is a correct fallback rather than a guess,
 * since `loadConfig` builds `configFile` as `join(<the root>, "skillslurp.json")` at both
 * return sites, so the config file is by construction directly at the repo root and its basename
 * IS its repo-relative path.
 */
function configFileForReports(config: ResolvedConfig): string {
	const rendered = displayPath(config.root, config.configFile);
	return isUnusableReportFile(rendered)
		? posix.basename(normalizeReportFile(config.configFile))
		: rendered;
}

/**
 * `toDiagnostic`/`toProjectDiagnostic`'s third sibling: flattens a `ConfigReport` — a rule
 * saying "your CONFIGURATION is wrong" (see `ConfigReport` in rule.ts for what the
 * mechanism is for) — into a `Diagnostic` the engine, not the rule, owns three fields of.
 *
 * - `ruleId` is `config/<problem>`, never `meta.id`. The reporting rule's identity survives only
 *   in `message`, if the rule chose to put it there.
 * - `severity` is `error`, regardless of what the rule is configured at — which is why
 *   `severity` is not a parameter of this function at all, unlike both siblings. A stale
 *   allowlist entry is "itself an error" unconditionally, and at a rule someone had set to
 *   `warn` it would not be.
 * - `docsUrl` is `DOCS_URL`, not `meta.docsUrl`: this diagnostic is emitted under an
 *   engine-owned id, so pointing at the reporting rule's docs page would point at the wrong
 *   page — the same choice `configErrorDiagnostics` (run.ts) already makes for every other
 *   `config/*` diagnostic.
 *
 * Exit stays 1, not 2: nothing here throws or aborts, the diagnostic joins the run's normal list
 * and `computeExitCode` (exit.ts) reads its `error` severity like any other. That is the
 * deliberate difference from a `ConfigError`, which is discovered BEFORE the engine runs and
 * takes the whole run down with it — this is discovered WHILE linting, so the rest of the run's
 * diagnostics still print.
 *
 * `file` and `loc` are the rule's to override and the engine's to default (`configFile` /
 * `surfaceLoc`, see `runEngine`). `report.file`, when the rule does set one, goes through
 * exactly the same `normalizeReportFile`/`isUnusableReportFile` pair as a `RuleReport`'s — an
 * absolute, `..`-escaping or blank path is a rule bug in either shape.
 */
function toConfigDiagnostic(
	meta: RuleMeta,
	report: ConfigReport,
	configFile: string,
	surfaceLoc: Loc | undefined,
): Diagnostic {
	// `typeof` first: `isConfigReport` discriminates on the KEY, on purpose (see its own doc),
	// so `{ message, problem: undefined }` reaches this function and must be named as the rule
	// bug it is rather than crashing later on `undefined.startsWith` or minting
	// `config/undefined`.
	if (
		typeof report.problem !== "string" ||
		!CONFIG_PROBLEM_PATTERN.test(report.problem)
	) {
		throw new Error(
			`rule "${meta.id}" reported an invalid config problem name: ${JSON.stringify(report.problem)} — expected a lowercase-hyphenated name (${CONFIG_PROBLEM_PATTERN.source}), which the engine mints as "${CONFIG_REPORT_NAMESPACE}<problem>"`,
		);
	}
	let file = configFile;
	if (report.file !== undefined) {
		const normalized = normalizeReportFile(report.file);
		if (isUnusableReportFile(normalized)) {
			throw new Error(
				`rule "${meta.id}" ${unusableReportFileReason(normalized)}: "${report.file}"`,
			);
		}
		file = normalized;
	}
	return {
		ruleId: `${CONFIG_REPORT_NAMESPACE}${report.problem}`,
		severity: "error",
		message: report.message,
		file,
		...locFields(report.loc ?? surfaceLoc),
		fixable: false,
		docsUrl: DOCS_URL,
	};
}

/** One shared message shape for a rule bug caught while checking a document (see `runEngine`). */
function ruleCrashError(
	ruleId: string,
	docPath: string,
	cause: unknown,
): Error {
	return (
		gitCheckoutRequiredError(cause) ??
		new Error(`rule "${ruleId}" crashed while checking "${docPath}"`, {
			cause,
		})
	);
}

/**
 * `ruleCrashError`'s counterpart for every kind with no document to name — `project` and `scan`
 * per surface, `shape` per run: the message identifies what the rule was checking instead.
 * `surfaceDescriptor` is `describeSurface`'s own wording, the same string
 * `resolveEnabledBySurface`'s config-problem messages already use, or `REPO_RULE_DESCRIPTOR` for
 * the once-per-run kind.
 */
function ruleCrashErrorForSurface(
	ruleId: string,
	surfaceDescriptor: string,
	cause: unknown,
): Error {
	return (
		gitCheckoutRequiredError(cause) ??
		new Error(`rule "${ruleId}" crashed while checking ${surfaceDescriptor}`, {
			cause,
		})
	);
}

/**
 * Stable ordering: file, then line/col (missing → 0), then ruleId, then message.
 *
 * Exported because `run.ts` merges the baseline's `baseline/stale` diagnostics into the
 * engine's own output and has to re-sort the result with the SAME comparator — a second
 * comparator "just for the merge" is how one output ends up with two orderings.
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
	if (a.file !== b.file) {
		return a.file < b.file ? -1 : 1;
	}
	const lineDiff = (a.line ?? 0) - (b.line ?? 0);
	if (lineDiff !== 0) {
		return lineDiff;
	}
	const colDiff = (a.col ?? 0) - (b.col ?? 0);
	if (colDiff !== 0) {
		return colDiff;
	}
	if (a.ruleId !== b.ruleId) {
		return a.ruleId < b.ruleId ? -1 : 1;
	}
	if (a.message !== b.message) {
		return a.message < b.message ? -1 : 1;
	}
	return 0;
}

/**
 * Drops an exact duplicate `Diagnostic` — one agreeing with an earlier one on EVERY field,
 * `severity` and `docsUrl` included, not merely `(file, line, col)` — keeping the first
 * occurrence. Two diagnostics that agree on every field are the same statement restated twice,
 * so this is lossless; two that differ in even one field (a different `severity` because one
 * surface overrides it, a different `message`, …) are kept, since they are not provably the
 * same violation.
 *
 * The false premise this corrects: a `project`/`scan` rule is dispatched once per surface it is
 * enabled on, and was assumed to never report anything surface-independent enough to
 * collide — but `index/no-missing-targets` reports `file: result.indexPath` and `loc: target.loc`,
 * neither derived from the surface, so two surfaces sharing one index file produce
 * byte-identical diagnostics, one per surface. Left undeduped, the count is inflated for one
 * defect — a landmine for the baseline model ("fingerprint (ruleId, file, normalized message)
 * with per-file counts": `--update-baseline` would bless a count of 2 for something that
 * happened once).
 *
 * `JSON.stringify` is a safe dedupe key here specifically because every `Diagnostic` reaching
 * this function was built by this same module's `toDiagnostic`/`toProjectDiagnostic`/
 * `frontmatterDiagnostics`, which all spread `locFields` into the identical field order — two
 * objects with the same own keys in the same order and the same values serialize identically,
 * so this cannot fail to collapse two diagnostics that really do agree on every field the way a
 * naive `Object.keys` order mismatch could.
 *
 * Runs BEFORE `compareDiagnostics` sorts, not after: two exact duplicates compare equal under
 * that comparator regardless of order, so which pass runs first cannot change the final
 * (deterministic) result — but deduping first means the sort never has to look at the doomed
 * copy at all.
 */
function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const deduped: Diagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = JSON.stringify(diagnostic);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(diagnostic);
	}
	return deduped;
}

/**
 * Run-scoped options for one `runEngine` call — deliberately NOT part of `ResolvedConfig`, which
 * is what the yaml said. Nothing here is settable from a config file; everything here comes from
 * the command line and applies to this invocation only.
 */
export interface EngineOptions {
	/**
	 * `--diff-base <ref>`: limits the per-document loop to the documents git reports as
	 * changed in `<ref>...HEAD` — that is, since the merge base of `<ref>` and `HEAD`. Absent
	 * means "lint every discovered document", the behaviour of every run before this option
	 * existed.
	 *
	 * **Committed changes only.** Biome's `--changed` is the posture adopted here, in its own
	 * words: "Checks only files with committed changes ... Staged and unstaged changes are not
	 * included. This option is intended for CI."
	 * (<https://biomejs.dev/reference/cli/>, fetched 2026-09-06.) A file edited in the working
	 * tree, or staged but not committed, is therefore NOT linted under this option — it is not
	 * in `git diff <ref>...HEAD` at all.
	 *
	 * **Only `file` rules are narrowed; `project`, `scan` and `shape` rules run in full.** They
	 * report on index documents, on arbitrary tracked files, on the whole grep corpus and on the
	 * repository's shape, none of which is "the document under check", so narrowing them would
	 * quietly change what they mean rather than merely do less work. A dangling path in an
	 * unchanged README is still reported; the baseline, not this option, is the tool for
	 * pre-existing findings.
	 *
	 * **The baseline's staleness guard is off** while this is set (`run.ts` passes
	 * `checkStale: false`): most of the repository was not linted, so nearly every baseline entry
	 * would look like one the repository has outgrown.
	 *
	 * **It saves rule invocations, not parsing.** Every discovered document is read and
	 * parsed before this filter runs, because `ctx.documents()` must stay complete for the
	 * `project` rules that read it — `index/complete` and `refs/no-unreachable-files` would
	 * otherwise report every unchanged entry as missing or orphaned. Skipping a document skips
	 * its `parse/frontmatter` diagnostics too: those are a per-document finding on a document
	 * this run was told not to look at.
	 *
	 * **Paths are compared Unicode NFC-normalized**, so a document whose directory name is
	 * stored decomposed (NFD) on disk still matches git's precomposed report of it — see
	 * `changedDocumentPaths`.
	 */
	readonly diffBase?: string;
}

/**
 * `runEngine`'s return value: the diagnostics every run produces, plus `changedDocuments`,
 * present as an own key only on a `--diff-base` run — the number of discovered documents that
 * survived the `diffBase` filter. Frozen, including `diagnostics`.
 */
export interface EngineResult {
	readonly diagnostics: readonly Diagnostic[];
	readonly changedDocuments?: number;
}

/**
 * Runs every enabled rule from `registry` over every file `config` discovers, and returns a
 * frozen `EngineResult` carrying a deterministically deduped, sorted, frozen list of
 * diagnostics.
 *
 * 1. Validates the registry: every rule id is a non-empty string, unique, and outside the
 *    reserved namespaces (`validateRegistry`, which lives in config.ts and is
 *    re-exported here). It does NOT cross-check the tiers against a preset id list — that assert
 *    was deleted when tiers became derived from each rule's own `meta.tiers`.
 * 2. Discovers files and builds a lazy capability bag over them.
 * 3. Builds one enabled-rule map per surface (see `resolveEnabledBySurface`) for `"file"`/
 *    `"project"`/`"scan"` rules: base (tier → global, already collapsed by `loadConfig`) plus
 *    each surface's own delta, each resulting `RuleContext` frozen and reused across every
 *    document on that surface, never rebuilt. `"shape"` rules take no part in this —
 *    `resolveRepoRules` resolves them once for the whole run instead (point 9 below).
 * 3b. When `options.diffBase` is set, the set of documents the per-document loop will look at is
 *    narrowed to the ones git reports as changed since that ref (`changedDocumentPaths`). Only
 *    that loop is narrowed — the `project`/`scan` loop below runs over every surface regardless,
 *    and `ctx.documents()` stays complete for the rules that read it. See `EngineOptions.diffBase`.
 * 4. For each document, in discovery order (and, under `diffBase`, only the changed ones): a
 *    document whose frontmatter has yaml parse errors (including duplicate keys, which `yaml`
 *    reports as parse errors) short-
 *    circuits to one `parse/frontmatter` diagnostic per error and skips all
 *    file rules for that document; rules never see broken frontmatter. A document with no
 *    frontmatter at all, or an empty-but-valid frontmatter block, has no parse errors and so
 *    reaches its file rules normally.
 * 5. Otherwise, the document's surface looks up its enabled-rule map (a miss is an internal
 *    invariant break — every document's surface came from `config.surfaces` via discovery, so
 *    it must be a key of a map built by iterating that same array — and throws rather than
 *    silently skipping every rule for that document), and every enabled rule is dispatched
 *    through an exhaustive switch on `rule.kind`: only `"file"` rules run here — `"project"`/
 *    `"scan"` are dispatched by the second loop below instead, never here, and `"shape"` is
 *    dispatched by the third loop (point 9), never here either.
 * 6. A second loop, run after every document has been checked, iterates `config.surfaces`
 *    (config order) and, within each surface, `registry` (registry order) — deterministic on
 *    both axes, same as the per-document loop above. For each surface's enabled `"project"`/
 *    `"scan"` rules, `rule.check(ctx)` is called exactly once per surface the rule is enabled
 *    on — a rule enabled on two surfaces runs twice, once per surface (a recorded,
 *    accepted quirk, not special-cased away). `ctx.surface` is that surface, so a rule can
 *    scope `ctx.documents()` down to its own surface's documents via `doc.surface ===
 *    ctx.surface`. Unlike a file rule, `RuleReport.file` is required here, not merely preferred
 *    (see `toProjectDiagnostic`) — there is no document for the engine to default to, so a
 *    report that omits it is a rule bug, routed through the same crash path as a throwing
 *    `check` (point 7) rather than silently forwarded as `Diagnostic.file: undefined`. A
 *    document's yaml frontmatter errors (point 4) are a per-document, file-rule-only skip and
 *    have no bearing on this loop: a surface with such a document still gets its project/scan
 *    rules run.
 * 7. A rule whose `check` throws (synchronously or via a rejected promise), in any of the three
 *    loops, is not swallowed as a diagnostic: it is caught and rethrown as one plain `Error`
 *    naming the rule id, and — a file rule's document path, or a project/scan rule's surface
 *    (`describeSurface`) or, for a shape rule, the fixed descriptor "the repository"
 *    (point 9) — chaining the original as `cause`. A rule that returns a non-array
 *    at runtime (a plain JS consumer can hand back anything despite the TS signature) is a
 *    distinct, single-message error — deliberately NOT routed through the same catch, so it
 *    is not double-wrapped ("crashed while checking ...: rule ... returned non-array while
 *    checking ...: ..."). A `toDiagnostic`/`toProjectDiagnostic` call that rejects a
 *    rule-reported `file` escaping the repo, or (project/scan/shape only) missing
 *    entirely, IS routed through the crash-path catch, same as a throwing `check` — every one
 *    of these is a rule bug the engine did not cause.
 * 7b. A report a rule returns is either an ordinary `RuleReport` or a `ConfigReport` — "your
 *    CONFIGURATION is wrong" rather than "your repository is wrong". The two are
 *    discriminated by `isConfigReport` (rule.ts) in all three loops, and a `ConfigReport` goes
 *    through `toConfigDiagnostic` in every case: it becomes `config/<problem>` at severity
 *    `error` regardless of what the reporting rule is configured at, against this run's config
 *    file (`configFileForReports`) at the reporting surface's own yaml position
 *    (`ResolvedSurface.loc`) for a file/project/scan rule, or at no position at all for a
 *    shape rule (point 9) — there is no surface to point at — unless the rule named a
 *    `file`/`loc` of its own. Exit stays 1, not 2: this is found WHILE linting, so the rest of
 *    the run's diagnostics still print — the deliberate difference from a `ConfigError`, which
 *    aborts before any rule runs. A malformed `problem` is a rule bug and goes through point
 *    7's crash path.
 * 8. Before sorting, an exact duplicate — one agreeing with an earlier diagnostic on EVERY
 *    field — is dropped (`dedupeDiagnostics`): a `project`/`scan` rule enabled on two
 *    surfaces (point 6) can report something surface-independent (`index/no-missing-targets`'s `file`/
 *    `loc` come from the configured index file and the link's own position, neither derived
 *    from the surface), which would otherwise inflate one violation into two byte-identical
 *    diagnostics.
 * 9. A third loop, run after every surface's `"project"`/`"scan"` rules (point 6), iterates
 *    `registry` once more (registry order — there is no surface axis for this kind).
 *    `"shape"` rules are dispatched unconditionally, exactly once, with a `RepoRuleContext`
 *    (`ctx.surfaces`, not `ctx.surface` — see that type's own doc) built once by
 *    `resolveRepoRules` from the global layer ONLY: no surface may enable, disable or
 *    configure one of these ids, so there is nothing here for `--diff-base` to narrow —
 *    `ctx.documents()` stays the complete list even on a `--diff-base` run. A `RuleReport` from
 *    one reuses `toProjectDiagnostic` — `RuleReport.file` is required, exactly as for
 *    `"project"`/`"scan"` — with the fixed descriptor `"the repository"` standing in for
 *    `describeSurface`'s output, since there is no single surface this kind could be about.
 */
export async function runEngine(
	config: ResolvedConfig,
	registry: readonly Rule[],
	options?: EngineOptions,
): Promise<EngineResult> {
	validateRegistry(registry);

	const discovered = await discoverFiles(config);
	// The facts the `ctx.grep` corpus is scoped by — see
	// `CorpusScope` (context.ts) for why each one is an exclusion rather than an oversight.
	const corpusScope: CorpusScope = {
		configFile: config.configFile,
		baselineFile: baselineFilePath(config.root),
		ignore: config.ignore,
	};
	const caps = createCapabilities(
		config.root,
		() =>
			Promise.all(
				discovered.map(async (file) => {
					try {
						return await readDocument(config.root, file);
					} catch (err) {
						throw new Error(`failed to read "${file.path}"`, { cause: err });
					}
				}),
			),
		corpusScope,
	);

	// Where a `ConfigReport` points when the reporting rule names no file of its own.
	const configFile = configFileForReports(config);

	const configProblems: ConfigProblem[] = [];
	const enabledBySurface = resolveEnabledBySurface(
		config,
		registry,
		caps,
		configProblems,
	);
	// Resolved alongside `enabledBySurface`, from the same `caps`, before either
	// touches a document — `resolveRepoRules` needs no discovered document at all, only the
	// config.
	const repoRules = resolveRepoRules(config, registry, caps, configProblems);
	if (configProblems.length > 0) {
		throw new ConfigError(config.configFile, configProblems);
	}

	// Computed HERE, after discovery and after the enabled-rule maps are built, never
	// before either: `config/no-files` (discover.ts) is a verdict about the repository, so a
	// surface whose only document happens to be unchanged is still a surface with a document in
	// it, not a config mistake — and a run that is going to fail on a bad `rules:` block should
	// fail on that rather than on a git subprocess it did not need to spawn.
	const changed =
		options?.diffBase === undefined
			? undefined
			: await changedDocumentPaths(caps, options.diffBase);

	const documents = await caps.documents();

	// Own key on `EngineResult` only when `diffBase` narrowed the run — see `EngineResult`.
	const changedDocuments =
		changed === undefined
			? undefined
			: documents.filter((doc) => changed.has(pathKey(doc.path))).length;

	const diagnostics: Diagnostic[] = [];

	for (const doc of documents) {
		// The FIRST statement of the loop body, ahead of the frontmatter short-circuit
		// below. `parse/frontmatter` is a per-document finding like any other, and a document
		// this run was told not to look at should not produce one. See `EngineOptions.diffBase`.
		if (changed !== undefined && !changed.has(pathKey(doc.path))) {
			continue;
		}

		if (doc.frontmatter && doc.frontmatter.errors.length > 0) {
			diagnostics.push(...frontmatterDiagnostics(doc));
			continue;
		}

		const enabled = enabledBySurface.get(doc.surface);
		if (!enabled) {
			// Not a user-facing mistake: every document's surface came from discovery, which
			// only ever hands out references from `config.surfaces`, the same array
			// `resolveEnabledBySurface` iterated to build its keys. A miss here means those two
			// have drifted apart — silently skipping the document would lint it with zero rules
			// and no diagnostic to say why.
			throw new Error(
				`internal error: no enabled-rule map found for the surface of document "${doc.path}"`,
			);
		}

		for (const rule of registry) {
			const cached = enabled.get(rule.meta.id);
			if (!cached) {
				continue;
			}

			switch (rule.kind) {
				case "file": {
					let result: Report[];
					try {
						result = await rule.check(doc, cached.ctx);
					} catch (err) {
						throw ruleCrashError(rule.meta.id, doc.path, err);
					}

					// Deliberately outside the try above: a plain JS consumer can hand `check`
					// back anything despite the TS signature, and this is a distinct failure
					// mode from a throwing `check` — routing it through the same catch would
					// double-wrap it ("crashed while checking ...: rule ... returned
					// non-array while checking ...: ...").
					if (!Array.isArray(result)) {
						throw new Error(
							`rule "${rule.meta.id}" returned non-array while checking "${doc.path}": ${String(result)}`,
						);
					}

					try {
						for (const report of result) {
							diagnostics.push(
								// A `ConfigReport` means the same thing from every kind of rule, so
								// it converts the same way from both dispatch loops — never through
								// `toDiagnostic`, whose `docPath` fallback would silently file a
								// config problem against whichever document happened to be under
								// check. No `file` rule reports one today; routing it here anyway is
								// what keeps that from becoming a landmine for the first one that
								// does (`docs/contract-sync` is a `project` rule, but nothing
								// about the mechanism is kind-specific).
								isConfigReport(report)
									? toConfigDiagnostic(
											rule.meta,
											report,
											configFile,
											doc.surface.loc,
										)
									: toDiagnostic(rule.meta, cached.severity, report, doc.path),
							);
						}
					} catch (err) {
						throw ruleCrashError(rule.meta.id, doc.path, err);
					}
					break;
				}
				case "project":
				case "scan":
					// Dispatched by the second loop below, once per surface — never here: a project/scan
					// rule has nothing to do with a single document.
					break;
				case "shape":
					// Dispatched by the third loop below, once per RUN rather than once per
					// document or per surface — never here.
					break;
				default: {
					const exhaustive: never = rule;
					throw new Error(`unhandled rule kind: ${String(exhaustive)}`);
				}
			}
		}
	}

	// Second dispatch loop: `"project"`/`"scan"` rules run once per surface they are enabled
	// on, not once per document — the per-document loop above never dispatches them.
	// `config.surfaces` (config order) is the outer axis and `registry` (registry order) the
	// inner one, matching the per-document loop's own determinism, so the diagnostics this loop
	// produces still sort into the same stable, single list as everything else once
	// `compareDiagnostics` runs below. A document's frontmatter parse errors (the skip
	// above) are a per-document, file-rule-only concern and have no bearing here: a surface
	// with such a document still gets its project/scan rules run.
	for (const [index, surface] of config.surfaces.entries()) {
		const enabled = enabledBySurface.get(surface);
		if (!enabled) {
			// Same invariant as the per-document lookup above, restated for a surface instead
			// of a document: every key `enabledBySurface` came from iterating this very
			// `config.surfaces` array, so a miss means the two have drifted apart.
			throw new Error(
				`internal error: no enabled-rule map found for ${describeSurface(surface, index)}`,
			);
		}

		for (const rule of registry) {
			const cached = enabled.get(rule.meta.id);
			if (!cached) {
				continue;
			}

			switch (rule.kind) {
				case "project":
				case "scan": {
					const surfaceDescriptor = describeSurface(surface, index);
					let result: Report[];
					try {
						result = await rule.check(cached.ctx);
					} catch (err) {
						throw ruleCrashErrorForSurface(
							rule.meta.id,
							surfaceDescriptor,
							err,
						);
					}

					// Deliberately outside the try above — see the identical comment on the
					// `"file"` case above; same failure mode, same reason not to double-wrap it.
					if (!Array.isArray(result)) {
						throw new Error(
							`rule "${rule.meta.id}" returned non-array while checking ${surfaceDescriptor}: ${String(result)}`,
						);
					}

					try {
						for (const report of result) {
							diagnostics.push(
								// See the identical branch in the per-document loop above.
								isConfigReport(report)
									? toConfigDiagnostic(
											rule.meta,
											report,
											configFile,
											surface.loc,
										)
									: toProjectDiagnostic(
											rule.meta,
											cached.severity,
											report,
											surfaceDescriptor,
										),
							);
						}
					} catch (err) {
						throw ruleCrashErrorForSurface(
							rule.meta.id,
							surfaceDescriptor,
							err,
						);
					}
					break;
				}
				case "file":
					// Already dispatched in the per-document loop above.
					break;
				case "shape":
					// Dispatched by the third loop below, once per RUN — never here.
					break;
				default: {
					const exhaustive: never = rule;
					throw new Error(`unhandled rule kind: ${String(exhaustive)}`);
				}
			}
		}
	}

	// Third dispatch loop: `"shape"` rules run exactly once per RUN, never once per
	// document and never once per surface — the two loops above dispatch every other kind and
	// leave this one as a no-op. `registry` order only: there is no surface axis here to make a
	// second, outer one out of. `REPO_RULE_DESCRIPTOR` stands in for `describeSurface`'s output
	// in every message the crash/report helpers below produce, since none of these diagnostics
	// is about a single surface.
	for (const rule of registry) {
		switch (rule.kind) {
			case "shape": {
				const cached = repoRules.shape.get(rule.meta.id);
				if (!cached) {
					break;
				}
				let result: Report[];
				try {
					result = await rule.check(cached.ctx);
				} catch (err) {
					throw ruleCrashErrorForSurface(
						rule.meta.id,
						REPO_RULE_DESCRIPTOR,
						err,
					);
				}
				if (!Array.isArray(result)) {
					throw new Error(
						`rule "${rule.meta.id}" returned non-array while checking ${REPO_RULE_DESCRIPTOR}: ${String(result)}`,
					);
				}
				try {
					for (const report of result) {
						diagnostics.push(
							isConfigReport(report)
								? toConfigDiagnostic(rule.meta, report, configFile, undefined)
								: toProjectDiagnostic(
										rule.meta,
										cached.severity,
										report,
										REPO_RULE_DESCRIPTOR,
									),
						);
					}
				} catch (err) {
					throw ruleCrashErrorForSurface(
						rule.meta.id,
						REPO_RULE_DESCRIPTOR,
						err,
					);
				}
				break;
			}
			case "file":
			case "project":
			case "scan":
				// Already dispatched by the loops above.
				break;
			default: {
				const exhaustive: never = rule;
				throw new Error(`unhandled rule kind: ${String(exhaustive)}`);
			}
		}
	}

	// `Diagnostic.file` is a mix until here: NFC for a scan-rule diagnostic (`GrepHit.file`,
	// untouched git output) and possibly NFD for a file/project-rule one (`Document.path`, raw
	// `readdir` bytes). One normalization form lets the two agree — for dedupe just below,
	// and for every downstream consumer that treats `file` as one canonical string (reporters,
	// the baseline).
	for (const diagnostic of diagnostics) {
		diagnostic.file = pathKey(diagnostic.file);
	}

	const deduped = dedupeDiagnostics(diagnostics);
	deduped.sort(compareDiagnostics);

	const result: {
		diagnostics: readonly Diagnostic[];
		changedDocuments?: number;
	} = {
		diagnostics: Object.freeze(deduped),
	};
	if (changedDocuments !== undefined) {
		result.changedDocuments = changedDocuments;
	}
	return Object.freeze(result);
}
