import fs from 'node:fs';
import path from 'node:path';
import { analyzeProject } from '../../core/analyze.js';
import { MAX_SCANNED_FILES } from '../../core/scan.js';
import { loadConfig } from '../../config/load.js';
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
import { dim, colors, icons } from '../../output/theme.js';
import { toPosix } from '../../utils/paths.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';
import type { AnalysisContext } from '../../core/context.js';

export interface InsightOptions extends GlobalOptions {
  json?: boolean;
}

async function contextFor(
  options: InsightOptions,
): Promise<{ root: string; context: AnalysisContext }> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const { context } = await analyzeProject({ root, config });
  return { root, context };
}

export interface DeadCodeOptions extends InsightOptions {
  minConfidence?: Confidence;
  includeTests?: boolean;
}

/** `little-owl dead-code` — files nothing appears to reach. */
export async function deadCodeCommand(options: DeadCodeOptions): Promise<number> {
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
  return 0;
}

export interface TestGapOptions extends InsightOptions {
  /** Only look at what the current change touched. */
  changed?: boolean;
  base?: string;
}

/** `little-owl tests` — behaviour that no test appears to watch. */
export async function testsCommand(options: TestGapOptions): Promise<number> {
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
  return 0;
}

/** `little-owl explain <file>` — why does this code exist? */
export async function explainCommand(file: string, options: InsightOptions): Promise<number> {
  const { root, context } = await contextFor(options);
  const relative = normalizeTarget(root, file);
  const report = explainFile(context, relative);

  if (options.json) {
    printJson(report);
    return report.exists ? 0 : 1;
  }

  print('');
  print(renderArchaeology(report));
  print('');
  return report.exists ? 0 : 1;
}

/** `little-owl map` — a first orientation in an unfamiliar codebase. */
export async function mapCommand(options: InsightOptions): Promise<number> {
  const { context } = await contextFor(options);
  const map = buildProjectMap(context);

  if (options.json) {
    printJson(map);
    return 0;
  }

  print('');
  print(renderProjectMap(map));
  print('');
  return 0;
}

/**
 * Turns whatever the user typed into a repo-relative POSIX path, so both
 * `src/a.ts` and an absolute path work.
 */
export function normalizeTarget(root: string, target: string): string {
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
  return toPosix(path.relative(root, absolute));
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'info';
  detail: string;
}

/**
 * `little-owl doctor` — is Little Owl set up to be useful here?
 *
 * Every check is about Little Owl's own ability to do its job, not about the
 * quality of the code. It is the command to run when the output looks wrong.
 */
export async function doctorCommand(options: InsightOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const started = Date.now();
  const { result, context } = await analyzeProject({ root, config });
  const elapsed = Date.now() - started;

  const checks: DoctorCheck[] = [];

  checks.push({
    name: 'Node.js',
    status: 'ok',
    detail: `${process.version} (needs >= 18.18)`,
  });

  checks.push({
    name: 'Project type',
    status: result.project.languages.length > 0 ? 'ok' : 'warn',
    detail:
      result.project.languages.length > 0
        ? `${result.project.languages.join(', ')}${result.project.frameworks.length > 0 ? ` · ${result.project.frameworks.join(', ')}` : ''}`
        : 'no supported source files found — check `include` and `ignore`',
  });

  checks.push({
    name: 'Git',
    status: result.project.isGitRepo ? 'ok' : 'info',
    detail: result.project.isGitRepo
      ? 'available — review, drift and archaeology all work'
      : 'not a git repository — review and explain have nothing to compare against',
  });

  checks.push({
    name: 'Configuration',
    status: config.sourcePath ? 'ok' : 'info',
    detail: config.sourcePath
      ? path.relative(root, config.sourcePath)
      : 'using defaults — run `little-owl init` to declare your layers',
  });

  const baselineFile = path.join(root, '.little-owl', 'baseline.json');
  checks.push({
    name: 'Baseline',
    status: fs.existsSync(baselineFile) ? 'ok' : 'info',
    detail: fs.existsSync(baselineFile)
      ? 'recorded — reviews compare against it'
      : 'none yet — run `little-owl baseline`',
  });

  checks.push({
    name: 'Files analysed',
    status: result.truncated ? 'warn' : result.project.fileCount > 0 ? 'ok' : 'warn',
    detail: result.truncated
      ? `${result.project.fileCount} files in ${elapsed}ms — the scan limit of ` +
        `${MAX_SCANNED_FILES.toLocaleString()} was reached, so this project is only partly analysed`
      : `${result.project.fileCount} files in ${elapsed}ms`,
  });

  const unresolved = context.graph.unresolved.length;
  checks.push({
    name: 'Import resolution',
    status: unresolved === 0 ? 'ok' : 'warn',
    detail:
      unresolved === 0
        ? `${context.graph.edges.length} internal imports resolved`
        : `${unresolved} imports unresolved — usually a path alias missing from tsconfig`,
  });

  checks.push({
    name: 'Architecture',
    status: context.layers.order.length >= 2 ? 'ok' : 'info',
    detail:
      context.layers.order.length >= 2
        ? `${context.layers.order.join(' → ')}${context.layers.inferred ? ' (inferred)' : ' (configured)'}`
        : 'no layers detected — boundary checks are inactive',
  });

  checks.push({
    name: 'Tests',
    status: context.files.some((file) => file.isTest) ? 'ok' : 'info',
    detail: context.files.some((file) => file.isTest)
      ? `${context.files.filter((file) => file.isTest).length} test files found`
      : 'no test files found',
  });

  if (result.warnings.length > 0) {
    checks.push({
      name: 'Skipped files',
      status: 'warn',
      detail: `${result.warnings.length} files could not be read or parsed`,
    });
  }

  if (options.json) {
    printJson({
      checks,
      warnings: result.warnings,
      truncated: result.truncated,
      durationMs: elapsed,
    });
    return 0;
  }

  print('');
  print(`${icons.owl} ${colors.bold('Little Owl doctor')}`);
  print('');

  for (const check of checks) {
    const mark =
      check.status === 'ok'
        ? colors.green(icons.ok)
        : check.status === 'warn'
          ? colors.yellow(icons.warn)
          : dim(icons.info);
    print(`${mark} ${check.name.padEnd(20)} ${dim(check.detail)}`);
  }

  if (result.warnings.length > 0) {
    print('');
    print(colors.yellow('Skipped files'));
    for (const warning of result.warnings.slice(0, 10)) {
      print(dim(`  ${warning.file ?? '?'} — ${warning.message}`));
    }
    if (result.warnings.length > 10) {
      print(dim(`  ... and ${result.warnings.length - 10} more`));
    }
  }

  print('');
  const problems = checks.filter((check) => check.status === 'warn').length;
  print(
    problems === 0
      ? colors.green(`${icons.ok} Everything Little Owl needs is in place.`)
      : colors.yellow(
          `${icons.warn} ${problems} thing${problems === 1 ? '' : 's'} limit what Little Owl can see.`,
        ),
  );
  print('');
  return 0;
}
