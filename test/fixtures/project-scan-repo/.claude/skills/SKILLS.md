# Skills index

The document both `index/complete` and `index/no-missing-targets` are pointed at. Two of its three links
name a discovered entry document; the third names a skill directory that is not here.

- [fixture-alpha](fixture-alpha/SKILL.md) — the skill with the dead activation glob.
- [fixture-beta](fixture-beta/SKILL.md) — the skill whose activation glob still matches.
- [fixture-gone](fixture-gone/SKILL.md) — a skill directory that no longer exists.

The third bullet is the ghost `index/no-missing-targets` reports, and the entry document this list never
mentions is what `index/complete` reports. Links here are relative on purpose: an index sitting
at the repository root would have to spell the surface root out, and `refs/no-dangling-paths`
would then report the very same ghost a second time.
