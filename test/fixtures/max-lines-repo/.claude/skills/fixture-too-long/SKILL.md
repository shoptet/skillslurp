---
name: fixture-too-long
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is two lines over the surface's lowered file/max-lines limit.
---

`file/max-lines` counts the whole file, frontmatter and closing delimiter included, because the
guidance it encodes ("keep SKILL.md under 500 lines") is about the file an agent has to read in
full rather than about its prose alone.

It is reported at the first line past the limit, not at line 1: the diagnostic points at where
the file started being too long, which is the line an author would start cutting from.

Two lines over rather than one, so the reported line (13) and the counted total (14) are
different numbers and a pin on the position cannot pass by accident.
