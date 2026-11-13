---
name: fixture-legacy-globs
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is scoped only by Cursor's legacy globs key, which Claude Code does not read.
globs: "docs/**/*.md"
---

Cursor still accepts `globs` as a fallback for older skills, so this file is path-scoped there
and always eligible in Claude Code — the divergence `activation/consistent-scope` reports.
