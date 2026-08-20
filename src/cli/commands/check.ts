import { analyzeProject } from '../../core/analyze.js';
import { loadConfig } from '../../config/load.js';
import { checkToJson, printJson } from '../../output/json.js';
import { renderHealth, renderOwlLine, renderProjectSummary } from '../../output/report.js';
import { colors, dim } from '../../output/theme.js';
import {
  createProgress,
  isInteractive,
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
export async function checkCommand(options: CheckOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
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
    print(renderProjectSummary(result.project));
    print('');
  }

  print(renderHealth(result, { details: options.details ?? false, quiet: options.quiet ?? false }));
  print('');

  const errors = result.findings.filter((finding) => finding.severity === 'error').length;
  if (errors === 0) {
    print(renderOwlLine('Looking good. Nothing critical in this codebase.', 'good'));
  } else {
    print(renderOwlLine(`I spotted ${errors} thing${errors === 1 ? '' : 's'} worth your attention.`, 'bad'));
  }

  if (config.sourcePath === null) {
    print('');
    print(dim(`No configuration found. ${colors.bold('little-owl init')} sets up layers and thresholds.`));
  }

  return 0;
}
