import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findingsFor } from './helpers.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

const bigFunction = (name: string, lines: number): string => {
  const body = Array.from({ length: lines }, (_, index) => `  const v${index} = ${index};`).join(
    '\n',
  );
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
};

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

/**
 * The scan slides an N-line window, so a copy-pasted region matches at every
 * offset inside it. Those overlapping matches have to collapse back into one
 * region, or a single problem is reported a couple of dozen times.
 */
describe('duplicate blocks', () => {
  const region = Array.from(
    { length: 20 },
    (_, index) => `  const value${index} = compute(${index}) + offset;`,
  ).join('\n');

  it('reports one long region rather than every window inside it', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"dupes"}',
      'src/a.ts': `export function a(compute: (n: number) => number, offset: number) {\n${region}\n  return value0;\n}\n`,
      'src/b.ts': `export function b(compute: (n: number) => number, offset: number) {\n${region}\n  return value1;\n}\n`,
    });
    try {
      const { result } = await project.analyze();
      const findings = findingsFor(result.findings, 'maintainability/duplicate-block');

      expect(findings).toHaveLength(1);
      // The title carries the real length, not the window size.
      expect(findings[0]?.title).toMatch(/^20 identical lines repeated 2 times$/);
      expect(findings[0]?.detail).toEqual(['src/a.ts:2', 'src/b.ts:2']);
    } finally {
      project.cleanup();
    }
  });

  it('keeps two separate regions separate', async () => {
    const other = Array.from(
      { length: 12 },
      (_, index) => `  const other${index} = lookup("${index}") ?? fallback;`,
    ).join('\n');

    const project = TempProject.create({
      'package.json': '{"name":"dupes"}',
      'src/a.ts': `export function a(compute: (n: number) => number, offset: number, lookup: (k: string) => string, fallback: string) {\n${region}\n  const gap = 1;\n${other}\n  return gap;\n}\n`,
      'src/b.ts': `export function b(compute: (n: number) => number, offset: number, lookup: (k: string) => string, fallback: string) {\n${region}\n  const other = 2;\n${other}\n  return other;\n}\n`,
    });
    try {
      const { result } = await project.analyze();
      const findings = findingsFor(result.findings, 'maintainability/duplicate-block');

      expect(findings.length).toBeGreaterThanOrEqual(2);
    } finally {
      project.cleanup();
    }
  });

  it('says nothing when the code is merely similar', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"distinct"}',
      'src/a.ts': 'export const a = (n: number) => n * 2;\n',
      'src/b.ts': 'export const b = (n: number) => n * 3;\n',
    });
    try {
      const { result } = await project.analyze();
      expect(findingsFor(result.findings, 'maintainability/duplicate-block')).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});

describe('layer coverage', () => {
  /** Ten UI files, and `helpers` files that no layer claims. */
  const projectWith = (unlayeredCount: number): Record<string, string> => {
    const files: Record<string, string> = {
      'package.json': '{"name":"coverage"}',
      'src/services/orders.ts': 'export const list = () => [];\n',
    };
    for (let index = 0; index < 10; index += 1) {
      files[`src/components/C${index}.tsx`] =
        "import { list } from '../services/orders';\nexport const C = () => list();\n";
    }
    for (let index = 0; index < unlayeredCount; index += 1) {
      files[`src/helpers/h${index}.ts`] = `export const h${index} = () => ${index};\n`;
    }
    return files;
  };

  it('stays quiet when the layers reach the whole project', async () => {
    project = TempProject.create(projectWith(0));
    const { result } = await project.analyze();

    expect(result.stats.layeredFiles).toBe(result.stats.files);
    expect(findingsFor(result.findings, 'architecture/unlayered-code')).toEqual([]);
    expect(result.metrics.architecture).toBe(100);
  });

  it('withholds architecture points for code no layer covers', async () => {
    project = TempProject.create(projectWith(20));
    const { result } = await project.analyze();

    // 11 of 31 files are unlayered, so boundary rules saw about a third of it.
    expect(result.stats.layeredFiles).toBeLessThan(result.stats.files);
    expect(result.metrics.architecture).toBeLessThan(100);

    const [finding] = findingsFor(result.findings, 'architecture/unlayered-code');
    expect(finding?.severity).toBe('info');
    expect(finding?.detail?.some((line) => line.startsWith('src/helpers'))).toBe(true);
    // The points withheld are stated, not silently deducted.
    expect(finding?.message).toContain('points lower');
  });

  it('says so rather than docking points when nothing looks like a layer', async () => {
    project = TempProject.create({
      'package.json': '{"name":"flat"}',
      'src/one.ts': 'export const one = 1;\n',
      'src/two.ts': "import { one } from './one';\nexport const two = one + 1;\n",
    });
    const { result } = await project.analyze();

    expect(result.metrics.architecture).toBe(100);
    const [finding] = findingsFor(result.findings, 'architecture/unlayered-code');
    expect(finding?.title).toBe('No layered structure to check');
  });

  it('does not judge coverage against a single layer', async () => {
    // One layer has no boundaries to cross, so "how much is covered" is not a
    // question about it — and must not cost the project points.
    project = TempProject.create({
      'package.json': '{"name":"one-layer"}',
      'src/core/engine.ts': 'export const run = () => 1;\n',
      'src/loose/a.ts': 'export const a = 1;\n',
      'src/loose/b.ts': 'export const b = 2;\n',
      'src/loose/c.ts': 'export const c = 3;\n',
    });
    const { result } = await project.analyze();

    expect(result.stats.layeredFiles).toBe(0);
    expect(result.metrics.architecture).toBe(100);
    expect(findingsFor(result.findings, 'architecture/unlayered-code')[0]?.title).toBe(
      'No layered structure to check',
    );
  });
});

describe('javascript in a typescript project', () => {
  it('flags a plain .js source file that should have been typed', async () => {
    project = TempProject.create({
      'package.json': '{"name":"mixed","devDependencies":{"typescript":"^5"}}',
      'tsconfig.json': '{"compilerOptions":{"allowJs":true}}',
      'src/typed.ts': 'export const a = 1;\n',
      'src/untyped.js': 'export const b = 2;\n',
    });
    const { result } = await project.analyze();

    const [finding] = findingsFor(result.findings, 'type-safety/js-in-ts-project');
    expect(finding?.detail).toEqual(['src/untyped.js']);
    expect(result.stats.jsFilesInTsProject).toBe(1);
  });

  it('leaves alone the files that have to be JavaScript', async () => {
    project = TempProject.create({
      'package.json': '{"name":"tooling","devDependencies":{"typescript":"^5"}}',
      'tsconfig.json': '{"compilerOptions":{"allowJs":true}}',
      'src/typed.ts': 'export const a = 1;\n',
      // Run directly by node, served verbatim, or read by a tool.
      'scripts/build.mjs': 'export const build = () => 1;\n',
      'scripts/legacy.cjs': 'module.exports = 1;\n',
      'public/sw.js': 'self.addEventListener("fetch", () => {});\n',
      'jest.setup.js': 'globalThis.x = 1;\n',
      'next.config.js': 'module.exports = {};\n',
    });
    const { result } = await project.analyze();

    expect(findingsFor(result.findings, 'type-safety/js-in-ts-project')).toEqual([]);
    // The score has to agree with the report, or it penalises invisible files.
    expect(result.stats.jsFilesInTsProject).toBe(0);
    expect(result.metrics.typeSafety).toBe(100);
  });
});
