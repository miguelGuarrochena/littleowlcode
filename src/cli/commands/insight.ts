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
import type { AnalysisResult, AnalysisWarning } from '../../core/types.js';
import type { ResolvedConfig } from '../../config/schema.js';

export interface InsightOptions extends GlobalOptions {
  json?: boolean;
  /** False to skip the parse cache, leaving nothing written to the project. */
  cache?: boolean;
}

async function contextFor(
  options: InsightOptions,
): Promise<{ root: string; context: AnalysisContext }> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const { context } = await analyzeProject({
    root,
    config,
    ...(options.cache === false ? { cache: false as const } : {}),
  });
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

function filesAnalysedDetail(fileCount: number, truncated: boolean, elapsed: number): string {
  if (fileCount === 0) {
    return 'none — no .ts/.js/.py/.go files matched, so every score below is meaningless';
  }
  if (truncated) {
    return (
      `${fileCount} files in ${elapsed}ms — the scan limit of ` +
      `${MAX_SCANNED_FILES.toLocaleString()} was reached, so this project is only partly analysed`
    );
  }
  return `${fileCount} files in ${elapsed}ms`;
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
/**
 * Each check is its own function of the analysis.
 *
 * Doctor answers one question — "can Little Owl see this project properly?" —
 * and every check is one independent piece of that answer, so they read and
 * change independently too.
 */
type CheckBuilder = (input: DoctorInput) => DoctorCheck | null;

interface DoctorInput {
  root: string;
  config: ResolvedConfig;
  result: AnalysisResult;
  context: AnalysisContext;
  elapsed: number;
}

const nodeCheck: CheckBuilder = () => ({
  name: 'Node.js',
  status: 'ok',
  detail: `${process.version} (needs >= 18.18)`,
});

const projectCheck: CheckBuilder = ({ result }) => {
  const { languages, frameworks } = result.project;
  if (languages.length === 0) {
    return {
      name: 'Project type',
      status: 'warn',
      detail: 'no supported source files found — check `include` and `ignore`',
    };
  }
  return {
    name: 'Project type',
    status: 'ok',
    detail: [languages.join(', '), frameworks.join(', ')].filter(Boolean).join(' · '),
  };
};

const gitCheck: CheckBuilder = ({ result }) => ({
  name: 'Git',
  status: result.project.isGitRepo ? 'ok' : 'info',
  detail: result.project.isGitRepo
    ? 'available — review, drift and archaeology all work'
    : 'not a git repository — review and explain have nothing to compare against',
});

const configCheck: CheckBuilder = ({ root, config }) => ({
  name: 'Configuration',
  status: config.sourcePath ? 'ok' : 'info',
  detail: config.sourcePath
    ? path.relative(root, config.sourcePath)
    : 'using defaults — run `little-owl init` to declare your layers',
});

const baselineCheck: CheckBuilder = ({ root }) => {
  const exists = fs.existsSync(path.join(root, '.little-owl', 'baseline.json'));
  return {
    name: 'Baseline',
    status: exists ? 'ok' : 'info',
    detail: exists
      ? 'recorded — reviews compare against it'
      : 'none yet — run `little-owl baseline`',
  };
};

const filesCheck: CheckBuilder = ({ result, elapsed }) => ({
  name: 'Files analysed',
  status: result.truncated || result.project.fileCount === 0 ? 'warn' : 'ok',
  detail: filesAnalysedDetail(result.project.fileCount, result.truncated, elapsed),
});

const resolutionCheck: CheckBuilder = ({ context }) => {
  const unresolved = context.graph.unresolved.length;
  return {
    name: 'Import resolution',
    status: unresolved === 0 ? 'ok' : 'warn',
    detail:
      unresolved === 0
        ? `${context.graph.edges.length} internal imports resolved`
        : `${unresolved} imports unresolved — usually a path alias missing from tsconfig`,
  };
};

const architectureCheck: CheckBuilder = ({ context }) => {
  const { order, inferred } = context.layers;
  return {
    name: 'Architecture',
    status: order.length >= 2 ? 'ok' : 'info',
    detail:
      order.length >= 2
        ? `${order.join(' → ')} (${inferred ? 'inferred' : 'configured'})`
        : 'no layers detected — boundary checks are inactive',
  };
};

const testsCheck: CheckBuilder = ({ context }) => {
  const count = context.files.filter((file) => file.isTest).length;
  return {
    name: 'Tests',
    status: count > 0 ? 'ok' : 'info',
    detail: count > 0 ? `${count} test files found` : 'no test files found',
  };
};

/** Only appears when something was actually skipped. */
const skippedCheck: CheckBuilder = ({ result }) =>
  result.warnings.length === 0
    ? null
    : {
        name: 'Skipped files',
        status: 'warn',
        detail: `${result.warnings.length} files could not be read or parsed`,
      };

const CHECKS: CheckBuilder[] = [
  nodeCheck,
  projectCheck,
  gitCheck,
  configCheck,
  baselineCheck,
  filesCheck,
  resolutionCheck,
  architectureCheck,
  testsCheck,
  skippedCheck,
];

function buildChecks(input: DoctorInput): DoctorCheck[] {
  return CHECKS.map((build) => build(input)).filter(
    (check): check is DoctorCheck => check !== null,
  );
}

const CHECK_MARK: Record<DoctorCheck['status'], () => string> = {
  ok: () => colors.green(icons.ok),
  warn: () => colors.yellow(icons.warn),
  info: () => dim(icons.info),
};

function printChecks(checks: DoctorCheck[], warnings: AnalysisWarning[]): void {
  print('');
  print(`${icons.owl} ${colors.bold('Little Owl doctor')}`);
  print('');

  for (const check of checks) {
    print(`${CHECK_MARK[check.status]()} ${check.name.padEnd(20)} ${dim(check.detail)}`);
  }

  if (warnings.length > 0) {
    print('');
    print(colors.yellow('Skipped files'));
    for (const warning of warnings.slice(0, 10)) {
      print(dim(`  ${warning.file ?? '?'} — ${warning.message}`));
    }
    if (warnings.length > 10) print(dim(`  ... and ${warnings.length - 10} more`));
  }

  const problems = checks.filter((check) => check.status === 'warn').length;
  print('');
  print(
    problems === 0
      ? colors.green(`${icons.ok} Everything Little Owl needs is in place.`)
      : colors.yellow(
          `${icons.warn} ${problems} thing${problems === 1 ? ' limits' : 's limit'} what Little Owl can see.`,
        ),
  );
  print('');
}

export async function doctorCommand(options: InsightOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
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
}
