import type { AnalysisContext } from '../core/context.js';
import type { Finding } from '../core/types.js';
import { resolveGuidance } from '../guidance/guidance.js';
import { relatedFiles } from '../guidance/related.js';
import { PRIORITY_MEANING, priorityOf } from '../output/severity.js';
import { detectCommands, verificationCommand } from '../detect/commands.js';
import { canDismiss, dismissalFor } from '../guidance/dismiss.js';
import type { Issue } from '../output/issue.js';

/**
 * A brief for whoever is going to do the work — usually an AI assistant.
 *
 * The failure mode this exists to prevent: an assistant is handed "fix the
 * circular dependency in orders.ts", spends its first four tool calls
 * rediscovering which files are in the cycle, and then rewrites all of them
 * because it never learned which one was the problem. Little Owl already knows
 * the file, the line, the cycle members, what the code should do instead and
 * how to tell whether it worked. All of that goes in the brief, so the
 * investigation happens once, here, and not again in the model.
 *
 * It is plain markdown on stdout. Little Owl never calls a model.
 */

export interface BriefOptions {
  context?: AnalysisContext;
  root?: string;
  /** Extra rules the assistant must respect, e.g. a scope restriction. */
  constraints?: string[];
  /** Set false for a compact entry inside a multi-issue brief. */
  standalone?: boolean;
}

export const renderIssueBrief = (issue: Issue, options: BriefOptions = {}): string => {
  const guidance = resolveGuidance(issue);
  const priority = priorityOf(issue);
  const lines: string[] = [];

  lines.push(`## Issue #${issue.number}: ${issue.title}`, '');
  lines.push(
    `- **Priority:** ${priority} — ${PRIORITY_MEANING[priority]}`,
    `- **Rule:** \`${issue.id}\``,
  );

  if (issue.file) {
    lines.push(`- **File:** \`${issue.file}${issue.line ? `:${issue.line}` : ''}\``);
    const enclosing = options.context ? enclosingFunction(issue, options.context) : null;
    if (enclosing) lines.push(`- **Function:** \`${enclosing}\``);
  }
  lines.push('');

  lines.push('### Current behaviour', '', guidance.what, '');
  lines.push('### Why it matters', '', guidance.why, '');
  lines.push('### Expected behaviour', '', guidance.expected, '');
  lines.push('### How to fix it', '', guidance.fix, '');

  if (issue.detail && issue.detail.length > 0) {
    lines.push('### Evidence Little Owl collected', '');
    for (const entry of issue.detail.slice(0, 8)) lines.push(`- ${entry}`);
    lines.push('');
  }

  if (options.context) {
    const related = relatedFiles(issue, options.context);
    if (related.length > 0) {
      lines.push('### Related files', '');
      for (const entry of related) lines.push(`- \`${entry.path}\` — ${entry.reason}`);
      lines.push('');
    }
  }

  lines.push('### Risks', '', guidance.risk, '');

  lines.push('### Constraints', '');
  for (const constraint of [...DEFAULT_CONSTRAINTS, ...(options.constraints ?? [])]) {
    lines.push(`- ${constraint}`);
  }
  lines.push('');

  lines.push(...dismissalBrief(issue));

  lines.push('### Acceptance criteria', '');
  for (const criterion of acceptanceCriteria(issue, guidance.expected)) {
    lines.push(`- [ ] ${criterion}`);
  }
  lines.push('');

  if (options.standalone !== false) {
    lines.push('### How to verify', '', '```bash', ...verifyCommands(issue, options), '```', '');
  }

  return lines.join('\n');
};

/**
 * Permission to push back.
 *
 * Without this an assistant handed a false positive has no legal move: the
 * constraints forbid touching the config, so the only thing left is to "fix"
 * code that was already correct. That is how a fixture directory gets
 * refactored and a test suite breaks.
 */
const dismissalBrief = (issue: Issue): string[] => {
  if (!canDismiss(issue)) return [];
  const dismissal = dismissalFor(issue);

  return [
    '### If this finding is wrong',
    '',
    'Little Owl reads structure, not intent. If this code is generated, vendored,',
    'a fixture, or deliberately shaped this way, then the finding is a false positive',
    'and the correct action is **not** to change the code. Say so, explain why, and',
    `propose this instead — in ${dismissal.where}:`,
    '',
    '```ts',
    dismissal.snippet,
    '```',
    '',
    'Do not do both. Either fix the code or dismiss the finding, and say which.',
    '',
  ];
};

const DEFAULT_CONSTRAINTS = [
  'Fix only what this issue names. Do not refactor surrounding code in the same change.',
  'Do not change existing behaviour — this is a structural fix, not a feature change.',
  'Do not add new dependencies.',
  // The old wording forbade touching the config at all, which left an assistant
  // holding a false positive with no legal move except to "fix" correct code.
  // The line to hold is silently, not the config itself.
  'Do not silently weaken `.little-owl/config.ts` or edit `.little-owl/baseline.json` to make a real finding disappear. Dismissing a finding is allowed, but only out loud — see below.',
];

const acceptanceCriteria = (issue: Issue, expected: string): string[] => [
  expected,
  `\`little-owl verify ${issue.number}\` reports the issue as fixed.`,
  'The existing tests still pass, unchanged.',
  'No file outside the ones named above was modified.',
];

const verifyCommands = (issue: Issue, options: BriefOptions): string[] => {
  const commands = [`little-owl verify ${issue.number}`];
  if (options.root && options.context) {
    const project = verificationCommand(detectCommands(options.root, options.context.project));
    if (project) commands.push(project);
  }
  return commands;
};

/** The function a finding's line falls inside, when the parser knows one. */
export const enclosingFunction = (finding: Finding, context: AnalysisContext): string | null => {
  if (!finding.file || !finding.line) return null;
  const file = context.fileMap.get(finding.file);
  if (!file) return null;

  const match = file.functions.find(
    (fn) => finding.line! >= fn.line && finding.line! <= fn.endLine,
  );
  return match ? `${match.name}()` : null;
};
