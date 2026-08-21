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
import { countLabel, metricLine, rule } from '../../output/ui.js';
import { basename, toPosix } from '../../utils/paths.js';
import { compilePattern, matchesCompiled } from '../../utils/glob.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';
import { attributeFindings, createRunQueue, type AttributedFindings } from '../watch-runtime.js';
import type { AnalysisResult, Finding, Metrics } from '../../core/types.js';
import type { DependencyGraph } from '../../graph/dependency-graph.js';

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
/** Mutable state a watch session carries between runs. */
interface WatchSession {
  /** The fixed point drift is measured from: the baseline, or the state at start-up. */
  reference: Metrics;
  /** Scores from the previous run, so a metric is only announced when it moves. */
  previous: Metrics;
  /** Findings already reported, so the same problem is not repeated on every keystroke. */
  known: Set<string>;
}

/** Watches the tree, filtering out anything that cannot change the analysis. */
function createWatcher(root: string, onChange: (relative: string) => void) {
  const ignored = WATCH_IGNORED.map(compilePattern);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (target) => {
      const relative = toPosix(path.relative(root, target));
      if (!relative || relative.startsWith('..')) return false;
      return matchesCompiled(relative, ignored);
    },
  });

  const handle = (file: string): void => {
    const relative = toPosix(path.relative(root, file));
    if (matchesCompiled(relative, ignored)) return;
    if (!affectsAnalysis(relative)) return;
    onChange(relative);
  };

  watcher.on('add', handle).on('change', handle).on('unlink', handle);
  return watcher;
}

/** Resolves once the process is asked to stop, after cleaning up. */
function untilStopped(cleanup: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      cleanup();
      print('');
      print(dim(`${icons.owl} Stopped watching.`));
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export async function watchCommand(options: WatchOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const cache = ParseCache.open(root);

  print('');
  print(`${icons.owl} ${colors.bold('Little Owl is watching your codebase.')}`);
  print('');

  const first = await analyzeProject({ root, config, cache });
  const savedBaseline = readBaseline(root);

  const session: WatchSession = {
    reference: savedBaseline?.metrics ?? first.result.metrics,
    previous: first.result.metrics,
    known: new Set(
      (savedBaseline?.findings ?? first.result.findings).map((finding) => finding.fingerprint),
    ),
  };

  printHealthy(first.result, session.reference, savedBaseline !== null);
  print(dim(`Watching ${first.result.project.fileCount} files. Press Ctrl+C to stop.`));
  print('');

  const queue = createRunQueue(
    options.debounce ?? 400,
    async (touched) => {
      for (const file of touched) cache.invalidate(file);

      const next = await analyzeProject({ root, config, cache });
      report(touched, next.result, next.context.graph, session, options);

      session.previous = next.result.metrics;
      for (const finding of next.result.findings) session.known.add(finding.fingerprint);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      print(colors.red(`${icons.error} Analysis failed: ${message}`));
    },
  );

  const watcher = createWatcher(root, (relative) => queue.add(relative));

  await untilStopped(() => {
    queue.stop();
    void watcher.close();
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

/** The files that were saved, and how far their imports reach. */
function printChangeHeader(touched: string[], attributed: AttributedFindings): void {
  print(colors.bold('Changed'));
  for (const file of touched.slice(0, 5)) print(`  ${file}`);
  if (touched.length > 5) print(dim(`  ... and ${touched.length - 5} more`));

  const affected = attributed.affectedFiles.length;
  if (affected > 0) {
    print(dim(`  ${countLabel(affected, 'file')} import this, directly or indirectly`));
  }
  print('');
}

function printDrift(drifted: Array<keyof Metrics>, current: Metrics, reference: Metrics): void {
  for (const key of drifted) {
    print(
      metricLine({
        label: key === 'typeSafety' ? 'Type Safety' : key[0]!.toUpperCase() + key.slice(1),
        value: current[key],
        previous: reference[key],
      }),
    );
  }
}

/**
 * Findings under a heading that says how they relate to the edit.
 *
 * Listing an unrelated file's problem beneath the file that was just saved
 * would be a claim the developer has no way to check.
 */
function printGroup(label: string, findings: Finding[]): void {
  if (findings.length === 0) return;

  print('');
  print(rule());
  print('');
  print(colors.bold(label));
  print('');

  for (const finding of findings.slice(0, 3)) {
    print(renderFinding(finding, false));
    print('');
  }
  if (findings.length > 3) {
    print(dim(`${findings.length - 3} more — run \`little-owl check --details\`.`));
  }
}

function report(
  touched: string[],
  result: AnalysisResult,
  graph: DependencyGraph,
  session: WatchSession,
  options: WatchOptions,
): void {
  const { reference, previous, known } = session;
  const fresh = result.findings.filter((finding) => !known.has(finding.fingerprint));
  const drifted = (Object.keys(reference) as Array<keyof Metrics>).filter(
    (key) => result.metrics[key] < reference[key] && result.metrics[key] !== previous[key],
  );

  if (fresh.length === 0 && drifted.length === 0) {
    const label = touched.length === 1 ? touched[0]! : `${touched.length} files`;
    print(`${colors.green(icons.ok)} ${dim(label)} ${dim('— no new findings')}`);
    return;
  }

  const attributed = attributeFindings(touched, fresh, graph);
  const fromChange = [...attributed.inChange, ...attributed.inAffected];
  const causedByChange = fromChange.length > 0 || drifted.length > 0;

  print('');
  print(
    colors.yellow(
      causedByChange
        ? `${icons.warn} CODEBASE DRIFT DETECTED`
        : `${icons.warn} NEW FINDINGS ELSEWHERE IN THE PROJECT`,
    ),
  );
  print('');

  printChangeHeader(touched, attributed);
  printDrift(drifted, result.metrics, reference);
  printGroup('In the files you changed', attributed.inChange);
  printGroup('In files that depend on the change', attributed.inAffected);
  printGroup('Elsewhere in the project, not caused by this change', attributed.elsewhere);

  if (options.prompt && fromChange.length > 0) {
    print('');
    print(dim('Prompt for your assistant:'));
    print('');
    print(promptFor(fromChange));
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
        truncated: false,
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
