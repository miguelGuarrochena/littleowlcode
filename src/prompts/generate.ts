import type { Finding, ReviewResult } from '../core/types.js';

/**
 * Turns findings into a short instruction list for an AI coding assistant.
 *
 * Little Owl never calls a model. It writes the prompt, the developer decides
 * what to do with it. The prompt is deliberately small: a wall of findings is
 * exactly how a codebase ends up being rewritten twenty files at a time.
 */

export interface PromptOptions {
  /** Maximum number of numbered instructions. */
  maxInstructions?: number;
  /** Restrict the assistant to these paths. */
  scope?: string[];
  /** Include findings that already existed before the change. */
  includeExisting?: boolean;
}

export const generatePrompt = (review: ReviewResult, options: PromptOptions = {}): string => {
  const maxInstructions = options.maxInstructions ?? 6;

  // Whether the brief is about this change or about debt that predates it. The
  // two need different wording: telling an assistant to "review the current
  // changes" when there are none sends it looking for something that is not
  // there, and it fixes whatever it finds instead.
  const aboutTheChange = !options.includeExisting && review.newFindings.length > 0;
  const pool = aboutTheChange ? review.newFindings : review.current.findings;

  // Several findings can produce the same sentence — three skipped-layer
  // imports in one file are three findings and one instruction. Deduplicating
  // before the cap means the brief spends its places on distinct problems.
  const ranked: string[] = [];
  const seen = new Set<string>();

  for (const finding of byImportance(pool)) {
    if (finding.severity === 'info') continue;
    const instruction = instructionFor(finding);
    if (seen.has(instruction)) continue;
    seen.add(instruction);
    ranked.push(instruction);
    if (ranked.length >= maxInstructions) break;
  }

  const instructions = [...ranked];
  const scope = options.scope ?? review.scope?.patterns ?? [];

  if (scope.length > 0) {
    instructions.push(`Do not modify files outside ${scope.join(', ')}.`);
  }
  if (review.newFindings.some((finding) => finding.id === 'dependencies/new-dependency')) {
    instructions.push('Do not add any further dependencies.');
  }
  instructions.push('Preserve the existing behaviour and keep the tests passing.');

  if (ranked.length === 0 && scope.length === 0) {
    return [
      'Little Owl Code found nothing that needs fixing in the current changes.',
      '',
      'If you continue working on this codebase, keep the existing structure:',
      review.current.findings.length === 0
        ? '- no outstanding findings'
        : `- ${review.current.findings.length} pre-existing findings are being ignored on purpose`,
    ].join('\n');
  }

  const lines = [
    aboutTheChange
      ? 'Review the current changes using these constraints:'
      : 'These are pre-existing findings in this codebase, not the result of a recent change.\n' +
        'Address them without rewriting anything they do not name:',
    '',
    ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
    '',
    'After making changes, run:',
    '',
    '   little-owl review',
  ];

  return lines.join('\n');
};

/**
 * How much each rule tends to matter, lowest first.
 *
 * The report sorts findings for reading — severity, then category, then path —
 * which puts whatever is alphabetically first at the top of the brief. An
 * assistant given six instructions acts on all six, so a throwaway script in
 * `a...` would get refactored while a 4,000-line service goes untouched.
 */
const RULE_PRIORITY: Record<string, number> = {
  'architecture/circular-dependency': 0,
  'scope/out-of-scope-change': 1,
  'architecture/layer-violation': 1,
  'next/server-import-in-client': 1,
  'architecture/layer-skip': 2,
  'architecture/cross-feature-import': 2,
  'patterns/parallel-implementations': 3,
  'patterns/duplicate-helper': 3,
  'complexity/large-file': 4,
  'complexity/large-component': 4,
  'type-safety/suppression': 5,
  'type-safety/explicit-any': 5,
  'complexity/large-function': 6,
  'complexity/high-complexity': 6,
};

const DEFAULT_PRIORITY = 7;
const SEVERITY_RANK: Record<Finding['severity'], number> = { error: 0, warning: 1, info: 2 };

const byImportance = (findings: Finding[]): Finding[] =>
  [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;

    const byRule =
      (RULE_PRIORITY[a.id] ?? DEFAULT_PRIORITY) - (RULE_PRIORITY[b.id] ?? DEFAULT_PRIORITY);
    if (byRule !== 0) return byRule;

    // Worst offender first: five times over the limit before barely over it.
    const byOvershoot = overshoot(b) - overshoot(a);
    if (byOvershoot !== 0) return byOvershoot;

    return (a.file ?? '') < (b.file ?? '') ? -1 : 1;
  });

/**
 * How far past its limit a finding is, as a multiple. Rules that carry a
 * `baseline` limit and a `current` measurement can be compared this way; the
 * rest all tie at 1 and fall through to the path.
 */
const overshoot = (finding: Finding): number => {
  const limit = typeof finding.baseline === 'number' ? finding.baseline : 0;
  const actual = typeof finding.current === 'number' ? finding.current : 0;
  return limit > 0 && actual > 0 ? actual / limit : 1;
};

/** Rule-specific phrasing, falling back to the finding's own suggestion. */
const instructionFor = (finding: Finding): string => {
  const where = finding.file ? ` in ${finding.file}` : '';

  switch (finding.id) {
    case 'architecture/circular-dependency':
      return `Remove the circular dependency: ${finding.detail?.[0] ?? finding.file}.`;
    case 'architecture/layer-violation':
    case 'architecture/layer-skip':
      return `Restore the layering${where}: ${finding.detail?.[1]?.replace('expected: ', '') ?? finding.title}.`;
    case 'architecture/cross-feature-import':
      return `${finding.title}${where}. Go through the feature's public entry point instead.`;
    case 'next/server-import-in-client':
      return `Stop the client component${where} from importing server-only code.`;
    // A file-level finding already names the file in its title, so repeating
    // `where` produced "reduce the size of x.ts in x.ts".
    case 'complexity/large-file':
      return `Reduce the size of ${finding.title.replace(/ is .*/, '')}, without changing behaviour.`;
    case 'complexity/large-component':
    case 'complexity/large-function':
      return `Reduce the size of ${finding.title.replace(/ is .*/, '')}${where}, without changing behaviour.`;
    case 'complexity/high-complexity':
      return `Simplify the branching in ${finding.title.replace(/ has .*/, '')}${where}.`;
    case 'type-safety/explicit-any':
      return `Replace the \`any\` types${where} with real types.`;
    case 'type-safety/suppression':
      return `Fix the type error hidden by @ts-ignore${where} instead of suppressing it.`;
    case 'maintainability/duplicate-block':
      return `Remove the duplicated block repeated across ${finding.detail?.length ?? 2} places, starting${where}.`;
    case 'scope/out-of-scope-change':
      return finding.message;
    default:
      return finding.suggestion ?? `${finding.title}${where}.`;
  }
};
