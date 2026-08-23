/**
 * Public API for Little Owl Code.
 *
 * The CLI is the product; this entry point exists so the same analysis can be
 * driven from scripts, editor integrations and CI wrappers.
 */

export { analyzeProject } from './core/analyze.js';
export type { Analysis, AnalyzeOptions, ProgressStep } from './core/analyze.js';
export { ParseCache } from './core/cache.js';
export {
  computeMetrics,
  computeStats,
  fileMetricsOf,
  uncheckedArchitecturePenalty,
  LAYER_COVERAGE_TARGET,
} from './core/metrics.js';
export { sortFindings, createFinding, severityOf, isEnabled } from './core/context.js';
export { rankFindings, overshoot, RULE_PRIORITY } from './core/priority.js';
export type { AnalysisContext, Rule, NewFinding } from './core/context.js';
export { scanFiles, languageOf, SOURCE_EXTENSIONS, MAX_SCANNED_FILES } from './core/scan.js';

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
export {
  loadConfig,
  resolveConfig,
  findConfigFile,
  ensureLocalGitignore,
  CONFIG_DIR,
} from './config/load.js';
export {
  DEFAULT_IGNORE,
  THRESHOLD_PRESETS,
  DEFAULT_RULE_SEVERITIES,
  ruleSeveritiesFor,
  baseConfig,
} from './config/defaults.js';
export { validateConfig, validateAgainstProject, knownRuleIds } from './config/validate.js';
export { configFingerprint } from './config/fingerprint.js';

export { detectProject, describeStack } from './detect/project.js';
export {
  isImplicitlyUsed,
  isNodeBuiltin,
  undeclaredPackages,
  unusedDependencies,
} from './detect/dependencies.js';
export { DependencyGraph, buildDependencyGraph } from './graph/dependency-graph.js';
export { findCycles } from './graph/cycles.js';
export { stronglyConnectedComponents } from './graph/scc.js';
export type { Cycle } from './graph/cycles.js';
export { createResolverContext } from './graph/resolve.js';
export {
  buildLayerModel,
  inferLayers,
  layerOf,
  layerCoverage,
  matchesLayerDirectory,
  featureOf,
  classifyLayerDependency,
  describeLayerChain,
} from './architecture/layers.js';
export type { LayerCoverage, LayerModel, LayerRelation } from './architecture/layers.js';
export {
  findClientLeaks,
  serverOnlyReasons,
  serverOnlyPackages,
  secretEnvReads,
  isSecretEnvName,
  describeChain,
} from './architecture/client-boundary.js';
export type {
  BoundaryOptions,
  ClientLeak,
  EnvRead,
  ServerOnlyReason,
} from './architecture/client-boundary.js';

export { runReview, runReviewWithContext, determineStatus } from './review/review.js';
export type { Review, ReviewOptions } from './review/review.js';
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
  configDriftedFromBaseline,
  explainDrift,
  baselinePath,
  CONFIG_DRIFT_NOTICE,
} from './baseline/baseline.js';
export { readHistory, appendHistory, latestEntries } from './baseline/history.js';
export type { HistoryEntry } from './baseline/history.js';

export { generatePrompt } from './prompts/generate.js';
export type { PromptOptions } from './prompts/generate.js';
export { renderIssueBrief, enclosingFunction } from './prompts/brief.js';
export type { BriefOptions } from './prompts/brief.js';

export { resolveGuidance, hasGuidance, RULE_GUIDANCE } from './guidance/guidance.js';
export type { RuleGuidance, ResolvedGuidance } from './guidance/guidance.js';
export { GLOSSARY, termsIn, defineTerm } from './guidance/glossary.js';
export { relatedFiles, renderFlow } from './guidance/related.js';
export type { RelatedFile } from './guidance/related.js';

export {
  countByPriority,
  priorityOf,
  renderPriorityCounts,
  renderPriorityLegend,
  PRIORITY_OF,
  PRIORITY_ICON,
  PRIORITY_MEANING,
  PRIORITY_ORDER,
  SEVERITY_OF,
} from './output/severity.js';
export type { Priority, PriorityCounts } from './output/severity.js';
export {
  numberFindings,
  withNumbers,
  renderIssueCard,
  renderIssueSummary,
} from './output/issue.js';
export type { Issue, IssueCardOptions } from './output/issue.js';

export { readSnapshot, writeSnapshot, snapshotIssue, snapshotPath } from './baseline/snapshot.js';
export type { RunSnapshot, SnapshotIssue } from './baseline/snapshot.js';

export { renderAgentFile, writeAgentFile, agentFilePath, AGENT_FILE } from './agent/agent-file.js';
export type { AgentFileInput } from './agent/agent-file.js';

export { detectCommands, verificationCommand } from './detect/commands.js';
export type { ProjectCommands } from './detect/commands.js';

export {
  renderReview,
  renderConfigDrift,
  changeSize,
  describeAge,
} from './output/review-report.js';
export type { ChangeSize, ReviewRenderOptions } from './output/review-report.js';

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
