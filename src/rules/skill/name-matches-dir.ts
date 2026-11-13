import { posix } from "node:path";
import { isMap } from "yaml";
import { DOCS_URL } from "../../diagnostic.js";
import { mergeContracts, SKILL_ENTRY_FILENAME } from "../../dialects.js";
import type { Document } from "../../document.js";
import { type FileRule, freezeRule, type RuleReport } from "../../rule.js";
import { readStringField } from "../frontmatter.js";

/**
 * Frontmatter `name` must equal the basename of the directory holding the `SKILL.md`.
 *
 * Whether that is a defect at all is the dialect's call, read from
 * `mergeContracts(...).nameMatchesDir` (dialects.ts) rather than assumed:
 *
 * - `must` (generic, codex, cursor skills, opencode) — the vendor documents it as a
 *   requirement: the tool resolves the skill by directory, so a mismatched `name` is either
 *   dead metadata or a rename someone only half finished.
 * - `should` (copilot skills) — documented as what the name "typically" is, with no stated
 *   enforcement. Checked all the same, because a linter that silently drops the check gives a
 *   repo no way to hold the convention; a surface that genuinely does not want it turns the
 *   rule down to `warn` or `off` per surface, which is the escape hatch the nuance deserves.
 * - `decoupled` (claude-code, and every non-`skills` contract) — reports nothing. Claude Code's
 *   `name` "sets only the display label shown in skill listings, and the command still comes
 *   from the directory name", so a mismatch is not a defect but the documented design. A repo
 *   that wants spec-uniform names lists `generic` alongside `claude-code` on the surface, and
 *   the merge's strongest-coupling-wins polarity turns this check back on.
 *
 * Only `SKILL.md` itself is checked. A supporting file inside a skill directory
 * (`reference.md`, and any other file a surface's `include` happens to pull in) carries no
 * name↔directory contract of its own.
 *
 * Comparison is exact string equality, with no Unicode normalization: every dialect that
 * couples the two also constrains `name` to strict ASCII (dialects.ts's `SKILL_NAME_PATTERN`),
 * so a name that would need normalizing to match a decomposed directory basename is already a
 * `frontmatter-schema` violation on its own. A missing, empty or non-string `name` is likewise
 * left alone — `skill/frontmatter-schema` owns those, and a second diagnostic about the same
 * key would say nothing new.
 */
export const nameMatchesDir: FileRule = freezeRule({
	kind: "file",
	meta: {
		id: "skill/name-matches-dir",
		description:
			"A skill whose `name` differs from its folder name, in formats that require them to match.",
		docsUrl: DOCS_URL,
		tiers: ["recommended", "strict"],
		defaultSeverity: "error",
		fixable: false,
	},
	check(doc: Document): RuleReport[] {
		if (posix.basename(doc.path) !== SKILL_ENTRY_FILENAME) {
			return [];
		}

		// No gate on `doc.surface.kind` here: a contract is per (dialect, kind), so
		// `nameMatchesDir` already IS this kind's own answer, and a future kind whose contract
		// said `must` would be stating a constraint worth enforcing rather than producing noise.
		// This rule infers nothing beyond what the contract states.
		//
		// `undefined` only on the defensive path `mergeContracts` documents (no listed dialect
		// defines a contract for the surface's kind) — unreachable through `loadConfig` or the
		// RuleTester, both of which reject such a surface first. Treated as "no coupling
		// documented", the same as `decoupled`: with no contract there is no claim to enforce.
		const merged = mergeContracts(doc.surface.dialects, doc.surface.kind);
		if (merged === undefined || merged.nameMatchesDir === "decoupled") {
			return [];
		}

		const fm = doc.frontmatter;
		if (fm === null) {
			return [];
		}
		// The same ownership claim `activation/consistent-scope` makes, and the same kind of
		// short-circuit: frontmatter present but not a mapping (a bare scalar, a list, an empty
		// block) is `skill/frontmatter-schema`'s to report, and a second diagnostic would say
		// nothing new. It changes no answer — `readStringField` reads a non-mapping as "no `name`
		// key" and the next branch returns anyway (measured: the suite stays green without these
		// lines) — and is written out so the silence is a decision with a test behind it rather than
		// an accident of how `collectScalarPairs` treats a non-mapping.
		if (!isMap(fm.doc.contents)) {
			return [];
		}
		const name = readStringField(fm, "name");
		if (name === undefined) {
			return [];
		}

		// Always the immediate parent, whatever it happens to be — and from `doc.path`
		// (repo-relative, posix, the contract every reporter already uses), never from
		// `doc.absPath`. The two only differ for a `SKILL.md` sitting directly at the repo root,
		// where the repo-relative parent is `"."` while the absolute one is the checkout
		// directory's own name: reading `absPath` would make the expected value depend on where
		// the repo lives on disk. That degenerate layout reports rather than being skipped — no
		// dialect that couples name to directory documents it (they all specify
		// `<name>/SKILL.md`) — and both spellings are pinned by test.
		const dir = posix.basename(posix.dirname(doc.path));
		if (name.value === dir) {
			return [];
		}
		return [
			{
				message: `Frontmatter key "name" must match the directory name "${dir}" (found "${name.value}")`,
				loc: name.loc,
			},
		];
	},
});
