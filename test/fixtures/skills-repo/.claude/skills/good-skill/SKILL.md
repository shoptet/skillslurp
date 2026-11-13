---
name: good-skill
description: A well-formed skill used as the clean control.
---

This skill is intentionally unremarkable: valid frontmatter, a short body, nothing that
should trigger any diagnostic. See the [reference material](reference.md) — the link is
what keeps `refs/no-unreachable-files` quiet about a file this fixture keeps undiscovered
on purpose, and it gives `links/resolve` a target that really is tracked by git.
