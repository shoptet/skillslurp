# project-scan-repo

A lint fixture for skillslurp's own test suite, not a real project. It is the end-to-end proof
that the capability layer is wired through the real CLI, so it is built to report exactly four
violations from four different rules and nothing else.

This file is what the one `scan` rule reads. It carries one path literal that is stale and one
that resolves cleanly:

- the skill directory `.claude/skills/fixture-old` was renamed away, so that literal path
  resolves to nothing — `refs/no-dangling-paths`;
- the path `.claude/skills/fixture-alpha` still resolves to a real directory, so the rule says
  nothing about this bullet.

`skillslurp.json`'s two opt-in rules on this surface, `index/complete` and
`index/no-missing-targets`, both require an option naming the index file, and both carry an
explicit `"severity": "error"`: with no tier pulling either rule in, an `options`-only entry would
leave it disabled and this fixture would quietly stop testing what it exists for.

The configured index file is the one inside the surface root, not a repo-root `SKILLS.md` — a
repo-root index would have to spell the surface path out in every link, so its one ghost link
would be reported twice, once by each of `index/no-missing-targets` and `refs/no-dangling-paths`,
both reading the same literal. Written here, the index's links are relative and each rule speaks
exactly once.
