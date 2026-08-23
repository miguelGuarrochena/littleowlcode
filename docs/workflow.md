# Working with an AI assistant

This is the workflow Little Owl Code was built for.

The short version:

```bash
little-owl init        # once, per project — also writes LITTLE_OWL.md for your agent
little-owl check       # what needs attention, most important first
little-owl explain 1   # what issue #1 means, in plain language
little-owl fix 1       # the plan, and a brief precise enough to hand to an assistant
little-owl verify 1    # confirm it landed
```

Everything below is the same loop, in more detail.

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
   ├── needs review ─► little-owl prompt ─► AI fixes ─► little-owl verify ─┐
   │                                                                        │
   └── degraded ────► revert or fix by hand                                 │
                                                                            │
                                        compare against the SAME ◄──────────┘
                                              baseline
```

The important part: **the baseline does not move between iterations.** Round two is judged against
the same reference as round one, so "the assistant fixed it" and "the assistant moved the problem
somewhere else" look different.

You update the baseline when _you_ decide the current state is the new normal:

```bash
little-owl baseline
```

### Editing the config makes the baseline stale

A baseline records the findings that existed **under one configuration**. Change the configuration —
tighten a threshold, correct the layer model, switch a rule on — and findings that were always there
become visible for the first time. Compared against the old baseline they look new, and the review
blames whatever you happened to be working on.

Little Owl stores a fingerprint of the configuration alongside the baseline and checks it on every
comparison. When the two disagree, `review`, `ci` and `watch` all say so before the verdict:

```
⚠ The configuration changed since this baseline was recorded.
   Findings that already existed can show up as new, so treat the comparison as a guide.
   Run `little-owl baseline` to re-record against the current configuration.
```

Re-recording is still your decision — Little Owl never does it on its own. But now you know when the
comparison stopped being one.

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

**4. Understand the first one before you act on it.**

```bash
little-owl explain 1
```

You get what happened, why it matters for the running app, the file and line, the related files,
what should happen instead, and how to confirm the fix. Add `--technical` for the rule id and the
raw evidence.

**5. Hand the findings back.**

```bash
little-owl prompt              # every open issue, written up as a task
little-owl fix 1 --brief       # or just the first one, ready to pipe
```

The brief carries the file, the line, the enclosing function, the related files, the expected
behaviour, the risks and the acceptance criteria — so the assistant does not spend its first four
steps rediscovering what Little Owl already measured. Use `--compact` for the short numbered list
when context is tight.

Paste it in. No API key, no integration, no service in the middle.

**6. Check the fix actually landed.**

```bash
little-owl verify
```

```
🟢 Issue #1 is fixed   Circular dependency across 2 files
🟢 Issue #2 is fixed   ui imports infrastructure directly

Health   86 → 91   ↑ +5
```

`verify` re-derives every finding from your source, so an issue can only disappear by genuinely
being gone — and it lists anything new that appeared, because a fix that trades one problem for
another is not finished. Add `--tests` to run the project's own test command as part of the check.

**7. Review again — against the same baseline.**

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

**8. Only now, if you want, move the baseline.**

```bash
little-owl baseline
```

## The findings worth interrupting yourself for

Most of what Little Owl reports can wait for a quiet afternoon. Two things cannot, and both come
from the same check: a **secret** (`next/secret-in-client-bundle`) or **server-only code**
(`next/server-module-in-client-bundle`) that a browser component can reach through a chain of
imports.

```bash
little-owl check      # these always sort to #1
```

They are worth treating differently because they are the only findings where the damage is already
done by the time you read them. If the page has been deployed, the value is public — the code fix
closes the hole, but the credential still has to be rotated. `little-owl explain 1` says so, and so
does the brief `little-owl fix 1` hands to your assistant.

This is also the failure mode most specific to AI-assisted work. Ask for "reuse the existing helper"
and you get an import; the assistant has no way to know that three files further down, that helper
reaches the database client. Neither do you, from the diff.

## What Little Owl decided not to look at

`init` prints the scope before it prints anything else:

```
ANALYSING

  src             87 files
  tests           16 files

SKIPPED

  Sample code, not your application:

  tests/fixtures  15 files  (**/fixtures/**)
  examples         1 file  (examples/**)
```

Fixtures, mocks, `examples/`, `testdata/` and `*.stories.*` are excluded by default. They hold code
that is deliberately broken, deliberately tiny, or illustrative, and reporting findings about it is
how a tool convinces someone on day one that it does not understand their project.

If one of those directories really is your application, put the pattern back with a `!`:

```ts
ignore: ['!examples/**'],
```

A `!` removes a built-in pattern; anything else adds one. `little-owl doctor` warns when sample code
is being analysed anyway.

## Telling the assistant the rules up front

`little-owl init` writes `LITTLE_OWL.md` at the project root. Claude Code, Cursor and similar agents
read markdown in the root automatically, so this is where the things they cannot infer from the code
go:

- the loop, and which command answers which question
- your declared layers, and that imports go downwards
- the size limits this project agreed to
- how to read a priority
- what **not** to touch — in particular that making a finding disappear by editing
  `.little-owl/baseline.json` is not a fix

Commit it, and edit it: it is a project document, not a generated artefact. `little-owl agent`
rewrites it and refuses to clobber an edited copy without `--force`.

The pattern this prevents is a familiar one. An assistant is told a check is failing, finds the
file that records the check, and makes the check pass. Saying so once, in a file it will actually
read, is cheaper than catching it every time.

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
