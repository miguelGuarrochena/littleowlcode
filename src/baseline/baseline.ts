import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult, Baseline, Finding, MetricKey, Metrics } from '../core/types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { currentBranch, headCommit } from '../git/git.js';
import { ensureConfigDir } from '../config/load.js';
import { configFingerprint } from '../config/fingerprint.js';

export const BASELINE_VERSION = '1';

export const baselinePath = (root: string): string => {
  return path.join(root, '.little-owl', 'baseline.json');
};

export const readBaseline = (root: string): Baseline | null => {
  const file = baselinePath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
    if (parsed.version !== BASELINE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const buildBaseline = (
  root: string,
  result: AnalysisResult,
  config?: ResolvedConfig,
): Baseline => {
  return {
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    commit: headCommit(root) ?? undefined,
    branch: currentBranch(root) ?? undefined,
    configFingerprint: config ? configFingerprint(config) : undefined,
    metrics: result.metrics,
    stats: result.stats,
    findings: result.findings,
    fileMetrics: result.fileMetrics,
  };
};

/**
 * Whether the configuration moved since the baseline was recorded.
 *
 * `null` means the question cannot be answered — a baseline written by an older
 * version has no fingerprint, and guessing "changed" would nag every user once.
 */
export const configDriftedFromBaseline = (
  baseline: Baseline | null,
  config: ResolvedConfig,
): boolean | null => {
  if (!baseline || !baseline.configFingerprint) return null;
  return baseline.configFingerprint !== configFingerprint(config);
};

/**
 * The one-paragraph explanation shown whenever a comparison is running against
 * a baseline recorded under different settings. Kept here so `review`, `ci` and
 * `watch` all say exactly the same thing.
 */
export const CONFIG_DRIFT_NOTICE = [
  'The configuration changed since this baseline was recorded.',
  'Findings that already existed can show up as new, so treat the comparison as a guide.',
  'Run `little-owl baseline` to re-record against the current configuration.',
];

/**
 * Writes the baseline. This is always an explicit action: Little Owl never
 * refreshes the baseline on its own, because a baseline that follows the code
 * downhill would hide exactly the drift it exists to catch.
 */
export const writeBaseline = (root: string, baseline: Baseline): string => {
  ensureConfigDir(root);
  const file = baselinePath(root);
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return file;
};

export interface BaselineComparison {
  drift: Record<MetricKey, number>;
  newFindings: Finding[];
  resolvedFindings: Finding[];
}

export const compareToBaseline = (
  baseline: Baseline,
  result: AnalysisResult,
): BaselineComparison => {
  const baselineFingerprints = new Set(baseline.findings.map((finding) => finding.fingerprint));
  const currentFingerprints = new Set(result.findings.map((finding) => finding.fingerprint));

  return {
    drift: metricDrift(baseline.metrics, result.metrics),
    newFindings: result.findings.filter(
      (finding) => !baselineFingerprints.has(finding.fingerprint),
    ),
    resolvedFindings: baseline.findings.filter(
      (finding) => !currentFingerprints.has(finding.fingerprint),
    ),
  };
};

export const metricDrift = (before: Metrics, after: Metrics): Record<MetricKey, number> => {
  const keys = Object.keys(before) as MetricKey[];
  const drift = {} as Record<MetricKey, number>;
  for (const key of keys) drift[key] = after[key] - before[key];
  return drift;
};

/**
 * Explains a metric change in terms of the counts behind it, so "architecture
 * dropped 7 points" can always be turned into "because of these two cycles".
 */
export const explainDrift = (baseline: Baseline, result: AnalysisResult): string[] => {
  const reasons: string[] = [];
  const before = baseline.stats;
  const after = result.stats;

  const deltas: Array<[keyof typeof before, string]> = [
    ['cycles', 'circular dependenc'],
    ['layerViolations', 'inverted layer dependenc'],
    ['layerSkips', 'skipped-layer import'],
    ['crossFeatureImports', 'cross-feature import'],
    ['largeFiles', 'oversized file'],
    ['largeFunctions', 'oversized function'],
    ['complexFunctions', 'over-complex function'],
    ['anyUsages', '`any` usage'],
    ['suppressions', '@ts-ignore suppression'],
    ['unresolvedImports', 'unresolved import'],
  ];

  for (const [key, label] of deltas) {
    const delta = after[key] - before[key];
    if (delta === 0) continue;
    const noun = label.endsWith('c')
      ? `${label}${Math.abs(delta) === 1 ? 'y' : 'ies'}`
      : `${label}${Math.abs(delta) === 1 ? '' : 's'}`;
    reasons.push(`${delta > 0 ? '+' : ''}${delta} ${noun}`);
  }

  return reasons;
};
