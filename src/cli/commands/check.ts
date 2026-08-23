import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject } from '../../core/analyze.js';
import { checkToJson, printJson } from '../../output/json.js';
import { renderHealth, renderOwlLine, renderProjectSummary } from '../../output/report.js';
import { colors, dim } from '../../output/theme.js';
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

export interface CheckOptions extends GlobalOptions {
  json?: boolean;
  details?: boolean;
  quiet?: boolean;
  cache?: boolean;
}

/** `little-owl check` — the health of the codebase as it stands right now. */
export const checkCommand = async (options: CheckOptions): Promise<number> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const progress = createProgress(!options.json && !options.quiet && isInteractive());

  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result } = await analyzeProject({
    root,
    config,
    cache: options.cache === false ? false : undefined,
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop(dim(`Analysed ${result.project.fileCount} files in ${result.durationMs}ms`));

  if (options.json) {
    printJson(checkToJson(result, readVersion()));
    return 0;
  }

  if (!options.quiet) {
    print('');
    print(renderProjectSummary(result.project, result.project.fileCount - result.stats.files));
    print('');
  }

  print(renderHealth(result, { details: options.details ?? false, quiet: options.quiet ?? false }));
  print('');

  const errors = result.findings.filter((finding) => finding.severity === 'error').length;
  if (errors === 0) {
    print(renderOwlLine('Looking good. Nothing critical in this codebase.', 'good'));
  } else {
    print(
      renderOwlLine(
        `I spotted ${errors} thing${errors === 1 ? '' : 's'} worth your attention.`,
        'bad',
      ),
    );
  }

  if (!options.quiet) printNextSteps(root, config.sourcePath !== null);
  return 0;
};

/**
 * What to do with what you just read.
 *
 * A first run ends on a wall of findings, and "now what?" is a fair question.
 * The suggestions are ordered by what is actually missing: a project with no
 * baseline cannot review anything yet, so that comes first.
 */
const printNextSteps = (root: string, configured: boolean): void => {
  const hasBaseline = fs.existsSync(path.join(root, '.little-owl', 'baseline.json'));
  const steps: string[] = [];

  if (!hasBaseline) {
    steps.push(
      `${colors.bold('little-owl baseline')}  record this as the reference, so the next review shows only what changed`,
    );
  }
  if (!configured) {
    steps.push(
      `${colors.bold('little-owl init')}      declare your layers instead of letting them be inferred`,
    );
  }
  steps.push(
    `${colors.bold('little-owl map')}       get your bearings — areas, entry points, what to read first`,
  );
  if (hasBaseline) {
    steps.push(
      `${colors.bold('little-owl review')}    see what your latest change did to the project`,
    );
  }

  print('');
  print(dim('Next'));
  print('');
  for (const step of steps.slice(0, 3)) print(dim(`  ${step}`));
};
