import type { AnalysisContext } from '../core/context.js';
import { rankFindings } from '../core/priority.js';
import type { Finding } from '../core/types.js';
import { resolveGuidance } from '../guidance/guidance.js';
import { relatedFiles, renderFlow } from '../guidance/related.js';
import { GLOSSARY } from '../guidance/glossary.js';
import { canDismiss, dismissalFor } from '../guidance/dismiss.js';
import { colors, dim, icons } from './theme.js';
import { PRIORITY_ICON, priorityColor, priorityLabel, priorityOf } from './severity.js';
import { padEnd, rule, wrap } from './ui.js';

/**
 * A finding with a number on it.
 *
 * Numbers are what make the rest of the product possible to talk about:
 * "run `little-owl fix 1`" is an instruction, "look at the circular dependency
 * one" is a scavenger hunt. They are assigned once per run, in priority order,
 * and written to `.little-owl/last-run.json` so the follow-up commands resolve
 * the same number to the same problem.
 */
export interface Issue extends Finding {
  number: number;
}

export const numberFindings = (findings: Finding[]): Issue[] =>
  rankFindings(findings).map((finding, index) => ({ ...finding, number: index + 1 }));

/**
 * Numbers for a subset, taken from the numbering of the whole run.
 *
 * `review` shows only what a change introduced, but issue #4 has to still be
 * issue #4 when the reader runs `little-owl fix 4` — otherwise every command
 * has its own private numbering and none of them can be quoted to another.
 */
export const withNumbers = (subset: Finding[], all: Finding[]): Issue[] => {
  const numbers = new Map(
    numberFindings(all).map((issue) => [issue.fingerprint, issue.number] as const),
  );
  let overflow = numbers.size;
  return rankFindings(subset).map((finding) => ({
    ...finding,
    number: numbers.get(finding.fingerprint) ?? ++overflow,
  }));
};

const BODY_WIDTH = 72;

const paragraph = (text: string, indent = '  '): string[] =>
  wrap(text, BODY_WIDTH).map((line) => indent + line);

const section = (title: string, body: string[]): string[] => [colors.bold(title), ...body, ''];

export const issueLocation = (finding: Finding): string => {
  if (!finding.file) return 'across the project';
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
};

/**
 * One line per issue, for the list in `check` and `review`.
 *
 * Deliberately three lines and not seven: the list exists to let someone pick
 * which problem to open, and a list where every entry is a full explanation is
 * a list nobody reads to the end of.
 */
export const renderIssueSummary = (issue: Issue): string => {
  const priority = priorityOf(issue);
  const paint = priorityColor(priority);
  const number = paint(padEnd(`#${issue.number}`, 4));
  // Continuation lines sit under the title, not under the number, so the eye
  // can run down the left edge of the list and read only the headlines.
  const gutter = ' '.repeat(7);
  const lines = [
    `${PRIORITY_ICON[priority]} ${number} ${colors.bold(issue.title)}`,
    dim(`${gutter}${issueLocation(issue)}`),
  ];

  const { what } = resolveGuidance(issue);
  lines.push(...wrap(what, BODY_WIDTH - 7).map((line) => `${gutter}${line}`));
  return lines.join('\n');
};

export interface IssueCardOptions {
  /** Adds related files and a flow diagram when the graph is available. */
  context?: AnalysisContext;
  /** Shows the rule id, raw message and detail lines under the plain-language ones. */
  technical?: boolean;
  /** The command to suggest at the bottom. Omit for no next step. */
  nextStep?: string | null;
}

/**
 * The full explanation of one issue.
 *
 * The order is fixed and it is the order the questions arrive in: what
 * happened, why should I care, where is it, what else is involved, what should
 * it look like, how do I fix it, how do I know it worked. Technical detail sits
 * at the bottom behind a flag, because the person who needs it will look and
 * the person who does not should not have to scroll past it.
 */
export const renderIssueCard = (issue: Issue, options: IssueCardOptions = {}): string => {
  const priority = priorityOf(issue);
  const paint = priorityColor(priority);
  const guidance = resolveGuidance(issue);

  const lines: string[] = [
    `${PRIORITY_ICON[priority]} ${paint(colors.bold(priorityLabel(priority)))}  ${dim(`issue #${issue.number}`)}`,
    '',
    colors.bold(issue.title),
    '',
    ...section('What happened', paragraph(guidance.what)),
    ...section('Why this matters', paragraph(guidance.why)),
    ...section('Where', [`  ${colors.cyan(issueLocation(issue))}`]),
  ];

  if (options.context) {
    const related = relatedFiles(issue, options.context);
    if (related.length > 0) {
      lines.push(
        ...section(
          'Related files',
          related.map((entry) => `  ${entry.path}  ${dim(`— ${entry.reason}`)}`),
        ),
      );
    }

    const flow = renderFlow(issue, options.context);
    if (flow) {
      lines.push(
        ...section(
          'How it connects',
          flow.split('\n').map((line) => `  ${line}`),
        ),
      );
    }
  }

  lines.push(
    ...section('What should happen instead', paragraph(guidance.expected)),
    ...section('Recommended fix', paragraph(guidance.fix)),
    ...section('How to check it worked', paragraph(guidance.verify)),
  );

  lines.push(...dismissalSection(issue));
  lines.push(...glossarySection(guidance.terms));
  lines.push(...technicalSection(issue, options.technical ?? false));

  if (options.nextStep !== null) {
    lines.push(
      colors.bold('Next step'),
      `  ${colors.cyan(icons.arrow)} ${colors.bold(options.nextStep ?? `little-owl fix ${issue.number}`)}`,
    );
  }

  return lines.join('\n');
};

/** The escape hatch: how to tell Little Owl this one does not apply. */
const dismissalSection = (issue: Issue): string[] => {
  if (!canDismiss(issue)) return [];
  const dismissal = dismissalFor(issue);

  return section('If this is not a real problem', [
    ...paragraph(
      `Little Owl can be wrong. To ${dismissal.effect}, add this to ${dismissal.where}:`,
    ),
    '',
    ...dismissal.snippet.split('\n').map((line) => dim(`    ${line}`)),
  ]);
};

const glossarySection = (terms: string[]): string[] => {
  const known = terms.filter((term) => GLOSSARY[term]);
  if (known.length === 0) return [];
  return section(
    'In plain words',
    known.flatMap((term) => paragraph(`${term}: ${GLOSSARY[term]}`)),
  );
};

const technicalSection = (issue: Issue, show: boolean): string[] => {
  if (!show) {
    return [dim(`  Technical detail: little-owl explain ${issue.number} --technical`), ''];
  }

  return section(
    'Technical detail',
    [
      `  rule       ${issue.id}`,
      `  severity   ${issue.severity}`,
      `  category   ${issue.category}`,
      ...(issue.detail?.length ? ['', ...issue.detail.map((entry) => `  ${entry}`)] : []),
    ].map((line) => dim(line)),
  );
};

export const issueSeparator = (): string => rule(BODY_WIDTH);
