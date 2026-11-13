---
name: fixture-paths-scoped
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is the clean sibling that proves the rule is selective rather than blanket.
paths: "docs/**/*.md"
---

Both dialects on this surface read `paths`, so both see the same scope and the rule reports
nothing — a two-dialect surface is not a violation by itself.
