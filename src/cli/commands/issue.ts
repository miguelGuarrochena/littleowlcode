import { analyzeProject } from '../../core/analyze.js';
import { detectCommands } from '../../detect/commands.js';
import { printJson } from '../../output/json.js';
import { colors, dim, icons } from '../../output/theme.js';
import { divider, owlHeader, renderNextStep } from '../../output/guided.js';
import { PRIORITY_ICON, priorityOf } from '../../output/severity.js';
import { issueLocation, numberFindings, renderIssueCard, type Issue } from '../../output/issue.js';
import { renderIssueBrief } from '../../prompts/brief.js';
import { readSnapshot, snapshotIssue } from '../../baseline/snapshot.js';
import { relatedFiles } from '../../guidance/related.js';
import { resolveGuidance } from '../../guidance/guidance.js';
import { canDismiss, dismissalFor } from '../../guidance/dismiss.js';
import { unknownIssue } from '../errors.js';
import { loadProjectConfig, print, resolveRoot, type GlobalOptions } from '../runtime.js';
import { wrap } from '../../output/ui.js';
import type { AnalysisContext } from '../../core/context.js';

/**
 * `explain <n>` and `fix <n>` — the two commands that open one numbered issue.
 *
 * They share a shape on purpose: read the last run to find out which problem
 * the number refers to, re-analyse so the answer describes the code as it is
 * now rather than as it was, and end on the next command. With `check` and
 * `verify` they are the whole loop — see it, understand it, fix it, confirm it
 * — and that loop only holds together if the number means the same thing in
 * all four.
 */

export interface IssueOptions extends GlobalOptions {
  json?: boolean;
  cache?: boolean;
  /** Show the rule id, raw message and evidence lines. */
  technical?: boolean;
}

interface Resolved {
  root: string;
  context: AnalysisContext;
  issues: Issue[];
}

const analyse = async (options: IssueOptions): Promise<Resolved> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const { result, context } = await analyzeProject({
    root,
    config,
    ...(options.cache === false ? { cache: false as const } : {}),
  });
  return { root, context, issues: numberFindings(result.findings) };
};

/**
 * Which problem a number refers to.
 *
 * The number comes from the last run and the finding comes from a fresh one,
 * because the code may have changed in between — which is the whole point of
 * `verify`. Matching on the fingerprint rather than the position means a number
 * keeps pointing at the same problem even after other issues around it are
 * fixed.
 */
const resolveIssue = (
  root: string,
  issues: Issue[],
  number: number,
): { issue: Issue | null; wasKnown: boolean } => {
  const snapshot = readSnapshot(root);
  if (!snapshot) {
    const direct = issues.find((issue) => issue.number === number);
    if (!direct) throw unknownIssue(number, issues.length);
    return { issue: direct, wasKnown: true };
  }

  const recorded = snapshotIssue(snapshot, number);
  if (!recorded) throw unknownIssue(number, snapshot.issues.length);

  const current = issues.find((issue) => issue.fingerprint === recorded.fingerprint) ?? null;
  return { issue: current ? { ...current, number } : null, wasKnown: true };
};

const alreadyFixed = (number: number): void => {
  print('');
  print(
    `${icons.owl} ${colors.green(`Issue #${number} is already fixed — it no longer appears.`)}`,
  );
  print('');
  print(renderNextStep({ command: 'little-owl check', note: 'see what is left' }));
  print('');
};

/** `little-owl explain <n>` — the whole story of one issue. */
/**
 * The three things a reader can do with a finding.
 *
 * The third one is not decoration. Without a stated way to say "you are wrong
 * about this", the only moves left are to follow advice you know is bad or to
 * stop trusting the tool — and one of those breaks a test suite.
 */
const printWaysForward = (issue: Issue, fix: string): void => {
  print(
    dim(
      canDismiss(issue)
        ? 'Little Owl never edits your code. Three ways forward:'
        : 'Little Owl never edits your code. Two ways to apply this:',
    ),
  );
  print('');
  print(`  ${colors.bold('1.')} Give the brief below to your AI assistant`);
  print(dim(`     little-owl fix ${issue.number} --brief | pbcopy`));
  print('');
  print(`  ${colors.bold('2.')} Do it yourself`);
  for (const line of wrap(fix, 67)) print(dim(`     ${line}`));
  print('');

  if (!canDismiss(issue)) return;

  const dismissal = dismissalFor(issue);
  print(`  ${colors.bold('3.')} Tell Little Owl it is wrong`);
  for (const line of wrap(`This would ${dismissal.effect}. In ${dismissal.where}:`, 67)) {
    print(dim(`     ${line}`));
  }
  for (const line of dismissal.snippet.split('\n')) print(dim(`       ${line}`));
  print('');
};

export const explainIssueCommand = async (
  number: number,
  options: IssueOptions,
): Promise<number> => {
  const { root, context, issues } = await analyse(options);
  const { issue } = resolveIssue(root, issues, number);

  if (!issue) {
    if (options.json) {
      printJson({ number, fixed: true });
      return 0;
    }
    alreadyFixed(number);
    return 0;
  }

  if (options.json) {
    printJson({
      ...issue,
      priority: priorityOf(issue),
      guidance: resolveGuidance(issue),
      related: relatedFiles(issue, context),
    });
    return 0;
  }

  print('');
  print(
    renderIssueCard(issue, {
      context,
      technical: options.technical ?? false,
      nextStep: `little-owl fix ${issue.number}`,
    }),
  );
  print('');
  return 0;
};

export interface FixOptions extends IssueOptions {
  /** Print only the brief, ready to pipe or copy. */
  briefOnly?: boolean;
}

/**
 * `little-owl fix <n>` — everything needed to fix one issue.
 *
 * Little Owl does not edit source files, and this command does not change that:
 * a tool that silently rewrites code it only partly understands is exactly the
 * problem this product exists to catch. What it does instead is remove every
 * reason the fix would be hard — which files are involved, what the code should
 * do instead, what could go wrong, and a brief precise enough that an assistant
 * can act on it without re-investigating anything.
 */
export const fixCommand = async (number: number, options: FixOptions): Promise<number> => {
  const { root, context, issues } = await analyse(options);
  const { issue } = resolveIssue(root, issues, number);

  if (!issue) {
    alreadyFixed(number);
    return 0;
  }

  const guidance = resolveGuidance(issue);
  const brief = renderIssueBrief(issue, { context, root });

  if (options.briefOnly) {
    print(brief);
    return 0;
  }

  if (options.json) {
    printJson({ number: issue.number, title: issue.title, guidance, brief });
    return 0;
  }

  const priority = priorityOf(issue);
  const related = relatedFiles(issue, context);
  const commands = detectCommands(root, context.project);

  print(owlHeader());
  print(
    `${colors.bold('Fixing')} ${PRIORITY_ICON[priority]} ${colors.bold(`#${issue.number}`)}  ${issue.title}`,
  );
  print('');
  print(colors.bold('FILES INVOLVED'));
  print('');
  print(
    `  ${colors.green(icons.ok)} ${colors.bold(issueLocation(issue))}   ${dim('the change goes here')}`,
  );
  for (const entry of related.slice(0, 3)) {
    print(`  ${dim('·')} ${entry.path}   ${dim(`may need updating — ${entry.reason}`)}`);
  }
  print('');
  print(colors.bold('GOAL'));
  print('');
  for (const line of wrap(guidance.expected, 70)) print(`  ${line}`);
  print('');
  print(divider());
  print('');
  printWaysForward(issue, guidance.fix);
  print(divider());
  print('');
  print(colors.bold('BRIEF FOR YOUR AI ASSISTANT'));
  print('');
  print(brief);
  print(divider());
  print('');
  print(
    renderNextStep(
      { command: `little-owl verify ${issue.number}`, note: 'once the change is made' },
      commands.test ? [{ command: commands.test, note: "this project's tests" }] : [],
    ),
  );
  print('');
  return 0;
};
