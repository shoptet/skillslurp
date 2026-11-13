import type { Code, Nodes, Root } from "mdast";
import { parse } from "yaml";
import { z } from "zod";
import { DOCS_URL, type Loc, START_LOC } from "../../diagnostic.js";
import { mergeContracts } from "../../dialects.js";
import { locOfNode } from "../../links.js";
import {
	type ConfigReport,
	freezeRule,
	type ProjectRule,
	type Report,
	type RuleReport,
} from "../../rule.js";
import { loadConfiguredDocument } from "../configured-document.js";

/**
 * Same shape and same reasoning as `IndexOptionsSchema` (rules/index/shared.ts) — a required,
 * repo-root-relative posix path with no default — declared here rather than imported from there
 * so that this rule's own validation errors, and the JSDoc a user reads to understand them, stay
 * this rule's own. There is no contract document every surface would want, so a rule enabled with
 * no `options.file` is a config mistake worth stopping for (an absent `options:` block parses as
 * `{}`, which fails this schema and becomes a positioned `ConfigError`), and it is why this rule
 * claims no tier: a tier that pulled it in would make every default run exit 2. `min(1)`, so
 * `file: ""` is rejected too — an empty string is not a repo-root-relative path to anything.
 */
export const OptionsSchema = z.strictObject({
	file: z.string().min(1),
});
export type Options = z.infer<typeof OptionsSchema>;

/**
 * The info-string language that marks a fenced block as the contract block, matched EXACTLY.
 *
 * mdast splits a fence's info string on the first run of whitespace into `lang` + `meta`
 * (measured 2026-09-05 against this project's own processor, document.ts: ```` ```skillslurp-
 * contract title=x ```` yields `lang: "skillslurp-contract"`, `meta: "title=x"`), so a block that
 * carries extra info still matches while a merely similar language — `skillslurp-contract-ish` —
 * does not. `meta` is never read: what a doc generator writes after the language is its business.
 */
export const CONTRACT_BLOCK_LANG = "skillslurp-contract";

/** `config/missing-contract-block`: the configured document exists but declares no contract. */
const MISSING_BLOCK_PROBLEM = "missing-contract-block";

/** `config/invalid-contract-block`: a block is there, but its body is not a contract. */
const INVALID_BLOCK_PROBLEM = "invalid-contract-block";

/**
 * The block body. Strict, and both keys required — the same posture the config's own unknown-key
 * handling takes, for the same reason: a document that claims to state the contract states both
 * halves of it or it is not stating the contract. `allowed: [...]` alone is indistinguishable
 * from a document whose `required` list was lost in an edit, and silently reading the absent key
 * as `[]` would turn that edit into a pile of per-key drift violations pointing everywhere except
 * at the line that actually broke. A contract with nothing required says so, as `required: []`.
 *
 * Duplicates inside a list are NOT rejected here: they are tolerated on purpose (see `compare`).
 */
const KEY_LIST = z.array(z.string());
const BodySchema = z.strictObject({
	allowed: KEY_LIST,
	required: KEY_LIST,
});

/** Every `skillslurp-contract` fence in the document, in document order, at any nesting depth. */
function collectContractBlocks(root: Root): Code[] {
	const blocks: Code[] = [];
	const walk = (node: Nodes): void => {
		if (node.type === "code" && node.lang === CONTRACT_BLOCK_LANG) {
			blocks.push(node);
		}
		// A `code` node is a leaf and has no `children`, so this never descends into a block it
		// just collected; what it does reach is a fence nested in a list item or a blockquote,
		// which is an ordinary way to write one and has no business being invisible.
		if ("children" in node) {
			for (const child of node.children) {
				walk(child);
			}
		}
	};
	walk(root);
	return blocks;
}

type ParsedBlock =
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "parsed"; readonly body: z.infer<typeof BodySchema> };

/**
 * Parses one block body as YAML and validates it against `BodySchema`.
 *
 * `parse`, not `parseDocument`: the position this rule reports at is the BLOCK, never a line
 * inside it — the block body's yaml-local line numbers would have to be shifted by the fence line
 * to mean anything in the file, and a reader looking at a five-line block does not need a cursor —
 * so nothing here needs the source ranges `parseDocument` exists to retain. `prettyErrors: false` keeps the reason a plain single-line
 * string, `logLevel: "error"` stops yaml from printing warnings straight to stderr that no
 * reporter owns, and `maxAliasCount` bounds an alias bomb — the same three settings, for the same
 * three reasons, that `document.ts`'s `parseFrontmatter` already passes.
 */
function parseContractBlock(source: string): ParsedBlock {
	let data: unknown;
	try {
		data = parse(source, {
			prettyErrors: false,
			logLevel: "error",
			maxAliasCount: 100,
		});
	} catch (err) {
		return {
			kind: "invalid",
			reason: `is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const result = BodySchema.safeParse(data);
	if (result.success) {
		return { kind: "parsed", body: result.data };
	}
	// `path.join(".")` then `issue.message`, the same rendering the engine's own options backstop
	// gives a failed `optionsSchema` parse (`validateOptions`, engine.ts) — one convention for
	// "zod rejected a user-authored blob" rather than a second one invented here. Issue order is
	// zod's, which is deterministic for a given input, so the message is too.
	const rendered = result.error.issues
		.map((issue) => {
			const path = issue.path.join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
	return { kind: "invalid", reason: `is not a valid contract: ${rendered}` };
}

/**
 * One list — `allowed` or `required` — compared as a SET against the contract's own.
 *
 * Order-insensitive and duplicate-tolerant, both by construction rather than by a check: a `Set`
 * cannot see either. A repeated key is a doc-quality nit of exactly the kind this linter keeps
 * out of scope, and reporting one would mean this rule started having opinions about
 * how the document is written rather than about what it claims.
 *
 * The two lists are compared INDEPENDENTLY, which is the point of doing it twice rather than once
 * over a merged view: `allowed ⊇ required` is an invariant of `mergeContracts`, so a key the
 * document lists under `required` that the contract merely allows is a `required` mismatch even
 * though `allowed` agrees about it perfectly.
 */
function compare(
	list: "allowed" | "required",
	documented: readonly string[],
	contract: readonly string[],
	file: string,
	loc: Loc,
): RuleReport[] {
	const documentedSet = new Set(documented);
	const contractSet = new Set(contract);
	const verb = list === "allowed" ? "allow" : "require";
	const reports: RuleReport[] = [];

	// Deterministic without a sort, and deliberately so. A `Set` iterates in insertion order, so
	// omissions come out in the CONTRACT's order (which for `mergeContracts` is the merge's
	// first-seen order, itself the dialects' own spec order) and unknown keys in the DOCUMENT's
	// order — each the most meaningful order there is for that half, and both fixed for a fixed
	// input. An alphabetical `.sort()` would replace both with a third order that nothing can
	// observe anyway: every report here shares one file, one position and one rule id, and
	// `runEngine` re-sorts diagnostics by message before returning them, so no test could tell
	// such a sort from its absence — code whose only justification is an unobservable claim.
	for (const key of contractSet) {
		if (documentedSet.has(key)) {
			continue;
		}
		reports.push({
			message: `Contract block omits "${key}" from "${list}", but this surface's dialects ${verb} it`,
			file,
			loc,
		});
	}
	for (const key of documentedSet) {
		if (contractSet.has(key)) {
			continue;
		}
		reports.push({
			message: `Contract block lists "${key}" under "${list}", but this surface's dialects do not ${verb} it`,
			file,
			loc,
		});
	}
	return reports;
}

/**
 * A document that claims to document a surface's frontmatter contract must not drift from the
 * contract the linter actually enforces.
 *
 * The document is named by a required `file` option and holds one fenced code block whose info
 * string is `skillslurp-contract`; the block's body is YAML with an `allowed` and a `required`
 * key list. Chosen over a GFM table or prose for two reasons: a table needs `remark-gfm`, a
 * dependency `document.ts` does not have, and prose needs heuristic guessing at which token on a
 * line is a key name — this tool's checks are deterministic only.
 *
 * Opt-in only (`tiers: []`, `file` required — see `OptionsSchema`), written per surface:
 *
 * ```json
 * {
 *   "surfaces": [
 *     {
 *       "root": ".claude/skills",
 *       "dialects": ["claude-code", "generic"],
 *       "rules": {
 *         "docs/contract-sync": {
 *           "severity": "error",
 *           "options": { "file": "docs/frontmatter-contract.md" }
 *         }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * ## What it compares against, and what it deliberately does not
 *
 * `mergeContracts(ctx.surface.dialects, ctx.surface.kind)` — the union, so a surface declaring
 * two dialects is measured against both at once — and **nothing else**. In
 * particular it does NOT fold in `skill/frontmatter-schema`'s `allowed`/`required` options, which
 * a repo may set to extend or narrow what that rule enforces. Two reasons, and a user who has
 * extended the contract in config needs to know both: a rule cannot see another rule's options
 * (a `RuleContext` carries only its own), and this rule is opt-in, so nobody is enrolled into a
 * comparison they did not ask for. **The document is therefore expected to document the DIALECT
 * contract, not the repository's extension of it.** Wanting the effective contract instead — the
 * dialect merge with `skill/frontmatter-schema`'s options applied over it — is a real need and a
 * real design change (the engine would have to hand a rule some cross-rule view); it is recorded
 * as a finding rather than guessed at here.
 *
 * ## What gets reported
 *
 * Per-key violations at this rule's configured severity, positioned at the contract block:
 * a key the contract has that the document omits, and a key the document claims that the contract
 * does not have, for each of the two lists separately (see `compare`). Two or more contract blocks
 * in one file is one further violation, positioned at the SECOND block — the first is still
 * compared, since discarding it would report drift the author cannot see and hide drift they can.
 *
 * Three failures are NOT violations of this kind but `config/*` problems at `error`, whatever
 * severity this rule is configured at, because in each the CONFIGURATION is what is
 * wrong rather than the repository: the configured `file` naming nothing readable
 * (`config/missing-file`, against the config file — shared with `index/*` through
 * `loadConfiguredDocument`); a readable document with no contract block at all
 * (`config/missing-contract-block`, against the document); and a block whose body is not
 * parseable YAML or not a contract (`config/invalid-contract-block`, against the document, at the
 * block).
 */
export const docsContractSync: ProjectRule<Options> = freezeRule({
	kind: "project",
	meta: {
		id: "docs/contract-sync",
		description:
			"Key lists in a document's `skillslurp-contract` block that differ from the configured formats' required and allowed keys.",
		docsUrl: DOCS_URL,
		// Opt-in: `file` has no sensible default, so a tier claiming this rule would make an
		// unconfigured run exit 2. See `OptionsSchema`.
		tiers: [],
		defaultSeverity: "error",
		fixable: false,
		optionsSchema: OptionsSchema,
	},
	check: async (ctx) => {
		const loaded = await loadConfiguredDocument(ctx, "Contract");
		if (loaded.kind === "missing") {
			return [loaded.report];
		}
		const { path: docPath, doc } = loaded;

		const blocks = collectContractBlocks(doc.ast);
		const [firstBlock, secondBlock] = blocks;
		if (firstBlock === undefined) {
			const missing: ConfigReport = {
				problem: MISSING_BLOCK_PROBLEM,
				message: `Contract file "${docPath}" has no "${CONTRACT_BLOCK_LANG}" code block`,
				file: docPath,
				// The whole file is what is missing the block, so there is nothing more specific in
				// it to point at. Set explicitly rather than left to the engine's default, which is
				// `ctx.surface.loc` — a line in the CONFIG yaml, which would be a position from one
				// file attached to another the moment `file` is overridden as it is here.
				loc: START_LOC,
			};
			return [missing];
		}

		const reports: Report[] = [];
		if (secondBlock !== undefined) {
			reports.push({
				message: `Contract file "${docPath}" has more than one "${CONTRACT_BLOCK_LANG}" code block; there must be exactly one, and only the first is compared`,
				file: docPath,
				loc: locOfNode(secondBlock),
			});
		}

		const blockLoc = locOfNode(firstBlock);
		const parsed = parseContractBlock(firstBlock.value);
		if (parsed.kind === "invalid") {
			const invalid: ConfigReport = {
				problem: INVALID_BLOCK_PROBLEM,
				message: `Contract block in "${docPath}" ${parsed.reason}`,
				file: docPath,
				loc: blockLoc,
			};
			reports.push(invalid);
			return reports;
		}

		// `undefined` only on the defensive path `mergeContracts` documents — no listed dialect
		// defines a contract for this surface's kind at all, which `loadConfig` and `RuleTester`'s
		// `buildSurface` both reject before a run gets here. With no contract there is nothing to
		// compare the document against, so the document is not wrong; anything already collected
		// above (the two-block violation) still stands on its own.
		const merged = mergeContracts(ctx.surface.dialects, ctx.surface.kind);
		if (merged === undefined) {
			return reports;
		}

		reports.push(
			...compare(
				"allowed",
				parsed.body.allowed,
				merged.allowed,
				docPath,
				blockLoc,
			),
			...compare(
				"required",
				parsed.body.required,
				merged.required,
				docPath,
				blockLoc,
			),
		);
		return reports;
	},
});
