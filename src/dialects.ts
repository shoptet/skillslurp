/**
 * Dialect data.
 *
 * A dialect is a per-tool frontmatter *contract*, expressed as data rather than code: which
 * keys a tool documents, which of them it demands, how it couples a skill's `name` to its
 * directory, and which key (if any) drives activation. Rules read these contracts; nothing in
 * here executes a check. Keeping it declarative is what lets a user add a dialect in config
 * later without shipping code.
 *
 * Every contract below is annotated with the vendor documentation it came from and the date it
 * was fetched. Where a detail is *not* documented, the contract stays permissive — the field is
 * omitted rather than guessed — and says so. A linter that invents a constraint produces false
 * positives on valid input, which is worse than missing a violation. That principle applies to
 * `required` exactly as much as to `allowed`: see the `copilot` instructions contract, where two
 * vendors document the same file differently.
 *
 * ## Merging a multi-dialect surface
 *
 * A surface may list several dialects (`dialects: [claude-code, generic]`), meaning "this file
 * has to work in all of these tools". `mergeContractList`/`mergeContracts` at the bottom of this
 * file do the merging, and the polarity per field is decided *here*, as data, so the rules that
 * consume a merged contract cannot quietly reach different answers:
 *
 * | field                  | merge                | rationale                                     |
 * | ---------------------- | -------------------- | --------------------------------------------- |
 * | `required`             | union                | a key any tool demands must be present         |
 * | `allowed`              | union                | see the asymmetry note below                   |
 * | `name`                 | all patterns apply   | violating any tool's charset breaks that tool  |
 * | `maxLengths`           | min per key          | the tightest documented cap wins               |
 * | `nameMatchesDir`       | `must` > `should` > `decoupled` | the strongest coupling wins         |
 * | `frontmatter`          | optional only if all | one tool that needs the block drops the file  |
 * | `activation`           | NOT merged           | kept per dialect; `consistent-scope` compares them |
 * | `toolUnknownKeyPolicy` | NOT merged           | informational, per dialect                     |
 * | `include`              | NOT merged here      | `defaultInclude` takes the sorted union        |
 * | `location`             | NOT merged           | read per dialect, by `readerAt`                |
 *
 * The asymmetry between `required` (union = stricter) and `allowed` (union = looser) is
 * deliberate, and the reasoning is spelled out here rather than cited, because this polarity is
 * what all three consuming rules are built on and it needs to stand on its own.
 *
 * The two fields answer different questions about "this file has to work in all of these tools".
 * `required` asks *will some tool reject this file for a missing key?* — one tool demanding a key
 * is enough to break the file, so the union is the only honest answer; an intersection would
 * silently drop a key that is genuinely mandatory somewhere. `allowed` asks *is this key a
 * mistake?* — and a key one tool documents while another merely ignores is not a mistake, so the
 * union again; an intersection would flag keys on a file that works everywhere the surface
 * claims, which is a false positive on valid input. Same operator, opposite reasons, and that is
 * why the two lines of the table above look redundant and are not.
 *
 * The exception worth knowing about, accepted rather than special-cased: a surface pairing
 * `generic` (which genuinely rejects unknown keys) with a superset dialect loses that rejection.
 */

/**
 * Surface kinds skillslurp models. There is no `commands` kind: both Claude Code and
 * Cursor have folded commands into skills (`.claude/commands/*.md` "support the same
 * frontmatter, except `name` and `paths`" — code.claude.com/docs/en/skills, fetched
 * 2026-09-01), so a separate kind would carry no distinct contract today. Deferred until a
 * tool documents one.
 */
export type SurfaceKind = "skills" | "rules" | "instructions";

export const SURFACE_KINDS: readonly SurfaceKind[] = Object.freeze([
	"skills",
	"rules",
	"instructions",
] as const);

/**
 * The entry-point file of a skill directory, for every dialect that speaks the `skills` kind —
 * the spec's own name for it, and the one both every skills contract's `include` below and the
 * `skill/*` rules that only apply to a skill's entry point (`name-matches-dir`) read, so the two
 * cannot disagree about which file that is. Compared case-sensitively, matching the glob.
 */
export const SKILL_ENTRY_FILENAME = "SKILL.md";

/**
 * The extension of a Cursor rule file. The `cursor` rules contract builds both its `include` and
 * its `location` from it, so that which files Cursor selects and which name a link in
 * `.cursor/rules` has to carry cannot disagree. Compared case-sensitively, matching the glob.
 */
export const CURSOR_RULE_EXTENSION = ".mdc";

export type DialectId =
	| "claude-code"
	| "codex"
	| "copilot"
	| "cursor"
	| "generic"
	| "opencode";

/**
 * How a dialect writes a multi-value activation key, and therefore how a consumer must split
 * it before comparing:
 *
 * - `comma-scalar` — one bare or quoted scalar holding comma-separated patterns
 *   (`globs: docs/**\/*.md, docs/**\/*.mdx`, `applyTo: "**\/*.ts,**\/*.tsx"`). Split on `,`,
 *   trim each part. Which shapes a tool does not activate on at all is
 *   `ActivationKey.nonActivatingShapes`, not a splitter.
 * - `list-or-string` — either a YAML sequence or a comma-separated scalar; the tool accepts
 *   both (`paths`, in Claude Code and Cursor alike). Normalize to a list.
 */
export type ActivationSplitter = "comma-scalar" | "list-or-string";

/**
 * How an activation value is written, named by the YAML node at the key: `flow-sequence` is a
 * sequence in brackets (`globs: [a, b]`, on one line or several), as opposed to a block sequence
 * (`globs:` then `- a` lines) or a scalar. Only shapes some contract lists in
 * `ActivationKey.nonActivatingShapes` are named here.
 */
export type ActivationValueShape = "flow-sequence";

export interface ActivationKey {
	/** frontmatter key name, verbatim */
	readonly key: string;
	readonly splitter: ActivationSplitter;
	/**
	 * Shapes of `key`'s value (never of a `legacyKeys` entry's) under which the tool does not
	 * activate the document, though YAML reads the value as patterns. Set only from a vendor
	 * statement or a dated hand check that names the tool version and the method. Omitted (never
	 * `[]`) where neither exists, which is every built-in but `cursor`'s rules contract. Omitted
	 * means nothing is known, not that every shape activates. Kept apart from `splitter` because
	 * `comma-scalar` is also `copilot`'s `applyTo`, whose shapes nobody has checked. Read by
	 * `activation/value-shape` only.
	 */
	readonly nonActivatingShapes?: readonly ActivationValueShape[];
	/**
	 * Superseded key names the tool still honours **when `key` itself is absent**, in the
	 * vendor's own precedence order (first entry consulted first). Omitted for a dialect that
	 * documents no such fallback — which is every built-in but `cursor`'s skills contract, where
	 * the vendor writes: "The legacy `globs` field is still accepted as a fallback for older
	 * skills, but new skills should use `paths`." (cursor.com/docs/context/skills, fetched
	 * 2026-09-03). The `paths` value shape itself is quoted from the sibling help page — see
	 * omission 2 below, and the `cursor` contract further down, which cite it the same way.
	 *
	 * Two deliberate omissions, both of which would otherwise be guesses:
	 *
	 * 1. **Precedence is read off the vendor's own word, not invented.** "Fallback" is Cursor's
	 *    term, and a fallback by definition applies when the primary is absent — so `key` beats
	 *    every entry here, and a legacy key is consulted only when `key` is not present at all.
	 *    That is the same class of prose interpretation this module already makes for `copilot`
	 *    skills, whose `name` "typically" matches the directory and is therefore encoded as
	 *    `should` rather than `must`. What Cursor does NOT state anywhere is which key wins when
	 *    BOTH are present; under this reading the question never arises, because the legacy key
	 *    is simply never read when the primary is there.
	 * 2. **A legacy key carries no splitter, on purpose.** Cursor documents a value shape for
	 *    skills-`paths` — verbatim, "`paths` accepts a list or a comma-separated string of glob
	 *    patterns." (cursor.com/help/customization/skills, fetched 2026-09-03) — but states none
	 *    for skills-`globs`, on either page that covers skills: the help page names `globs` only
	 *    where it lists which Cursor *rules* migrate into skills, never as a skills frontmatter
	 *    key, and cursor.com/docs/context/skills (same date) names it only in the fallback
	 *    sentence quoted above. This module's standing principle is to omit an undocumented
	 *    detail rather than guess it. `activation/consistent-scope` is built so that
	 *    it never needs one: when the primary key is present every dialect reads the primary and
	 *    the legacy key is irrelevant, and when only a legacy key is present, "present and
	 *    non-empty" is already enough to prove the divergence without parsing the value. A
	 *    future rule that genuinely has to parse a legacy key's value has to fetch a source
	 *    first and add the field then.
	 */
	readonly legacyKeys?: readonly string[];
}

/**
 * How strictly a tool ties frontmatter `name` to the containing directory's basename:
 * `must` (documented as a requirement) · `should` (documented as "typically", so a
 * mismatch is suspicious rather than broken) · `decoupled` (the tool derives the invocation
 * name from the directory and treats `name` as something else entirely, or has no `name` key).
 */
export type NameDirCoupling = "must" | "should" | "decoupled";

/** The charset rule for `name`. Length caps live in `maxLengths`, so there is one home for them. */
export interface NameConstraints {
	readonly pattern: RegExp;
	/** human-readable form of `pattern`, for the diagnostic message */
	readonly patternDescription: string;
}

/**
 * What the *tool* does with a frontmatter key it does not recognize. Informational only:
 * skillslurp flags unknown keys for every dialect regardless, because catching `descrption:` is
 * the whole point of the check. Recorded so a future rule (or a `--explain`) can say "Claude
 * Code ignores this, but the Skills API rejects it".
 *
 * Only two values, both of which a vendor states in so many words. Most tools say nothing about
 * unknown keys, and the field is simply omitted for those rather than filled with a guess.
 */
export type UnknownKeyPolicy = "error" | "ignore";

/**
 * Where a tool reads a kind of document in a project, and under which extension: a directory of
 * per-file links there has to name each link with `extension`, whatever the hub calls the file it
 * points at. `path` is repo-relative and posix-separated, compared with a declared spoke's
 * normalized path as a whole, never as a suffix.
 */
export interface ReaderLocation {
	readonly path: string;
	readonly extension: string;
}

/**
 * Whether a tool reads a document of a kind that carries no frontmatter block: `optional` (it
 * does, with no keys set) or `required` (the document is ignored or invalid without one).
 */
export type FrontmatterPresence = "optional" | "required";

export interface FrontmatterContract {
	/**
	 * Patterns, relative to the surface root, selecting the files the tool reads as a document of
	 * this kind: the file layout, kept beside the keys that describe what is inside the file.
	 * What a surface that spells out no `include` falls back to — see `defaultInclude`.
	 */
	readonly include: readonly string[];
	/**
	 * The one place the tool reads this kind of document in a project, when the vendor documents
	 * both the place and the extension. Omitted for every contract whose vendor documents no
	 * such place, which today is every contract but `cursor`'s rules. Where it and `include` are
	 * both set, `include` is `**\/*` plus `location.extension` (asserted in dialects.test.ts).
	 */
	readonly location?: ReaderLocation;
	/** keys the tool demands; always a subset of `allowed` (asserted in dialects.test.ts) */
	readonly required: readonly string[];
	/** every documented key, required ones included */
	readonly allowed: readonly string[];
	readonly nameMatchesDir: NameDirCoupling;
	/** omitted means `required`: only a vendor statement that the block may be absent earns `optional` */
	readonly frontmatter?: FrontmatterPresence;
	/** omitted when the dialect places no charset constraint on `name` */
	readonly name?: NameConstraints;
	/**
	 * Documented maximum value length, per frontmatter key. A key absent from this map has no
	 * documented cap and must not be length-checked.
	 */
	readonly maxLengths?: Readonly<Record<string, number>>;
	/** omitted when the dialect has no activation key (the skill is always eligible) */
	readonly activation?: ActivationKey;
	/** omitted when the vendor documents no unknown-key behaviour */
	readonly toolUnknownKeyPolicy?: UnknownKeyPolicy;
}

export interface Dialect {
	readonly id: DialectId;
	/** one contract per surface kind the dialect actually defines; missing kind = not supported */
	readonly contracts: Readonly<
		Partial<Record<SurfaceKind, FrontmatterContract>>
	>;
}

/**
 * Strict ASCII: lowercase letters and digits in single-hyphen-separated segments, so no
 * leading, trailing, or consecutive hyphens. Matches the prose of the Agent Skills spec and
 * OpenCode's documented regex verbatim.
 *
 * Deliberate divergence: the spec's own reference validator accepts
 * Unicode letters, contradicting its prose. We encode the prose. A side effect worth having:
 * with an ASCII-only name, `name-matches-dir` never needs Unicode normalization to compare a
 * name against a directory basename.
 *
 * Linear-time despite the nested quantifier: an iteration of `(-[a-z0-9]+)*` can only start at
 * `-`, which `[a-z0-9]` cannot match, so no input has an ambiguous decomposition to backtrack
 * over. Shared across dialects and never given the `g` flag, so `test()` is stateless and this
 * single instance is safe to reuse.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ASCII_NAME: NameConstraints = {
	pattern: SKILL_NAME_PATTERN,
	patternDescription:
		"lowercase letters, digits and single hyphens, with no leading, trailing or consecutive hyphens",
};

/** Every skills contract's `include`: a skill is a directory, and its entry point is the file. */
const SKILLS_INCLUDE: readonly string[] = [`**/${SKILL_ENTRY_FILENAME}`];

/** The spec's closed six-key set, in spec order. */
const SPEC_KEYS: readonly string[] = [
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
];

/** The spec's documented caps: name ≤64, description ≤1024, compatibility ≤500. */
const SPEC_MAX_LENGTHS: Readonly<Record<string, number>> = {
	name: 64,
	description: 1024,
	compatibility: 500,
};

/**
 * `generic` — the agentskills.io Agent Skills spec itself: the tool-agnostic baseline and the
 * default dialect for a surface that does not name one.
 *
 * The key set is genuinely closed. The strict distribution paths (claude.ai skill uploads, the
 * Skills API, `package_skill.py`) reject anything else outright with
 * `Unexpected key(s) in SKILL.md frontmatter: … Allowed properties are: allowed-tools,
 * compatibility, description, license, metadata, name` — hence `toolUnknownKeyPolicy: "error"`,
 * the only dialect that earns it.
 *
 * Sources (fetched 2026-09-01): code.claude.com/docs/en/skills § "Using skill frontmatter
 * outside Claude Code" (quotes the error and the six-field table); the spec's own field rules
 * (name ≤64 matching the parent directory, description ≤1024 non-empty, compatibility ≤500).
 */
const generic: Dialect = {
	id: "generic",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
			required: ["name", "description"],
			allowed: SPEC_KEYS,
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: SPEC_MAX_LENGTHS,
			toolUnknownKeyPolicy: "error",
		},
	},
};

/**
 * `claude-code` — Claude Code's superset of the spec: the six spec fields plus fourteen
 * Claude Code extensions, and *every one of them optional*.
 *
 * Two consequences worth spelling out, both verified against
 * code.claude.com/docs/en/skills § "Frontmatter reference" (fetched 2026-09-01):
 *
 * 1. `name` is `decoupled`. "In a personal or project skill, `name` sets only the display
 *    label shown in skill listings, and the command still comes from the directory name."
 *    A mismatch is not a defect here, so `name-matches-dir` reports nothing for this dialect.
 * 2. No charset constraint on `name`. The docs impose no charset rule on a display label, and
 *    plugin skills legitimately carry a colon (`name: my-plugin:fancy` is a documented,
 *    supported value). Applying the strict ASCII pattern here would flag valid frontmatter.
 *    A repo that wants spec-uniform names lists `generic` alongside `claude-code` on the
 *    surface — per the merge table in the module header, `generic`'s charset rule and its
 *    `must` coupling then both apply.
 *
 * There is no `version` key — an earlier placeholder allowed-set was wrong about that, and
 * `version` is now unknown for every built-in dialect.
 *
 * `description` has no cap: the documented 1,536 characters is where the *skill listing*
 * truncates `description` + `when_to_use` combined (and it is itself configurable via
 * `skillListingMaxDescChars`), not a validation limit. The post-v1 token-budget rule owns that,
 * not `frontmatter-schema`. `compatibility` does have one — "Accepts a string of up to 500
 * characters" — inherited from the spec.
 *
 * Everything above is about the `skills` contract. **rules** (`.claude/rules/`,
 * code.claude.com/docs/en/memory, fetched 2026-10-01) is a second one, with `paths` as the only
 * key a rule file can carry. The page documents no `name` key for a rule, so `name` is neither
 * allowed nor constrained, and what a pattern in `paths` is relative to inside a nested rules
 * directory is left unencoded: every example on the page sits at the project root.
 */
const claudeCode: Dialect = {
	id: "claude-code",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
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
			// code.claude.com/docs/en/skills § Frontmatter reference, fetched 2026-10-02, verbatim:
			// "All fields are optional." and "Claude Code reads the frontmatter only when the opening
			// `---` is the file's first line. Otherwise it treats the whole file, `---` markers
			// included, as skill content."
			frontmatter: "optional",
			maxLengths: { compatibility: 500 },
			// `paths`: "Glob patterns that limit when this skill is activated. Accepts a
			// comma-separated string or a YAML list."
			activation: { key: "paths", splitter: "list-or-string" },
			// The docs never state what Claude Code does with an unrecognized key, only what the
			// *other* distribution paths do (see `generic`). Left unset rather than guessed.
		},
		rules: {
			// code.claude.com/docs/en/memory § Set up rules, fetched 2026-10-01, verbatim: "All `.md`
			// files are discovered recursively, so you can organize rules into subdirectories like
			// `frontend/` or `backend/`"
			include: ["**/*.md"],
			// Same page, § Rule frontmatter reference, same date, verbatim: "`paths` | No | Glob
			// patterns that scope the rule to matching files. Accepts a YAML list or a
			// comma-separated string" — optional, so nothing is required.
			required: [],
			allowed: ["paths"],
			nameMatchesDir: "decoupled",
			// Same page, § Set up rules, fetched 2026-10-02, verbatim: "Rules without `paths`
			// frontmatter are loaded at launch with the same priority as `.claude/CLAUDE.md`."
			frontmatter: "optional",
			activation: { key: "paths", splitter: "list-or-string" },
			// Same section, same date, verbatim: "`paths` is the only field Claude Code reads from a
			// rule; any other field is ignored without an error."
			toolUnknownKeyPolicy: "ignore",
		},
	},
};

/**
 * `cursor` — two contracts, because Cursor reads two different file shapes.
 *
 * **skills** (`.cursor/skills/<name>/SKILL.md`, cursor.com/docs/context/skills, fetched
 * 2026-09-01): `name` and `description` required, `name` "lowercase letters, numbers, and
 * hyphens only. Must match the parent folder name" with no documented maximum. Cursor's own
 * activation key is `paths`: "`paths` accepts a list or a comma-separated string of glob
 * patterns." (cursor.com/help/customization/skills, re-fetched 2026-09-03) — the same key and
 * shape Claude Code uses. That sibling page is the one this module quotes for the shape, here and
 * on `ActivationKey.legacyKeys`; `docs/context/skills` states the same shape in its own, shorter
 * words (see the inline note on the `activation` block below).
 * `globs` stays in the allowed set: it is documented as still accepted as a fallback for older
 * skills, and flagging a key the tool honors would be a false positive. Nudging users off it is
 * a deprecation rule's job, not this one's — but it IS recorded as a `legacyKeys` fallback on
 * the activation key (re-fetched 2026-09-03, see below), because a skill that sets only `globs`
 * is path-scoped in Cursor and unscoped in every other tool on the same surface, which is
 * exactly the divergence `activation/consistent-scope` exists to catch.
 *
 * **rules** (`.cursor/rules/*.mdc`, https://cursor.com/docs/rules, fetched 2026-10-01; the page
 * this module first cited, cursor.com/docs/context/rules, now redirects there): three optional
 * keys, no `name` key at all, and `globs` written as bare comma-separated patterns
 * (`globs: docs/**\/*.md, docs/**\/*.mdx`) rather than a YAML list — hence `comma-scalar`, from
 * "Use `globs` to scope a rule to specific files or directories. Separate multiple patterns with
 * commas." The extension is part of the contract, verbatim: "Project rules must use the `.mdc`
 * extension. A plain `.md` file in `.cursor/rules` is ignored by the rules system because it has
 * no frontmatter to specify `description`, `globs`, and `alwaysApply`." — which is the `include`.
 *
 * The same page says where the rules are read, verbatim: "Project rules live in `.cursor/rules`
 * as `.mdc` files and are version-controlled." and "Each rule is an `.mdc` file that you can name
 * anything you want." That is the `location`: `.cursor/rules`, under `.mdc`. A link there that
 * points at a differently named hub file has to carry the `.mdc` name, since the vendor says a
 * plain `.md` file in that directory is ignored.
 *
 * NOT documented by the vendor, verified by hand in Cursor: on 2026-10-01 (Cursor
 * version not recorded) `.cursor/rules/rule.mdc`, a symlink to the hub file
 * `.agents/rules/rule.md`, loads; on 2026-10-05 (Cursor version not recorded) a real
 * `.cursor/rules/<sub>/` directory of such per-file `.mdc` links loads; and on 2026-10-19, with
 * Cursor 3.25.9 on macOS, such per-file links one and two real subfolders deep attach their rules
 * (method: a throwaway repository whose rules each carried a random token, and a new Agent chat
 * that read the probe files through its tool and listed the tokens it had). Neither Cursor page
 * says anything about symlinks, so a link to a directory was not checked, and nothing here rests
 * on it.
 *
 * Also NOT documented by the vendor, verified by hand in Cursor 3.25.9 on macOS on
 * 2026-10-19: a rule whose `globs` is a YAML flow sequence is not attached. Method: a throwaway
 * repository with one `.mdc` rule per shape in `.cursor/rules`, each with `alwaysApply: false` and
 * no `description`, scoped to a probe file of its own and carrying a random token; a new Agent chat
 * read the probe files through its tool and listed the tokens. The controls held: an
 * `alwaysApply: true` rule and the documented shapes attached, and the rule for a probe file not
 * read did not. `globs: ["probe/s2.ts"]` and `globs: [probe/s3.ts]` did not attach, each confirmed
 * alone, hence `nonActivatingShapes`. The same day, in the same version and by the same method, a
 * flow sequence of two items (`globs: [probe/m1a.ts, probe/m1b.ts]`) and one written over several
 * lines (`globs: [`, then `  probe/m2.ts`, then `]`) did not attach either. Attached, so recorded
 * nowhere: a bare pattern, two patterns with and without a space after the comma, a single- or
 * double-quoted pattern, a quoted comma-separated pair, brace sets (`probe/b1.{ts,js}`),
 * `**\/a1.ts`, and a block sequence (`globs:` then `  - probe/s1.ts`), though Cursor Settings
 * lists that rule as "Apply Manually". Not tried: an empty `[]`, an anchored or tagged list, the
 * skills contract's `paths` and legacy `globs`, and Copilot's `applyTo` in any shape. The vendor
 * page (fetched 2026-10-19) still says only "Separate multiple patterns with commas."
 *
 * Neither page states what Cursor does with an unrecognized key, so `toolUnknownKeyPolicy` is
 * unset on both contracts.
 */
const cursor: Dialect = {
	id: "cursor",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
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
			// cursor.com/docs/context/skills, fetched 2026-09-03, verbatim: "The legacy `globs`
			// field is still accepted as a fallback for older skills, but new skills should use
			// `paths`." That page lists seven keys — `name`, `description`, `paths`,
			// `disable-model-invocation`, `icon`, `color`, `metadata` — with `globs` named only in
			// the fallback sentence above, which is the eighth entry in `allowed`.
			//
			// Both Cursor skills pages give `paths` the same shape, hence `list-or-string`, and the
			// two are quoted separately so neither wording is attributed to the wrong page:
			// `docs/context/skills` says "Accepts a comma-separated string or a list.", and
			// `help/customization/skills` (same date) says "`paths` accepts a list or a
			// comma-separated string of glob patterns." — the fuller sentence this module quotes
			// everywhere else. Neither documents a value shape for skills-`globs`, nor which key
			// wins when both are set; see `ActivationKey.legacyKeys` for how both gaps are left
			// unguessed rather than filled in.
			activation: {
				key: "paths",
				splitter: "list-or-string",
				legacyKeys: ["globs"],
			},
		},
		rules: {
			include: [`**/*${CURSOR_RULE_EXTENSION}`],
			location: { path: ".cursor/rules", extension: CURSOR_RULE_EXTENSION },
			required: [],
			allowed: ["description", "globs", "alwaysApply"],
			nameMatchesDir: "decoupled",
			// Checked 2026-10-19 on Cursor 3.25.9: see the contract's JSDoc above.
			activation: {
				key: "globs",
				splitter: "comma-scalar",
				nonActivatingShapes: ["flow-sequence"],
			},
		},
	},
};

/**
 * `copilot` — also two contracts.
 *
 * **skills** (`.github/skills/<name>/SKILL.md`,
 * docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills,
 * fetched 2026-09-01): `name` + `description` required, `license` and `allowed-tools`
 * optional. Coupling is `should`, not `must`: the docs say `name` "typically" matches the
 * directory name, which is a convention with no stated enforcement. No length limits are
 * documented for either field, so none are encoded.
 *
 * **instructions** (`.github/instructions/*.instructions.md`): one file shape, two consumers
 * documenting it differently, so the contract is their union in *both* directions.
 * docs.github.com (…/add-repository-instructions) lists `applyTo` as required plus an optional
 * `excludeAgent` (`"code-review"` or `"cloud-agent"`); VS Code
 * (code.visualstudio.com/docs/copilot/customization/custom-instructions) documents `name`,
 * `description` and `applyTo` for the same files, all three optional, and defines the
 * `applyTo`-absent case: "the instructions are not applied automatically, but you can still add
 * them manually to a chat request". Both fetched 2026-09-01.
 *
 * `applyTo` is therefore NOT required. A missing `applyTo` is a documented mode of a documented
 * vendor example, not a defect, and demanding it would be the invented constraint the module
 * header rules out. A repo that does want it can raise the bar with a per-surface rule option.
 * Its value, when present, is a quoted comma-separated glob string (`applyTo: "**\/*.ts,**\/*.tsx"`).
 */
const copilot: Dialect = {
	id: "copilot",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
			required: ["name", "description"],
			allowed: ["name", "description", "license", "allowed-tools"],
			nameMatchesDir: "should",
			name: ASCII_NAME,
		},
		instructions: {
			include: ["**/*.instructions.md"],
			required: [],
			allowed: ["applyTo", "excludeAgent", "name", "description"],
			nameMatchesDir: "decoupled",
			activation: { key: "applyTo", splitter: "comma-scalar" },
		},
	},
};

/**
 * `opencode` — the most precisely specified of the six, and the source of our name regex.
 *
 * opencode.ai/docs/skills (fetched 2026-09-01), verbatim: "Only these fields are recognized:
 * `name` (required), `description` (required), `license` (optional), `compatibility`
 * (optional), `metadata` (optional, string-to-string map). Unknown frontmatter fields are
 * ignored." `name` is 1–64 characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` and "must match the
 * directory name that contains `SKILL.md`"; `description` is 1–1024 characters. No cap is given
 * for `compatibility`, so unlike the spec none is encoded.
 *
 * Note the absence of `allowed-tools`: OpenCode recognizes five of the spec's six fields, so a
 * surface declaring both `opencode` and `generic` widens back to six by union.
 */
const opencode: Dialect = {
	id: "opencode",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
			required: ["name", "description"],
			allowed: ["name", "description", "license", "compatibility", "metadata"],
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: { name: 64, description: 1024 },
			toolUnknownKeyPolicy: "ignore",
		},
	},
};

/**
 * `codex` — spec-aligned by decision, because Codex's own docs stop early.
 *
 * learn.chatgpt.com/docs/build-skills (fetched 2026-09-01) states only that "The `SKILL.md`
 * file must include `name` and `description`" and says nothing about charset, length, or
 * unknown keys. Codex implements the Agent Skills standard, so the spec's constraints are the
 * documented answer for everything its own page omits — which
 * makes this contract identical to `generic` except for `toolUnknownKeyPolicy`. That one field
 * is left unset rather than copied: `generic`'s `"error"` is evidenced by the Skills API
 * rejection message, which says nothing about what the Codex CLI does with the same file.
 *
 * `agents/openai.yaml` — optional, sits inside the skill directory, configures UI metadata,
 * invocation policy and tool dependencies — is a separate file, not frontmatter. Not read for
 * the skills surface; deferred, not ruled out.
 */
const codex: Dialect = {
	id: "codex",
	contracts: {
		skills: {
			include: SKILLS_INCLUDE,
			required: ["name", "description"],
			allowed: SPEC_KEYS,
			nameMatchesDir: "must",
			name: ASCII_NAME,
			maxLengths: SPEC_MAX_LENGTHS,
		},
	},
};

/**
 * Recursively freezes plain objects and arrays so the shared dialect singletons cannot be
 * mutated by one rule and observed by another.
 *
 * `RegExp` instances are skipped: freezing one would make `lastIndex` unwritable, which is
 * harmless for the flag-less patterns here but would turn a future `g`-flagged pattern into a
 * runtime `TypeError` in strict mode.
 *
 * The `seen` set is not needed by the literals below (they are acyclic, though several objects
 * are shared by more than one contract). It is there because the module header promises
 * config-defined dialects later, and config-derived data can be cyclic — `config.ts` already
 * warns that yaml anchors make `ResolvedRule.options` unsafe to deep-walk without a visited set.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (typeof value !== "object" || value === null || value instanceof RegExp) {
		return value;
	}
	if (seen.has(value)) {
		return value;
	}
	seen.add(value);
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child, seen);
	}
	return Object.freeze(value);
}

export const BUILTIN_DIALECTS: Readonly<Record<DialectId, Dialect>> =
	deepFreeze({
		"claude-code": claudeCode,
		codex,
		copilot,
		cursor,
		generic,
		opencode,
	});

/** Sorted, so config error messages listing the valid ids are deterministic. */
export const BUILTIN_DIALECT_IDS: readonly DialectId[] = Object.freeze(
	(Object.keys(BUILTIN_DIALECTS) as DialectId[]).sort(),
);

export function isDialectId(id: string): id is DialectId {
	return Object.hasOwn(BUILTIN_DIALECTS, id);
}

/**
 * The built-in dialects that define a contract for `kind`, in `BUILTIN_DIALECT_IDS` order.
 * A surface is only checkable against a dialect that speaks its kind — listing `copilot` on a
 * rules surface says nothing, because Copilot defines no rules contract.
 */
export function dialectsSupportingKind(
	kind: SurfaceKind,
): readonly DialectId[] {
	return BUILTIN_DIALECT_IDS.filter(
		(id) => BUILTIN_DIALECTS[id].contracts[kind] !== undefined,
	);
}

/** A built-in contract's `location`, with the dialect that owns it and what it selects there. */
export interface Reader {
	readonly dialect: DialectId;
	readonly path: string;
	readonly extension: string;
	readonly include: readonly string[];
}

function readersOf(kind: SurfaceKind): readonly Reader[] {
	const readers: Reader[] = [];
	for (const id of BUILTIN_DIALECT_IDS) {
		const contract = BUILTIN_DIALECTS[id].contracts[kind];
		if (contract?.location !== undefined) {
			readers.push(
				Object.freeze({
					dialect: id,
					path: contract.location.path,
					extension: contract.location.extension,
					include: contract.include,
				}),
			);
		}
	}
	return Object.freeze(readers);
}

const READERS: Readonly<Record<SurfaceKind, readonly Reader[]>> = Object.freeze(
	{
		skills: readersOf("skills"),
		rules: readersOf("rules"),
		instructions: readersOf("instructions"),
	},
);

/**
 * The built-in dialect whose tool reads `kind` documents at exactly `path`, a declared spoke's
 * normalized repo-relative path; `undefined` for any other path, a nested look-alike
 * (`packages/web/.cursor/rules`) included, because no vendor documents one. Matched against the
 * kind only, so the same path on a surface of another kind is not a reader's place. Never
 * conditioned on which dialects a surface lists: a dialect list says what contract the content
 * meets, not where a tool reads it.
 */
export function readerAt(kind: SurfaceKind, path: string): Reader | undefined {
	return READERS[kind].find((reader) => reader.path === path);
}

/**
 * The `include` of a surface that spells out none: every pattern the listed dialects' `kind`
 * contracts select, deduped and sorted, so the same set of dialects gives the same patterns
 * whatever order a config lists them in (they show up in zero-config notices). A dialect with no
 * `kind` contract adds nothing, the same way `mergeContracts` skips it.
 *
 * Frozen, because the loader hands this array out as `surface.include` and one run's mutation
 * must not be seen by the next. Lives here, not in config.ts: both `loadConfig` (a written
 * surface with no `include:`) and `detectSurfaces` (a synthesized one) need it, and `detect.ts`
 * must not import anything from `config.ts` at runtime (see its module header) — a synchronous
 * cycle between the two crashed at import time once, and putting the shared data in this
 * dependency-free leaf module removes the cycle instead of legalizing it.
 */
export function defaultInclude(
	kind: SurfaceKind,
	dialects: readonly DialectId[],
): readonly string[] {
	const patterns = new Set<string>();
	for (const id of dialects) {
		for (const pattern of BUILTIN_DIALECTS[id].contracts[kind]?.include ?? []) {
			patterns.add(pattern);
		}
	}
	return Object.freeze([...patterns].sort());
}

/**
 * The `include` a surface of each kind gets when it also names no dialect: `defaultInclude` over
 * the dialect that kind defaults to (config.ts's `DEFAULT_DIALECTS`). No source module reads it
 * any more: `loadConfig`, detection, the run notices and the `RuleTester` ask `defaultInclude`
 * with the surface's real dialects. It stays for the test files that hand-build a surface and
 * pass it as `DEFAULT_INCLUDE.skills`, and is derived rather than written out so it cannot drift
 * from the contracts.
 */
export const DEFAULT_INCLUDE: Readonly<Record<SurfaceKind, readonly string[]>> =
	Object.freeze({
		skills: defaultInclude("skills", ["generic"]),
		rules: defaultInclude("rules", ["cursor"]),
		instructions: defaultInclude("instructions", ["copilot"]),
	});

/**
 * The outcome of merging every dialect in `ids` that defines a `kind` contract, per the polarity
 * table in this module's header. `skill/frontmatter-schema` reads `required`/`allowed`/
 * `names`/`maxLengths`; `skill/name-matches-dir` reads `nameMatchesDir`. That field is
 * merged here — one comparison — rather than left for `skill/name-matches-dir` to reopen this
 * module for.
 *
 * `activation` and `toolUnknownKeyPolicy` are deliberately absent: the header marks both "NOT
 * merged" (activation stays per-dialect because `activation/consistent-scope` compares dialects
 * against EACH OTHER, not against a blend of them; `toolUnknownKeyPolicy` is informational only).
 */
export interface MergedContract {
	/** union, deduped, first-seen order over `ids` then contract order */
	readonly required: readonly string[];
	/** union, deduped, same order rule as `required` */
	readonly allowed: readonly string[];
	/** the strongest documented coupling among the merged contracts: `must` > `should` > `decoupled` */
	readonly nameMatchesDir: NameDirCoupling;
	/** `optional` only when every merged contract says so; a contract that says nothing counts as `required` */
	readonly frontmatter: FrontmatterPresence;
	/** every distinct pattern, deduped by `pattern.source` + `pattern.flags`, first-seen order */
	readonly names: readonly NameConstraints[];
	/**
	 * Min per key, over only the dialects (among `ids`) that document a cap for that key. The
	 * non-obvious half: a dialect that documents NO cap for a key does not loosen another
	 * dialect's cap for it — omission is silence, not a wider limit — so the merged cap is the
	 * minimum over the dialects that document one, never over all of `ids`. A key absent from
	 * this map has no documented cap from any listed dialect.
	 */
	readonly maxLengths: Readonly<Record<string, number>>;
}

/** `must` beats `should` beats `decoupled` — the strongest documented coupling wins. */
const NAME_DIR_COUPLING_RANK: Readonly<Record<NameDirCoupling, number>> =
	Object.freeze({ decoupled: 0, should: 1, must: 2 });

/** First-seen order across the given lists, in the order the lists themselves are given. */
function unionInOrder(lists: readonly (readonly string[])[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (!seen.has(item)) {
				seen.add(item);
				out.push(item);
			}
		}
	}
	return out;
}

/**
 * Merges an already-resolved list of contracts, per the merge table in this module's header.
 *
 * Exported on its own, separate from `mergeContracts` below, because two of the six merge
 * polarities — `maxLengths`'s min-per-key and `names`'s all-patterns-apply — cannot be told apart
 * from their opposite (max-per-key, first-pattern-only) by any pair of REAL built-in dialects:
 * every built-in that constrains `name` shares the one `ASCII_NAME` object, so the merge always
 * collapses to a single pattern regardless of which polarity is implemented, and every pair of
 * built-ins that both document a cap for the same key document the identical number, so min and
 * max agree too. `mergeContracts` only ever hands this function real `BUILTIN_DIALECTS` entries,
 * which can never exercise the difference — a test has to inject synthetic contracts with
 * genuinely different `name` patterns or `maxLengths` values to pin either polarity, and this is
 * the function such a test calls directly. It is also where config-defined dialects
 * will plug in: they arrive already resolved as `FrontmatterContract`s, not as `DialectId`s
 * `mergeContracts`'s registry lookup could resolve.
 *
 * Returns `undefined` for an empty `contracts` list — the same defensive contract `mergeContracts`
 * documents for "no listed id defines a contract for the kind".
 */
export function mergeContractList(
	contracts: readonly FrontmatterContract[],
): MergedContract | undefined {
	if (contracts.length === 0) {
		return undefined;
	}

	const required = unionInOrder(contracts.map((c) => c.required));
	const allowed = unionInOrder(contracts.map((c) => c.allowed));

	let nameMatchesDir: NameDirCoupling = "decoupled";
	for (const contract of contracts) {
		if (
			NAME_DIR_COUPLING_RANK[contract.nameMatchesDir] >
			NAME_DIR_COUPLING_RANK[nameMatchesDir]
		) {
			nameMatchesDir = contract.nameMatchesDir;
		}
	}

	const frontmatter: FrontmatterPresence = contracts.every(
		(contract) => contract.frontmatter === "optional",
	)
		? "optional"
		: "required";

	const names: NameConstraints[] = [];
	const seenPatterns = new Set<string>();
	for (const contract of contracts) {
		const { name } = contract;
		if (!name) {
			continue;
		}
		const patternKey = JSON.stringify([
			name.pattern.source,
			name.pattern.flags,
		]);
		if (!seenPatterns.has(patternKey)) {
			seenPatterns.add(patternKey);
			names.push(name);
		}
	}

	// `Object.create(null)`, not `{}`: this record is keyed by frontmatter key names, which
	// config-defined dialects will eventually supply as untrusted data. A plain `{}`
	// makes `maxLengths["__proto__"] = n` a no-op that silently drops the entry instead of
	// writing it (the `__proto__` setter only accepts an object or `null`), and makes a read of
	// e.g. `maxLengths["toString"]` return `Object.prototype.toString` instead of `undefined`.
	// Both are moot with no prototype chain to intercept the write or answer the read.
	const maxLengths: Record<string, number> = Object.create(null);
	for (const contract of contracts) {
		if (!contract.maxLengths) {
			continue;
		}
		for (const [key, max] of Object.entries(contract.maxLengths)) {
			const current = maxLengths[key];
			if (current === undefined || max < current) {
				maxLengths[key] = max;
			}
		}
	}

	return deepFreeze({
		required,
		allowed,
		nameMatchesDir,
		frontmatter,
		names,
		maxLengths,
	});
}

/**
 * Merges every built-in dialect in `ids` that defines a contract for `kind`, per the merge table
 * in this module's header. A thin id → contract lookup in front of `mergeContractList`, which
 * does the actual merging.
 *
 * Returns `undefined` when none of `ids` defines a `kind` contract at all. This is a defensive
 * path, not one reachable through the CLI today: `loadConfig`'s own per-id-stage check and the
 * RuleTester's `buildSurface` both already reject a dialect with no contract for a surface's
 * kind before a `Document` carrying that combination can exist. Kept so a direct caller of this
 * function gets an honest `undefined` instead of a contract synthesized from zero sources.
 */
export function mergeContracts(
	ids: readonly DialectId[],
	kind: SurfaceKind,
): MergedContract | undefined {
	const contracts: FrontmatterContract[] = [];
	for (const id of ids) {
		const contract = BUILTIN_DIALECTS[id].contracts[kind];
		if (contract) {
			contracts.push(contract);
		}
	}
	return mergeContractList(contracts);
}
