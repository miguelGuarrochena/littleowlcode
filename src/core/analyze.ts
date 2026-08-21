import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult, AnalysisWarning, ChangeSet, Finding, ParsedFile } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { scanFiles } from './scan.js';
import { parseFile } from '../languages/index.js';
import { detectProject } from '../detect/project.js';
import { buildDependencyGraph } from '../graph/dependency-graph.js';
import { createResolverContext } from '../graph/resolve.js';
import { findCycles } from '../graph/cycles.js';
import { buildLayerModel } from '../architecture/layers.js';
import { allRules } from '../rules/index.js';
import { computeMetrics, computeStats, fileMetricsOf } from './metrics.js';
import { sortFindings, type AnalysisContext } from './context.js';
import { ParseCache } from './cache.js';
import { hashContent } from '../utils/hash.js';

export type ProgressStep =
  | 'reading-project'
  | 'parsing'
  | 'building-graph'
  | 'analyzing-architecture'
  | 'running-rules'
  | 'done';

export interface AnalyzeOptions {
  root: string;
  config?: ResolvedConfig;
  /** Git changes to attach to the context; some rules only run with them. */
  changes?: ChangeSet | null;
  cache?: ParseCache | false;
  onProgress?: (step: ProgressStep) => void;
  /** Cap on files scanned. Defaults to the scanner's own limit. */
  maxFiles?: number;
}

export interface Analysis {
  result: AnalysisResult;
  context: AnalysisContext;
  cache: ParseCache;
}

export const analyzeProject = async (options: AnalyzeOptions): Promise<Analysis> => {
  const started = Date.now();
  const root = path.resolve(options.root);
  const notify = options.onProgress ?? (() => {});

  notify('reading-project');
  const config = options.config ?? (await loadConfig(root));
  const { files: relativePaths, truncated } = scanFiles(
    root,
    config,
    options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  );

  notify('parsing');
  const cache =
    options.cache === false ? new ParseCache(null) : (options.cache ?? ParseCache.open(root));
  const { files, warnings } = parseAll(root, relativePaths, cache);
  cache.save(new Set(relativePaths));

  const project = detectProject(root, { files: relativePaths });

  notify('building-graph');
  const resolver = createResolverContext(root, relativePaths, project.languages);
  const graph = buildDependencyGraph(files, resolver);

  notify('analyzing-architecture');
  const layers = buildLayerModel(config, files);
  const cycles = findCycles(graph);

  const context: AnalysisContext = {
    root,
    config,
    project,
    files,
    fileMap: new Map(files.map((file) => [file.path, file])),
    graph,
    layers,
    cycles,
    changes: options.changes ?? null,
  };

  notify('running-rules');
  const findings: Finding[] = [];
  for (const rule of allRules) {
    try {
      findings.push(...rule.run(context));
    } catch (error) {
      // One broken rule must never take down the whole analysis.
      findings.push(ruleCrashFinding(rule.id, error));
    }
  }

  const sorted = sortFindings(findings);
  const stats = computeStats(context, sorted);
  const metrics = computeMetrics(stats, project.hasTypeScript);

  notify('done');

  return {
    context,
    cache,
    result: {
      metrics,
      stats,
      findings: sorted,
      fileMetrics: fileMetricsOf(files),
      project,
      warnings,
      truncated,
      durationMs: Date.now() - started,
    },
  };
};

/**
 * Parses every file, skipping the ones that cannot be read or understood.
 *
 * A single unreadable or malformed file must never take down the analysis of
 * the other few thousand, so failures become warnings the report can mention.
 */
const parseAll = (
  root: string,
  relativePaths: string[],
  cache: ParseCache,
): { files: ParsedFile[]; warnings: AnalysisWarning[] } => {
  const files: ParsedFile[] = [];
  const warnings: AnalysisWarning[] = [];

  for (const relative of relativePaths) {
    const absolute = path.join(root, relative);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolute);
    } catch {
      warnings.push({ file: relative, message: 'could not be read' });
      continue;
    }

    const cached = cache.get(relative, stats);
    if (cached) {
      files.push({ ...cached, absPath: absolute });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absolute, 'utf8');
    } catch {
      warnings.push({ file: relative, message: 'could not be read' });
      continue;
    }

    // The file looks changed, but a rewritten mtime is not a rewritten file.
    // Comparing the content hash against the stale entry costs one hash and
    // saves a full parse after a checkout, a rebase or a formatter run.
    const stale = cache.peek(relative);
    if (stale && stale.hash === hashContent(content)) {
      cache.set(relative, stats, stale);
      files.push({ ...stale, absPath: absolute });
      continue;
    }

    try {
      const parsed = parseFile({ path: relative, absPath: absolute, content });
      if (!parsed) continue;
      cache.set(relative, stats, parsed);
      files.push(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push({ file: relative, message: `could not be parsed (${reason})` });
    }
  }

  return { files, warnings };
};

const ruleCrashFinding = (ruleId: string, error: unknown): Finding => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: 'internal/rule-error',
    fingerprint: `rule-error-${ruleId}`,
    severity: 'info',
    category: 'maintainability',
    title: `Rule ${ruleId} failed to run`,
    message: `Little Owl could not finish this rule: ${message}. The rest of the analysis is unaffected.`,
    suggestion: 'Please report this at https://github.com/littleowlcode/little-owl-code/issues',
  };
};
