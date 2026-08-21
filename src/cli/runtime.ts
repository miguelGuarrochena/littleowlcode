import path from 'node:path';
import * as prompts from '@clack/prompts';
import { colors } from '../output/theme.js';
import { readVersion } from '../utils/version.js';

export { readVersion };

export interface GlobalOptions {
  cwd?: string;
  color?: boolean;
}

export function resolveRoot(options: GlobalOptions = {}): string {
  return path.resolve(options.cwd ?? process.cwd());
}

export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.env['CI'] !== 'true';
}

/**
 * Progress indicator that stays silent when output is being piped or parsed.
 * Nothing that writes to stdout may interfere with `--json`.
 */
export interface Progress {
  start(message: string): void;
  update(message: string): void;
  stop(message?: string): void;
}

export function createProgress(enabled: boolean): Progress {
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
}

export const PROGRESS_LABELS: Record<string, string> = {
  'reading-project': 'Reading project',
  parsing: 'Parsing source files',
  'building-graph': 'Building dependency graph',
  'analyzing-architecture': 'Analyzing architecture',
  'running-rules': 'Checking maintainability',
  done: 'Analysis complete',
};

export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function printError(text: string): void {
  process.stderr.write(`${colors.red('✗')} ${text}\n`);
}

/** Exits with a message; used for unrecoverable command-level problems. */
export function fail(message: string, code = 1): never {
  printError(message);
  process.exit(code);
}

export function cancelled(): never {
  prompts.cancel('Cancelled.');
  process.exit(0);
}
