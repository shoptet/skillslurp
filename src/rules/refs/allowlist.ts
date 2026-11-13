/**
 * The config-level allowlist a `refs/*` scan rule takes, and the staleness guard every allowlist
 * this project ever grows must have: "an entry that no longer applies (name now exists on disk /
 * pattern matches nothing) is itself an error".
 *
 * Shared rather than written inline: `refs/no-dangling-paths` allowlists a path, and any
 * later rule that grows an allowlist gets the identical mechanism — "is this string allowlisted,
 * and did any allowlisted string turn out never to be needed" — rather than its own copy, which
 * could only drift in the one direction that matters (a staleness guard that silently stops
 * firing is indistinguishable from a clean repo).
 *
 * Not itself a rule — no `meta`, no `kind` — so it lives as a private sibling of the rule files
 * under `rules/refs/`, the same shape `rules/index/shared.ts` already has for the `index/*`
 * rules.
 */

import { z } from "zod";
import type { ConfigReport } from "../../rule.js";

/**
 * The `allowlist` option, ready to drop into a rule's own `z.strictObject`.
 *
 * Defaults on the FIELD, never on the schema as a whole (`RuleMeta.optionsSchema`'s own doc):
 * a rule enabled with no `options:` block is parsed as `{}`, so a top-level `.default(...)`
 * would never fire. `.default([])` is safe to share between two rules despite handing out an
 * array: zod 4 clones a non-function default on every parse rather than handing out one shared
 * instance (measured against zod 4.4.3, 2026-09-05 — two `parse({})` calls return arrays that
 * are not `===`), and the engine deep-freezes resolved options on top of that.
 *
 * `min(1)` per entry, so `allowlist: [""]` is rejected at config time rather than becoming an
 * entry that can never match and is therefore permanently stale.
 */
export const AllowlistSchema = z.array(z.string().min(1)).default([]);

/**
 * The `<problem>` half of the `config/<problem>` id a stale entry is reported under. Exported so
 * `refs/no-dangling-paths` — and any later rule that grows an allowlist — reports one mistake under
 * one id instead of inventing a second name for it, the same reason `MISSING_FILE_PROBLEM`
 * (rules/index/shared.ts) is exported.
 */
export const STALE_ALLOWLIST_PROBLEM = "stale-allowlist";

export interface AllowlistTracker {
	/**
	 * True when `value` is allowlisted, and marks the matching entry used.
	 *
	 * Call it ONLY for a value that would otherwise be reported. An allowlist entry exists to
	 * suppress a violation, so asking about a value that is not a violation in the first place
	 * would mark the entry used for a reason that has nothing to do with suppression — which is
	 * exactly the "name now exists on disk" half of the staleness guard, silently
	 * unenforced. `refs/no-dangling-paths` checks whether the candidate already resolves before
	 * it gets here for that reason.
	 */
	allows(value: string): boolean;
	/**
	 * One `ConfigReport` per distinct entry `allows` never matched, in the order the entries
	 * were written. Neither `file` nor `loc` is set, so the engine's own defaults apply: the
	 * run's config file, positioned at where this surface is written in the yaml — which is
	 * where the offending entry actually lives, and the one place the user can go and delete it.
	 *
	 * `error`, not the reporting rule's configured severity, and that is the whole reason this
	 * is a `ConfigReport` at all: a stale entry is itself an error unconditionally,
	 * and a rule turned down to `warn` would otherwise report its own staleness at `warn` too.
	 *
	 * `ruleId` goes in the message because the diagnostic's own id is `config/stale-allowlist`
	 * for every rule that has an allowlist — without it, a repo with two allowlists could not
	 * tell which one the dead entry is in.
	 */
	staleReports(ruleId: string): ConfigReport[];
}

/**
 * Builds a per-dispatch tracker over `entries`.
 *
 * Per dispatch, not per run, and deliberately so: a `project`/`scan` rule runs once per surface
 * it is enabled on, each with that surface's own options, so two surfaces that configure
 * two different allowlists get two independent trackers and two independent staleness verdicts.
 * A module-level or run-level tracker would let a surface that never even enabled the rule
 * "use up" another surface's entry.
 *
 * Duplicate entries collapse: `["a", "a"]` is one entry for both membership and staleness, so a
 * repo that wrote the same string twice gets one diagnostic, not two identical ones. Whether the
 * duplicate itself deserves a diagnostic is a config-validation question, not this function's.
 */
export function createAllowlistTracker(
	entries: readonly string[],
): AllowlistTracker {
	// Insertion order IS config order, and `Set` iteration preserves it — that is what makes
	// `staleReports` deterministic without a sort that would scramble the entries away from the
	// order the user reads them in.
	const distinct = new Set(entries);
	const unused = new Set(distinct);

	return Object.freeze({
		allows(value: string): boolean {
			if (!distinct.has(value)) {
				return false;
			}
			unused.delete(value);
			return true;
		},
		staleReports(ruleId: string): ConfigReport[] {
			const reports: ConfigReport[] = [];
			for (const entry of distinct) {
				if (unused.has(entry)) {
					reports.push({
						problem: STALE_ALLOWLIST_PROBLEM,
						message: `Rule "${ruleId}": allowlist entry "${entry}" matched nothing — remove it`,
					});
				}
			}
			return reports;
		},
	});
}
