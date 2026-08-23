import type { Finding } from '../core/types.js';

/**
 * How to tell Little Owl it is wrong.
 *
 * Every static analyser is wrong sometimes, and the reader is the only one who
 * can tell. Without a stated way to say so, the choices are: follow advice you
 * know is bad, or conclude the tool is unreliable and stop reading it. Both are
 * worse than a false positive.
 *
 * This is deliberately not a `--ignore` flag that writes config on the reader's
 * behalf. Turning a rule off is a decision the project should be able to see in
 * a diff and argue about, so what Little Owl offers is the exact line to paste,
 * scoped as narrowly as the finding allows.
 */

export interface Dismissal {
  /** One line: what this would stop reporting. */
  effect: string;
  /** The config edit, ready to paste. */
  snippet: string;
  /** Where to paste it. */
  where: string;
}

/** Rules whose finding is a budget being exceeded, not a mistake. */
const THRESHOLD_RULES: Record<string, string> = {
  'complexity/large-file': 'maxFileLines',
  'complexity/large-function': 'maxFunctionLines',
  'complexity/large-component': 'maxComponentLines',
  'complexity/high-complexity': 'maxComplexity',
  'complexity/deep-nesting': 'maxNesting',
  'complexity/too-many-params': 'maxParams',
  'architecture/deep-import-chain': 'maxImportDepth',
  'maintainability/duplicate-block': 'minDuplicateLines',
};

/**
 * Directory names that suggest the file is not the application.
 *
 * Only these get a path exclusion offered. Telling someone to exclude
 * `src/core/**` because one function there is complex is worse advice than the
 * finding it replaces — it would blind the tool to a quarter of their app to
 * silence one warning.
 */
const NOT_APPLICATION =
  /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|testdata|generated|vendor|third[-_]party|examples?|scaffold|templates?)(\/|$)/i;

/**
 * The narrowest honest way to say "not here".
 *
 * Three shapes, chosen by why the reader is likely to disagree:
 *
 * - The code is not theirs to fix — a fixture, generated output, a vendored
 *   copy. Exclude the path.
 * - The finding is a budget they do not share. Move the budget, which keeps the
 *   rule working everywhere else.
 * - They disagree with the rule itself. Turn it off, and see it in the diff.
 */
export const dismissalFor = (finding: Finding): Dismissal => {
  if (finding.file && NOT_APPLICATION.test(finding.file)) {
    const area = enclosingArea(finding.file);
    return {
      effect: `stop analysing everything under ${area}`,
      snippet: `ignore: ['${area}/**'],`,
      where: '.little-owl/config.ts',
    };
  }

  const threshold = THRESHOLD_RULES[finding.id];
  if (threshold && typeof finding.baseline === 'number') {
    return {
      effect: `raise the limit this project holds itself to (currently ${finding.baseline})`,
      snippet: `thresholds: {\n  ${threshold}: ${suggestLimit(finding)},\n},`,
      where: '.little-owl/config.ts',
    };
  }

  return {
    effect: `stop reporting ${finding.id} anywhere in this project`,
    snippet: `rules: {\n  '${finding.id}': 'off',\n},`,
    where: '.little-owl/config.ts',
  };
};

/**
 * The smallest limit that clears this finding.
 *
 * Deliberately exact rather than rounded up to a comfortable number. Suggesting
 * `maxComplexity: 30` to clear a function at 21 does not dismiss one finding,
 * it hides the next nine — and it does it invisibly. The exact value makes the
 * trade obvious: this is the limit your worst function sets.
 */
const suggestLimit = (finding: Finding): number => {
  const actual = typeof finding.current === 'number' ? finding.current : 0;
  const limit = typeof finding.baseline === 'number' ? finding.baseline : 0;
  return Math.max(actual, limit + 1);
};

/**
 * The directory worth excluding, rather than the file itself.
 *
 * A false positive of this kind is never about one file — it is about a folder
 * whose whole contents are the wrong kind of code. The match is anchored on the
 * segment that triggered it, so `tests/fixtures` is excluded and `tests` is not.
 */
const enclosingArea = (file: string): string => {
  const parts = file.split('/');
  const trigger = parts.findIndex((part) => NOT_APPLICATION.test(part));
  if (trigger >= 0) return parts.slice(0, trigger + 1).join('/');
  return parts.length <= 1 ? file : parts.slice(0, parts.length - 1).join('/');
};

/**
 * Whether a finding is worth offering a dismissal for at all.
 *
 * A leaked credential is not a matter of taste. Offering "here is how to
 * silence this" next to it invites exactly the wrong reflex, so the escape
 * hatch is held back for findings where reasonable projects disagree.
 */
const NEVER_DISMISSABLE = new Set([
  'next/secret-in-client-bundle',
  'next/server-module-in-client-bundle',
  'next/server-import-in-client',
]);

export const canDismiss = (finding: Finding): boolean => !NEVER_DISMISSABLE.has(finding.id);
