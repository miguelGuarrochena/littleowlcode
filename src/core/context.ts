import type { ResolvedConfig } from '../config/schema.js';
import type { LayerModel } from '../architecture/layers.js';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { Cycle } from '../graph/cycles.js';
import type {
  ChangeSet,
  Finding,
  FindingCategory,
  ParsedFile,
  ProjectInfo,
  ReportedSeverity,
  Severity,
} from './types.js';
import { fingerprint } from '../utils/hash.js';

export interface AnalysisContext {
  root: string;
  config: ResolvedConfig;
  project: ProjectInfo;
  files: ParsedFile[];
  fileMap: Map<string, ParsedFile>;
  graph: DependencyGraph;
  layers: LayerModel;
  cycles: Cycle[];
  /** Present when the caller narrowed the run to a set of changed files. */
  changes: ChangeSet | null;
}

export interface Rule {
  id: string;
  category: FindingCategory;
  /** One line explaining what this rule looks for; shown by `little-owl config`. */
  description: string;
  run(context: AnalysisContext): Finding[];
}

export interface NewFinding {
  file?: string;
  line?: number;
  title: string;
  message: string;
  detail?: string[];
  suggestion?: string;
  baseline?: unknown;
  current?: unknown;
  /** Extra parts that make this finding unique within its rule. */
  key?: (string | number | undefined)[];
}

/**
 * Builds a finding for `rule`, resolving its severity from config and giving it
 * a stable fingerprint so later runs can tell old problems from new ones.
 *
 * Returns `null` when the rule is switched off, which keeps rule bodies free of
 * severity checks.
 */
export const createFinding = (
  rule: Pick<Rule, 'id' | 'category'>,
  context: AnalysisContext,
  input: NewFinding,
): Finding | null => {
  const severity = severityOf(rule.id, context.config);
  if (severity === 'off') return null;

  return {
    id: rule.id,
    fingerprint: fingerprint([rule.id, input.file, ...(input.key ?? [])]),
    severity: severity as ReportedSeverity,
    category: rule.category,
    file: input.file,
    line: input.line,
    title: input.title,
    message: input.message,
    detail: input.detail,
    suggestion: input.suggestion,
    baseline: input.baseline,
    current: input.current,
  };
};

export const severityOf = (ruleId: string, config: ResolvedConfig): Severity => {
  return config.rules[ruleId] ?? 'off';
};

export const isEnabled = (ruleId: string, config: ResolvedConfig): boolean => {
  return severityOf(ruleId, config) !== 'off';
};

/** Findings sort by severity, then category, then file, so output is stable. */
const SEVERITY_RANK: Record<ReportedSeverity, number> = { error: 0, warning: 1, info: 2 };

export const sortFindings = (findings: Finding[]): Finding[] => {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    const fileA = a.file ?? '';
    const fileB = b.file ?? '';
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
};
