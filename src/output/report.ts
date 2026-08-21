import type {
  AnalysisResult,
  ChangeSet,
  Finding,
  Metrics,
  ProjectInfo,
  ReviewResult,
} from '../core/types.js';
import type { AnalysisContext } from '../core/context.js';
import {
  colors,
  dim,
  icons,
  severityColor,
  severityIcon,
  statusColor,
  statusIcon,
  statusText,
} from './theme.js';
import { box, countLabel, heading, indent, metricLine, rule, scoreBar, wrap } from './ui.js';
import { MAX_SCANNED_FILES } from '../core/scan.js';
import { describeStack } from '../detect/project.js';
import {
  isImplicitlyUsed,
  undeclaredPackages,
  unusedDependencies,
} from '../detect/dependencies.js';
import { describeLayerChain, layerOf } from '../architecture/layers.js';
import { explainDrift } from '../baseline/baseline.js';
import { groupByArea } from '../review/scope.js';
import type { ImpactReport } from '../review/impact.js';
import { routeLabel } from '../review/impact.js';

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

export function renderProjectSummary(project: ProjectInfo): string {
  const lines = [
    `${colors.bold('Name')}            ${project.name}`,
    `${colors.bold('Stack')}           ${describeStack(project)}`,
  ];
  if (project.packageManager) {
    lines.push(`${colors.bold('Package manager')} ${project.packageManager}`);
  }
  lines.push(`${colors.bold('Files')}           ${project.fileCount}`);
  lines.push(
    `${colors.bold('Git')}             ${project.isGitRepo ? colors.green(icons.ok) : dim('not a git repository')}`,
  );
  if (project.monorepo) {
    lines.push(`${colors.bold('Monorepo')}        ${project.monorepo.kind}`);
  }
  return lines.join('\n');
}

/**
 * A banner for a partial analysis.
 *
 * Every number in a truncated run describes part of the repository, so it has
 * to be said out loud rather than left for the reader to work out.
 */
export function renderTruncationNotice(): string {
  return [
    colors.yellow(
      `${icons.warn} Only the first ${MAX_SCANNED_FILES.toLocaleString()} source files were scanned.`,
    ),
    dim('   This report covers part of the repository, not all of it. Narrow the analysis'),
    dim('   with `include` or `ignore` in .little-owl/config.ts for numbers you can compare.'),
  ].join('\n');
}

/**
 * Shown instead of a score when nothing was analysed.
 *
 * A project with no scanned files scores 100 on every metric, because there is
 * nothing to lose points for. Printing that would be the most misleading
 * output this tool can produce, so the empty case is stated plainly instead.
 */
export function renderEmptyAnalysis(): string {
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
}

export function renderHealth(result: AnalysisResult, options: RenderOptions = {}): string {
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
}

/** Every score, with the baseline value alongside it when there is one. */
function renderMetricComparison(current: Metrics, baseline: Metrics | null): string[] {
  const line = (label: string, key: keyof Metrics): string =>
    metricLine({
      label,
      value: current[key],
      ...(baseline ? { previous: baseline[key] } : {}),
    });

  return [...METRIC_LABELS.map(([key, label]) => line(label, key)), line('Overall', 'overall')];
}

export function renderReview(review: ReviewResult, options: RenderOptions = {}): string {
  const { current, baseline, changes, scope } = review;
  const shown = review.baseline ? review.newFindings : current.findings;
  const sections: string[] = [heading(`${icons.owl} CODEBASE REVIEW`), ''];

  if (changes) {
    const size = changeSize(changes);
    sections.push(
      `${colors.bold(countLabel(size.files, 'file'))} changed ${dim(`(${changes.description})`)}`,
    );
    if (size.insertions > 0 || size.deletions > 0) {
      sections.push(
        `${colors.green(`+${size.insertions.toLocaleString()}`)} ${colors.red(`-${size.deletions.toLocaleString()}`)} ${dim('lines')}` +
          (size.areas > 1 ? dim(`   across ${countLabel(size.areas, 'area')}`) : ''),
      );
    }
    sections.push('');
  }

  sections.push(
    `${statusColor(review.status)(`${statusIcon(review.status)} ${statusText[review.status]}`)}`,
    '',
  );

  sections.push(...renderMetricComparison(current.metrics, baseline?.metrics ?? null));

  if (baseline) {
    const reasons = explainDrift(baseline, current);
    if (reasons.length > 0) {
      sections.push('', dim(`Since the baseline: ${reasons.join(', ')}`));
    }
  } else {
    sections.push(
      '',
      dim('No baseline yet — run `little-owl baseline` to make future reviews comparable.'),
    );
  }

  sections.push('', renderCounts(countBySeverity(shown), current.findings.length));

  if (review.resolvedFindings.length > 0) {
    sections.push(
      colors.green(
        `${icons.ok} ${countLabel(review.resolvedFindings.length, 'earlier finding')} resolved`,
      ),
    );
  }

  if (scope && scope.outOfScope.length > 0) {
    sections.push('', renderScope(scope.patterns, scope.outOfScope));
  }

  if (current.truncated) sections.push('', renderTruncationNotice());

  const findings = renderFindings(shown, options);
  if (findings) sections.push('', findings);
  else
    sections.push(
      '',
      colors.green(`${icons.owl} Looking good. This change did not introduce new findings.`),
    );

  return sections.join('\n');
}

export interface ChangeSize {
  files: number;
  insertions: number;
  deletions: number;
  /** Distinct top-level directories touched. */
  areas: number;
  magnitude: 'small' | 'medium' | 'large';
}

/**
 * How big the change is, separate from whether it is good. A large change is
 * not wrong, but it is worth knowing before reading four findings and assuming
 * you have seen everything.
 */
export function changeSize(changes: ChangeSet): ChangeSize {
  const insertions = changes.files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = changes.files.reduce((sum, file) => sum + file.deletions, 0);
  const areas = new Set(
    changes.files.map((file) =>
      file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '.',
    ),
  ).size;

  const touched = insertions + deletions;
  const magnitude =
    changes.files.length > 30 || touched > 1500
      ? 'large'
      : changes.files.length > 10 || touched > 400
        ? 'medium'
        : 'small';

  return { files: changes.files.length, insertions, deletions, areas, magnitude };
}

function renderScope(patterns: string[], outOfScope: string[]): string {
  const groups = groupByArea(outOfScope);
  const lines = [
    colors.yellow(`${icons.warn} SCOPE`),
    '',
    `  ${dim('expected:')} ${patterns.join(', ')}`,
    `  ${dim('also changed:')}`,
    ...groups.map(
      (group) => `    ${group.area}/ ${dim(`(${countLabel(group.files.length, 'file')})`)}`,
    ),
  ];
  return lines.join('\n');
}

export function renderFindings(findings: Finding[], options: RenderOptions = {}): string {
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
}

export function renderFinding(finding: Finding, verbose: boolean): string {
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
}

export function countBySeverity(findings: Finding[]): {
  error: number;
  warning: number;
  info: number;
} {
  return {
    error: findings.filter((finding) => finding.severity === 'error').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
  };
}

function renderCounts(
  counts: { error: number; warning: number; info: number },
  total: number,
): string {
  const parts: string[] = [];
  if (counts.error > 0)
    parts.push(
      colors.red(`${severityIcon.error} ${countLabel(counts.error, 'critical', 'critical')}`),
    );
  if (counts.warning > 0) {
    parts.push(colors.yellow(`${severityIcon.warning} ${countLabel(counts.warning, 'warning')}`));
  }
  if (counts.info > 0)
    parts.push(colors.blue(`${severityIcon.info} ${countLabel(counts.info, 'note')}`));
  if (parts.length === 0) {
    parts.push(colors.green(`${icons.ok} nothing flagged`));
  }
  const suffix = total > 0 ? dim(`   (${total} total findings in the project)`) : '';
  return parts.join('   ') + suffix;
}

export function renderArchitecture(context: AnalysisContext): string {
  const { layers, graph } = context;
  const sections: string[] = [heading('ARCHITECTURE'), ''];

  if (layers.order.length === 0) {
    sections.push(
      dim('No layered structure detected.'),
      '',
      ...wrap(
        'Little Owl looks for conventional directories such as app, components, services and ' +
          'repositories. Declare your own layers in .little-owl/config.ts to get boundary checks.',
      ),
    );
    return sections.join('\n');
  }

  sections.push(
    layers.inferred
      ? dim('Detected from the directory structure (not configured):')
      : dim('From your configuration:'),
    '',
  );

  layers.order.forEach((layer, index) => {
    const directories = (layers.dirsByLayer[layer] ?? []).join(', ');
    sections.push(`  ${colors.bold(layer)} ${dim(directories ? `(${directories})` : '')}`);
    if (index < layers.order.length - 1) sections.push(dim('   ↓'));
  });

  const fileCounts = new Map<string, number>();
  for (const file of context.files) {
    const layer = layerOf(file.path, layers);
    if (!layer) continue;
    fileCounts.set(layer, (fileCounts.get(layer) ?? 0) + 1);
  }

  sections.push(
    '',
    dim(
      `Policy: ${layers.policy === 'adjacent' ? 'a layer may only use the layer directly below it' : 'a layer may use any layer below it'}`,
    ),
  );
  sections.push(dim(`Chain:  ${describeLayerChain(layers)}`));
  sections.push('');

  const violations = context.files.length > 0 ? architectureSummary(context) : [];
  if (violations.length === 0) {
    sections.push(colors.green(`${icons.ok} No boundary violations found.`));
  } else {
    sections.push(colors.yellow(`${icons.warn} Boundary issues:`), '');
    sections.push(...violations.map((line) => `  ${line}`));
  }

  sections.push(
    '',
    dim(`${graph.edges.length} internal imports across ${graph.nodes().length} files`),
  );
  return sections.join('\n');
}

function architectureSummary(context: AnalysisContext): string[] {
  const pairs = new Map<string, number>();
  for (const edge of context.graph.edges) {
    if (edge.typeOnly) continue;
    const from = layerOf(edge.from, context.layers);
    const to = layerOf(edge.to, context.layers);
    if (!from || !to || from === to) continue;
    const fromIndex = context.layers.order.indexOf(from);
    const toIndex = context.layers.order.indexOf(to);
    if (fromIndex === -1 || toIndex === -1) continue;

    const isProblem =
      toIndex < fromIndex || (context.layers.policy === 'adjacent' && toIndex - fromIndex > 1);
    if (!isProblem) continue;

    const key = `${from} → ${to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  return [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([pair, count]) =>
        `${colors.red(icons.error)} ${pair}  ${dim(`(${countLabel(count, 'import')})`)}`,
    );
}

export function renderImpact(report: ImpactReport): string {
  const sections: string[] = [heading('CHANGE IMPACT'), ''];

  if (report.changed.length === 0) {
    sections.push(dim('No changed files to analyse.'));
    return sections.join('\n');
  }

  sections.push(colors.bold('Changed'), ...report.changed.slice(0, 10).map((file) => `  ${file}`));
  if (report.changed.length > 10) {
    sections.push(dim(`  ... and ${report.changed.length - 10} more`));
  }

  if (report.impacted.length === 0) {
    sections.push('', colors.green(`${icons.ok} Nothing else imports these files.`));
    return sections.join('\n');
  }

  sections.push('', colors.bold('Potentially affected'), '');
  for (const level of ['high', 'medium', 'low'] as const) {
    const entries = report.impacted.filter((entry) => entry.level === level);
    if (entries.length === 0) continue;
    const paint = level === 'high' ? colors.red : level === 'medium' ? colors.yellow : dim;
    sections.push(
      paint(`  ${level.toUpperCase()}  ${dim(`(${countLabel(entries.length, 'file')})`)}`),
    );
    sections.push(...entries.slice(0, 8).map((entry) => `    ${entry.path}`));
    if (entries.length > 8) sections.push(dim(`    ... and ${entries.length - 8} more`));
    sections.push('');
  }

  if (report.routes.length > 0) {
    sections.push(
      colors.bold('Routes'),
      ...report.routes.map((file) => `  ${routeLabel(file)} ${dim(file)}`),
      '',
    );
  }

  if (report.tests.length > 0) {
    sections.push(
      colors.bold('Tests that reach this change'),
      ...report.tests.slice(0, 10).map((file) => `  ${file}`),
      '',
    );
  }

  sections.push(
    dim('These files import the change directly or indirectly. That makes them worth testing —'),
    dim('it does not mean they are broken.'),
  );

  return sections.join('\n');
}

export function renderDependencies(context: AnalysisContext): string {
  const imported = context.graph.externalPackages();
  const packages = [...imported].sort();
  const declared = {
    ...context.project.dependencies,
    ...context.project.devDependencies,
  };
  const declaredNames = Object.keys(declared).sort();

  // Same helpers the `unused-dependency` rule uses, so the command and the
  // finding can never disagree about the same package.
  const undeclared = undeclaredPackages(packages, declared);
  const unused = unusedDependencies(declared, imported);
  const implicit = declaredNames.filter(
    (name) => !imported.has(name) && isImplicitlyUsed(name),
  ).length;

  const lines = [
    heading('DEPENDENCIES'),
    '',
    `${colors.bold(String(declaredNames.length))} declared   ${colors.bold(String(packages.length))} imported`,
    '',
  ];

  if (undeclared.length > 0) {
    lines.push(colors.yellow(`${icons.warn} Imported but not declared in package.json`), '');
    lines.push(...undeclared.slice(0, 15).map((name) => `  ${name}`), '');
  }

  if (unused.length > 0) {
    lines.push(
      dim(`${icons.info} Declared but never imported (may be used via config or at runtime)`),
      '',
    );
    lines.push(...unused.slice(0, 15).map((name) => dim(`  ${name}`)), '');
  }

  if (undeclared.length === 0 && unused.length === 0) {
    lines.push(colors.green(`${icons.ok} Declared and imported dependencies line up.`));
  }

  if (implicit > 0) {
    lines.push(
      '',
      dim(
        `${implicit} package${implicit === 1 ? '' : 's'} (type definitions, linters, build tooling) do their job`,
      ),
      dim('without being imported and are not counted above.'),
    );
  }

  lines.push(
    '',
    dim('Little Owl checks dependency hygiene, not security. For vulnerabilities run your'),
    dim('package manager audit command.'),
  );

  return lines.join('\n');
}

export function renderOwlLine(message: string, tone: 'good' | 'warn' | 'bad' = 'good'): string {
  const paint = tone === 'good' ? colors.green : tone === 'warn' ? colors.yellow : colors.red;
  return `${icons.owl} ${paint(message)}`;
}

export { box, indent };
