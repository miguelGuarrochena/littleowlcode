import * as prompts from '@clack/prompts';
import { runReview } from '../../review/review.js';
import { buildBaseline, writeBaseline } from '../../baseline/baseline.js';
import { appendHistory } from '../../baseline/history.js';
import { generatePrompt } from '../../prompts/generate.js';
import { printJson, reviewToJson } from '../../output/json.js';
import { countBySeverity, renderFindings, renderReview } from '../../output/report.js';
import { colors, dim } from '../../output/theme.js';
import { box } from '../../output/ui.js';
import { currentBranch, headCommit, isGitRepository } from '../../git/git.js';
import {
  createProgress,
  isInteractive,
  print,
  PROGRESS_LABELS,
  readVersion,
  resolveRoot,
  type GlobalOptions,
} from '../runtime.js';
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

  if (!isGitRepository(root)) {
    print(dim('Not a git repository — reviewing the whole codebase instead of a change.'));
  }

  const progress = createProgress(!options.json && !options.quiet && isInteractive());
  progress.start(PROGRESS_LABELS['reading-project']!);

  const review = await runReview({
    root,
    ...(options.base ? { base: options.base } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.cache === false ? { cache: false } : {}),
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop(dim(`Reviewed in ${review.current.durationMs}ms`));

  recordHistory(root, review);

  if (options.json) {
    printJson(reviewToJson(review, readVersion()));
    return exitCodeFor(review);
  }

  if (options.prompt) {
    print(generatePrompt(review));
    return exitCodeFor(review);
  }

  print('');
  print(renderReview(review, { details: options.details ?? false, quiet: options.quiet ?? false }));
  print('');

  if (isInteractive() && !options.noMenu && !options.quiet) {
    await followUpMenu(root, review, options);
  }

  return exitCodeFor(review);
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
  options: ReviewOptions,
): Promise<void> => {
  const shown = review.baseline ? review.newFindings : review.current.findings;

  for (;;) {
    const choice = await prompts.select({
      message: 'What would you like to do?',
      options: [
        { value: 'prompt', label: 'Generate a prompt for your AI assistant' },
        { value: 'details', label: 'View all findings' },
        { value: 'baseline', label: 'Save this state as the new baseline' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (prompts.isCancel(choice) || choice === 'exit') return;

    if (choice === 'prompt') {
      const text = generatePrompt(review, options.scope ? { scope: options.scope } : {});
      print('');
      print(box([colors.bold('AI REVIEW PROMPT')], { width: 60 }));
      print('');
      print(text);
      print('');
      print(dim('Copy the block above into Claude Code, Cursor, Codex or any other assistant.'));
      print('');
      continue;
    }

    if (choice === 'details') {
      print('');
      print(renderFindings(shown, { details: true }));
      print('');
      continue;
    }

    if (choice === 'baseline') {
      const confirmed = await prompts.confirm({
        message: 'Replace the current baseline with this state?',
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;

      const file = writeBaseline(root, buildBaseline(root, review.current));
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
