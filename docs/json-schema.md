# JSON output

Every reporting command accepts `--json`. The contract is stable: `schemaVersion` changes only when a
field is removed or its meaning changes. New optional fields may appear without a version bump.

Current version: **1**.

## `little-owl check --json`

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "little-owl-code", "version": "0.1.0" },
  "project": {
    "name": "my-app",
    "root": "/path/to/my-app",
    "stack": ["Next.js", "React", "typescript"],
    "fileCount": 286,
    "packageManager": "pnpm",
  },
  "metrics": {
    "overall": 87,
    "architecture": 91,
    "maintainability": 78,
    "complexity": 82,
    "dependencies": 96,
    "typeSafety": 89,
  },
  "stats": {
    "files": 286,
    "linesOfCode": 41230,
    "functions": 1902,
    "cycles": 0,
    "layerViolations": 0,
    "layerSkips": 2,
    "crossFeatureImports": 0,
    "largeFiles": 3,
    "largeFunctions": 11,
    "deeplyNested": 4,
    "complexFunctions": 9,
    "duplicateBlocks": 2,
    "anyUsages": 12,
    "suppressions": 1,
    "unsafeAssertions": 3,
    "jsFilesInTsProject": 0,
    "unresolvedImports": 0,
    "maxImportDepth": 7,
  },
  "counts": { "error": 0, "warning": 5, "info": 6 },
  // Files that could not be read or parsed. Never fatal.
  "warnings": [{ "file": "src/legacy/broken.py", "message": "could not be parsed (…)" }],
  // True when the scan stopped at its 20,000-file limit. Every number above
  // then describes part of the repository rather than all of it.
  "truncated": false,
  "findings": [
    {
      "id": "architecture/layer-skip",
      "fingerprint": "8f2a1c4d9e07",
      "severity": "warning",
      "category": "architecture",
      "file": "components/Orders.tsx",
      "line": 4,
      "title": "ui imports data directly",
      "message": "components/Orders.tsx imports lib/db/client.ts, skipping the application layer...",
      "detail": ["found:    ui -> data", "expected: ui -> application -> data"],
      "suggestion": "Route the call through application instead of importing data from here.",
      "baseline": null,
      "current": "ui -> data",
    },
  ],
  "durationMs": 412,
}
```

### Partial analyses

`truncated` is `true` when a project has more source files than one run will scan. Treat the metrics
as a sample rather than a measurement, and narrow the analysis with `include` or `ignore` before
comparing scores. `little-owl ci --json` repeats the flag inside its `ci` block, and `little-owl ci`
prints a `PARTIAL ANALYSIS` line above its verdict so a pipeline cannot read a partial pass as a
clean one.

### Finding fields

| Field                 | Type                             | Notes                                                                                             |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`                  | string                           | Rule id, e.g. `architecture/circular-dependency`                                                  |
| `fingerprint`         | string                           | Stable identity — same problem, same fingerprint, across runs                                     |
| `severity`            | `"error" \| "warning" \| "info"` | Resolved from your configuration                                                                  |
| `category`            | string                           | `architecture`, `complexity`, `maintainability`, `dependencies`, `type-safety`, `scope`, `impact` |
| `file`, `line`        | string, number                   | Optional; project-relative POSIX path                                                             |
| `title`               | string                           | One line, usually including the number that matters                                               |
| `message`             | string                           | Why it matters                                                                                    |
| `detail`              | string[]                         | Optional supporting lines                                                                         |
| `suggestion`          | string                           | Optional; what to do                                                                              |
| `baseline`, `current` | unknown                          | Optional; the threshold and the measured value                                                    |

`fingerprint` is what makes drift comparison work. Use it as the identity of a finding, not `title`,
which can be reworded.

## `little-owl review --json` and `little-owl ci --json`

Everything above, plus:

```jsonc
{
  "status": "needs-review", // "healthy" | "needs-review" | "degraded"
  "baseline": {
    "createdAt": "2026-08-01T09:12:44.000Z",
    "commit": "3f9a1c2...",
    "metrics": { "overall": 89, "architecture": 91 /* ... */ },
  },
  "drift": {
    "overall": -3,
    "architecture": -5,
    "maintainability": 0,
    "complexity": -2,
    "dependencies": 0,
    "typeSafety": -1,
  },
  "changes": {
    "description": "uncommitted changes vs HEAD",
    "base": "HEAD",
    "files": [
      { "path": "components/Orders.tsx", "status": "modified", "insertions": 812, "deletions": 4 },
    ],
  },
  "scope": {
    "patterns": ["features/orders/**"],
    "outOfScope": ["components/Header.tsx"],
  },
  "newFindings": [], // not present in the baseline
  "resolvedFindings": [], // in the baseline, no longer reproducing
}
```

`ci --json` adds:

```jsonc
{
  "ci": {
    "passed": false,
    "reasons": ["1 error-level finding"],
    "failOn": "error",
    "maxDrop": 5,
    "newFindingsOnly": true,
  },
}
```

`changes.status` is one of `added`, `modified`, `deleted`, `renamed`, `untracked`. Files under
`.little-owl/` are never included — Little Owl's own state is not part of the change being reviewed.

## Other commands

- `little-owl architecture --json` — layers, whether they were inferred, the directories in each
  layer, files grouped by layer, cycles, and the edge count.
- `little-owl impact [file] --json` — changed files, impacted files with
  `distance` and `level` (`high`/`medium`/`low`), reachable tests, route-like
  entry points, `externals`, a `risk` level and a `confidence` level.
  `confidence` drops to `medium` when a changed file builds an import specifier
  at runtime, because the real blast radius may then be larger than listed.
- `little-owl dependencies --json` — declared dependencies, imported packages, and imports per file.
- `little-owl config --json` — the fully resolved configuration.
- `little-owl baseline --show --json` — the stored baseline.
- `little-owl compare --json` — local review history.
- `little-owl map --json` — areas, layers, entry points, central modules,
  recognised external services and totals.
- `little-owl dead-code --json` — `candidates` (each with `confidence`,
  `reasons` and `caveats`), `entryPoints`, and `hasUnresolvedDynamicImports`.
- `little-owl tests --json` — `hasNoTests`, `testFileCount`, `reachedCount`,
  `gaps` (each with `coverage`, `reachedBy` and `untestedExports`), `covered`
  and `skipped`.
- `little-owl explain <file> --json` — the archaeology report, including
  `evidence` (`strong` / `partial` / `none`), `created`, `rationale`,
  `consumers`, `coChanged` and `assessment`.
- `little-owl doctor --json` — `checks` (each `ok` / `warn` / `info`) and any
  files that had to be skipped.

## Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Success. For `ci`, the gate passed                               |
| 1    | For `ci`, the gate failed. For other commands, an error occurred |

`review` never fails a build on its own — it reports. Use `ci` when an exit code should decide
whether something proceeds.

## Piping

```bash
little-owl check --json | jq '.findings[] | select(.severity == "error")'
little-owl ci --json | jq -r '.ci.reasons[]'
little-owl impact --json | jq -r '.tests[]'
```

Progress spinners are written only to an interactive terminal, so JSON output is never polluted.
