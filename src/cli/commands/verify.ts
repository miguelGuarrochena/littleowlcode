import { execSync } from 'node:child_process';
import { analyzeProject } from '../../core/analyze.js';
import { detectCommands } from '../../detect/commands.js';
import { printJson } from '../../output/json.js';
import { colors, dim, icons } from '../../output/theme.js';
import {
  divider,
  owlHeader,
  renderIssueList,
  renderNextStep,
  renderSteps,
  verdict,
} from '../../output/guided.js';
import { countByPriority } from '../../output/severity.js';
import { numberFindings, type Issue } from '../../output/issue.js';
import { countLabel } from '../../output/ui.js';
import {
  readSnapshot,
  writeSnapshot,
  type RunSnapshot,
  type SnapshotIssue,
} from '../../baseline/snapshot.js';
import { noRunYet, unknownIssue } from '../errors.js';
import {
  createProgress,
  isInteractive,
  loadProjectConfig,
  print,
  PROGRESS_LABELS,
  resolveRoot,
} from '../runtime.js';
import type { IssueOptions } from './issue.js';

export interface VerifyOptions extends IssueOptions {
  /** Run the project's own test command as part of the check. */
  tests?: boolean;
}

/**
 * `little-owl verify [n]` — did the fix actually land?
 *
 * "Fix applied" is a claim about an edit. This is a claim about the codebase:
 * the issue is re-derived from the current source, so it can only disappear by
 * actually being gone. It also reports anything the fix introduced, because a
 * fix that trades one problem for another is not finished.
 */
export const verifyCommand = async (
  number: number | undefined,
  options: VerifyOptions,
): Promise<number> => {
  const root = resolveRoot(options);
  const before = readSnapshot(root);
  if (!before) throw noRunYet();

  const config = await loadProjectConfig(root);
  const progress = createProgress(!options.json && isInteractive());
  if (!options.json) print(owlHeader('Checking whether the fix landed…'));

  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result, context } = await analyzeProject({
    root,
    config,
    ...(options.cache === false ? { cache: false as const } : {}),
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop();

  const current = numberFindings(result.findings);
  const outcome = compare(before, current, number);

  let testsPassed: boolean | null = null;
  const commands = detectCommands(root, context.project);
  const tests = options.tests && commands.test ? runTests(root, commands.test) : null;
  if (tests) testsPassed = tests.passed;

  if (options.json) {
    printJson({
      verified: number ?? null,
      resolved: outcome.resolved.map((issue) => issue.fingerprint),
      remaining: outcome.remaining.map((issue) => issue.fingerprint),
      introduced: outcome.introduced.map((issue) => issue.fingerprint),
      metrics: result.metrics,
      previousMetrics: before.metrics,
      testsPassed,
    });
    return verifyExitCode(number, outcome.remaining.length, testsPassed);
  }

  print(verifySteps(result.project.fileCount, before.issues.length, testsPassed, commands.test));
  print('');
  if (tests && !tests.passed) {
    print(divider());
    print(tests.output.trimEnd());
    print('');
  }
  print(divider());
  print('');
  printOutcome(outcome, number);
  printMovement(before.metrics.overall, result.metrics.overall);
  print(verdict(countByPriority(result.findings)));
  print('');

  writeSnapshot(root, 'check', current, result.metrics);
  print(renderNextStep(...verifyNextStep(number, outcome, current, testsPassed, commands.test)));
  print('');

  return verifyExitCode(number, outcome.remaining.length, testsPassed);
};

const verifySteps = (
  fileCount: number,
  knownBefore: number,
  testsPassed: boolean | null,
  testCommand: string | undefined,
): string =>
  renderSteps([
    { label: 'Re-read the project', note: countLabel(fileCount, 'file') },
    { label: 'Compared with the last check', note: `${countLabel(knownBefore, 'issue')} then` },
    ...(testsPassed === null
      ? []
      : [
          {
            label: testsPassed ? 'Ran your tests' : 'Ran your tests — they failed',
            note: testCommand,
          },
        ]),
  ]);

interface Outcome {
  resolved: SnapshotIssue[];
  remaining: SnapshotIssue[];
  introduced: Issue[];
}

/**
 * What changed between the last run and this one.
 *
 * Findings are matched by fingerprint rather than by position, so an issue can
 * only count as fixed by actually not reproducing — never by another one being
 * fixed above it and shifting the numbering.
 */
const compare = (before: RunSnapshot, current: Issue[], number: number | undefined): Outcome => {
  const stillThere = new Set(current.map((issue) => issue.fingerprint));
  const knownBefore = new Set(before.issues.map((issue) => issue.fingerprint));

  const targets =
    number === undefined ? before.issues : before.issues.filter((issue) => issue.number === number);
  if (number !== undefined && targets.length === 0)
    throw unknownIssue(number, before.issues.length);

  return {
    resolved: targets.filter((issue) => !stillThere.has(issue.fingerprint)),
    remaining: targets.filter((issue) => stillThere.has(issue.fingerprint)),
    introduced: current.filter((issue) => !knownBefore.has(issue.fingerprint)),
  };
};

const printOutcome = (outcome: Outcome, number: number | undefined): void => {
  for (const issue of outcome.resolved) {
    print(
      `${colors.green('🟢')} ${colors.bold(`Issue #${issue.number} is fixed`)}   ${dim(issue.title)}`,
    );
  }
  if (outcome.resolved.length > 0) print('');

  const stuck = outcome.remaining[0];
  if (stuck && number !== undefined) {
    print(colors.yellow(`${icons.warn} ${colors.bold(`Issue #${stuck.number} is still there`)}`));
    print(dim(`   ${stuck.title}`));
    print(dim('   The change either has not been made yet, or did not address the cause.'));
    print('');
  } else if (stuck) {
    // Verifying everything: "still open" with nothing under it is a shrug.
    print(colors.yellow(`${icons.warn} ${colors.bold('Still open')}`));
    for (const issue of outcome.remaining.slice(0, 3)) {
      print(dim(`   #${issue.number}  ${issue.title}`));
    }
    if (outcome.remaining.length > 3) {
      print(dim(`   … and ${outcome.remaining.length - 3} more`));
    }
    print('');
  }

  // A fix that trades one problem for another is not finished, and saying so
  // here is the difference between "done" and "done, and I checked".
  if (outcome.introduced.length > 0) {
    const count = outcome.introduced.length;
    print(
      colors.red(
        `${icons.warn} ${count} new issue${count === 1 ? '' : 's'} appeared since the last check`,
      ),
    );
    print('');
    print(renderIssueList(outcome.introduced, { limit: 2, heading: 'New since then' }));
    print('');
  }
};

/**
 * The score, moved or not.
 *
 * Staying silent when nothing changed reads as "it forgot to check". After a
 * fix, "unchanged" is an answer the reader wants — a structural fix often costs
 * nothing and gains nothing on the score, and that is worth confirming rather
 * than leaving them to wonder.
 */
const printMovement = (before: number, after: number): void => {
  const delta = after - before;
  const arrow =
    delta > 0
      ? colors.green(`${icons.up} +${delta}`)
      : delta < 0
        ? colors.red(`${icons.down} ${delta}`)
        : dim(`${icons.flat} unchanged`);
  print(`${colors.bold('Health')}   ${before} ${dim(icons.arrow)} ${after}   ${arrow}`);
  print('');
};

/**
 * Non-zero means "the thing you asked me to confirm did not happen".
 *
 * Asking about one issue is a question with a yes or no answer, so a remaining
 * issue is a failure. Asking about all of them is a status report — a project
 * with one minor note left is not a failed command, and treating it as one
 * would make `verify` useless in a script the moment anything was deferred.
 */
const verifyExitCode = (
  number: number | undefined,
  remaining: number,
  testsPassed: boolean | null,
): number => {
  if (testsPassed === false) return 1;
  return number !== undefined && remaining > 0 ? 1 : 0;
};

const verifyNextStep = (
  number: number | undefined,
  outcome: Outcome,
  current: Issue[],
  testsPassed: boolean | null,
  testCommand: string | undefined,
): [{ command: string; note?: string }, Array<{ command: string; note?: string }>] => {
  if (testsPassed === false) {
    return [
      { command: testCommand ?? 'your tests', note: 'read the failure before going further' },
      [],
    ];
  }

  // Asked about one issue, and it is still there: the useful next move is the
  // fix plan again, not a fresh list of everything.
  if (number !== undefined && outcome.remaining.length > 0) {
    return [
      { command: `little-owl fix ${number}`, note: 'the plan for this issue, again' },
      [{ command: `little-owl explain ${number} --technical`, note: 'the raw evidence' }],
    ];
  }
  if (outcome.introduced.length > 0) {
    return [{ command: 'little-owl check --all', note: 'look at what appeared' }, []];
  }

  // Only point at another issue when there is a reason to do it now. Sending
  // someone straight from a successful fix to `fix 4` for a low-priority note
  // turns a finished piece of work into an endless queue.
  const next = current.find((issue) => issue.severity !== 'info');
  if (next) {
    return [
      { command: `little-owl fix ${next.number}`, note: `next up: ${next.title}` },
      [{ command: 'little-owl baseline', note: 'or lock in this state as the new reference' }],
    ];
  }

  const minor = current.length;
  return [
    { command: 'little-owl baseline', note: 'nothing urgent left — record this as the reference' },
    minor > 0
      ? [
          {
            command: 'little-owl check --all',
            note: `${countLabel(minor, 'minor note')} to look at`,
          },
        ]
      : [],
  ];
};

interface TestRun {
  passed: boolean;
  output: string;
}

/**
 * Runs the project's own test command.
 *
 * Only ever on `--tests`, and only ever the command the project already
 * defines — Little Owl does not invent a way to test somebody's app.
 *
 * The output is captured rather than inherited. A passing suite has nothing to
 * say, and letting it print would push the actual answer off the top of the
 * screen behind a wall of green dots; a failing one is printed in full, because
 * then the wall is the answer.
 */
const runTests = (root: string, command: string): TestRun => {
  try {
    const output = execSync(command, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { passed: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { passed: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
};
