import path from 'node:path';
import chokidar from 'chokidar';
import { analyzeProject } from '../../core/analyze.js';
import { ParseCache } from '../../core/cache.js';
import { SOURCE_EXTENSIONS } from '../../core/scan.js';
import { loadConfig } from '../../config/load.js';
import { readBaseline } from '../../baseline/baseline.js';
import { generatePrompt } from '../../prompts/generate.js';
import { renderFinding } from '../../output/report.js';
import { colors, dim, icons } from '../../output/theme.js';
import { metricLine, rule } from '../../output/ui.js';
import { basename, toPosix } from '../../utils/paths.js';
import { compilePattern, matchesCompiled } from '../../utils/glob.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';
import type { AnalysisResult, Finding, Metrics } from '../../core/types.js';

export interface WatchOptions extends GlobalOptions {
  debounce?: number;
  /** Print a prompt block whenever new findings appear. */
  prompt?: boolean;
}

const WATCH_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/vendor/**',
  '**/.little-owl/**',
];

/**
 * `little-owl watch` — keep an eye on the codebase while you work.
 *
 * It compares against the reference taken when the session started (the saved
 * baseline if there is one), so drift is measured from a fixed point rather
 * than from whatever the code looked like a second ago.
 */
export async function watchCommand(options: WatchOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const cache = ParseCache.open(root);

  print('');
  print(`${icons.owl} ${colors.bold('Little Owl is watching your codebase.')}`);
  print('');

  let reference = await analyzeProject({ root, config, cache });
  const savedBaseline = readBaseline(root);
  const referenceMetrics: Metrics = savedBaseline?.metrics ?? reference.result.metrics;
  let knownFingerprints = new Set(
    (savedBaseline?.findings ?? reference.result.findings).map((finding) => finding.fingerprint),
  );
  let lastMetrics = reference.result.metrics;

  printHealthy(reference.result, referenceMetrics, savedBaseline !== null);
  print(dim(`Watching ${reference.result.project.fileCount} files. Press Ctrl+C to stop.`));
  print('');

  const ignored = WATCH_IGNORED.map(compilePattern);
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (target) => {
      const relative = toPosix(path.relative(root, target));
      if (!relative || relative.startsWith('..')) return false;
      return matchesCompiled(relative, ignored);
    },
  });

  const debounceMs = options.debounce ?? 400;
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    const touched = [...pending].sort();
    pending.clear();

    for (const file of touched) cache.invalidate(file);

    try {
      const next = await analyzeProject({ root, config, cache });
      report(touched, next.result, lastMetrics, referenceMetrics, knownFingerprints, options);
      lastMetrics = next.result.metrics;
      // Findings that persist become part of what we already know about, so
      // the same problem is not announced on every keystroke.
      knownFingerprints = new Set([
        ...knownFingerprints,
        ...next.result.findings.map((finding) => finding.fingerprint),
      ]);
      reference = next;
    } catch (error) {
      print(colors.red(`${icons.error} Analysis failed: ${(error as Error).message}`));
    } finally {
      running = false;
    }
  };

  const schedule = (file: string): void => {
    const relative = toPosix(path.relative(root, file));
    if (matchesCompiled(relative, ignored)) return;
    if (!affectsAnalysis(relative)) return;
    pending.add(relative);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  };

  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.close();
      print('');
      print(dim(`${icons.owl} Stopped watching.`));
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  return 0;
}

/**
 * Files that can change the analysis: source files, the manifest, and the
 * project's own configuration. A README or a log file cannot, and re-running
 * for those would just burn CPU and scroll the terminal.
 */
function affectsAnalysis(relative: string): boolean {
  if (SOURCE_EXTENSIONS.some((extension) => relative.endsWith(extension))) return true;
  const name = basename(relative);
  return name === 'package.json' || name === 'tsconfig.json' || name === 'go.mod';
}

function printHealthy(result: AnalysisResult, reference: Metrics, hasBaseline: boolean): void {
  const lines: Array<[string, keyof Metrics]> = [
    ['Architecture', 'architecture'],
    ['Complexity', 'complexity'],
    ['Dependencies', 'dependencies'],
  ];

  for (const [label, key] of lines) {
    const healthy = result.metrics[key] >= reference[key];
    const mark = healthy ? colors.green(icons.ok) : colors.yellow(icons.warn);
    print(`${mark} ${label} ${dim(String(result.metrics[key]))}`);
  }
  print('');
  print(
    dim(
      hasBaseline
        ? 'Comparing against the saved baseline.'
        : 'No saved baseline — comparing against the state at start-up.',
    ),
  );
}

function report(
  touched: string[],
  result: AnalysisResult,
  previous: Metrics,
  reference: Metrics,
  known: Set<string>,
  options: WatchOptions,
): void {
  const fresh = result.findings.filter((finding) => !known.has(finding.fingerprint));
  const drifted = (Object.keys(reference) as Array<keyof Metrics>).filter(
    (key) => result.metrics[key] < reference[key] && result.metrics[key] !== previous[key],
  );

  if (fresh.length === 0 && drifted.length === 0) {
    const label = touched.length === 1 ? touched[0]! : `${touched.length} files`;
    print(`${colors.green(icons.ok)} ${dim(label)} ${dim('— no new findings')}`);
    return;
  }

  print('');
  print(colors.yellow(`${icons.warn} CODEBASE DRIFT DETECTED`));
  print('');
  for (const file of touched.slice(0, 5)) print(`  ${colors.bold(file)}`);
  print('');

  for (const key of drifted) {
    print(
      metricLine({
        label: key === 'typeSafety' ? 'Type Safety' : key[0]!.toUpperCase() + key.slice(1),
        value: result.metrics[key],
        previous: reference[key],
      }),
    );
  }

  if (fresh.length > 0) {
    print('');
    print(rule());
    print('');
    for (const finding of fresh.slice(0, 3)) {
      print(renderFinding(finding, false));
      print('');
    }
    if (fresh.length > 3)
      print(dim(`${fresh.length - 3} more — run \`little-owl check --details\`.`));

    if (options.prompt) {
      print('');
      print(dim('Prompt for your assistant:'));
      print('');
      print(promptFor(fresh));
    }
  }
  print('');
}

function promptFor(findings: Finding[]): string {
  return generatePrompt(
    {
      status: 'needs-review',
      current: {
        metrics: {
          overall: 0,
          architecture: 0,
          maintainability: 0,
          complexity: 0,
          dependencies: 0,
          typeSafety: 0,
        },
        stats: {} as never,
        findings,
        fileMetrics: {},
        project: {} as never,
        warnings: [],
        durationMs: 0,
      },
      baseline: null,
      changes: null,
      newFindings: findings,
      resolvedFindings: [],
      scope: null,
      drift: null,
    },
    { maxInstructions: 4 },
  );
}
