#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readVersion, printError } from './runtime.js';
import { asOwlError, renderOwlError } from './errors.js';
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
import { explainIssueCommand, fixCommand } from './commands/issue.js';
import { verifyCommand } from './commands/verify.js';
import { agentCommand } from './commands/agent.js';
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
  .helpOption('-h, --help', 'show help')
  // Twenty commands with no starting point is a wall, so the five that make up
  // the loop go *above* the list rather than below it — help text after the
  // commands is help text nobody scrolls to. And the npm name is
  // `little-owl-code`: `npx little-owl` fetches an unrelated package, which is
  // worth saying where people actually look.
  .addHelpText(
    'before',
    [
      '',
      'Start here — the whole loop is five commands:',
      '',
      '  little-owl init        set up. No questions, takes a few seconds.',
      '  little-owl check       what needs attention, most important first',
      '  little-owl explain 1   what issue #1 means, in plain language',
      '  little-owl fix 1       everything needed to fix it, incl. an AI brief',
      '  little-owl verify 1    confirm the fix actually landed',
      '',
      'Everything else is optional. Run `little-owl` on its own for a menu.',
      '',
    ].join('\n'),
  )
  .addHelpText(
    'after',
    [
      '',
      'Installed from npm as `little-owl-code` — `npx little-owl-code <command>`.',
      'Docs: https://littleowlcode.com/docs',
    ].join('\n'),
  );

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
  .description('set Little Owl up for this project (asks nothing)')
  .option('-y, --yes', 'accept the defaults without asking (now the default)')
  .option('-i, --interactive', 'choose the structure and strictness yourself')
  .option('--force', 'overwrite an existing configuration')
  .option('--no-baseline', 'skip creating a baseline')
  .option('--no-agent-file', 'skip writing LITTLE_OWL.md for AI assistants')
  .action(async (options) => {
    await run(() => initCommand({ ...globals(), ...options }));
  });

program
  .command('check')
  .description('what needs attention in this project, most important first')
  .option('--json', 'machine-readable output')
  .option('--all', 'list every issue, not just the first few')
  .option('--details', 'the full explanation of every issue')
  .option('-q, --quiet', 'only the essentials')
  .option('--no-cache', 'ignore the parse cache')
  .action(async (options) => {
    await run(() => checkCommand({ ...globals(), ...options }));
  });

program
  .command('explain')
  .argument('<issue-or-file>', 'an issue number from `check`, or a file path')
  .description('explain an issue in plain language (or a file, from git history)')
  .option('--json', 'machine-readable output')
  .option('--technical', 'include the rule id and raw evidence')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (target: string, options) => {
    const issue = issueNumber(target);
    await run(() =>
      issue === null
        ? explainCommand(target, { ...globals(), ...options })
        : explainIssueCommand(issue, { ...globals(), ...options }),
    );
  });

program
  .command('fix')
  .argument('[issue]', 'issue number from `check` (defaults to #1)')
  .description('everything needed to fix one issue, including a brief for your AI')
  .option('--brief', 'print only the AI brief, ready to pipe or copy')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (issue: string | undefined, options) => {
    const number = issue === undefined ? 1 : issueNumber(issue);
    if (number === null) {
      printError(`'${issue}' is not an issue number. Run 'little-owl check' to see the list.`);
      process.exitCode = 1;
      return;
    }
    await run(() =>
      fixCommand(number, { ...globals(), ...options, briefOnly: options.brief === true }),
    );
  });

program
  .command('verify')
  .argument('[issue]', 'issue number to confirm (defaults to all of them)')
  .description('check whether the fixes actually landed')
  .option('--tests', "also run this project's own test command")
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (issue: string | undefined, options) => {
    const number = issue === undefined ? undefined : issueNumber(issue);
    if (number === null) {
      printError(`'${issue}' is not an issue number. Run 'little-owl check' to see the list.`);
      process.exitCode = 1;
      return;
    }
    await run(() => verifyCommand(number, { ...globals(), ...options }));
  });

program
  .command('prompt')
  .description('write a prompt for your AI assistant from the current findings')
  .option('-b, --base <ref>', 'git ref to compare against')
  .option('-s, --scope <glob>', 'area the change was meant to touch (repeatable)', list)
  .option('--all', 'include findings that predate this change')
  .option('--compact', 'a short numbered list instead of the full brief')
  .option('-n, --max <count>', 'maximum number of issues to include', (value) =>
    Number.parseInt(value, 10),
  )
  .action(async (options) => {
    await run(() => promptCommand({ ...globals(), ...options }));
  });

program
  .command('agent')
  .description('write LITTLE_OWL.md, the briefing file for AI assistants')
  .option('--force', 'overwrite an existing file')
  .action(async (options) => {
    await run(() => agentCommand({ ...globals(), ...options }));
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
  .command('map')
  .description('a high-level map of the project')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => mapCommand({ ...globals(), ...options }));
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
  .command('architecture')
  .description('show the detected layers and boundary violations')
  .option('--json', 'machine-readable output')
  .option('--details', 'name every offending import')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => architectureCommand({ ...globals(), ...options }));
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
  .command('config')
  .description('show the configuration currently in effect')
  .option('--rules', 'list every rule and its severity')
  .option('--json', 'machine-readable output')
  .action(async (options) => {
    await run(() => configCommand({ ...globals(), ...options }));
  });

program
  .command('doctor')
  .description('check that Little Owl can see this project properly')
  .option('--json', 'machine-readable output')
  .option('--no-cache', 'ignore the parse cache, writing nothing to the project')
  .action(async (options) => {
    await run(() => doctorCommand({ ...globals(), ...options }));
  });

/**
 * No command means interactive mode — but a *wrong* command reaches here too,
 * because the root action swallows leftover arguments. Commander's own message
 * for that is "too many arguments. Expected 0 arguments but got 1", which tells
 * nobody they simply mistyped `architecture`.
 */
program
  .argument('[command]', 'command to run (omit for interactive mode)')
  .action(async (maybeCommand: string | undefined) => {
    if (maybeCommand !== undefined) {
      printError(`unknown command '${maybeCommand}'.${didYouMean(maybeCommand)}`);
      process.stderr.write("  Run 'little-owl --help' to see every command.\n");
      process.exitCode = 1;
      return;
    }
    await run(() => interactiveCommand(globals()));
  });

/** Every name and alias the CLI answers to. */
const commandNames = (): string[] =>
  program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

const didYouMean = (typed: string): string => {
  const closest = commandNames()
    .map((name) => ({ name, distance: editDistance(typed.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)[0];
  // Roughly one mistake per three characters, so unrelated words stay quiet.
  const budget = Math.max(1, Math.floor(Math.max(typed.length, closest?.name.length ?? 0) / 3));
  return closest && closest.distance <= budget ? ` Did you mean '${closest.name}'?` : '';
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
};

const run = async (command: () => Promise<number> | number): Promise<void> => {
  try {
    process.exitCode = await command();
  } catch (error) {
    // Everything that reaches here becomes an explanation with a way out of it.
    // A bare message tells the reader the tool broke; it never tells them what
    // to type next, and "what do I type next" is the only question they have.
    process.stderr.write(renderOwlError(asOwlError(error)));
    if (process.env['LITTLE_OWL_DEBUG'] && error instanceof Error) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  }
};

/** `3` and `#3` are issue numbers; `src/3.ts` is not. */
const issueNumber = (value: string): number | null => {
  const match = /^#?(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

program.parseAsync(process.argv).catch((error: unknown) => {
  printError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
