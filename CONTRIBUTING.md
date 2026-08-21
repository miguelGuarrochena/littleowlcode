# Contributing to Little Owl Code

Thanks for wanting to help. This document covers how the project is built and what makes a change
likely to be merged.

## Getting set up

```bash
git clone https://github.com/littleowlcode/little-owl-code.git
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
3. Add a test in `tests/rules.test.ts` using `TempProject`, covering both the positive case and a
   case that must **not** fire.

`createFinding` returns `null` when the rule is switched off, so rule bodies never check severity
themselves. The `key` you pass becomes part of the fingerprint — get it right, or drift comparison
will report the same problem as new on every run.

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

## Reporting bugs

Include the command you ran, what you expected, what happened, and — most useful of all — a minimal
project that reproduces it. `little-owl check --json` output helps too.

## Code of conduct

Participation is covered by our [Code of Conduct](./CODE_OF_CONDUCT.md).
