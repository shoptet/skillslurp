# Working conventions

Conventions for anyone — human or agent — contributing to skillslurp.

## Commits

- Work lands as commits directly on `master`: no branches, no pull requests, nothing to merge.
- Every commit is green on its own: `bun run lint && bun run typecheck && bun test` must pass
  before committing. Amend only before push.
- Commit messages: English, imperative subject; the body explains the why when it is not
  obvious from the diff.

## Reviews

- Every change gets an adversarial code review of its diff before it is committed.
- Review findings must be backed by evidence — a failing test, a reproduction command with
  its output, or the exact code path that demonstrates the defect. Unproven suspicions are
  labeled as such and do not block.

## Edge cases

- Edge cases are enumerated before the code is written, and each one gets a test.
- An edge case discovered mid-change is never silently handled or skipped: it gets an explicit
  decision — in scope (test + fix now) or out of scope, said so in the commit message.

## Guardrails

- No new dependencies without flagging it first.
- No Bun-only APIs in `src/` — dist must run on Node ≥ 22.
- No scope creep: work beyond the change at hand is a change of its own.
- Output is deterministic: stable ordering of discovery, diagnostics, and reporter output.
- Nothing confidential in code, fixtures, or commit messages — the repository is public.
- No `any`, and no lint warning left standing. `bun run lint` runs with `--error-on-warnings`,
  so a warn-level rule fails CI exactly like an error — a warning nobody has to fix is a
  comment. `strict` and `noUncheckedIndexedAccess` are on; reach for `unknown` plus a narrowing
  check, and where a cast really is the honest answer, write the comment that says why it
  cannot lie.

### Habits that have each already caught a bug here

- **`Readonly<T>` is a type, not a lock.** Freeze anything shared between callers or handed out
  of a module. This has bitten twice: `SURFACE_KINDS`, then `DEFAULT_INCLUDE`/`DEFAULT_DIALECTS`
  — where it was a regression, because the zod defaults they replaced were cloned per parse.
- **Mutation-check every new test.** After writing it, make the one-character change in the
  source that it exists to catch, and confirm it fails. Two tests have passed for the wrong
  reason so far: a contract table that could not see a contract filed under an unlisted key,
  and an ordering assertion whose fixture happened to be sorted already.
- **A vendor claim carries its URL and the date it was fetched, and an undocumented detail is
  omitted rather than guessed.** This is what makes a contract reviewable instead of merely
  believable, and it is how four points of an early design turned out to be wrong. A linter
  that invents a constraint produces false positives on valid input, which is worse than
  missing a violation.
- **Never build an object as `{ key: maybeUndefined }`.** It creates an own key, so `"key" in
  obj` reads "not set" as "explicitly set". Assign field by field behind an `!== undefined`
  guard.

## Releases

- No CHANGELOG.md until the first public release; until then the git history and the tags are
  the record.
- A release is an annotated tag `v<version>` on `master` with `package.json` at the same version,
  published to npm from a tarball packed at that tag.
