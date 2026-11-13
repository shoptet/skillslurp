import { posix } from "node:path";
import picomatch from "picomatch";

/**
 * A predicate over posix paths relative to a surface root, built from a surface's `include` or
 * `ignore` list. Patterns are prepared the way discovery's globber prepares them: empty ones are
 * dropped, a trailing `/` is stripped and the rest is `posix.normalize`d, so `wip`, `wip/` and
 * `wip/**` each match the directory `wip` itself, and dotfiles match. An empty list matches
 * nothing.
 */
export function matcher(
	patterns: readonly string[],
): (path: string) => boolean {
	const prepared = patterns
		.filter((pattern) => pattern.length > 0)
		.map((pattern) =>
			posix.normalize(pattern.endsWith("/") ? pattern.slice(0, -1) : pattern),
		);
	if (prepared.length === 0) {
		return () => false;
	}
	return picomatch(prepared, { dot: true, posix: true });
}
