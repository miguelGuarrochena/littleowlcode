# Changelog

Notable changes to Little Owl Code. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/) — while it is on `0.x`, breaking changes bump the minor.

## [0.2.0] — 2026-08-23

The report was rewritten around one question: after reading this, do you know what to do next?

### Read this first if you are upgrading

Two changes move numbers you may be comparing against.

- **Sample code is no longer analysed.** Fixtures, mocks, `examples/`, `testdata/`,
  `__snapshots__/` and `*.stories.*` are excluded by default. On a project that has any of these,
  the file count drops, the score moves and existing baselines will report drift. Re-record with
  `little-owl baseline` once you have looked at the new numbers.
- **Two new rules default to `error`**, so a project that leaks a secret into its client bundle
  will start failing `little-owl ci`. That is the intent; if you need to land it in stages, set
  them to `warning` in `.little-owl/config.ts` while you work through them.

The parse cache format changed, so the first run after upgrading re-parses everything.

### Added

- `little-owl explain <n>` — what an issue means, in plain language: what happened, why it
  matters for the running application, where it is, what should happen instead, how to fix it and
  how to confirm the fix. `--technical` adds the rule id and raw evidence.
- `little-owl fix <n>` — the files involved, the goal, and a brief precise enough to hand to an AI
  assistant. `--brief` prints only the brief. Little Owl still never edits your source.
- `little-owl verify [n]` — re-derives the findings from your code, so an issue can only disappear
  by genuinely being gone. Reports anything the fix introduced. `--tests` runs your own test
  command as part of the check.
- `little-owl agent` — writes `LITTLE_OWL.md`, the briefing file Claude Code, Cursor and similar
  agents read: the loop, your layers, the limits, and what not to touch.
- **Client/server boundary detection.** `next/secret-in-client-bundle` and
  `next/server-module-in-client-bundle` follow the import graph from every `"use client"` module
  and report code that was never meant to reach a browser — including through a chain of
  intermediate files, which no file-at-a-time linter can see. Server Actions, `import type`,
  server components and `NEXT_PUBLIC_`-prefixed variables are correctly left alone.
- `architecture/unlayered-code` — names the part of the tree no declared layer covers, so
  "no boundary violations" cannot quietly mean "nothing was checked".
- **Issue numbers.** Every finding is numbered in priority order, and the number means the same
  thing in `check`, `explain`, `fix` and `verify`.
- **A way to say a finding is wrong.** `explain` and `fix` both end with the narrowest way to
  dismiss it — excluding a path, moving a threshold, or switching the rule off — and the AI brief
  explicitly permits rejecting a false positive instead of changing correct code.
- `ignore` entries may start with `!` to remove one of the built-in patterns.
- `--all` on `check`; `--compact` on `prompt`; `--technical` on `explain`; `--interactive` and
  `--no-agent-file` on `init`.
- `priority`, `number` and `priorities` in `--json` output. `schemaVersion` stays at `1` — these
  are additive.

### Changed

- **`init` asks nothing.** The stack, structure and layers are read from disk. It prints what it
  is analysing and what it skipped, with the pattern responsible, before writing anything. The old
  questionnaire is behind `--interactive`.
- **Reports speak in priorities** — 🔴 critical, 🟠 important, 🟡 minor — each with a line saying
  what that level means. Rules are still _configured_ with `error` / `warning` / `info`; both
  appear in `--json`.
- `check` leads with a verdict and one recommended next command instead of a metric table. The
  full table is behind `--details`.
- `explain` accepts an issue number as well as a file path. `explain <file>` still reads git
  history, unchanged.
- `prompt` writes a full brief — file, line, enclosing function, related files, expected
  behaviour, risks, acceptance criteria — rather than a list of one-line instructions. The old
  form is `--compact`.
- Errors say what happened, why, and which command to run next.
- Progress output moved from stdout to stderr, so nothing decorative can reach a pipe.
- `init` writes `LITTLE_OWL.md` unless `--no-agent-file` is passed.

### Fixed

- Test fixtures and example directories were analysed as production code, producing critical
  findings about deliberately-broken sample projects and distorting the detected stack.
- `doctor` reported that everything was in place while the tool was misreading the project. It now
  checks scope plausibility: sample code inside the analysis, and a stack the manifest contradicts.
- `check` and `doctor` disagreed about how many layers a project had.
- `init` inferred a single layer from one directory name and wrote it into the config, enabling
  boundary rules that could never fire. Inference now requires two layers; otherwise the config
  gets a commented example.
- `prompt` reported "nothing that needs fixing" while `check` listed open findings — they were
  looking at different sets and neither said so.
- `prompt --all` told the assistant that pre-existing debt had been "introduced by the most recent
  change", sending it to search a diff that did not contain it.
- `review` credited a code change for score movement caused by a configuration change. The
  comparison now says so, and withholds the verdicts that depend on the delta.
- `verify` omitted the score line when the score had not moved, which read as a missed check.
- The progress spinner left orphaned `│` and `◇` characters above the output of every command that
  finished quietly.
- Findings whose text came straight from the rule engine now read in the same voice as the rest.
- Related files and the flow diagram no longer appear on findings that live inside a single
  function, where the neighbours cannot be involved.
- An empty or unreadable project no longer reports a perfect score.

## [0.1.3] — 2026-08-21

- Performance fixes.
- The AI prompt no longer repeats itself.

## [0.1.2] — 2026-08-20

- Installed files are no longer counted as changes.
- README leads with the product.

## [0.1.0] — 2026-08-20

First public release.

[0.2.0]: https://github.com/miguelGuarrochena/littleowlcode/releases/tag/v0.2.0
[0.1.3]: https://github.com/miguelGuarrochena/littleowlcode/releases/tag/v0.1.3
[0.1.2]: https://github.com/miguelGuarrochena/littleowlcode/releases/tag/v0.1.2
[0.1.0]: https://github.com/miguelGuarrochena/littleowlcode/releases/tag/v0.1.0
