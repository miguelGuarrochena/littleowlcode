import { runReview } from '../../review/review.js';
import { loadConfig } from '../../config/load.js';
import { printJson, reviewToJson } from '../../output/json.js';
import { countBySeverity } from '../../output/report.js';
import { statusText } from '../../output/theme.js';
import { print, readVersion, resolveRoot, type GlobalOptions } from '../runtime.js';
import type { Finding, ReviewResult } from '../../core/types.js';

export interface CiOptions extends GlobalOptions {
  json?: boolean;
  base?: string;
  scope?: string[];
  failOn?: 'error' | 'warning' | 'never';
  maxDrop?: number;
  /** Consider every finding, not only the ones this change introduced. */
  all?: boolean;
}

export interface CiVerdict {
  passed: boolean;
  reasons: string[];
  exitCode: number;
}

/**
 * `little-owl ci` — non-interactive, deterministic, exit-code driven.
 *
 * By default only findings that are *new* relative to the baseline can fail a
 * build. A project with existing debt can adopt Little Owl without having to
 * fix everything first.
 */
export async function ciCommand(options: CiOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);

  const review = await runReview({
    root,
    ...(options.base ? { base: options.base } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });

  const failOn = options.failOn ?? config.ci.failOn;
  const maxDrop = options.maxDrop ?? config.ci.maxOverallDrop;
  const newOnly = options.all ? false : config.ci.newFindingsOnly && review.baseline !== null;

  const verdict = evaluateCi(review, { failOn, maxDrop, newOnly });

  if (options.json) {
    printJson({
      ...reviewToJson(review, readVersion()),
      ci: {
        passed: verdict.passed,
        reasons: verdict.reasons,
        failOn,
        maxDrop,
        newFindingsOnly: newOnly,
      },
    });
    return verdict.exitCode;
  }

  const considered = newOnly ? review.newFindings : review.current.findings;
  const counts = countBySeverity(considered);

  print(`little-owl: ${statusText[review.status]}`);
  print(
    `findings: ${counts.error} error, ${counts.warning} warning, ${counts.info} info` +
      `${newOnly ? ' (new since baseline)' : ''}`,
  );
  if (review.baseline) {
    print(`overall: ${review.baseline.metrics.overall} -> ${review.current.metrics.overall}`);
  } else {
    print(`overall: ${review.current.metrics.overall} (no baseline)`);
  }

  for (const finding of considered.filter((entry) => entry.severity !== 'info').slice(0, 20)) {
    print(`  ${finding.severity}: ${location(finding)} ${finding.title}`);
  }

  print('');
  print(verdict.passed ? 'result: pass' : `result: fail (${verdict.reasons.join('; ')})`);
  return verdict.exitCode;
}

function location(finding: Finding): string {
  if (!finding.file) return '';
  return `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
}

export interface CiThresholds {
  failOn: 'error' | 'warning' | 'never';
  maxDrop: number;
  newOnly: boolean;
}

export function evaluateCi(review: ReviewResult, thresholds: CiThresholds): CiVerdict {
  const considered = thresholds.newOnly ? review.newFindings : review.current.findings;
  const counts = countBySeverity(considered);
  const reasons: string[] = [];

  if (thresholds.failOn === 'error' && counts.error > 0) {
    reasons.push(`${counts.error} error-level finding${counts.error === 1 ? '' : 's'}`);
  }
  if (thresholds.failOn === 'warning' && counts.error + counts.warning > 0) {
    reasons.push(
      `${counts.error + counts.warning} finding${counts.error + counts.warning === 1 ? '' : 's'} at warning or above`,
    );
  }

  const drop = review.drift ? -review.drift.overall : 0;
  if (drop > thresholds.maxDrop) {
    reasons.push(`overall score dropped ${drop} points (limit ${thresholds.maxDrop})`);
  }

  const passed = reasons.length === 0;
  return { passed, reasons, exitCode: passed ? 0 : 1 };
}
