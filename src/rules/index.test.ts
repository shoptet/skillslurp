import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { validateRegistry } from "../engine.js";
import type { Rule } from "../rule.js";
import { builtinRules } from "./index.js";

/**
 * Why this file exists: every other test in the suite runs against a registry it builds itself —
 * `FRONTMATTER_SCHEMA_ONLY` in config.test.ts, `fakeRule` stubs in engine.test.ts, a single rule
 * in each rule test — so nothing pinned `builtinRules` itself. A review measured the
 * consequence: deleting a rule from the registry, or blanking its `meta.tiers`, left the whole
 * suite green (474 pass, lint and tsc clean). A rule can only reach a user through this list and
 * its own tiers, so those two facts get asserted here, in one place, rather than depending on
 * some other test's fixtures happening to notice.
 */

/** Writes `content` as `skillslurp.json` into a fresh temp dir, then cleans it up. */
async function withConfig<T>(
	content: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "skillslurp-registry-"));
	try {
		await writeFile(join(dir, "skillslurp.json"), content, "utf8");
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const MINIMAL_CONFIG = '{"version":1,"surfaces":[{"root":".claude/skills"}]}\n';

test("the registry holds exactly the built-in rules, sorted by id", () => {
	// Spelled out, not derived: a rule that never made it into this list is invisible to every
	// user, and this assertion is what says so out loud.
	expect(builtinRules.map((rule) => rule.meta.id)).toEqual([
		"activation/consistent-scope",
		"activation/max-glob-share",
		"activation/no-unmatched-globs",
		"activation/value-shape",
		"docs/contract-sync",
		"file/defers-to",
		"file/max-lines",
		"hub/symlinks",
		"index/complete",
		"index/no-missing-targets",
		"links/resolve",
		"refs/no-dangling-paths",
		"refs/no-unreachable-files",
		"skill/dir-has-entry",
		"skill/frontmatter-schema",
		"skill/name-matches-dir",
	]);
});

/**
 * The test above spells the ids out; this one says the ORDER is a rule rather than a habit.
 *
 * It exists because `--list-rules` prints the registry in registry order and nothing
 * else sorts on the way out — `loadConfig` sorts its own resolved map and the engine sorts
 * diagnostics, so neither of them was ever load-bearing for this list. Until now the list being
 * alphabetical was a readability convention stated in a comment; a rule appended at the bottom
 * would have satisfied every existing assertion (they would simply be updated to match) and
 * silently made the listing unsorted. Deriving the expectation from the ids themselves is
 * deliberate: it keeps holding, unchanged, for the next rule and the one after that.
 *
 * `sort()`'s default UTF-16 comparator is the definition used, and it is the right one here —
 * every id is lowercase ASCII with `/` and `-`, so it agrees with what a reader means by
 * alphabetical, and it is the comparator a reader would apply by eye.
 */
test("builtinRules is sorted by id, so the --list-rules order is an invariant and not a coincidence", () => {
	const ids = builtinRules.map((rule) => rule.meta.id);

	// Guards against the assertion below being vacuously true on an empty or one-rule registry.
	expect(ids.length).toBeGreaterThan(1);
	expect(ids).toEqual([...ids].sort());
});

test("the registry is frozen, so one caller cannot add or drop a rule for the next", () => {
	expect(Object.isFrozen(builtinRules)).toBe(true);
	expect(() => {
		(builtinRules as Rule[]).push(builtinRules[0] as Rule);
	}).toThrow(TypeError);
});

/**
 * `Object.freeze(builtinRules)` above locks the ARRAY and nothing inside it. Before
 * `freezeRule`, every one of the six rule objects the registry then held, every `meta`, and
 * every `meta.tiers` was writable at runtime, and `tsc --noEmit` accepted
 * `builtinRules[0].meta.id = "x"` without a word. A rule is reused for every surface and every
 * document of a run, so one write to a shared `meta` reconfigures that rule for the rest of the
 * process — the same class of bug the `SURFACE_KINDS` and `DEFAULT_INCLUDE`/`DEFAULT_DIALECTS`
 * freezes were added for, twice.
 *
 * `freezeRule` (rule.ts) applies at each rule's own definition site; this asserts it actually
 * happened for every registered rule, so a new rule that forgets the call fails here rather
 * than shipping a writable singleton. `optionsSchema` is deliberately excluded — see
 * `freezeRule`.
 */
test("every registered rule, its meta and its tiers are frozen, not just the array holding them", () => {
	for (const rule of builtinRules) {
		expect({
			id: rule.meta.id,
			rule: Object.isFrozen(rule),
			meta: Object.isFrozen(rule.meta),
			tiers: Object.isFrozen(rule.meta.tiers),
		}).toEqual({
			id: rule.meta.id,
			rule: true,
			meta: true,
			tiers: true,
		});
	}
});

test("a write into a rule singleton throws rather than silently reconfiguring it", () => {
	const [first] = builtinRules;
	if (first === undefined) {
		throw new Error("builtinRules is empty");
	}
	const { id, defaultSeverity } = first.meta;
	const tiers = [...first.meta.tiers];

	expect(() => {
		(first.meta as { id: string }).id = "hijacked";
	}).toThrow(TypeError);
	expect(() => {
		(first.meta as { defaultSeverity: string }).defaultSeverity = "off";
	}).toThrow(TypeError);
	expect(() => {
		(first.meta.tiers as string[]).push("invented-tier");
	}).toThrow(TypeError);
	expect(() => {
		(first as { kind: string }).kind = "project";
	}).toThrow(TypeError);

	// Nothing above landed: the freeze rejected the writes rather than dropping them silently.
	expect(first.meta.id).toBe(id);
	expect(first.meta.defaultSeverity).toBe(defaultSeverity);
	expect(first.meta.tiers).toEqual(tiers);
	expect(first.kind).toBe("file");
});

test("the registry passes the engine's own validation", () => {
	// `loadConfig` and `runEngine` both call this on whatever they are handed; running it on the
	// real list here means a reserved-namespace or duplicate id in a built-in fails as its own
	// named test rather than as a confusing failure inside an unrelated one.
	expect([...validateRegistry(builtinRules)]).toEqual([
		"activation/consistent-scope",
		"activation/max-glob-share",
		"activation/no-unmatched-globs",
		"activation/value-shape",
		"docs/contract-sync",
		"file/defers-to",
		"file/max-lines",
		"hub/symlinks",
		"index/complete",
		"index/no-missing-targets",
		"links/resolve",
		"refs/no-dangling-paths",
		"refs/no-unreachable-files",
		"skill/dir-has-entry",
		"skill/frontmatter-schema",
		"skill/name-matches-dir",
	]);
});

/** Opt-in: no tier, so a preset must not enable them (see the two tests below). */
const OPT_IN_RULE_IDS = [
	"activation/max-glob-share",
	"docs/contract-sync",
	"file/defers-to",
	"index/complete",
	"index/no-missing-targets",
] as const;

test("extends: [recommended] enables every tiered rule and leaves the opt-in rules out", async () => {
	await withConfig(MINIMAL_CONFIG, async (dir) => {
		const resolved = await loadConfig(dir, builtinRules);

		// A default run — and, through the same
		// `resolveTierRules` helper, a zero-config auto-detected one — lints against exactly
		// these ids at exactly these severities.
		expect([...resolved.rules.entries()]).toEqual([
			["activation/consistent-scope", { severity: "error" }],
			["activation/no-unmatched-globs", { severity: "error" }],
			["activation/value-shape", { severity: "error" }],
			["file/max-lines", { severity: "warn" }],
			["hub/symlinks", { severity: "error" }],
			["links/resolve", { severity: "error" }],
			["refs/no-dangling-paths", { severity: "error" }],
			["refs/no-unreachable-files", { severity: "error" }],
			["skill/dir-has-entry", { severity: "error" }],
			["skill/frontmatter-schema", { severity: "error" }],
			["skill/name-matches-dir", { severity: "error" }],
		]);
		for (const id of OPT_IN_RULE_IDS) {
			expect(resolved.rules.has(id)).toBe(false);
		}
	});
});

test("extends: [strict] adds nothing yet, and still excludes the opt-in rules", async () => {
	// `strict` is a superset of `recommended` (config.ts's `TIER_IMPLIES`) and no built-in claims
	// `strict` alone today, so the two tiers resolve to the same set. Pinned so that the day one
	// does, the divergence shows up here rather than only in whichever fixture happens to trip.
	await withConfig(
		'{"version":1,"surfaces":[{"root":".claude/skills"}],"extends":["strict"]}\n',
		async (dir) => {
			const resolved = await loadConfig(dir, builtinRules);

			expect([...resolved.rules.keys()]).toEqual([
				"activation/consistent-scope",
				"activation/no-unmatched-globs",
				"activation/value-shape",
				"file/max-lines",
				"hub/symlinks",
				"links/resolve",
				"refs/no-dangling-paths",
				"refs/no-unreachable-files",
				"skill/dir-has-entry",
				"skill/frontmatter-schema",
				"skill/name-matches-dir",
			]);
			for (const id of OPT_IN_RULE_IDS) {
				expect(resolved.rules.has(id)).toBe(false);
			}
		},
	);
});
