---
name: Fixture Display Label
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; its name deliberately disagrees with its directory and must still produce no diagnostic on a claude-code surface.
---

On `claude-code` the frontmatter `name` "sets only the display label shown in skill listings, and
the command still comes from the directory name" — so this file is not a half-finished rename, it
is the documented design, and `skill/name-matches-dir` reports nothing for it
(`nameMatchesDir: "decoupled"`).

The sibling to `zero-config-agents/fixture-renamed-dir`, which is the same mismatch on a `generic`
surface and does report. Between the two, the coupling field is pinned end to end in both of its
observable states rather than only in the one that speaks.
