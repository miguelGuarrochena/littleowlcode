import { colors, dim, icons } from './theme.js';
import { countLabel, rule, scoreBar, wrap } from './ui.js';
import { countByPriority, renderPriorityLegend, type PriorityCounts } from './severity.js';
import { renderIssueSummary, type Issue } from './issue.js';
import type { Finding, ProjectInfo } from '../core/types.js';
import type { ScopeReport } from '../detect/scope-report.js';
import { describeStack } from '../detect/project.js';

/**
 * The shared shape of a guided command.
 *
 * Every screen in the product answers the same three questions in the same
 * order — what just happened, what does it mean, what should I do now — and
 * this module holds the pieces that answer them, so `check`, `review`, `fix`
 * and `verify` cannot drift into sounding like four different tools.
 */

const WIDTH = 72;

export const owlHeader = (subtitle?: string): string => {
  const lines = ['', `${icons.owl} ${colors.bold('Little Owl')}`];
  if (subtitle) lines.push('', dim(subtitle));
  lines.push('');
  return lines.join('\n');
};

export const divider = (): string => dim(rule(WIDTH));

/** `✓ Checked the architecture` — one line per completed stage. */
export const renderSteps = (steps: Array<{ label: string; note?: string }>): string => {
  const width = Math.max(...steps.map((step) => step.label.length)) + 2;
  return steps
    .map(({ label, note }) =>
      note
        ? `${colors.green(icons.ok)} ${label.padEnd(width)}${dim(note)}`
        : `${colors.green(icons.ok)} ${label}`,
    )
    .join('\n');
};

/** The stages a person recognises, as opposed to the stages the engine has. */
export const CHECK_STEPS = [
  'Read the project',
  'Mapped how files connect',
  'Checked the architecture',
  'Checked for common problems',
] as const;

/**
 * The one sentence that tells someone how worried to be.
 *
 * "Found 17 findings" is a number. This is a verdict, and it is the difference
 * between a report someone acts on and a report someone closes.
 */
export const verdict = (counts: PriorityCounts): string => {
  if (counts.total === 0) return colors.green('Nothing to fix. Your project looks healthy.');
  if (counts.critical > 0) return colors.red('Your project needs attention.');
  if (counts.important > 0) {
    return colors.yellow('Your project looks solid. A few things are worth fixing soon.');
  }
  return colors.green('Your project is in good shape — only small improvements left.');
};

/**
 * Shown when the list is long enough to be discouraging.
 *
 * Someone who built their app with an assistant and gets handed forty findings
 * concludes the app is broken. It usually is not: the count is dominated by
 * notes. Saying so, before they scroll, is the difference between fixing two
 * things and abandoning the tool.
 */
export const reassurance = (counts: PriorityCounts): string | null => {
  if (counts.total === 0) return null;

  const urgent = counts.critical + counts.important;
  if (counts.total >= 12 && urgent <= counts.total / 2) {
    return dim("Most of these are low priority — you don't need to fix everything now.");
  }
  if (counts.critical > 0) {
    return dim(
      `Start with the ${counts.critical} critical issue${counts.critical === 1 ? '' : 's'}. The rest can wait.`,
    );
  }
  if (counts.total > 5) return dim("You don't need to fix all of these at once.");
  return null;
};

export interface SummaryOptions {
  /** How many issues to list. */
  limit?: number;
  /** Word for the list heading, e.g. "where to start". */
  heading?: string;
  /** Command that reveals the rest. */
  moreCommand?: string;
}

/**
 * The priority breakdown plus the first few issues.
 *
 * Only the top slice is shown, because the point of prioritising is that the
 * reader does not have to read the bottom of the list.
 */
export const renderIssueList = (issues: Issue[], options: SummaryOptions = {}): string => {
  if (issues.length === 0) return '';

  const limit = options.limit ?? 3;
  const shown = issues.slice(0, limit);
  const lines = [
    colors.bold((options.heading ?? 'Where to start').toUpperCase()),
    '',
    shown.map(renderIssueSummary).join('\n\n'),
  ];

  const remaining = issues.length - shown.length;
  if (remaining > 0) {
    lines.push(
      '',
      dim(
        `… and ${remaining} more. ${options.moreCommand ?? 'Run `little-owl check --all` to see every one.'}`,
      ),
    );
  }

  return lines.join('\n');
};

export interface NextStep {
  command: string;
  /** What running it will do, in one short clause. */
  note?: string;
}

/** The single recommended action. There is always exactly one. */
export const renderNextStep = (step: NextStep, extra: NextStep[] = []): string => {
  const lines = [
    colors.bold('NEXT STEP'),
    '',
    `  ${colors.cyan(icons.arrow)} ${colors.bold(step.command)}${step.note ? `   ${dim(step.note)}` : ''}`,
  ];
  if (extra.length > 0) {
    lines.push('');
    for (const option of extra) {
      lines.push(`    ${dim(option.command.padEnd(30))}${option.note ? dim(option.note) : ''}`);
    }
  }
  return lines.join('\n');
};

/** `Health  86 / 100  ████████████████░░░░` — the score, without a table. */
export const renderScoreLine = (score: number): string =>
  `${colors.bold('Health')}   ${colors.bold(String(score))} ${dim('/ 100')}   ${scoreBar(score, 20)}`;

export const renderPrioritySummary = (findings: Finding[]): string =>
  renderPriorityLegend(countByPriority(findings));

/**
 * What Little Owl is about to look at, said before it looks.
 *
 * Confirming the detection out loud is what stops someone spending ten minutes
 * wondering why their Python service scored 100 — they ran it one directory up
 * and Little Owl found nothing but a README.
 */
export const renderDetection = (
  project: ProjectInfo,
  options: { fileNote?: string } = {},
): string => {
  const good = (text: string): string => `${colors.green(icons.ok)} ${text}`;
  const lines = [good(`${project.name} — ${describeStack(project)}`)];
  if (project.frameworks.length > 0) lines.push(good(`${project.frameworks.join(', ')} detected`));
  // The breakdown hangs off the total rather than standing on its own line:
  // "121 files" followed by "31 test files" reads as 152.
  lines.push(
    good(
      countLabel(project.fileCount, 'file') +
        (options.fileNote ? dim(`  — ${options.fileNote}`) : ''),
    ),
  );
  if (project.isGitRepo) lines.push(good('Git repository — change reviews will work'));
  return lines.join('\n');
};

/**
 * What is being analysed, and what was left out.
 *
 * Printed before any finding, because a list of problems is only meaningful
 * once the reader agrees it is about their code. The skipped half is the part
 * that earns its place: it is the difference between "this tool is broken" and
 * "ah, it skipped my fixtures — good".
 */
export const renderScope = (report: ScopeReport, options: { limit?: number } = {}): string => {
  const limit = options.limit ?? 6;
  const shown = report.analysed.slice(0, limit);
  // One column across both lists: a skipped path is usually the longest name on
  // screen, and sizing on the analysed half alone runs the two together.
  const width =
    Math.max(
      12,
      ...shown.map((area) => area.directory.length),
      ...report.skipped.map((area) => area.directory.length),
    ) + 2;

  const lines = [colors.bold('ANALYSING'), ''];
  for (const area of shown) {
    lines.push(`  ${area.directory.padEnd(width)}${dim(countLabel(area.files, 'file'))}`);
  }
  const rest = report.analysed.length - shown.length;
  if (rest > 0) lines.push(dim(`  … and ${countLabel(rest, 'other area')}`));

  if (report.skipped.length > 0) {
    lines.push('', colors.bold('SKIPPED'), '', dim('  Sample code, not your application:'), '');
    for (const area of report.skipped.slice(0, 4)) {
      lines.push(
        `  ${area.directory.padEnd(width)}${dim(`${countLabel(area.files, 'file')}  (${area.pattern})`)}`,
      );
    }
    lines.push(
      '',
      dim('  Is one of these real code? Put the pattern back with a `!` in front,'),
      dim("  in `ignore` in .little-owl/config.ts — e.g. ignore: ['!examples/**']."),
      dim('  Something else to skip? Add it to the same list without the `!`.'),
    );
  }

  return lines.join('\n');
};

/**
 * Shown when the scan found nothing to analyse.
 *
 * A perfect score for zero files is the worst possible output: it is wrong,
 * it is reassuring, and it is completely undetectable to the person reading it.
 */
export const renderNothingFound = (root: string): string =>
  [
    `${icons.owl} ${colors.yellow('Little Owl could not find any code to look at here.')}`,
    '',
    ...wrap(
      `Nothing in ${root} matched the file types Little Owl reads: .ts, .tsx, .js, .jsx, ` +
        '.mjs, .cjs, .py and .go.',
      WIDTH,
    ).map((line) => dim(line)),
    '',
    dim('The two usual reasons:'),
    dim('  • you are one folder above (or below) your project'),
    dim('  • the code lives somewhere `include` or `ignore` is filtering out'),
    '',
    colors.bold('NEXT STEP'),
    '',
    `  ${colors.cyan(icons.arrow)} ${colors.bold('little-owl doctor')}   ${dim('shows exactly what Little Owl can and cannot see')}`,
  ].join('\n');
