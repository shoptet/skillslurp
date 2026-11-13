---
globs: src/**/*.ts
paths: ["src/**/*.ts", "src/**/*.dead"]
---

Lint fixture for skillslurp's own test suite, not a real rule. Claude Code reads `paths` and
Cursor reads `globs`, so the two lists have to agree: here `paths` carries one more pattern, and
that pattern matches no tracked file, so `activation/consistent-scope` and
`activation/no-unmatched-globs` each report it. The file sits in a subdirectory on purpose:
Claude Code discovers `.md` rules recursively.
