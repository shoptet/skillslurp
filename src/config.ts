import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	isMap,
	isNode,
	LineCounter,
	parseDocument,
	type Document as YamlDocument,
} from "yaml";
import { z } from "zod";
// A plain, one-directional value import: `loadConfig` below calls `detectSurfaces` on the
// config-file ENOENT path. detect.ts must NOT import anything from this module at runtime —
// see detect.ts's module header for the cycle that existed here before and why it was a latent
// import-time crash, not a merely theoretical one.
import {
	CANDIDATE_ROOTS,
	type DetectedSurface,
	detectSurfaces,
	type SkippedCandidate,
} from "./detect.js";
import type { ConfiguredSeverity, Loc, Severity } from "./diagnostic.js";
import {
	BUILTIN_DIALECT_IDS,
	BUILTIN_DIALECTS,
	type DialectId,
	defaultInclude,
	dialectsSupportingKind,
	isDialectId,
	SURFACE_KINDS,
	type SurfaceKind,
} from "./dialects.js";
import { repoFileRefusal, stripTrailingSlashes, toPosixPath } from "./paths.js";
import type { Rule, Tier } from "./rule.js";
import { TIERS } from "./rule.js";
import { errorPos, locFromOffsets } from "./yaml-loc.js";

/**
 * The one place the config filename is spelled out; every module that needs it (run.ts,
 * testing/rule-tester.ts, discover.test.ts) imports this rather than repeating the literal.
 */
export const CONFIG_FILENAME = "skillslurp.json";

const SeveritySchema = z.enum(["error", "warn", "off"]);

const RuleSettingSchema = z.union([
	SeveritySchema,
	z.strictObject({
		severity: SeveritySchema.default("error"),
		options: z.unknown().optional(),
	}),
]);

/**
 * The same shape for a *surface's* rules block, with one difference that matters: `severity` is
 * optional instead of defaulting to `error`. A surface entry is a delta over the global
 * resolution, so "I only want different options here" has to be expressible — defaulting the
 * field would silently escalate a globally-`warn` rule to `error` on any surface that touches
 * only its options.
 */
const SurfaceRuleSettingSchema = z.union([
	SeveritySchema,
	z.strictObject({
		severity: SeveritySchema.optional(),
		options: z.unknown().optional(),
	}),
]);

const SurfaceSchema = z.strictObject({
	root: z.string().min(1),
	kind: z.enum(SURFACE_KINDS).default("skills"),
	/**
	 * Checked against the built-in ids in the id stage of `loadConfig` rather than with
	 * `z.enum`, because user-defined dialects will arrive from config post-v1 — the
	 * set is not closed the way `kind` is, and a schema-level enum would have to be unpicked
	 * again. Duplicates are deduped during resolution, not rejected: listing a dialect twice
	 * changes nothing, since every merge over `dialects` is set-shaped.
	 */
	dialects: z
		.array(z.string().min(1))
		.min(
			1,
			"list at least one dialect, or omit the key to use this kind's default",
		)
		.optional(),
	/**
	 * No schema default: the right one depends on `kind` and `dialects`, so it is filled in from
	 * `defaultInclude` during resolution. An explicit `include: []` is therefore NOT the same
	 * as omitting the key — it means "match nothing", which discovery turns into `config/no-files`.
	 */
	include: z.array(z.string()).optional(),
	/** Matched relative to this surface's root (the glob's cwd), not the repo root. */
	ignore: z.array(z.string()).default([]),
	/**
	 * Tool directories that should mirror this surface's root (the hub) through symlinks, as
	 * repo-root-relative paths. Declared here; only a zero-config run detects them, as the other
	 * candidate directories that resolve to the hub (detect.ts). What a spoke actually is on disk
	 * (one directory-level symlink, or a real directory of item-level ones) is for a rule to read,
	 * and discovery does not follow symlinks either way. Checked against the other surfaces in
	 * `validateSurfaces` (discover.ts), not here.
	 */
	spokes: z.array(z.string().min(1)).optional(),
	/**
	 * Per-surface overrides of the global rule settings. Same shape as the top-level `rules`
	 * block, but resolved into `SurfaceRuleOverride` rather than `ResolvedRule` — see that
	 * type for why `off` has to survive here.
	 */
	rules: z.record(z.string(), SurfaceRuleSettingSchema).default({}),
});

/**
 * The default `dialects` per kind. It cannot be a flat `["generic"]`: `generic` is the Agent
 * Skills spec and defines a `skills` contract only, so defaulting a `rules` or `instructions`
 * surface to it would leave that surface with no contract to check against at all. For `rules`
 * and `instructions` the dialect named here is currently the *sole* built-in speaking that kind,
 * so the choice is forced rather than a preference. `skills` is the exception: all six built-ins
 * define a `skills` contract, and `generic` is picked deliberately, as the vendor-neutral spec
 * baseline. `config.test.ts` pins both halves of that: every default speaks its own kind,
 * and `rules`/`instructions` still have exactly one speaker each — the day a second one
 * appears, that assertion fails and the default has to be chosen deliberately.
 */
const DEFAULT_DIALECTS: Readonly<Record<SurfaceKind, readonly DialectId[]>> =
	Object.freeze({
		skills: Object.freeze<DialectId[]>(["generic"]),
		rules: Object.freeze<DialectId[]>(["cursor"]),
		instructions: Object.freeze<DialectId[]>(["copilot"]),
	});

export const ConfigSchema = z.strictObject({
	version: z.literal(1).default(1),
	extends: z.array(z.enum(TIERS)).default(["recommended"]),
	/**
	 * Glob patterns to exclude from discovery, merged with the always-on defaults
	 * (`DEFAULT_IGNORE`, applied during resolution — see `loadConfig`) — listing your own
	 * patterns here never re-enables walking `node_modules` or `.git`.
	 *
	 * Matched relative to each surface root (the glob's cwd for that surface), not the repo
	 * root: `dist/**` excludes `<surface-root>/dist/**` for every surface, not a single
	 * `dist/` at the repo root. Use a `**\/`-prefixed pattern (`**\/dist/**`) for a
	 * location-agnostic exclude that matches regardless of nesting depth.
	 */
	ignore: z.array(z.string()).default([]),
	/** required in a written config; a missing file falls back to zero-config auto-detection */
	surfaces: z.array(SurfaceSchema).min(1),
	rules: z.record(z.string(), RuleSettingSchema).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

type RuleSetting =
	| ConfiguredSeverity
	| { severity: ConfiguredSeverity; options?: unknown };

/**
 * `RuleSetting`'s per-surface counterpart; see `SurfaceRuleSettingSchema` for why it differs.
 * `severity` is explicitly `| undefined` because this describes zod's *output*, which really
 * does hand back an own `severity: undefined` key for the object branch. The resolved form
 * (`SurfaceRuleOverride`) is the strict one — `resolveSurfaceRules` is where the difference is
 * collapsed, and under `exactOptionalPropertyTypes` the compiler now checks that it is.
 */
type SurfaceRuleSetting =
	| ConfiguredSeverity
	| { severity?: ConfiguredSeverity | undefined; options?: unknown };

/** Engine-owned rule-id namespaces (e.g. `parse/frontmatter`); no rule may register here. */
// Frozen: `Readonly<T>` is a type, not a lock (AGENTS.md) — this array is
// imported into engine.ts, discover.ts and run.ts, each of which asserts an owned pseudo-rule
// id against it at import time, so a caller that mutated it (accidentally or otherwise) would
// silently invalidate every one of those guards.
//
// `baseline/` joined `parse/` and `config/` on 2026-09-06:
// `baseline.ts` mints `baseline/stale` as a diagnostic id exactly like `parse/frontmatter`, and
// without this entry `validateRegistry` would accept a rule that registered `baseline/stale` for
// real, which would then emit two different kinds of diagnostic under one id.
export const RESERVED_NAMESPACES: readonly string[] = Object.freeze([
	"parse/",
	"config/",
	"baseline/",
]);

/**
 * A rule id's only allowed shape: a namespace and a name, each one or more lowercase letters,
 * digits or hyphens, joined by exactly one `/` — the shape every built-in id already uses
 * (`skill/frontmatter-schema`, `parse/frontmatter`, …). Enforced both here (`validateRegistry`,
 * against the in-house registry) and in `checkRuleIds` (against user-written config), so a
 * charset a config file could never name — including `__proto__`, which a JS object treats as
 * an accessor rather than an own key and which `z.record`'s output silently drops entirely
 * rather than rejects (measured against zod 4.4.3 on 2026-09-06, see `checkRuleIds`) — can never
 * reach either the registry or a resolved config unnoticed.
 */
const RULE_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * Validates a rule registry before it is trusted anywhere else: every `meta.id` must be a
 * unique non-empty string matching `RULE_ID_PATTERN`, and none may fall in an engine-owned
 * reserved namespace (`parse/`, `config/`, `baseline/` — see `RESERVED_NAMESPACES`), since those
 * ids are used for diagnostics the engine itself emits (e.g. `parse/frontmatter`). Throws a
 * plain `Error` — this is a programming mistake in the registry, not a user-facing config
 * problem — and returns the set of registered ids for callers that want it.
 *
 * Lives here rather than in engine.ts (where it started) because `loadConfig` derives the tiers
 * straight from `meta.tiers`: without this check a rule claiming a tier could put a reserved id
 * into `ResolvedConfig`, an id the same user is forbidden to write in `rules:`. Re-exported from
 * engine.ts for existing importers.
 */
export function validateRegistry(
	registry: readonly Rule[],
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const rule of registry) {
		const { id } = rule.meta;
		if (typeof id !== "string" || id.length === 0) {
			throw new Error(
				`rule id must be a non-empty string, got: ${JSON.stringify(id)}`,
			);
		}
		if (ids.has(id)) {
			throw new Error(`duplicate rule id in registry: "${id}"`);
		}
		if (RESERVED_NAMESPACES.some((ns) => id.startsWith(ns))) {
			throw new Error(
				`rule id "${id}" uses a reserved namespace (${RESERVED_NAMESPACES.join(", ")}) and cannot be registered`,
			);
		}
		if (!RULE_ID_PATTERN.test(id)) {
			throw new Error(
				`rule id "${id}" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")`,
			);
		}
		ids.add(id);
	}
	return ids;
}

/**
 * What each `extends` entry actually pulls in. `strict` is a superset of `recommended`, so a
 * rule author never has to remember to list both tiers and `extends: [strict]` can never be a
 * weaker lint than `extends: [recommended]`. For now the two tiers happen to hold the same set;
 * `strict` growing into a real superset later is exactly what this relation has to survive, and
 * keeping it as data means it is stated once and testable rather than maintained twice by hand.
 */
const TIER_IMPLIES: Readonly<Record<Tier, readonly Tier[]>> = Object.freeze({
	recommended: Object.freeze<Tier[]>(["recommended"]),
	strict: Object.freeze<Tier[]>(["recommended", "strict"]),
});

/**
 * Always-on discovery excludes; a user `ignore:` list is merged with these, never replaces
 * them (frozen — `Readonly<T>` is a type, not a lock). Also handed to `detectSurfaces` as its
 * `ignore` parameter on the zero-config path, so a synthesized surface is scanned with the same
 * always-on excludes discovery uses moments later — there is no `ignore:` block to merge in
 * before a config file exists.
 *
 * Exported (with `freezeSurface`/`sealMap`) for the RuleTester (src/testing/rule-tester.ts):
 * a hand-built `ResolvedConfig` that hardcoded `ignore: []` instead of reading this constant
 * would let a rule test's `files` map lint a `.git/` or `node_modules/` fixture file that a real
 * run, going through `loadConfig`, never reads.
 */
export const DEFAULT_IGNORE: readonly string[] = Object.freeze([
	"**/node_modules/**",
	"**/.git/**",
]);

/** `ResolvedConfig.skippedCandidates` for a written config — there is nothing to have skipped. */
const NO_SKIPPED_CANDIDATES: readonly SkippedCandidate[] = Object.freeze([]);

export interface ResolvedRule {
	severity: Severity;
	/**
	 * Opaque, rule-defined shape validated later by the engine against the rule's own
	 * options schema. Treated as possibly cyclic: a JSON config cannot express a cycle, but a
	 * `ResolvedConfig` built in code can hand one in, so nothing serializes or deep-walks this
	 * without a visited set.
	 */
	options?: unknown;
}

/**
 * A per-surface delta over the globally resolved rules, applied by the engine on top of the
 * tier → global base `loadConfig` has already collapsed into `config.rules`. There is no dialect
 * layer underneath it: a dialect carries neither a severity nor an options blob, and is read by
 * the rules themselves off `doc.surface.dialects` (see `resolveEnabledBySurface` in engine.ts).
 * Unlike `ResolvedRule` this keeps `severity: "off"`: for a
 * surface, an absent entry means "inherit" and `off` means "switch this rule off here only".
 * Collapsing the two — as the global map does, where absent simply means disabled — would
 * leave a surface unable to turn off a rule the global config enables.
 */
export interface SurfaceRuleOverride {
	/**
	 * Absent means "keep whatever the layers below resolved to, change only `options`".
	 * `off` switches the rule off for this surface alone. The opposite direction — a surface
	 * naming a severity for a rule the global config set to `off` — turns it back on here;
	 * The engine owns that merge and the JSDoc on `ResolvedSurface.rules` restates it.
	 */
	severity?: ConfiguredSeverity;
	/** same opacity and cyclic-value caveat as `ResolvedRule.options` */
	options?: unknown;
}

/**
 * One spoke of a surface. `loc` is where the entry sits in the config file, so a spoke that
 * `validateSurfaces` rejects is reported at the line the user wrote. A spoke with a `loc` is one a
 * config declared, and `hub/symlinks` acts only on those; one without (found by zero-config
 * detection, or a hand-built surface, like `ResolvedSurface.loc`) is still validated, and
 * `refs/no-dangling-paths` still follows it, but `hub/symlinks` never checks it.
 */
export interface ResolvedSpoke {
	readonly path: string;
	readonly loc?: Loc;
}

/**
 * `readonly` throughout, matching the deep freeze `freezeSurface` already applies: every rule on a
 * surface is handed the same instance for every document, so a rule that rewrote `dialects` or
 * `root` would change what the next document is judged against. The freeze made that throw; the
 * type used to accept `surface.root = "x"` and `doc.surface.root = "y"` without a word.
 */
export interface ResolvedSurface {
	readonly root: string;
	readonly kind: SurfaceKind;
	/** deduped, in config order; every entry is a built-in id */
	readonly dialects: readonly DialectId[];
	readonly include: readonly string[];
	readonly ignore: readonly string[];
	/**
	 * The declared spokes (see `SurfaceSchema`), each normalized by `normalizeSpoke` to a
	 * repo-root-relative posix path, deduped keeping the first occurrence (and its position), in
	 * config order; empty when none are declared. Not checked against the filesystem here — a
	 * spoke that does not exist is for the `hub/symlinks` rule to report, not a config error.
	 * A detected surface's spokes are the candidates detection found reaching its directory, in
	 * table order, without a `loc`; `hub/symlinks` skips a spoke without one.
	 */
	readonly spokes: readonly ResolvedSpoke[];
	/**
	 * This surface's overrides only, sorted by rule id; empty when it configures none. A delta,
	 * not a final answer: the engine applies it last, over the tier → global base `loadConfig`
	 * has already collapsed — there is no dialect layer of rule settings (see
	 * `SurfaceRuleOverride` and `resolveEnabledBySurface`).
	 */
	readonly rules: ReadonlyMap<string, SurfaceRuleOverride>;
	/**
	 * Where this surface's `root` value sits in the config yaml, so a problem discovered long
	 * after parsing — a root that does not exist, two surfaces claiming the same file, a
	 * surface that matches nothing — can still point at the line the user wrote.
	 *
	 * Absent when the surface has no yaml behind it: zero-config auto-detection
	 * synthesizes surfaces from the directory layout, and there is nothing to blame.
	 */
	readonly loc?: Loc;
}

/**
 * `surfaces[1] (".agents/skills")` — index first, so two same-named surfaces stay tellable
 * apart. Lives here, not in discover.ts (where it started), because the engine needs the same
 * string to prefix a per-surface options-validation problem, and importing it from discover.ts
 * just for the naming convention would be a config → discover → config-shaped dependency for
 * no reason other than where the function happened to be typed first.
 */
export function describeSurface(
	surface: ResolvedSurface,
	index: number,
): string {
	return `surfaces[${index}] ("${surface.root}")`;
}

export interface ResolvedConfig {
	/**
	 * Absolute AND canonical (via `realpath`) — not merely `resolve()`d. Every other absolute
	 * path this run derives from a document's location (`document.ts`'s `Document.absPath`,
	 * `engine.ts`'s `Capabilities.root`, and from there every containment/symlink check that
	 * compares against it) is built from THIS field, so if it were left merely lexical — the CLI
	 * positional arg, resolved but not realpath'd — the same repo would lint differently
	 * depending on which of two equally valid spellings (a symlink vs. its real target, e.g.
	 * macOS's `/tmp` → `/private/tmp`) the caller happened to type. Realpathing here, once, means
	 * no downstream consumer has to remember to. `displayFile`'s messages (this function's own
	 * `ConfigError`s) still echo the CALLER's original, unresolved `root` argument — only THIS
	 * field, and everything derived from it, is canonical.
	 */
	root: string;
	/**
	 * `"config"` when a `skillslurp.json` was loaded, `"detected"` when the surfaces
	 * were auto-detected from the directory layout (config-file ENOENT). Required, not
	 * optional: a missing origin at a construction site should be a compile error, not a
	 * silently-`undefined` field a reader has to guess the meaning of. `run.ts` reads this to
	 * decide whether the zero-config announcement belongs on stderr.
	 */
	origin: "config" | "detected";
	/** absolute path of the loaded `skillslurp.json`; the `file` for downstream ConfigErrors (e.g. discover.ts) */
	configFile: string;
	ignore: readonly string[];
	surfaces: readonly ResolvedSurface[];
	rules: ReadonlyMap<string, ResolvedRule>;
	/**
	 * Every options blob written in the global `rules:` block, keyed by rule id — a rule set to
	 * `off` included, since `resolveRuleSetting` drops an `off` entry from `rules` (and with it
	 * the rule's options) entirely. Exists so a surface that re-enables a globally-off rule via
	 * a bare severity override (`base` absent, `override.severity` set) has something real to
	 * inherit instead of falling through to schema defaults: the false green —
	 * `test/maxy: { severity: off, options: { max: 7 } }` globally, re-enabled by a
	 * surface writing only `error`, silently observed `max: 500` (the schema default) instead
	 * of the configured `7`, because the `off` rule's options had nowhere to live once
	 * `resolveRuleSetting` discarded them. Severity and options are independent layers
	 * here, following ESLint — a bare severity changes the severity and keeps whatever options
	 * were already configured.
	 *
	 * For a rule that IS enabled globally, this holds the exact same blob `ResolvedRule.options`
	 * does — one source of truth read through two keys (one answers "is this rule on", the
	 * other "what did the user write for it"), not a second, independent copy that could drift
	 * from the first.
	 *
	 * Opaque, and treated as possibly cyclic — same caveat as `ResolvedRule.options`.
	 */
	ruleOptions: ReadonlyMap<string, unknown>;
	/**
	 * Zero-config auto-detection's candidates that resolved to a real directory but produced no
	 * surface (see `SkippedCandidate`, detect.ts) — empty for `origin: "config"`, since there is
	 * no detection pass to have skipped anything. `run.ts` reads this to mention a still-skipped
	 * candidate (e.g. an escaping symlink) even on a run that DID find surfaces elsewhere, not
	 * only on the all-skipped `NoSurfacesDetectedError` path.
	 */
	skippedCandidates: readonly SkippedCandidate[];
}

export interface ConfigProblem {
	message: string;
	loc?: Loc;
	/**
	 * Overrides the `config/invalid` id `run.ts` assigns to every problem by default. Set only
	 * for a config-shaped mistake that deserves its own, lookup-able id — e.g. `config/no-files`
	 * — so a user sees `config/no-files` in their terminal and can search for exactly that,
	 * rather than a generic `config/invalid` indistinguishable from every other config mistake.
	 * Still surfaces as an exit-2 `ConfigError`, never as a lint diagnostic a rule could have
	 * emitted: it must be one of the engine-owned `RESERVED_NAMESPACES` prefixes.
	 */
	ruleId?: string;
}

export class ConfigError extends Error {
	readonly file: string;
	readonly problems: readonly ConfigProblem[];

	constructor(
		file: string,
		problems: readonly ConfigProblem[],
		message?: string,
	) {
		super(
			message ??
				(problems.length > 0
					? problems.map((p) => p.message).join("; ")
					: `invalid config: ${file}`),
		);
		this.name = "ConfigError";
		this.file = file;
		this.problems = problems;
	}
}

/**
 * Thrown by `loadConfig` when zero-config auto-detection finds no known agent-skill layout
 * under `root` at all — every candidate directory in `candidateRoots` is either missing or
 * produced no surface. `skipped` carries the subset of `candidateRoots` that DID resolve to a
 * real directory (present-but-empty, or a symlink escaping the repo) so `run.ts` can report
 * "this layout is sitting right there and matched nothing" instead of falsely implying every
 * candidate is simply absent (the bug this field exists to fix).
 * `candidateRoots` minus `skipped`'s roots is what was genuinely not found.
 *
 * Deliberately NOT a `ConfigError`, and not a subclass of it: every `ConfigError` means exit 2
 * at the CLI, but an empty repo with no surfaces to lint is not a lint failure — the contract
 * for this case is a stderr notice and exit 0. `runCli` catches this
 * separately from `ConfigError`, in the same inner try.
 */
export class NoSurfacesDetectedError extends Error {
	readonly root: string;
	readonly candidateRoots: readonly string[];
	readonly skipped: readonly SkippedCandidate[];

	constructor(
		root: string,
		candidateRoots: readonly string[],
		skipped: readonly SkippedCandidate[],
	) {
		super(`no known agent-skill layout detected under ${root}`);
		this.name = "NoSurfacesDetectedError";
		this.root = root;
		this.candidateRoots = candidateRoots;
		this.skipped = skipped;
	}
}

/** Node lookup that never throws: yaml's `getIn` can be handed any path shape we derive. */
function getNodeAt(
	doc: YamlDocument,
	path: readonly (string | number)[],
): unknown {
	try {
		return doc.getIn(path, true);
	} catch {
		return undefined;
	}
}

/**
 * Locates the node at `path`, walking up no further than `floor` segments before giving up.
 * The default floor of `path.length - 1` is the historical behaviour: the exact node, else its
 * parent, else the document start. Rule options pass a deeper floor so a missing option can
 * never be reported on top of a *different* rule's entry (see `optionLoc`). Config yaml has no
 * fence, so lineOffset is 0.
 */
function issueLoc(
	doc: YamlDocument,
	lineCounter: LineCounter,
	path: readonly (string | number)[],
	floor = Math.max(path.length - 1, 0),
): Loc {
	for (let depth = path.length; depth >= Math.max(floor, 1); depth--) {
		const node = getNodeAt(doc, path.slice(0, depth));
		if (isNode(node) && node.range) {
			return locFromOffsets(lineCounter, 0, node.range);
		}
	}
	return { line: 1, col: 1 };
}

/**
 * A mapping key rendered as the string it becomes in `toJS()`'s output object — the only form
 * the rest of this file ever compares against, since every key that reaches zod came through
 * `toJS()`. From a JSON config every key is already a string, so this is `String(...)`;
 * the `null` → `""` branch is the YAML-era backstop (a `? ` key with no scalar, which `toJS()`
 * renders as the empty string and not as `"null"`, measured against yaml 2.9.0 on 2026-09-06)
 * and is unreachable through the JSON gate. It stays because it costs one comparison and keeps
 * `keyLoc` and the reported id agreeing on `""` for the one shape JSON can still produce: an
 * explicit empty key, `"": "error"`, reported as `rule id ""` and positioned on that key.
 */
function jsKeyString(value: unknown): string {
	return value === null ? "" : String(value);
}

/**
 * Locates a mapping key's own scalar (not its value) — used for unrecognized-key zod issues
 * and for our own rule-id checks, both of which must point at the key, not its value.
 * `jsKeyString` on the found key's value so the comparison is string-to-string whatever node
 * shape the parser produced.
 */
function keyLoc(
	doc: YamlDocument,
	lineCounter: LineCounter,
	parentPath: readonly (string | number)[],
	key: string,
): Loc {
	const mapping = getNodeAt(doc, parentPath);
	if (isMap(mapping)) {
		for (const item of mapping.items) {
			if (
				isNode(item.key) &&
				"value" in item.key &&
				jsKeyString(item.key.value) === key &&
				item.key.range
			) {
				return locFromOffsets(lineCounter, 0, item.key.range);
			}
		}
	}
	// The block itself, when the key could not be located inside it — or when the block is not
	// a mapping node at all. The second case is real: `rules: *shared` puts an Alias where the
	// mapping would be, `isMap` rejects it, and without this fallback every problem in an
	// anchored rules block would collapse onto {line 1, col 1}. Mirrors `issueLoc`.
	if (isNode(mapping) && mapping.range) {
		return locFromOffsets(lineCounter, 0, mapping.range);
	}
	return { line: 1, col: 1 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How a zod issue becomes user-facing text and gets located. The config schema and a rule's
 * options schema differ in both: one says `surfaces.0.kind: …` and looks the path up from the
 * document root, the other says `rule "x" options.max: …` and looks it up under that rule's
 * `options` node without ever walking above it. Built per document, so `mapIssue` needs no
 * `doc`/`lineCounter` of its own.
 */
interface IssueFraming {
	/** yaml path of the value the schema was applied to; issue paths are relative to it */
	readonly basePath: readonly (string | number)[];
	/** message from the dotted issue path (relative, may be empty) and zod's own text */
	readonly message: (path: string, message: string) => string;
	/** message for a key the schema does not recognize */
	readonly unknownKey: (path: string, key: string) => string;
	/** absolute path (`basePath` + issue path) → the node to blame */
	readonly locate: (path: readonly (string | number)[]) => Loc;
	/** absolute path of a mapping + one of its keys → the node to blame */
	readonly locateKey: (
		parentPath: readonly (string | number)[],
		key: string,
	) => Loc;
}

/** Framing for the top-level config schema: absolute paths, bare `path: message` text. */
function configFraming(
	doc: YamlDocument,
	lineCounter: LineCounter,
): IssueFraming {
	return {
		basePath: [],
		message: (path, message) => (path ? `${path}: ${message}` : message),
		unknownKey: (path, key) =>
			`unrecognized key "${path ? `${path}.${key}` : key}"`,
		locate: (path) => issueLoc(doc, lineCounter, path),
		locateKey: (parentPath, key) => keyLoc(doc, lineCounter, parentPath, key),
	};
}

/**
 * Framing for one rule's `options` blob. `optionsPath` is where the blob lives (`["rules", id,
 * "options"]`, or the surface equivalent) and need not exist: a rule enabled only by a tier has
 * no `rules:` entry at all.
 *
 * The floor is what keeps that case honest. `issueLoc` may walk up to the rule's own entry —
 * so a missing required option lands on the severity the user wrote — but never above it.
 * Blaming the enclosing `rules:` map would put the caret on whichever *other* rule happened to
 * be configured. When even the rule's entry is absent, `fallbackPath` (the `extends:` list that
 * pulled the rule in) is the honest thing to point at.
 */
function optionFraming(
	doc: YamlDocument,
	lineCounter: LineCounter,
	id: string,
	optionsPath: readonly (string | number)[],
	fallbackPath: readonly (string | number)[],
): IssueFraming {
	const floor = optionsPath.length - 1;
	const ownEntryExists = isNode(getNodeAt(doc, optionsPath.slice(0, floor)));
	const locate = (path: readonly (string | number)[]): Loc =>
		ownEntryExists
			? issueLoc(doc, lineCounter, path, floor)
			: issueLoc(doc, lineCounter, fallbackPath);
	return {
		basePath: optionsPath,
		message: (path, message) =>
			path
				? `rule "${id}" options.${path}: ${message}`
				: `rule "${id}" options: ${message}`,
		unknownKey: (path, key) =>
			`rule "${id}" options: unrecognized key "${path ? `${path}.${key}` : key}"`,
		locate,
		locateKey: (parentPath, key) =>
			ownEntryExists
				? keyLoc(doc, lineCounter, parentPath, key)
				: issueLoc(doc, lineCounter, fallbackPath),
	};
}

/**
 * Maps one zod issue to one or more positioned problems. `invalid_union` and
 * `unrecognized_keys` each need special handling; everything else falls through to the
 * generic path-based lookup.
 */
function mapIssue(
	issue: z.core.$ZodIssue,
	framing: IssueFraming,
): ConfigProblem[] {
	// zod v4 types `issue.path` as `PropertyKey[]`; a symbol segment cannot come from yaml
	// (every key we parse is a string or a number) and has no node to point at, so drop it.
	const path = issue.path.filter(
		(segment): segment is string | number => typeof segment !== "symbol",
	);
	const absolute = [...framing.basePath, ...path];
	const dotted = path.join(".");

	if (issue.code === "invalid_union") {
		// zod v4 collapses a failed union into a single generic "Invalid input" issue and
		// buries the actually useful sub-issues (e.g. the bad severity value, or a
		// misspelled key inside RuleSettingSchema's object branch) in `issue.errors`, one
		// array per union member in declaration order. Recover them by picking the branch
		// whose shape matches the actual input: RuleSettingSchema always puts the scalar
		// severity branch first and the object branch second. A rule's own options schema can
		// be a union of any shape, so fall back to the first branch that reported anything
		// rather than leaving the user with a bare "Invalid input".
		const branchIssues =
			(isPlainObject(issue.input) ? issue.errors[1] : issue.errors[0]) ??
			issue.errors.find((branch) => branch.length > 0);
		if (branchIssues && branchIssues.length > 0) {
			return branchIssues.flatMap((sub) =>
				mapIssue(
					{ ...sub, path: [...path, ...sub.path] } as z.core.$ZodIssue,
					framing,
				),
			);
		}
		// no more specific sub-issue available — fall through to the generic handling below.
	}

	if (issue.code === "unrecognized_keys") {
		return issue.keys.map((key) => ({
			message: framing.unknownKey(dotted, key),
			loc: framing.locateKey(absolute, key),
		}));
	}

	return [
		{
			message: framing.message(dotted, issue.message),
			loc: framing.locate(absolute),
		},
	];
}

function mapZodIssues(
	issues: readonly z.core.$ZodIssue[],
	framing: IssueFraming,
): ConfigProblem[] {
	return issues.flatMap((issue) => mapIssue(issue, framing));
}

function resolveRuleSetting(setting: RuleSetting): ResolvedRule | undefined {
	if (typeof setting === "string") {
		return setting === "off" ? undefined : { severity: setting };
	}
	if (setting.severity === "off") {
		return undefined;
	}
	// Built up field-by-field so `options` is only an own key when actually defined — a
	// spread of `{ options: setting.options }` would add an own `options: undefined` key,
	// visible to `"options" in rule` even when the config gave no options at all.
	const resolved: ResolvedRule = { severity: setting.severity };
	if (setting.options !== undefined) {
		resolved.options = setting.options;
	}
	return resolved;
}

/**
 * Resolves a registry plus an `extends` list plus a written `rules:` record into the two maps
 * `ResolvedConfig` carries (`rules`, `ruleOptions`). The single implementation both `loadConfig`
 * return paths call — the normal one with `parsed.extends`/`parsed.rules`, the zero-config
 * auto-detection path with `["recommended"]`/`{}` — so a synthetic detected config can
 * never drift from what a real `extends: [recommended]` config resolves to on the same
 * registry. Returns plain, unsealed `Map`s; each caller seals them as part of building its own
 * `ResolvedConfig` (the detected path has nothing else to validate against real yaml, so it
 * seals immediately, while the configured path still has the positioned option-validation stage
 * ahead of it).
 *
 * Tier membership is a property of the rule, not of a table kept alongside it: a rule that
 * claims `recommended` is in `recommended`, and there is nothing to keep in sync. Its
 * `defaultSeverity` is the severity the tier gives it; a `rules:` entry still wins.
 */
function resolveTierRules(
	registry: readonly Rule[],
	extendsList: readonly Tier[],
	rulesRecord: Record<string, RuleSetting>,
): { rules: Map<string, ResolvedRule>; ruleOptions: Map<string, unknown> } {
	const merged = new Map<string, RuleSetting>();
	for (const extended of extendsList) {
		for (const tier of TIER_IMPLIES[extended]) {
			for (const rule of registry) {
				if (rule.meta.tiers.includes(tier)) {
					merged.set(rule.meta.id, rule.meta.defaultSeverity);
				}
			}
		}
	}
	for (const [id, setting] of Object.entries(rulesRecord)) {
		merged.set(id, setting);
	}

	const rules = new Map<string, ResolvedRule>();
	for (const id of [...merged.keys()].sort()) {
		const setting = merged.get(id);
		if (setting === undefined) {
			continue;
		}
		const resolved = resolveRuleSetting(setting);
		if (resolved !== undefined) {
			rules.set(id, resolved);
		}
	}

	// See `ResolvedConfig.ruleOptions` for why this exists: built from `rulesRecord` directly
	// (not `merged`, which also carries tier defaults that never wrote an `options:` key), so an
	// `off` rule's options survive here even though `resolveRuleSetting` just dropped them from
	// `rules` above. Sorted by id for the same byte-stability reason every other resolved map is.
	const ruleOptions = new Map<string, unknown>();
	for (const id of Object.keys(rulesRecord).sort()) {
		const written = rulesRecord[id];
		if (typeof written === "object" && written.options !== undefined) {
			ruleOptions.set(id, written.options);
		}
	}

	return { rules, ruleOptions };
}

/**
 * Per-surface counterpart of `resolveRuleSetting`. Keeps every configured id — including the
 * ones set to `off` — because the map is a delta, not a final answer (see `SurfaceRuleOverride`).
 * Sorted by id so the resolved config is byte-stable across runs.
 */
function resolveSurfaceRules(
	rules: Record<string, SurfaceRuleSetting>,
): ReadonlyMap<string, SurfaceRuleOverride> {
	const resolved = new Map<string, SurfaceRuleOverride>();
	for (const id of Object.keys(rules).sort()) {
		const setting = rules[id];
		if (setting === undefined) {
			continue;
		}
		if (typeof setting === "string") {
			resolved.set(id, { severity: setting });
			continue;
		}
		// Field-by-field for the same reason as `resolveRuleSetting`: a spread would give the
		// override own `severity: undefined` / `options: undefined` keys even when the config
		// supplied neither, which `"severity" in override` would then read as "explicitly set".
		const override: SurfaceRuleOverride = {};
		if (setting.severity !== undefined) {
			override.severity = setting.severity;
		}
		if (setting.options !== undefined) {
			override.options = setting.options;
		}
		resolved.set(id, override);
	}
	return sealMap(resolved);
}

/**
 * The written keys of one `rules:` mapping — the UNION of the yaml AST's own keys and zod's
 * parsed output (`resolved`), because neither source alone sees all of them and a key seen by
 * neither is a rule setting silently thrown away.
 *
 * What only the AST sees: `z.record`'s output is built by assigning into a plain object one key
 * at a time, and assigning a `__proto__` key that way sets the object's prototype instead of
 * creating an own property — silently, since the assigned value (a severity string) is not an
 * object, so even the prototype write is a no-op. Measured against zod 4.4.3 on 2026-09-06:
 * `rules: { __proto__: error }` parses clean and `Object.keys(resolved)` comes back empty, so a
 * user who believed they had configured (or disabled) a rule got no diagnostic and no error at
 * all.
 *
 * Since the JSON gate neither of the two shapes below can arrive from a config file —
 * JSON keys are string scalars and JSON has no aliases — so the union is a backstop for a
 * hand-built or differently-parsed document, and the measurements are the record of why it was
 * built.
 *
 * What only `resolved` sees: a key whose node is a COLLECTION. `? [a, b]` / `: error` is a legal
 * yaml mapping key; `toJS()` stringifies it (to `"[ a, b ]"`) and it becomes a real own key of
 * `resolved`, but the AST node is a `YAMLSeq`/`YAMLMap` with no `.value`, so the loop below
 * cannot read it. Reading the AST alone therefore traded the `__proto__` silent-swallow for a
 * collection-key one — measured on 2026-09-06, where the config above produced no output and
 * exit 0. Hence the union rather than a choice between the two.
 *
 * The union is also what covers `parentPath` not being a mapping node at all: `rules: *shared`
 * (an alias) puts an `Alias` there, per `keyLoc`'s own fallback comment, and `resolved` — already
 * `toJS()`-through, which transparently expands aliases — is then the only place the keys are.
 *
 * Order is AST-first, then whatever `resolved` adds, deduplicated: a written key keeps the
 * position the file gives it, and one key never yields two problems. Ids the AST could not
 * supply are located by `keyLoc`'s block-level fallback, since by construction there is no key
 * scalar to point at.
 */
function ruleIdKeys(
	doc: YamlDocument,
	parentPath: readonly (string | number)[],
	resolved: Readonly<Record<string, unknown>>,
): readonly string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const add = (key: string): void => {
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	};
	const mapping = getNodeAt(doc, parentPath);
	if (isMap(mapping)) {
		for (const item of mapping.items) {
			if (isNode(item.key) && "value" in item.key) {
				add(jsKeyString(item.key.value));
			}
		}
	}
	for (const key of Object.keys(resolved)) {
		add(key);
	}
	return keys;
}

/**
 * Collects reserved-namespace, malformed-shape and unknown-id problems for one `rules` block,
 * positioned at the offending key. `parentPath` is the yaml path of that block — `["rules"]`
 * for the global one, `["surfaces", i, "rules"]` for a surface's.
 *
 * Three checks, in this order, each `continue`-ing past the rest once one fires so a single id
 * gets exactly one problem:
 *
 * 1. Reserved namespace — checked first so an id that happens to be BOTH reserved and malformed
 *    (a hypothetical `PARSE/x`) is still reported as reserved, not as a charset violation; every
 *    real reserved id already matches `RULE_ID_PATTERN`, so this ordering changes nothing for
 *    the ids that exist today.
 * 2. Charset (`RULE_ID_PATTERN`), before the registry lookup — this is what actually catches
 *    `__proto__` (no `/`, and `_` is not in the allowed charset) as well as an uppercase letter,
 *    a missing or doubled `/`, or an empty segment (`foo/`). Given its own message rather than
 *    reusing `unknown rule id`: "unknown" implies a real id was misspelled, which is not what
 *    happened here, and naming the expected shape is more useful for a config-shaped mistake
 *    than a generic bad-value error would be. Positioned with the same `keyLoc` the other two
 *    checks use, not reinvented.
 * 3. Unknown id — the existing registry-membership check, unchanged.
 */
function checkRuleIds(
	doc: YamlDocument,
	lineCounter: LineCounter,
	ids: readonly string[],
	parentPath: readonly (string | number)[],
	byId: ReadonlyMap<string, Rule>,
	problems: ConfigProblem[],
): void {
	for (const id of ids) {
		if (RESERVED_NAMESPACES.some((ns) => id.startsWith(ns))) {
			problems.push({
				message: `rule id "${id}" is reserved and cannot be configured`,
				loc: keyLoc(doc, lineCounter, parentPath, id),
			});
			continue;
		}
		if (!RULE_ID_PATTERN.test(id)) {
			problems.push({
				message: `rule id "${id}" must look like "namespace/name" (lowercase letters, digits and hyphens only, exactly one "/")`,
				loc: keyLoc(doc, lineCounter, parentPath, id),
			});
			continue;
		}
		if (!byId.has(id)) {
			problems.push({
				message: `unknown rule id "${id}"`,
				loc: keyLoc(doc, lineCounter, parentPath, id),
			});
		}
	}
}

/**
 * A `rules:` entry inside a SURFACE naming a `"shape"` rule: that kind runs once per
 * repository, never once per surface, so a surface entry for one can never do anything — the
 * principle that such an entry should itself be an error, not a silent no-op nobody notices
 * turned nothing on. The engine (`resolveEnabledBySurface`) carries the same
 * check as a backstop for a hand-built `ResolvedConfig` that skipped this function entirely.
 *
 * Called after `checkRuleIds` on the same block, with the same unfiltered `ids`: a reserved,
 * malformed or unknown id is already reported there, and is skipped here only because
 * `byId.get(id)` returns `undefined` for it.
 */
function checkNoSurfaceRepoRules(
	doc: YamlDocument,
	lineCounter: LineCounter,
	ids: readonly string[],
	parentPath: readonly (string | number)[],
	byId: ReadonlyMap<string, Rule>,
	problems: ConfigProblem[],
): void {
	for (const id of ids) {
		const rule = byId.get(id);
		if (rule?.kind === "shape") {
			problems.push({
				message: `rule "${id}" is repository-wide and must be configured in the top-level "rules", not on a surface`,
				loc: keyLoc(doc, lineCounter, parentPath, id),
			});
		}
	}
}

/**
 * Validates one rule's `options` blob against that rule's own schema, collecting a positioned
 * problem per zod issue. Never throws for a bad *value* — that is the caller's `ConfigError`.
 *
 * A blob that is absent is parsed as `{}`, not as `undefined`, so a schema with a required
 * field is caught here rather than by the engine's loc-less backstop. The cost is that a
 * top-level `.default()` on an options schema never fires; `RuleMeta.optionsSchema` documents
 * that defaults belong on the fields. `null` is NOT treated as absent — writing `options:` with
 * nothing after it is a mistake worth reporting, not a synonym for omitting the key.
 */
function checkRuleOptions(
	doc: YamlDocument,
	lineCounter: LineCounter,
	rule: Rule,
	options: unknown,
	optionsPath: readonly (string | number)[],
	fallbackPath: readonly (string | number)[],
	problems: ConfigProblem[],
): void {
	const { optionsSchema, id } = rule.meta;
	const framing = optionFraming(
		doc,
		lineCounter,
		id,
		optionsPath,
		fallbackPath,
	);
	if (!optionsSchema) {
		if (options !== undefined) {
			problems.push({
				message: `rule "${id}" accepts no options`,
				loc: framing.locate(optionsPath),
			});
		}
		return;
	}
	const result = optionsSchema.safeParse(options === undefined ? {} : options);
	if (!result.success) {
		problems.push(...mapZodIssues(result.error.issues, framing));
	}
}

/**
 * A `Map` that refuses to be written to. `Object.freeze` does not help: a Map's entries live in
 * internal slots, so `set`/`delete`/`clear` keep working on a frozen instance. Shadowing them
 * with own properties does, and keeps the value a real `Map` for every reader.
 *
 * A synthesized surface's `rules` map (zero-config auto-detection) is always empty — there
 * is no yaml to write a per-surface override into — and is locked the exact same way a written
 * surface's is: `sealMap(new Map())`, built in `resolveDetectedSurface` below, not in
 * detect.ts, which produces plain `DetectedSurface` data and must not import this function (or
 * anything else from this module) at runtime — see detect.ts's module header.
 */
export function sealMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
	const refuse = (): never => {
		throw new TypeError("the resolved config is read-only");
	};
	return Object.freeze(
		Object.assign(map, { set: refuse, delete: refuse, clear: refuse }),
	);
}

/**
 * Deep-freezes one resolved surface. `Document.surface` hands this object to every rule in the
 * run, so a mutable one would undo the point of freezing the `Document` itself: a rule could
 * rewrite the dialects the next document is judged against, or the surface's root. `Readonly<>`
 * on the interface is a type, not a lock (AGENTS.md).
 *
 * Used for both a written surface and a zero-config auto-detected one — a detected surface
 * has no yaml behind it, hence no `loc` (see `ResolvedSurface.loc`), but is otherwise frozen
 * exactly the same way, by the same pass, so the two paths cannot drift.
 *
 * Exported (with `sealMap`) for the RuleTester (src/testing/rule-tester.ts), which builds a
 * surface by hand and must hand rules the same locked object a real run does: a rule mutating
 * `doc.surface` throws in production and would otherwise pass every rule test.
 */
export function freezeSurface(surface: ResolvedSurface): ResolvedSurface {
	Object.freeze(surface.dialects);
	Object.freeze(surface.include);
	Object.freeze(surface.ignore);
	for (const spoke of surface.spokes) {
		if (spoke.loc) {
			Object.freeze(spoke.loc);
		}
		Object.freeze(spoke);
	}
	Object.freeze(surface.spokes);
	if (surface.loc) {
		Object.freeze(surface.loc);
	}
	// `sealMap` only locks the map's own shape (a rule cannot add or remove
	// an entry) — the plain `SurfaceRuleOverride` object each `.get(id)` hands back was still
	// mutable, so a rule could rewrite `doc.surface.rules.get(id)!.severity` and every later
	// rule on the same document would see the lie. `options` inside it is deliberately left
	// alone: it is raw config data treated as possibly cyclic (the same caveat `ResolvedRule.options`
	// carries), and deep-freezing it here would duplicate the job `deepFreeze` already does,
	// once, in engine.ts — over the *validated* options object, not a second, cruder pass over
	// the raw written value.
	for (const override of surface.rules.values()) {
		Object.freeze(override);
	}
	return Object.freeze(surface);
}

/**
 * Resolves one zero-config `DetectedSurface` (detect.ts) into a `ResolvedSurface`, exactly as
 * if the user had written a `surfaces:` entry for it. Detection only ever hands back plain data
 * (see detect.ts's module header for why); this is where that data becomes the same shape a
 * written surface resolves to, run through the same `freezeSurface` pass.
 *
 * `include` is `defaultInclude(kind, dialects)` — a synthesized surface's file set comes from
 * its kind and dialects, the same lookup a written surface with no `include:` falls back to;
 * there is no separate "detected include" concept.
 *
 * `loc` is never set, not even to `undefined`: `config/no-files` (discover.ts) treats the
 * absence of `loc` as "not something the user wrote" and skips its zero-match check on that
 * basis; every candidate detect.ts hands back already passed its own "≥1 file matched" test, so
 * there is nothing left for that check to catch, and inventing a synthetic `loc` would only risk
 * wiring an empty detected directory back into an exit-2 `ConfigError`, breaking this feature's
 * own "notice + exit 0" contract.
 *
 * `ignore: []` for the same reason there is no `loc`: there is no yaml `ignore:` block to have
 * written, and a detected surface synthesizes no ignore patterns of its own, so there is nothing
 * left to anchor. `rules: sealMap(new Map())` likewise — no yaml, no per-surface override to
 * hold. `spokes` are the other candidates detection found reaching this surface's directory, and
 * like the surface they have no `loc`: nothing was declared, so `hub/symlinks` leaves them alone.
 */
function resolveDetectedSurface(detected: DetectedSurface): ResolvedSurface {
	return freezeSurface({
		root: detected.root,
		kind: detected.kind,
		dialects: detected.dialects,
		include: defaultInclude(detected.kind, detected.dialects),
		ignore: [],
		spokes: detected.spokes,
		rules: sealMap(new Map()),
	});
}

/**
 * Spells one written spoke as a repo-root-relative posix path, through the same `toPosixPath`
 * the discovery side uses for a surface root: `./a/` and `a` become `a`, `a/../b` becomes `b`,
 * and `./` becomes `.`. The trailing slash is stripped on top of that (`normalize` keeps it),
 * since `validateSurfaces` compares spokes with roots as strings. Purely lexical — an absolute or
 * `..`-escaping spoke stays one, and is rejected there.
 */
function normalizeSpoke(written: string): string {
	return stripTrailingSlashes(toPosixPath(written), isAbsolute);
}

/**
 * Normalizes the written `spokes` of one surface and pairs each kept entry with its own
 * position. Two spellings of one directory collapse onto the first, which also keeps the
 * position at the line the user wrote first. `locate` may answer `undefined`, and then the
 * entry has no `loc` key at all rather than an own one holding `undefined`.
 */
export function resolveSpokes(
	written: readonly string[] | undefined,
	locate: (position: number) => Loc | undefined,
): readonly ResolvedSpoke[] {
	const spokes: { path: string; loc?: Loc }[] = [];
	written?.forEach((entry, position) => {
		const path = normalizeSpoke(entry);
		if (spokes.some((spoke) => spoke.path === path)) {
			return;
		}
		const spoke: { path: string; loc?: Loc } = { path };
		const loc = locate(position);
		if (loc !== undefined) {
			spoke.loc = loc;
		}
		spokes.push(spoke);
	});
	return spokes;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

/**
 * V8's `JSON.parse` `SyntaxError` often ends with a `(line N column M)` suffix (measured on
 * Node 26, for most syntax errors) — a real position into `src`, worth pointing at instead of
 * defaulting to 1:1. Absent on some messages (e.g. "Unexpected end of JSON input", which names
 * no position at all), which is exactly when 1:1 is the honest answer rather than a guess.
 *
 * Exported for its unit tests: `bun test` runs on JavaScriptCore, whose `JSON.parse` messages
 * never carry the suffix, so no `loadConfig` test can reach the matching branch.
 */
export function jsonSyntaxErrorLoc(message: string): Loc | undefined {
	const match = /\(line (\d+) column (\d+)\)$/.exec(message);
	if (!match) {
		return undefined;
	}
	const [, line, col] = match;
	if (line === undefined || col === undefined) {
		return undefined;
	}
	return { line: Number(line), col: Number(col) };
}

/**
 * Loads and validates `<root>/skillslurp.json` (that exact filename only; no upward search, no
 * alternate extension). Can reject two ways, and a caller must catch both — see
 * `runCli`, which does:
 *
 * - `ConfigError` (exit 2 at the CLI) for a broken symlink at the
 *   config path, an unreadable file, invalid JSON, broken yaml, a schema violation, or an
 *   invalid rule id. These are exclusive stages — the JSON syntax gate,
 *   then the yaml parse, then `toJS()`, then the zod schema, then the rule-id checks — and only
 *   the first stage that fails ever runs: its `ConfigError` carries every problem found *within
 *   that stage*, not just the first, but never problems from a later stage, since a failing
 *   earlier stage means there is no valid parsed config for the later checks to run against.
 * - `NoSurfacesDetectedError` (exit 0, deliberately NOT a `ConfigError`) when the config file is
 *   genuinely absent (zero-config auto-detection) and none of the known agent-skill layouts
 *   are present under `root` either — an empty repo with nothing to lint is not a lint failure.
 *
 * A config file that is genuinely missing (no `skillslurp.json`, and `root` is a real directory) triggers auto-detection
 * instead of failing outright: every candidate directory that exists and holds at least one
 * matching file becomes a synthesized surface (`origin: "detected"` on the returned
 * `ResolvedConfig`), and only an empty result from that pass raises `NoSurfacesDetectedError`.
 */
export async function loadConfig(
	root: string,
	registry: readonly Rule[],
): Promise<ResolvedConfig> {
	// Tier membership comes straight from `meta.tiers`, so an unvalidated registry could put a
	// reserved id into `ResolvedConfig` — an id the same user is forbidden to write in `rules:`.
	validateRegistry(registry);
	const byId = new Map(registry.map((rule) => [rule.meta.id, rule] as const));
	const absRoot = resolve(root);

	const file = join(absRoot, CONFIG_FILENAME);
	// Caller-supplied `root`, not `absRoot`/`file`, in every message below: a relative `root`
	// (the common case — the CLI passes its positional path through unresolved for exactly
	// this reason) keeps these messages relative and machine-independent, which matters once
	// they can end up in a baseline. Only the actual filesystem access above needs the
	// resolved absolute form.
	const displayFile = join(root, CONFIG_FILENAME);

	// Before the read, and before the ENOENT ladder below: `skillslurp.json` is a path the
	// repository under lint chooses, so a symlink or a FIFO at that name is committed content.
	// `readFile` follows both — the first echoes an unrelated file's top-level key names onto
	// STDOUT as `unrecognized key "..."` problems, the second never returns. See
	// `repoFileRefusal` (paths.ts) for the measurements. A path that is not there at all is not
	// refused here; the ENOENT ladder below still owns that case, including auto-detection.
	const refusal = await repoFileRefusal(file);
	if (refusal !== undefined) {
		throw new ConfigError(
			file,
			[],
			`refusing to read ${displayFile}: ${refusal}`,
		);
	}

	let src: string;
	try {
		src = await readFile(file, "utf8");
	} catch (err) {
		if (isErrnoException(err)) {
			if (err.code === "ENOENT") {
				// `readFile`'s ENOENT is ambiguous in a second way, checked first: a dangling
				// symlink (or a symlink chain that does not resolve) at `file` also fails
				// `readFile` with ENOENT, indistinguishable from "no file here at all" — but
				// `lstat` does not follow the final symlink, so it tells the two apart. Silently
				// falling through to auto-detection here would lint whatever layout happens to
				// exist instead of the config the user actually wrote (or meant to, via the
				// symlink) — a regression from a loud exit 2 to a quiet, wrong exit 0/1. Checked
				// before the root-existence guard below: a broken symlink implies `absRoot`
				// itself exists, so there is nothing that check could add here.
				let configPathExists: boolean;
				try {
					await lstat(file);
					configPathExists = true;
				} catch {
					configPathExists = false;
				}
				if (configPathExists) {
					throw new ConfigError(
						file,
						[],
						`${displayFile} exists but could not be read (broken symlink?)`,
					);
				}

				// The config file itself is missing, which is ambiguous: `root` may not exist
				// at all (a caller typo — must stay a `ConfigError`, exit 2, never "nothing to
				// lint"), or `root` may be a perfectly real directory that just has no
				// `skillslurp.json` yet, the case zero-config auto-detection
				// exists for. `stat(absRoot)` is what tells the two apart; a second failed
				// `readFile` would not, since a nonexistent path segment produces this exact
				// same ENOENT either way.
				let rootIsDirectory: boolean;
				try {
					rootIsDirectory = (await stat(absRoot)).isDirectory();
				} catch {
					rootIsDirectory = false;
				}
				if (!rootIsDirectory) {
					throw new ConfigError(
						file,
						[],
						`${root} does not exist or is not a directory`,
					);
				}

				const { surfaces: detected, skipped } = await detectSurfaces(
					absRoot,
					DEFAULT_IGNORE,
				);
				if (detected.length === 0) {
					throw new NoSurfacesDetectedError(root, CANDIDATE_ROOTS, skipped);
				}

				// `extends: ["recommended"]` through the SAME helper the configured path calls
				// below, not a parallel reimplementation that could drift from it (see
				// `resolveTierRules`). No `rules:` block exists to write per-rule options
				// against, so the record is empty.
				const { rules: detectedRules, ruleOptions: detectedRuleOptions } =
					resolveTierRules(registry, ["recommended"], {});
				// Canonical, not merely resolved: `rootIsDirectory` above already proved
				// `absRoot` exists and is a directory, so this cannot fail here. See
				// `ResolvedConfig.root`'s own doc comment for why every consumer needs this to
				// already be symlink-free rather than re-deriving it.
				const rootReal = await realpath(absRoot);
				return {
					root: rootReal,
					origin: "detected",
					// The file the user SHOULD create, not a file that exists: any downstream
					// `ConfigError` in a detected run (e.g. discover.ts's overlap/no-files
					// checks) is telling them exactly that, so pointing at this path is the
					// honest answer even though nothing lives there yet.
					//
					// Built from `rootReal`, not the lexical `file`: every consumer of this field
					// (`buildCorpus`'s own-config exclusion, `displayPath(config.root, ...)`)
					// compares or relativizes it against the canonical `root` above, so the two
					// must share the same base or they silently stop lining up the moment `root`
					// is reached through a symlink (e.g. macOS's default `/tmp` -> `/private/tmp`).
					configFile: join(rootReal, CONFIG_FILENAME),
					ignore: DEFAULT_IGNORE,
					surfaces: Object.freeze(detected.map(resolveDetectedSurface)),
					rules: sealMap(detectedRules),
					ruleOptions: sealMap(detectedRuleOptions),
					skippedCandidates: skipped,
				};
			}
			if (err.code === "EISDIR") {
				throw new ConfigError(
					file,
					[],
					`${displayFile} is a directory, expected a json file`,
				);
			}
			if (err.code === "ENOTDIR") {
				throw new ConfigError(file, [], `${root} is not a directory`);
			}
		}
		throw err;
	}

	// A pure syntax gate, ahead of the real (yaml-library) parse below: V8's `JSON.parse` rejects
	// anything the yaml parser would otherwise accept that valid JSON never is (a bare `yes`, a
	// trailing comma, single quotes, a comment) — cheaply, and with a message worth showing
	// rather than translating. Not the parse this function's data comes from: `data` a few lines
	// down still comes from `doc.toJS()`, so this stage exists to REJECT, never to produce a
	// value anything downstream reads.
	try {
		// A leading BOM is legal YAML 1.2 and was accepted by the previous loader; `JSON.parse`
		// rejects it, so the gate strips it. `src` itself stays untouched so the yaml pass's offsets
		// still line up with the file.
		JSON.parse(src.replace(/^\uFEFF/, ""));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ConfigError(file, [
			{
				message: `invalid JSON: ${message}`,
				loc: jsonSyntaxErrorLoc(message) ?? { line: 1, col: 1 },
			},
		]);
	}

	const lineCounter = new LineCounter();
	// logLevel: "error" stops yaml from printing a bare "Warning: ..." + stack trace
	// straight to stderr for things like collection keys; we surface warnings ourselves
	// via doc.warnings (currently: nowhere, intentionally — see document.ts).
	const doc = parseDocument(src, {
		lineCounter,
		prettyErrors: false,
		logLevel: "error",
	});

	if (doc.errors.length > 0) {
		const problems = doc.errors.map((err) => ({
			message: err.message,
			loc: locFromOffsets(lineCounter, 0, err.pos),
		}));
		throw new ConfigError(file, problems);
	}

	let data: unknown;
	try {
		// maxAliasCount is unreachable from a JSON config (JSON has no aliases) and stays as a
		// backstop; see document.ts for the rationale where it is live, frontmatter parsing.
		data = doc.toJS({ maxAliasCount: 100 });
	} catch (err) {
		const pos = errorPos(err);
		throw new ConfigError(file, [
			{
				message: err instanceof Error ? err.message : String(err),
				loc: pos ? locFromOffsets(lineCounter, 0, pos) : { line: 1, col: 1 },
			},
		]);
	}

	// reportInput: true — off by default in zod v4 — attaches `issue.input` to every
	// issue; mapIssue's invalid_union handling needs it to tell which union branch's
	// sub-issues (scalar severity vs. the object form) actually match the real input.
	const result = ConfigSchema.safeParse(data, { reportInput: true });
	if (!result.success) {
		throw new ConfigError(
			file,
			mapZodIssues(result.error.issues, configFraming(doc, lineCounter)),
		);
	}
	const parsed = result.data;

	// One stage for every id the schema can only see as an arbitrary string: dialect ids and
	// rule ids, per surface and globally. Reported in schema-declaration order (surfaces before
	// the top-level `rules` block) so the list is deterministic regardless of key order in the
	// yaml.
	const idProblems: ConfigProblem[] = [];
	parsed.surfaces.forEach((surface, index) => {
		// Only an explicitly written list is checked; an omitted one resolves to
		// `DEFAULT_DIALECTS`, which is valid by construction and pinned by a test.
		surface.dialects?.forEach((dialect, position) => {
			const loc = issueLoc(doc, lineCounter, [
				"surfaces",
				index,
				"dialects",
				position,
			]);
			if (!isDialectId(dialect)) {
				idProblems.push({
					message: `unknown dialect "${dialect}" (known: ${BUILTIN_DIALECT_IDS.join(", ")})`,
					loc,
				});
				return;
			}
			if (BUILTIN_DIALECTS[dialect].contracts[surface.kind] === undefined) {
				idProblems.push({
					message: `dialect "${dialect}" has no contract for surface kind "${surface.kind}" (kind "${surface.kind}" is spoken by: ${dialectsSupportingKind(surface.kind).join(", ")})`,
					loc,
				});
			}
		});
		const surfaceRuleIds = ruleIdKeys(
			doc,
			["surfaces", index, "rules"],
			surface.rules,
		);
		checkRuleIds(
			doc,
			lineCounter,
			surfaceRuleIds,
			["surfaces", index, "rules"],
			byId,
			idProblems,
		);
		checkNoSurfaceRepoRules(
			doc,
			lineCounter,
			surfaceRuleIds,
			["surfaces", index, "rules"],
			byId,
			idProblems,
		);
	});
	checkRuleIds(
		doc,
		lineCounter,
		ruleIdKeys(doc, ["rules"], parsed.rules),
		["rules"],
		byId,
		idProblems,
	);
	if (idProblems.length > 0) {
		throw new ConfigError(file, idProblems);
	}

	const { rules, ruleOptions } = resolveTierRules(
		registry,
		parsed.extends,
		parsed.rules,
	);

	const surfaces = parsed.surfaces.map((s, index) => {
		// Every entry cleared `isDialectId` in the id stage above, which throws before
		// reaching here, so the narrowing cast cannot lie.
		const dialects = (
			s.dialects === undefined
				? DEFAULT_DIALECTS[s.kind]
				: [...new Set(s.dialects)]
		) as readonly DialectId[];
		return {
			root: s.root,
			kind: s.kind,
			loc: issueLoc(doc, lineCounter, ["surfaces", index, "root"]),
			dialects,
			include: s.include ?? defaultInclude(s.kind, dialects),
			ignore: s.ignore,
			spokes: resolveSpokes(s.spokes, (position) =>
				issueLoc(doc, lineCounter, ["surfaces", index, "spokes", position]),
			),
			rules: resolveSurfaceRules(s.rules),
		};
	});

	// Last stage: rule options, against each rule's own schema, positioned at the yaml node that
	// caused each issue. The engine re-validates before running anything, but only as a
	// defensive backstop for a caller that built a `ResolvedConfig` without `loadConfig` — its
	// problems carry no `loc`, so this is where a user actually gets a line and column.
	//
	// Globally, the resolved map is the base layer, so a rule enabled with no options at all is
	// still checked (`{}` against its schema). A rule written but switched `off` is checked too:
	// `resolveRuleSetting` drops it from the resolved map, and silently discarding options the
	// user wrote — while the surface layer would have reported them — is how a typo survives an
	// `off` that gets deleted later.
	//
	// A surface entry is a delta and its options REPLACE the global blob wholesale when written,
	// ESLint-style, never a deep merge — so an entry that names no options is inheriting rather
	// than clearing, and there is nothing to validate. The engine implements that merge; it is decided
	// here because both layers' validation only makes sense under one answer.
	const optionProblems: ConfigProblem[] = [];
	// Every id the global loop below covers, so the surface loop can tell "already validated
	// once, at the global layer" from "validated nowhere" without re-deriving the union.
	const globalIds = new Set([...rules.keys(), ...Object.keys(parsed.rules)]);
	for (const id of [...globalIds].sort()) {
		const rule = byId.get(id);
		if (!rule) {
			continue;
		}
		// Same blob `ruleOptions` holds for an enabled rule (see `ResolvedConfig.ruleOptions`'s
		// JSDoc) — one source, read through whichever key is at hand here.
		const options = rules.get(id)?.options ?? ruleOptions.get(id);
		checkRuleOptions(
			doc,
			lineCounter,
			rule,
			options,
			["rules", id, "options"],
			["extends"],
			optionProblems,
		);
	}
	surfaces.forEach((surface, index) => {
		for (const [id, override] of surface.rules) {
			const rule = byId.get(id);
			if (!rule) {
				continue;
			}
			if (override.options !== undefined) {
				checkRuleOptions(
					doc,
					lineCounter,
					rule,
					override.options,
					["surfaces", index, "rules", id, "options"],
					["surfaces", index, "rules", id],
					optionProblems,
				);
				continue;
			}
			// The override names no options, so there is nothing written to validate — but a rule
			// mentioned ONLY in a surface's `rules:` block is in neither `rules.keys()` nor
			// `Object.keys(parsed.rules)`, so `globalIds` above never sees it, and the global loop
			// only validates ids it knows about. Without this branch, `surfaces[0].rules:
			// { index/complete: error }` on a rule with a *required* option passed `loadConfig`
			// clean and only tripped the engine's loc-less backstop, which cannot satisfy the
			// "enabling without it is a positioned config error" contract. So: validate the
			// effective `{}` here whenever this override actually turns the rule on (a severity
			// other than `off`), and only for an id the global loop never saw.
			//
			// Membership in `globalIds` is the right test, not "does an inherited options blob
			// exist": a rule pulled in by a tier, or written as a bare `off`, has no options blob at
			// all, yet the global loop still validated its effective `{}` — reporting the same
			// missing option a second time here, positioned at whichever surface happens to mention
			// it, is noise for one mistake, which is the same reason the engine tracks
			// `globalFailed`.
			if (
				override.severity !== undefined &&
				override.severity !== "off" &&
				!globalIds.has(id)
			) {
				checkRuleOptions(
					doc,
					lineCounter,
					rule,
					undefined,
					["surfaces", index, "rules", id, "options"],
					["surfaces", index, "rules", id],
					optionProblems,
				);
			}
		}
	});
	if (optionProblems.length > 0) {
		throw new ConfigError(file, optionProblems);
	}

	// Canonical, not merely resolved: the `readFile(file, ...)` above already proved
	// `absRoot` exists (its own config file was just read out of it), so this cannot fail here.
	// See `ResolvedConfig.root`'s own doc comment for why.
	const rootReal = await realpath(absRoot);
	return {
		root: rootReal,
		origin: "config",
		// Built from `rootReal`, not the lexical `file` read above: see the matching comment on
		// the "detected" origin's `configFile` a few dozen lines up for why the two must share
		// the same canonical base.
		configFile: join(rootReal, CONFIG_FILENAME),
		// User-listed patterns always come first, then the always-on defaults, deduped —
		// listing your own patterns never disables walking node_modules/.git (see the
		// `ignore` field's JSDoc on ConfigSchema).
		ignore: Object.freeze([...new Set([...parsed.ignore, ...DEFAULT_IGNORE])]),
		surfaces: Object.freeze(surfaces.map(freezeSurface)),
		rules: sealMap(rules),
		ruleOptions: sealMap(ruleOptions),
		// A written config never runs auto-detection, so there is nothing it could have skipped.
		skippedCandidates: NO_SKIPPED_CANDIDATES,
	};
}
