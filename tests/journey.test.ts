import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';

/**
 * The journey, walked the way someone new walks it.
 *
 * Each test is one state the CLI can leave a person in, and each asserts the
 * same thing in the end: is there a next command on the screen? A report with
 * no way forward is the failure mode this whole layer exists to prevent, and it
 * is invisible to every other kind of test — nothing throws, nothing is wrong,
 * the reader is just stuck.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');

let project: TempProject | null = null;

beforeAll(() => {
  if (!fs.existsSync(cli)) {
    execFileSync('npx', ['tsup'], { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

afterEach(() => {
  project?.cleanup();
  project = null;
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Both streams, for assertions that do not care which one carried it. */
  output: string;
}

const run = (args: string[], cwd: string): RunResult => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', CI: 'true' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
};

/** Every guided screen ends on something the reader can type. */
const offersANextStep = (result: RunResult): void => {
  expect(result.output, 'no next command on screen').toMatch(/little-owl [a-z]/);
};

const CLEAN_PROJECT = {
  'package.json': JSON.stringify({ name: 'my-app', scripts: { test: 'vitest run' } }),
  'src/app/page.ts': "import { list } from '../services/orders';\nexport const page = list;\n",
  'src/services/orders.ts':
    "import { query } from '../lib/db/client';\nexport const list = () => query();\n",
  'src/lib/db/client.ts': 'export const query = () => [];\n',
};

/** A project with a real, critical problem: two files needing each other. */
const BROKEN_PROJECT = {
  ...CLEAN_PROJECT,
  'src/lib/db/client.ts':
    "import { page } from '../../app/page';\nexport const query = () => [page];\n",
};

/**
 * A library whose test suite holds deliberately broken sample projects — the
 * shape that ruined the first dogfooding run.
 */
const LIBRARY_WITH_FIXTURES = {
  'package.json': JSON.stringify({ name: 'my-lib', scripts: { test: 'vitest run' } }),
  'src/index.ts': "export { helper } from './helper';\n",
  'src/helper.ts': 'export const helper = () => 1;\n',
  'tests/fixtures/bad-architecture/a.ts': "import { b } from './b';\nexport const a = b;\n",
  'tests/fixtures/bad-architecture/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'examples/demo.ts': 'export const demo: any = {} as any;\n',
};

describe('the first run on a project with sample code in it', () => {
  it('does not report deliberately broken fixtures as critical problems', () => {
    project = TempProject.create(LIBRARY_WITH_FIXTURES);
    const result = run(['check'], project.root);

    expect(result.stdout).not.toContain('critical');
    expect(result.stdout).not.toContain('tests/fixtures');
    expect(result.stdout).not.toContain('examples/demo.ts');
  });

  it('says out loud what it skipped, and how to disagree', () => {
    project = TempProject.create(LIBRARY_WITH_FIXTURES);
    const result = run(['init'], project.root);

    expect(result.stdout).toContain('ANALYSING');
    expect(result.stdout).toContain('SKIPPED');
    expect(result.stdout).toContain('tests/fixtures');
    expect(result.stdout).toContain('.little-owl/config.ts');
  });

  it('reports the stack the project actually is', () => {
    project = TempProject.create({
      ...LIBRARY_WITH_FIXTURES,
      'tests/fixtures/py/app.py': 'def f():\n    pass\n',
    });

    expect(run(['check'], project.root).stdout).not.toContain('Python');
  });

  it('warns in doctor when sample code really is being analysed', () => {
    project = TempProject.create({
      ...LIBRARY_WITH_FIXTURES,
      '.little-owl/config.ts': "export default { ignore: ['!**/fixtures/**'] };\n",
    });

    const result = run(['doctor'], project.root);
    expect(result.stdout).toContain('Scope');
    expect(result.stdout).toContain('looks like sample code');
    // Doctor must not green-light a project it is misreading.
    expect(result.stdout).not.toContain('Everything Little Owl needs is in place');
  });

  it('does not invent an architecture from one directory name', () => {
    project = TempProject.create({
      'package.json': '{"name":"x"}',
      'src/core/a.ts': 'export const a = 1;\n',
    });
    run(['init'], project.root);

    const config = fs.readFileSync(project.path('.little-owl/config.ts'), 'utf8');
    expect(config).toContain('No layered structure was detected');
    expect(config).not.toContain('domain: ["core"]');
  });

  it('agrees with itself about how many layers there are', () => {
    project = TempProject.create({
      'package.json': '{"name":"x"}',
      'src/core/a.ts': 'export const a = 1;\n',
    });

    // `check` used to say "1 layer: domain" while `doctor` said "no layers".
    expect(run(['check'], project.root).stdout).toContain('no layers to check');
    expect(run(['doctor'], project.root).stdout).toContain('no layers detected');
  });
});

describe('state 1 — a project Little Owl has never seen', () => {
  it('sets itself up without asking a single question', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['init'], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('my-app');
    expect(fs.existsSync(project.path('.little-owl/config.ts'))).toBe(true);
    expect(fs.existsSync(project.path('.little-owl/baseline.json'))).toBe(true);
    expect(fs.existsSync(project.path('LITTLE_OWL.md'))).toBe(true);
    expect(result.stdout).toContain('NEXT STEP');
    expect(result.stdout).toContain('little-owl check');
  });

  it('says what it will watch for, in words, before it writes anything', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['init'], project.root);

    expect(result.stdout).toContain('Little Owl will watch for');
    // No jargon in the promises: no rule ids, no "cyclomatic".
    expect(result.stdout).not.toContain('cyclomatic');
    expect(result.stdout).not.toMatch(/architecture\/[a-z-]+/);
  });

  it('can skip the assistant briefing when asked', () => {
    project = TempProject.create(CLEAN_PROJECT);
    run(['init', '--no-agent-file'], project.root);
    expect(fs.existsSync(project.path('LITTLE_OWL.md'))).toBe(false);
  });
});

describe('state 2 — a project with nothing wrong', () => {
  it('says so plainly and still gives a next step', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['check'], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/healthy|good shape/);
    offersANextStep(result);
  });

  it('sends an unconfigured project to setup, not into a low-priority note', () => {
    // A fresh project always has notes. Opening one of them is the wrong first
    // move when Little Owl has not even been set up here yet.
    project = TempProject.create({
      'package.json': '{"name":"fresh"}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const result = run(['check'], project.root);

    expect(result.stdout).toContain('→ little-owl init');
    expect(result.stdout).not.toContain('→ little-owl explain');
  });

  it('does not offer a prompt when there is nothing worth prompting about', () => {
    project = TempProject.create({
      'package.json': '{"name":"fresh"}',
      'src/a.ts': 'export const a = 1;\n',
    });
    expect(run(['check'], project.root).stdout).not.toContain('little-owl prompt');
  });

  it('counts in the singular when there is one of something', () => {
    project = TempProject.create({
      'package.json': '{"name":"fresh"}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const { stdout } = run(['check'], project.root);

    expect(stdout).toContain('1 file');
    expect(stdout).not.toMatch(/\b1 files\b/);
  });
});

describe('state 3 — a project with a critical problem', () => {
  it('leads with the verdict, the priority and where to start', () => {
    project = TempProject.create(BROKEN_PROJECT);
    const result = run(['check'], project.root);

    expect(result.stdout).toContain('needs attention');
    expect(result.stdout).toContain('critical');
    expect(result.stdout).toContain('Fix before your app goes live');
    expect(result.stdout).toContain('WHERE TO START');
    expect(result.stdout).toContain('#1');
    expect(result.stdout).toContain('little-owl explain 1');
  });

  it('explains issue #1 without requiring a security background', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    const result = run(['explain', '1'], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('What happened');
    expect(result.stdout).toContain('Why this matters');
    expect(result.stdout).toContain('Where');
    expect(result.stdout).toContain('Recommended fix');
    expect(result.stdout).toContain('little-owl fix 1');
    // The rule id stays behind the flag as a label.
    expect(result.stdout).not.toMatch(/rule\s+architecture\/circular-dependency/);
    expect(run(['explain', '1', '--technical'], project.root).stdout).toMatch(
      /rule\s+architecture\/circular-dependency/,
    );
  });

  it('accepts the number with or without a hash', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    expect(run(['explain', '#1'], project.root).status).toBe(0);
  });

  it('offers a way to say the finding is wrong', () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/big.ts': `${Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
      '.little-owl/config.ts': 'export default { thresholds: { maxFileLines: 10 } };\n',
    });
    run(['check'], project.root);

    const explained = run(['explain', '1'], project.root);
    expect(explained.stdout).toContain('If this is not a real problem');
    expect(explained.stdout).toContain('.little-owl/config.ts');

    const fixed = run(['fix', '1'], project.root);
    expect(fixed.stdout).toContain('Tell Little Owl it is wrong');
  });

  it('lets the AI brief dismiss a false positive instead of breaking correct code', () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/big.ts': `${Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
      '.little-owl/config.ts': 'export default { thresholds: { maxFileLines: 10 } };\n',
    });
    run(['check'], project.root);

    const { stdout } = run(['fix', '1', '--brief'], project.root);
    expect(stdout).toContain('If this finding is wrong');
    expect(stdout).toContain('false positive');
    expect(stdout).toContain('Do not do both');
  });

  it('hands over a fix plan that names the files and never edits them', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);

    const before = fs.readFileSync(project.path('src/lib/db/client.ts'), 'utf8');
    const result = run(['fix', '1'], project.root);

    expect(result.stdout).toContain('FILES INVOLVED');
    expect(result.stdout).toContain('GOAL');
    expect(result.stdout).toContain('never edits your code');
    expect(result.stdout).toContain('little-owl verify 1');
    expect(fs.readFileSync(project.path('src/lib/db/client.ts'), 'utf8')).toBe(before);
  });

  it('can print just the brief, for piping into an assistant', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    const result = run(['fix', '1', '--brief'], project.root);

    expect(result.stdout.trimStart().startsWith('## Issue #1')).toBe(true);
    expect(result.stdout).toContain('### Acceptance criteria');
    expect(result.stdout).not.toContain('FILES INVOLVED');
  });

  it('defaults to the most important issue when no number is given', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    expect(run(['fix'], project.root).stdout).toContain('#1');
  });
});

describe('the leak a diff cannot show', () => {
  /**
   * The shape this takes in a real AI-assisted project: a component asks for a
   * helper, the helper reaches the database module, the database module reads a
   * key. Nothing in any single file looks wrong.
   */
  const LEAKY = {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '14.0.0' } }),
    'lib/db.ts': 'const url = process.env.DATABASE_URL!;\nexport const query = () => [url];\n',
    'lib/orders.ts': "import { query } from './db';\nexport const list = () => query();\n",
    'components/Orders.tsx':
      "'use client';\nimport { list } from '../lib/orders';\nexport function Orders() { return <div>{String(list())}</div>; }\n",
  };

  it('leads with it, and shows the route the secret takes', () => {
    project = TempProject.create(LEAKY);
    const result = run(['check'], project.root);

    expect(result.stdout).toContain('critical');
    expect(result.stdout).toContain('#1');
    expect(result.stdout).toMatch(/secret can reach the browser/i);
    expect(result.stdout).toContain('components/Orders.tsx');
  });

  it('explains it without assuming any security background', () => {
    project = TempProject.create(LEAKY);
    run(['check'], project.root);
    const { stdout } = run(['explain', '1'], project.root);

    expect(stdout).toContain('Why this matters');
    expect(stdout).toMatch(/visitor can read/i);
    // The chain is the answer, so it belongs above the fold, not behind a flag.
    expect(stdout).toContain('lib/orders.ts');
    expect(stdout).toContain('lib/db.ts');
    expect(stdout).toContain('little-owl fix 1');
  });

  it('tells the assistant to rotate the key, not just delete the import', () => {
    project = TempProject.create(LEAKY);
    run(['check'], project.root);
    const { stdout } = run(['fix', '1', '--brief'], project.root);

    expect(stdout).toContain('### Risks');
    expect(stdout.toLowerCase()).toContain('rotate');
    expect(stdout).toContain('lib/db.ts');
  });

  it('fails CI, because this is the kind of thing that must not ship', () => {
    project = TempProject.create(LEAKY);
    project.initGit();

    const result = run(['ci'], project.root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('result: fail');
  });

  it('confirms the fix once the boundary is closed', () => {
    project = TempProject.create(LEAKY);
    run(['check'], project.root);

    // The correct fix: the client calls a server action instead of importing
    // the data layer, so nothing on the secret's path is bundled.
    project.write({
      'actions/orders.ts':
        "'use server';\nimport { query } from '../lib/db';\nexport const list = async () => query();\n",
      'components/Orders.tsx':
        "'use client';\nimport { list } from '../actions/orders';\nexport function Orders() { return <button onClick={() => list()} />; }\n",
    });

    const result = run(['verify', '1'], project.root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Issue #1 is fixed');
  });
});

describe('state 4 — a project with a lot of findings', () => {
  it('prioritises instead of dumping, and does not frighten anybody', () => {
    const files: Record<string, string> = { 'package.json': '{"name":"big"}' };
    for (let i = 0; i < 25; i += 1) {
      files[`src/mod${i}.ts`] = `export const value${i}: any = {} as any;\n`;
    }
    project = TempProject.create(files);

    const result = run(['check'], project.root);
    expect(result.stdout).not.toMatch(/ERRORS/);
    expect(result.stdout).toMatch(/don't need to fix|low priority/i);
    // Only a slice is shown by default, with a way to see the rest.
    expect(result.stdout).toContain('--all');
    expect(run(['check', '--all'], project.root).stdout).not.toContain('… and');
  });
});

describe('state 5 — something is set up wrong', () => {
  it('explains an unreadable configuration and names the way out', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      '.little-owl/config.ts': 'export default = ;;;',
    });

    const result = run(['check'], project.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('configuration');
    expect(result.stderr).toContain('Try:');
    expect(result.stderr).toContain('little-owl init');
  });

  it('never answers with a bare error code', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['explain', 'src/does-not-exist.ts'], project.root);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/^Error: ENOENT/);
    expect(result.stderr).toContain('little-owl');
  });

  it('says what to run first when asked to verify before anything was checked', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['verify'], project.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has not looked at this project yet');
    expect(result.stderr).toContain('little-owl check');
  });

  it('says how many issues there actually are when the number is out of range', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    const result = run(['explain', '999'], project.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no issue #999');
    expect(result.stderr).toContain('little-owl check');
  });

  it('finds no code without claiming the project is perfect', () => {
    project = TempProject.create({ 'README.md': '# nothing here\n' });
    const result = run(['check'], project.root);

    expect(result.stdout).toContain('could not find any code');
    expect(result.stdout).not.toContain('100 / 100');
    expect(result.stdout).toContain('little-owl doctor');
  });
});

describe('states 6 and 7 — the fix, and knowing it worked', () => {
  it('says the issue is still there when nothing has changed', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);

    const result = run(['verify', '1'], project.root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('still there');
    offersANextStep(result);
  });

  it('confirms the fix, shows the score moving, and points at what is next', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);

    project.write({ 'src/lib/db/client.ts': 'export const query = () => [];\n' });
    const result = run(['verify', '1'], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Issue #1 is fixed');
    expect(result.stdout).toContain('Health');
    offersANextStep(result);
  });

  it('notices a fix that traded one problem for another', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);

    project.write({
      'src/lib/db/client.ts': 'export const query = (x: any) => [x as any];\n',
    });
    const result = run(['verify', '1'], project.root);

    expect(result.stdout).toContain('Issue #1 is fixed');
    expect(result.stdout).toMatch(/new issue/i);
  });

  it('reports the whole list as JSON for anything automating the loop', () => {
    project = TempProject.create(BROKEN_PROJECT);
    run(['check'], project.root);
    project.write({ 'src/lib/db/client.ts': 'export const query = () => [];\n' });

    const result = run(['verify', '--json'], project.root);
    const json = JSON.parse(result.stdout) as {
      resolved: string[];
      remaining: string[];
      metrics: { overall: number };
      previousMetrics: { overall: number };
    };

    expect(json.resolved.length).toBeGreaterThan(0);
    expect(json.metrics.overall).toBeGreaterThan(json.previousMetrics.overall);
    // Verifying everything is a status report, not a gate: leftover low
    // priority findings must not turn it into a failed command.
    expect(result.status).toBe(0);
  });

  it("runs the project's own tests on request and fails when they fail", () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      'package.json': JSON.stringify({
        name: 'my-app',
        scripts: { test: 'node -e "process.exit(1)"' },
      }),
    });
    run(['check'], project.root);

    const result = run(['verify', '--tests'], project.root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('they failed');
  });
});

describe('the whole loop', () => {
  it('never leaves the reader without a command to type', () => {
    project = TempProject.create(BROKEN_PROJECT);
    project.initGit();

    for (const args of [
      ['init'],
      ['check'],
      ['explain', '1'],
      ['fix', '1'],
      ['verify', '1'],
      ['review', '--no-menu'],
      ['map'],
      ['architecture'],
      ['dead-code'],
      ['tests'],
      ['dependencies'],
      ['doctor'],
      ['impact', 'src/services/orders.ts'],
      ['explain', 'src/services/orders.ts'],
    ]) {
      const result = run(args, project.root);
      expect(result.output, `\`${args.join(' ')}\` printed nothing`).not.toBe('');
      offersANextStep(result);
    }
  });

  it('speaks one language across every command', () => {
    project = TempProject.create(BROKEN_PROJECT);
    project.initGit();
    run(['check'], project.root);

    // The internal severity words must never reach a person; they configure
    // rules, they do not describe urgency.
    for (const args of [['check'], ['explain', '1'], ['fix', '1'], ['review', '--no-menu']]) {
      const { stdout } = run(args, project.root);
      expect(stdout, args.join(' ')).not.toMatch(/\bwarning\b/);
      expect(stdout, args.join(' ')).not.toMatch(/\berror-level\b/);
    }
  });

  it('uses the same number for the same problem in every command', () => {
    project = TempProject.create(BROKEN_PROJECT);
    const checked = JSON.parse(run(['check', '--json'], project.root).stdout) as {
      findings: Array<{ number: number; fingerprint: string; priority: string }>;
    };
    run(['check'], project.root);

    const first = checked.findings.find((entry) => entry.number === 1);
    expect(first?.priority).toBe('critical');

    const explained = JSON.parse(run(['explain', '1', '--json'], project.root).stdout) as {
      fingerprint: string;
    };
    expect(explained.fingerprint).toBe(first?.fingerprint);
  });

  it('writes an assistant briefing on demand, and does not overwrite an edited one', () => {
    project = TempProject.create(CLEAN_PROJECT);

    expect(run(['agent'], project.root).status).toBe(0);
    project.write({ 'LITTLE_OWL.md': '# my own notes\n' });

    run(['agent'], project.root);
    expect(fs.readFileSync(project.path('LITTLE_OWL.md'), 'utf8')).toContain('my own notes');

    run(['agent', '--force'], project.root);
    expect(fs.readFileSync(project.path('LITTLE_OWL.md'), 'utf8')).toContain('little-owl check');
  });
});
