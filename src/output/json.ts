import type {
  AnalysisResult,
  AnalysisWarning,
  Finding,
  MetricKey,
  Metrics,
  ReviewResult,
} from '../core/types.js';
import { countByPriority, PRIORITY_OF, type Priority, type PriorityCounts } from './severity.js';
import { numberFindings } from './issue.js';

/**
 * Stable JSON contract for `--json`.
 *
 * `schemaVersion` changes only when a field is removed or its meaning changes;
 * new optional fields are added without bumping it. Automation and AI tooling
 * can rely on that.
 */
export const SCHEMA_VERSION = 1;

export interface JsonFinding {
  id: string;
  fingerprint: string;
  /**
   * Issue number, matching what `check` printed and what `fix`/`verify` accept.
   * Derived from the priority ranking, so it is stable for a given code state.
   */
  number: number;
  severity: Finding['severity'];
  /** The severity in the words the reports use: critical, important, minor. */
  priority: Priority;
  category: Finding['category'];
  file?: string;
  line?: number;
  title: string;
  message: string;
  detail?: string[];
  suggestion?: string;
  baseline?: unknown;
  current?: unknown;
}

export interface JsonCheckOutput {
  schemaVersion: number;
  tool: { name: string; version: string };
  project: {
    name: string;
    root: string;
    stack: string[];
    fileCount: number;
    packageManager: string | null;
  };
  metrics: Metrics;
  stats: AnalysisResult['stats'];
  counts: { error: number; warning: number; info: number };
  /** The same totals in the words the reports use. */
  priorities: PriorityCounts;
  findings: JsonFinding[];
  /** Files that could not be read or parsed. Never fatal. */
  warnings: AnalysisWarning[];
  /** True when the scan hit its file limit, so these numbers cover part of the repository. */
  truncated: boolean;
  durationMs: number;
}

export interface JsonReviewOutput extends JsonCheckOutput {
  status: ReviewResult['status'];
  baseline: {
    createdAt: string;
    commit?: string;
    metrics: Metrics;
    /** Whether the config changed after this baseline was recorded. */
    configDrifted: boolean | null;
  } | null;
  drift: Record<MetricKey, number> | null;
  changes: {
    description: string;
    base?: string;
    files: Array<{ path: string; status: string; insertions: number; deletions: number }>;
  } | null;
  scope: {
    patterns: string[];
    outOfScope: string[];
  } | null;
  newFindings: JsonFinding[];
  resolvedFindings: JsonFinding[];
}

const toJsonFinding = (finding: Finding, number: number): JsonFinding => {
  const json: JsonFinding = {
    id: finding.id,
    fingerprint: finding.fingerprint,
    number,
    severity: finding.severity,
    priority: PRIORITY_OF[finding.severity],
    category: finding.category,
    title: finding.title,
    message: finding.message,
  };
  if (finding.file !== undefined) json.file = finding.file;
  if (finding.line !== undefined) json.line = finding.line;
  if (finding.detail !== undefined) json.detail = finding.detail;
  if (finding.suggestion !== undefined) json.suggestion = finding.suggestion;
  if (finding.baseline !== undefined) json.baseline = finding.baseline;
  if (finding.current !== undefined) json.current = finding.current;
  return json;
};

/**
 * Fingerprint to issue number, from the full finding list.
 *
 * A resolved finding no longer has a number, because it no longer has a place
 * in the ranking; 0 says that plainly rather than pointing at whichever issue
 * happens to sit in its old position.
 */
const numbering = (all: Finding[]): ((finding: Finding) => number) => {
  const map = new Map(numberFindings(all).map((issue) => [issue.fingerprint, issue.number]));
  return (finding) => map.get(finding.fingerprint) ?? 0;
};

const counts = (findings: Finding[]): { error: number; warning: number; info: number } => {
  return {
    error: findings.filter((finding) => finding.severity === 'error').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
  };
};

export const checkToJson = (result: AnalysisResult, version: string): JsonCheckOutput => {
  const numbers = numbering(result.findings);
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'little-owl-code', version },
    project: {
      name: result.project.name,
      root: result.project.root,
      stack: [...result.project.frameworks, ...result.project.languages],
      fileCount: result.project.fileCount,
      packageManager: result.project.packageManager,
    },
    metrics: result.metrics,
    stats: result.stats,
    counts: counts(result.findings),
    priorities: countByPriority(result.findings),
    findings: result.findings.map((finding) => toJsonFinding(finding, numbers(finding))),
    warnings: result.warnings,
    truncated: result.truncated,
    durationMs: result.durationMs,
  };
};

export const reviewToJson = (review: ReviewResult, version: string): JsonReviewOutput => {
  const base = checkToJson(review.current, version);
  const numbers = numbering(review.current.findings);

  return {
    ...base,
    status: review.status,
    baseline: review.baseline
      ? {
          createdAt: review.baseline.createdAt,
          ...(review.baseline.commit ? { commit: review.baseline.commit } : {}),
          metrics: review.baseline.metrics,
          // True when the config moved after this baseline was recorded, so
          // `newFindings` may include problems that predate the change.
          configDrifted: review.configDrifted,
        }
      : null,
    drift: review.drift,
    changes: review.changes
      ? {
          description: review.changes.description,
          ...(review.changes.base ? { base: review.changes.base } : {}),
          files: review.changes.files.map((file) => ({
            path: file.path,
            status: file.status,
            insertions: file.insertions,
            deletions: file.deletions,
          })),
        }
      : null,
    scope: review.scope
      ? { patterns: review.scope.patterns, outOfScope: review.scope.outOfScope }
      : null,
    newFindings: review.newFindings.map((finding) => toJsonFinding(finding, numbers(finding))),
    resolvedFindings: review.resolvedFindings.map((finding) =>
      toJsonFinding(finding, numbers(finding)),
    ),
  };
};

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
