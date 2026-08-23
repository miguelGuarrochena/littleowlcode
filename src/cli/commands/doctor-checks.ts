import fs from 'node:fs';
import path from 'node:path';
import { MAX_SCANNED_FILES } from '../../core/scan.js';
import { colors, dim, icons } from '../../output/theme.js';
import { countLabel } from '../../output/ui.js';
import { renderNextStep } from '../../output/guided.js';
import { validateAgainstProject } from '../../config/validate.js';
import { hasUsableLayers, layerCoverage } from '../../architecture/layers.js';
import { configDriftedFromBaseline, readBaseline } from '../../baseline/baseline.js';
import { LAYER_COVERAGE_TARGET } from '../../core/metrics.js';
import { print } from '../runtime.js';
import type { AnalysisContext } from '../../core/context.js';
import type { AnalysisResult, AnalysisWarning } from '../../core/types.js';
import type { ResolvedConfig } from '../../config/schema.js';

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
const filesAnalysedDetail = (fileCount: number, truncated: boolean, elapsed: number): string => {
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
};

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'info';
  detail: string;
  /** Further lines, indented under the check. Used when one line is not enough. */
  extra?: string[];
}

type CheckBuilder = (input: DoctorInput) => DoctorCheck | null;

export interface DoctorInput {
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

const configCheck: CheckBuilder = ({ root, config }) => {
  if (!config.sourcePath) {
    return {
      name: 'Configuration',
      status: 'info',
      detail: 'using defaults — run `little-owl init` to declare your layers',
    };
  }

  const where = path.relative(root, config.sourcePath);
  return {
    name: 'Configuration',
    status: config.warnings.length === 0 ? 'ok' : 'warn',
    detail:
      config.warnings.length === 0
        ? where
        : `${where} — ${countLabel(config.warnings.length, 'setting')} ignored (see the warnings above)`,
  };
};

/**
 * Configured patterns that match nothing.
 *
 * A `forbidden` pair or a layer directory that matches no file behaves exactly
 * like one that found no problems, so it stays broken indefinitely. This is the
 * check that tells them apart.
 */
const patternCheck: CheckBuilder = ({ config, context }) => {
  const dead = validateAgainstProject(config, context.files, context.layers);
  if (dead.length === 0) return null;
  return {
    name: 'Config patterns',
    status: 'warn',
    detail: dead[0]!,
    ...(dead.length > 1 ? { extra: dead.slice(1) } : {}),
  };
};

const baselineCheck: CheckBuilder = ({ root, config }) => {
  const baseline = readBaseline(root);
  if (!baseline) {
    return { name: 'Baseline', status: 'info', detail: 'none yet — run `little-owl baseline`' };
  }

  const drifted = configDriftedFromBaseline(baseline, config);
  if (drifted === true) {
    return {
      name: 'Baseline',
      status: 'warn',
      detail: 'recorded under a different configuration — re-record with `little-owl baseline`',
    };
  }
  // A baseline from an older version cannot answer the question at all, and a
  // comparison that might be misattributed should not look like a clean one.
  if (drifted === null) {
    return {
      name: 'Baseline',
      status: 'info',
      detail:
        'recorded before Little Owl tracked configuration — re-record to make drift verifiable',
    };
  }

  return {
    name: 'Baseline',
    status: 'ok',
    detail: 'recorded under this configuration — reviews compare against it',
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

/**
 * The layer model, and how much of the tree it reaches.
 *
 * A green tick next to a chain of layer names used to be the whole answer,
 * which reads as "your architecture is fine" even when the model covers a
 * third of the code. Coverage is what makes the tick mean something.
 */
const architectureCheck: CheckBuilder = ({ context }) => {
  const { order, inferred } = context.layers;

  // One layer is a common and confusing state: the config looks configured,
  // and nothing is ever reported. Name the cause rather than the symptom.
  if (order.length === 1) {
    return {
      name: 'Architecture',
      status: 'warn',
      detail: `only one layer (${order[0]}) — a boundary needs two, so no boundary checks ran`,
      extra: ['Declare a second layer in `.little-owl/config.ts`, or remove the first.'],
    };
  }
  if (!hasUsableLayers(context.layers)) {
    return {
      name: 'Architecture',
      status: 'info',
      detail: 'no layers detected — boundary checks are inactive',
    };
  }

  const coverage = layerCoverage(context.files, context.layers);
  const percent = Math.round(coverage.share * 100);
  const source = inferred ? 'inferred' : 'configured';
  const covered = coverage.share >= LAYER_COVERAGE_TARGET;

  return {
    name: 'Architecture',
    status: covered ? 'ok' : 'warn',
    detail: covered
      ? `${order.join(' → ')} (${source}) — ${percent}% of files covered`
      : `${order.join(' → ')} (${source}) — only ${percent}% of files are inside a layer` +
        `${coverage.unplaced[0] ? `, e.g. ${coverage.unplaced[0].directory}` : ''}`,
  };
};

/**
 * Does what Little Owl is analysing look like this project?
 *
 * Every other check answers "did the machinery run". This one answers the
 * question that actually goes wrong: it ran, and it read the wrong files.
 * Doctor exists to be run when the output looks strange, so a green doctor over
 * a misread project is worse than no doctor at all — it confirms the reader's
 * mistake back to them.
 */
const plausibilityCheck: CheckBuilder = ({ root, config, result, context }) => {
  const problems: string[] = [];

  // Sample code being analysed as production code. The one that ruined a first
  // run: two "critical" findings, both inside a fixture named `bad-architecture`.
  const samples = analysedSampleDirectories(context);
  if (samples.length > 0) {
    const [worst] = samples;
    problems.push(
      `${worst!.directory} looks like sample code but is being analysed ` +
        `(${countLabel(worst!.files, 'file')})`,
    );
  }

  // A stack the manifest does not corroborate usually means the extra language
  // came from fixtures or vendored code, and it skews everything downstream.
  const declared = declaredLanguages(root);
  const surprising = result.project.languages.filter(
    (language) => language !== 'unknown' && declared.size > 0 && !declared.has(language),
  );
  if (surprising.length > 0) {
    problems.push(
      `detected ${surprising.join(' and ')} but package.json suggests ` +
        `${[...declared].join('/')} — check what those files are`,
    );
  }

  if (problems.length === 0) {
    return {
      name: 'Scope',
      status: 'ok',
      detail: `${countLabel(result.stats.files, 'source file')} analysed, ${countLabel(config.ignore.length, 'ignore pattern')} applied`,
    };
  }

  return {
    name: 'Scope',
    status: 'warn',
    detail: problems[0]!,
    extra: [
      ...problems.slice(1),
      'Add it to `ignore` in .little-owl/config.ts if it is not your application.',
    ],
  };
};

/** Directories that survived the ignore list but read as samples. */
const analysedSampleDirectories = (
  context: AnalysisContext,
): Array<{ directory: string; files: number }> => {
  const counts = new Map<string, number>();
  for (const file of context.files) {
    const parts = file.path.split('/');
    const trigger = parts.findIndex((part) => SAMPLE_DIRECTORY.test(part));
    if (trigger < 0) continue;
    const directory = parts.slice(0, trigger + 1).join('/');
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts]
    .map(([directory, files]) => ({ directory, files }))
    .sort((a, b) => b.files - a.files);
};

const SAMPLE_DIRECTORY =
  /^(fixtures?|__fixtures__|__mocks__|mocks|testdata|examples?|scaffold|templates?)$/i;

/** Languages the project's own manifest implies, used to sanity-check detection. */
const declaredLanguages = (root: string): Set<string> => {
  const declared = new Set<string>();
  if (fs.existsSync(path.join(root, 'package.json'))) {
    declared.add('typescript');
    declared.add('javascript');
  }
  if (fs.existsSync(path.join(root, 'go.mod')) || fs.existsSync(path.join(root, 'go.sum'))) {
    declared.add('go');
  }
  for (const marker of ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile']) {
    if (fs.existsSync(path.join(root, marker))) declared.add('python');
  }
  return declared;
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
  patternCheck,
  baselineCheck,
  filesCheck,
  resolutionCheck,
  plausibilityCheck,
  architectureCheck,
  testsCheck,
  skippedCheck,
];

export const buildChecks = (input: DoctorInput): DoctorCheck[] => {
  return CHECKS.map((build) => build(input)).filter(
    (check): check is DoctorCheck => check !== null,
  );
};

const CHECK_MARK: Record<DoctorCheck['status'], () => string> = {
  ok: () => colors.green(icons.ok),
  warn: () => colors.yellow(icons.warn),
  info: () => dim(icons.info),
};

export const printChecks = (checks: DoctorCheck[], warnings: AnalysisWarning[]): void => {
  print('');
  print(`${icons.owl} ${colors.bold('Little Owl doctor')}`);
  print('');

  for (const check of checks) {
    print(`${CHECK_MARK[check.status]()} ${check.name.padEnd(20)} ${dim(check.detail)}`);
    for (const line of check.extra ?? []) print(dim(`${' '.repeat(23)}${line}`));
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
  // Doctor is usually run because something looked wrong. Ending on a verdict
  // and no command leaves the reader exactly where they started.
  print(
    renderNextStep(
      problems === 0
        ? { command: 'little-owl check', note: 'see what needs attention' }
        : { command: 'little-owl init --force', note: 're-detect this project from scratch' },
    ),
  );
  print('');
};
