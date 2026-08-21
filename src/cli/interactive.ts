import * as prompts from '@clack/prompts';
import { detectProject, describeStack } from '../detect/project.js';
import { scanFiles } from '../core/scan.js';
import { loadConfig } from '../config/load.js';
import { readBaseline } from '../baseline/baseline.js';
import { isGitRepository } from '../git/git.js';
import { banner } from '../output/ui.js';
import { colors, dim, icons } from '../output/theme.js';
import { cancelled, isInteractive, print, resolveRoot, type GlobalOptions } from './runtime.js';
import { checkCommand } from './commands/check.js';
import { reviewCommand } from './commands/review.js';
import { watchCommand } from './commands/watch.js';
import { architectureCommand, dependenciesCommand, impactCommand } from './commands/inspect.js';
import { initCommand } from './commands/init.js';
import { baselineCommand } from './commands/baseline.js';
import { configCommand } from './commands/config.js';
import { deadCodeCommand, doctorCommand, mapCommand, testsCommand } from './commands/insight.js';

/**
 * The default experience: show what was detected, then offer the handful of
 * things a developer actually wants to do. Nobody should have to memorise a
 * command to get value out of this tool.
 */
export const interactiveCommand = async (options: GlobalOptions): Promise<number> => {
  const root = resolveRoot(options);

  if (!isInteractive()) {
    // Piped or CI: fall back to the most useful non-interactive command.
    return checkCommand(options);
  }

  print('');
  print(banner());
  print('');

  const config = await loadConfig(root);
  const { files } = scanFiles(root, config);
  const project = detectProject(root, { files });

  printDetection(root, project.fileCount, describeStack(project), project.frameworks);

  const configured = config.sourcePath !== null;
  const baseline = readBaseline(root);

  if (!configured && !baseline) {
    return firstRun(options);
  }

  for (;;) {
    const choice = await prompts.select({
      message: 'What would you like to do?',
      options: [
        {
          value: 'review',
          label: '🔍 Review recent changes',
          hint: 'what did the last change do?',
        },
        { value: 'check', label: '🧭 Check codebase', hint: 'health right now' },
        { value: 'watch', label: '👀 Watch changes', hint: 'keep an eye on it while you work' },
        { value: 'architecture', label: '🏗  Understand architecture' },
        { value: 'impact', label: '📊 See change impact' },
        { value: 'map', label: '🗺  Map the project', hint: 'new to this codebase?' },
        { value: 'tests', label: '🧪 Find test gaps' },
        { value: 'dead-code', label: '🧹 Find dead code' },
        { value: 'dependencies', label: '📦 Inspect dependencies' },
        { value: 'baseline', label: '📌 Update baseline' },
        { value: 'config', label: '⚙  Configure' },
        { value: 'doctor', label: '🩺 Doctor', hint: 'is Little Owl seeing this project right?' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (prompts.isCancel(choice) || choice === 'exit') {
      print('');
      print(dim(`${icons.owl} See you.`));
      return 0;
    }

    print('');
    switch (choice) {
      case 'review':
        await reviewCommand({ ...options, noMenu: false });
        break;
      case 'check':
        await checkCommand(options);
        break;
      case 'watch':
        return watchCommand(options);
      case 'architecture':
        await architectureCommand(options);
        break;
      case 'impact':
        await impactCommand(options);
        break;
      case 'map':
        await mapCommand(options);
        break;
      case 'tests':
        await testsCommand(options);
        break;
      case 'dead-code':
        await deadCodeCommand(options);
        break;
      case 'dependencies':
        await dependenciesCommand(options);
        break;
      case 'doctor':
        await doctorCommand(options);
        break;
      case 'baseline':
        await baselineCommand(options);
        break;
      case 'config':
        await configCommand(options);
        break;
      default:
        break;
    }
    print('');
  }
};

const printDetection = (
  root: string,
  fileCount: number,
  stack: string,
  frameworks: string[],
): void => {
  const good = (text: string): string => `${colors.green(icons.ok)} ${text}`;

  if (isGitRepository(root)) print(good('Git repository detected'));
  for (const framework of frameworks.slice(0, 3)) print(good(`${framework} detected`));
  print(good(`${stack}`));
  print(good(`${fileCount} source files`));
  print('');
};

/** Shown when there is no config and no baseline yet. */
const firstRun = async (options: GlobalOptions): Promise<number> => {
  print(dim('Looks like this is your first time here.'));
  print('');

  const choice = await prompts.select({
    message: 'Want me to analyse the project and create a baseline?',
    options: [
      { value: 'baseline', label: 'Analyse and create a baseline', hint: 'recommended' },
      { value: 'analyze', label: 'Just analyse' },
      { value: 'configure', label: 'Configure manually' },
      { value: 'exit', label: 'Exit' },
    ],
  });

  if (prompts.isCancel(choice) || choice === 'exit') cancelled();

  print('');
  if (choice === 'analyze') return checkCommand(options);
  if (choice === 'configure') return initCommand({ ...options, baseline: false });
  return initCommand(options);
};
