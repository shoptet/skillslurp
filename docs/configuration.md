# skillslurp configuration

[Quick start](../README.md)

## Where the file lives and what it does

skillslurp reads `skillslurp.json` at the root of the repository it is pointed at. The name is
exact: there is no alternative spelling and no search in parent directories. The file is strict
JSON, so it carries no comments: the reason a setting exists belongs in documentation or in the
commit message that introduced it. A configuration file **replaces automatic detection**: the
directories listed in it are the only directories linted, including ones detection would have
found on its own.

Configuration problems are fatal. They exit 2 before any document is linted, and the selected
reporter renders them on standard output with `line:col` positions.

- An unrecognized key, at the top level or inside a surface: `unrecognized key "..."`.
- A rule id the build does not know: `unknown rule id "..."`.
- A file that is not valid JSON: `invalid JSON: <parser message>`, with a position where the
  parser reports one.
- A key written twice in the same object is an error too. The second value does not win.

`skillslurp-baseline.json`, when a repository has one, sits next to it.

## Minimal example

```json
{
  "surfaces": [{ "root": ".claude/skills", "dialects": ["claude-code"] }]
}
```

The dialect is spelled out because it is never inferred from the path: omit `dialects` and the
surface is checked against `generic`, even under `.claude/skills`. `kind` defaults to `skills`.

## Top-level keys

| Key | Required | Default | Meaning |
|---|---|---|---|
| `version` | no | `1` | Configuration format version. `1` is the only accepted value. |
| `extends` | no | `["recommended"]` | Presets to start from. See [presets](#presets). |
| `surfaces` | yes | — | Directories to lint. At least one entry. |
| `ignore` | no | `[]` | Globs excluding files from linting and from repository-wide checks. See [ignoring files](#ignoring-files). |
| `rules` | no | `{}` | Severities and options for every surface. See [rule entries](#rule-entries). |

## Surface keys

| Key | Required | Default | Meaning |
|---|---|---|---|
| `root` | yes | — | Directory to lint, relative to the repository root. A configured directory that matches no file is a configuration error, not an empty run. |
| `kind` | no | `"skills"` | `skills`, `rules`, or `instructions`. Never inferred from the path. |
| `dialects` | no | skills `["generic"]`, rules `["cursor"]`, instructions `["copilot"]` | Formats to validate against. A `rules` directory can be checked as `cursor`, as `claude-code`, or as both. |
| `include` | no | follows `dialects`: skills `["**/SKILL.md"]`; rules `["**/*.mdc"]` for `cursor` and `["**/*.md"]` for `claude-code`, both for the pair; instructions `["**/*.instructions.md"]` | Patterns selecting entry documents, relative to `root`. An explicit `[]` matches nothing; it does not restore the default. |
| `ignore` | no | `[]` | Patterns excluding documents in this directory from discovery and from the checks of its spokes. |
| `spokes` | no | `[]` | Tool directories that mirror this directory through symlinks. See [spokes](#spokes). |
| `rules` | no | `{}` | Overrides for this directory. |

## Spokes

A hub is one real directory that several tools should read from; its spokes are the tool
directories that mirror it through symlinks. The surface is the hub, and a configuration declares
the spokes on it: nothing is inferred from the filesystem. Without a configuration, detection
records a spoke only for a candidate that resolves to the same directory as another of the same
kind (see [spokes without a configuration](#spokes-without-a-configuration)).

```json
{
  "surfaces": [
    { "root": ".agents/skills", "spokes": [".claude/skills", ".cursor/skills"] }
  ]
}
```

A spoke is a path relative to the repository root. `./`, a trailing slash and `a/../b` are
normalized away, and a spoke listed twice is kept once. Discovery fails, at the entry, when a spoke:

- is absolute or leaves the repository;
- is, sits inside, or contains its own surface's `root`, as written and after resolving the root's
  symlinks: with `.agents/skills` linked to `.claude/skills`, declaring `.claude/skills` on the
  `.agents/skills` surface names the hub itself;
- exists, is not itself a symlink, and resolves outside the repository;
- is declared by two surfaces, by its written path or, when it exists and is not a symlink, by the
  directory it resolves to;
- is, sits inside, or contains another surface's `root`, including by its real path when it exists
  and is not itself a symlink (one that is a symlink is never judged by its target here). A root
  that also holds this surface's own root, such as `.` next to `.agents/skills`, is a broader
  surface and does not count as holding the spoke.

A spoke under a symlinked directory that leads to the hub, such as `.claude/skills` when `.claude`
links to `.agents`, is a working mirror and is accepted.

A spoke that does not exist is not a configuration error. Discovery is unchanged: it does not
follow symlinks, so only the hub is linted. Whether a spoke really mirrors the hub is the job of
the `hub/symlinks` rule, which is on in the `recommended` preset, reports at `error`, and checks
only spokes declared here. It is repository-wide: configure it in the top-level `rules`, never on a
surface. For a directory-level spoke (a spoke that is one symlink to the hub) it reports a spoke
that:

- does not exist, or is neither a directory nor a symlink, or is a regular file that git's index
  records as a symlink (the change is not staged, or the checkout was made with `core.symlinks`
  off);
- is a symlink that git does not track as one (tracked as something else, or not tracked at all).
  Git records a link under the path of its real parent directory, so a link reached through a
  symlinked directory is looked up there, never under the name of that directory;
- has an absolute target, since a relative one stays valid in every checkout;
- does not resolve, resolves outside the linted directory, or resolves to somewhere other than the
  hub. The hub is compared by its real path, so a hub reached through a symlink is still the hub. A
  target whose text climbs above the linted directory is outside even when it comes back in, as
  `../../app/.agents/skills` does in a checkout named `app`: the link would break in a checkout
  with any other name.

A spoke reached through a symlinked ancestor, such as `.claude/skills` when `.claude` links to
`.agents`, is also reported when the nearest symlinked ancestor is not committed as a symlink. That
holds for every form of spoke, and the ancestor is reported once for the spoke, not once per link
inside it.

A spoke that is a real directory holding its own items is an item-level spoke: it mirrors the hub
with one symlink per hub item. A hub item is the immediate child of the hub's root on the path to a
discovered entry document of the surface: `foo` for `foo/SKILL.md`, `group` for
`group/foo/SKILL.md`, and the file itself for an entry at the root, such as `a.mdc`. The list comes
from discovery, so an item git does not track yet counts. Each item must be linked as
`<spoke>/<item>` (a spoke at `.cursor/rules` renames file items and can mirror a hub directory as a
real directory, see [below](#a-spoke-at-cursorrules)), and a report is against that path. It names
an item that:

- has no link in the spoke;
- is a real copy in the spoke instead of a link, the forked-copy case, or a regular file that git's
  index records as a symlink (the change is not staged, or `core.symlinks` is off);
- has a link that git does not track as a symlink, or that has an absolute target, or that does not
  resolve, resolves outside the linted directory, or resolves to somewhere other than that hub
  item (at most one of these three, as for a directory-level spoke).

Other entries in the spoke are reported in two cases only. A symlink that is not a hub item is
reported when it does not resolve, when it leaves the linted directory (by where it resolves or by
the climbing text of its target), when it is a second link to a hub item under another name, or when
what it points at is something the surface's `include` would lint and no discovered document
covers, since discovery does not follow links. Any other symlink is left alone, including a link to
a hub directory that holds no entry document and any symlink git does not track, which CI never
sees.

Real content, a file or a directory holding one, is reported when git tracks it, the surface's
`include` matches it and no discovered document covers it, since then no surface lints it. Content
git does not track is never seen by CI, so it is not reported. The surface's `ignore` is matched
against the path from the spoke's root, the way discovery matches it from the surface's root, since
a spoke mirrors the hub: with `ignore: ["wip/**"]` on the surface, a `wip/SKILL.md` in the spoke is
skipped. The top-level `ignore` is matched against the path from the repository's root, as in every
repository-wide check: to skip that same file, write `<spoke>/wip/**`. Anything else in the
directory, such as a `README.md` or a `.DS_Store`, is not an entry and is ignored.

A declared spoke inside another declared spoke is checked on its own. The outer spoke does not
report its directory, or anything under it, as an unexpected entry.

Two surfaces whose roots resolve to the same directory are still an error. When one root is a
symlink to the other, the error suggests declaring the symlink as a spoke of the other surface, the
alternative to listing several dialects on one surface.

`refs/no-dangling-paths` follows spokes and symlinked roots too. A path written through a
configured root that is itself a symlink (`root: .claude/skills`, a link to `.agents/skills`), or
through a spoke that links to the hub (`.claude/skills/<item>/SKILL.md` for the hub
`.agents/skills`), declared or detected, is looked up in the hub, since git tracks nothing below a
symlinked directory. A spoke that is a symlink to any other directory is not followed;
`hub/symlinks` reports it when it is declared. A path git tracks as written (a committed README in
a spoke that is a real directory) is accepted as it is. A report and an `allowlist` entry use the
path as it is written in the file, not the hub path it resolves to.

### Spokes without a configuration

When several detected directories of one kind resolve to the same real directory, skillslurp lints
that directory once. The root is the candidate that is not itself reached through a symlink; if
none is, the first in the detection table. Every other candidate is recorded as a spoke, in table
order, and the announcement names them:

```
  .agents/skills (skills, claude-code, generic; spokes: .claude/skills)
```

`refs/no-dangling-paths` follows these spokes like declared ones, so a path written through
`.claude/skills/<item>` is looked up in the hub. `hub/symlinks` does not check them: nothing was
declared, and a link that exists only on one machine would be reported there and never in CI.
Declare the spokes in a configuration to have them checked.

### A spoke at `.cursor/rules`

A spoke declared at exactly `.cursor/rules`, on a `rules` surface, is read by Cursor whichever
formats the surface lists, and Cursor reads only `.mdc` files there: "Project rules must use the
`.mdc` extension. A plain `.md` file in `.cursor/rules` is ignored by the rules system"
(cursor.com/docs/rules, fetched 2026-10-01). So `hub/symlinks` expects the link to a hub rule
`x.md` to be named `x.mdc`: the last extension is replaced, or one is appended when the name has
none, and it is compared case-sensitively. A hub rule already named `x.mdc` and a hub directory
keep their names. Cursor does not document symlinks; a `.mdc` link to a `.md` hub rule, and a real
subfolder of such links, are layouts checked by hand in Cursor, not documented ones: the
link on 2026-10-01 and the subfolder on 2026-10-05 (no Cursor version recorded), and the subfolder
again, one and two levels deep, on 2026-10-19 (Cursor 3.25.9). The rule reports:

- a link under the hub's own name (`x.md`) when `x.mdc` is missing, once, with the name to use,
  instead of reporting the missing link and the second link; with `x.mdc` present the `x.md` link is
  a second link to the item, as everywhere;
- two hub files that need one name (`x.md` next to `x.mdc`), once each, at the spoke, naming the
  hub item that owns the name: the one already called `.mdc` does, else the first by name;
- a spoke that is one link to the whole hub, when some of the hub's rules are not `.mdc`: once, at
  the spoke, with how many Cursor ignores and the first path through the spoke. Make it a real
  directory with one link per hub rule. Nothing is added to a spoke that already has another
  report;
- a link to a hub directory holding rules that are not `.mdc`: once, at the link, with the count.
  A link to a directory cannot rename what is inside it, so make it a real directory with one link
  per hub rule, as below.

A hub directory can be mirrored as a real directory instead of being linked, at any depth:
`.cursor/rules/backend/` holding one `.mdc` link per rule of `.agents/rules/backend/`. Names,
renames and name collisions are worked out within one directory, so `x.md` next to `backend/x.md`
is no collision, and a collision is reported at the subfolder. A real directory at the place of a
hub directory is checked this way rather than reported as a copy, unless it is itself a declared
spoke, which is checked on its own. A report inside a mirrored directory is filed at the path it is
about and names the declared spoke and hub, not the subfolder. A real directory in the spoke with no
hub directory behind it is an entry that is not a hub item: the links inside it are not inspected,
and real content in it is reported once, at the directory. A hub directory with no discovered rule,
because `include` or `ignore` leaves its rules out, expects no links. Cursor's help recommends a
flat directory instead: "Keep all rules in a flat `.cursor/rules/` directory."
(cursor.com/help/customization/rules, fetched 2026-10-01). That is advice, and the rule does not
enforce it.

Real files and other links in this spoke are judged by what Cursor reads (`.mdc`) instead of by the
surface's `include`: a tracked `fork.mdc` that no surface lints is reported, and a `notes.md`, which
Cursor ignores, is not. For a link to a file outside the hub, the file name of its target is still
judged by the surface's `include`. A target in the hub that the surface's `ignore` skips is skipped
too, by its path in the hub. Only the exact path counts: a nested `packages/web/.cursor/rules`
keeps the same-name rule above, since no vendor documents it, and so does every other spoke,
`.claude/rules` on the same hub included.

## Rule entries

A `rules` entry is either a bare severity or an object with `severity` and `options`:

```json
{
  "rules": {
    "links/resolve": "warn",
    "file/max-lines": { "severity": "warn", "options": { "max": 300 } }
  }
}
```

Severities are `"error"`, `"warn"` and `"off"`. In the top-level `rules` block a missing
`severity` means `"error"`, so an entry carrying only `options` both enables an opt-in check and
sets it to error. In a surface's `rules` block a missing `severity` means inherit whatever the top
level resolved to. Options never merge: a surface's `options` for a rule replace the top-level
`options` wholesale, so a surface that sets one option drops the rest back to their defaults.

## Presets

`extends` accepts `"recommended"` and `"strict"`; `strict` includes `recommended`, and both
currently enable the same checks at the same severities. `recommended` holds the checks marked
"on" in the [check list](../README.md#checks).

## Ignoring files

Patterns are matched against **file** paths, never directory paths. Write `dir/**`, not `dir/` or
`dir`: a directory-shaped pattern excludes nothing from the repository-wide scan. `**/vendor/**`
matches at any depth. `**/node_modules/**` and `**/.git/**` are always excluded.

Top-level `ignore` is evaluated against two bases, because it answers two questions:

- Which documents are linted: patterns are matched relative to **each surface root**, so a
  top-level `ignore: ["src/**"]` excludes `.claude/skills/src/**`, not the repository's `src/`.
- What the repository-wide checks see: patterns are matched relative to the **repository root**.
  They also exclude supporting files from unreachable-file reporting.

A surface's own `ignore` is relative to that surface root and affects discovery only, plus the
spokes of that surface, which mirror it (see [`hub/symlinks`](#spokes)); it never reaches the
repository-wide scan corpus.

## What reaches a supporting file

`refs/no-unreachable-files` reports a tracked file inside a skill directory that its entry
document does not reach. A file is reached by a link, or by a mention: a path or glob written
anywhere in the text of a document inside the skill, in prose, inline or fenced code, frontmatter
or an HTML comment. The scan is lexical; it asks whether the document names the file, not whether
a tool loads it. A markdown file reached this way is read for links and mentions in turn, and any
other file is a leaf.

- A relative path is tried against the directory of the document that mentions it, the skill
  directory and the repository root. `@path` is the same path with the `@` dropped.
- `${CLAUDE_SKILL_DIR}/…` is tried against the skill directory alone and `${CLAUDE_PROJECT_DIR}/…`
  against the repository root alone. Any other `$…` token is skipped.
- A glob with a literal directory prefix (`notes/*.md`, `scripts/{a,b}.sh`) reaches the files it
  matches inside the skill. `*.md`, `*` and `**/*.md` excuse nothing.
- Sentence punctuation after a path, `**emphasis**`, a `#fragment` and a `:line` suffix are not
  part of it.

These do not reach a file: a bare basename that resolves from none of the three bases, a directory
mention (`notes/`, `@notes/`), a path with a space in it (a mention ends at whitespace, so link the
file instead), an absolute or `~/` path, a URL, and a `..` that leaves the skill. Mentions are
fenced to the skill: only its own documents are read for them, and only its own files can be
reached by one.

## Directories without an entry document

`skill/dir-has-entry` reports a directory under a `skills` root that holds tracked files but no
entry document: a folder with only `notes.md`, or a `SKILL.md` renamed to `README.md`. Claude Code
documents `SKILL.md` as required in every skill directory (code.claude.com/docs/en/skills, fetched
2026-10-01). What a tool does with a directory that has none is not documented, so the finding
says that the directory sits where a skill goes and is not one, not that any tool rejects it. It
is on in both presets, at error, and judges `skills` surfaces only.

- One finding per directory, filed against the directory and without a line. Only Git-tracked
  files count, so an empty directory or one holding only untracked files is not reported.
- A directory with an entry document directly in it is a skill, and nothing inside it is judged
  (`references/` next to `SKILL.md`). A directory holding entry documents only further down, such
  as `group/a/SKILL.md`, is looked through, and each directory below it is judged on its own.
- A surface root with a `SKILL.md` directly in it (`"root": "skills/foo"`, or a root symlinked to
  one skill directory) is that one skill, and nothing under it is judged. Only `SKILL.md` counts
  there, so a commands hub with flat command files at its root still has its other directories
  judged.
- A surface's `include` decides what an entry document is, so a surface with
  `include: ["**/*.md"]` accepts any `.md` file. Names are matched case-sensitively: `skill.md` is
  not `SKILL.md`.
- A directory of shared helpers that belongs in a skills root needs an `ignore` entry. Either list
  the directory in the top-level `ignore`, relative to the repository root
  (`.claude/skills/_shared/**`), or in the surface's own `ignore`, relative to its root
  (`_shared/**`; for this check `_shared` and `_shared/` work there too). The top-level pattern is
  matched against the real, tracked path, so under a symlinked skills root (`.agents/skills` linked
  to `.claude/skills`) write `.claude/skills/_shared/**`: `.agents/skills/_shared/**` matches
  nothing and the directory is still reported. The surface's own `ignore` matches from the surface
  root either way.
- The root or a spoke of another surface, inside the skills root, is not reported.
- Under `--diff-base` the check still runs in full.

## A commands hub

There is no `commands` surface kind. A hub of command files is a `skills` surface whose `include`
accepts any `.md` file, because Claude Code treats the two alike: "Custom commands have been merged
into skills. A file at `.claude/commands/deploy.md` and a skill at
`.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Your existing
`.claude/commands/` files keep working." (code.claude.com/docs/en/skills, fetched 2026-10-01).

```json
{
  "surfaces": [
    {
      "root": ".agents/commands",
      "kind": "skills",
      "dialects": ["claude-code"],
      "include": ["**/*.md"],
      "spokes": [".claude/commands", ".cursor/commands"]
    }
  ]
}
```

Every `.md` file is an entry document, so a command in a subdirectory (`frontend/component.md`) is
neither unreachable nor a directory without an entry, and `hub/symlinks` checks the spokes as it
does for any hub. A command file with no frontmatter at all is clean too: `claude-code` makes the
block optional, so `skill/frontmatter-schema` has nothing to report on a plain prompt file. Any
other format listed next to `claude-code` makes the block required again. Without the `include`, the default `**/SKILL.md` finds no command and the run
stops with `config/no-files`.

The fold has one known gap. The same page says a command file "supports the same frontmatter
except `name` and `paths`", but the `skills` contract allows both, so `name` or `paths` in a command
file is not reported (a `paths` pattern that matches no tracked file still is, as in a skill).
Output styles are not covered: they have no surface kind, so their hub and spokes are not checked.

## Lists in brackets in a Cursor rule

`activation/value-shape` reports a Cursor rule whose `globs` is a YAML list written in brackets:

```yaml
---
globs: ["src/**/*.ts"]
---
```

Cursor's documentation says only "Use `globs` to scope a rule to specific files or directories.
Separate multiple patterns with commas." (cursor.com/docs/rules, fetched 2026-10-19). It does not
say what a list does, and a check by hand showed that Cursor does not attach a rule with one: on
2026-10-19, in Cursor 3.25.9 on macOS, a throwaway repository held one `.mdc` rule per shape, each
scoped to a probe file of its own and carrying a random token, and a new Agent chat read the probe
files and listed the tokens it had. A list of one item (quoted or bare), a list of two items and a
list over several lines did not attach. The controls held: a rule with `alwaysApply: true` and the
documented shapes attached, and the rule for a file the chat did not read did not.

Write the patterns comma-separated instead: `globs: src/**/*.ts, docs/**/*.md`. Quote a value that
starts with `*`, `!` or `{` (`globs: "**/*.ts"`): YAML reads a bare leading `*` as an alias and a
leading `{` as the start of a mapping, which skillslurp reports as `parse/frontmatter`, and a
leading `!` as a tag, which silently drops the pattern.

- It applies wherever `cursor` is among a `rules` surface's formats, whatever the file's extension:
  a hub `.md` rule that reaches Cursor through an `.mdc` link is reported as the `.mdc` file is.
- It is on in both presets, at error. One finding per list, at the list, over its whole span when
  the list runs over several lines, however many items it holds. A baseline entry survives an edit
  to the list: the message names no pattern.
- A list is reported only when it holds at least one pattern, and then also with `alwaysApply:
  true`, since the list stops working the day the flag changes. A negated pattern (`["!a"]`) is a
  pattern here.
- The other activation checks still read the items of a list as patterns, so one value can draw a
  finding on an item from `activation/no-unmatched-globs` next to this one on the list. Each names
  its own fix.
- Under `--diff-base` it runs on changed documents only.

These are not reported: a block list (`globs:` then `- src/**/*.ts` lines), which the same check saw
attach, though Cursor Settings shows that rule as "Apply Manually"; a quoted value, a comma-separated
one and one with a brace set (`src/*.{ts,tsx}`), which attached; an empty list and a list of blank
items, where there is nothing to lose and nothing was tried; a list with an item that is not a
string, a type problem that `activation/consistent-scope` reports where two formats activate; an
alias to a list (`globs: *g`) and a mapping, neither of which was tried. No other key or format has
such a check behind it: Claude Code's `paths`, Copilot's `applyTo` and the keys of a Cursor skill
(`paths`, `globs`) are left alone.

## Opt-in checks and their options

Three checks are off in every preset and require `options.file`, naming the document they are
about: `docs/contract-sync` (the document holding the `skillslurp-contract` block),
`index/complete` and `index/no-missing-targets` (the index document). Enabling one without
`options.file` is a config error, exit 2 — not a check that quietly does nothing.

A fourth, `file/defers-to`, is off in every preset too and requires `options.pairs`; it has its
own section [below](#deferring-one-file-to-another). A fifth, `activation/max-glob-share`, is off
in every preset and requires `options.max`; see [Limiting how much one activation glob
matches](#limiting-how-much-one-activation-glob-matches).

Three checks that are on by default take optional settings:

| Check | Option | Default |
|---|---|---|
| `file/max-lines` | `max`: line limit for the whole file, frontmatter included. | `500` |
| `refs/no-dangling-paths` | `allowlist`: path literals that are not treated as references. | `[]` |
| `skill/frontmatter-schema` | `required`, `allowed`: key lists that **replace** the format's own. | the dialect's lists |

An allowlist entry that suppresses nothing is a `config/stale-allowlist` error, so the list
cannot quietly outlive its reason.

`skill/frontmatter-schema` reports a document with no frontmatter block, or one that is not a YAML
mapping, unless every format on the surface reads the document without one. Only Claude Code does:
"All fields are optional." and "Claude Code reads the frontmatter only when the opening `---` is
the file's first line. Otherwise it treats the whole file, `---` markers included, as skill
content." for skills (code.claude.com/docs/en/skills, fetched 2026-10-02), and "Rules without
`paths` frontmatter are loaded at launch with the same priority as `.claude/CLAUDE.md`." for rules
(code.claude.com/docs/en/memory, fetched 2026-10-02). So a `claude-code` surface accepts a file with
no block, or an empty `---` / `---` block, and treats it as having no keys: a key in `required` is
still reported missing. Listing another format next to `claude-code` (`generic`, or `cursor` for
rules) brings the requirement back, as does any other format alone. A bare scalar or a list between
the fences is reported everywhere.

A key in `skill/frontmatter-schema`'s `required` must be present and not empty. Its type is
checked only where a source documents one. A key must be a string where a format requires or
documents it as a string, that is, constrains its value: `name` and `description` where a format
requires them, or `compatibility`, which has a documented length cap. An activation key such as
Cursor's rules `globs` may be a string or a list of strings (though `activation/value-shape` reports
a Cursor rule's `globs` written as a list in brackets; see [Lists in brackets in a Cursor
rule](#lists-in-brackets-in-a-cursor-rule)). Any other key may hold any value, so
`alwaysApply: false` passes. Empty means `null` or a blank string; for a key that is not a string
by those rules, also an empty list or mapping, and for an activation key, a list of only blank
items.

## Limiting how much one activation glob matches

`activation/max-glob-share` warns when one activation glob (`paths`, `globs` or `applyTo`) matches
more than a share of the repository's Git-tracked files. A document scoped to `**` is loaded for
almost every file, which is what a document without an activation key already is. It is off until
`options.max` is set, and `max` has no default: neither vendor documents a threshold, and the same
share means something different in a fifty-file repository and in a sixty-thousand-file monorepo.
A rule enabled without `max`, or with `max` outside the range below, is a config error, exit 2,
and so is one set to `"off"` without it.

```json
{
  "rules": {
    "activation/max-glob-share": { "severity": "warn", "options": { "max": 5 } }
  }
}
```

| Option | Meaning | Default |
|---|---|---|
| `max` | The most one pattern may match, as a percentage of all Git-tracked files: above 0 and below 100, decimals allowed (`2.5`). | required |

Each distinct pattern of a document is matched against every tracked file, not only those under
the surface root, and reported when it matches strictly more than `max` percent: a pattern exactly
at the limit passes. The report names the count, the total and the share to one decimal, so a
share just over the limit can read as the limit itself:
`matches 63 of 1250 tracked files (5.0%), more than the limit of 5%`.

- A pattern with no `/` matches the repository root only, as both vendors document it: `*.md`
  counts `README.md`, not `docs/a.md`. Dotfiles and dot directories count.
- A pattern that matches nothing is not reported here; `activation/no-unmatched-globs` reports it.
  A negated pattern (`!**/*.test.ts`) is skipped, since no vendor documents negation.
- A pattern written under two keys (`paths` and `globs` on a surface with two rule formats) is one
  report naming both. Reports come in document order, a key's patterns sorted.
- The check is a `warn` unless you set `error`. Set per surface, it applies to that surface only,
  and a surface's `options` replace the top-level ones.
- Under `--diff-base` it runs on changed documents only. An unchanged document whose glob crosses
  the limit because other files were added is reported by the next full run.

## Deferring one file to another

`file/defers-to` keeps one file as the source of truth and makes the others point at it, for
instance every `CLAUDE.md` deferring to the `AGENTS.md` beside it. It is repository-wide, so it is
configured in the top-level `rules` only, and it is off until `options.pairs` names at least one
pair:

```json
{
  "rules": {
    "file/defers-to": {
      "options": { "pairs": [{ "files": "**/CLAUDE.md", "canonical": "AGENTS.md" }] }
    }
  }
}
```

| Pair key | Meaning | Default |
|---|---|---|
| `files` | Glob for the files that must defer, matched case-sensitively against Git-tracked paths from the repository root, ignored files excluded. Not absolute. | required |
| `canonical` | The file they defer to, as a path from the directory of each matched file: `packages/a/CLAUDE.md` defers to `packages/a/AGENTS.md`. Not absolute, and it may climb with `..` only as far as the shallowest file `files` can match is deep: the least depth across the alternatives of a simple `{a,b}` group. A glob with negation, an extglob such as `*(x)`, a bracket expression or an escape has no computable depth, so its `canonical` may not climb at all. | required |
| `allow` | `"symlink"`, `"import"` or `"either"`: the forms a matched file may take. | `"either"` |

A matched file defers in one of two forms: a symlink that resolves to the canonical file, or a
file whose only content is one `@` import of it, with any number of blank lines and block-level
HTML comments around it. Claude Code strips such comments before it injects the file, so they
carry maintainer notes for free. Claude Code itself accepts Claude-specific text below an
`@AGENTS.md` import; this rule is deliberately stricter and does not. On Windows a committed
symlink is checked out as a plain text file unless `core.symlinks` is enabled, so a repository with
Windows contributors can set `"allow": "import"`.

What is reported, against the matched file:

- the canonical file is missing, cannot be inspected, is a symlink that does not resolve or leads
  outside the repository (or whose target text climbs out of it on the way, even if it comes back
  in), is a directory (or a link to one), or is not tracked by Git, once per
  file and instead of anything else. A canonical reached through a
  committed directory symlink is looked up in the index under the directory's real path;
- the file is a symlink in Git's index but a regular file on disk, which is either a change that
  is not staged yet or a checkout made with `core.symlinks` off. This is reported before the form
  is judged, so `allow` does not change it;
- the file is in a form `allow` rules out;
- a symlink that is absolute, does not resolve, leaves the repository, or resolves to another
  file (links are compared by real path, so a chain of links or a canonical file that is itself a
  link still matches);
- an import file with no import, several imports, more content than the import (reported at the
  first such line), an import of another file, an absolute import (reported like an absolute
  symlink target, even when it resolves to the canonical file), a `~/` import, or an import outside
  the repository. An import inside a code block or code span is not an import, and a comment
  beside the import on its own line, or inside a paragraph, is content.

A pair whose `files` matches no tracked file is a `config/unmatched-pair` error, the same way a
stale allowlist entry is. A pair whose `canonical` resolves outside the repository for a matched
file is a `config/canonical-outside` error, once per pair, and nothing outside is looked up. A
matched file that is the canonical file itself is skipped, so a broad glob such as `**/*.md` does
not report the canonical file against itself.

`**/CLAUDE.md` also matches the `CLAUDE.md` inside a `.claude` directory, and a `canonical` of
`AGENTS.md` would then look for the canonical file inside `.claude` too. To keep the root `.claude`
directory out of the first pair and give it a pair of its own, whose canonical file sits one level
up:

```json
{
  "pairs": [
    { "files": "{CLAUDE.md,!(.claude)/**/CLAUDE.md,.claude?*/**/CLAUDE.md}", "canonical": "AGENTS.md" },
    { "files": ".claude/CLAUDE.md", "canonical": "../AGENTS.md" }
  ]
}
```

The first glob uses an extglob, which is fine because its `canonical` does not climb. `!(.claude)`
also drops every top-level directory whose name merely starts with `.claude`, such as
`.claude-shared/`, so its last alternative, `.claude?*/**/CLAUDE.md`, puts those back. Only the
`.claude` directory at the repository root is left out of the first pair; a nested one, such as
`packages/a/.claude/CLAUDE.md`, still matches and needs its own pair.

## Examples

One configuration that turns the line limit off for a second surface, requires every skill to be
linked from an index, and excuses a path literal that is prose rather than a reference:

```json
{
  "surfaces": [
    { "root": ".claude/skills", "dialects": ["claude-code"] },
    { "root": "docs/playbooks", "rules": { "file/max-lines": { "severity": "off" } } }
  ],
  "rules": {
    "file/max-lines": { "severity": "warn", "options": { "max": 300 } },
    "index/complete": { "options": { "file": "docs/SKILLS.md" } },
    "refs/no-dangling-paths": {
      "options": { "allowlist": [".claude/skills/retired-skill/SKILL.md"] }
    }
  }
}
```
