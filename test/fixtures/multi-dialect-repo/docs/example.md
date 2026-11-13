# Example doc

Both skills on this fixture's surface scope themselves to `docs/**/*.md`. This file is what that
glob matches, which is what keeps `activation/no-unmatched-globs` silent here — so the pinned CLI
output for this fixture stays a statement about `activation/consistent-scope` and nothing else.

Deleting this file is the mutation check for that: the run then reports two extra
`activation/no-unmatched-globs` errors, one per skill.
