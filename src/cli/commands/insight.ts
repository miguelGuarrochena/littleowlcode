import path from 'node:path';
import { analyzeProject } from '../../core/analyze.js';
import { detectChanges } from '../../git/git.js';
import { findDeadCode, type Confidence } from '../../review/dead-code.js';
import { analyzeTestGaps, changedFilesOf } from '../../review/test-gap.js';
import { explainFile } from '../../review/archaeology.js';
import { buildProjectMap } from '../../review/map.js';
import { printJson } from '../../output/json.js';
import {
  renderArchaeology,
  renderDeadCode,
  renderProjectMap,
  renderTestGaps,
} from '../../output/insight.js';
import { dim } from '../../output/theme.js';
import { renderNextStep } from '../../output/guided.js';
import { toPosix } from '../../utils/paths.js';
import { loadProjectConfig, print, resolveRoot, type GlobalOptions } from '../runtime.js';
import { fileNotAnalysed } from '../errors.js';
import { buildChecks, printChecks } from './doctor-checks.js';
import type { AnalysisContext } from '../../core/context.js';

export interface InsightOptions extends GlobalOptions {
  json?: boolean;
  /** False to skip the parse cache, leaving nothing written to the project. */
  cache?: boolean;
}

const contextFor = async (
  options: InsightOptions,
): Promise<{ root: string; context: AnalysisContext }> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const { context } = await analyzeProject({
    root,
    config,
    ...(options.cache === false ? { cache: false as const } : {}),
  });
  return { root, context };
};

export interface DeadCodeOptions extends InsightOptions {
  minConfidence?: Confidence;
  includeTests?: boolean;
}

/** `little-owl dead-code` — files nothing appears to reach. */
export const deadCodeCommand = async (options: DeadCodeOptions): Promise<number> => {
  const { context } = await contextFor(options);
  const report = findDeadCode(context, {
    ...(options.minConfidence ? { minConfidence: options.minConfidence } : {}),
    ...(options.includeTests ? { includeTests: true } : {}),
  });

  if (options.json) {
    printJson(report);
    return 0;
  }

  print('');
  print(renderDeadCode(report));
  print('');
  const first = report.candidates[0];
  print(
    renderNextStep(
      first
        ? {
            command: `little-owl explain ${first.path}`,
            note: 'why it exists, before you delete it',
          }
        : { command: 'little-owl check', note: 'what else needs attention' },
    ),
  );
  print('');
  return 0;
};

export interface TestGapOptions extends InsightOptions {
  /** Only look at what the current change touched. */
  changed?: boolean;
  base?: string;
}

/** `little-owl tests` — behaviour that no test appears to watch. */
export const testsCommand = async (options: TestGapOptions): Promise<number> => {
  const { root, context } = await contextFor(options);

  let files: string[] | undefined;
  if (options.changed) {
    const changes = detectChanges(root, options.base ? { base: options.base } : {});
    files = changedFilesOf(changes);
    if (!files) {
      print('');
      print(dim('No changes detected, so there is nothing to check for new test gaps.'));
      print('');
      return 0;
    }
  }

  const report = analyzeTestGaps(context, files ? { files } : {});

  if (options.json) {
    printJson(report);
    return 0;
  }

  print('');
  if (files) print(dim(`Limited to the ${files.length} files in the current change.`));
  print(renderTestGaps(report));
  print('');
  const gap = report.gaps[0];
  print(
    renderNextStep(
      gap
        ? { command: `little-owl impact ${gap.file}`, note: 'what breaks if this is wrong' }
        : { command: 'little-owl check', note: 'what else needs attention' },
    ),
  );
  print('');
  return 0;
};

/** `little-owl explain <file>` — why does this code exist? */
export const explainCommand = async (file: string, options: InsightOptions): Promise<number> => {
  const { root, context } = await contextFor(options);
  const relative = normalizeTarget(root, file);
  const report = explainFile(context, relative);

  if (options.json) {
    printJson(report);
    return report.exists ? 0 : 1;
  }

  // A path Little Owl never read is a setup question, not an empty report.
  if (!report.exists) throw fileNotAnalysed(relative);

  print('');
  print(renderArchaeology(report));
  print('');
  print(
    renderNextStep({
      command: `little-owl impact ${relative}`,
      note: 'what else would a change here touch?',
    }),
  );
  print('');
  return 0;
};

/** `little-owl map` — a first orientation in an unfamiliar codebase. */
export const mapCommand = async (options: InsightOptions): Promise<number> => {
  const { context } = await contextFor(options);
  const map = buildProjectMap(context);

  if (options.json) {
    printJson(map);
    return 0;
  }

  print('');
  print(renderProjectMap(map));
  print('');
  print(
    renderNextStep({ command: 'little-owl check', note: 'now: what in here needs attention?' }, [
      { command: 'little-owl explain <file>', note: 'why does this file exist?' },
    ]),
  );
  print('');
  return 0;
};

/**
 * Turns whatever the user typed into a repo-relative POSIX path, so both
 * `src/a.ts` and an absolute path work.
 */
export const normalizeTarget = (root: string, target: string): string => {
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
  return toPosix(path.relative(root, absolute));
};

/**
 * `little-owl doctor` — is Little Owl set up to be useful here?
 *
 * The checks themselves live in `doctor-checks.ts`; this is the command around
 * them.
 */
export const doctorCommand = async (options: InsightOptions): Promise<number> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const started = Date.now();
  const { result, context } = await analyzeProject({
    root,
    config,
    ...(options.cache === false ? { cache: false as const } : {}),
  });
  const elapsed = Date.now() - started;

  const checks = buildChecks({ root, config, result, context, elapsed });

  if (options.json) {
    printJson({
      checks,
      warnings: result.warnings,
      truncated: result.truncated,
      durationMs: elapsed,
    });
    return 0;
  }

  printChecks(checks, result.warnings);
  return 0;
};
