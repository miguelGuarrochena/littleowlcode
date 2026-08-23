import type { FileMetric, Finding, MetricStats, Metrics, ParsedFile } from './types.js';
import type { AnalysisContext } from './context.js';
import {
  layerOf,
  classifyLayerDependency,
  featureOf,
  layerCoverage,
} from '../architecture/layers.js';
import { untypedSources } from '../detect/typed-files.js';

/**
 * Scores are a summary, not a verdict.
 *
 * Each one starts at 100 and loses points for measurable problems, normalised
 * by project size so a large repository is not punished for being large. The
 * numbers exist to make drift visible between two runs of the same project;
 * comparing scores across different projects means very little.
 */

const WEIGHTS: Record<keyof Omit<Metrics, 'overall'>, number> = {
  architecture: 0.3,
  complexity: 0.2,
  maintainability: 0.2,
  dependencies: 0.15,
  typeSafety: 0.15,
};

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const ratio = (part: number, total: number): number => (total === 0 ? 0 : part / total);

export const computeStats = (context: AnalysisContext, findings: Finding[]): MetricStats => {
  const { files, config, graph, layers } = context;
  const sourceFiles = files.filter((file) => !file.isTest);
  const thresholds = config.thresholds;

  let functions = 0;
  let largeFiles = 0;
  let largeFunctions = 0;
  let complexFunctions = 0;
  let deeplyNested = 0;
  let anyUsages = 0;
  let suppressions = 0;
  let unsafeAssertions = 0;
  let linesOfCode = 0;

  for (const file of sourceFiles) {
    linesOfCode += file.sloc;
    functions += file.functions.length;
    if (file.lines > thresholds.maxFileLines) largeFiles += 1;

    for (const fn of file.functions) {
      const limit = fn.isComponent ? thresholds.maxComponentLines : thresholds.maxFunctionLines;
      if (fn.lines > limit) largeFunctions += 1;
      if (fn.complexity > thresholds.maxComplexity) complexFunctions += 1;
      if (fn.maxNesting > thresholds.maxNesting) deeplyNested += 1;
    }

    for (const marker of file.markers) {
      if (marker.kind === 'any') anyUsages += 1;
      else if (marker.kind === 'ts-ignore') suppressions += 1;
      else if (marker.kind === 'unsafe-assertion') unsafeAssertions += 1;
    }
  }

  let layerViolations = 0;
  let layerSkips = 0;
  let crossFeatureImports = 0;

  for (const edge of graph.edges) {
    if (edge.typeOnly) continue;
    if (context.fileMap.get(edge.from)?.isTest) continue;

    const relation = classifyLayerDependency(
      layerOf(edge.from, layers),
      layerOf(edge.to, layers),
      layers,
    );
    if (relation === 'inverted') layerViolations += 1;
    else if (relation === 'skip') layerSkips += 1;

    const fromFeature = featureOf(edge.from, layers);
    const toFeature = featureOf(edge.to, layers);
    if (fromFeature && toFeature && fromFeature !== toFeature) crossFeatureImports += 1;
  }

  const coverage = layerCoverage(files, layers);

  const maxImportDepth = graph
    .nodes()
    .filter((node) => graph.dependentsOf(node).length === 0)
    .reduce((deepest, node) => Math.max(deepest, graph.maxDepthFrom(node)), 0);

  return {
    files: sourceFiles.length,
    layeredFiles: coverage.applicable ? coverage.layered : 0,
    linesOfCode,
    functions,
    cycles: context.cycles.length,
    layerViolations,
    layerSkips,
    crossFeatureImports,
    largeFiles,
    largeFunctions,
    deeplyNested,
    complexFunctions,
    duplicateBlocks: findings.filter((finding) => finding.id === 'maintainability/duplicate-block')
      .length,
    anyUsages,
    suppressions,
    unsafeAssertions,
    // Same predicate the rule uses, so the score cannot penalise a file the
    // report never mentions.
    jsFilesInTsProject: untypedSources(sourceFiles, context.project.hasTypeScript).length,
    unresolvedImports: graph.unresolved.length,
    maxImportDepth,
  };
};

/**
 * Share of the codebase a layer model should reach before its verdict counts as
 * covering the project. Below this, the architecture score is discounted for
 * what it could not see. Not 100%: build scripts, generated types and
 * repository-root files legitimately sit outside any layer.
 */
export const LAYER_COVERAGE_TARGET = 0.8;

/** Points lost per unit of missing coverage. 40 at zero coverage. */
const UNCHECKED_WEIGHT = 50;

/**
 * How many architecture points are withheld because the layer model does not
 * reach the code.
 *
 * Boundary rules need both ends of an import to belong to a layer. Without this
 * discount, a project whose layers describe a third of the tree scores a
 * perfect 100 for an architecture nothing examined — and leaving the config
 * wrong becomes the cheapest way to a good number.
 *
 * Zero when no layer matched anything at all: there is no model to judge, and
 * the report says so in words rather than by docking points.
 */
export const uncheckedArchitecturePenalty = (stats: MetricStats): number => {
  if (stats.layeredFiles === 0 || stats.files === 0) return 0;
  const coverage = stats.layeredFiles / stats.files;
  return Math.max(0, LAYER_COVERAGE_TARGET - coverage) * UNCHECKED_WEIGHT;
};

export const computeMetrics = (stats: MetricStats, hasTypeScript: boolean): Metrics => {
  // Architecture problems are counted per 100 files so the score reflects
  // density rather than repository size.
  const per100Files = Math.max(1, stats.files / 100);
  const architecturePenalty =
    (stats.cycles * 10 +
      stats.layerViolations * 5 +
      stats.layerSkips * 2 +
      stats.crossFeatureImports * 1) /
    per100Files;
  const architecture = clampScore(100 - architecturePenalty - uncheckedArchitecturePenalty(stats));

  const complexity = clampScore(
    100 -
      ratio(stats.complexFunctions, stats.functions) * 180 -
      ratio(stats.deeplyNested, stats.functions) * 60,
  );

  const maintainability = clampScore(
    100 -
      ratio(stats.largeFiles, stats.files) * 200 -
      ratio(stats.largeFunctions, stats.functions) * 100 -
      (stats.duplicateBlocks / per100Files) * 2,
  );

  const dependencies = clampScore(
    100 - (stats.unresolvedImports / per100Files) * 3 - Math.max(0, stats.maxImportDepth - 8) * 2,
  );

  const kloc = Math.max(1, stats.linesOfCode / 1000);
  const typeSafety = hasTypeScript
    ? clampScore(
        100 -
          (stats.anyUsages / kloc) * 3 -
          (stats.suppressions / kloc) * 8 -
          (stats.unsafeAssertions / kloc) * 2 -
          ratio(stats.jsFilesInTsProject, stats.files) * 50,
      )
    : 100;

  const overall = clampScore(
    architecture * WEIGHTS.architecture +
      complexity * WEIGHTS.complexity +
      maintainability * WEIGHTS.maintainability +
      dependencies * WEIGHTS.dependencies +
      typeSafety * WEIGHTS.typeSafety,
  );

  return { overall, architecture, maintainability, complexity, dependencies, typeSafety };
};

export const fileMetricsOf = (files: ParsedFile[]): Record<string, FileMetric> => {
  const metrics: Record<string, FileMetric> = {};
  for (const file of files) {
    metrics[file.path] = {
      lines: file.lines,
      sloc: file.sloc,
      functions: file.functions.length,
      maxComplexity: file.functions.reduce((max, fn) => Math.max(max, fn.complexity), 0),
    };
  }
  return metrics;
};
