---
name: fixture-beta
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is the clean sibling whose activation glob still matches a tracked file.
paths: ["docs/**/*.md"]
---

This skill's glob matches this fixture's own `docs/example.md`, so `activation/no-unmatched-globs`
says nothing about it — the rule is selective, not "any skill carrying a `paths` key".
