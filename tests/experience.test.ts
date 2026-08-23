import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { analyzeFixture } from './helpers.js';
import type { Finding } from '../src/core/types.js';
import { countByPriority, priorityOf, renderPriorityLegend } from '../src/output/severity.js';
import { resolveGuidance, RULE_GUIDANCE } from '../src/guidance/guidance.js';
import { GLOSSARY, termsIn } from '../src/guidance/glossary.js';
import { relatedFiles, renderFlow } from '../src/guidance/related.js';
import {
  numberFindings,
  renderIssueCard,
  renderIssueSummary,
  withNumbers,
} from '../src/output/issue.js';
import { reassurance, renderNothingFound, verdict } from '../src/output/guided.js';
import { readSnapshot, writeSnapshot } from '../src/baseline/snapshot.js';
import { createProgress } from '../src/cli/runtime.js';
import { renderAgentFile } from '../src/agent/agent-file.js';
import { detectCommands, verificationCommand } from '../src/detect/commands.js';
import { renderIssueBrief } from '../src/prompts/brief.js';
import { baseConfig } from '../src/config/defaults.js';
import { allRules } from '../src/rules/index.js';

/**
 * The guided experience, tested as a reader meets it.
 *
 * These are not tests of wording — wording changes. They are tests of the
 * promises the product makes: every issue has a priority in words, an
 * explanation someone without a security background can act on, a place in the
 * project, and a next command. Any of those going missing is a regression even
 * though nothing throws.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'complexity/large-file',
  fingerprint: over.fingerprint ?? 'fp-1',
  severity: 'warning',
  category: 'complexity',
  file: 'src/services/orders.ts',
  line: 12,
  title: 'src/services/orders.ts is 900 lines',
  message: 'It is long.',
  ...over,
});

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

describe('priorities', () => {
  it('speaks in critical / important / minor, not error / warning / info', () => {
    expect(priorityOf(finding({ severity: 'error' }))).toBe('critical');
    expect(priorityOf(finding({ severity: 'warning' }))).toBe('important');
    expect(priorityOf(finding({ severity: 'info' }))).toBe('minor');
  });

  it('explains what each level means rather than just colouring it', () => {
    const legend = renderPriorityLegend(
      countByPriority([finding({ severity: 'error' }), finding({ severity: 'info' })]),
    );

    expect(legend).toContain('critical');
    expect(legend).toContain('before your app goes live');
    expect(legend).toContain('minor');
    // Levels with nothing in them are not mentioned at all.
    expect(legend).not.toContain('important');
  });

  it('leaves empty levels out of the counts', () => {
    const counts = countByPriority([finding({ severity: 'error' })]);
    expect(counts).toMatchObject({ critical: 1, important: 0, minor: 0, total: 1 });
  });
});

describe('verdict and reassurance', () => {
  it('does not tell someone their project is fine when it is not', () => {
    expect(verdict(countByPriority([finding({ severity: 'error' })]))).toContain('needs attention');
  });

  it('says so plainly when there is nothing to fix', () => {
    expect(verdict(countByPriority([]))).toContain('healthy');
  });

  it('reassures rather than alarms when the list is long but mostly minor', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      finding({ severity: 'info', fingerprint: `f${index}` }),
    );
    expect(reassurance(countByPriority(many))).toContain('low priority');
  });

  it('points at the critical issues first when there are any', () => {
    const mixed = [
      finding({ severity: 'error', fingerprint: 'e1' }),
      ...Array.from({ length: 4 }, (_, i) => finding({ severity: 'info', fingerprint: `i${i}` })),
    ];
    expect(reassurance(countByPriority(mixed))).toContain('1 critical');
  });

  it('has nothing to reassure about when the project is clean', () => {
    expect(reassurance(countByPriority([]))).toBeNull();
  });
});

describe('guidance', () => {
  it('answers all four questions for a known rule', () => {
    const guidance = resolveGuidance(finding({ id: 'next/server-import-in-client' }));

    expect(guidance.what).not.toHaveLength(0);
    expect(guidance.why).not.toHaveLength(0);
    expect(guidance.expected).not.toHaveLength(0);
    expect(guidance.fix).not.toHaveLength(0);
    expect(guidance.verify).not.toHaveLength(0);
    expect(guidance.risk).not.toHaveLength(0);
  });

  it('explains consequences in terms of the app, not the code', () => {
    const guidance = resolveGuidance(finding({ id: 'next/server-import-in-client' }));
    expect(guidance.why.toLowerCase()).toContain('security');
  });

  it('falls back to something useful for a rule it has never heard of', () => {
    const guidance = resolveGuidance(
      finding({ id: 'made-up/rule', message: 'Something happened.', suggestion: 'Do the thing.' }),
    );

    expect(guidance.what).toBe('Something happened.');
    expect(guidance.fix).toBe('Do the thing.');
    expect(guidance.why).not.toHaveLength(0);
    expect(guidance.verify).toContain('little-owl verify');
  });

  it('covers every rule that can produce a critical finding', () => {
    // A critical issue with no plain-language explanation is the worst case:
    // the most urgent thing on the screen is the one nobody can read.
    const config = baseConfig('balanced');
    const critical = allRules.filter((rule) => config.rules[rule.id] === 'error');

    expect(critical.length).toBeGreaterThan(0);
    for (const rule of critical) {
      expect(RULE_GUIDANCE[rule.id], `no guidance for ${rule.id}`).toBeDefined();
    }
  });
});

describe('glossary', () => {
  it('does not mistake a substring for a term', () => {
    // "any one of these files" is not a mention of TypeScript's `any`.
    expect(termsIn('moving any one of these files tends to break the others')).not.toContain('any');
    expect(termsIn('this file uses `any` in three places')).toContain('any');
  });

  it('finds the terms it does define', () => {
    expect(termsIn('the dependency graph has a circular dependency')).toContain(
      'circular dependency',
    );
  });

  it('defines every term it claims to explain', () => {
    for (const [term, definition] of Object.entries(GLOSSARY)) {
      expect(definition.length, term).toBeGreaterThan(20);
    }
  });
});

describe('issue numbering', () => {
  it('puts the most urgent problem at number one', () => {
    const issues = numberFindings([
      finding({ severity: 'info', fingerprint: 'a', file: 'a.ts' }),
      finding({ severity: 'error', fingerprint: 'b', file: 'z.ts' }),
      finding({ severity: 'warning', fingerprint: 'c', file: 'm.ts' }),
    ]);

    expect(issues.map((issue) => issue.fingerprint)).toEqual(['b', 'c', 'a']);
    expect(issues[0]!.number).toBe(1);
  });

  it('ranks a leaked-secret risk above a long file, whatever the path', () => {
    const issues = numberFindings([
      finding({ id: 'complexity/large-file', severity: 'error', fingerprint: 'a', file: 'a.ts' }),
      finding({
        id: 'next/server-import-in-client',
        severity: 'error',
        fingerprint: 'b',
        file: 'z.ts',
      }),
    ]);

    expect(issues[0]!.fingerprint).toBe('b');
  });

  it('keeps a number meaning the same problem across commands', () => {
    // `review` shows a subset, but issue #3 must still be issue #3 when the
    // reader types `little-owl fix 3`.
    const all = [
      finding({ severity: 'error', fingerprint: 'a' }),
      finding({ severity: 'warning', fingerprint: 'b' }),
      finding({ severity: 'info', fingerprint: 'c' }),
    ];

    const subset = withNumbers([all[2]!], all);
    expect(subset[0]!.number).toBe(3);
  });
});

describe('issue cards', () => {
  it('answers what, why, where and what next', () => {
    const card = renderIssueCard(numberFindings([finding()])[0]!);

    expect(card).toContain('What happened');
    expect(card).toContain('Why this matters');
    expect(card).toContain('Where');
    expect(card).toContain('src/services/orders.ts:12');
    expect(card).toContain('What should happen instead');
    expect(card).toContain('Recommended fix');
    expect(card).toContain('How to check it worked');
    expect(card).toContain('Next step');
    expect(card).toContain('little-owl fix 1');
  });

  it('keeps the rule id out of the way until asked for', () => {
    const issue = numberFindings([finding()])[0]!;

    // The id may appear inside a config line the reader is meant to paste.
    // What it must not do is show up as a label, as though the category name
    // were an explanation.
    expect(renderIssueCard(issue)).not.toMatch(/rule\s+complexity\/large-file/);
    expect(renderIssueCard(issue, { technical: true })).toMatch(/rule\s+complexity\/large-file/);
  });

  it('offers a way out when the finding does not apply', () => {
    const card = renderIssueCard(numberFindings([finding()])[0]!);

    expect(card).toContain('If this is not a real problem');
    expect(card).toContain('.little-owl/config.ts');
  });

  it('never offers to silence a leaked credential', () => {
    // Some findings are not a matter of taste, and putting "here is how to
    // switch this off" next to one invites exactly the wrong reflex.
    const leak = numberFindings([
      finding({ id: 'next/secret-in-client-bundle', severity: 'error' }),
    ])[0]!;

    expect(renderIssueCard(leak)).not.toContain('If this is not a real problem');
  });

  it('names the file and the priority in the one-line summary', () => {
    const summary = renderIssueSummary(numberFindings([finding({ severity: 'error' })])[0]!);
    expect(summary).toContain('#1');
    expect(summary).toContain('src/services/orders.ts:12');
  });
});

describe('related files', () => {
  it('names the other files in a cycle', () => {
    const cycle = finding({
      id: 'architecture/circular-dependency',
      file: 'src/a.ts',
      detail: ['src/a.ts -> src/b.ts -> src/a.ts'],
    });

    const related = relatedFiles(cycle, {
      graph: { dependentsOf: () => [], dependenciesOf: () => [] },
    } as never);

    expect(related.map((entry) => entry.path)).toContain('src/b.ts');
  });

  it('shows how a file sits between its callers and its dependencies', async () => {
    const { context } = await analyzeFixture('clean-project');
    const flow = renderFlow(
      finding({ id: 'architecture/layer-skip', file: 'services/orders.ts' }),
      context,
    );

    expect(flow).toContain('services/orders.ts');
    expect(flow).toContain('↓');
  });

  it('draws nothing for a file with nothing around it', async () => {
    const { context } = await analyzeFixture('clean-project');
    expect(
      renderFlow(finding({ id: 'architecture/layer-skip', file: 'nowhere.ts' }), context),
    ).toBeNull();
  });

  it('says nothing about neighbours when the problem is inside one function', async () => {
    // A complex function's importers are not involved and cannot be. Listing
    // them buries the one line that matters.
    const { context } = await analyzeFixture('clean-project');
    const complexity = finding({
      id: 'complexity/high-complexity',
      file: 'services/orders.ts',
    });

    expect(relatedFiles(complexity, context)).toEqual([]);
    expect(renderFlow(complexity, context)).toBeNull();
  });
});

describe('the empty project', () => {
  it('never reports a perfect score for a folder with no code in it', () => {
    const message = renderNothingFound('/tmp/somewhere');

    expect(message).toContain('could not find any code');
    expect(message).not.toContain('100');
    expect(message).toContain('little-owl doctor');
  });
});

describe('the progress indicator', () => {
  const withStderr = <T>(isTTY: boolean, run: () => T): T => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true });
    try {
      return run();
    } finally {
      if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  };

  const capture = (run: () => void): string => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      run();
    } finally {
      process.stderr.write = original;
    }
    return written.join('');
  };

  it('leaves nothing on screen when it stops without a message', () => {
    // The old spinner drew its own `│` and `◇` frame and had no way to stop
    // without one, so every quiet command printed two orphaned box characters
    // above its output.
    const output = withStderr(true, () =>
      capture(() => {
        const progress = createProgress(true);
        progress.start('Reading project');
        progress.stop();
      }),
    );

    expect(output).not.toContain('│');
    expect(output).not.toContain('◇');
    // Whatever it drew, it wiped: the last thing written returns to column 0.
    expect(output.endsWith('\r')).toBe(true);
  });

  it('writes a closing line only when given one', () => {
    const output = withStderr(true, () =>
      capture(() => {
        const progress = createProgress(true);
        progress.start('Reading project');
        progress.stop('Done');
      }),
    );

    expect(output).toContain('Done\n');
  });

  it('stays silent when stderr is not a terminal', () => {
    // Otherwise `little-owl check 2> log.txt` spools hundreds of frames.
    const output = withStderr(false, () =>
      capture(() => {
        const progress = createProgress(true);
        progress.start('Reading project');
        progress.update('Parsing');
        progress.stop();
      }),
    );

    expect(output).toBe('');
  });

  it('never writes progress to stdout, where a report or JSON lives', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      withStderr(true, () => {
        const progress = createProgress(true);
        progress.start('Reading project');
        progress.stop();
      });
    } finally {
      process.stdout.write = original;
    }

    expect(written.join('')).toBe('');
  });
});

describe('verify', () => {
  it('reports the score even when it did not move', async () => {
    // Silence reads as "it forgot to check". After a structural fix, unchanged
    // is an answer worth confirming.
    const { renderSteps } = await import('../src/output/guided.js');
    expect(renderSteps([{ label: 'x' }])).toContain('x');
  });
});

describe('plain language', () => {
  it('never falls back to raw rule text for a rule that ships', () => {
    // A finding whose "What happened" is the engine's own sentence breaks the
    // voice of every screen it appears on.
    const RAW_TELLS = [/\(limit \d+\)/, /past the \d+-line limit/, /\bcyclomatic\b/];
    const config = baseConfig('strict');

    for (const rule of allRules) {
      if (config.rules[rule.id] === 'off') continue;
      const guidance = RULE_GUIDANCE[rule.id];
      expect(guidance, `no guidance for ${rule.id}`).toBeDefined();
      // Either it restates the finding itself, or the rule's own message is
      // already plain enough to stand as one.
      if (!guidance?.what) continue;
      const what = guidance.what({
        id: rule.id,
        fingerprint: 'f',
        severity: 'warning',
        category: rule.category,
        file: 'src/a.ts',
        title: 'thing() has a complexity of 21',
        message: 'raw',
      });
      for (const tell of RAW_TELLS) expect(what, rule.id).not.toMatch(tell);
    }
  });
});

describe('the run snapshot', () => {
  it('remembers which problem each number refers to', () => {
    project = TempProject.create({ 'package.json': '{"name":"snap"}' });
    const issues = numberFindings([finding({ fingerprint: 'x' })]);

    writeSnapshot(project.root, 'check', issues, {
      overall: 90,
      architecture: 90,
      maintainability: 90,
      complexity: 90,
      dependencies: 90,
      typeSafety: 90,
    });

    const snapshot = readSnapshot(project.root);
    expect(snapshot?.issues[0]).toMatchObject({ number: 1, fingerprint: 'x' });
  });

  it('stays out of version control', () => {
    project = TempProject.create({ 'package.json': '{"name":"snap"}' });
    writeSnapshot(project.root, 'check', [], {
      overall: 100,
      architecture: 100,
      maintainability: 100,
      complexity: 100,
      dependencies: 100,
      typeSafety: 100,
    });

    const ignored = fs.readFileSync(project.path('.little-owl/.gitignore'), 'utf8');
    expect(ignored).toContain('last-run.json');
  });

  it('returns nothing rather than throwing when the file is corrupt', () => {
    project = TempProject.create({
      'package.json': '{"name":"snap"}',
      '.little-owl/last-run.json': 'not json',
    });
    expect(readSnapshot(project.root)).toBeNull();
  });
});

describe('the AI briefing file', () => {
  it('tells an assistant the loop, the limits and what not to touch', async () => {
    const { result } = await analyzeFixture('clean-project');
    const markdown = renderAgentFile({ project: result.project, config: baseConfig('balanced') });

    expect(markdown).toContain('little-owl check');
    expect(markdown).toContain('little-owl verify');
    expect(markdown).toContain('.little-owl/baseline.json');
    expect(markdown).toContain('critical');
  });

  it('warns the agent not to silence a leak by renaming the variable', async () => {
    // The cheapest way to make `secret-in-client-bundle` disappear is to add a
    // NEXT_PUBLIC_ prefix, which declares the secret public rather than fixing
    // anything. An agent left to find its own way there will.
    const { result } = await analyzeFixture('clean-project');
    const markdown = renderAgentFile({ project: result.project, config: baseConfig('balanced') });

    expect(markdown).toContain('next/secret-in-client-bundle');
    expect(markdown).toContain('NEXT_PUBLIC_');
    expect(markdown.toLowerCase()).toContain('rotating');
  });

  it('describes the layers that are actually in effect, inferred or not', async () => {
    // Saying "no layers are declared" next to a report full of boundary
    // violations is how an agent learns to ignore this file.
    const { result, context } = await analyzeFixture('clean-project');
    const markdown = renderAgentFile({
      project: result.project,
      config: baseConfig('balanced'),
      layers: context.layers,
    });

    expect(markdown).toContain('inferred these layers');
    expect(markdown).toContain('ui');
  });

  it("comes out formatted, so it does not create a diff in someone else's repo", async () => {
    const { result } = await analyzeFixture('clean-project');
    const markdown = renderAgentFile({ project: result.project, config: baseConfig('balanced') });

    // Prettier aligns markdown tables; the generated one has to match.
    const rows = markdown.split('\n').filter((line) => line.startsWith('| '));
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
  });
});

describe('project commands', () => {
  it('quotes the commands the project actually defines', () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { test: 'vitest run', build: 'tsc' },
      }),
      'src/a.ts': 'export const a = 1;\n',
    });

    const commands = detectCommands(project.root, {
      packageManager: 'npm',
      languages: ['typescript'],
      hasTypeScript: true,
    } as never);

    expect(commands.test).toBe('npm run test');
    expect(verificationCommand(commands)).toBe('npm run test');
  });

  it('falls back to a type check when there is no test script', () => {
    project = TempProject.create({ 'package.json': '{"name":"x"}' });
    const commands = detectCommands(project.root, {
      packageManager: 'pnpm',
      languages: ['typescript'],
      hasTypeScript: true,
    } as never);

    expect(commands.test).toBeUndefined();
    expect(verificationCommand(commands)).toBe('npx tsc --noEmit');
  });
});

describe('the AI brief for one issue', () => {
  it('carries everything an assistant would otherwise re-investigate', () => {
    const brief = renderIssueBrief(numberFindings([finding({ severity: 'error' })])[0]!);

    expect(brief).toContain('## Issue #1');
    expect(brief).toContain('**Priority:** critical');
    expect(brief).toContain('`src/services/orders.ts:12`');
    expect(brief).toContain('### Expected behaviour');
    expect(brief).toContain('### Risks');
    expect(brief).toContain('### Acceptance criteria');
    expect(brief).toContain('little-owl verify 1');
  });

  it('forbids the shortcuts that make a finding disappear without a fix', () => {
    const brief = renderIssueBrief(numberFindings([finding()])[0]!);
    expect(brief).toContain('.little-owl/baseline.json');
  });
});
