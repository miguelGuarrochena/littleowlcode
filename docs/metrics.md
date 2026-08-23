# How the scores work

Little Owl reports six numbers between 0 and 100. This page explains exactly how they are produced,
because a score you cannot explain is not worth showing.

## What the scores are for

The scores exist to make **drift visible** — to compare a project against its own past. They are not
a grade, and comparing them across different projects means very little: a 200-file service and a
20,000-file monolith have different natural shapes.

**The findings are the product. The score is the summary.**

## The five components

Each score starts at 100 and loses points for measurable problems, normalised so a large repository
is not punished for being large.

### Architecture

```
per100Files = max(1, files / 100)

penalty = (cycles × 10
         + layerViolations × 5
         + layerSkips × 2
         + crossFeatureImports × 1) / per100Files

coverage  = layeredFiles / files
unchecked = max(0, 0.8 − coverage) × 50     // 0 when no layer matched anything

architecture = clamp(100 − penalty − unchecked)
```

Counting per 100 files means the score reflects density, not size. Ten cycles in a 50-file project is
a much worse situation than ten cycles in a 5,000-file one, and the score says so.

**The `unchecked` term is the important one.** Boundary rules only fire between two files that both
belong to a layer. A model covering 60% of the tree can report "no violations" and mean it — about
the 60% it saw. Without the discount, a project whose layers are wrong scores a perfect 100 for an
architecture nothing examined, and correcting the config _lowers_ the number. The points withheld
are never silent: `architecture/unlayered-code` states the figure and names the directories behind
it, and `little-owl architecture` prints the coverage line under every verdict.

The target is 80%, not 100%: build scripts, generated types and repository-root files legitimately
sit outside any layer. When no layer matches anything at all, nothing is withheld — the report says
"no layered structure detected" in words instead.

### Complexity

```
complexity = clamp(100
  − (complexFunctions / functions) × 180
  − (deeplyNested / functions) × 60)
```

A function is "complex" when its cyclomatic complexity exceeds `maxComplexity`, and "deeply nested"
when its nesting exceeds `maxNesting`. Both are ratios of all functions in the project, so the score
answers "what proportion of this codebase is hard to follow?"

### Maintainability

```
maintainability = clamp(100
  − (largeFiles / files) × 200
  − (largeFunctions / functions) × 100
  − (duplicateBlocks / per100Files) × 2)
```

### Dependencies

```
dependencies = clamp(100
  − (unresolvedImports / per100Files) × 3
  − max(0, maxImportDepth − 8) × 2)
```

This measures dependency _hygiene_ — imports that resolve, chains that stay shallow. It is not a
security score.

### Type safety

```
kloc = max(1, linesOfCode / 1000)

typeSafety = clamp(100
  − (anyUsages / kloc) × 3
  − (suppressions / kloc) × 8
  − (unsafeAssertions / kloc) × 2
  − (jsFilesInTsProject / files) × 50)
```

Projects that are not TypeScript score 100 here — the category does not apply, and penalising them
for it would be meaningless.

### Overall

```
overall = round(
    architecture    × 0.30
  + complexity      × 0.20
  + maintainability × 0.20
  + dependencies    × 0.15
  + typeSafety      × 0.15
)
```

Architecture carries the most weight because architectural damage is the hardest to undo. A long
function can be split in an afternoon; a tangled dependency graph takes weeks.

Because it is a weighted average, a project can hold a high overall score while one component is in
trouble. That is why the counts line (`🔴 1 critical  🟡 3 warnings`) always sits next to the score.

## The counts behind the scores

Every score is derived from `MetricStats`, which is stored in the baseline. That is what makes drift
explainable:

```
Since the baseline: +2 circular dependencies, +3 skipped-layer imports, +14 `any` usages
```

The full set of counts is in `--json` output under `stats`:

| Field                                           | Meaning                                      |
| ----------------------------------------------- | -------------------------------------------- |
| `files`, `linesOfCode`, `functions`             | Size of the analysed source, excluding tests |
| `layeredFiles`                                  | Of those, the ones inside a declared layer   |
| `cycles`                                        | Circular dependency groups                   |
| `layerViolations`                               | Lower layer importing a higher one           |
| `layerSkips`                                    | Layer reaching past its neighbour            |
| `crossFeatureImports`                           | Feature importing another feature            |
| `largeFiles`, `largeFunctions`                  | Over the configured budget                   |
| `complexFunctions`, `deeplyNested`              | Over the complexity and nesting limits       |
| `duplicateBlocks`                               | Repeated blocks found                        |
| `anyUsages`, `suppressions`, `unsafeAssertions` | Type-safety escape hatches                   |
| `jsFilesInTsProject`                            | Untyped source files in a TypeScript project |
| `unresolvedImports`                             | Imports matching no file and no package      |
| `maxImportDepth`                                | Longest import chain from any entry point    |

## Determinism

Two runs over the same code always produce the same scores, the same findings, in the same order,
with the same fingerprints. Files are scanned in sorted order, rules run in a fixed sequence, and
findings sort by severity, then category, then file, then line.

This matters because drift comparison relies on fingerprints: a finding whose identity changed
between runs would be reported as "new" forever.
