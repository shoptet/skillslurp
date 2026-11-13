# Lint fixtures

Each directory is a repository skillslurp lints in its own tests, not a real project. Their
configurations are JSON, which cannot carry comments, so the reasons a fixture is shaped the way it
is live here. A fixture with a README of its own (`project-scan-repo`, `zero-config-empty`) keeps
its reasons there.

- `commands-repo` is a commands hub folded into a `skills` surface: `include: ["**/*.md"]` makes
  every flat command file an entry document (`format.md` has no frontmatter at all, which
  `claude-code` allows), and its two spokes are directory-level symlinks that
  have to be staged as mode 120000, like `hub-repo`'s. The committed state must stay silent;
  `src/commands-fold.test.ts` copies it to a temp repository to repoint or dangle a spoke. The
  default `include` (`**/SKILL.md`) would find no command and stop the run with `config/no-files`.
- `hub-repo` is the one fixture that configures `file/defers-to`, and with `commands-repo` the only
  ones that run `hub/symlinks` over committed symlinks. `.claude/skills` is a correct link to the
  hub and stays silent; `.cursor/skills` holds a real copy of the hub item, and `CLAUDE.md` carries text
  after its `@AGENTS.md`, so each rule fires once. The link has to be staged as mode 120000 for
  CI's in-place run to see it, and `src/cli.capability.test.ts` copies the fixture without
  following links for the same reason. A second, rules surface holds one `.md` rule that
  `.cursor/rules` links as `fixture-rule.mdc`, the name Cursor reads; it has to stay silent, which
  the pinned output in `src/cli.capability.test.ts` (run under Node) is what enforces.
- `links-repo` uses the `claude-code` format rather than the default `generic`: every frontmatter
  key is optional there, so nothing but `links/resolve` can speak in this fixture's pinned output.
- `max-lines-repo` lowers `max` instead of inflating the fixture: 500 is the shipped default, and
  a 501-line file would be 500 lines of filler in a public repository. The rule counts lines, so
  the threshold and the file are interchangeable and the small one is the honest
  choice. The per-surface entry deliberately has no `severity`: it then inherits the tier's
  severity (`warn`), which is what makes this a warn-only run that must still exit 0. Adding an
  explicit `"severity": "error"` would turn a fixture that proves warn-only-still-exits-0 into
  one that proves nothing.
- `multi-dialect-repo` has one surface with two formats, the only way skillslurp expresses "these
  files are read by two tools" (two overlapping surfaces are a config error by design). Both
  formats define an activation key for the `skills` kind, which is what makes
  `activation/consistent-scope` applicable at all: it needs at least two such formats on one
  surface.
- `rules-repo` has one rules surface with two formats and no `include:`, so the nested `.md` file
  it reports is found only because the default include follows the dialects (`claude-code` reads
  `.md`, `cursor` reads `.mdc`). `ts.md` gives Claude Code's `paths` one pattern more than
  Cursor's `globs`, and that pattern matches nothing, so both activation rules fire once;
  `in-sync.md` writes the same live pattern both ways and must stay silent. Like
  `multi-dialect-repo` it is linted in place, so `src/a.ts` has to be tracked for `src/**/*.ts` to
  be live.
- `orphan-repo` configures no per-surface rules: `refs/no-unreachable-files` is in `recommended`,
  so this fixture is what an unconfigured repository gets, and its single violation is reachable
  without anyone opting into anything.
- `bad-config`, `clean-repo`, `skills-repo`: an invalid config, a repository with nothing to
  report, and the frontmatter failures the README's introduction names, respectively.
