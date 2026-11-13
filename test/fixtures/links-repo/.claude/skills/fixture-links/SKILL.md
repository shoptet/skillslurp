---
name: fixture-links
description: Lint fixture for skillslurp's own test suite, not a real skill. Nothing here is an instruction; it carries one broken link, one link inside a code fence, and four links that resolve — one plain, one with a fragment, one with a query, one with both.
---

A link that resolves: [the reference notes](./reference.md).

A link that does not: [the notes that were never written](./gone.md).

A link inside a fenced code block is markup in an example, not a link the reader can follow, so
it is never reported — remark parses the whole block as one `code` node:

```markdown
[an example of a broken link](./also-gone.md)
```

Three more links that resolve, each carrying a URI component this rule strips off the path before
it stats anything (RFC 3986 §4.2: `relative-ref = relative-part [ "?" query ] [ "#" fragment ]`) —
a [fragment](./reference.md#reference), a [query](./reference.md?plain=1), and
[both at once](./reference.md?plain=1#reference). The last one is the pair that fixes the
earliest delimiter as the cut: strip at the later `#` instead and the path becomes
`./reference.md?plain=1`, which nothing on disk matches.

Whether `#reference` names a real heading is deliberately not asked — every renderer slugs
differently — and `?plain=1` is GitHub's own view modifier, not a different file.
