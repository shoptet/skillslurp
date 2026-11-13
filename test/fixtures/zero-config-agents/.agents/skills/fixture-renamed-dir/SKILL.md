---
name: fixture-renamed-skill
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; its name deliberately disagrees with its directory so skill/name-matches-dir fires.
---

`generic` couples the name to the directory (`nameMatchesDir: "must"`), so renaming one without
the other is a violation rather than a style preference.
