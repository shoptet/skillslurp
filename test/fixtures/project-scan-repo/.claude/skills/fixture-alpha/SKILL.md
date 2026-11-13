---
name: fixture-alpha
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is scoped to a path pattern whose target was renamed out from under it.
paths: ["src/**/*.renamed"]
---

Nothing in this fixture is tracked under `src/`, so this skill can never activate — the dead
activation glob `activation/no-unmatched-globs` reports. The glob is written as a one-item YAML
sequence rather than a plain scalar so that the reported position is the sequence ITEM, which is
the per-piece half of that rule's positioning.

The [notes](./notes.md) in this directory are linked from here, which is what keeps
`refs/no-unreachable-files` silent about them.
