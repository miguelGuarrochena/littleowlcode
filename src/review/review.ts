import type { Finding, MetricKey, ReviewResult, ReviewStatus, ScopeResult } from '../core/types.js';
import { analyzeProject, type ProgressStep } from '../core/analyze.js';
import { loadConfig } from '../config/load.js';
import {
  compareToBaseline,
  configDriftedFromBaseline,
  readBaseline,
} from '../baseline/baseline.js';
import { detectChanges } from '../git/git.js';
import { checkScope } from './scope.js';
import { fingerprint } from '../utils/hash.js';
import { sortFindings, type AnalysisContext } from '../core/context.js';

/** A review plus the analysis context it was produced from. */
export interface Review {
  review: ReviewResult;
  context: AnalysisContext;
}

export interface ReviewOptions {
  root: string;
  /** Git ref to compare against; defaults to "whatever changed recently". */
  base?: string;
  scope?: string[];
  cache?: boolean;
  onProgress?: (step: ProgressStep) => void;
}

const SCOPE_RULE = { id: 'scope/out-of-scope-change', category: 'scope' as const };

/**
 * The review, and the analysis it came from.
 *
 * `runReview` is kept as the narrower function it always was, because it is
 * public API; this is the variant the CLI uses, since every guided screen needs
 * the dependency graph to answer "what else is involved here?".
 */
export const runReviewWithContext = async (options: ReviewOptions): Promise<Review> => {
  const config = await loadConfig(options.root);
  const changes = detectChanges(options.root, options.base ? { base: options.base } : {});

  const { result, context } = await analyzeProject({
    root: options.root,
    config,
    changes,
    cache: options.cache === false ? false : undefined,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const scopePatterns = options.scope ?? config.scope;
  const scope = changes ? checkScope(changes, scopePatterns) : null;
  if (scope) {
    const scopeFinding = buildScopeFinding(scope);
    if (scopeFinding) result.findings = sortFindings([...result.findings, scopeFinding]);
  }

  const baseline = readBaseline(options.root);
  const comparison = baseline ? compareToBaseline(baseline, result) : null;

  const review: ReviewResult = {
    status: determineStatus(
      comparison?.newFindings ?? result.findings,
      comparison?.drift ?? null,
      scope,
      baseline !== null,
    ),
    current: result,
    baseline,
    changes,
    newFindings: comparison?.newFindings ?? [],
    resolvedFindings: comparison?.resolvedFindings ?? [],
    scope,
    drift: comparison?.drift ?? null,
    configDrifted: configDriftedFromBaseline(baseline, config),
  };

  return { review, context };
};

export const runReview = async (options: ReviewOptions): Promise<ReviewResult> =>
  (await runReviewWithContext(options)).review;

/**
 * Scope is not a configurable rule — it comes from what the developer said the
 * change was for — so the finding is built directly rather than through the
 * rule pipeline.
 */
const buildScopeFinding = (scope: ScopeResult): Finding | null => {
  if (scope.outOfScope.length === 0) return null;
  const count = scope.outOfScope.length;

  return {
    id: SCOPE_RULE.id,
    fingerprint: fingerprint([SCOPE_RULE.id, ...scope.outOfScope]),
    severity: 'warning',
    category: 'scope',
    title: `${count} file${count === 1 ? '' : 's'} changed outside the requested area`,
    message:
      `This change was scoped to ${scope.patterns.join(', ')}, but ${count} file` +
      `${count === 1 ? '' : 's'} outside that area changed too.`,
    detail: scope.outOfScope.slice(0, 10),
    suggestion:
      'Check whether those edits were intended. If they were, widen the scope; if not, revert them.',
    current: scope.outOfScope,
  };
};

/**
 * A review is judged on what the change introduced, not on problems that were
 * already there. That distinction is the whole point of having a baseline.
 */
export const determineStatus = (
  findings: Finding[],
  drift: Record<MetricKey, number> | null,
  scope: ScopeResult | null,
  hasBaseline = true,
): ReviewStatus => {
  const hasErrors = findings.some((finding) => finding.severity === 'error');
  const outOfScope = (scope?.outOfScope.length ?? 0) > 0;

  // Without a baseline there is no drift to judge, and every pre-existing
  // finding would count as "new". Report the state of the code rather than a
  // change that cannot be measured yet.
  if (!hasBaseline) {
    if (hasErrors) return 'degraded';
    return outOfScope ? 'needs-review' : 'healthy';
  }

  const overallDrop = drift ? -drift.overall : 0;
  if (hasErrors || overallDrop >= 5) return 'degraded';

  const hasNewWarnings = findings.some((finding) => finding.severity === 'warning');
  if (hasNewWarnings || overallDrop > 0 || outOfScope) return 'needs-review';

  return 'healthy';
};
