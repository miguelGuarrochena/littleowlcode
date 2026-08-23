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
is now duplicated.

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

## See it in action

After your assistant finishes, ask what it did:

```bash
little-owl review
```

```
╭──────────────────────────────────────────────╮
│  🦉 CODEBASE REVIEW                          │
╰──────────────────────────────────────────────╯

12 files changed (uncommitted changes vs HEAD)
+486 -73 lines   across 3 areas

✗ DEGRADED

Architecture     91 →  84 ↓
Maintainability  87 →  87   ·
Complexity       84 →  71 ↓
Dependencies     95 →  94 ↓
Type Safety      91 →  87 ↓
Overall          89 →  83 ↓

Since the baseline: +1 circular dependency, +2 skipped-layer imports

🔴 1 critical   🟡 3 warnings

FINDINGS

🔴 architecture  ui imports infrastructure directly
   components/Orders.tsx:4

   components/Orders.tsx imports lib/db/client.ts, skipping the application
   layer. The structure detected in this project is ui -> application ->
   infrastructure.

   found:    ui -> infrastructure
   expected: ui -> application -> infrastructure

   → Route the call through application instead of importing infrastructure
   from here.
```

Reading that output:

- **The arrows are the point.** `91 → 84` is the distance from your baseline, not an absolute grade.
- **"Since the baseline"** names the counts behind the movement. Every score change traces back to
  something you can go and look at.
- **Only what this change introduced** is listed. Pre-existing debt stays quiet.
- **Each finding says what, where, why it matters, and what to do.**

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
| Scope             | n/a                | did this change stay where it should? |

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
little-owl review          again — against the SAME baseline
```

The last step is the one that makes the loop honest. Reviewing the fix against the same reference is
what stops the second pass from quietly accepting the damage of the first.

Little Owl writes the prompt; **you** paste it into Claude Code, Cursor, Codex, Copilot or whatever
you use. There is no integration with any of them, and none is needed — the output is text.

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
# 1. Set up: detects your structure, writes config, records a baseline
npx little-owl-code init

# 2. Let your AI assistant do its thing

# 3. See what it did
npx little-owl-code review
```

If there are findings worth fixing:

```bash
npx little-owl-code prompt
```

Running `little-owl` with no arguments opens interactive mode, which is the friendliest way in.

## Commands

**Get started**

| Command            | What it does                     |
| ------------------ | -------------------------------- |
| `little-owl`       | Interactive mode                 |
| `little-owl init`  | Set up config and a baseline     |
| `little-owl check` | Health of the codebase right now |

**Reviewing changes**

| Command               | What it does                             |
| --------------------- | ---------------------------------------- |
| `little-owl review`   | What did the recent changes do?          |
| `little-owl watch`    | Report drift while you work              |
| `little-owl baseline` | Record the reference state               |
| `little-owl compare`  | Recent reviews against the same baseline |
| `little-owl prompt`   | Write a brief for your AI assistant      |

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

Useful flags: `--json` (every command), `--details` (`check`, `review`, `architecture`), `--quiet`,
`--scope`, `--base <ref>`, `-C <dir>`, `--no-color`, `--no-cache` (analyse without writing anything
to the project). Each command's own `--help` is authoritative.

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
little-owl prompt
```

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

Paste that into Claude Code, Cursor, Codex, Copilot, or whatever you use. Then review again —
**against the same baseline**. That is what keeps the second pass honest:

```
AI change → review → findings → AI fix → review → compare to the SAME baseline → accept or reject
```

The instructions are built only from findings that actually exist, capped so the list stays
actionable. **Little Owl never calls a model, needs no API key, and sends nothing anywhere.** It
writes the text; you decide what to do with it.

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
imports, configured forbidden edges, very deep import chains, Next.js client components reaching
server-only code.

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
