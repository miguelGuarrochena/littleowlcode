import type { ChangeSet, ReviewResult } from '../core/types.js';
import { colors, dim, icons } from './theme.js';
import { countLabel, wrap } from './ui.js';
import { countByPriority, renderPriorityLegend } from './severity.js';
import { issueSeparator, renderIssueCard, type Issue } from './issue.js';
import { renderIssueList } from './guided.js';
import { renderTruncationNotice, type RenderOptions } from './report.js';
import { CONFIG_DRIFT_NOTICE } from '../baseline/baseline.js';
import { groupByArea } from '../review/scope.js';
import type { AnalysisContext } from '../core/context.js';

export interface ReviewRenderOptions extends RenderOptions {
  /** The numbered issues this change introduced, in priority order. */
  issues: Issue[];
  /** Enables related files inside the full issue cards. */
  context?: AnalysisContext;
}

/**
 * `little-owl review` — what did the last change do?
 *
 * The report is built around the comparison, not around the codebase: what
 * changed, which direction the score moved, what is new, what got fixed. A
 * reader who has just watched an assistant edit twenty files wants those four
 * answers and a place to start, and the ordering here is that sentence.
 */
export const renderReview = (review: ReviewResult, options: ReviewRenderOptions): string => {
  const issues = options.issues;
  return [
    ...whatWasCompared(review),
    ...scoreAndVerdict(review, review.configDrifted !== true),
    ...caveats(review),
    ...whatChanged(review, issues),
    ...newIssues(review, issues, options),
  ].join('\n');
};

/** The two facts that make everything below it mean something. */
const whatWasCompared = (review: ReviewResult): string[] => {
  const lines: string[] = [];

  if (review.changes) {
    const size = changeSize(review.changes);
    const detail =
      size.insertions > 0 || size.deletions > 0
        ? `${colors.green(`+${size.insertions.toLocaleString()}`)} ${colors.red(`-${size.deletions.toLocaleString()}`)}` +
          (size.areas > 1 ? dim(`, ${countLabel(size.areas, 'area')}`) : '')
        : '';
    lines.push(
      `${colors.green(icons.ok)} ${colors.bold(countLabel(size.files, 'file'))} changed   ${detail}`,
      dim(`  ${review.changes.description}`),
    );
  }

  if (review.baseline) {
    lines.push(
      `${colors.green(icons.ok)} Compared with the baseline recorded ${describeAge(review.baseline.createdAt)}`,
    );
  }

  return [...lines, ''];
};

/**
 * The score, and which way it moved.
 *
 * A number on its own answers "how is the project"; the arrow answers "what did
 * I just do to it", which is the only question this command was asked.
 */
const scoreAndVerdict = (review: ReviewResult, comparable: boolean): string[] => {
  const before = review.baseline?.metrics.overall;
  const after = review.current.metrics.overall;
  const delta = before === undefined ? 0 : after - before;

  if (before === undefined) {
    return [
      `${colors.bold('Health')}   ${colors.bold(String(after))} ${dim('/ 100')}`,
      '',
      reviewVerdict(review, delta, comparable),
      '',
    ];
  }

  // A configuration change moves the score on its own: different files get
  // measured, different rules fire. Printing `↑ +6` next to "this change left
  // the project in better shape" then credits the reader's edit for something
  // an `ignore` pattern did. The numbers still belong on screen — the claim
  // about what caused them does not.
  // Nothing moved, nothing to misattribute: the caveat would be noise.
  const movement =
    comparable || delta === 0
      ? driftArrow(delta)
      : `${dim(signed(delta))}   ${colors.yellow('← the configuration moved too, so this is not all your change')}`;

  return [
    `${colors.bold('Health')}   ${dim(String(before))} ${dim(icons.arrow)} ${colors.bold(String(after))}   ${movement}`,
    '',
    reviewVerdict(review, delta, comparable),
    '',
  ];
};

const signed = (delta: number): string =>
  delta > 0 ? `${icons.up} +${delta}` : delta < 0 ? `${icons.down} ${delta}` : `${icons.flat} 0`;

/** Anything that stops the comparison meaning what it appears to mean. */
const caveats = (review: ReviewResult): string[] => {
  const lines: string[] = [];

  if (!review.baseline) {
    lines.push(
      dim('There is no baseline yet, so this describes the state of the code rather than'),
      dim('the effect of your change. `little-owl baseline` makes the next run a comparison.'),
      '',
    );
  } else if (review.configDrifted) {
    lines.push(renderConfigDrift(), '');
  }

  if (review.current.truncated) lines.push(renderTruncationNotice(), '');
  return lines;
};

const whatChanged = (review: ReviewResult, issues: Issue[]): string[] => {
  const lines: string[] = [];

  if (issues.length > 0) lines.push(renderPriorityLegend(countByPriority(issues)), '');

  const resolved = review.resolvedFindings.length;
  if (resolved > 0) {
    lines.push(
      colors.green(
        `${icons.ok} ${countLabel(resolved, 'earlier issue')} no longer ` +
          `${resolved === 1 ? 'appears' : 'appear'}.`,
      ),
      '',
    );
  }

  const scope = review.scope;
  if (scope && scope.outOfScope.length > 0) {
    lines.push(renderScope(scope.patterns, scope.outOfScope), '');
  }

  return lines;
};

const newIssues = (
  review: ReviewResult,
  issues: Issue[],
  options: ReviewRenderOptions,
): string[] => {
  if (issues.length === 0) {
    return [
      colors.green(
        `${icons.owl} Nothing new. This change did not introduce any problems Little Owl watches for.`,
      ),
    ];
  }

  if (!options.details) {
    return [
      renderIssueList(issues, {
        limit: Math.min(3, issues.length),
        heading: review.baseline ? 'What this change introduced' : 'Where to start',
        moreCommand: 'Run `little-owl review --details` to see every one.',
      }),
    ];
  }

  return [
    colors.bold('EVERY NEW ISSUE'),
    '',
    issues
      .map((issue) =>
        renderIssueCard(issue, {
          ...(options.context ? { context: options.context } : {}),
          technical: true,
          nextStep: null,
        }),
      )
      .join(`\n${issueSeparator()}\n\n`),
  ];
};

/**
 * One sentence on whether the change was good for the project.
 *
 * `comparable` is false when the configuration moved after the baseline was
 * recorded. The findings still say something true about the change; the score
 * does not, so every verdict that leans on the delta is withheld rather than
 * guessed at.
 */
const reviewVerdict = (review: ReviewResult, delta: number, comparable: boolean): string => {
  const counts = countByPriority(review.baseline ? review.newFindings : review.current.findings);

  if (counts.critical > 0) {
    return colors.red('This change introduced something that needs fixing before release.');
  }
  if (comparable && delta <= -5) {
    return colors.red('This change moved the project in the wrong direction.');
  }
  if (counts.important > 0) return colors.yellow('Worth a look before you move on.');
  if (comparable && delta > 0) {
    return colors.green('This change left the project in better shape than it found it.');
  }
  if (counts.total > 0) return colors.yellow('A few small things came in with this change.');
  if (!comparable) {
    return colors.yellow('This change introduced nothing new. The score is not comparable yet.');
  }
  return colors.green('This change looks clean.');
};

const driftArrow = (delta: number): string => {
  if (delta > 0) return colors.green(`${icons.up} +${delta}`);
  if (delta < 0) return colors.red(`${icons.down} ${delta}`);
  return dim(`${icons.flat} unchanged`);
};

/** `3 days ago`, `just now` — precise enough, never a timestamp to decode. */
export const describeAge = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'earlier';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/**
 * Shown whenever a comparison runs against a baseline recorded under different
 * settings. Without it, findings that were always there read as damage the
 * current change did — which is the one thing a review must never get wrong.
 */
export const renderConfigDrift = (): string => {
  const [first, ...rest] = CONFIG_DRIFT_NOTICE;
  return [
    colors.yellow(`${icons.warn} ${first}`),
    ...rest.flatMap((line) => wrap(line, 76).map((wrapped) => dim(`   ${wrapped}`))),
  ].join('\n');
};

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
export const changeSize = (changes: ChangeSet): ChangeSize => {
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
};

const renderScope = (patterns: string[], outOfScope: string[]): string => {
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
};
