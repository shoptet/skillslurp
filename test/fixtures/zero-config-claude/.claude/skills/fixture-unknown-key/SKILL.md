---
name: fixture-unknown-key
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it misspells allowed-tools as allowedTools so the zero-config .claude/ run has one violation to report.
allowedTools: Read
---

`allowedTools` is a plausible camelCase typo of the documented `allowed-tools` key, which is
exactly the mistake `skill/frontmatter-schema` exists to catch on a `claude-code` surface.
