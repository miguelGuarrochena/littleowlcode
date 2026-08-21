import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/core/analyze.js';
import { ParseCache } from '../src/core/cache.js';
import { MAX_SCANNED_FILES, scanFiles } from '../src/core/scan.js';
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
import { detectChanges } from '../src/git/git.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

/**
 * The `unused-dependency` rule and the `little-owl dependencies` report answer
 * the same question, so they share `src/detect/dependencies.ts` and cannot
 * disagree about a package.
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
 * A scan that stops at the file limit describes part of the repository. Saying
 * so is the difference between a sample and a measurement.
 */
describe('scan truncation', () => {
  const manyFiles = (count: number): Record<string, string> => {
    const files: Record<string, string> = { 'package.json': '{"name":"wide"}' };
    for (let index = 0; index < count; index += 1) {
      files[`src/m${index}.ts`] = `export const value${index} = ${index};\n`;
    }
    return files;
  };

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
 * The parse cache is machine state and has no business in version control, so
 * the ignore file has to exist whether or not `init` was ever run.
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

/**
 * Findings a real project would reject.
 *
 * Pinned because a false positive at error level costs more trust than the
 * true findings around it earn.
 */
describe('false positives found while dogfooding', () => {
  it('does not flag a client component for calling a server action', async () => {
    // The Server Actions pattern: the directive exists so client components
    // can call the module. Next.js replaces the import with an RPC reference.
    project = TempProject.create({
      'package.json': JSON.stringify({ name: 'next-app', dependencies: { next: '^15.0.0' } }),
      'src/lib/actions.ts':
        '"use server";\n\nexport async function signIn(email: string) {\n  return email;\n}\n',
      'src/app/login/page.tsx':
        '"use client";\n\nimport { signIn } from "../../lib/actions";\n' +
        'export default function Login() {\n  return <button onClick={() => signIn("a")}>go</button>;\n}\n',
    });

    const { result } = await project.analyze();
    expect(findingsFor(result.findings, 'next/server-import-in-client')).toEqual([]);
  });

  it('still flags a client component importing a server-only package', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({ name: 'next-app', dependencies: { next: '^15.0.0' } }),
      'src/app/leaky/page.tsx':
        '"use client";\n\nimport fs from "node:fs";\nexport default function Page() {\n' +
        '  return <div>{fs.readdirSync(".").length}</div>;\n}\n',
    });

    const { result } = await project.analyze();
    const findings = findingsFor(result.findings, 'next/server-import-in-client');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toEqual(['imports node:fs']);
  });

  it('does not call a stylesheet or image import an unresolved module', async () => {
    project = TempProject.create({
      'package.json': '{"name":"assets"}',
      'src/app/globals.css': 'body { margin: 0; }',
      'src/app/layout.tsx':
        'import "./globals.css";\nimport logo from "../../public/logo.png";\n' +
        'export default function Layout() {\n  return <img src={logo} alt="" />;\n}\n',
    });

    const { result, context } = await project.analyze();
    expect(context.graph.unresolved).toEqual([]);
    expect(findingsFor(result.findings, 'maintainability/unresolved-import')).toEqual([]);
  });

  it('counts a package as used when only its stylesheet is imported', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 'assets',
        dependencies: { bootstrap: '^5.0.0' },
      }),
      'src/main.ts': 'import "bootstrap/dist/css/bootstrap.min.css";\nexport const app = 1;\n',
    });

    const { result, context } = await project.analyze();
    expect([...context.graph.externalPackages()]).toContain('bootstrap');
    expect(findingsFor(result.findings, 'dependencies/unused-dependency')).toEqual([]);
  });

  it('does not report react-dom as unused', async () => {
    project = TempProject.create({
      'package.json': JSON.stringify({
        name: 'react-app',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      }),
      'src/app.tsx':
        'import { useState } from "react";\nexport const useThing = () => useState(0);\n',
    });

    const { result } = await project.analyze();
    const finding = findingsFor(result.findings, 'dependencies/unused-dependency')[0];
    expect(finding?.detail ?? []).not.toContain('react-dom');
  });
});

/**
 * With nothing scanned every metric sits at 100, because there is nothing to
 * lose points for. That number must never reach the reader as a score.
 */
describe('empty analysis', () => {
  it('reports that nothing was analysed instead of a perfect score', async () => {
    project = TempProject.create({ 'package.json': '{"name":"empty"}', 'README.md': '# nothing' });

    const { result } = await project.analyze();
    expect(result.project.fileCount).toBe(0);

    const rendered = renderHealth(result);
    expect(rendered).toContain('No source files were analysed');
    expect(rendered).not.toContain('100 / 100');
  });

  it('scans source files that are symlinks', () => {
    // Homebrew-style layouts and some package managers link individual source
    // files into place. Skipping them reported the project as empty.
    project = TempProject.create({
      'package.json': '{"name":"linked"}',
      'real/module.ts': 'export const value = 1;\n',
    });
    fs.mkdirSync(project.path('src'), { recursive: true });
    fs.symlinkSync(project.path('real/module.ts'), project.path('src/linked.ts'));

    const { files } = scanFiles(project.root, resolveConfig({ ignore: ['real/**'] }));
    expect(files).toContain('src/linked.ts');
  });

  it('ignores a broken symlink rather than failing', () => {
    const broken = TempProject.create({ 'package.json': '{"name":"broken"}' });
    project = broken;
    fs.mkdirSync(broken.path('src'), { recursive: true });
    fs.symlinkSync(broken.path('src/nowhere.ts'), broken.path('src/dangling.ts'));

    expect(() => scanFiles(broken.root, resolveConfig({}))).not.toThrow();
    expect(scanFiles(broken.root, resolveConfig({})).files).toEqual([]);
  });
});

/**
 * The parse cache stores `ParsedFile` as JSON and reuses it across runs, so a
 * field added to that shape has to survive the round trip. An entry written
 * before the field existed has to be discarded rather than reused, or the
 * rules reading that field silently see nothing.
 */
describe('parse cache and the shape it stores', () => {
  it('preserves the names an import takes from a module', async () => {
    project = TempProject.create({
      'package.json': '{"name":"round-trip"}',
      'src/utils.ts': 'export const a = 1;\nexport const b = 2;\n',
      'src/app.ts': "import { a as renamed } from './utils';\nexport const app = renamed;\n",
    });

    // First run populates the cache from a real parse.
    await analyzeProject({ root: project.root, config: resolveConfig({}) });

    // Second run answers entirely from disk.
    const { context } = await analyzeProject({ root: project.root, config: resolveConfig({}) });
    const app = context.fileMap.get('src/app.ts');
    const reference = app?.imports.find((entry) => entry.resolved === 'src/utils.ts');

    expect(reference?.names).toEqual(['a']);
    expect(reference?.wildcard).toBeUndefined();
  });

  it('records a namespace import as taking the whole module', async () => {
    project = TempProject.create({
      'package.json': '{"name":"wildcard"}',
      'src/utils.ts': 'export const a = 1;\n',
      'src/app.ts': "import * as utils from './utils';\nexport const app = utils.a;\n",
    });

    const { context } = await analyzeProject({
      root: project.root,
      config: resolveConfig({}),
      cache: false,
    });
    const reference = context.fileMap
      .get('src/app.ts')
      ?.imports.find((entry) => entry.resolved === 'src/utils.ts');

    expect(reference?.wildcard).toBe(true);
  });
});

/**
 * Findings from running the published package against real projects.
 */
describe('changed-file reporting', () => {
  it('leaves installed dependencies and tool output out of a change', () => {
    // `git ls-files --others` honours .gitignore, so a project without one
    // reports every installed file as untracked. A seven-file edit then reads
    // as "235 files changed".
    project = TempProject.create({
      'package.json': '{"name":"noisy"}',
      'src/a.ts': 'export const a = 1;\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'playwright-report/index.html': '<html></html>',
      'test-results/results.json': '{}',
      'dist/bundle.js': 'var a=1;\n',
    });
    project.git(['init', '-q']);
    project.git(['config', 'user.email', 'test@example.com']);
    project.git(['config', 'user.name', 'Test']);

    const changes = detectChanges(project.root);
    const paths = changes?.files.map((file) => file.path) ?? [];

    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('package.json');
    for (const noise of ['node_modules', 'playwright-report', 'test-results', 'dist']) {
      expect(paths.some((path) => path.startsWith(noise))).toBe(false);
    }
  });

  it('does not offer tool output as a place to look for source', async () => {
    // `init` used to list every top-level directory, so a Playwright project
    // was invited to treat its HTML report as project code.
    project = TempProject.create({
      'package.json': '{"name":"picky"}',
      'src/a.ts': 'export const a = 1;\n',
      'supabase/fn.ts': 'export const fn = 1;\n',
      'playwright-report/index.html': '<html></html>',
      'test-results/out.json': '{}',
    });

    const { context } = await project.analyze();
    const directories = new Set(
      context.files.map((file) => file.path.split('/')[0]).filter((top) => top),
    );

    expect([...directories].sort()).toEqual(['src', 'supabase']);
  });
});
