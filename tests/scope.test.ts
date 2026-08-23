import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findingsFor } from './helpers.js';
import { DEFAULT_IGNORE, SAMPLE_CODE_IGNORE, baseConfig } from '../src/config/defaults.js';
import { mergeIgnore, resolveConfig } from '../src/config/load.js';
import { buildScopeReport } from '../src/detect/scope-report.js';
import { renderScope } from '../src/output/guided.js';
import { inferLayers, hasUsableLayers } from '../src/architecture/layers.js';
import { renderConfigFile } from '../src/cli/commands/init.js';
import { dismissalFor, canDismiss } from '../src/guidance/dismiss.js';
import type { Finding, ParsedFile } from '../src/core/types.js';

/**
 * What Little Owl looks at, and what it says about that.
 *
 * These exist because of one dogfooding run: on a project with a
 * `tests/fixtures/` directory, the first thing the tool ever said was two
 * critical findings inside deliberately-broken sample code. Every test here
 * guards one link in that chain.
 */

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

const SAMPLE_PROJECT = {
  'package.json': '{"name":"lib"}',
  'src/index.ts': 'export const real = () => 1;\n',
  // Deliberately broken sample code, exactly as a test suite would hold it.
  'tests/fixtures/circular/a.ts': "import { b } from './b';\nexport const a = b;\n",
  'tests/fixtures/circular/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'examples/demo.ts': 'export const demo: any = {} as any;\n',
  '__mocks__/fs.ts': 'export default {} as any;\n',
  'src/Button.stories.tsx': 'export const Story: any = {};\n',
};

describe('sample code is not the application', () => {
  it('leaves fixtures, mocks, examples and stories out by default', async () => {
    project = TempProject.create(SAMPLE_PROJECT);
    const { result, context } = await project.analyze();

    const analysed = context.files.map((file) => file.path);
    expect(analysed).toEqual(['src/index.ts']);
    // The headline consequence: no fabricated critical findings on a first run.
    expect(findingsFor(result.findings, 'architecture/circular-dependency')).toEqual([]);
  });

  it('does not let sample code distort the detected stack', async () => {
    project = TempProject.create({
      'package.json': '{"name":"lib"}',
      'src/index.ts': 'export const a = 1;\n',
      'tests/fixtures/py/app.py': 'def f():\n    pass\n',
      'tests/fixtures/go/main.go': 'package main\n',
    });

    const { result } = await project.analyze();
    expect(result.project.languages).not.toContain('python');
    expect(result.project.languages).not.toContain('go');
  });

  it('keeps every sample pattern inside the default list', () => {
    for (const pattern of SAMPLE_CODE_IGNORE) {
      expect(DEFAULT_IGNORE, pattern).toContain(pattern);
    }
  });

  it('can be told a sample directory is real code after all', async () => {
    // Without this, the defaults would be unremovable and the advice Little Owl
    // prints — "put it back with a !" — would be a lie.
    project = TempProject.create(SAMPLE_PROJECT);
    const { context } = await project.analyze({ ignore: ['!examples/**'] });

    expect(context.files.map((file) => file.path)).toContain('examples/demo.ts');
  });

  it('merges ignore additively, with `!` as the only escape', () => {
    expect(mergeIgnore(['a/**', 'b/**'], ['c/**'])).toEqual(['a/**', 'b/**', 'c/**']);
    expect(mergeIgnore(['a/**', 'b/**'], ['!a/**'])).toEqual(['b/**']);
    expect(mergeIgnore(['a/**'], ['!a/**', 'c/**'])).toEqual(['c/**']);
  });
});

describe('saying what is in scope', () => {
  it('lists what is analysed and what was skipped, with the pattern responsible', () => {
    project = TempProject.create(SAMPLE_PROJECT);
    const report = buildScopeReport(project.root, baseConfig('balanced'), [
      'src/index.ts',
      'src/other.ts',
    ]);

    expect(report.analysed[0]).toMatchObject({ directory: 'src', files: 2 });
    const skipped = report.skipped.map((entry) => entry.directory);
    expect(skipped).toContain('tests/fixtures');
    expect(skipped).toContain('examples');
    expect(report.skipped.every((entry) => entry.pattern.length > 0)).toBe(true);
  });

  it('does not list loose root files as if each were an area', () => {
    project = TempProject.create(SAMPLE_PROJECT);
    const report = buildScopeReport(project.root, baseConfig('balanced'), [
      'src/index.ts',
      'vitest.config.ts',
      'eslint.config.js',
    ]);

    expect(report.analysed.map((area) => area.directory)).toEqual(['(project root)', 'src']);
  });

  it('tells the reader how to disagree with the exclusions', () => {
    project = TempProject.create(SAMPLE_PROJECT);
    const rendered = renderScope(
      buildScopeReport(project.root, baseConfig('balanced'), ['src/index.ts']),
    );

    expect(rendered).toContain('ANALYSING');
    expect(rendered).toContain('SKIPPED');
    expect(rendered).toContain('tests/fixtures');
    expect(rendered).toContain('!');
    expect(rendered).toContain('.little-owl/config.ts');
  });

  it('says nothing about skipped samples in a project that has none', () => {
    project = TempProject.create({
      'package.json': '{"name":"x"}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const rendered = renderScope(
      buildScopeReport(project.root, baseConfig('balanced'), ['src/a.ts']),
    );

    expect(rendered).not.toContain('SKIPPED');
  });
});

describe('layers', () => {
  const file = (path: string): ParsedFile =>
    ({ path, isTest: false, functions: [], imports: [], markers: [], exports: [] }) as never;

  it('refuses to guess an architecture from a single directory name', () => {
    // `domain: ["core"]` inferred from a folder called `core` states a decision
    // nobody made, and enables rules that can never fire.
    const inferred = inferLayers([file('src/core/a.ts'), file('src/other/b.ts')]);

    expect(inferred.order).toEqual([]);
    expect(hasUsableLayers(inferred)).toBe(false);
  });

  it('infers a model as soon as there are two sides to a boundary', () => {
    const inferred = inferLayers([file('components/a.tsx'), file('lib/db/b.ts')]);

    expect(inferred.order.length).toBeGreaterThanOrEqual(2);
    expect(hasUsableLayers(inferred)).toBe(true);
  });

  it('writes a commented example rather than an empty layers block', () => {
    const rendered = renderConfigFile({ strictness: 'balanced', include: [], layers: {} });

    expect(rendered).toContain('No layered structure was detected');
    expect(rendered).not.toMatch(/layers: \{\s*\},/);
  });

  it('writes real layers when there are real layers', () => {
    const rendered = renderConfigFile({
      strictness: 'balanced',
      include: [],
      layers: { ui: ['app'], data: ['lib/db'] },
    });

    expect(rendered).toContain('ui: ["app"]');
    expect(rendered).toContain('data: ["lib/db"]');
  });
});

describe('dismissing a finding', () => {
  const finding = (over: Partial<Finding> = {}): Finding =>
    ({
      id: 'complexity/high-complexity',
      fingerprint: 'f',
      severity: 'warning',
      category: 'complexity',
      file: 'src/core/metrics.ts',
      title: 'computeStats() has a complexity of 21',
      message: 'm',
      baseline: 15,
      current: 21,
      ...over,
    }) as Finding;

  it('excludes the path when the code is not the application', () => {
    const dismissal = dismissalFor(finding({ file: 'tests/fixtures/broken/a.ts' }));

    expect(dismissal.snippet).toContain("ignore: ['tests/fixtures/**']");
    // Not `tests/**`, which would throw away real coverage.
    expect(dismissal.snippet).not.toContain("'tests/**'");
  });

  it('moves the budget rather than excluding real source', () => {
    // Telling someone to exclude src/core to silence one complex function is
    // worse advice than the finding it replaces.
    const dismissal = dismissalFor(finding());

    expect(dismissal.snippet).toContain('maxComplexity');
    expect(dismissal.snippet).not.toContain('ignore:');
  });

  it('suggests the smallest limit that clears it, not a comfortable round number', () => {
    // 30 would silence this finding and the next nine, invisibly.
    expect(dismissalFor(finding()).snippet).toContain('maxComplexity: 21');
  });

  it('falls back to switching the rule off when nothing narrower fits', () => {
    const dismissal = dismissalFor(
      finding({ id: 'patterns/thin-wrapper', baseline: undefined, current: undefined }),
    );

    expect(dismissal.snippet).toContain("'patterns/thin-wrapper': 'off'");
  });

  it('is never offered for a leaked credential', () => {
    expect(canDismiss(finding({ id: 'next/secret-in-client-bundle' }))).toBe(false);
    expect(canDismiss(finding({ id: 'next/server-module-in-client-bundle' }))).toBe(false);
    expect(canDismiss(finding())).toBe(true);
  });
});

describe('the generated config', () => {
  it('explains the escape hatch it just told the reader about', () => {
    project = TempProject.create(SAMPLE_PROJECT);
    const rendered = renderConfigFile({ strictness: 'balanced', include: [], layers: {} });

    expect(rendered).toContain('ignore');
    expect(rendered).toContain('!examples/**');
  });

  it('parses as a real config', async () => {
    project = TempProject.create(SAMPLE_PROJECT);
    fs.mkdirSync(project.path('.little-owl'), { recursive: true });
    fs.writeFileSync(
      project.path('.little-owl/config.ts'),
      renderConfigFile({ strictness: 'balanced', include: [], layers: {} }),
    );

    const { result } = await project.analyze(resolveConfig({ strictness: 'balanced' }) as never);
    expect(result.metrics.overall).toBeGreaterThan(0);
  });
});
