<p align="center">
  <img src="https://raw.githubusercontent.com/miguelGuarrochena/littleowlcode/main/assets/owl.png" alt="" width="112" height="112">
</p>

<h1 align="center">Little Owl Code</h1>

<p align="center"><strong>A second pair of eyes for your codebase.</strong></p>

<p align="center">Keep your codebase healthy while AI writes code.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/little-owl-code"><img src="https://img.shields.io/npm/v/little-owl-code.svg" alt="npm version"></a>
  <a href="https://github.com/miguelGuarrochena/littleowlcode/actions/workflows/ci.yml"><img src="https://github.com/miguelGuarrochena/littleowlcode/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/miguelGuarrochena/littleowlcode/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/little-owl-code.svg" alt="MIT licence"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/little-owl-code.svg" alt="Node version"></a>
</p>

<p align="center">
  <a href="https://littleowlcode.com">littleowlcode.com</a> ·
  <a href="https://littleowlcode.com/docs">Documentation</a> ·
  <a href="https://github.com/miguelGuarrochena/littleowlcode/issues/new?template=false_positive.yml">Report a false positive</a>
</p>

```bash
npx little-owl-code
```

> The npm package is **`little-owl-code`**. Plain `little-owl` on npm is an unrelated project, so
> `npx little-owl` will not fetch this tool. Once installed, the `little-owl` command is yours.

Little Owl reads your project from disk, builds its dependency graph, and tells you what your last
change did to the shape of the codebase — which boundaries it crossed, what got more complex, what
is now duplicated. Then it explains each problem in plain language, tells you exactly where it is,
hands you (or your AI assistant) what is needed to fix it, and checks the fix afterwards.

It is **deterministic** (same code, same findings, every machine), **read-only** (it never edits your
source), and **local**. It never calls an AI model, needs no API key, and sends nothing anywhere.

---

## The problem

AI assistants make you dramatically faster. They also change a lot of files.

You ask for "improve this code" and twenty files change. Another pass changes thirty more. The next
assistant reads the already-modified architecture and changes it again. Each individual step looks
reasonable in the diff. A week later:

- the original architecture is no longer obvious
- abstractions have multiplied
- components have grown
- the dependency graph has knots in it
- the same logic exists in three places
- files were touched that had nothing to do with what you asked for

Nothing was "wrong" at any single step. The codebase still drifted.

**Little Owl Code is not the AI. It is the second pair of eyes watching what the AI does to your
codebase.**

## Built for people building with AI

You do not need to be a security engineer, or an architect, or even a very experienced developer,
to use this. Little Owl is written for the person who built a real application mostly by asking an
assistant for features — and now wants to know whether it is safe to ship.

So every issue it finds answers the same four questions, in plain language:

**what happened · why it matters · where it is · what to do about it**

And every screen ends on one recommended command, so there is never a point where the answer to
"what now?" is _look it up_.

## The whole thing is five commands

```bash
npx little-owl-code init        # set up. Asks nothing.
npx little-owl-code check       # what needs attention, most important first
npx little-owl-code explain 1   # what issue #1 actually means
npx little-owl-code fix 1       # everything needed to fix it, incl. a brief for your AI
npx little-owl-code verify 1    # confirm the fix really landed
```

Everything else is optional.

## See it in action

### `little-owl check` — what needs attention

```
🦉 Little Owl

✓ acme-app — Next.js · TypeScript
✓ Next.js, React detected
✓ 4 source files
✓ Git repository — change reviews will work

✓ Read the project             4 files
✓ Mapped how files connect     4 connections
✓ Checked the architecture     3 layers: ui → application → infrastructure
✓ Checked for common problems  5ms

────────────────────────────────────────────────────────────────────────

Health   95 / 100   ███████████████████░

Your project needs attention.

🔴   2  critical    Fix before your app goes live.
🟠   1  important   Fix soon — this gets more expensive the longer it waits.
🟡   4  minor       Improve when you have time. Nothing is broken.

Start with the 2 critical issues. The rest can wait.

WHERE TO START

🔴 #1   Circular dependency across 2 files
       lib/db/client.ts
       Some of your files depend on each other in a loop:
       lib/db/client.ts -> services/orders.ts -> lib/db/client.ts. Each
       one needs the other to load first.

🔴 #2   infrastructure imports application, which sits above it
       lib/db/client.ts:1
       lib/db/client.ts sits at a lower level of your app but imports
       code from a level above it.

… and 5 more. Run `little-owl check --all` to see every one.

NEXT STEP

  → little-owl explain 1   the full story of the first issue
```

Three things are deliberate here:

- **Every issue has a number.** `#3` is something you can talk about, and something you can type:
  `explain 3`, `fix 3`, `verify 3` all mean the same problem.
- **Levels are explained, not just coloured.** "critical" without "fix before your app goes live"
  is a colour, not information.
- **A long list is not a crisis.** Little Owl says so before you scroll.

### The one it was built to catch

Little Owl follows imports, which means it can see something no diff review and no
file-at-a-time linter can:

```
components/Profile.tsx   "use client"
      ↓ imports
lib/user.ts
      ↓ imports
lib/db.ts                const url = process.env.DATABASE_URL
```

Three reasonable files. No single one of them is wrong. And because everything a client component
imports gets compiled into the page, that database URL is now downloadable by anyone who visits your
site.

```
🔴 #1   A secret can reach the browser through this component
       components/ProfileCard.tsx
       Following the imports out of components/ProfileCard.tsx leads to
       code that reads a password or key from your environment — and
       everything on that path is sent to the browser.
```

`little-owl explain 1` names the exact chain, explains what a visitor can actually do with it, and
tells you to rotate the credential as well as change the code — because if the page has shipped, the
value is already public.

Just as importantly, it stays quiet about the things that only _look_ like this: Server Actions
(that is the correct pattern, and the fix these findings recommend), `import type`, server
components, and anything with a `NEXT_PUBLIC_` prefix. See
[docs/rules.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/docs/rules.md#the-clientserver-boundary).

### `little-owl explain 3` — what it actually means

```
🟠 IMPORTANT  issue #3

ui imports infrastructure directly

What happened
  components/Orders.tsx reaches straight past the level directly below it
  and talks to the one after that.

Why this matters
  A screen talking straight to the database skips whatever the middle
  layer was doing — permission checks, validation, business rules. That
  logic silently stops applying on this path, and it is easy to miss
  because the feature still appears to work.

Where
  components/Orders.tsx:3

Related files
  app/dashboard/page.tsx  — uses this file
  lib/db/client.ts  — this file uses it

How it connects
  app/dashboard/page.tsx
     ↓
  components/Orders.tsx
     ↓
  lib/db/client.ts

What should happen instead
  Each level should talk to the one directly below it, so the rules living
  in between always run.

Recommended fix
  Route the call through the layer in between. If no function exists there
  yet, add one that wraps the lower-level call along with whatever checks
  belong with it.

How to check it worked
  Run `little-owl verify`, then exercise the feature and confirm the
  checks in the middle layer actually run.

In plain words
  layer: A layer is a level of your app — screens on top, business logic
  in the middle, database at the bottom. Code should call downwards, not
  upwards.

Next step
  → little-owl fix 3
```

No rule ids, no "cyclomatic complexity", no acronyms left undefined. Add `--technical` when you do
want the rule id and the raw evidence — it is one flag away, not the default.

### `little-owl verify` — did it actually work?

```
🦉 Little Owl

Checking whether the fix landed…

✓ Re-read the project           4 files
✓ Compared with the last check  7 issues then

────────────────────────────────────────────────────────────────────────

🟢 Issue #1 is fixed   Circular dependency across 2 files

Health   95 → 99   ↑ +4

Your project looks solid. A few things are worth fixing soon.

NEXT STEP

  → little-owl fix 2   next up: infrastructure imports application
```

`verify` re-derives the finding from your source, so an issue can only disappear by actually being
gone. It also reports anything the fix introduced — a fix that trades one problem for another is
not finished. Add `--tests` to run your project's own test command as part of the check.

### `little-owl review` — what did my last change do?

```
🦉 Little Owl

Looking at what changed…

✓ 12 files changed   +486 -73, 3 areas
  uncommitted changes vs HEAD
✓ Compared with the baseline recorded 2 days ago

Health   89 → 83   ↓ -6

This change introduced something that needs fixing before release.

🔴   1  critical    Fix before your app goes live.
🟠   3  important   Fix soon — this gets more expensive the longer it waits.

✓ 1 earlier issue no longer appears.

WHAT THIS CHANGE INTRODUCED

🔴 #1   Client component imports a server-only package
       app/settings/page.tsx:2
       app/settings/page.tsx runs in the browser but imports code that is
       only supposed to run on your server.

NEXT STEP

  → little-owl explain 1   what this issue actually means
```

- **The arrow is the point.** `89 → 83` is the distance from your baseline, not an absolute grade.
- **Only what this change introduced** is listed. Pre-existing debt stays quiet.

## What it does not look at

Fixtures, mocks, `examples/`, `testdata/`, `__snapshots__/` and `*.stories.*` are excluded by
default, alongside the usual build output. That code is deliberately broken, deliberately tiny or
purely illustrative, and findings about it are all true and all useless.

`init` prints what it is analysing and what it skipped, with the pattern responsible, so you can
disagree straight away:

```
SKIPPED

  Sample code, not your application:

  tests/fixtures  15 files  (**/fixtures/**)
  examples         1 file  (examples/**)
```

If one of them really is your application, put the pattern back with a `!` in `ignore`:

```ts
ignore: ['!examples/**'],
```

## When Little Owl is wrong

It will be, sometimes. `explain` and `fix` both end with the narrowest way to dismiss a finding —
excluding a path when the code is not yours to fix, raising a threshold when you do not share the
budget, or switching the rule off — and the brief handed to your AI assistant explicitly permits
saying "this is a false positive" instead of changing correct code.

The client/server boundary findings are the exception: no dismissal is offered for a leaked
credential.

## Priorities

Little Owl never presents everything as equally urgent.

|     | Level         | What it means                                            |
| --- | ------------- | -------------------------------------------------------- |
| 🔴  | **critical**  | Fix before your app goes live.                           |
| 🟠  | **important** | Fix soon — this gets more expensive the longer it waits. |
| 🟡  | **minor**     | Improve when you have time. Nothing is broken.           |

A project with a hundred findings is usually a project with two real problems and ninety-eight
notes. Little Owl says that out loud rather than handing you a wall.

## Why a linter is not enough

ESLint, Ruff and `golangci-lint` are excellent, and Little Owl does not try to replace them. They
answer _"is this line acceptable?"_

Little Owl answers a different question: _"is this codebase in better or worse shape than it was
before this change?"_ That question needs three things a line-level linter does not have:

|                   | Linter             | Little Owl Code                       |
| ----------------- | ------------------ | ------------------------------------- |
| Unit of judgement | one line, one file | the project over time                 |
| Memory            | none               | a baseline you control                |
| Change awareness  | none               | git-aware: new vs pre-existing        |
| Architecture      | mostly no          | layers, cycles, boundaries            |
| Reachability      | no                 | can a browser component reach this?   |
| Scope             | n/a                | did this change stay where it should? |

The reachability row is the clearest example. A secret leaking into your client bundle through three
files is invisible to any tool that reads one file at a time, because none of the three files is
wrong. It is only visible to something holding the whole import graph.

Run both. They are not competing.

## The three ideas

Everything in Little Owl is built on three concepts.

### 1. Baseline

The baseline is your record of what "healthy" looks like for _this_ project. It stores metrics, the
counts behind them, and the findings that existed when you took it.

```bash
little-owl baseline        # record the current state
little-owl baseline --show # see what is recorded
```

**Little Owl never updates the baseline on its own.** That rule matters more than it sounds. If the
baseline moved after every AI iteration, "healthy" would silently be redefined as "whatever the code
is right now", and steady degradation would become invisible. Updating it is always your call.

A baseline also records **which configuration produced it**. Tighten a threshold or correct your
layers and findings that were always there become visible for the first time — against the old
baseline they look new, and the review blames whatever you were working on. Little Owl compares the
two and says so before the verdict:

```
⚠ The configuration changed since this baseline was recorded.
   Findings that already existed can show up as new, so treat the comparison as a guide.
   Run `little-owl baseline` to re-record against the current configuration.
```

### 2. Scope

What was this change _supposed_ to touch?

```bash
little-owl review --scope "features/orders/**"
```

If files outside that area changed, Little Owl says so and shows which areas were affected. It does
not block anything — that is your decision, unless you configure CI to fail on it.

### 3. Drift

Did the project move away from the baseline, and _why_?

```
Architecture     91 →  84 ↓
Complexity       84 →  71 ↓

Since the baseline: +2 circular dependencies, +3 skipped-layer imports, +812 lines
```

Every score change can be traced back to concrete counts. A number you cannot explain is not worth
showing.

## The AI development loop

This is what the product is for.

```
little-owl init
        ↓
your AI assistant makes changes
        ↓
little-owl review          what did that do to the project?
        ↓
little-owl prompt          a brief built from the real findings
        ↓
your AI assistant fixes them
        ↓
little-owl verify          did the fixes actually land?
        ↓
little-owl review          again — against the SAME baseline
```

Reviewing the fix against the same reference is what stops the second pass from quietly accepting
the damage of the first. `verify` is what stops "fix applied" from being taken on trust.

### The brief Little Owl writes

`little-owl prompt` does not hand your assistant a list of complaints. It hands it a worked
problem:

````markdown
## Issue #1: Client component imports a server-only package

- **Priority:** critical — Fix before your app goes live.
- **Rule:** `next/server-import-in-client`
- **File:** `app/settings/page.tsx:2`
- **Function:** `SettingsPage()`

### Current behaviour

app/settings/page.tsx runs in the browser but imports code that is only
supposed to run on your server.

### Why it matters

This is a real security risk. Server code often holds database credentials
or API keys, and anything the browser bundle contains can be read by anyone
who visits your site.

### Expected behaviour

Server code stays on the server. The browser receives only the results it
is allowed to see.

### Related files

- `lib/db/client.ts` — this file uses it

### Risks

If a secret has already been deployed in a client bundle, treat it as
leaked and rotate it. Removing the import does not un-publish what already
shipped.

### Constraints

- Fix only what this issue names. Do not refactor surrounding code.
- Do not change existing behaviour.
- Do not add new dependencies.
- Do not edit `.little-owl/baseline.json` or weaken rules to make the
  finding disappear.

### Acceptance criteria

- [ ] Server code stays on the server.
- [ ] `little-owl verify 1` reports the issue as fixed.
- [ ] The existing tests still pass, unchanged.
- [ ] No file outside the ones named above was modified.

### How to verify

```bash
little-owl verify 1
npm run test
```
````

The point is that the assistant does not have to re-investigate anything. Little Owl already knows
the file, the line, the enclosing function, the related files and how to check the result — and its
version of those is measured, where the assistant's would be a guess.

Use `--compact` for a short numbered list instead, when context budget is tight.

Little Owl writes the prompt; **you** paste it into Claude Code, Cursor, Codex, Copilot or whatever
you use. There is no integration with any of them, and none is needed — the output is text.

### `LITTLE_OWL.md`

`init` also writes a `LITTLE_OWL.md` at your project root. Claude Code, Cursor and similar tools
pick up markdown in the repository root automatically, and this file tells them the things they
cannot infer from the code:

- the loop, and which command to run when
- your declared layers, and that imports go downwards
- the size limits this project agreed to
- how to read a priority
- what **not** to touch — in particular, that making a finding disappear by editing
  `.little-owl/baseline.json` is not a fix

Commit it. Edit it — it is yours. `little-owl agent` rewrites it, and refuses to clobber an edited
copy unless you pass `--force`.

## Install

```bash
npm install -D little-owl-code
```

or run it without installing:

```bash
npx little-owl-code
```

Requires Node.js 18.18 or newer. After installing, the binary is available as `little-owl`:

```bash
npx little-owl check
```

> **Note on the name:** the npm package is `little-owl-code`. The unrelated package name
> `little-owl` is already taken on npm by a different project, so `npx little-owl` will not fetch
> this tool — use `npx little-owl-code`. Once installed, the `little-owl` command is yours.

## Quick start

```bash
# 1. Set up. Detects your stack and structure, asks nothing.
npx little-owl-code init

# 2. See what needs attention
npx little-owl-code check

# 3. Understand the first issue
npx little-owl-code explain 1

# 4. Get everything you need to fix it
npx little-owl-code fix 1

# 5. Confirm it actually landed
npx little-owl-code verify 1
```

Then, once your assistant has been working:

```bash
npx little-owl-code review      # what did that change do?
npx little-owl-code prompt      # the open issues, written up for your AI
```

Running `little-owl` with no arguments opens interactive mode, which is the friendliest way in.

**Little Owl never edits your source files.** `fix` prepares the change and tells you — or your
assistant — exactly what to do; it does not do it behind your back.

## Commands

**The loop** — this is all most people need

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `little-owl`             | Interactive mode                                           |
| `little-owl init`        | Set up. Detects your stack and structure, asks nothing     |
| `little-owl check`       | What needs attention, most important first                 |
| `little-owl explain <n>` | What issue #n means, in plain language                     |
| `little-owl fix <n>`     | Everything needed to fix it, including a brief for your AI |
| `little-owl verify [n]`  | Did the fix actually land? (`--tests` runs your tests too) |

**Working with an AI assistant**

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `little-owl prompt` | The open issues, written up as a task for your AI   |
| `little-owl agent`  | Write `LITTLE_OWL.md`, the briefing file for agents |

**Reviewing changes**

| Command               | What it does                             |
| --------------------- | ---------------------------------------- |
| `little-owl review`   | What did the recent changes do?          |
| `little-owl watch`    | Report drift while you work              |
| `little-owl baseline` | Record the reference state               |
| `little-owl compare`  | Recent reviews against the same baseline |

**Exploring a codebase** — see [docs/exploring.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/docs/exploring.md)

| Command                     | What it does                                            |
| --------------------------- | ------------------------------------------------------- |
| `little-owl map`            | High-level map: areas, entry points, what to read first |
| `little-owl explain <file>` | Why does this code exist? (reads git history)           |
| `little-owl impact [file]`  | What could changing this affect?                        |
| `little-owl tests`          | Behaviour no test appears to watch                      |
| `little-owl dead-code`      | Files nothing appears to reach                          |

**Analysis**

| Command                   | What it does                             |
| ------------------------- | ---------------------------------------- |
| `little-owl architecture` | Layers, coverage and boundary violations |
| `little-owl dependencies` | Declared vs actually imported packages   |

**CI, configuration and diagnostics**

| Command             | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `little-owl ci`     | Non-interactive check with an exit code           |
| `little-owl config` | Settings in effect (`--rules` to list every rule) |
| `little-owl doctor` | Is Little Owl seeing this project properly?       |

> `explain` takes either an issue number or a file path. `explain 3` is the issue; `explain
src/auth.ts` is that file's history. Both were already the natural thing to type.

Useful flags: `--json` (every command), `--all` (`check`), `--details` (`check`, `review`,
`architecture`), `--technical` (`explain`), `--quiet`, `--scope`, `--base <ref>`, `-C <dir>`,
`--no-color`, `--no-cache` (analyse without writing anything to the project). Each command's own
`--help` is authoritative.

### If something goes wrong

Errors say what happened, why, and what to run next:

```
🦉 Little Owl has not looked at this project yet, so there are no numbered
   issues to work from.

Try:

   little-owl check
```

`little-owl doctor` is the command to reach for when the output itself looks wrong.

### review

The main command. It inspects the current git changes — added, modified, deleted and renamed files —
re-analyses the project, and compares against the baseline.

By default only the highest-signal findings are shown, and only what is _new_ since the baseline.
Existing debt is not repeated at you every run. `--details` shows everything.

```bash
little-owl review                              # vs whatever changed recently
little-owl review --base origin/main           # vs a specific ref
little-owl review --scope "features/orders/**" # and flag anything outside that
little-owl review --details                    # every finding, not just the new ones
```

### watch

```bash
little-owl watch
```

Little Owl does not take over your dev server. Run them side by side:

```
terminal 1:  npm run dev
terminal 2:  little-owl watch
```

Watch mode stays quiet unless something actually drifted. It measures against a fixed reference (your
baseline if you have one), not against the state a second ago — otherwise slow degradation would
never register.

**What it actually does on each save.** Every run is a full analysis: the whole dependency graph is
rebuilt and every rule runs again. What is incremental is _parsing_ — files you have not touched are
reused from the parse cache, which is the expensive part. On a large repository expect each run to
take about as long as `little-owl check` does.

New findings are grouped by how they relate to what you just saved:

```
Changed
  src/services/orders.ts
  3 files import this, directly or indirectly

In the files you changed
  ...
In files that depend on the change
  ...
Elsewhere in the project, not caused by this change
  ...
```

That last group matters. A finding in a file you have not touched is reported under its own heading
rather than being listed beneath the file you just saved, because reachability through imports is
the only honest link available — Little Owl cannot know that your edit caused a problem in a module
that neither imports nor is imported by it.

Edits made while an analysis is already running are kept and picked up by the next one, so nothing
you type during a slow run is lost.

### prompt

This is the loop that stops the AI-review snowball.

```bash
little-owl prompt              # the full brief, with file, line and acceptance criteria
little-owl prompt --compact    # a short numbered list, for a tight context budget
little-owl prompt --all        # include debt that predates this change
little-owl prompt -n 2         # fewer issues per brief
```

The full brief is shown under [The AI development loop](#the-ai-development-loop). The compact form
is the original one-liner list:

```
Review the current changes using these constraints:

1. Remove the circular dependency: orders.ts -> users.ts -> auth.ts -> orders.ts.
2. Restore the layering in components/Orders.tsx: ui -> application -> infrastructure.
3. Reduce the size of OrdersPage, without changing behaviour.
4. Do not modify files outside features/orders/**.
5. Preserve the existing behaviour and keep the tests passing.

After making changes, run:

   little-owl review
```

Paste it into Claude Code, Cursor, Codex, Copilot, or whatever you use. Then review again —
**against the same baseline**. That is what keeps the second pass honest:

```
AI change → review → findings → AI fix → verify → review → compare to the SAME baseline
```

The brief is built only from findings that actually exist, capped so the list stays actionable.
**Little Owl never calls a model, needs no API key, and sends nothing anywhere.** It writes the
text; you decide what to do with it.

### fix and verify

```bash
little-owl fix 1              # the plan, the files involved, and the AI brief
little-owl fix 1 --brief      # only the brief, ready to pipe: `... --brief | pbcopy`
little-owl verify 1           # is issue #1 gone?
little-owl verify             # everything you had open, plus anything new
little-owl verify --tests     # and run this project's own test command
```

`fix` never edits your files. It answers "what changes, what is the goal, and what exactly do I say
to my assistant" — and then gets out of the way.

`verify` re-runs the analysis and matches findings by fingerprint, so an issue can only count as
fixed by genuinely not reproducing. It also lists anything that appeared since, because a fix that
trades one problem for another is not a fix. `verify <n>` exits non-zero while issue _n_ is still
there; `verify` on its own is a status report and exits 0 unless your tests fail.

### ci

```bash
little-owl ci
```

Deterministic, non-interactive, exit code driven. By default it fails only on **new** error-level
findings, so a project with existing debt can adopt Little Owl without fixing everything first.

```bash
little-owl ci --json                  # machine readable
little-owl ci --fail-on warning       # stricter
little-owl ci --all                   # count pre-existing findings too
little-owl ci --max-drop 3            # fail if the overall score falls more than 3
```

#### GitHub Action

```yaml
name: Little Owl Code

on:
  pull_request:

jobs:
  little-owl:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # so the base branch is available for comparison

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npx little-owl-code ci --base origin/${{ github.base_ref }}
```

Commit `.little-owl/baseline.json` so CI compares against the state your team agreed on.

## Understanding an unfamiliar codebase

Five commands that explain rather than judge. Full details in
[docs/exploring.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/docs/exploring.md).

```bash
little-owl map                       # where is everything, what should I read first
little-owl explain src/Payments.ts   # why does this file exist?
little-owl impact src/Payments.ts    # what could changing it affect?
little-owl tests --changed           # what behaviour has no test watching it
little-owl dead-code                 # what does nothing reach any more
little-owl doctor                    # is Little Owl seeing this project properly
```

Each of these reports how much to trust it. `explain` states whether the evidence is `strong`,
`partial` or `none`, and says plainly when the history records no reason rather than inventing one.
`dead-code` grades every candidate `high`, `medium` or `low` and lists what undermines the
conclusion. `impact` reports a `risk` level and lowers its `confidence` when a dynamic import could
reach further than it can see.

## What it checks

**Architecture** — circular dependencies, inverted layer dependencies, skipped layers, cross-feature
imports, configured forbidden edges, very deep import chains.

**The client/server boundary** — secrets and server-only code that a browser component can reach
_through a chain of imports_, not just by importing them directly. This is the one a linter
structurally cannot find, because no individual file is wrong. Server Actions, `import type` and
`NEXT_PUBLIC_` variables are correctly left alone.

**Complexity** — oversized files, functions and React components, cyclomatic complexity, deep
nesting, long parameter lists.

**Maintainability** — duplicated blocks, unresolved imports, `useEffect` with no dependency array.

**Type safety** — clusters of `any`, `@ts-ignore`, assertions through `any`/`unknown`, plain
JavaScript files in a TypeScript project.

**Patterns** — the same helper implemented twice, two modules implementing one concept in parallel,
modules that only forward a call, directories full of single-use abstractions. These are shapes that
appear whenever changes are made without seeing the whole codebase. Little Owl reports the shape; it
never claims to know who wrote the code.

**Dependencies** — major version jumps, newly added packages, declared-but-never-imported packages,
packages declared in both dependency lists.

**Python** — bare `except:`, mutable default arguments, module-level `global` state, import cycles.

**Go** — package cycles, discarded return values, oversized packages.

Every one of these comes with a plain-language explanation of what it means for your running
application, what should happen instead, and how to confirm the fix — not just a rule name.

## Supported languages

| Language         | How it is parsed           | Depth                                         |
| ---------------- | -------------------------- | --------------------------------------------- |
| TypeScript / TSX | TypeScript compiler API    | Full syntax tree                              |
| JavaScript / JSX | TypeScript compiler API    | Full syntax tree                              |
| Python           | Line and indentation based | Imports, functions, known smells              |
| Go               | Line and brace based       | Package, imports, functions, discarded values |

Frameworks detected automatically: Next.js, React, Vue, Nuxt, Svelte, Angular, Astro, Vite, Express,
NestJS, Fastify, Hono, Remix, Django, FastAPI, Flask, Go modules. Monorepos: pnpm workspaces, npm and
yarn workspaces, Turborepo, Nx.

## Configuration

Everything is optional. `little-owl init` writes `.little-owl/config.ts`:

```ts
export default {
  strictness: 'balanced', // 'relaxed' | 'balanced' | 'strict'

  architecture: {
    // Layers top to bottom. A layer may depend on the one below it.
    layers: {
      ui: ['app', 'components'],
      application: ['services', 'domain'],
      data: ['repositories', 'lib/db'],
    },
    layerPolicy: 'adjacent', // 'adjacent' | 'downward'
    featureRoot: 'features',
    forbidden: [['components/**', 'lib/db/**']],
  },

  thresholds: {
    maxFileLines: 800,
    maxFunctionLines: 100,
    maxComponentLines: 800,
    maxComplexity: 15,
  },

  rules: {
    'architecture/circular-dependency': 'error',
    'architecture/layer-violation': 'error',
    'architecture/layer-skip': 'warning',
    'complexity/large-file': 'warning',
  },

  ignore: ['generated/**'],

  ci: {
    failOn: 'error',
    maxOverallDrop: 5,
  },
};
```

Installing the package as a dev dependency gets you type checking on that file:

```ts
import { defineConfig } from 'little-owl-code';

export default defineConfig({/* … */});
```

The generated config deliberately does not import anything, so it keeps working when Little Owl is
run through `npx` and never installed into the project.

**`strictness`** picks the preset every threshold and several rule severities start from.

**`layerPolicy`** decides how strict layering is. `adjacent` means UI may only use the layer directly
below it, so `ui → data` is reported as a skipped layer. `downward` allows any lower layer.

**Severities** are `off` | `info` | `warning` | `error`. `little-owl config --rules` lists every rule
with its current severity.

**`ignore`** adds glob patterns on top of the built-in list; your root `.gitignore` is read as well.

**Paths are written the same way everywhere.** Layer directories, `forbidden` patterns and `scope`
all accept the bare form (`components/**`) and match `src/components/**` too, so a project with a
`src/` wrapper does not need two spellings.

**Configuration is checked, not just read.** Unknown keys, rule ids that no rule answers to, invalid
severities and patterns that match nothing are all reported, with a suggestion where there is an
obvious one. A silently ignored setting looks exactly like a rule that found no problems, so none of
them stay quiet:

```
⚠ .little-owl/config.ts
  thresholdz is not a Little Owl setting — did you mean "thresholds"?
  rules: "complexity/large-fil" is not a rule, so this severity is ignored — did you mean "complexity/large-file"?
```

`little-owl doctor` adds the ones that need the project to answer — a layer directory or a
`forbidden` pattern that matches no file.

Config can also live at `.little-owl/config.{js,mjs,json}`, `little-owl.config.{ts,js,mjs,json}`,
`.littleowlrc.{ts,js,mjs,json}`, or a bare `.littleowlrc` (JSON).

**Layers you do not declare are not checked.** Boundary rules need both ends of an import to belong
to a layer, so a model reaching part of the tree reports "no violations" about the part it saw.
`little-owl architecture` prints the coverage under every verdict and names the largest directories
sitting outside the model, and the architecture score withholds points for what it could not check —
stated in the `architecture/unlayered-code` finding rather than deducted silently.

```
⚠ No boundary violations among the 68% of files inside a layer.

Coverage: 161 of 236 source files are inside a layer (68%)

Not covered by any layer:
  src/lib                      32 files
  src/lib/facial               15 files
```

If there is no config at all, Little Owl still works: it infers layers from your directory names and
says so in the output. An inferred structure is a guess, and it is labelled as one.

## Limitations

Worth being straight about:

- **Scores are heuristics.** They are useful for comparing a project against its own past, not for
  comparing different projects. The findings matter more than the number.
- **Inferred layers are guesses.** Little Owl says when it inferred them. Configure your layers to
  get checks you can trust.
- **Python and Go analysis is shallow.** It is line-based, not a full parse: imports, function
  boundaries, sizes and a handful of known smells. It will not replace Ruff or `golangci-lint`, and
  it is not meant to. Two consequences worth knowing: Go exports are detected from capitalised
  _functions_ only, so exported types, constants and variables are invisible to the dead-code and
  pattern rules; and Python's `__init__.py` re-exports are not followed, so a module reached only
  through a package export can look unreferenced. Both lower the confidence Little Owl reports
  rather than producing silent false positives.
- **Impact analysis is reachability, not proof.** "Potentially affected" means exactly that.
- **Unused-dependency detection can be wrong.** Packages loaded through configuration or at runtime
  look unused. The finding is a prompt to check, not a verdict.
- **Duplicate detection is textual.** It finds copy-paste, not semantically equivalent code, and it
  only reports a block once it reaches `minDuplicateLines` — 8 by default, 6 under `strict`. Two
  near-identical six-line helpers will not be reported at the default setting.
- **Dead code detection is reachability, not proof.** Framework conventions, dynamic imports and
  configuration keep files alive without an import. Confidence levels say how much each candidate
  can be trusted, and Little Owl never deletes anything. Unused _exports_ are reported too, but only
  for TypeScript and JavaScript, and never for a module something imports wholesale.
- **Test gaps are a risk signal, not coverage.** Little Owl follows imports and names; it does not
  run your tests. Use a coverage tool for real numbers.
- **`explain` only reports what the repository records.** If no commit message says why something
  exists, it says so instead of guessing.
- **It is not a security scanner.** For vulnerabilities, run your package manager's audit command.
- **A single run scans at most 20,000 source files.** The cap stops an accidental run against a home
  directory from taking an hour. If a project reaches it, every report says so — `check`, `review`,
  `ci` and `doctor` all mark the analysis as partial, and `--json` carries `truncated: true`. Narrow
  the analysis with `include` or `ignore` rather than trusting a truncated score.
- **Watch mode re-runs every rule on each save.** Only parsing is incremental. It also cannot prove
  that your edit caused a finding elsewhere, so it groups findings by import reachability and labels
  anything it cannot connect to the change.

## Privacy

Little Owl Code is **read-only** and **offline**.

- **No network calls.** There is no networking code in the package to audit.
- **No telemetry.** Not opt-out — absent.
- **No API key, and no AI service.** Little Owl never calls a model.
- **It never modifies your application source code.** It only writes to `.little-owl/`.
- **It never commits, stages, checks out or pushes anything.** Git is read from, never written to.

`.little-owl/config.ts` and `.little-owl/baseline.json` are meant to be committed — they are what
your team agreed on. `.little-owl/cache/` (the parse cache) and `.little-owl/history.json` (your
local review log) are machine state. Little Owl writes `.little-owl/.gitignore` covering those two
the first time it writes anything there, so the cache cannot drift into a pull request. An ignore
file you already have is extended, never overwritten.

Every command that analyses a project also accepts `--no-cache`, which writes nothing at all.

See [SECURITY.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/SECURITY.md).

## Programmatic use

```ts
import { analyzeProject, loadConfig } from 'little-owl-code';

const config = await loadConfig(process.cwd());
const { result } = await analyzeProject({ root: process.cwd(), config });

console.log(result.metrics.overall);
for (const finding of result.findings) {
  console.log(finding.severity, finding.file, finding.title);
}
```

The plain-language layer is exported too, so an editor extension or a bot can say the same things
the CLI says:

```ts
import { analyzeProject, numberFindings, resolveGuidance, renderIssueBrief } from 'little-owl-code';

const { result, context } = await analyzeProject({ root: process.cwd() });

for (const issue of numberFindings(result.findings)) {
  const { what, why, expected, fix, verify } = resolveGuidance(issue);
  console.log(`#${issue.number} ${issue.title}`, { what, why, expected, fix, verify });
}

// Or the whole thing as a task for an AI assistant:
const [first] = numberFindings(result.findings);
if (first) console.log(renderIssueBrief(first, { context, root: process.cwd() }));
```

## Changelog

See [CHANGELOG.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/CHANGELOG.md).
If you are upgrading from 0.1.x, read the note at the top of the 0.2.0 entry first — sample code is
no longer analysed by default, which moves the file count and the score on most projects.

## Contributing

See [CONTRIBUTING.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/CONTRIBUTING.md).

```bash
pnpm install
pnpm check   # typecheck + lint + test + build
```

## Roadmap

Not in this version, possibly later: VS Code extension, GitHub PR bot, GitLab integration, optional
AI provider integration, architecture visualisation, historical dashboards, team and organisation
policies, and more language adapters (Rust, Java, C#, Kotlin, PHP).

None of these exist today.

## Support

- **Bugs and false positives** — [open an issue](https://github.com/miguelGuarrochena/littleowlcode/issues).
  There is a template specifically for false positives, and they are triaged as bugs.
- **Security** — see [SECURITY.md](https://github.com/miguelGuarrochena/littleowlcode/blob/main/SECURITY.md). Report privately, not as a public issue.
- **Anything else** — `info@littleowlcode.com`.

## License

MIT © [Miguel Guarrochena](https://littleowlcode.com)
