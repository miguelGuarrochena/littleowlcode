import * as prompts from '@clack/prompts';
import { detectProject } from '../detect/project.js';
import { scanFiles } from '../core/scan.js';
import { readBaseline } from '../baseline/baseline.js';
import { isGitRepository } from '../git/git.js';
import { dim, icons } from '../output/theme.js';
import { owlHeader, renderDetection } from '../output/guided.js';
import {
  cancelled,
  isInteractive,
  loadProjectConfig,
  print,
  resolveRoot,
  type GlobalOptions,
} from './runtime.js';
import { checkCommand } from './commands/check.js';
import { reviewCommand } from './commands/review.js';
import { watchCommand } from './commands/watch.js';
import { architectureCommand, dependenciesCommand, impactCommand } from './commands/inspect.js';
import { initCommand } from './commands/init.js';
import { baselineCommand } from './commands/baseline.js';
import { configCommand } from './commands/config.js';
import { deadCodeCommand, doctorCommand, mapCommand, testsCommand } from './commands/insight.js';
import { promptCommand } from './commands/prompt.js';
import { agentCommand } from './commands/agent.js';

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

  print(owlHeader());

  const config = await loadProjectConfig(root);
  const { files } = scanFiles(root, config);
  const project = detectProject(root, { files });

  print(renderDetection({ ...project, isGitRepo: isGitRepository(root) }));
  print('');

  const configured = config.sourcePath !== null;
  const baseline = readBaseline(root);

  if (!configured && !baseline) {
    return firstRun(options);
  }

  // Thirteen equally weighted options is a wall, not a menu. The four things
  // people actually came to do are named in plain words at the top; everything
  // else lives one keystroke deeper, where it stops competing for attention.
  for (;;) {
    const choice = await prompts.select({
      message: 'What would you like to do?',
      options: [
        { value: 'check', label: 'See what needs attention', hint: 'start here' },
        { value: 'review', label: 'See what my last change did' },
        { value: 'prompt', label: 'Write a brief for my AI assistant' },
        { value: 'watch', label: 'Watch the project while I work' },
        { value: 'more', label: 'Something else…' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (prompts.isCancel(choice) || choice === 'exit') {
      print('');
      print(dim(`${icons.owl} See you.`));
      return 0;
    }

    if (choice === 'more') {
      const advanced = await moreMenu();
      if (advanced === null) continue;
      print('');
      await runAdvanced(advanced, options);
      print('');
      continue;
    }

    print('');
    switch (choice) {
      case 'prompt':
        await promptCommand(options);
        break;
      case 'review':
        await reviewCommand({ ...options, noMenu: false });
        break;
      case 'check':
        await checkCommand(options);
        break;
      case 'watch':
        return watchCommand(options);
      default:
        break;
    }
    print('');
  }
};

/** The commands people reach for once they know what they are looking for. */
const moreMenu = async (): Promise<string | null> => {
  const choice = await prompts.select({
    message: 'Which one?',
    options: [
      { value: 'map', label: 'Map the project', hint: 'new to this codebase?' },
      { value: 'architecture', label: 'Show the layers and boundary problems' },
      { value: 'impact', label: 'What could changing this file affect?' },
      { value: 'tests', label: 'Find behaviour no test watches' },
      { value: 'dead-code', label: 'Find files nothing reaches' },
      { value: 'dependencies', label: 'Compare declared and imported packages' },
      { value: 'baseline', label: 'Record this state as the new reference' },
      { value: 'agent', label: 'Write LITTLE_OWL.md for AI assistants' },
      { value: 'config', label: 'Show the settings in effect' },
      { value: 'doctor', label: 'Is Little Owl seeing this project properly?' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (prompts.isCancel(choice) || choice === 'back') return null;
  return String(choice);
};

const runAdvanced = async (choice: string, options: GlobalOptions): Promise<void> => {
  const commands: Record<string, () => Promise<number>> = {
    map: () => mapCommand(options),
    architecture: () => architectureCommand(options),
    impact: () => impactCommand(options),
    tests: () => testsCommand(options),
    'dead-code': () => deadCodeCommand(options),
    dependencies: () => dependenciesCommand(options),
    baseline: () => baselineCommand(options),
    agent: () => agentCommand(options),
    config: () => configCommand(options),
    doctor: () => doctorCommand(options),
  };
  await commands[choice]?.();
};

/**
 * Shown when there is no config and no baseline yet.
 *
 * One question with an obvious answer, phrased in terms of what happens rather
 * than what gets written. "Create a baseline" is a thing Little Owl does;
 * "start watching this project" is the thing the person wants.
 */
const firstRun = async (options: GlobalOptions): Promise<number> => {
  print(dim('This is the first time Little Owl has seen this project.'));
  print('');

  const choice = await prompts.select({
    message: 'Set Little Owl up here? It asks nothing and takes a few seconds.',
    options: [
      { value: 'init', label: 'Yes — set it up and show me what it finds', hint: 'recommended' },
      { value: 'analyze', label: 'Just look, do not write anything' },
      { value: 'exit', label: 'Not now' },
    ],
  });

  if (prompts.isCancel(choice) || choice === 'exit') cancelled();

  print('');
  if (choice === 'analyze') return checkCommand(options);
  return initCommand(options);
};
