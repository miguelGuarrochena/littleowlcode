import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject } from '../../core/analyze.js';
import { checkToJson, printJson } from '../../output/json.js';
import { renderMetricComparison, renderTruncationNotice } from '../../output/report.js';
import { colors } from '../../output/theme.js';
import {
  CHECK_STEPS,
  divider,
  owlHeader,
  renderDetection,
  renderIssueList,
  renderNextStep,
  renderNothingFound,
  renderPrioritySummary,
  renderScoreLine,
  renderSteps,
  reassurance,
  verdict,
  type NextStep,
} from '../../output/guided.js';
import { countByPriority, type PriorityCounts } from '../../output/severity.js';
import { countLabel } from '../../output/ui.js';
import { numberFindings, renderIssueCard, issueSeparator, type Issue } from '../../output/issue.js';
import { writeSnapshot } from '../../baseline/snapshot.js';
import { agentFilePath } from '../../agent/agent-file.js';
import { hasUsableLayers } from '../../architecture/layers.js';
import {
  createProgress,
  isInteractive,
  loadProjectConfig,
  print,
  PROGRESS_LABELS,
  readVersion,
  resolveRoot,
  type GlobalOptions,
} from '../runtime.js';
import type { AnalysisContext } from '../../core/context.js';
import type { AnalysisResult } from '../../core/types.js';

export interface CheckOptions extends GlobalOptions {
  json?: boolean;
  details?: boolean;
  /** List every issue, not just the first few. */
  all?: boolean;
  quiet?: boolean;
  cache?: boolean;
}

/**
 * `little-owl check` — the state of the project right now.
 *
 * This is the first real screen most people see, so it is built around one
 * question: after reading it, do you know what to do next? Scores and metric
 * tables answer "how am I doing"; they do not answer that. So the numbers stay
 * to one line, the issues are numbered and prioritised, and the screen ends on
 * exactly one recommended command.
 */
export const checkCommand = async (options: CheckOptions): Promise<number> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const verbose = !options.json && !options.quiet;
  const progress = createProgress(verbose && isInteractive());

  if (verbose) print(owlHeader());

  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result, context } = await analyzeProject({
    root,
    config,
    cache: options.cache === false ? false : undefined,
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop();

  if (options.json) {
    printJson(checkToJson(result, readVersion()));
    return 0;
  }

  // No files means every score is 100 for the same reason an empty exam is not
  // a perfect grade. Say that instead of printing the grade.
  if (result.project.fileCount === 0) {
    print(renderNothingFound(root));
    print('');
    return 0;
  }

  const issues = numberFindings(result.findings);
  const counts = countByPriority(result.findings);
  writeSnapshot(root, 'check', issues, result.metrics);

  if (options.quiet) {
    print(renderScoreLine(result.metrics.overall));
    print(renderPrioritySummary(result.findings));
    return 0;
  }

  printWhatWasRead(result, context);
  printVerdict(result, counts);
  if (counts.total > 0) printIssues(issues, counts, context, options);
  if (options.details) printScores(result);

  print(renderNextStep(...nextSteps(root, issues, config.sourcePath !== null)));
  print('');
  return 0;
};

/** What Little Owl looked at, so the numbers below have a subject. */
const printWhatWasRead = (result: AnalysisResult, context: AnalysisContext): void => {
  const testFiles = result.project.fileCount - result.stats.files;
  print(
    renderDetection(result.project, {
      ...(testFiles > 0 ? { fileNote: `${result.stats.files} source, ${testFiles} test` } : {}),
    }),
  );
  print('');
  print(
    renderSteps([
      { label: CHECK_STEPS[0], note: countLabel(result.project.fileCount, 'file') },
      { label: CHECK_STEPS[1], note: countLabel(context.graph.edges.length, 'connection') },
      { label: CHECK_STEPS[2], note: architectureNote(context) },
      { label: CHECK_STEPS[3], note: `${result.durationMs}ms` },
    ]),
  );
  print('');
  print(divider());
  print('');
};

const printVerdict = (result: AnalysisResult, counts: PriorityCounts): void => {
  print(renderScoreLine(result.metrics.overall));
  print('');
  print(verdict(counts));
  print('');
  if (result.truncated) {
    print(renderTruncationNotice());
    print('');
  }
};

const printIssues = (
  issues: Issue[],
  counts: PriorityCounts,
  context: AnalysisContext,
  options: CheckOptions,
): void => {
  print(renderPrioritySummary(issues));
  const note = reassurance(counts);
  if (note) {
    print('');
    print(note);
  }
  print('');

  if (options.details) {
    print(colors.bold('EVERY ISSUE'));
    print('');
    print(
      issues
        .map((issue) => renderIssueCard(issue, { context, technical: true, nextStep: null }))
        .join(`\n${issueSeparator()}\n\n`),
    );
  } else {
    print(
      renderIssueList(issues, {
        limit: options.all ? issues.length : listLength(counts.critical),
        moreCommand: 'Run `little-owl check --all` to see every one.',
      }),
    );
  }
  print('');
};

const printScores = (result: AnalysisResult): void => {
  print(colors.bold('CODEBASE HEALTH'));
  print('');
  print(renderMetricComparison(result.metrics, null).join('\n'));
  print('');
};

/** Show every critical issue, but never fewer than three or more than five. */
const listLength = (critical: number): number => Math.min(5, Math.max(3, critical));

const architectureNote = (context: AnalysisContext): string => {
  if (!hasUsableLayers(context.layers)) return 'no layers to check';
  const { order } = context.layers;
  return `${order.length} layers: ${order.join(' → ')}`;
};

/**
 * The one thing to do next, and the two worth knowing about.
 *
 * Ordered by what is actually missing rather than by what is interesting: a
 * project with issues has an obvious first move, and a clean project that has
 * never been set up has a different one.
 */
const nextSteps = (root: string, issues: Issue[], configured: boolean): [NextStep, NextStep[]] => {
  const hasBaseline = fs.existsSync(path.join(root, '.little-owl', 'baseline.json'));
  const setUp = configured && hasBaseline && fs.existsSync(agentFilePath(root));

  // Only send someone into an issue when it is worth their afternoon. Pointing
  // at `explain 1` for a low-priority note, on a project that has not even been
  // set up yet, gets the order of the work exactly backwards.
  const actionable = issues.find((issue) => issue.severity !== 'info');
  const primary: NextStep = actionable
    ? {
        command: `little-owl explain ${actionable.number}`,
        note: 'the full story of the first issue',
      }
    : setUp
      ? { command: 'little-owl review', note: 'after your next change' }
      : { command: 'little-owl init', note: 'takes one command, asks nothing' };

  const alternatives: NextStep[] = [];
  // `prompt` writes "nothing that needs fixing" when only notes are left, so
  // offering it there would send someone to an empty page.
  if (actionable) {
    alternatives.push({ command: 'little-owl prompt', note: 'hand the whole list to your AI' });
  }
  if (!setUp) {
    alternatives.push({
      command: 'little-owl init',
      note: 'set up, so later runs show only what changed',
    });
  }
  if (!actionable && issues.length > 0) {
    alternatives.push({
      command: 'little-owl check --all',
      note: `${countLabel(issues.length, 'minor note')} to look at`,
    });
  }
  if (hasBaseline) {
    alternatives.push({ command: 'little-owl review', note: 'what did my last change do?' });
  }
  alternatives.push({ command: 'little-owl map', note: 'get your bearings in this codebase' });

  return [primary, alternatives.filter((option) => option.command !== primary.command).slice(0, 3)];
};
