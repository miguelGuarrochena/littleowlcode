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

export { allRules, ruleById } from './rules/index.js';
export { adapters, adapterFor, parseFile } from './languages/index.js';
export type { LanguageAdapter, ParseInput } from './languages/index.js';

export * from './core/types.js';
