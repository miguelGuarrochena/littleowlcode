import fs from 'node:fs';
import path from 'node:path';
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
import { validateAgainstProject } from '../src/config/validate.js';

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

/**
 * The documented way in is `npx little-owl-code`, which never installs the
 * package into the project. A generated config that imports the package would
 * therefore load on the maintainer's machine and nowhere else.
 */
describe('a generated config loads without the package installed', () => {
  it('has no import statement at all', () => {
    const written = renderConfigFile({ strictness: 'balanced', include: [], layers: {} });
    // The comment mentions `defineConfig` as an opt-in, so match statements
    // rather than the text — an active import is the thing that breaks.
    const statements = written.split('\n').filter((line) => /^\s*import\s/.test(line));

    expect(statements).toEqual([]);
    expect(written).toContain('export default {');
  });

  it('is loadable straight after init, and every command still works', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"npx-style"}',
      'src/a.ts': 'export const a = 1;\n',
    });

    try {
      // Exactly what `init` writes, in a project with no node_modules at all.
      fs.mkdirSync(path.join(project.root, '.little-owl'), { recursive: true });
      fs.writeFileSync(
        path.join(project.root, '.little-owl', 'config.ts'),
        renderConfigFile({ strictness: 'strict', include: ['src/**'], layers: {} }),
      );

      const config = await loadConfig(project.root);
      expect(config.strictness).toBe('strict');
      expect(config.include).toEqual(['src/**']);

      const { result } = await analyzeProject({ root: project.root, config, cache: false });
      expect(result.project.fileCount).toBe(1);
    } finally {
      project.cleanup();
    }
  });

  it('explains an unresolvable import instead of dumping a require stack', async () => {
    const project = TempProject.create({
      'package.json': '{"name":"broken-config"}',
      '.little-owl/config.ts':
        "import { defineConfig } from 'little-owl-code';\nexport default defineConfig({});\n",
      'src/a.ts': 'export const a = 1;\n',
    });

    try {
      await expect(loadConfig(project.root)).rejects.toThrow(
        /imports 'little-owl-code', which is not installed/,
      );
    } finally {
      project.cleanup();
    }
  });
});

describe('configuration validation', () => {
  it('names settings that do not exist instead of ignoring them silently', () => {
    const config = resolveConfig({
      thresholdz: { maxFileLines: 10 },
      strictness: 'balnced',
      architecture: { layerPolicee: 'adjacent' },
      ci: { failOn: 'sometimes' },
    } as never);

    expect(config.warnings).toEqual([
      'thresholdz is not a Little Owl setting — did you mean "thresholds"?',
      'architecture.layerPolicee is not a Little Owl setting — did you mean "layerPolicy"?',
      'strictness: "balnced" is not valid — use relaxed, balanced, strict.',
      'ci.failOn: "sometimes" is not valid — use warning, error, never.',
    ]);
  });

  it('rejects rule ids that no rule answers to', () => {
    const config = resolveConfig({
      rules: {
        'complexity/large-fil': 'error',
        'architecture/invented': 'error',
        'complexity/large-file': 'error',
      },
    } as never);

    expect(config.warnings).toEqual([
      'rules: "complexity/large-fil" is not a rule, so this severity is ignored — did you mean "complexity/large-file"?',
      'rules: "architecture/invented" is not a rule, so this severity is ignored — see `little-owl config --rules` for the full list.',
    ]);
  });

  it('rejects severities that are not severities', () => {
    const config = resolveConfig({ rules: { 'complexity/large-file': 'loud' } } as never);
    expect(config.warnings).toEqual([
      'rules["complexity/large-file"]: "loud" is not a severity — use off, info, warning, error.',
    ]);
  });

  it('says nothing about a config that is entirely correct', () => {
    const config = resolveConfig({
      strictness: 'strict',
      architecture: { layers: { ui: ['components'] }, layerPolicy: 'downward' },
      thresholds: { maxFileLines: 300 },
      rules: { 'complexity/large-file': 'off' },
      ci: { failOn: 'warning', maxOverallDrop: 2 },
      ignore: ['generated/**'],
      include: ['src/**'],
      scope: [],
    });
    expect(config.warnings).toEqual([]);
  });

  it('reports patterns that match nothing, and why they probably do not', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/components/Button.tsx': "import { db } from '../lib/db/client';\nexport const B = db;\n",
      'src/lib/db/client.ts': 'export const db = 1;\n',
    });

    const config = resolveConfig({
      architecture: {
        layers: { ui: ['components'], data: ['lib/db', 'lib/repositories'] },
        // Written the way layer directories are written — without `src/`.
        forbidden: [['components/**', 'lib/db/**']],
      },
    });
    const { context } = await project.analyze({
      architecture: {
        layers: { ui: ['components'], data: ['lib/db', 'lib/repositories'] },
        forbidden: [['components/**', 'lib/db/**']],
      },
    });

    // The bare form now matches `src/...` too, so only the truly dead pattern
    // is reported — a warning about a rule that works would be worse than none.
    const warnings = validateAgainstProject(config, context.files, context.layers);
    expect(warnings).toEqual([
      'architecture.layers.data: "lib/repositories" matches no file, so that layer is smaller than you declared it.',
    ]);

    const forbidden = context.files.length
      ? (
          await project!.analyze({
            architecture: {
              layers: { ui: ['components'], data: ['lib/db'] },
              forbidden: [['components/**', 'lib/db/**']],
            },
          })
        ).result.findings
      : [];
    expect(forbidden.some((f) => f.id === 'architecture/forbidden-dependency')).toBe(true);
  });

  it('still reports a forbidden pattern that matches nothing in any spelling', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/components/Button.tsx': 'export const B = 1;\n',
    });
    const declared = {
      architecture: { forbidden: [['widgets/**', 'lib/db/**']] as Array<[string, string]> },
    };
    const { context } = await project.analyze(declared);

    expect(validateAgainstProject(resolveConfig(declared), context.files, context.layers)).toEqual([
      'architecture.forbidden: the from pattern "widgets/**" matches no file, so the rule never fires.',
      'architecture.forbidden: the to pattern "lib/db/**" matches no file, so the rule never fires.',
    ]);
  });

  it('stays quiet when every configured pattern reaches something', async () => {
    project = TempProject.create({
      'package.json': '{"name":"t"}',
      'src/components/Button.tsx': "import { db } from '../lib/db/client';\nexport const B = db;\n",
      'src/lib/db/client.ts': 'export const db = 1;\n',
    });

    const declared = {
      architecture: {
        layers: { ui: ['components'], data: ['lib/db'] },
        forbidden: [['src/components/**', 'src/lib/db/**']] as Array<[string, string]>,
      },
    };
    const { context } = await project.analyze(declared);

    expect(validateAgainstProject(resolveConfig(declared), context.files, context.layers)).toEqual(
      [],
    );
  });
});
