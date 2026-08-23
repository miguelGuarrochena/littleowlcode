import type { AnalysisResult, Finding, Metrics, ProjectInfo } from '../core/types.js';
import { colors, dim, icons, severityColor, severityIcon } from './theme.js';
import { box, countLabel, heading, indent, metricLine, rule, scoreBar, wrap } from './ui.js';
import { MAX_SCANNED_FILES } from '../core/scan.js';
import { describeStack } from '../detect/project.js';

const METRIC_LABELS: Array<[keyof Omit<Metrics, 'overall'>, string]> = [
  ['architecture', 'Architecture'],
  ['maintainability', 'Maintainability'],
  ['complexity', 'Complexity'],
  ['dependencies', 'Dependencies'],
  ['typeSafety', 'Type Safety'],
];

export interface RenderOptions {
  /** Show every finding instead of the highest-signal ones. */
  details?: boolean;
  quiet?: boolean;
  maxFindings?: number;
}

export const renderProjectSummary = (project: ProjectInfo, testFiles?: number): string => {
  const lines = [
    `${colors.bold('Name')}            ${project.name}`,
    `${colors.bold('Stack')}           ${describeStack(project)}`,
  ];
  if (project.packageManager) {
    lines.push(`${colors.bold('Package manager')} ${project.packageManager}`);
  }
  // Two different file counts appear across the reports — everything scanned,
  // and the source files the scores are computed from. Saying both here, once,
  // stops them looking like a contradiction later.
  const breakdown =
    testFiles !== undefined && testFiles > 0
      ? dim(`  (${project.fileCount - testFiles} source, ${testFiles} test)`)
      : '';
  lines.push(`${colors.bold('Files')}           ${project.fileCount}${breakdown}`);
  lines.push(
    `${colors.bold('Git')}             ${project.isGitRepo ? colors.green(icons.ok) : dim('not a git repository')}`,
  );
  if (project.monorepo) {
    lines.push(`${colors.bold('Monorepo')}        ${project.monorepo.kind}`);
  }
  return lines.join('\n');
};

/**
 * A banner for a partial analysis.
 *
 * Every number in a truncated run describes part of the repository, so it has
 * to be said out loud rather than left for the reader to work out.
 */
export const renderTruncationNotice = (): string => {
  return [
    colors.yellow(
      `${icons.warn} Only the first ${MAX_SCANNED_FILES.toLocaleString()} source files were scanned.`,
    ),
    dim('   This report covers part of the repository, not all of it. Narrow the analysis'),
    dim('   with `include` or `ignore` in .little-owl/config.ts for numbers you can compare.'),
  ].join('\n');
};

/**
 * Shown instead of a score when nothing was analysed.
 *
 * With no scanned files every metric sits at 100, because there is nothing to
 * lose points for. Stating the empty case plainly avoids handing back a
 * perfect score for an empty measurement.
 */
export const renderEmptyAnalysis = (): string => {
  return [
    heading('CODEBASE HEALTH'),
    '',
    colors.yellow(`${icons.warn} No source files were analysed, so there is nothing to score.`),
    '',
    dim('Little Owl reads .ts, .tsx, .js, .jsx, .mjs, .cjs, .py and .go files. This usually means'),
    dim('the sources live somewhere the `include` or `ignore` patterns exclude, or that you are'),
    dim('not in the project root.'),
    '',
    dim(`${icons.arrow} little-owl doctor  shows what Little Owl can and cannot see here.`),
  ].join('\n');
};

export const renderHealth = (result: AnalysisResult, options: RenderOptions = {}): string => {
  if (result.project.fileCount === 0) return renderEmptyAnalysis();

  const counts = countBySeverity(result.findings);
  const sections: string[] = [
    heading('CODEBASE HEALTH'),
    '',
    dim('Overall'),
    '',
    `  ${colors.bold(String(result.metrics.overall))} ${dim('/ 100')}`,
    `  ${scoreBar(result.metrics.overall)}`,
    '',
    ...METRIC_LABELS.map(([key, label]) => metricLine({ label, value: result.metrics[key] })),
    '',
    renderCounts(counts, result.findings.length),
  ];

  if (result.truncated) sections.push('', renderTruncationNotice());

  const findings = renderFindings(result.findings, options);
  if (findings) sections.push('', findings);

  return sections.join('\n');
};

/** Every score, with the baseline value alongside it when there is one. */
export const renderMetricComparison = (current: Metrics, baseline: Metrics | null): string[] => {
  const line = (label: string, key: keyof Metrics): string =>
    metricLine({
      label,
      value: current[key],
      ...(baseline ? { previous: baseline[key] } : {}),
    });

  return [...METRIC_LABELS.map(([key, label]) => line(label, key)), line('Overall', 'overall')];
};

export const renderFindings = (findings: Finding[], options: RenderOptions = {}): string => {
  if (findings.length === 0) return '';
  if (options.quiet) return '';

  const limit = options.details ? findings.length : (options.maxFindings ?? 5);
  const shown = findings.slice(0, limit);
  const blocks = shown.map((finding) => renderFinding(finding, options.details ?? false));

  if (findings.length > shown.length) {
    blocks.push(
      dim(
        `${findings.length - shown.length} more finding${findings.length - shown.length === 1 ? '' : 's'} — run with --details to see them.`,
      ),
    );
  }

  return [colors.bold('FINDINGS'), '', blocks.join(`\n${rule()}\n\n`)].join('\n');
};

export const renderFinding = (finding: Finding, verbose: boolean): string => {
  const paint = severityColor(finding.severity);
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';

  const lines = [
    `${severityIcon[finding.severity]} ${paint(finding.category)}  ${colors.bold(finding.title)}`,
  ];
  if (location) lines.push(dim(`   ${location}`));
  lines.push('', ...wrap(finding.message, 74).map((line) => `   ${line}`));

  if (finding.detail && finding.detail.length > 0) {
    const detail = verbose ? finding.detail : finding.detail.slice(0, 3);
    lines.push('', ...detail.map((entry) => dim(`   ${entry}`)));
    if (!verbose && finding.detail.length > detail.length) {
      lines.push(dim(`   ... and ${finding.detail.length - detail.length} more`));
    }
  }

  if (finding.suggestion) {
    lines.push('', ...wrap(`${icons.arrow} ${finding.suggestion}`, 74).map((line) => `   ${line}`));
  }

  return lines.join('\n');
};

export const countBySeverity = (
  findings: Finding[],
): {
  error: number;
  warning: number;
  info: number;
} => {
  return {
    error: findings.filter((finding) => finding.severity === 'error').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
  };
};

const renderCounts = (
  counts: { error: number; warning: number; info: number },
  total: number,
): string => {
  const parts: string[] = [];
  if (counts.error > 0)
    parts.push(
      colors.red(`${severityIcon.error} ${countLabel(counts.error, 'critical', 'critical')}`),
    );
  if (counts.warning > 0) {
    parts.push(
      colors.yellow(
        `${severityIcon.warning} ${countLabel(counts.warning, 'important', 'important')}`,
      ),
    );
  }
  if (counts.info > 0)
    parts.push(colors.blue(`${severityIcon.info} ${countLabel(counts.info, 'minor', 'minor')}`));
  if (parts.length === 0) {
    parts.push(colors.green(`${icons.ok} nothing flagged`));
  }
  const suffix = total > 0 ? dim(`   (${total} total findings in the project)`) : '';
  return parts.join('   ') + suffix;
};

export const renderOwlLine = (message: string, tone: 'good' | 'warn' | 'bad' = 'good'): string => {
  const paint = tone === 'good' ? colors.green : tone === 'warn' ? colors.yellow : colors.red;
  return `${icons.owl} ${paint(message)}`;
};

export { box, indent };
