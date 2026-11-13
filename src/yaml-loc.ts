import type { LineCounter } from "yaml";
import type { Loc } from "./diagnostic.js";

/**
 * Maps a yaml-source offset range (a yaml AST node's `range`, or a yaml error's `pos`) to
 * file coordinates. `lineOffset` is the yaml-local-to-file line shift: the frontmatter fence
 * line for `document.ts`, always `0` for a standalone config yaml file (`config.ts`).
 */
export function locFromOffsets(
	lineCounter: LineCounter,
	lineOffset: number,
	range: readonly [number, number] | readonly [number, number, number],
): Loc {
	const start = lineCounter.linePos(range[0]);
	const end = lineCounter.linePos(range[1]);
	return {
		line: start.line + lineOffset,
		col: start.col,
		endLine: end.line + lineOffset,
		endCol: end.col,
	};
}

const NESTED_MAPPING_MESSAGE =
	'A value contains an unquoted ": ", which YAML reads as the start of a nested mapping; wrap the whole value in quotes';

interface YamlErrorLike {
	readonly code: string;
	readonly message: string;
	readonly pos: readonly [number, number] | readonly [number, number, number];
}

function indexOfMappingColon(source: string, from: number): number {
	for (
		let i = source.indexOf(":", from);
		i !== -1;
		i = source.indexOf(":", i + 1)
	) {
		const next = source[i + 1];
		if (
			next === undefined ||
			next === " " ||
			next === "\t" ||
			next === "\r" ||
			next === "\n"
		) {
			return i;
		}
	}
	return -1;
}

function indexAfterQuoted(source: string, open: number): number {
	const quote = source[open];
	for (let i = open + 1; i < source.length; i++) {
		const ch = source[i];
		if (quote === '"' && ch === "\\") {
			i++;
		} else if (ch === quote) {
			if (quote === "'" && source[i + 1] === "'") {
				i++;
			} else {
				return i + 1;
			}
		}
	}
	return -1;
}

/** yaml puts BLOCK_AS_IMPLICIT_KEY at the start of the value, not at the colon that caused it. */
export function describeYamlError(
	source: string,
	err: YamlErrorLike,
	lineCounter: LineCounter,
	lineOffset: number,
): { message: string; loc: Loc } {
	if (err.code === "BLOCK_AS_IMPLICIT_KEY") {
		const start = err.pos[0];
		const opening = source[start];
		const from =
			opening === '"' || opening === "'"
				? indexAfterQuoted(source, start)
				: start;
		const colon = from === -1 ? -1 : indexOfMappingColon(source, from);
		if (colon !== -1) {
			return {
				message: NESTED_MAPPING_MESSAGE,
				loc: locFromOffsets(lineCounter, lineOffset, [colon, colon + 1]),
			};
		}
	}
	return {
		message: err.message,
		loc: locFromOffsets(lineCounter, lineOffset, err.pos),
	};
}

/**
 * Extracts a `[start, end]` offset pair from an unknown thrown value, if it carries one.
 * Defensive: as of yaml 2.9, errors thrown out of `toJS()` (an unresolved alias, or an
 * alias-count bomb) carry no `pos` at all, so callers must handle `undefined` here.
 */
export function errorPos(err: unknown): readonly [number, number] | undefined {
	if (typeof err !== "object" || err === null || !("pos" in err)) {
		return undefined;
	}
	const { pos } = err as { pos: unknown };
	if (!Array.isArray(pos)) {
		return undefined;
	}
	const [start, end] = pos as unknown[];
	return typeof start === "number" && typeof end === "number"
		? [start, end]
		: undefined;
}
