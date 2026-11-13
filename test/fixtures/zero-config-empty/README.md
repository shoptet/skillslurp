# zero-config-empty

A lint fixture for skillslurp's own test suite: a repository with no `skillslurp.json`
and none of the layouts zero-config auto-detection looks for. The expected outcome is a notice
on **stderr**, empty stdout, and exit 0 — "nothing to lint" is not a failure.

This file exists only because git cannot represent an empty directory. It is deliberately not a
`SKILL.md` and not under any candidate root (`.claude/skills`, `.agents/skills`,
`.opencode/skills`, `.cursor/skills`, `.github/skills`, `.cursor/rules`, `.github/instructions`),
so detection must find nothing here.
