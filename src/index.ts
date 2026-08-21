/**
 * Public API for Little Owl Code.
 *
 * The CLI is the product; this entry point exists so the same analysis can be
 * driven from scripts, editor integrations and CI wrappers.
 */

export { analyzeProject } from './core/analyze.js';
export type { Analysis, AnalyzeOptions, ProgressStep } from './core/analyze.js';
export { ParseCache } from './core/cache.js';
export { computeMetrics, computeStats, fileMetricsOf } from './core/metrics.js';
export { sortFindings, createFinding, severityOf, isEnabled } from './core/context.js';
export type { AnalysisContext, Rule, NewFinding } from './core/context.js';
export { scanFiles, languageOf, SOURCE_EXTENSIONS } from './core/scan.js';

export { defineConfig } from './config/schema.js';
export type {
  ArchitectureConfig,
  CiConfig,
  LayerPolicy,
  LittleOwlConfig,
  ResolvedConfig,
  Strictness,
  Thresholds,
} from './config/schema.js';
export { loadConfig, resolveConfig, findConfigFile, CONFIG_DIR } from './config/load.js';
export { DEFAULT_IGNORE, THRESHOLD_PRESETS, DEFAULT_RULE_SEVERITIES } from './config/defaults.js';

export { detectProject, describeStack } from './detect/project.js';
export { DependencyGraph, buildDependencyGraph } from './graph/dependency-graph.js';
export { findCycles } from './graph/cycles.js';
export type { Cycle } from './graph/cycles.js';
export { createResolverContext } from './graph/resolve.js';
export {
  buildLayerModel,
  inferLayers,
  layerOf,
  featureOf,
  classifyLayerDependency,
  describeLayerChain,
} from './architecture/layers.js';
export type { LayerModel, LayerRelation } from './architecture/layers.js';

export { runReview, determineStatus } from './review/review.js';
export type { ReviewOptions } from './review/review.js';
export { checkScope, groupByArea } from './review/scope.js';
export { analyzeImpact, routeLabel } from './review/impact.js';
export type { ImpactReport, ImpactedFile, ImpactLevel, RiskLevel } from './review/impact.js';
export { findDeadCode } from './review/dead-code.js';
export type { DeadCodeReport, DeadCodeCandidate, Confidence } from './review/dead-code.js';
export { analyzeTestGaps, changedFilesOf } from './review/test-gap.js';
export type { TestGapReport, TestGap, Coverage } from './review/test-gap.js';
export { explainFile } from './review/archaeology.js';
export type { ArchaeologyReport, EvidenceStrength } from './review/archaeology.js';
export { buildProjectMap } from './review/map.js';
export type { ProjectMap, MapArea, CentralModule, ExternalService } from './review/map.js';

export {
  buildBaseline,
  readBaseline,
  writeBaseline,
  compareToBaseline,
  explainDrift,
  baselinePath,
} from './baseline/baseline.js';
export { readHistory, appendHistory, latestEntries } from './baseline/history.js';
export type { HistoryEntry } from './baseline/history.js';

export { generatePrompt } from './prompts/generate.js';
export type { PromptOptions } from './prompts/generate.js';

export { checkToJson, reviewToJson, SCHEMA_VERSION } from './output/json.js';
export type { JsonCheckOutput, JsonReviewOutput, JsonFinding } from './output/json.js';

export {
  detectChanges,
  isGitRepository,
  fileHistory,
  fileCreation,
  coChangedFiles,
} from './git/git.js';
export type { Commit, ChangeQuery } from './git/git.js';

export { allRules, ruleById } from './rules/index.js';
export { adapters, adapterFor, parseFile } from './languages/index.js';
export type { LanguageAdapter, ParseInput } from './languages/index.js';

export * from './core/types.js';
