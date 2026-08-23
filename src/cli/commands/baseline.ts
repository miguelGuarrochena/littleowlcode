import path from 'node:path';
import * as prompts from '@clack/prompts';
import { analyzeProject } from '../../core/analyze.js';
import {
  baselinePath,
  buildBaseline,
  compareToBaseline,
  configDriftedFromBaseline,
  readBaseline,
  writeBaseline,
} from '../../baseline/baseline.js';
import { appendHistory, latestEntries } from '../../baseline/history.js';
import type { AnalysisResult, Baseline } from '../../core/types.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { colors, dim, icons } from '../../output/theme.js';
import { heading, countLabel } from '../../output/ui.js';
import { renderMetricComparison } from '../../output/report.js';
import { printJson } from '../../output/json.js';
import {
  cancelled,
  createProgress,
  isInteractive,
  loadProjectConfig,
  print,
  PROGRESS_LABELS,
  resolveRoot,
  type GlobalOptions,
} from '../runtime.js';

export interface BaselineOptions extends GlobalOptions {
  /** Write without asking. */
  yes?: boolean;
  show?: boolean;
  json?: boolean;
}

/**
 * `little-owl baseline` — record what "healthy" means for this project.
 *
 * Updating the baseline is always an explicit act. Refreshing it after every
 * AI iteration would quietly redefine healthy as "whatever the code is now".
 */
export const baselineCommand = async (options: BaselineOptions): Promise<number> => {
  const root = resolveRoot(options);
  const existing = readBaseline(root);

  if (options.show) return showBaseline(root, existing, options);

  const config = await loadProjectConfig(root);
  const progress = createProgress(!options.json && isInteractive());
  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result } = await analyzeProject({
    root,
    config,
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop(dim(`Analysed ${result.project.fileCount} files`));

  print('');
  print(colors.bold('Current project health'));
  print('');
  for (const line of renderMetricComparison(result.metrics, existing?.metrics ?? null)) {
    print(line);
  }
  print('');

  if (existing) printWhatSavingAccepts(existing, result, config);

  if (!options.yes) {
    const decision = await confirmOverwrite(existing !== null);
    // Declining is a normal outcome; being unable to ask is not.
    if (decision === 'declined') return 0;
    if (decision === 'needs-yes') return 1;
  }

  const baseline = buildBaseline(root, result, config);
  writeBaseline(root, baseline);
  appendHistory(root, {
    at: baseline.createdAt,
    kind: 'snapshot',
    ...(baseline.commit ? { commit: baseline.commit } : {}),
    ...(baseline.branch ? { branch: baseline.branch } : {}),
    metrics: baseline.metrics,
    findingCounts: {
      error: result.findings.filter((finding) => finding.severity === 'error').length,
      warning: result.findings.filter((finding) => finding.severity === 'warning').length,
      info: result.findings.filter((finding) => finding.severity === 'info').length,
    },
    note: 'baseline updated',
  });

  print(
    `${colors.green(icons.ok)} Baseline saved to ${colors.bold(path.relative(root, baselinePath(root)))}`,
  );
  return 0;
};

/** `little-owl baseline --show` — what is currently recorded. */
const showBaseline = async (
  root: string,
  existing: Baseline | null,
  options: BaselineOptions,
): Promise<number> => {
  if (!existing) {
    print(dim('No baseline yet. Run `little-owl baseline` to create one.'));
    return 1;
  }
  if (options.json) {
    printJson(existing);
    return 0;
  }

  print(heading('BASELINE'));
  print('');
  print(`${dim('Created')}  ${new Date(existing.createdAt).toLocaleString()}`);
  if (existing.commit) print(`${dim('Commit')}   ${existing.commit.slice(0, 8)}`);
  if (existing.branch) print(`${dim('Branch')}   ${existing.branch}`);
  if (existing.configFingerprint) {
    const drifted = configDriftedFromBaseline(existing, await loadProjectConfig(root));
    print(
      `${dim('Config')}   ${existing.configFingerprint}` +
        (drifted ? colors.yellow('  (changed since — run `little-owl baseline`)') : ''),
    );
  }
  print('');
  for (const line of renderMetricComparison(existing.metrics, null)) print(line);
  print('');
  print(dim(`${countLabel(existing.findings.length, 'finding')} recorded at baseline time`));
  return 0;
};

/**
 * Spells out what replacing the baseline would accept.
 *
 * Two different things put a finding in the "appeared since" list: the code got
 * worse, or the configuration started looking for something it did not look for
 * before. Saving is the same act either way, but they mean opposite things.
 */
const printWhatSavingAccepts = (
  existing: Baseline,
  result: AnalysisResult,
  config: ResolvedConfig,
): void => {
  const appeared = compareToBaseline(existing, result).newFindings.length;
  const drifted = configDriftedFromBaseline(existing, config);

  if (appeared > 0) {
    print(
      colors.yellow(
        `${icons.warn} ${countLabel(appeared, 'finding')} appeared since the current baseline.`,
      ),
    );
    if (drifted) {
      print(dim('   The configuration also changed, so some of those were always there.'));
    }
    print(dim('   Saving now accepts them as the new normal.'));
    print('');
    return;
  }

  if (drifted) {
    print(dim('The configuration changed since this baseline. Saving re-records it.'));
    print('');
  }
};

type OverwriteDecision = 'write' | 'declined' | 'needs-yes';

const confirmOverwrite = async (replacing: boolean): Promise<OverwriteDecision> => {
  if (!isInteractive()) {
    print(dim('Run with --yes to write the baseline in a non-interactive shell.'));
    return 'needs-yes';
  }

  const confirmed = await prompts.confirm({
    message: replacing ? 'Replace the existing baseline?' : 'Save this as the baseline?',
    initialValue: !replacing,
  });
  if (prompts.isCancel(confirmed)) cancelled();
  if (!confirmed) print(dim('Baseline unchanged.'));
  return confirmed ? 'write' : 'declined';
};

export interface HistoryOptions extends GlobalOptions {
  limit?: number;
  json?: boolean;
}

/** `little-owl compare` — the last few runs against the same baseline. */
export const compareCommand = (options: HistoryOptions): number => {
  const root = resolveRoot(options);
  const entries = latestEntries(root, options.limit ?? 10);

  if (options.json) {
    printJson({ entries });
    return 0;
  }

  if (entries.length === 0) {
    print(dim('No history yet. Run `little-owl review` a few times.'));
    return 0;
  }

  print(heading('REVIEW HISTORY'));
  print('');

  for (const entry of entries) {
    const when = new Date(entry.at).toLocaleString();
    const label = entry.kind === 'snapshot' ? 'snapshot' : `review #${entry.id}`;
    const trend =
      entry.baselineOverall === undefined
        ? dim('no baseline')
        : entry.metrics.overall > entry.baselineOverall
          ? colors.green('improved')
          : entry.metrics.overall < entry.baselineOverall
            ? colors.red('degraded')
            : dim('unchanged');

    print(`${colors.bold(label.padEnd(12))} ${dim(when)}`);
    print(
      `  baseline ${entry.baselineOverall ?? '—'}   current ${entry.metrics.overall}   ${trend}` +
        (entry.note ? dim(`   ${entry.note}`) : ''),
    );
    print('');
  }

  print(dim('The baseline stays where you put it until you run `little-owl baseline`.'));
  return 0;
};
