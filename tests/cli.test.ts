import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';

/**
 * End-to-end tests against the built CLI, exactly as a user would run it.
 * These are the tests that catch packaging and wiring problems that unit tests
 * on the source cannot see.
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
}

const run = (args: string[], cwd: string): RunResult => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', CI: 'true' },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const CLEAN_PROJECT = {
  'package.json': '{"name":"cli-fixture"}',
  '.gitignore': 'node_modules\n',
  'src/app/page.ts': "import { list } from '../services/orders';\nexport const page = list;\n",
  'src/services/orders.ts':
    "import { query } from '../lib/db/client';\nexport const list = () => query();\n",
  'src/lib/db/client.ts': 'export const query = () => [];\n',
};

describe('cli', () => {
  it('prints help and version', () => {
    project = TempProject.create(CLEAN_PROJECT);

    const help = run(['--help'], project.root);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('A second pair of eyes for your codebase.');
    expect(help.stdout).toContain('review');

    const version = run(['--version'], project.root);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('checks a project and emits valid JSON', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['check', '--json'], project.root);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.project.name).toBe('cli-fixture');
    expect(json.metrics.overall).toBeGreaterThan(0);
    expect(Array.isArray(json.findings)).toBe(true);
  });

  it('never writes to source files', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const before = fs.readFileSync(project.path('src/services/orders.ts'), 'utf8');

    run(['check'], project.root);
    run(['review', '--no-menu'], project.root);
    run(['architecture'], project.root);

    expect(fs.readFileSync(project.path('src/services/orders.ts'), 'utf8')).toBe(before);
  });

  it('creates a config and baseline with init --yes', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['init', '--yes'], project.root);

    expect(result.status).toBe(0);
    expect(fs.existsSync(project.path('.little-owl/config.ts'))).toBe(true);
    expect(fs.existsSync(project.path('.little-owl/baseline.json'))).toBe(true);

    const baseline = JSON.parse(fs.readFileSync(project.path('.little-owl/baseline.json'), 'utf8'));
    expect(baseline.version).toBe('1');
    expect(baseline.metrics.overall).toBeGreaterThan(0);

    // Running init again must not silently overwrite the existing setup.
    const second = run(['init', '--yes'], project.root);
    expect(second.status).toBe(1);
    expect(second.stdout).toContain('already exists');
  });

  it('exits 0 in CI when nothing is wrong', () => {
    project = TempProject.create(CLEAN_PROJECT);
    project.initGit();
    run(['baseline', '--yes'], project.root);

    const result = run(['ci'], project.root);
    expect(result.stdout).toContain('result: pass');
    expect(result.status).toBe(0);
  });

  it('exits non-zero in CI when a change introduces an error-level finding', () => {
    project = TempProject.create(CLEAN_PROJECT);
    project.initGit();
    run(['baseline', '--yes'], project.root);

    // The data layer now imports the UI: an inverted dependency and a cycle.
    project.write({
      'src/lib/db/client.ts':
        "import { page } from '../../app/page';\nexport const query = () => [page];\n",
    });

    const result = run(['ci'], project.root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('result: fail');
    expect(result.stdout).toContain('error');

    const json = JSON.parse(run(['ci', '--json'], project.root).stdout);
    expect(json.ci.passed).toBe(false);
    expect(json.status).toBe('degraded');
  });

  it('respects --fail-on never', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      'src/lib/db/client.ts':
        "import { page } from '../../app/page';\nexport const query = () => [page];\n",
    });
    project.initGit();

    expect(run(['ci', '--fail-on', 'never'], project.root).status).toBe(0);
    expect(run(['ci'], project.root).status).toBe(1);
  });

  it('reports scope violations from the command line', () => {
    project = TempProject.create(CLEAN_PROJECT);
    project.initGit();
    project.write({ 'src/app/page.ts': 'export const page = () => 1;\n' });

    const json = JSON.parse(
      run(['review', '--scope', 'src/services/**', '--json', '--no-menu'], project.root).stdout,
    );

    expect(json.scope.patterns).toEqual(['src/services/**']);
    expect(json.scope.outOfScope).toContain('src/app/page.ts');
  });

  it('writes a prompt with no findings when the code is clean', () => {
    project = TempProject.create(CLEAN_PROJECT);
    project.initGit();

    const result = run(['prompt'], project.root);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('describes the architecture as JSON', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const json = JSON.parse(run(['architecture', '--json'], project.root).stdout);

    expect(json.layers).toContain('ui');
    expect(json.filesByLayer['ui']).toContain('src/app/page.ts');
  });

  it('lists rules and configuration', () => {
    project = TempProject.create(CLEAN_PROJECT);

    const rules = run(['config', '--rules'], project.root);
    expect(rules.stdout).toContain('architecture/circular-dependency');
    expect(rules.stdout).toContain('error');

    const config = JSON.parse(run(['config', '--json'], project.root).stdout);
    expect(config.strictness).toBe('balanced');
  });

  it('reports impact for explicit files', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const json = JSON.parse(
      run(['impact', '--files', 'src/lib/db/client.ts', '--json'], project.root).stdout,
    );

    expect(json.impacted.map((entry: { path: string }) => entry.path)).toContain(
      'src/services/orders.ts',
    );
  });

  it('maps the project as JSON', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const json = JSON.parse(run(['map', '--json'], project.root).stdout);

    expect(json.totals.files).toBe(3);
    expect(json.areas.map((area: { path: string }) => area.path)).toContain('src/services');
  });

  it('finds dead code and respects the confidence floor', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      'src/orphan.ts': 'const helper = () => 1;\nexport default helper;\n',
    });

    const json = JSON.parse(run(['dead-code', '--json'], project.root).stdout);
    expect(json.candidates.map((c: { path: string }) => c.path)).toContain('src/orphan.ts');

    const strict = JSON.parse(
      run(['dead-code', '--min-confidence', 'high', '--json'], project.root).stdout,
    );
    expect(strict.candidates.length).toBeLessThanOrEqual(json.candidates.length);
  });

  it('reports test gaps as JSON', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const json = JSON.parse(run(['tests', '--json'], project.root).stdout);

    expect(json.hasNoTests).toBe(true);
    expect(Array.isArray(json.gaps)).toBe(true);
  });

  it('explains a file using git history', () => {
    project = TempProject.create(CLEAN_PROJECT);
    project.initGit('Add the orders service to fix duplicate rows.');

    const result = run(['explain', 'src/services/orders.ts'], project.root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CODE ARCHAEOLOGY');
    expect(result.stdout).toContain('orders service');

    const json = JSON.parse(
      run(['explain', 'src/services/orders.ts', '--json'], project.root).stdout,
    );
    expect(json.evidence).toBe('strong');
    expect(json.consumers).toContain('src/app/page.ts');
  });

  it('exits non-zero when explaining a file that is not analysed', () => {
    project = TempProject.create(CLEAN_PROJECT);
    expect(run(['explain', 'src/nope.ts'], project.root).status).toBe(1);
  });

  it('runs doctor and reports what limits the analysis', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run(['doctor'], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Little Owl doctor');

    const json = JSON.parse(run(['doctor', '--json'], project.root).stdout);
    const names = json.checks.map((check: { name: string }) => check.name);
    expect(names).toContain('Import resolution');
    expect(names).toContain('Baseline');
  });

  it('accepts a file argument for impact', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const json = JSON.parse(run(['impact', 'src/lib/db/client.ts', '--json'], project.root).stdout);

    expect(json.changed).toEqual(['src/lib/db/client.ts']);
    expect(json.impacted.map((entry: { path: string }) => entry.path)).toContain(
      'src/services/orders.ts',
    );
    expect(['high', 'medium', 'low']).toContain(json.risk);
    expect(json.confidence).toBe('high');
  });

  it('reads a .littleowlrc config file', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      '.littleowlrc': '{"strictness":"strict"}',
    });

    const config = JSON.parse(run(['config', '--json'], project.root).stdout);
    expect(config.strictness).toBe('strict');
    expect(config.sourcePath).toContain('.littleowlrc');
  });

  it('keeps going when a file cannot be parsed', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      'src/broken.py': 'def (((:\n  ???\n',
    });

    const result = run(['check', '--json'], project.root);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.metrics.overall).toBeGreaterThan(0);
  });

  it('keeps its own cache out of git even without init', () => {
    // The cache is machine state, and `init` is optional — so the ignore file
    // cannot depend on having run it.
    project = TempProject.create(CLEAN_PROJECT);

    const result = run(['check'], project.root);
    expect(result.status).toBe(0);
    expect(fs.existsSync(project.path('.little-owl/cache/parse.json'))).toBe(true);

    const ignored = fs.readFileSync(project.path('.little-owl/.gitignore'), 'utf8');
    expect(ignored).toContain('cache/');
    expect(ignored).toContain('history.json');
  });

  it('agrees with its own rule about unused dependencies', () => {
    project = TempProject.create({
      ...CLEAN_PROJECT,
      'package.json': JSON.stringify({
        name: 'cli-fixture',
        dependencies: { lodash: '^4.0.0' },
        devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0' },
      }),
    });

    const report = run(['dependencies'], project.root).stdout;
    const check = JSON.parse(run(['check', '--json'], project.root).stdout) as {
      findings: Array<{ id: string; detail?: string[] }>;
    };
    const finding = check.findings.find((entry) => entry.id === 'dependencies/unused-dependency');

    expect(report).toContain('lodash');
    expect(finding?.detail).toEqual(['lodash']);
    // Build tooling is not imported and must not be called unused by either.
    expect(report).not.toContain('eslint');
    expect(report).not.toContain('prettier');
  });

  it('falls back to check when run non-interactively with no command', () => {
    project = TempProject.create(CLEAN_PROJECT);
    const result = run([], project.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CODEBASE HEALTH');
  });
});
