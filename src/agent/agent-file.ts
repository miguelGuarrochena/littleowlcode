import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/schema.js';
import type { LayerModel } from '../architecture/layers.js';
import type { ProjectInfo } from '../core/types.js';
import { describeStack } from '../detect/project.js';

/**
 * `LITTLE_OWL.md` — the briefing an AI assistant reads before it touches this
 * project.
 *
 * Claude Code, Cursor and the rest all pick up markdown left in the repository
 * root. What they do *not* pick up is the reason a rule exists, or the fact
 * that `.little-owl/baseline.json` is a record rather than a config file they
 * should tidy. This file is that missing half, and it stays short on purpose:
 * an agent that has to read three pages before writing a line of code will
 * skim, and the important parts are the ones it skips.
 */

export const AGENT_FILE = 'LITTLE_OWL.md';

export const agentFilePath = (root: string): string => path.join(root, AGENT_FILE);

export interface AgentFileInput {
  project: ProjectInfo;
  config: ResolvedConfig;
  /**
   * The layers actually in effect. Pass this whenever it is available: an
   * inferred layer model still produces findings, and a briefing that says
   * "no layers are declared" next to a report full of boundary violations
   * teaches the agent to distrust the file.
   */
  layers?: LayerModel;
}

/** The layers section, which is the only part that varies with the project. */
const architectureSection = (config: ResolvedConfig, model?: LayerModel): string => {
  const declared = Object.entries(config.architecture.layers).filter(([, dirs]) => dirs.length > 0);
  const inferred = model?.inferred === true && model.order.length > 0;
  const entries = declared.length > 0 ? declared : inferred ? layerRows(model) : [];

  if (entries.length === 0) {
    return [
      'No layers are declared yet, so boundary checks are inactive. Run `little-owl init`',
      'to detect them, or add `architecture.layers` to `.little-owl/config.ts`.',
    ].join('\n');
  }

  return [
    inferred
      ? 'Little Owl inferred these layers from the folder names — they are not declared anywhere,'
      : 'This project is organised in layers, listed top to bottom. Code may depend on the',
    inferred
      ? 'so correct them in `.little-owl/config.ts` if they are wrong. Code may depend on the'
      : 'layer below it, never on the layer above it.',
    ...(inferred ? ['layer below it, never on the layer above it.'] : []),
    '',
    '```',
    ...entries.map(([layer, dirs]) => `${layer.padEnd(16)}${dirs.join(', ')}`),
    '```',
    '',
    '- Do not import upwards. If a lower layer needs a value from a higher one, pass it in.',
    '- Do not skip a layer. Going straight from a screen to the database bypasses whatever',
    '  checks live in between.',
  ].join('\n');
};

const layerRows = (model: LayerModel): Array<[string, string[]]> =>
  model.order.map((layer) => [layer, model.dirsByLayer[layer] ?? []]);

/**
 * The size limits, as an aligned markdown table.
 *
 * Aligned because this file lands in someone else's repository, and a repo with
 * Prettier in its pre-commit hook should not get a diff on a file it did not
 * write.
 */
const limitsTable = (config: ResolvedConfig): string => {
  const rows: Array<[string, string]> = [
    ['File length', `${config.thresholds.maxFileLines} lines`],
    ['Function length', `${config.thresholds.maxFunctionLines} lines`],
    ['Component length', `${config.thresholds.maxComponentLines} lines`],
    ['Branches per function', String(config.thresholds.maxComplexity)],
  ];

  const left = Math.max(5, ...rows.map(([label]) => label.length));
  const right = Math.max(5, ...rows.map(([, value]) => value.length));
  const line = (a: string, b: string): string => `| ${a.padEnd(left)} | ${b.padEnd(right)} |`;

  return [
    line('Limit', 'Value'),
    `| ${'-'.repeat(left)} | ${'-'.repeat(right)} |`,
    ...rows.map(([label, value]) => line(label, value)),
  ].join('\n');
};

/** The half of the file that is the same in every project. */
const HOUSE_RULES = `## The two findings to stop for

\`next/secret-in-client-bundle\` and \`next/server-module-in-client-bundle\` mean a browser component
can reach a secret, or server-only code, through a chain of imports. Fix these before anything else.

Two things to get right when you do:

1. **Route the data access through a server component, a route handler or a Server Action.** A
   \`"use server"\` module is called over the network, not bundled — that is the correct fix, and
   Little Owl will recognise it as one.
2. **Say out loud that the credential needs rotating.** If the page was ever deployed, the value is
   already public and changing the code does not un-publish it. That part is not yours to do, but it
   is yours to flag.

Never "fix" one of these by renaming the variable to \`NEXT_PUBLIC_*\`. That silences the rule by
declaring the secret public, which is the opposite of the fix.

## How to read a finding

Every issue has a priority, and they are not equal:

- 🔴 **critical** — fix before this goes live.
- 🟠 **important** — fix soon.
- 🟡 **minor** — improve when convenient.

Fix critical issues first. Do not fix everything at once: a run with forty findings is a
backlog, not a task.

## Rules for changing this project

1. **Fix the issue that was reported, not the file it lives in.** Little Owl points at a
   specific line for a reason. Rewriting the surrounding code makes the change impossible
   to review.
2. **Do not change behaviour while restructuring.** Splitting a large file and fixing a bug
   are two separate commits.
3. **Run the tests before and after.** If the project has no tests, say so rather than
   assuming the change was safe.
4. **Do not add dependencies** to solve something a few lines of local code would solve.
5. **Never edit \`.little-owl/baseline.json\`.** It is a record of an agreed state. Making
   findings disappear by editing it hides the problem instead of fixing it. Only
   \`little-owl baseline\` should write to it.
6. **\`.little-owl/config.ts\` is the project's agreement**, not a switch to flip when a rule
   is inconvenient. Turning a rule off is a decision to state out loud, with a reason.

## Verifying a change

\`\`\`bash
little-owl verify        # the issues you set out to fix should be gone
little-owl review        # and nothing new should have appeared
\`\`\`

Add \`--tests\` to \`verify\` to run this project's own test command as part of the check.

<!-- Generated by little-owl init. Safe to edit; re-running init --force will overwrite it. -->
`;

export const renderAgentFile = ({ project, config, layers }: AgentFileInput): string => {
  return `# Little Owl

This project is watched by [Little Owl Code](https://littleowlcode.com) — a local, read-only
tool that checks what changes do to the structure of the codebase. It never edits source
files and never calls a model.

**If you are an AI assistant working in this repository, read this before making changes.**

## Project

- Stack: ${describeStack(project)}
- Package manager: ${project.packageManager ?? 'unknown'}
- Strictness: \`${config.strictness}\`

## The loop

Run these after you finish a piece of work, not before you start:

\`\`\`bash
little-owl check      # what is wrong right now, in priority order
little-owl explain 1  # the full story of issue #1
little-owl fix 1      # a precise brief for fixing issue #1
little-owl verify     # did the fix actually land?
little-owl prompt     # every open issue as one task list
\`\`\`

\`little-owl prompt\` is the one to reach for first: it writes the findings out with file,
line, expected behaviour and acceptance criteria already filled in, so you do not have to
re-investigate anything.

## Architecture rules

${architectureSection(config, layers)}

## Limits this project agreed to

${limitsTable(config)}

Going past a limit is not forbidden, it is a signal to split something up.

${HOUSE_RULES}`;
};

export interface WriteAgentFileResult {
  path: string;
  written: boolean;
  reason?: 'exists';
}

/**
 * Writes `LITTLE_OWL.md`, refusing to clobber a version someone has edited
 * unless asked. The file is meant to be committed and adjusted per project.
 */
export const writeAgentFile = (
  root: string,
  input: AgentFileInput,
  options: { force?: boolean } = {},
): WriteAgentFileResult => {
  const file = agentFilePath(root);
  if (fs.existsSync(file) && !options.force) {
    return { path: file, written: false, reason: 'exists' };
  }
  fs.writeFileSync(file, renderAgentFile(input));
  return { path: file, written: true };
};
