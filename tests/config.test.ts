import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { loadConfig, resolveConfig, findConfigFile } from '../src/config/load.js';
import { THRESHOLD_PRESETS } from '../src/config/defaults.js';
import { scanFiles } from '../src/core/scan.js';
import { ParseCache } from '../src/core/cache.js';
import { readVersion } from '../src/utils/version.js';
import { analyzeProject } from '../src/core/analyze.js';
import {
  buildLayerModel,
  inferLayers,
  layerOf,
  classifyLayerDependency,
} from '../src/architecture/layers.js';
import { renderConfigFile } from '../src/cli/commands/init.js';

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

describe('configuration', () => {
  it('falls back to balanced defaults when there is no config file', async () => {
    project = TempProject.create({ 'package.json': '{"name":"t"}' });
    const config = await loadConfig(project.root);

    expect(config.strictness).toBe('balanced');
    expect(config.sourcePath).toBeNull();
    expect(config.thresholds).toEqual(THRESHOLD_PRESETS.balanced);
  });

  it('loads a TypeScript config file', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      '.little-owl/config.ts': `export default {
  strictness: 'strict',
  thresholds: { maxFileLines: 123 },
  rules: { 'complexity/large-file': 'error' },
};
`,
    });

    const config = await loadConfig(project.root);

    expect(findConfigFile(project.root)).toContain('.little-owl/config.ts');
    expect(config.strictness).toBe('strict');
    expect(config.thresholds.maxFileLines).toBe(123);
    // Unspecified thresholds still come from the chosen preset.
    expect(config.thresholds.maxComplexity).toBe(THRESHOLD_PRESETS.strict.maxComplexity);
    expect(config.rules['complexity/large-file']).toBe('error');
  });

  it('loads a JSON config file', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      '.little-owl/config.json': '{"strictness":"relaxed"}',
    });

    const config = await loadConfig(project.root);
    expect(config.strictness).toBe('relaxed');
    expect(config.thresholds).toEqual(THRESHOLD_PRESETS.relaxed);
  });

  it('changes rule severities with strictness', () => {
    expect(resolveConfig({ strictness: 'relaxed' }).rules['architecture/layer-skip']).toBe('info');
    expect(resolveConfig({ strictness: 'balanced' }).rules['architecture/layer-skip']).toBe(
      'warning',
    );
    expect(resolveConfig({ strictness: 'strict' }).rules['architecture/layer-skip']).toBe('error');
  });

  it('generates a config file that parses back to the same settings', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      '.little-owl/config.ts': renderConfigFile({
        strictness: 'strict',
        include: ['app/**'],
        layers: { ui: ['app'], data: ['lib/db'] },
      }).replace("from 'little-owl-code'", "from 'little-owl-code-stub'"),
      'node_modules/little-owl-code-stub/index.js': 'export const defineConfig = (c) => c;\n',
      'node_modules/little-owl-code-stub/package.json':
        '{"name":"little-owl-code-stub","type":"module","main":"index.js"}',
    });

    const config = await loadConfig(project.root);
    expect(config.strictness).toBe('strict');
    expect(config.include).toEqual(['app/**']);
    expect(config.architecture.layers).toEqual({ ui: ['app'], data: ['lib/db'] });
  });
});

describe('file scanning', () => {
  it('skips ignored directories and honours include patterns', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': 'export const a = 1;\n',
      'scripts/b.ts': 'export const b = 1;\n',
      'dist/c.js': 'export const c = 1;\n',
      'node_modules/pkg/d.js': 'export const d = 1;\n',
    });

    const all = scanFiles(project.root, resolveConfig({}));
    expect(all.files).toEqual(['scripts/b.ts', 'src/a.ts']);

    const onlySrc = scanFiles(project.root, resolveConfig({ include: ['src/**'] }));
    expect(onlySrc.files).toEqual(['src/a.ts']);

    const withoutScripts = scanFiles(project.root, resolveConfig({ ignore: ['scripts/**'] }));
    expect(withoutScripts.files).toEqual(['src/a.ts']);
  });

  it('respects .gitignore', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      '.gitignore': 'generated\n',
      'src/a.ts': 'export const a = 1;\n',
      'generated/b.ts': 'export const b = 1;\n',
    });

    expect(scanFiles(project.root, resolveConfig({})).files).toEqual(['src/a.ts']);
  });
});

describe('parse cache', () => {
  it('reuses parsed files until they change, and drops deleted ones', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': 'export const a = 1;\n',
    });

    const cache = ParseCache.open(project.root);
    await analyzeProject({ root: project.root, cache });
    expect(cache.size).toBe(1);

    // A second run over unchanged files must produce the same result.
    const second = await analyzeProject({ root: project.root, cache });
    expect(second.result.fileMetrics['src/a.ts']!.lines).toBe(2);

    project.write({ 'src/b.ts': 'export const b = 2;\n' });
    const third = await analyzeProject({ root: project.root, cache });
    expect(Object.keys(third.result.fileMetrics).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    project.remove('src/b.ts');
    const fourth = await analyzeProject({ root: project.root, cache });
    expect(Object.keys(fourth.result.fileMetrics)).toEqual(['src/a.ts']);
  });
});

describe('parse cache invalidation', () => {
  it('ignores a cache written by a different version of the tool', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/a.ts': 'export const a = 1;\n',
    });

    const cache = ParseCache.open(project.root);
    await analyzeProject({ root: project.root, cache });
    cache.save(new Set(['src/a.ts']));

    const cacheFile = project.path('.little-owl/cache/parse.json');
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(stored.tool).toBe(readVersion());

    // A stale cache from an older analyser must not be reused: its rules and
    // parsing may have changed.
    fs.writeFileSync(cacheFile, JSON.stringify({ ...stored, tool: '0.0.0-old' }));
    expect(ParseCache.open(project.root).size).toBe(0);
  });
});

describe('layer model', () => {
  it('infers conventional layers from directory names', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'components/A.tsx': 'export const A = 1;\n',
      'services/b.ts': 'export const b = 1;\n',
      'repositories/c.ts': 'export const c = 1;\n',
    });

    const { context } = await project.analyze();
    const model = inferLayers(context.files);

    expect(model.order).toEqual(['ui', 'application', 'infrastructure']);
    expect(layerOf('components/A.tsx', model)).toBe('ui');
    expect(layerOf('repositories/c.ts', model)).toBe('infrastructure');
    expect(layerOf('unrelated/d.ts', model)).toBeNull();
  });

  it('treats Next.js route handlers as server code, not UI', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/app/page.tsx': 'export default function P() { return null; }\n',
      'src/app/api/orders/route.ts': 'export const GET = () => null;\n',
      'src/services/orders.ts': 'export const list = () => [];\n',
    });

    const { context } = await project.analyze();
    expect(layerOf('src/app/page.tsx', context.layers)).toBe('ui');
    expect(layerOf('src/app/api/orders/route.ts', context.layers)).toBe('application');
  });

  it('classifies dependencies according to the layer policy', () => {
    const model = buildLayerModel(
      resolveConfig({
        architecture: {
          layers: { ui: ['app'], application: ['services'], data: ['db'] },
          layerPolicy: 'adjacent',
        },
      }),
      [],
    );

    expect(classifyLayerDependency('ui', 'application', model)).toBe('ok');
    expect(classifyLayerDependency('ui', 'data', model)).toBe('skip');
    expect(classifyLayerDependency('data', 'ui', model)).toBe('inverted');
    expect(classifyLayerDependency('ui', 'ui', model)).toBe('same');
    expect(classifyLayerDependency('ui', null, model)).toBe('unknown');

    const relaxed = buildLayerModel(
      resolveConfig({
        architecture: {
          layers: { ui: ['app'], application: ['services'], data: ['db'] },
          layerPolicy: 'downward',
        },
      }),
      [],
    );
    expect(classifyLayerDependency('ui', 'data', relaxed)).toBe('ok');
  });
});
