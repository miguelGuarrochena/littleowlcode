import * as prompts from '@clack/prompts';
import { runReviewWithContext } from '../../review/review.js';
import { loadConfig } from '../../config/load.js';
import { buildBaseline, writeBaseline } from '../../baseline/baseline.js';
import { appendHistory } from '../../baseline/history.js';
import { writeSnapshot } from '../../baseline/snapshot.js';
import { generatePrompt } from '../../prompts/generate.js';
import { printJson, reviewToJson } from '../../output/json.js';
import { countBySeverity } from '../../output/report.js';
import { renderReview } from '../../output/review-report.js';
import { colors, dim } from '../../output/theme.js';
import { divider, owlHeader, renderNextStep } from '../../output/guided.js';
import { numberFindings, withNumbers, type Issue } from '../../output/issue.js';
import { currentBranch, headCommit, isGitRepository } from '../../git/git.js';
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
import type { ReviewResult } from '../../core/types.js';

export interface ReviewOptions extends GlobalOptions {
  base?: string;
  scope?: string[];
  json?: boolean;
  details?: boolean;
  quiet?: boolean;
  prompt?: boolean;
  cache?: boolean;
  /** Skip the follow-up menu even in a TTY. */
  noMenu?: boolean;
}

/** `little-owl review` — what did the latest changes do to the codebase? */
export const reviewCommand = async (options: ReviewOptions): Promise<number> => {
  const root = resolveRoot(options);
  const verbose = !options.json && !options.quiet && !options.prompt;

  // `runReview` loads the config itself; this pass exists so a broken setting
  // is reported before the report that silently ignored it.
  await loadProjectConfig(root);

  const progress = createProgress(verbose && isInteractive());
  if (verbose) print(owlHeader('Looking at what changed…'));

  progress.start(PROGRESS_LABELS['reading-project']!);
  const { review, context } = await runReviewWithContext({
    root,
    ...reviewQuery(options),
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop();

  recordHistory(root, review);

  // Numbers come from the whole run so `fix 4` means the same thing whether the
  // reader got here through `check` or through `review`.
  const allIssues = numberFindings(review.current.findings);
  const issues = review.baseline
    ? withNumbers(review.newFindings, review.current.findings)
    : allIssues;
  writeSnapshot(root, 'review', allIssues, review.current.metrics);

  // Machine output and the prompt are whole answers on their own; neither wants
  // the guided screen wrapped around it.
  if (options.json) {
    printJson(reviewToJson(review, readVersion()));
    return exitCodeFor(review);
  }
  if (options.prompt) {
    print(generatePrompt(review, { context, root }));
    return exitCodeFor(review);
  }

  if (!isGitRepository(root)) {
    print(dim('Not a git repository — this reviews the whole codebase, not a change.'));
    print('');
  }

  print(
    renderReview(review, {
      issues,
      context,
      details: options.details ?? false,
      quiet: options.quiet ?? false,
    }),
  );
  print('');

  if (options.quiet) return exitCodeFor(review);

  print(renderNextStep(...reviewNextStep(issues, allIssues)));
  print('');

  if (isInteractive() && !options.noMenu) {
    await followUpMenu(root, review, context, options);
  }

  return exitCodeFor(review);
};

/** The parts of the request that describe *what* to review, not how to show it. */
const reviewQuery = (
  options: ReviewOptions,
): { base?: string; scope?: string[]; cache?: boolean } => ({
  ...(options.base ? { base: options.base } : {}),
  ...(options.scope ? { scope: options.scope } : {}),
  ...(options.cache === false ? { cache: false } : {}),
});

const reviewNextStep = (
  issues: Issue[],
  allIssues: Issue[],
): [{ command: string; note?: string }, Array<{ command: string; note?: string }>] => {
  const first = issues[0];
  if (first) {
    return [
      { command: `little-owl explain ${first.number}`, note: 'what this issue actually means' },
      [
        { command: 'little-owl prompt', note: 'hand the whole list to your AI' },
        { command: 'little-owl review --details', note: 'every new issue in full' },
      ],
    ];
  }
  if (allIssues.length > 0) {
    return [
      { command: 'little-owl check', note: `${allIssues.length} older issues are still open` },
      [{ command: 'little-owl baseline', note: 'record this state as the new reference' }],
    ];
  }
  return [
    { command: 'little-owl baseline', note: 'record this clean state as the new reference' },
    [],
  ];
};

const recordHistory = (root: string, review: ReviewResult): void => {
  const shown = review.baseline ? review.newFindings : review.current.findings;
  try {
    appendHistory(root, {
      at: new Date().toISOString(),
      kind: 'review',
      ...(headCommit(root) ? { commit: headCommit(root)! } : {}),
      ...(currentBranch(root) ? { branch: currentBranch(root)! } : {}),
      status: review.status,
      metrics: review.current.metrics,
      ...(review.baseline ? { baselineOverall: review.baseline.metrics.overall } : {}),
      findingCounts: countBySeverity(shown),
    });
  } catch {
    // History is a convenience. Never let it break a review.
  }
};

const followUpMenu = async (
  root: string,
  review: ReviewResult,
  context: AnalysisContext,
  options: ReviewOptions,
): Promise<void> => {
  for (;;) {
    const choice = await prompts.select({
      message: 'What next?',
      options: [
        { value: 'prompt', label: 'Write a brief for my AI assistant', hint: 'recommended' },
        { value: 'details', label: 'Show every new issue in full' },
        { value: 'baseline', label: 'Accept this state as the new baseline' },
        { value: 'exit', label: 'Nothing for now' },
      ],
    });

    if (prompts.isCancel(choice) || choice === 'exit') return;

    if (choice === 'prompt') {
      const text = generatePrompt(review, {
        context,
        root,
        ...(options.scope ? { scope: options.scope } : {}),
      });
      print('');
      print(divider());
      print(text);
      print(divider());
      print('');
      print(dim('Copy everything between the lines into Claude Code, Cursor or Codex.'));
      print('');
      continue;
    }

    if (choice === 'details') {
      print('');
      print(
        renderReview(review, {
          issues: review.baseline
            ? withNumbers(review.newFindings, review.current.findings)
            : numberFindings(review.current.findings),
          context,
          details: true,
        }),
      );
      print('');
      continue;
    }

    if (choice === 'baseline') {
      const confirmed = await prompts.confirm({
        message: 'From now on, treat this state as normal?',
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;

      const config = await loadConfig(root);
      const file = writeBaseline(root, buildBaseline(root, review.current, config));
      print('');
      print(colors.green(`✓ Baseline updated: ${file}`));
      print('');
      return;
    }
  }
};

const exitCodeFor = (review: ReviewResult): number => {
  // `review` is a reporting command: it describes, it does not gate. Use
  // `little-owl ci` when an exit code should decide whether a build proceeds.
  void review;
  return 0;
};
