import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/core/analyze.js';
import { ParseCache } from '../src/core/cache.js';
import { MAX_SCANNED_FILES } from '../src/core/scan.js';
import { resolveConfig, ensureLocalGitignore } from '../src/config/load.js';
import {
  isImplicitlyUsed,
  undeclaredPackages,
  unusedDependencies,
} from '../src/detect/dependencies.js';
import { renderDependencies, renderHealth, renderTruncationNotice } from '../src/output/report.js';
import { checkToJson } from '../src/output/json.js';
import { findingsFor } from './helpers.js';
import { TempProject } from './temp-project.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

/**
 * The `unused-dependency` rule and the `little-owl dependencies` report used to
 * decide separately whether a package counted as used, so the same project
 * could be told its dependencies "line up" by one and that eslint was unused by
 * the other. Both now go through `src/detect/dependencies.ts`.
 */
describe('dependency usage', () => {
  const TOOLING = ['eslint', 'prettier', 'tsup', 'vitest', '@vitest/coverage-v8', '@types/node'];

  it('treats packages that work without being imported as used', () => {
    for (const name of TOOLING) {
      expect(isImplicitlyUsed(name)).toBe(true);
    }
    expect(isImplicitlyUsed('lodash')).toBe(false);
    expect(isImplicitlyUsed('left-pad')).toBe(false);
  });

  it('keeps the allowlist out of the unused list', () => {
    const declared = Object.fromEntries(
      [...TOOLING, 'lodash', 'zod'].map((name) => [name, '^1.0.0']),
    );
    expect(unusedDependencies(declared, new Set(['zod']))).toEqual(['lodash']);
  });

  it('does not call a Node builtin an undeclared package', () => {
    expect(undeclaredPackages(['node:fs', 'path', 'zod'], {})).toEqual(['zod']);
  });

  it('gives the rule and the report the same answer', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 'hygiene',
        dependencies: { lodash: '^4.0.0', zod: '^3.0.0' },
        devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0', vitest: '^3.0.0' },
      }),
      'src/index.ts': "import { z } from 'zod';\nexport const schema = z;\n",
    });

    const { result, context } = await project.analyze();
    const finding = findingsFor(result.findings, 'dependencies/unused-dependency')[0];
    const report = renderDependencies(context);

    // Genuinely unused: both must say so.
    expect(finding?.detail).toEqual(['lodash']);
    expect(report).toContain('lodash');

    // Build tooling: neither may call it unused.
    for (const name of ['eslint', 'prettier', 'vitest']) {
      expect(finding?.detail ?? []).not.toContain(name);
      expect(report).not.toContain(name);
    }
  });
});

/**
 * A scan that stops at the file limit used to look exactly like a complete
 * one, so every score described part of the repository while claiming to
 * describe all of it.
 */
describe('scan truncation', () => {
  function manyFiles(count: number): Record<string, string> {
    const files: Record<string, string> = { 'package.json': '{"name":"wide"}' };
    for (let index = 0; index < count; index += 1) {
      files[`src/m${index}.ts`] = `export const value${index} = ${index};\n`;
    }
    return files;
  }

  it('reports a complete scan as complete', async () => {
    project = TempProject.create(manyFiles(4));
    const { result } = await project.analyze();
    expect(result.truncated).toBe(false);
  });

  it('says so when the scan stopped early', async () => {
    project = TempProject.create(manyFiles(10));
    const { result } = await analyzeProject({
      root: project.root,
      config: resolveConfig({}),
      cache: false,
      maxFiles: 4,
    });

    expect(result.truncated).toBe(true);
    expect(result.project.fileCount).toBe(4);
  });

  it('puts the warning in the report and in the JSON', async () => {
    project = TempProject.create(manyFiles(10));
    const { result } = await analyzeProject({
      root: project.root,
      config: resolveConfig({}),
      cache: false,
      maxFiles: 4,
    });

    expect(renderHealth(result)).toContain(MAX_SCANNED_FILES.toLocaleString());
    expect(checkToJson(result, '0.0.0').truncated).toBe(true);
  });

  it('leaves a complete report free of the warning', async () => {
    project = TempProject.create(manyFiles(4));
    const { result } = await project.analyze();

    expect(renderHealth(result)).not.toContain(renderTruncationNotice());
    expect(checkToJson(result, '0.0.0').truncated).toBe(false);
  });
});

/**
 * The parse cache is machine state. It used to be written into a directory
 * with no ignore file unless the developer had run `init`, which is how a cache
 * fixture ended up committed to this very repository.
 */
describe('local state stays out of git', () => {
  const ignorePath = (root: string): string => path.join(root, '.little-owl', '.gitignore');

  it('writes an ignore file the first time the cache is saved', () => {
    project = TempProject.create({ 'src/a.ts': 'export const a = 1;\n' });

    const cache = ParseCache.open(project.root);
    const file = project.path('src/a.ts');
    cache.set('src/a.ts', fs.statSync(file), {
      path: 'src/a.ts',
      absPath: file,
      language: 'typescript',
      hash: 'abc',
      lines: 1,
      sloc: 1,
      imports: [],
      functions: [],
      exports: ['a'],
      markers: [],
      isTest: false,
      meta: {},
    });
    cache.save(new Set(['src/a.ts']));

    const ignored = fs.readFileSync(ignorePath(project.root), 'utf8');
    expect(ignored).toContain('cache/');
    expect(ignored).toContain('history.json');
  });

  it('adds only what is missing to an ignore file that already exists', () => {
    project = TempProject.create({ 'src/a.ts': 'export const a = 1;\n' });
    fs.mkdirSync(path.join(project.root, '.little-owl'), { recursive: true });
    fs.writeFileSync(ignorePath(project.root), '# mine\ncache/\nnotes.md\n');

    ensureLocalGitignore(project.root);

    const ignored = fs.readFileSync(ignorePath(project.root), 'utf8');
    expect(ignored).toContain('# mine');
    expect(ignored).toContain('notes.md');
    expect(ignored).toContain('history.json');
    // The entry that was already there must not be repeated.
    expect(ignored.split('\n').filter((line) => line.trim() === 'cache/')).toHaveLength(1);
  });

  it('is idempotent', () => {
    project = TempProject.create({ 'src/a.ts': 'export const a = 1;\n' });

    ensureLocalGitignore(project.root);
    const first = fs.readFileSync(ignorePath(project.root), 'utf8');
    ensureLocalGitignore(project.root);

    expect(fs.readFileSync(ignorePath(project.root), 'utf8')).toBe(first);
  });
});
