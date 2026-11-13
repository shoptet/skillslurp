---
name: fixture-agents-clean
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it is the clean control for the zero-config .agents/ run.
---

The `generic` dialect (the Agent Skills spec) closes the key set at six keys and requires both
`name` and `description`; this file satisfies all of that.

Named for its own fixture repo rather than `fixture-clean`: every `.claude/skills` and
`.agents/skills` directory under `test/fixtures/` is a live directory-scoped skill to an agent
working in this checkout, so two fixtures sharing one skill name is a real collision, not just
an untidy one.
