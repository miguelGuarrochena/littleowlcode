import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { runReview, determineStatus } from '../src/review/review.js';
import {
  buildBaseline,
  compareToBaseline,
  explainDrift,
  readBaseline,
  writeBaseline,
} from '../src/baseline/baseline.js';
import { checkScope, groupByArea } from '../src/review/scope.js';
import { analyzeImpact } from '../src/review/impact.js';
import { generatePrompt } from '../src/prompts/generate.js';
import { evaluateCi } from '../src/cli/commands/ci.js';
import { reviewToJson, SCHEMA_VERSION } from '../src/output/json.js';
import { detectChanges } from '../src/git/git.js';
import type { Finding, ReviewResult } from '../src/core/types.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

const BASE_FILES = {
  'package.json': '{"name":"drift-fixture"}',
  '.gitignore': 'node_modules\n',
  'src/app/page.ts': "import { list } from '../services/orders';\nexport const page = list;\n",
  'src/services/orders.ts':
    "import { query } from '../lib/db/client';\nexport const list = () => query();\n",
  'src/lib/db/client.ts': 'export const query = () => [];\n',
};

describe('scope checking', () => {
  it('separates in-scope from out-of-scope changes', () => {
    const result = checkScope(
      {
        description: 'test',
        files: [
          { path: 'features/orders/list.ts', status: 'modified', insertions: 1, deletions: 0 },
          { path: 'features/auth/login.ts', status: 'modified', insertions: 1, deletions: 0 },
          { path: 'components/Header.tsx', status: 'modified', insertions: 1, deletions: 0 },
        ],
      },
      ['features/orders/**'],
    );

    expect(result?.inScope).toEqual(['features/orders/list.ts']);
    expect(result?.outOfScope).toEqual(['components/Header.tsx', 'features/auth/login.ts']);
  });

  it('returns null when no scope was requested', () => {
    expect(checkScope({ description: 'test', files: [] }, [])).toBeNull();
  });

  it('groups out-of-scope files by area', () => {
    expect(
      groupByArea(['features/auth/a.ts', 'features/auth/b.ts', 'components/Header.tsx']),
    ).toEqual([
      { area: 'components', files: ['components/Header.tsx'] },
      { area: 'features/auth', files: ['features/auth/a.ts', 'features/auth/b.ts'] },
    ]);
  });
});

describe('baseline and drift', () => {
  it('writes, reads back and compares a baseline', async () => {
    project = TempProject.create(BASE_FILES);
    const first = await project.analyze();
    writeBaseline(project.root, buildBaseline(project.root, first.result));

    const baseline = readBaseline(project.root);
    expect(baseline?.metrics).toEqual(first.result.metrics);

    // Introduce a cycle: the data layer now imports the UI.
    project.write({
      'src/lib/db/client.ts':
        "import { page } from '../../app/page';\nexport const query = () => [page];\n",
    });

    const second = await project.analyze();
    const comparison = compareToBaseline(baseline!, second.result);

    expect(comparison.drift.architecture).toBeLessThan(0);
    expect(comparison.newFindings.some((f) => f.id === 'architecture/circular-dependency')).toBe(
      true,
    );
    expect(explainDrift(baseline!, second.result)).toContain('+1 circular dependency');
  });

  it('reports findings that no longer reproduce as resolved', async () => {
    project = TempProject.create({
      ...BASE_FILES,
      'src/lib/db/client.ts':
        "import { page } from '../../app/page';\nexport const query = () => [page];\n",
    });
    const broken = await project.analyze();
    writeBaseline(project.root, buildBaseline(project.root, broken.result));

    project.write({ 'src/lib/db/client.ts': 'export const query = () => [];\n' });
    const fixed = await project.analyze();
    const comparison = compareToBaseline(readBaseline(project.root)!, fixed.result);

    expect(
      comparison.resolvedFindings.some((f) => f.id === 'architecture/circular-dependency'),
    ).toBe(true);
    expect(comparison.newFindings).toHaveLength(0);
    expect(comparison.drift.architecture).toBeGreaterThan(0);
  });
});

describe('review status', () => {
  const finding = (severity: Finding['severity']): Finding => ({
    id: 'x',
    fingerprint: severity,
    severity,
    category: 'complexity',
    title: 't',
    message: 'm',
  });

  it('degrades on a new error or a large score drop', () => {
    expect(determineStatus([finding('error')], null, null)).toBe('degraded');
    expect(
      determineStatus(
        [],
        {
          overall: -6,
          architecture: 0,
          maintainability: 0,
          complexity: 0,
          dependencies: 0,
          typeSafety: 0,
        },
        null,
      ),
    ).toBe('degraded');
  });

  it('needs review on a new warning, a small drop, or an out-of-scope change', () => {
    expect(determineStatus([finding('warning')], null, null)).toBe('needs-review');
    expect(
      determineStatus(
        [],
        {
          overall: -1,
          architecture: 0,
          maintainability: 0,
          complexity: 0,
          dependencies: 0,
          typeSafety: 0,
        },
        null,
      ),
    ).toBe('needs-review');
    expect(
      determineStatus([], null, { patterns: ['a/**'], inScope: [], outOfScope: ['b/x.ts'] }),
    ).toBe('needs-review');
  });

  it('is healthy when nothing new appeared', () => {
    expect(determineStatus([finding('info')], null, null)).toBe('healthy');
  });
});

describe('review over git', () => {
  it('finds uncommitted changes and judges them against the baseline', async () => {
    project = TempProject.create(BASE_FILES);
    project.initGit();

    const initial = await project.analyze();
    writeBaseline(project.root, buildBaseline(project.root, initial.result));

    project.write({
      'src/app/page.ts':
        "import { query } from '../lib/db/client';\nexport const page = () => query();\n",
    });

    const changes = detectChanges(project.root);
    expect(changes?.files.map((file) => file.path)).toContain('src/app/page.ts');
    // Little Owl's own files never count as part of the reviewed change.
    expect(changes?.files.some((file) => file.path.startsWith('.little-owl/'))).toBe(false);

    const review = await runReview({ root: project.root, scope: ['src/services/**'] });

    expect(review.changes?.description).toBe('uncommitted changes vs HEAD');
    expect(review.scope?.outOfScope).toContain('src/app/page.ts');
    expect(review.newFindings.some((f) => f.id === 'scope/out-of-scope-change')).toBe(true);
    expect(review.status).not.toBe('healthy');
  });

  it('produces valid, stable JSON', async () => {
    project = TempProject.create(BASE_FILES);
    project.initGit();
    const review = await runReview({ root: project.root });
    const json = reviewToJson(review, '1.2.3');

    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
    expect(json.tool).toEqual({ name: 'little-owl-code', version: '1.2.3' });
    expect(['healthy', 'needs-review', 'degraded']).toContain(json.status);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('change impact', () => {
  it('ranks dependents by how close they are to the change', async () => {
    project = TempProject.create(BASE_FILES);
    const { context } = await project.analyze();
    const report = analyzeImpact(context, ['src/lib/db/client.ts']);

    expect(report.impacted.find((entry) => entry.path === 'src/services/orders.ts')?.level).toBe(
      'high',
    );
    expect(report.impacted.find((entry) => entry.path === 'src/app/page.ts')?.level).toBe('medium');
  });

  it('says nothing is affected when nothing imports the file', async () => {
    project = TempProject.create(BASE_FILES);
    const { context } = await project.analyze();
    expect(analyzeImpact(context, ['src/app/page.ts']).impacted).toHaveLength(0);
  });
});

describe('prompt generation', () => {
  const reviewWith = (findings: Finding[], scope?: string[]): ReviewResult => {
    return {
      status: 'degraded',
      current: {
        metrics: {
          overall: 80,
          architecture: 80,
          maintainability: 80,
          complexity: 80,
          dependencies: 80,
          typeSafety: 80,
        },
        stats: {} as never,
        findings,
        fileMetrics: {},
        project: {} as never,
        warnings: [],
        truncated: false,
        durationMs: 1,
      },
      baseline: null,
      changes: null,
      newFindings: findings,
      resolvedFindings: [],
      scope: scope ? { patterns: scope, inScope: [], outOfScope: ['other/x.ts'] } : null,
      drift: null,
    };
  };

  it('turns findings into numbered instructions and keeps the scope constraint', () => {
    const prompt = generatePrompt(
      reviewWith(
        [
          {
            id: 'architecture/circular-dependency',
            fingerprint: 'a',
            severity: 'error',
            category: 'architecture',
            title: 'Circular dependency across 3 files',
            message: 'm',
            detail: ['a.ts -> b.ts -> c.ts -> a.ts'],
          },
        ],
        ['features/orders/**'],
      ),
    );

    expect(prompt).toContain('1. Remove the circular dependency: a.ts -> b.ts -> c.ts -> a.ts.');
    expect(prompt).toContain('Do not modify files outside features/orders/**.');
    expect(prompt).toContain('Preserve the existing behaviour');
    expect(prompt).toContain('little-owl review');
  });

  it('stays short by ignoring info-level findings', () => {
    const prompt = generatePrompt(
      reviewWith([
        {
          id: 'complexity/deep-nesting',
          fingerprint: 'b',
          severity: 'info',
          category: 'complexity',
          title: 'deep',
          message: 'm',
        },
      ]),
    );

    expect(prompt).toContain('nothing that needs fixing');
  });

  it('does not spend places on the same sentence twice', () => {
    // Three skipped-layer imports in one file are three findings but one
    // instruction; repeating it wastes the brief's cap on a single problem.
    const sameFile = (line: number): Finding => ({
      id: 'architecture/layer-skip',
      fingerprint: `skip-${line}`,
      severity: 'warning',
      category: 'architecture',
      file: 'src/app/panel/page.tsx',
      line,
      title: 'ui imports infrastructure directly',
      message: 'skips a layer',
      detail: ['found:    ui -> infrastructure', 'expected: ui -> application -> infrastructure'],
    });

    const text = generatePrompt(reviewWith([sameFile(17), sameFile(18), sameFile(22)]));
    const numbered = text.split('\n').filter((line) => /^\d+\. /.test(line));
    const layering = numbered.filter((line) => line.includes('Restore the layering'));

    expect(layering).toHaveLength(1);
  });

  it('caps the number of instructions', () => {
    const many: Finding[] = Array.from({ length: 20 }, (_, index) => ({
      id: 'complexity/large-file',
      fingerprint: `f${index}`,
      severity: 'warning',
      category: 'complexity',
      title: `file${index}.ts is 900 lines`,
      message: 'm',
      file: `file${index}.ts`,
    }));

    const numbered = generatePrompt(reviewWith(many), { maxInstructions: 3 })
      .split('\n')
      .filter((line) => /^\d+\./.test(line));

    // 3 findings plus the standing "preserve behaviour" instruction.
    expect(numbered).toHaveLength(4);
  });
});

describe('ci gate', () => {
  const base = (findings: Finding[], drift?: number): ReviewResult => ({
    status: 'needs-review',
    current: {
      metrics: {
        overall: 80,
        architecture: 80,
        maintainability: 80,
        complexity: 80,
        dependencies: 80,
        typeSafety: 80,
      },
      stats: {} as never,
      findings,
      fileMetrics: {},
      project: {} as never,
      warnings: [],
      truncated: false,
      durationMs: 1,
    },
    baseline: null,
    changes: null,
    newFindings: findings,
    resolvedFindings: [],
    scope: null,
    drift:
      drift === undefined
        ? null
        : {
            overall: drift,
            architecture: 0,
            maintainability: 0,
            complexity: 0,
            dependencies: 0,
            typeSafety: 0,
          },
  });

  const warning: Finding = {
    id: 'complexity/large-file',
    fingerprint: 'w',
    severity: 'warning',
    category: 'complexity',
    title: 'w',
    message: 'm',
  };
  const error: Finding = { ...warning, fingerprint: 'e', severity: 'error' };

  it('passes on warnings when configured to fail on errors', () => {
    const verdict = evaluateCi(base([warning]), { failOn: 'error', maxDrop: 5, newOnly: true });
    expect(verdict.passed).toBe(true);
    expect(verdict.exitCode).toBe(0);
  });

  it('fails on an error-level finding', () => {
    const verdict = evaluateCi(base([error]), { failOn: 'error', maxDrop: 5, newOnly: true });
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reasons[0]).toContain('1 error-level finding');
  });

  it('fails on warnings when the threshold is lowered', () => {
    expect(
      evaluateCi(base([warning]), { failOn: 'warning', maxDrop: 5, newOnly: true }).passed,
    ).toBe(false);
  });

  it('never fails when failOn is never', () => {
    expect(evaluateCi(base([error]), { failOn: 'never', maxDrop: 5, newOnly: true }).passed).toBe(
      true,
    );
  });

  it('fails when the overall score drops too far', () => {
    const verdict = evaluateCi(base([], -9), { failOn: 'error', maxDrop: 5, newOnly: true });
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toContain('dropped 9 points');
  });
});

/**
 * Without a baseline there is no change to judge, so the status has to describe
 * the code rather than counting pre-existing findings against it.
 */
describe('review status without a baseline', () => {
  const warning: Finding = {
    id: 'complexity/large-file',
    fingerprint: 'w1',
    severity: 'warning',
    category: 'complexity',
    title: 'big file',
    message: 'big file',
  };
  const error: Finding = { ...warning, fingerprint: 'e1', severity: 'error' };

  it('is healthy when nothing is critical, however many warnings exist', () => {
    expect(determineStatus([warning, warning], null, null, false)).toBe('healthy');
  });

  it('still degrades on an error', () => {
    expect(determineStatus([error], null, null, false)).toBe('degraded');
  });

  it('still reports work done outside the requested area', () => {
    const scope = { patterns: ['src/a/**'], inScope: [], outOfScope: ['src/b/x.ts'] };
    expect(determineStatus([warning], null, scope, false)).toBe('needs-review');
  });

  it('goes back to judging the change once a baseline exists', () => {
    expect(determineStatus([warning], null, null, true)).toBe('needs-review');
  });
});
