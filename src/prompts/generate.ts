import type { AnalysisContext } from '../core/context.js';
import type { Finding, ReviewResult } from '../core/types.js';
import { withNumbers, type Issue } from '../output/issue.js';
import { countByPriority, PRIORITY_MEANING } from '../output/severity.js';
import { detectCommands, verificationCommand } from '../detect/commands.js';
import { renderIssueBrief } from './brief.js';

/**
 * Turns findings into a brief for an AI coding assistant.
 *
 * Little Owl never calls a model. It writes the prompt, the developer decides
 * what to do with it.
 *
 * Two shapes come out of here. The full brief is the default: it carries file,
 * line, function, related files, expected behaviour, risks and acceptance
 * criteria, because an assistant handed only "reduce the size of orders.ts"
 * will go and rediscover all of that itself, and its version of the answer is
 * a guess where Little Owl's is measured. The compact list is the original
 * behaviour, kept for people piping this into something with a small context.
 *
 * Both stay deliberately short on issues: a wall of findings is exactly how a
 * codebase ends up being rewritten twenty files at a time.
 */

export interface PromptOptions {
  /** Maximum number of issues (or, in compact mode, instructions). */
  maxInstructions?: number;
  /** Restrict the assistant to these paths. */
  scope?: string[];
  /** Include findings that already existed before the change. */
  includeExisting?: boolean;
  /** `full` (default) writes a complete brief; `compact` writes a numbered list. */
  style?: 'full' | 'compact';
  /** Internal: whether the pool is the current change or the whole codebase. */
  aboutTheChange?: boolean;
  /** Enables related files, enclosing functions and the project's own commands. */
  context?: AnalysisContext;
  root?: string;
}

export const generatePrompt = (review: ReviewResult, options: PromptOptions = {}): string => {
  const maxInstructions = options.maxInstructions ?? (options.style === 'compact' ? 6 : 4);

  // Whether the brief is about this change or about debt that predates it. The
  // two need different wording: telling an assistant to "review the current
  // changes" when there are none sends it looking for something that is not
  // there, and it fixes whatever it finds instead.
  const aboutTheChange = !options.includeExisting && review.newFindings.length > 0;
  const pool = aboutTheChange ? review.newFindings : review.current.findings;
  const scope = options.scope ?? review.scope?.patterns ?? [];

  // Numbers come from the whole run, not from this brief, so `little-owl fix 3`
  // means the same problem here as it does in `check`.
  const actionable = withNumbers(pool, review.current.findings).filter(
    (finding) => finding.severity !== 'info',
  );

  if (actionable.length === 0) {
    return nothingToDo(review, scope, aboutTheChange || review.newFindings.length > 0);
  }

  if (options.style === 'compact') {
    return compactBrief(review, actionable, scope, maxInstructions);
  }

  return fullBrief(review, actionable, scope, maxInstructions, {
    ...options,
    aboutTheChange,
  });
};

const nothingToDo = (review: ReviewResult, scope: string[], scoped: boolean): string => {
  const outstanding = review.current.findings.filter((finding) => finding.severity !== 'info');

  // The trap this closes: `check` says "4 important", `prompt` says "nothing to
  // fix", and the reader believes one of them at random. They were looking at
  // different sets — this says which, and how to ask for the other.
  const headline = scoped
    ? 'The most recent change introduced nothing that needs fixing.'
    : 'Little Owl found nothing that needs fixing right now.';

  const lines = [
    '# Little Owl Code',
    '',
    headline,
    '',
    'If you keep working in this codebase, keep the existing structure:',
    '',
    review.current.findings.length === 0
      ? '- there are no outstanding findings'
      : `- ${review.current.findings.length} low-priority findings exist and are being left alone on purpose`,
    '- do not add dependencies for things a few lines of local code would do',
    '- do not edit `.little-owl/baseline.json`',
  ];
  if (scope.length > 0) lines.push(`- do not modify files outside ${scope.join(', ')}`);

  if (scoped && outstanding.length > 0) {
    lines.push(
      '',
      `The project still has ${outstanding.length} open ` +
        `${outstanding.length === 1 ? 'finding' : 'findings'} that predate this change ` +
        '— the same ones `little-owl check` lists. To work on those instead:',
      '',
      '```bash',
      'little-owl prompt --all',
      '```',
    );
  }

  lines.push('', 'When you have finished a change, run `little-owl review`.');
  return lines.join('\n');
};

/**
 * The full brief.
 *
 * Structured as markdown headings because that is what assistants parse most
 * reliably, and because a human pasting it into a chat window still gets
 * something readable.
 */
const fullBrief = (
  review: ReviewResult,
  actionable: Issue[],
  scope: string[],
  max: number,
  options: PromptOptions,
): string => {
  const issues = pickIssues(actionable, max);
  const counts = countByPriority(issues);
  const remaining = actionable.length - issues.length;

  const lines = [
    '# Little Owl Code — fix brief',
    '',
    review.current.project.name ? `Project: **${review.current.project.name}**` : 'Project brief',
    '',
    intro(review, issues.length, remaining, options.aboutTheChange === true),
    '',
    '**Priority key**',
    '',
    ...(['critical', 'important', 'minor'] as const)
      .filter((priority) => counts[priority] > 0)
      .map((priority) => `- \`${priority}\` — ${PRIORITY_MEANING[priority]}`),
    '',
    '---',
    '',
  ];

  for (const issue of issues) {
    lines.push(
      renderIssueBrief(issue, {
        ...(options.context ? { context: options.context } : {}),
        ...(options.root ? { root: options.root } : {}),
        ...(scope.length > 0
          ? { constraints: [`Do not modify files outside ${scope.join(', ')}.`] }
          : {}),
        standalone: false,
      }),
      '---',
      '',
    );
  }

  lines.push(
    '## Order of work',
    '',
    'Fix the issues above one at a time, in the order given. Do not start the second',
    'until the first is verified. If an issue turns out to be a false positive, say so',
    'and move on rather than changing unrelated code to satisfy it.',
    '',
    '## When you are done',
    '',
    '```bash',
    ...doneCommands(review, options),
    '```',
    '',
  );

  if (remaining > 0) {
    lines.push(
      `There are ${remaining} more findings below this priority. Leave them for a later pass.`,
      '',
    );
  }

  return lines.join('\n');
};

const intro = (
  review: ReviewResult,
  shown: number,
  remaining: number,
  aboutTheChange: boolean,
): string => {
  // Read from the pool that was actually used, not from whether a baseline
  // happens to exist. `--all` deliberately widens to pre-existing debt, and the
  // brief used to keep calling it "introduced by the most recent change" —
  // sending the assistant to look for it in a diff that does not contain it.
  const about = aboutTheChange
    ? 'introduced by the most recent change'
    : 'present in this codebase';
  void review;
  const scale =
    remaining > 0
      ? `the ${shown} most important of them`
      : shown === 1
        ? 'the one it found'
        : `all ${shown} of them`;
  return (
    `Little Owl analysed the project and found problems ${about}. What follows is ${scale}, ` +
    'with the file, the line and the expected behaviour already worked out. ' +
    'You do not need to re-investigate any of it.'
  );
};

const doneCommands = (review: ReviewResult, options: PromptOptions): string[] => {
  const commands = ['little-owl verify', 'little-owl review'];
  if (options.root && options.context) {
    const project = verificationCommand(detectCommands(options.root, options.context.project));
    if (project) commands.unshift(project);
  } else {
    void review;
  }
  return commands;
};

/**
 * One issue per distinct problem.
 *
 * Three skipped-layer imports in one file are three findings and one piece of
 * work; without this the brief spends all four of its places on the same file.
 */
const pickIssues = (findings: Issue[], max: number): Issue[] => {
  const picked: Issue[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const key = `${finding.id}:${finding.file ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(finding);
    if (picked.length >= max) break;
  }

  return picked;
};

/** The original short instruction list, kept for small-context consumers. */
const compactBrief = (
  review: ReviewResult,
  actionable: Issue[],
  scope: string[],
  max: number,
): string => {
  const ranked: string[] = [];
  const seen = new Set<string>();

  for (const finding of actionable) {
    const instruction = instructionFor(finding);
    if (seen.has(instruction)) continue;
    seen.add(instruction);
    ranked.push(instruction);
    if (ranked.length >= max) break;
  }

  const instructions = [...ranked];
  if (scope.length > 0) instructions.push(`Do not modify files outside ${scope.join(', ')}.`);
  if (review.newFindings.some((finding) => finding.id === 'dependencies/new-dependency')) {
    instructions.push('Do not add any further dependencies.');
  }
  instructions.push('Preserve the existing behaviour and keep the tests passing.');

  const aboutTheChange = review.newFindings.length > 0;
  return [
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
  ].join('\n');
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
