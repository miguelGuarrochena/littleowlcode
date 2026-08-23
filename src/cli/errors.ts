import { colors, dim, icons } from '../output/theme.js';

/**
 * Errors written for the person who hit them.
 *
 * A stack trace, or `Error: ENOENT`, tells someone who already knows this
 * codebase exactly what went wrong. It tells everybody else that the tool
 * broke and they should probably stop using it. Every failure that can be
 * anticipated therefore answers the same three things the rest of the product
 * answers: what happened, why, and which command to run next.
 */

export interface OwlErrorInput {
  /** One sentence, no jargon: what did not happen. */
  what: string;
  /** Optional: why it happened, if that is not obvious from the first line. */
  why?: string;
  /** Commands to try, most likely first. */
  next?: string[];
  /** The original failure, kept for `LITTLE_OWL_DEBUG`. */
  cause?: unknown;
}

export class OwlError extends Error {
  readonly what: string;
  readonly why: string | undefined;
  readonly next: string[];

  constructor(input: OwlErrorInput) {
    super(input.what);
    this.name = 'OwlError';
    this.what = input.what;
    this.why = input.why;
    this.next = input.next ?? [];
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

/** Recognisable low-level failures, turned into something actionable. */
const RECOGNISED: Array<{ match: RegExp; build: (message: string) => OwlError }> = [
  {
    match: /ENOENT/,
    build: (message) =>
      new OwlError({
        what: 'Little Owl could not find a file or folder it needed.',
        why: message,
        next: ['little-owl doctor'],
      }),
  },
  {
    match: /EACCES|EPERM/,
    build: (message) =>
      new OwlError({
        what: 'Little Owl was not allowed to read part of this project.',
        why: message,
        next: ['little-owl check --no-cache'],
      }),
  },
  {
    match: /not a git repository/i,
    build: () =>
      new OwlError({
        what: 'This folder is not a git repository, so there are no changes to compare.',
        why: 'Reviewing a change means comparing it against what was there before, and that history lives in git.',
        next: ['little-owl check'],
      }),
  },
  {
    match: /is not installed in this project|could not be resolved from this project/,
    build: (message) =>
      new OwlError({
        what: 'Little Owl could not load your configuration file.',
        why: message,
        next: ['little-owl init --force'],
      }),
  },
  {
    match: /Could not parse .* as JSON|did not export an object|Could not load .*config/,
    build: (message) =>
      new OwlError({
        what: 'Your Little Owl configuration file could not be read.',
        why: message,
        next: ['little-owl init --force'],
      }),
  },
];

export const asOwlError = (error: unknown): OwlError => {
  if (error instanceof OwlError) return error;

  const message = error instanceof Error ? error.message : String(error);
  for (const candidate of RECOGNISED) {
    if (candidate.match.test(message)) return candidate.build(message);
  }

  return new OwlError({
    what: 'Little Owl hit a problem it did not expect.',
    why: message,
    next: ['little-owl doctor'],
    cause: error,
  });
};

export const renderOwlError = (error: OwlError): string => {
  const lines = [`${icons.owl} ${colors.red(error.what)}`];

  if (error.why) {
    lines.push('', ...error.why.split('\n').map((line) => dim(`   ${line.trim()}`)));
  }
  if (error.next.length > 0) {
    lines.push('', 'Try:', '');
    for (const command of error.next) lines.push(`   ${colors.bold(command)}`);
  }

  return `${lines.join('\n')}\n`;
};

/** Convenience builders for the failures commands raise on purpose. */
export const notInitialised = (): OwlError =>
  new OwlError({
    what: 'Little Owl has not been set up in this project yet.',
    why: 'Setting up takes one command and no questions — it looks at your project and writes its own configuration.',
    next: ['little-owl init'],
  });

export const noRunYet = (): OwlError =>
  new OwlError({
    what: 'Little Owl has not looked at this project yet, so there are no numbered issues to work from.',
    next: ['little-owl check'],
  });

export const unknownIssue = (number: number, available: number): OwlError =>
  new OwlError({
    what: `There is no issue #${number} in the last run.`,
    why:
      available > 0
        ? `The last run found ${available} issue${available === 1 ? '' : 's'}, numbered 1 to ${available}.`
        : 'The last run found nothing to fix.',
    next: ['little-owl check'],
  });

export const fileNotAnalysed = (file: string): OwlError =>
  new OwlError({
    what: `Little Owl has not analysed ${file}.`,
    why: 'Either the path is wrong, or the file is excluded by the `include` / `ignore` settings in your configuration.',
    next: ['little-owl map', 'little-owl doctor'],
  });
