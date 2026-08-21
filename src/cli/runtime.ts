import path from 'node:path';
import * as prompts from '@clack/prompts';
import { colors } from '../output/theme.js';
import { readVersion } from '../utils/version.js';

export { readVersion };

export interface GlobalOptions {
  cwd?: string;
  color?: boolean;
}

export const resolveRoot = (options: GlobalOptions = {}): string => {
  return path.resolve(options.cwd ?? process.cwd());
};

export const isInteractive = (): boolean => {
  return process.stdout.isTTY === true && process.env['CI'] !== 'true';
};

/**
 * Progress indicator that stays silent when output is being piped or parsed.
 * Nothing that writes to stdout may interfere with `--json`.
 */
export interface Progress {
  start(message: string): void;
  update(message: string): void;
  stop(message?: string): void;
}

export const createProgress = (enabled: boolean): Progress => {
  if (!enabled) {
    return { start: () => {}, update: () => {}, stop: () => {} };
  }

  const spinner = prompts.spinner();
  let running = false;

  return {
    start(message) {
      spinner.start(message);
      running = true;
    },
    update(message) {
      if (running) spinner.message(message);
    },
    stop(message) {
      if (!running) return;
      spinner.stop(message ?? '');
      running = false;
    },
  };
};

export const PROGRESS_LABELS: Record<string, string> = {
  'reading-project': 'Reading project',
  parsing: 'Parsing source files',
  'building-graph': 'Building dependency graph',
  'analyzing-architecture': 'Analyzing architecture',
  'running-rules': 'Checking maintainability',
  done: 'Analysis complete',
};

export const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export const printError = (text: string): void => {
  process.stderr.write(`${colors.red('✗')} ${text}\n`);
};

/**
 * Exits with a message; used for unrecoverable command-level problems.
 *
 * The type annotation on the constant is load-bearing: control-flow analysis
 * only treats a call as unreachable-after when the identifier's type is
 * declared, so without it callers stop narrowing past `fail(...)`.
 */
export const fail: (message: string, code?: number) => never = (message, code = 1) => {
  printError(message);
  process.exit(code);
};

export const cancelled: () => never = () => {
  prompts.cancel('Cancelled.');
  process.exit(0);
};
