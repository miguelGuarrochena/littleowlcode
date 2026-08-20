import type {
  AnalysisResult,
  Finding,
  Metrics,
  ProjectInfo,
  ReviewResult,
} from '../core/types.js';
import type { AnalysisContext } from '../core/context.js';
import { colors, dim, icons, severityColor, severityIcon, statusColor, statusIcon, statusText } from './theme.js';
import { box, countLabel, heading, indent, metricLine, rule, scoreBar, wrap } from './ui.js';
import { describeStack } from '../detect/project.js';
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

export function renderHealth(result: AnalysisResult, options: RenderOptions = {}): string {
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

  const findings = renderFindings(result.findings, options);
  if (findings) sections.push('', findings);

  return sections.join('\n');
}

export function renderReview(review: ReviewResult, options: RenderOptions = {}): string {
  const { current, baseline, changes, scope } = review;
  const shown = review.baseline ? review.newFindings : current.findings;
  const sections: string[] = [heading(`${icons.owl} CODEBASE REVIEW`), ''];

  if (changes) {
    const changedCount = changes.files.length;
    sections.push(
      `${colors.bold(countLabel(changedCount, 'file'))} changed ${dim(`(${changes.description})`)}`,
      '',
    );
  }

  sections.push(
    `${statusColor(review.status)(`${statusIcon(review.status)} ${statusText[review.status]}`)}`,
    '',
  );

  for (const [key, label] of METRIC_LABELS) {
    sections.push(
      metricLine({
        label,
        value: current.metrics[key],
        ...(baseline ? { previous: baseline.metrics[key] } : {}),
      }),
    );
  }
  sections.push(
    metricLine({
      label: 'Overall',
      value: current.metrics.overall,
      ...(baseline ? { previous: baseline.metrics.overall } : {}),
    }),
  );

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
      colors.green(`${icons.ok} ${countLabel(review.resolvedFindings.length, 'earlier finding')} resolved`),
    );
  }

  if (scope && scope.outOfScope.length > 0) {
    sections.push('', renderScope(scope.patterns, scope.outOfScope));
  }

  const findings = renderFindings(shown, options);
  if (findings) sections.push('', findings);
  else sections.push('', colors.green(`${icons.owl} Looking good. This change did not introduce new findings.`));

  return sections.join('\n');
}

function renderScope(patterns: string[], outOfScope: string[]): string {
  const groups = groupByArea(outOfScope);
  const lines = [
    colors.yellow(`${icons.warn} SCOPE`),
    '',
    `  ${dim('expected:')} ${patterns.join(', ')}`,
    `  ${dim('also changed:')}`,
    ...groups.map((group) => `    ${group.area}/ ${dim(`(${countLabel(group.files.length, 'file')})`)}`),
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
  const location = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
    : '';

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
  if (counts.error > 0) parts.push(colors.red(`${severityIcon.error} ${countLabel(counts.error, 'critical', 'critical')}`));
  if (counts.warning > 0) {
    parts.push(colors.yellow(`${severityIcon.warning} ${countLabel(counts.warning, 'warning')}`));
  }
  if (counts.info > 0) parts.push(colors.blue(`${severityIcon.info} ${countLabel(counts.info, 'note')}`));
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

  sections.push('', dim(`Policy: ${layers.policy === 'adjacent' ? 'a layer may only use the layer directly below it' : 'a layer may use any layer below it'}`));
  sections.push(dim(`Chain:  ${describeLayerChain(layers)}`));
  sections.push('');

  const violations = context.files.length > 0 ? architectureSummary(context) : [];
  if (violations.length === 0) {
    sections.push(colors.green(`${icons.ok} No boundary violations found.`));
  } else {
    sections.push(colors.yellow(`${icons.warn} Boundary issues:`), '');
    sections.push(...violations.map((line) => `  ${line}`));
  }

  sections.push('', dim(`${graph.edges.length} internal imports across ${graph.nodes().length} files`));
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
    .map(([pair, count]) => `${colors.red(icons.error)} ${pair}  ${dim(`(${countLabel(count, 'import')})`)}`);
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
    sections.push(paint(`  ${level.toUpperCase()}  ${dim(`(${countLabel(entries.length, 'file')})`)}`));
    sections.push(...entries.slice(0, 8).map((entry) => `    ${entry.path}`));
    if (entries.length > 8) sections.push(dim(`    ... and ${entries.length - 8} more`));
    sections.push('');
  }

  if (report.routes.length > 0) {
    sections.push(colors.bold('Routes'), ...report.routes.map((file) => `  ${routeLabel(file)} ${dim(file)}`), '');
  }

  if (report.tests.length > 0) {
    sections.push(colors.bold('Tests that reach this change'), ...report.tests.slice(0, 10).map((file) => `  ${file}`), '');
  }

  sections.push(
    dim('These files import the change directly or indirectly. That makes them worth testing —'),
    dim('it does not mean they are broken.'),
  );

  return sections.join('\n');
}

export function renderDependencies(context: AnalysisContext): string {
  const packages = [...context.graph.externalPackages()].sort();
  const declared = {
    ...context.project.dependencies,
    ...context.project.devDependencies,
  };
  const declaredNames = Object.keys(declared).sort();

  const undeclared = packages.filter(
    (name) => !name.startsWith('node:') && !(name in declared) && !isBuiltin(name),
  );
  const unused = declaredNames.filter((name) => !packages.includes(name));

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
    lines.push(dim(`${icons.info} Declared but never imported (may be used via config or at runtime)`), '');
    lines.push(...unused.slice(0, 15).map((name) => dim(`  ${name}`)), '');
  }

  if (undeclared.length === 0 && unused.length === 0) {
    lines.push(colors.green(`${icons.ok} Declared and imported dependencies line up.`));
  }

  lines.push(
    '',
    dim('Little Owl checks dependency hygiene, not security. For vulnerabilities run your'),
    dim('package manager audit command.'),
  );

  return lines.join('\n');
}

const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'url', 'util', 'events', 'stream', 'crypto', 'http', 'https', 'child_process',
  'assert', 'buffer', 'zlib', 'net', 'tls', 'dns', 'readline', 'worker_threads', 'perf_hooks',
  'string_decoder', 'querystring', 'timers', 'tty', 'v8', 'vm', 'process', 'module',
]);

function isBuiltin(name: string): boolean {
  return NODE_BUILTINS.has(name);
}

export function renderOwlLine(message: string, tone: 'good' | 'warn' | 'bad' = 'good'): string {
  const paint = tone === 'good' ? colors.green : tone === 'warn' ? colors.yellow : colors.red;
  return `${icons.owl} ${paint(message)}`;
}

export { box, indent };
