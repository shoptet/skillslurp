# skillslurp

**Lint AI agent skills, rules, and instructions across your repository.**

Catch broken links, invalid frontmatter, activation patterns that load a file never or everywhere,
and mirrored directories that drift from their source.
Optional checks keep an index and the format documentation in sync with the skills on disk.

## Quick start

Requires Node 22 or newer and a Git checkout of the repository you want to lint.

```sh
npm install --save-dev skillslurp
npx skillslurp .
```

A run with a broken link and an unmatched activation glob reports:

```
.claude/skills/broken-link/SKILL.md
  6:5  error  Link target "./checklist.md" does not exist or is not tracked by git  links/resolve

.claude/skills/dead-glob/SKILL.md
  5:5  error  Activation glob "src/**/*.renamed" (frontmatter key "paths") matches no file tracked by git  activation/no-unmatched-globs

✖ 2 problems (2 errors, 0 warnings)
```

Exit codes: **0** no errors, **1** lint errors, **2** configuration or execution failure.
Warnings alone do not fail a run. If nothing is found to lint, the CLI says so and exits 0.

## What gets checked

Without a config file, skillslurp detects these layouts and runs the recommended checks:

| Directory | Linted as | Files it looks for |
|---|---|---|
| `.claude/skills` | skills, `claude-code` format | `**/SKILL.md` |
| `.agents/skills` | skills, `generic` format | `**/SKILL.md` |
| `.opencode/skills` | skills, `opencode` format | `**/SKILL.md` |
| `.cursor/skills` | skills, `cursor` format | `**/SKILL.md` |
| `.github/skills` | skills, `copilot` format | `**/SKILL.md` |
| `.cursor/rules` | rules, `cursor` format | `**/*.mdc` |
| `.github/instructions` | instructions, `copilot` format | `**/*.instructions.md` |

Other layouts need a [configuration file](#configuration).
Links and path references are checked against Git-tracked targets, so add new target files to Git.
Remote URLs and heading anchors are not checked.

## Checks

The checks marked "on" belong to the `recommended` preset and run without configuration; opt-in
checks need the option named. `strict` currently contains the same checks as `recommended`.

The checks use a few terms:

- **Activation key**: the frontmatter field that tells a tool when to load a file on its own:
  `paths` (Claude Code), `globs` (Cursor rules), `applyTo` (Copilot instructions). Its value holds
  glob patterns.
- **Format**: whose file contract a directory follows (`dialects` in the config: `claude-code`,
  `cursor`, …). A directory read by several tools lists several.
- **Hub and spokes**: the hub is the one real directory that holds the files; a spoke is another
  tool's directory that mirrors it through symlinks, so every tool reads the same files.
- **Entry document**: the file a tool loads first, `SKILL.md` for a skill or the rule file itself
  for a rule. A skill's other files are its supporting files.

| Check | What it reports | Default |
|---|---|---|
| `activation/consistent-scope` | A file whose activation keys disagree between the formats that read it, such as `globs` set for Cursor but no `paths` for Claude Code. | on, error |
| `activation/max-glob-share` | An activation pattern that matches more than `max` percent of the Git-tracked files, so the file loads almost everywhere. | opt-in (needs option `max`) |
| `activation/no-unmatched-globs` | An activation pattern that matches no Git-tracked file, so the file never loads. | on, error |
| `activation/value-shape` | An activation value written in a form the tool does not act on, such as Cursor's `globs` as a list in brackets. | on, error |
| `docs/contract-sync` | Key lists in a document's `skillslurp-contract` block that differ from the configured formats' required and allowed keys. | opt-in (needs option `file`) |
| `file/defers-to` | A configured file that does not defer to its canonical file (for instance `CLAUDE.md` to `AGENTS.md`) by being a symlink to it or holding only an `@import` of it. | opt-in (needs option `pairs`) |
| `file/max-lines` | A file longer than the line limit (500 by default), frontmatter included. | on, warn |
| `hub/symlinks` | A declared spoke that does not mirror its hub through committed, relative symlinks: one link to the whole hub, or one per hub item named as the reading tool expects, with a real folder of such links in place of a hub folder where the tool renames files. | on, error |
| `index/complete` | An entry document that the configured index does not link to. | opt-in (needs option `file`) |
| `index/no-missing-targets` | A link in the configured index to a file inside the linted directory that is missing or not tracked by Git. | opt-in (needs option `file`) |
| `links/resolve` | A local Markdown link, image or link definition whose target is missing or not tracked by Git. | on, error |
| `refs/no-dangling-paths` | A path written out in the text, such as `.claude/skills/<skill>/reference.md` in inline code, that points into a linted directory at a file that is missing or not tracked by Git. | on, error |
| `refs/no-unreachable-files` | A tracked supporting file that its entry document neither links to nor mentions, so nothing leads the tool to it. | on, error |
| `skill/dir-has-entry` | A folder in a skills directory that holds files but no `SKILL.md`. | on, error |
| `skill/frontmatter-schema` | Frontmatter that breaks the configured formats: none where one is needed, a missing required key, a key the format does not allow, or a value of the wrong type where the format documents one. | on, error |
| `skill/name-matches-dir` | A skill whose `name` differs from its folder name, in formats that require them to match. | on, error |

## Configuration

Create `skillslurp.json` at the repository root to choose directories and adjust checks.
**This replaces automatic detection:** list every directory you want linted. The name is exact,
and the file is strict JSON.

```json
{
  "surfaces": [{ "root": ".claude/skills", "dialects": ["claude-code"] }]
}
```

`surfaces` lists the directories to lint; `dialects` selects the formats to validate against.
Checks are adjusted under `rules`. This example disables the line limit, makes link findings
warnings, and requires every skill to be linked from `docs/SKILLS.md`:

```json
{
  "surfaces": [{ "root": ".claude/skills", "dialects": ["claude-code"] }],
  "rules": {
    "file/max-lines": "off",
    "links/resolve": "warn",
    "index/complete": { "options": { "file": "docs/SKILLS.md" } }
  }
}
```

See the [configuration guide](docs/configuration.md) for every key, its default, per-directory
settings, and ignoring files.

## Existing repositories

If the first run reports findings you want to address gradually, record them in a baseline:

```sh
npx skillslurp . --update-baseline
```

Review and commit `skillslurp-baseline.json`. Later runs load it automatically, suppress matching
findings, and report findings beyond the recorded baseline. After fixing baselined findings,
regenerate the baseline and review its diff to clear `baseline/stale` errors.

## CI

Use the GitHub reporter to display findings as annotations:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install --save-dev skillslurp@0.1.1
- run: npx skillslurp . --reporter github
```

For pull requests, `--diff-base origin/main` limits per-file checks to committed changes;
repository-wide checks still run. This mode needs Git history, so set `fetch-depth: 0` on checkout.

## Security

skillslurp reads the repository it lints and runs none of the code in it; `skillslurp.json` is
plain JSON. It does trust that repository not to slow it down on purpose: a crafted glob in a
linted file or in `skillslurp.json`, matched against crafted file names, can keep a run busy for a
very long time. A CI job that builds a pull request already trusts it at least this much. Where you
lint content whose code you would not run, such as in a `pull_request_target` workflow, set
`timeout-minutes` on the job and install skillslurp outside the checkout, not with `npm install`
inside it.

## Documentation

The [configuration guide](docs/configuration.md) covers `skillslurp.json` in full.

## License

MIT. See [LICENSE](LICENSE). The npm package bundles its dependencies into `dist/cli.js` and ships
their license notices in `dist/THIRD_PARTY_NOTICES.txt`.
