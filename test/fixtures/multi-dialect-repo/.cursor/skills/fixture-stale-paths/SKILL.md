---
name: fixture-stale-paths
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is scoped to a directory that no longer exists in this fixture.
paths: "gone/**/*.md"
---

Nothing in this fixture is tracked under `gone/`, so this skill can never activate — the stale
scope `activation/no-unmatched-globs` reports. Both dialects read `paths`, so they agree about
that scope and `activation/consistent-scope` stays silent here.
