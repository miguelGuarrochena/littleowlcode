# Contributing to Little Owl Code

Thanks for wanting to help. This document covers how the project is built and what makes a change
likely to be merged.

## Getting set up

```bash
git clone https://github.com/miguelGuarrochena/littleowlcode.git
cd little-owl-code
pnpm install
pnpm check
```

`pnpm check` runs typecheck, lint, tests and build — the same gate CI uses.

Useful scripts:

| Script            | What it does            |
| ----------------- | ----------------------- |
| `pnpm build`      | Build to `dist/`        |
| `pnpm dev`        | Rebuild on change       |
| `pnpm test`       | Run the test suite once |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm typecheck`  | `tsc --noEmit`          |
| `pnpm lint`       | ESLint                  |
| `pnpm format`     | Prettier                |

To try your build against a real project:

```bash
pnpm build
node dist/cli.js check -C ../some-project
```

## Project layout

```
src/
  cli/           command definitions, interactive mode, terminal runtime
  core/          types, scanning, parse cache, the analysis engine, metrics
  config/        schema, defaults, config loading
  detect/        project and framework detection
  languages/     one adapter per language
  graph/         import resolution, dependency graph, cycle detection
  architecture/  layer model
  rules/         the rules themselves, grouped by category
  guidance/      the plain-language layer: what/why/expected/fix per rule, glossary
  agent/         LITTLE_OWL.md, the briefing file for AI assistants
  review/        review flow, scope, impact
  baseline/      baseline and local history
  prompts/       AI prompt generation
  output/        terminal rendering and the JSON contract
  git/           read-only git access
  utils/         glob, paths, hashing
tests/
  fixtures/      small projects used by the tests
```

## Design principles

These are not style preferences; they are what the product is.

1. **Signal over noise.** A rule that fires often but rarely matters makes the tool worse. If you
   cannot describe the situation where a developer would be glad to see the finding, it is not ready.
2. **Explainable over clever.** Every finding must say what happened, where, why it matters, and what
   to do. Every score change must be traceable to concrete counts.
3. **Deterministic.** The same code must always produce the same findings, in the same order, with
   the same fingerprints. No timestamps, no randomness, no set iteration order leaking into output.
4. **Read-only.** Little Owl must never modify application source code, and must never write to git.
   The only directory it writes to is `.little-owl/`.
5. **Offline.** No network calls, no telemetry, no API keys.
6. **Honest language.** "Detected", "appears inconsistent with", "your configured architecture".
   Never present a preference as a universal truth.
7. **Written for someone who is not you.** Many people using Little Owl built their application
   mostly by asking an AI assistant for features. They may not know what a layer is, or why a
   circular dependency matters. Explain the consequence in terms of the running application before
   you reach for the term — and if a term is unavoidable, define it in one clause.
8. **Every state ends on a next step.** Any screen that leaves the reader asking "and now what?" is
   unfinished, including error messages. `tests/journey.test.ts` asserts this.

## Adding a rule

A rule lives in `src/rules/<category>.ts` and looks like this:

```ts
const myRule: Rule = {
  id: 'category/kebab-case-name',
  category: 'complexity',
  description: 'One line, shown by `little-owl config --rules`.',
  run(context) {
    const findings: Finding[] = [];
    for (const file of context.files) {
      if (file.isTest) continue;
      // ...
      const finding = createFinding(this, context, {
        file: file.path,
        line: 12,
        title: 'Short, specific, includes the number that matters',
        message: 'Why this matters, in plain language.',
        suggestion: 'What the developer can do about it.',
        key: [/* what makes this finding unique within the rule */],
      });
      if (finding) findings.push(finding);
    }
    return findings;
  },
};
```

Then:

1. Add it to the exported array at the bottom of the file.
2. Add a default severity to `DEFAULT_RULE_SEVERITIES` in `src/config/defaults.ts`, plus any
   strictness overrides.
3. **Add an entry to `RULE_GUIDANCE` in `src/guidance/guidance.ts`.** This is not optional for
   anything that can be `error`; a test enforces it. The rule's `message` describes the code, the
   guidance describes the consequence:

   ```ts
   'category/kebab-case-name': {
     // Optional: a plainer restatement than the rule's own message.
     what: (finding) => `${finding.file} does the thing.`,
     // What this means for the running application, for someone who has never
     // heard the term. No acronyms without a definition.
     why: 'A user could end up seeing another user\'s data.',
     expected: 'Each request only ever reads the rows that belong to that user.',
     fix: 'Concrete, and specific enough to act on without reading anything else.',
     verify: 'How to know it worked, beyond the warning going away.',
     risk: 'What could go wrong while fixing it.',
   },
   ```

4. If the guidance uses a term a non-expert would not know, add it to `GLOSSARY` in
   `src/guidance/glossary.ts` — it is matched and explained automatically.
5. Add a rank to `RULE_PRIORITY` in `src/core/priority.ts` if the rule should be worked on before or
   after others of the same severity. Issue numbers come from that ranking.
6. Add a test in `tests/rules.test.ts` using `TempProject`, covering both the positive case and a
   case that must **not** fire.

`createFinding` returns `null` when the rule is switched off, so rule bodies never check severity
themselves. The `key` you pass becomes part of the fingerprint — get it right, or drift comparison
will report the same problem as new on every run.

## Changing what the CLI says

Every guided screen is assembled from `src/output/guided.ts`, `src/output/issue.ts` and
`src/output/severity.ts`, so the commands cannot drift into sounding like different tools. If you
are adding a new screen, use those pieces rather than printing your own headings.

`tests/journey.test.ts` walks the whole path — init, check, explain, fix, verify — as a newcomer
does, and asserts the things that are easy to break silently: that priorities are explained and not
just coloured, that rule ids stay behind `--technical`, that errors name a recovery command, and
that no screen ends without one.

## Adding a language

Implement `LanguageAdapter` in `src/languages/`, register it in `src/languages/index.ts`, add the
extensions to `src/core/scan.ts`, and add a fixture under `tests/fixtures/`. Adapters extract
imports, function shapes and markers — nothing cross-file. The engine owns the graph, layers and
drift.

## Tests

Vitest, in `tests/`. Two helpers:

- `TempProject` writes a real project to a temp directory, optionally with a git repo. Use it for
  anything that touches the file pipeline.
- `tests/fixtures/` holds committed example projects for the language adapters.

`tests/cli.test.ts` runs the built CLI as a subprocess. Those tests catch the packaging and wiring
problems that source-level tests cannot.

Please avoid snapshot tests of terminal output — they break on every wording change and assert
nothing about behaviour.

## Commits and pull requests

- Write commit messages in English, in the imperative, describing the effect: `Stop watch mode from
re-analysing on non-source files.`
- Keep a pull request to one concern.
- Run `pnpm check` before pushing.
- If you change output wording, paste a before/after in the PR description.
- Add a line to [CHANGELOG.md](./CHANGELOG.md) under "unreleased" for anything a user would
  notice: a new command or flag, changed output, a new rule, a changed default. Behaviour that
  moves someone's score or fails a build they were passing goes at the top of the entry, under
  the upgrade note — those are the ones people need to read before they upgrade, not after.

## Releasing

The release runs from CI on a tag, so the local steps are small:

1. Move the `unreleased` heading in `CHANGELOG.md` to the version and today's date.
2. Bump `version` in `package.json`. While the project is on `0.x`, anything that changes existing
   behaviour bumps the minor — a new default-`error` rule and a new default `ignore` pattern both
   qualify, because both can turn a passing build red.
3. Commit, then tag `vX.Y.Z`.

Pushing the tag triggers `.github/workflows/release.yml`, which re-runs `pnpm check`, verifies the
tag matches `package.json`, and publishes with npm trusted publishing and provenance. There is no
token to manage.

## Reporting bugs

Include the command you ran, what you expected, what happened, and — most useful of all — a minimal
project that reproduces it. `little-owl check --json` output helps too.

## Code of conduct

Participation is covered by our [Code of Conduct](./CODE_OF_CONDUCT.md).
