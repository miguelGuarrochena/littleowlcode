# Working with an AI assistant

This is the workflow Little Owl Code was built for.

## The snowball problem

A normal AI-assisted session looks like this:

```
"Improve this code"        → 20 files change
"Now clean up the types"   → 30 files change
"Refactor the data layer"  → 25 files change
```

Every diff looked fine when you skimmed it. But the third assistant read an architecture the second
one had already altered, and changed it again on that basis. No single step was wrong; the direction
was never checked.

The dangerous version of this is when a tool re-baselines after every iteration. Then:

```
change → new baseline → change → new baseline → change → new baseline
```

Every step "passes", because each one is only ever compared with the step before it. The codebase can
slide a long way while every check stays green.

## The loop that fixes it

```
   ┌──────────────────────────────────────────────┐
   │                                              │
   ▼                                              │
AI makes a change                                 │
   │                                              │
   ▼                                              │
little-owl review                                 │
   │                                              │
   ├── healthy ──────────────► accept ────────────┘
   │
   ├── needs review ─► little-owl prompt ─► AI fixes ─┐
   │                                                   │
   └── degraded ────► revert or fix by hand            │
                                                       │
                        compare against the SAME ◄─────┘
                              baseline
```

The important part: **the baseline does not move between iterations.** Round two is judged against
the same reference as round one, so "the assistant fixed it" and "the assistant moved the problem
somewhere else" look different.

You update the baseline when _you_ decide the current state is the new normal:

```bash
little-owl baseline
```

## A worked session

**1. Set up once.**

```bash
npx little-owl-code init
git add .little-owl && git commit -m "Add Little Owl baseline."
```

**2. Tell the assistant what you want, and tell Little Owl the same thing.**

```
You:  "Add bulk cancellation to the orders feature."
```

**3. Review with the scope you actually asked for.**

```bash
little-owl review --scope "features/orders/**"
```

```
18 files changed (uncommitted changes vs HEAD)

⚠ NEEDS REVIEW

Architecture     91 →  86 ↓
Complexity       84 →  79 ↓
Overall          89 →  86 ↓

Since the baseline: +1 circular dependency, +1 skipped-layer import

🔴 1 critical   🟡 2 warnings

⚠ SCOPE

  expected: features/orders/**
  also changed:
    features/auth/ (2 files)
    components/ (1 file)
```

Two things surfaced that the diff would not have: a new cycle, and three files changed in an area you
never mentioned.

**4. Hand the findings back.**

```bash
little-owl prompt
```

```
Review the current changes using these constraints:

1. Remove the circular dependency: features/orders/api.ts -> features/orders/store.ts -> features/orders/api.ts.
2. Restore the layering in features/orders/BulkCancel.tsx: ui -> application -> data.
3. Reduce the size of BulkCancelDialog, without changing behaviour.
4. Do not modify files outside features/orders/**.
5. Preserve the existing behaviour and keep the tests passing.

After making changes, run:

   little-owl review
```

Paste it in. No API key, no integration, no service in the middle.

**5. Review again — against the same baseline.**

```bash
little-owl review --scope "features/orders/**"
```

```
✓ HEALTHY

Architecture     91 →  91   ·
Complexity       84 →  83 ↓
Overall          89 →  89   ·

✓ 3 earlier findings resolved

🦉 Looking good. This change did not introduce new findings.
```

**6. Only now, if you want, move the baseline.**

```bash
little-owl baseline
```

## While you work

```
terminal 1:  npm run dev
terminal 2:  little-owl watch
```

Watch mode stays quiet until something drifts. It compares against your baseline, not against the
file as it was ten seconds ago, so a slow slide still registers.

## Before you open a pull request

```bash
little-owl review --details    # everything, not just the highlights
little-owl impact              # what else could this change affect?
little-owl ci                  # what CI will decide
```

`impact` is particularly useful for writing the "how to test this" section of a PR description: it
lists the routes, modules and tests that reach the code you changed.

## Checking history

```bash
little-owl compare
```

```
review #12    12/08/2026, 14:02
  baseline 91   current 87   degraded

review #13    12/08/2026, 14:31
  baseline 91   current 90   improved
```

The baseline stayed at 91 through both. That is the whole point.
