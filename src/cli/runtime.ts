import path from 'node:path';
import * as prompts from '@clack/prompts';
import { colors } from '../output/theme.js';
import { loadConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/schema.js';
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

/** Frames for the spinner. Braille dots animate smoothly at any width. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

/**
 * A progress line that leaves nothing behind.
 *
 * This used to be `@clack/prompts`'s spinner, which draws its own frame — a
 * leading `│` and a closing `◇` — and has no way to stop without one. Every
 * command that finished quietly therefore printed two orphaned box characters
 * above its output, which read as a rendering bug in the first three lines a
 * new user ever sees.
 *
 * Writing to stderr rather than stdout is the other half: progress is not part
 * of the report, and nothing that decorates a terminal should be able to reach
 * a pipe carrying JSON.
 */
export const createProgress = (enabled: boolean): Progress => {
  // The animation is drawn on stderr, so stderr is what has to be a terminal.
  // Gating on stdout instead would spool a few hundred spinner frames into the
  // file behind `little-owl check 2> log.txt`.
  if (!enabled || process.stderr.isTTY !== true) {
    return { start: () => {}, update: () => {}, stop: () => {} };
  }

  let timer: NodeJS.Timeout | null = null;
  let text = '';
  let frame = 0;
  let width = 0;

  const draw = (): void => {
    const line = `${FRAMES[frame % FRAMES.length]} ${text}`;
    frame += 1;
    width = Math.max(width, line.length);
    process.stderr.write(`\r${line.padEnd(width)}`);
  };

  const erase = (): void => {
    if (width > 0) process.stderr.write(`\r${' '.repeat(width)}\r`);
    width = 0;
  };

  return {
    start(message) {
      if (timer) return;
      text = message;
      draw();
      timer = setInterval(draw, FRAME_MS);
      // Never hold the process open just to keep an animation running.
      timer.unref?.();
    },
    update(message) {
      text = message;
    },
    stop(message) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      erase();
      if (message) process.stderr.write(`${message}\n`);
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
 * Loads configuration and reports anything wrong with it.
 *
 * Every command goes through here rather than calling `loadConfig` directly, so
 * a misspelled key cannot stay quiet just because the command that hit it was
 * not the one that prints warnings.
 *
 * Warnings go to stderr: `--json` consumers must keep getting clean stdout.
 */
export const loadProjectConfig = async (root: string): Promise<ResolvedConfig> => {
  const config = await loadConfig(root);
  printConfigWarnings(config);
  return config;
};

export const printConfigWarnings = (config: ResolvedConfig): void => {
  if (config.warnings.length === 0) return;
  const where = config.sourcePath ? path.relative(process.cwd(), config.sourcePath) : 'config';
  process.stderr.write(`${colors.yellow('⚠')} ${where}\n`);
  for (const warning of config.warnings) {
    process.stderr.write(`  ${warning}\n`);
  }
  process.stderr.write('\n');
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
