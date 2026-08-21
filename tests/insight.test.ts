import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findDeadCode } from '../src/review/dead-code.js';
import { analyzeTestGaps } from '../src/review/test-gap.js';
import { explainFile } from '../src/review/archaeology.js';
import { buildProjectMap } from '../src/review/map.js';
import { analyzeImpact } from '../src/review/impact.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

describe('dead code', () => {
  it('reports an unreferenced file and leaves reachable ones alone', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/index.ts': "import { used } from './used';\nexport const run = () => used();\n",
      'src/used.ts': 'export const used = () => 1;\n',
      'src/orphan.ts': 'const helper = () => 2;\nexport default helper;\n',
    });

    const { context } = await project.analyze();
    const report = findDeadCode(context);
    const paths = report.candidates.map((candidate) => candidate.path);

    expect(paths).toContain('src/orphan.ts');
    expect(paths).not.toContain('src/used.ts');
    // `index.ts` is an entry point by convention and is never a candidate.
    expect(paths).not.toContain('src/index.ts');
    expect(report.entryPoints).toContain('src/index.ts');
  });

  it('never claims high confidence when dynamic imports are unresolved', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/index.ts': 'export const load = (name: string) => import(`./plugins/${name}`);\n',
      'src/orphan.ts': 'export const maybe = () => 1;\n',
    });

    const { context } = await project.analyze();
    const report = findDeadCode(context);
    const orphan = report.candidates.find((candidate) => candidate.path === 'src/orphan.ts');

    expect(report.hasUnresolvedDynamicImports).toBe(true);
    expect(orphan?.confidence).not.toBe('high');
    expect(orphan?.caveats.join(' ')).toMatch(/dynamic/);
  });

  it('does not report framework convention files', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"next":"15"}}',
      'app/orders/page.tsx': 'export default function Page() { return null; }\n',
      'app/orders/route.ts': 'export const GET = () => null;\n',
      'middleware.ts': 'export function middleware() { return null; }\n',
    });

    const { context } = await project.analyze();
    const report = findDeadCode(context);

    expect(report.candidates).toHaveLength(0);
    expect(report.entryPoints).toContain('app/orders/page.tsx');
    expect(report.entryPoints).toContain('middleware.ts');
  });

  it('filters by minimum confidence', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/main.ts': 'export const run = () => 1;\n',
      'src/orphan.ts': 'export const maybe = () => 1;\n',
    });

    const { context } = await project.analyze();
    expect(findDeadCode(context, { minConfidence: 'low' }).candidates.length).toBeGreaterThan(0);
    // The orphan exports a name, so its confidence is capped below `high`.
    expect(findDeadCode(context, { minConfidence: 'high' }).candidates).toHaveLength(0);
  });
});

describe('test gaps', () => {
  const SUBJECT = {
    'package.json': '{"name":"t"}',
    'src/orders.ts': `export function total(items: number[]) {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item, 0);
}

export function discount(total: number, rate: number) {
  if (rate < 0 || rate > 1) throw new Error('bad rate');
  return total * (1 - rate);
}
`,
  };

  it('reports a module no test reaches', async () => {
    project = TempProject.create(SUBJECT);
    const { context } = await project.analyze();
    const report = analyzeTestGaps(context);

    expect(report.hasNoTests).toBe(true);
    expect(report.gaps.map((gap) => gap.file)).toEqual(['src/orders.ts']);
    expect(report.gaps[0]!.coverage).toBe('none');
    expect(report.gaps[0]!.untestedExports).toEqual(['discount', 'total']);
  });

  it('marks a module partial when a test reaches it but skips an export', async () => {
    project = TempProject.create({
      ...SUBJECT,
      'src/orders.test.ts': `import { total } from './orders';

it('sums', () => {
  expect(total([1, 2])).toBe(3);
});
`,
    });

    const { context } = await project.analyze();
    const report = analyzeTestGaps(context);
    const gap = report.gaps.find((entry) => entry.file === 'src/orders.ts');

    expect(report.hasNoTests).toBe(false);
    expect(gap?.coverage).toBe('partial');
    expect(gap?.untestedExports).toEqual(['discount']);
    expect(gap?.reachedBy).toContain('src/orders.test.ts');
  });

  it('counts a module as covered when every export is named', async () => {
    project = TempProject.create({
      ...SUBJECT,
      'src/orders.test.ts': `import { total, discount } from './orders';

it('sums', () => expect(total([1])).toBe(1));
it('discounts', () => expect(discount(10, 0.5)).toBe(5));
`,
    });

    const { context } = await project.analyze();
    const report = analyzeTestGaps(context);

    expect(report.covered).toContain('src/orders.ts');
    expect(report.gaps).toHaveLength(0);
  });

  it('skips build scripts and config, which are not normally unit tested', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'next.config.js':
        'module.exports = { reactStrictMode: true, webpack(c) { if (c) return c; return c; } };\n',
      'scripts/seed.ts': `export function seed(n: number) {
  if (n > 0) return n;
  return 0;
}
`,
    });

    const { context } = await project.analyze();
    const report = analyzeTestGaps(context);

    expect(report.gaps).toHaveLength(0);
    expect(report.skipped).toContain('scripts/seed.ts');
    expect(report.skipped).toContain('next.config.js');
  });

  it('narrows to a set of changed files when asked', async () => {
    project = TempProject.create({
      ...SUBJECT,
      'src/other.ts': 'export function other(n: number) {\n  if (n) return n;\n  return 0;\n}\n',
    });

    const { context } = await project.analyze();
    const report = analyzeTestGaps(context, { files: ['src/other.ts'] });

    expect(report.gaps.map((gap) => gap.file)).toEqual(['src/other.ts']);
  });
});

describe('code archaeology', () => {
  it('reads the commit that introduced a file', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/payments.ts': 'export const refund = () => 1;\n',
      'src/index.ts': "import { refund } from './payments';\nexport const run = () => refund();\n",
    });
    project.initGit('Add refund handling to fix duplicate Stripe webhooks.');

    const { context } = await project.analyze();
    const report = explainFile(context, 'src/payments.ts');

    expect(report.exists).toBe(true);
    expect(report.hasHistory).toBe(true);
    expect(report.created?.subject).toContain('refund handling');
    expect(report.evidence).toBe('strong');
    expect(report.rationale[0]).toContain('refund handling');
    expect(report.consumers).toEqual(['src/index.ts']);
  });

  it('says so plainly when there is no history to read', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/payments.ts': 'export const refund = () => 1;\n',
    });

    const { context } = await project.analyze();
    const report = explainFile(context, 'src/payments.ts');

    expect(report.hasHistory).toBe(false);
    expect(report.evidence).toBe('none');
    expect(report.assessment.join(' ')).toMatch(/not a git repository/);
    // It must never invent a reason it cannot support.
    expect(report.rationale).toHaveLength(0);
    expect(report.recommendation).toBeNull();
  });

  it('reports partial evidence when commits exist but explain nothing', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/payments.ts': 'export const refund = () => 1;\n',
    });
    project.initGit('wip');

    const { context } = await project.analyze();
    const report = explainFile(context, 'src/payments.ts');

    expect(report.evidence).toBe('partial');
    expect(report.rationale).toHaveLength(0);
    expect(report.assessment.join(' ')).toMatch(/No commit message explains why/);
  });

  it('handles a file that is not part of the project', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const { context } = await project.analyze();
    const report = explainFile(context, 'src/nope.ts');

    expect(report.exists).toBe(false);
  });
});

describe('project map', () => {
  it('groups files into areas and finds the central modules', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"stripe":"14"}}',
      'src/app/page.tsx':
        "import { pay } from '../services/payments';\nexport default function P() { return pay(); }\n",
      'src/services/payments.ts':
        "import Stripe from 'stripe';\nimport { log } from '../lib/log';\nexport const pay = () => { log(); return new Stripe('k'); };\n",
      'src/services/orders.ts':
        "import { log } from '../lib/log';\nexport const order = () => log();\n",
      'src/lib/log.ts': 'export const log = () => console.log(1);\n',
    });

    const { context } = await project.analyze();
    const map = buildProjectMap(context);

    expect(map.areas.map((area) => area.path)).toContain('src/services');
    expect(map.central[0]?.path).toBe('src/lib/log.ts');
    expect(map.external.map((service) => service.name)).toContain('Stripe');
    expect(map.entryPoints).toContain('src/app/page.tsx');
    expect(map.startHere.length).toBeGreaterThan(0);
    expect(map.totals.files).toBe(4);
  });

  it('works on a project with no recognisable structure', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'a.ts': 'export const a = 1;\n',
    });

    const { context } = await project.analyze();
    const map = buildProjectMap(context);

    expect(map.totals.files).toBe(1);
    expect(map.external).toHaveLength(0);
  });
});

describe('impact risk', () => {
  it('rates a widely depended-on module as higher risk than a leaf', async () => {
    const files: Record<string, string> = {
      'package.json': '{"name":"t"}',
      'src/core.ts': 'export const core = () => 1;\n',
      'src/leaf.ts': 'export const leaf = () => 1;\n',
    };
    for (let index = 0; index < 12; index += 1) {
      files[`src/user${index}.ts`] =
        `import { core } from './core';\nexport const u${index} = () => core();\n`;
    }
    project = TempProject.create(files);

    const { context } = await project.analyze();
    const core = analyzeImpact(context, ['src/core.ts']);
    const leaf = analyzeImpact(context, ['src/leaf.ts']);

    expect(core.risk).toBe('high');
    expect(core.impacted).toHaveLength(12);
    expect(leaf.risk).toBe('low');
    expect(leaf.impacted).toHaveLength(0);
  });

  it('lowers confidence when a changed file uses unresolved dynamic imports', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/loader.ts': 'export const load = (n: string) => import(`./plugins/${n}`);\n',
    });

    const { context } = await project.analyze();
    const report = analyzeImpact(context, ['src/loader.ts']);

    expect(report.confidence).toBe('medium');
    expect(report.confidenceNote).toMatch(/dynamic/);
  });

  it('lists external packages the changed files talk to', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"stripe":"14"}}',
      'src/pay.ts': "import Stripe from 'stripe';\nexport const pay = () => new Stripe('k');\n",
    });

    const { context } = await project.analyze();
    expect(analyzeImpact(context, ['src/pay.ts']).externals).toEqual(['stripe']);
  });
});

/**
 * Unused exports.
 *
 * Narrower than the file-level search on purpose: it only judges files that
 * something already imports, and it goes silent for any module reached through
 * a wildcard, because those leave no record of which name was wanted.
 */
describe('unused exports', () => {
  it('reports an exported name nothing imports', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"exports"}',
      'src/utils.ts': 'export const used = 1;\nexport const forgotten = 2;\n',
      'src/app.ts': "import { used } from './utils';\nexport const app = used;\n",
      'src/main.ts': "import { app } from './app';\nconsole.log(app);\n",
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);
      const utils = report.unusedExports.find((entry) => entry.file === 'src/utils.ts');

      expect(utils?.names).toEqual(['forgotten']);
    } finally {
      project.cleanup();
    }
  });

  it('counts a renamed import as usage', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"aliased"}',
      'src/utils.ts': 'export const original = 1;\n',
      'src/app.ts': "import { original as renamed } from './utils';\nexport const app = renamed;\n",
      'src/main.ts': "import { app } from './app';\nconsole.log(app);\n",
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);

      expect(report.unusedExports.some((entry) => entry.file === 'src/utils.ts')).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('stays silent about a module someone imports wholesale', async () => {
    // `import * as` could reach any name, so nothing can be ruled out.
    const project = TempProject.create({
      'package.json': '{"name":"namespace"}',
      'src/utils.ts': 'export const a = 1;\nexport const b = 2;\n',
      'src/app.ts': "import * as utils from './utils';\nexport const app = utils.a;\n",
      'src/main.ts': "import { app } from './app';\nconsole.log(app);\n",
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);

      expect(report.unusedExports.some((entry) => entry.file === 'src/utils.ts')).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('stays silent about a module a barrel re-exports wholesale', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"barrel"}',
      'src/utils.ts': 'export const a = 1;\nexport const b = 2;\n',
      'src/index.ts': "export * from './utils';\n",
      'src/main.ts': "import { a } from './index';\nconsole.log(a);\n",
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);

      expect(report.unusedExports.some((entry) => entry.file === 'src/utils.ts')).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('does not name exports of a file nothing imports at all', async () => {
    // That file is reported whole, by the file-level search.
    const project = TempProject.create({
      'package.json': '{"name":"orphan"}',
      'src/app.ts': 'export const app = 1;\n',
      'src/orphan.ts': 'export const lonely = 1;\n',
      'src/main.ts': "import { app } from './app';\nconsole.log(app);\n",
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);

      expect(report.unusedExports.some((entry) => entry.file === 'src/orphan.ts')).toBe(false);
      expect(report.candidates.some((entry) => entry.path === 'src/orphan.ts')).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('leaves Python and Go alone', async () => {
    // Their export detection is too shallow to say "nobody uses this name".
    const project = TempProject.create({
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'cmd/main.go':
        'package main\n\nimport "example.com/app/internal/store"\n\nfunc main() { store.Open() }\n',
      'internal/store/store.go':
        'package store\n\nfunc Open() int { return 1 }\n\nfunc NeverCalled() int { return 2 }\n',
    });
    try {
      const { context } = await project.analyze();
      const report = findDeadCode(context);

      expect(report.unusedExports).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});
