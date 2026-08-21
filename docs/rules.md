# Rules

Every rule, what it looks for, and its default severity at each strictness level.

Change any of them in `.little-owl/config.ts`:

```ts
rules: {
  'architecture/layer-skip': 'error',
  'maintainability/duplicate-block': 'off',
}
```

Severities: `off` | `info` | `warning` | `error`. Run `little-owl config --rules` to see what is
active in your project right now.

## Architecture

| Rule                                | Relaxed | Balanced | Strict |
| ----------------------------------- | ------- | -------- | ------ |
| `architecture/circular-dependency`  | error   | error    | error  |
| `architecture/layer-violation`      | error   | error    | error  |
| `architecture/layer-skip`           | info    | warning  | error  |
| `architecture/cross-feature-import` | info    | warning  | error  |
| `architecture/forbidden-dependency` | error   | error    | error  |
| `architecture/deep-import-chain`    | off     | info     | info   |
| `next/server-import-in-client`      | error   | error    | error  |

**`architecture/circular-dependency`** — files that import each other, directly or through a chain.
Cycles are found with Tarjan's algorithm over the import graph. `import type` edges are excluded:
they are erased at build time and do not create a runtime cycle.

**`architecture/layer-violation`** — a lower layer imports a higher one, for example the data layer
importing a UI component. This is almost always a mistake rather than a style choice.

**`architecture/layer-skip`** — a layer reaches past its neighbour, for example UI importing the
database directly. Only reported when `layerPolicy` is `adjacent`.

**`architecture/cross-feature-import`** — one feature imports another feature's internals. Requires
`architecture.featureRoot` to be set or inferred.

**`architecture/forbidden-dependency`** — an edge matching a pair in `architecture.forbidden`.

**`architecture/deep-import-chain`** — an entry point whose transitive import chain is longer than
`maxImportDepth`.

**`next/server-import-in-client`** — a `'use client'` module that imports a server-only package
(`node:fs`, `pg`, `server-only`, …) or a `'use server'` module.

## Complexity

| Rule                         | Relaxed | Balanced | Strict  |
| ---------------------------- | ------- | -------- | ------- |
| `complexity/large-file`      | warning | warning  | warning |
| `complexity/large-function`  | warning | warning  | warning |
| `complexity/large-component` | warning | warning  | warning |
| `complexity/high-complexity` | warning | warning  | warning |
| `complexity/deep-nesting`    | off     | info     | warning |
| `complexity/too-many-params` | off     | info     | warning |
| `go/large-package`           | info    | info     | info    |

Thresholds come from `thresholds` and differ per strictness:

| Threshold           | Relaxed | Balanced | Strict |
| ------------------- | ------- | -------- | ------ |
| `maxFileLines`      | 1200    | 800      | 400    |
| `maxFunctionLines`  | 160     | 100      | 60     |
| `maxComponentLines` | 1000    | 800      | 300    |
| `maxComplexity`     | 25      | 15       | 10     |
| `maxNesting`        | 6       | 4        | 3      |
| `maxParams`         | 8       | 5        | 4      |
| `maxImportDepth`    | 12      | 8        | 6      |
| `minDuplicateLines` | 12      | 8        | 6      |
| `maxAnyPerKLoc`     | 12      | 6        | 2      |

Complexity is cyclomatic: one plus each `if`, loop, `catch`, `case`, ternary, `&&`, `||` and `??`.
Nested functions are measured separately rather than inflating their parent. React components are
measured against `maxComponentLines` instead of `maxFunctionLines`; a function counts as a component
when its name starts with a capital letter and its body returns JSX.

Test files are excluded from every complexity rule.

## Maintainability

| Rule                                | Relaxed | Balanced | Strict  |
| ----------------------------------- | ------- | -------- | ------- |
| `maintainability/duplicate-block`   | off     | info     | warning |
| `maintainability/unresolved-import` | info    | info     | info    |
| `react/effect-dependency-risk`      | info    | info     | warning |

**`maintainability/duplicate-block`** — the same `minDuplicateLines` consecutive lines appear in more
than one place. Comparison is textual after whitespace normalisation, and structural lines (imports,
closing braces, very short lines) never start a block.

**`maintainability/unresolved-import`** — an import that matches neither a project file nor a declared
package. Usually a path alias Little Owl does not know about.

**`react/effect-dependency-risk`** — `useEffect` or `useLayoutEffect` called with no dependency array,
so the effect runs after every render.

## Type safety

| Rule                           | Relaxed | Balanced | Strict  |
| ------------------------------ | ------- | -------- | ------- |
| `type-safety/explicit-any`     | info    | warning  | warning |
| `type-safety/suppression`      | warning | warning  | warning |
| `type-safety/unsafe-assertion` | off     | info     | warning |
| `type-safety/js-in-ts-project` | off     | info     | warning |

**`type-safety/explicit-any`** — reported per file, not per occurrence, once the count exceeds
`max(2, maxAnyPerKLoc × kloc)`. A couple of `any`s in a large file is normal; a cluster is not.

**`type-safety/suppression`** — `@ts-ignore`. `@ts-expect-error` is deliberately _not_ reported: it
fails once the underlying error is fixed, which is the behaviour you want.

**`type-safety/unsafe-assertion`** — `as any`, `as unknown`, and `x as unknown as Y`. Ordinary
`as SomeType` is normal TypeScript and is not flagged. A laundering chain counts once.

**`type-safety/js-in-ts-project`** — plain JavaScript source files in a project configured for
TypeScript. Root-level `*.config.js` and `*.setup.js` are excluded.

## Dependencies

| Rule                                | Relaxed | Balanced | Strict  |
| ----------------------------------- | ------- | -------- | ------- |
| `dependencies/major-version-change` | warning | warning  | warning |
| `dependencies/new-dependency`       | off     | info     | warning |
| `dependencies/unused-dependency`    | off     | info     | info    |
| `dependencies/duplicate-dependency` | warning | warning  | warning |

The first two compare `package.json` against the same file at the git base ref, so they only fire
during a `review` or `ci` run with something to compare against.

`dependencies/unused-dependency` is a heuristic: packages loaded through configuration or at runtime
look unused. Type-only packages, linters, formatters and build tools are excluded. Treat the finding
as a prompt to check.

Little Owl does not check for vulnerabilities. Use `npm audit`, `pnpm audit` or your scanner of
choice.

## Python

| Rule                     | Relaxed | Balanced | Strict  |
| ------------------------ | ------- | -------- | ------- |
| `python/bare-except`     | warning | warning  | warning |
| `python/mutable-default` | warning | warning  | warning |
| `python/global-state`    | info    | info     | info    |

Python is parsed line by line rather than into a syntax tree, so these are the checks that are
reliable without one. Import cycles are found through the same graph machinery as everywhere else.
This is not a replacement for Ruff or Pylint.

## Go

| Rule               | Relaxed | Balanced | Strict  |
| ------------------ | ------- | -------- | ------- |
| `go/ignored-error` | warning | warning  | warning |
| `go/large-package` | info    | info     | info    |

`go/ignored-error` reports return values discarded with `_`, which in Go is usually a dropped error.
Package cycles are found through the import graph: a Go import resolves to every non-test file of the
target package.

This is not a replacement for `staticcheck` or `golangci-lint`.

## Patterns

Shapes that show up when a codebase is edited in many small passes — the same
helper written twice, two modules implementing the same concept, wrappers that
only forward a call.

| Rule                                | Relaxed | Balanced | Strict  |
| ----------------------------------- | ------- | -------- | ------- |
| `patterns/duplicate-helper`         | warning | warning  | warning |
| `patterns/parallel-implementations` | info    | warning  | warning |
| `patterns/thin-wrapper`             | off     | info     | warning |
| `patterns/abstraction-growth`       | off     | info     | warning |

Little Owl **never claims a pattern is "AI-generated"**. It reports the shape it
found. These patterns are easy to introduce whenever the person making a change
cannot see the whole codebase at once, whoever or whatever that is.

**`patterns/duplicate-helper`** — the same exported name defined in more than one
file. Only counts names a file actually _defines_, so a barrel re-exporting
`formatDate` is not a second implementation. Framework names that are supposed to
repeat (`GET`, `default`, `middleware`, `Page`, …) are excluded, as are names
shorter than four characters.

**`patterns/parallel-implementations`** — three or more shared names between the
same set of files. This is the module-level version of the rule above: two
modules implementing one concept is _one_ situation, reported once rather than
once per duplicated name.

Both rules stay quiet when the overlap is deliberate:

- one of the files imports all the others (delegation), or
- a third module imports every one of them (a facade choosing between them)

That second case is the demo/real strategy pattern, where identical signatures
are the entire point.

**`patterns/thin-wrapper`** — a module with exactly one export, one internal
import and one function of three lines or fewer with no branching, that something
else imports. It adds a name and nothing else.

**`patterns/abstraction-growth`** — a directory of eight or more files where at
least half are under 30 lines, have at most two functions, and have exactly one
caller. That is the shape a directory takes when abstractions accumulate one
change at a time.

## Scope

`scope/out-of-scope-change` is not a configurable rule. It appears when `review` is given a `--scope`
and files outside it changed, and is always a warning.
