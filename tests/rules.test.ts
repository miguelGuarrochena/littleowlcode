import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findingsFor } from './helpers.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

function bigFunction(name: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `  const v${index} = ${index};`).join(
    '\n',
  );
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
}

describe('complexity rules', () => {
  it('reports files and functions past their budget', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/huge.ts': bigFunction('huge', 150),
    });

    const { result } = await project.analyze({
      thresholds: { maxFileLines: 100, maxFunctionLines: 50 },
    });

    expect(findingsFor(result.findings, 'complexity/large-file')).toHaveLength(1);
    const large = findingsFor(result.findings, 'complexity/large-function');
    expect(large).toHaveLength(1);
    expect(large[0]!.title).toContain('huge()');
    expect(large[0]!.current).toBe(153);
  });

  it('counts branches, not lines, for complexity', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/branchy.ts': `export function branchy(n: number) {
  if (n > 1) return 1;
  if (n > 2 && n < 9) return 2;
  for (const x of [1]) { if (x) return x; }
  switch (n) { case 1: return 1; case 2: return 2; }
  return n > 3 ? 4 : 5;
}
`,
    });

    const { context } = await project.analyze();
    const fn = context.fileMap.get('src/branchy.ts')!.functions[0]!;
    expect(fn.complexity).toBeGreaterThan(8);
    expect(fn.name).toBe('branchy');
  });

  it('measures a React component with the component budget, not the function one', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"react":"18"}}',
      'src/Widget.tsx': `export function Widget() {
${Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join('\n')}
  return <div>hi</div>;
}
`,
    });

    const { result, context } = await project.analyze({
      thresholds: { maxFunctionLines: 10, maxComponentLines: 200 },
    });

    expect(context.fileMap.get('src/Widget.tsx')!.functions[0]!.isComponent).toBe(true);
    expect(findingsFor(result.findings, 'complexity/large-function')).toHaveLength(0);
    expect(findingsFor(result.findings, 'complexity/large-component')).toHaveLength(0);
  });
});

describe('type-safety rules', () => {
  it('flags a cluster of `any` but tolerates a couple', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `export const v${i}: any = ${i};`).join('\n');
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'tsconfig.json': '{}',
      'src/loose.ts': many,
      'src/tight.ts': 'export const a: any = 1;\nexport const b = 2;\n',
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'type-safety/explicit-any');

    expect(findings.map((finding) => finding.file)).toEqual(['src/loose.ts']);
    expect(findings[0]!.current).toBe(12);
  });

  it('only counts directives in comments, not code that talks about them', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'tsconfig.json': '{}',
      // A rule engine describing suppressions must not flag itself.
      'src/docs.ts': [
        "export const label = '@ts-ignore suppression';",
        '/** Explains what @ts-ignore does, without using it. */',
        'export const explain = () => label;',
      ].join('\n'),
      'src/real.ts': '// @ts-ignore\nexport const a: number = 1;\n',
    });

    const { result, context } = await project.analyze();

    expect(context.fileMap.get('src/docs.ts')!.markers).toHaveLength(0);
    const findings = findingsFor(result.findings, 'type-safety/suppression');
    expect(findings.map((finding) => finding.file)).toEqual(['src/real.ts']);
  });

  it('reports @ts-ignore but not @ts-expect-error', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'tsconfig.json': '{}',
      'src/a.ts': '// @ts-ignore\nexport const a = 1;\n// @ts-expect-error\nexport const b = 2;\n',
    });

    const { result } = await project.analyze();
    expect(findingsFor(result.findings, 'type-safety/suppression')).toHaveLength(1);
  });

  it('only flags assertions that bypass the type system', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'tsconfig.json': '{}',
      'src/a.ts': `const raw: unknown = 1;
export const safe = raw as number;
export const loose = raw as any;
export const laundered = raw as unknown as string;
`,
    });

    const { result, context } = await project.analyze();
    const markers = context.fileMap
      .get('src/a.ts')!
      .markers.filter((m) => m.kind === 'unsafe-assertion');

    expect(markers).toHaveLength(2);
    expect(findingsFor(result.findings, 'type-safety/unsafe-assertion')).toHaveLength(1);
  });
});

describe('framework rules', () => {
  it('flags a client component importing server-only code', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"next":"15"}}',
      'src/Client.tsx': `'use client';
import fs from 'node:fs';

export function Client() {
  return <div>{String(fs)}</div>;
}
`,
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'next/server-import-in-client');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
  });

  it('flags effects with no dependency array', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t","dependencies":{"react":"18"}}',
      'src/Comp.tsx': `import { useEffect } from 'react';

export function Comp() {
  useEffect(() => { console.log('every render'); });
  useEffect(() => { console.log('once'); }, []);
  return <div />;
}
`,
    });

    const { result } = await project.analyze({ strictness: 'strict' });
    const findings = findingsFor(result.findings, 'react/effect-dependency-risk');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.current).toBe(1);
  });
});

describe('dependency rules', () => {
  it('flags packages declared in both dependency lists', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { lodash: '^4.0.0' },
        devDependencies: { lodash: '^3.0.0' },
      }),
      'src/a.ts': "import _ from 'lodash';\nexport const x = _;\n",
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'dependencies/duplicate-dependency');

    expect(findings).toHaveLength(1);
    expect(findings[0]!.current).toEqual(['lodash']);
  });

  it('reports declared dependencies that are never imported', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { lodash: '^4.0.0', '@types/node': '^22.0.0' },
      }),
      'src/a.ts': 'export const x = 1;\n',
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'dependencies/unused-dependency');

    // `@types/*` is never imported by design and must not be reported.
    expect(findings[0]!.current).toEqual(['lodash']);
  });
});

describe('rule severity configuration', () => {
  it('honours per-rule overrides, including turning a rule off', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
    });

    const on = await project.analyze();
    expect(findingsFor(on.result.findings, 'architecture/circular-dependency')).toHaveLength(1);

    const off = await project.analyze({ rules: { 'architecture/circular-dependency': 'off' } });
    expect(findingsFor(off.result.findings, 'architecture/circular-dependency')).toHaveLength(0);

    const info = await project.analyze({ rules: { 'architecture/circular-dependency': 'info' } });
    expect(findingsFor(info.result.findings, 'architecture/circular-dependency')[0]!.severity).toBe(
      'info',
    );
  });

  it('ignores type-only imports when looking for cycles', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'tsconfig.json': '{}',
      'src/a.ts': "import type { B } from './b';\nexport type A = { b?: B };\n",
      'src/b.ts':
        "import { a } from './a';\nexport type B = { a: typeof a };\nexport const a = 1;\n",
    });

    const { context } = await project.analyze();
    expect(context.cycles).toHaveLength(0);
  });
});
