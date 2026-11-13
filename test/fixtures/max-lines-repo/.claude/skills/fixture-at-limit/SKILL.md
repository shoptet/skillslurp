---
name: fixture-at-limit
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is exactly as long as the surface's lowered file/max-lines limit.
---

Twelve lines, against `max: 12` — the boundary itself, which is the one length the comparison can
get wrong in either direction. At the limit is not over it, so this file must stay clean, and
`count <= max` narrowed to `count < max` turns it into a reported document.

Counted the way the rule counts: the whole file, frontmatter and both delimiters included, with
the trailing line break read as a terminator rather than as a thirteenth line. This is the last
line.
