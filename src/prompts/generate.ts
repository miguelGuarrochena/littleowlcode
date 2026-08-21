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
  const pool = options.includeExisting
    ? review.current.findings
    : review.newFindings.length > 0
      ? review.newFindings
      : review.current.findings;

  // Several findings can produce the same sentence — three skipped-layer
  // imports in one file are three findings and one instruction. Deduplicating
  // before the cap means the brief spends its places on distinct problems.
  const ranked: string[] = [];
  const seen = new Set<string>();

  for (const finding of pool) {
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
    'Review the current changes using these constraints:',
    '',
    ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
    '',
    'After making changes, run:',
    '',
    '   little-owl review',
  ];

  return lines.join('\n');
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
    case 'complexity/large-component':
    case 'complexity/large-function':
    case 'complexity/large-file':
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
