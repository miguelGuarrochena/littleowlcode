#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readVersion, printError } from './runtime.js';
import { interactiveCommand } from './interactive.js';
import { checkCommand } from './commands/check.js';
import { reviewCommand } from './commands/review.js';
import { watchCommand } from './commands/watch.js';
import { initCommand } from './commands/init.js';
import { baselineCommand, compareCommand } from './commands/baseline.js';
import { architectureCommand, dependenciesCommand, impactCommand } from './commands/inspect.js';
import { configCommand } from './commands/config.js';
import { ciCommand } from './commands/ci.js';
import { promptCommand } from './commands/prompt.js';
import {
  deadCodeCommand,
  doctorCommand,
  explainCommand,
  mapCommand,
  testsCommand,
} from './commands/insight.js';

const version = readVersion();

const program = new Command();

program
  .name('little-owl')
  .description(
    'A second pair of eyes for your codebase.\nKeep your codebase healthy while AI writes code.',
  )
  .version(version, '-v, --version')
  .option('-C, --cwd <dir>', 'run against another directory')
  .option('--no-color', 'disable coloured output')
  .helpOption('-h, --help', 'show help');

/** Options declared on the root command are shared by every subcommand. */
const globals = (): { cwd?: string } => {
  const options = program.opts<{ cwd?: string }>();
  return options.cwd ? { cwd: options.cwd } : {};
};

const list = (value: string, previous: string[] = []): string[] => {
  return [
    ...previous,
    ...value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
};

program
  .command('init')
  .description('set up .little-owl/config.ts and an initial baseline')
  .option('-y, --yes', 'accept the defaults without asking')
  .option('--force', 'overwrite an existing configuration')
  .option('--no-baseline', 'skip creating a baseline')
  .action(async (options) => {
    await run(() => initCommand({ ...globals(), ...options }));
  });

program
  .command('check')
  .description('report the current health of the codebase')
  .option('--json', 'machine-readable output')
  .option('--details', 'show every finding')
  .option('-q, --quiet', 'only the essentials')
  .option('--no-cache', 'ignore the parse cache')
  .action(async (options) => {
    await run(() => checkCommand({ ...globals(), ...options }));
  });

program
  .command('review')
  .description('review recent changes against the baseline')
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('-s, --scope <glob>', 'area the change was meant to touch (repeatable)', list)
  .option('--json', 'machine-readable output')
  .option('--details', 'show every finding')
  .option('--prompt', 'print an AI prompt instead of the report')
  .option('-q, --quiet', 'only the essentials')
  .option('--no-cache', 'ignore the parse cache')
  .option('--no-menu', 'skip the follow-up menu')
  .action(async (options) => {
    await run(() => reviewCommand({ ...globals(), ...options, noMenu: options.menu === false }));
  });

program
  .command('watch')
  .description('watch the codebase and report drift as it happens')
  .option('--debounce <ms>', 'delay before re-analysing', (value) => Number.parseInt(value, 10))
  .option('--prompt', 'include an AI prompt with each report')
  .action(async (options) => {
    await run(() => watchCommand({ ...globals(), ...options }));
  });

program
  .command('architecture')
  .description('show the detected layers and boundary violations')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => architectureCommand({ ...globals(), ...options }));
  });

program
  .command('impact')
  .argument('[file]', 'file to analyse (defaults to the current git changes)')
  .description('show what changing a file could affect')
  .option('-f, --files <paths>', 'additional files to analyse', list)
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (file, options) => {
    const files = [...(file ? [file] : []), ...((options.files as string[] | undefined) ?? [])];
    await run(() =>
      impactCommand({ ...globals(), ...options, ...(files.length > 0 ? { files } : {}) }),
    );
  });

program
  .command('dependencies')
  .alias('deps')
  .description('compare declared dependencies with what is actually imported')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => dependenciesCommand({ ...globals(), ...options }));
  });

program
  .command('baseline')
  .description('record the current state as the reference for future reviews')
  .option('-y, --yes', 'write without asking')
  .option('--show', 'print the existing baseline instead of writing one')
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    await run(() => baselineCommand({ ...globals(), ...options }));
  });

program
  .command('compare')
  .description('show recent reviews against the same baseline')
  .option('-n, --limit <count>', 'how many entries to show', (value) => Number.parseInt(value, 10))
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    await run(() => compareCommand({ ...globals(), ...options }));
  });

program
  .command('config')
  .description('show the configuration currently in effect')
  .option('--rules', 'list every rule and its severity')
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    await run(() => configCommand({ ...globals(), ...options }));
  });

program
  .command('ci')
  .description('non-interactive check with an exit code')
  .option('--json', 'machine-readable output')
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('-s, --scope <glob>', 'area the change was meant to touch (repeatable)', list)
  .addOption(
    new Option('--fail-on <level>', 'severity that fails the build').choices([
      'error',
      'warning',
      'never',
    ]),
  )
  .option('--max-drop <points>', 'largest acceptable drop in the overall score', (value) =>
    Number.parseInt(value, 10),
  )
  .option('--all', 'consider pre-existing findings too, not just new ones')
  .action(async (options) => {
    await run(() => ciCommand({ ...globals(), ...options }));
  });

program
  .command('prompt')
  .description('write a prompt for your AI assistant from the current findings')
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('-s, --scope <glob>', 'area the change was meant to touch (repeatable)', list)
  .option('--all', 'include findings that predate this change')
  .option('-n, --max <count>', 'maximum number of instructions', (value) =>
    Number.parseInt(value, 10),
  )
  .action(async (options) => {
    await run(() => promptCommand({ ...globals(), ...options }));
  });

program
  .command('explain')
  .argument('<file>', 'the file to investigate')
  .description('why does this code exist? (reads git history)')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (file, options) => {
    await run(() => explainCommand(file, { ...globals(), ...options }));
  });

program
  .command('dead-code')
  .description('find files nothing appears to reach')
  .addOption(
    new Option('--min-confidence <level>', 'lowest confidence to report').choices([
      'high',
      'medium',
      'low',
    ]),
  )
  .option('--include-tests', 'consider test files too')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => deadCodeCommand({ ...globals(), ...options }));
  });

program
  .command('tests')
  .description('find behaviour that no test appears to watch')
  .option('--changed', 'only look at what the current change touched')
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => testsCommand({ ...globals(), ...options }));
  });

program
  .command('map')
  .description('a high-level map of the project')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => mapCommand({ ...globals(), ...options }));
  });

program
  .command('doctor')
  .description('check that Little Owl can see this project properly')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => doctorCommand({ ...globals(), ...options }));
  });

program.action(async () => {
  await run(() => interactiveCommand(globals()));
});

const run = async (command: () => Promise<number> | number): Promise<void> => {
  try {
    process.exitCode = await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(message);
    if (process.env['LITTLE_OWL_DEBUG'] && error instanceof Error) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  }
};

program.parseAsync(process.argv).catch((error: unknown) => {
  printError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
