import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findingsFor } from './helpers.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

describe('duplicate helpers', () => {
  it('reports the same helper written twice', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': 'export function formatMoney(n: number) {\n  return `$${n.toFixed(2)}`;\n}\n',
      'src/b.ts': 'export function formatMoney(n: number) {\n  return "$" + n.toFixed(2);\n}\n',
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'patterns/duplicate-helper');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('formatMoney');
    expect(findings[0]!.detail).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores framework names that are meant to repeat', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"next":"15"}}',
      'app/a/route.ts': 'export function GET() {\n  return null;\n}\n',
      'app/b/route.ts': 'export function GET() {\n  return null;\n}\n',
    });

    const { result } = await project.analyze();
    expect(findingsFor(result.findings, 'patterns/duplicate-helper')).toHaveLength(0);
  });

  it('ignores a barrel that only re-exports', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/money.ts': 'export function formatMoney(n: number) {\n  return `$${n}`;\n}\n',
      'src/barrel.ts': "export { formatMoney } from './money';\n",
    });

    const { result } = await project.analyze();
    expect(findingsFor(result.findings, 'patterns/duplicate-helper')).toHaveLength(0);
  });
});

describe('parallel implementations', () => {
  const REAL = `export function listOrders() {
  return [1];
}
export function createOrder(n: number) {
  return n;
}
export function deleteOrder(n: number) {
  return n;
}
`;

  it('reports two modules implementing the same names once, not once per name', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/orders.real.ts': REAL,
      'src/orders.copy.ts': REAL,
    });

    const { result } = await project.analyze();
    const parallel = findingsFor(result.findings, 'patterns/parallel-implementations');
    const duplicates = findingsFor(result.findings, 'patterns/duplicate-helper');

    expect(parallel).toHaveLength(1);
    expect(parallel[0]!.detail).toEqual(['createOrder', 'deleteOrder', 'listOrders']);
    // The pair is one situation, so the per-name rule stays quiet.
    expect(duplicates).toHaveLength(0);
  });

  it('stays quiet when a facade selects between the implementations', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/orders.real.ts': REAL,
      'src/orders.demo.ts': REAL,
      'src/orders.ts': `import * as real from './orders.real';
import * as demo from './orders.demo';

export const orders = process.env['DEMO'] ? demo : real;
`,
    });

    const { result } = await project.analyze();

    // A demo/real pair behind a facade is a deliberate design, not a mistake.
    expect(findingsFor(result.findings, 'patterns/parallel-implementations')).toHaveLength(0);
    expect(findingsFor(result.findings, 'patterns/duplicate-helper')).toHaveLength(0);
  });

  it('stays quiet when one implementation delegates to the other', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/orders.demo.ts': REAL,
      'src/orders.real.ts': `import { listOrders as base } from './orders.demo';

export function listOrders() {
  return base();
}
export function createOrder(n: number) {
  return n;
}
export function deleteOrder(n: number) {
  return n;
}
`,
    });

    const { result } = await project.analyze();
    expect(findingsFor(result.findings, 'patterns/parallel-implementations')).toHaveLength(0);
  });
});

describe('thin wrappers', () => {
  it('reports a module that only forwards a call', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/core.ts': 'export function work(n: number) {\n  if (n) return n;\n  return 0;\n}\n',
      'src/wrapper.ts':
        "import { work } from './core';\n\nexport const doWork = (n: number) => work(n);\n",
      'src/app.ts': "import { doWork } from './wrapper';\nexport const run = () => doWork(1);\n",
    });

    const { result } = await project.analyze({ strictness: 'strict' });
    const findings = findingsFor(result.findings, 'patterns/thin-wrapper');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('src/wrapper.ts');
  });

  it('does not report a module that actually does something', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/core.ts': 'export function work(n: number) {\n  return n;\n}\n',
      'src/real.ts': `import { work } from './core';

export function doWork(n: number) {
  if (n < 0) throw new Error('negative');
  return work(n) * 2;
}
`,
      'src/app.ts': "import { doWork } from './real';\nexport const run = () => doWork(1);\n",
    });

    const { result } = await project.analyze({ strictness: 'strict' });
    expect(findingsFor(result.findings, 'patterns/thin-wrapper')).toHaveLength(0);
  });
});

describe('abstraction growth', () => {
  it('reports a directory full of small single-use modules', async () => {
    const files: Record<string, string> = { 'package.json': '{"name":"t"}' };
    const imports: string[] = [];

    for (let index = 0; index < 9; index += 1) {
      files[`src/helpers/h${index}.ts`] = `export const h${index} = (n: number) => n + ${index};\n`;
      imports.push(`import { h${index} } from './helpers/h${index}';`);
    }
    files['src/app.ts'] = `${imports.join('\n')}\n\nexport const run = () => [${Array.from(
      { length: 9 },
      (_, index) => `h${index}(1)`,
    ).join(', ')}];\n`;

    project = TempProject.create(files);
    const { result } = await project.analyze({ strictness: 'strict' });
    const findings = findingsFor(result.findings, 'patterns/abstraction-growth');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('src/helpers/');
  });

  it('does not report a directory of substantial modules', async () => {
    const files: Record<string, string> = { 'package.json': '{"name":"t"}' };
    const imports: string[] = [];

    for (let index = 0; index < 9; index += 1) {
      const body = Array.from({ length: 40 }, (_, line) => `  const v${line} = ${line};`).join(
        '\n',
      );
      files[`src/services/s${index}.ts`] =
        `export function s${index}(n: number) {\n${body}\n  return n;\n}\n`;
      imports.push(`import { s${index} } from './services/s${index}';`);
    }
    files['src/app.ts'] = `${imports.join('\n')}\nexport const run = () => s0(1);\n`;

    project = TempProject.create(files);
    const { result } = await project.analyze({ strictness: 'strict' });
    expect(findingsFor(result.findings, 'patterns/abstraction-growth')).toHaveLength(0);
  });
});
