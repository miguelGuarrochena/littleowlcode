import fs from 'node:fs';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { analyzeProject } from '../../core/analyze.js';
import { baseConfig } from '../../config/defaults.js';
import { ensureConfigDir, findConfigFile } from '../../config/load.js';
import { inferLayers } from '../../architecture/layers.js';
import { buildBaseline, writeBaseline } from '../../baseline/baseline.js';
import { renderHealth } from '../../output/report.js';
import { colors, dim, icons } from '../../output/theme.js';
import type { Strictness } from '../../config/schema.js';
import {
  cancelled,
  createProgress,
  isInteractive,
  print,
  PROGRESS_LABELS,
  resolveRoot,
  type GlobalOptions,
} from '../runtime.js';

export interface InitOptions extends GlobalOptions {
  /** Accept every default without asking. */
  yes?: boolean;
  force?: boolean;
  baseline?: boolean;
}

const STRUCTURE_HINTS: Record<string, string> = {
  feature: 'Code grouped by feature: features/orders, features/auth',
  layer: 'Code grouped by layer: components, services, repositories',
  domain: 'Domain-driven: domain, application, infrastructure',
  flat: 'Everything in a small number of top-level folders',
};

export async function initCommand(options: InitOptions): Promise<number> {
  const root = resolveRoot(options);
  const existing = findConfigFile(root);

  if (existing && !options.force) {
    print(`${colors.yellow(icons.warn)} Configuration already exists at ${dim(existing)}`);
    print(dim('Run with --force to overwrite it.'));
    return 1;
  }

  const interactive = isInteractive() && !options.yes;
  if (interactive) prompts.intro(`${icons.owl}  Setting up Little Owl Code`);

  const progress = createProgress(interactive);
  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result, context } = await analyzeProject({
    root,
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop(dim(`Read ${result.project.fileCount} files`));

  const detected = inferLayers(context.files);
  let strictness: Strictness = 'balanced';
  let include: string[] = [];
  let layers = detected.dirsByLayer;

  if (interactive) {
    const structure = await prompts.select({
      message: 'How is this project organised?',
      options: [
        {
          value: 'detected',
          label: `Use what Little Owl detected${detected.order.length ? ` (${detected.order.join(' → ')})` : ''}`,
          hint: detected.order.length === 0 ? 'nothing obvious detected' : 'recommended',
        },
        { value: 'layer', label: 'Layer-based', hint: STRUCTURE_HINTS['layer'] },
        { value: 'feature', label: 'Feature-based', hint: STRUCTURE_HINTS['feature'] },
        { value: 'domain', label: 'Domain-driven', hint: STRUCTURE_HINTS['domain'] },
      ],
    });
    if (prompts.isCancel(structure)) cancelled();
    layers = layersFor(String(structure), detected.dirsByLayer, root);

    const topLevel = topLevelDirectories(root);
    if (topLevel.length > 0) {
      const chosen = await prompts.multiselect({
        message: 'Which folders contain application code?',
        options: topLevel.map((directory) => ({
          value: directory,
          label: directory,
          hint: guessRole(directory),
        })),
        initialValues: topLevel.filter((directory) => !isProbablySupport(directory)),
        required: false,
      });
      if (prompts.isCancel(chosen)) cancelled();
      const selected = chosen as string[];
      // An empty selection means "everything", which is also the default.
      if (selected.length > 0 && selected.length < topLevel.length) {
        include = selected.map((directory) => `${directory}/**`);
      }
    }

    const level = await prompts.select({
      message: 'How strict should Little Owl be?',
      options: [
        { value: 'relaxed', label: 'Relaxed', hint: 'only clear structural problems' },
        { value: 'balanced', label: 'Balanced', hint: 'recommended' },
        { value: 'strict', label: 'Strict', hint: 'small files, tight boundaries' },
      ],
      initialValue: 'balanced',
    });
    if (prompts.isCancel(level)) cancelled();
    strictness = level as Strictness;
  }

  const configFile = writeConfigFile(root, { strictness, include, layers });
  print('');
  print(`${colors.green(icons.ok)} Wrote ${colors.bold(path.relative(root, configFile))}`);

  const shouldBaseline = options.baseline ?? (interactive ? await askBaseline() : true);
  if (shouldBaseline) {
    const file = writeBaseline(root, buildBaseline(root, result));
    print(`${colors.green(icons.ok)} Wrote ${colors.bold(path.relative(root, file))}`);
    print('');
    print(dim('Future reviews compare against this baseline until you explicitly update it.'));
  }

  print('');
  print(renderHealth(result, { maxFindings: 3 }));
  print('');
  print(dim(`Next: ${colors.bold('little-owl review')} after your next change.`));

  if (interactive) prompts.outro(`${icons.owl}  Ready.`);
  return 0;
}

async function askBaseline(): Promise<boolean> {
  const answer = await prompts.confirm({
    message: 'Save the current state as the baseline?',
    initialValue: true,
  });
  if (prompts.isCancel(answer)) cancelled();
  return answer;
}

function layersFor(
  structure: string,
  detected: Record<string, string[]>,
  root: string,
): Record<string, string[]> {
  if (structure === 'detected') return detected;

  const exists = (directory: string): boolean => fs.existsSync(path.join(root, directory));
  const keep = (candidates: string[]): string[] => candidates.filter(exists);

  if (structure === 'layer') {
    return {
      ui: keep(['app', 'pages', 'components', 'views']),
      application: keep(['services', 'controllers', 'actions']),
      data: keep(['repositories', 'lib/db', 'db', 'data']),
    };
  }
  if (structure === 'domain') {
    return {
      ui: keep(['app', 'components', 'ui']),
      application: keep(['application', 'usecases', 'services']),
      domain: keep(['domain', 'entities', 'models']),
      infrastructure: keep(['infrastructure', 'infra', 'adapters', 'repositories']),
    };
  }
  return detected;
}

function topLevelDirectories(root: string): string[] {
  const skip = new Set([
    'node_modules',
    '.git',
    '.github',
    'dist',
    'build',
    'coverage',
    '.next',
    '.turbo',
    'public',
    'static',
    'assets',
    '.vscode',
    '.idea',
    '.little-owl',
    'venv',
    '.venv',
  ]);

  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const SUPPORT_DIRECTORIES = new Set([
  'scripts',
  'tests',
  'test',
  'docs',
  'examples',
  'e2e',
  'tools',
]);

function isProbablySupport(directory: string): boolean {
  return SUPPORT_DIRECTORIES.has(directory);
}

function guessRole(directory: string): string {
  if (isProbablySupport(directory)) return 'support';
  if (['app', 'pages', 'components', 'ui'].includes(directory)) return 'interface';
  if (['services', 'lib', 'domain', 'core'].includes(directory)) return 'logic';
  return '';
}

interface ConfigTemplate {
  strictness: Strictness;
  include: string[];
  layers: Record<string, string[]>;
}

export function renderConfigFile(template: ConfigTemplate): string {
  const defaults = baseConfig(template.strictness);
  const layerEntries = Object.entries(template.layers).filter(([, dirs]) => dirs.length > 0);

  return `import { defineConfig } from 'little-owl-code';

/**
 * Little Owl Code configuration.
 * Docs: https://littleowlcode.com
 */
export default defineConfig({
  strictness: '${template.strictness}',
${template.include.length > 0 ? `\n  // Only these paths are analysed.\n  include: ${JSON.stringify(template.include, null, 2).replace(/\n/g, '\n  ')},\n` : ''}
  architecture: {
    // Layers are listed top to bottom. A layer may depend on the one below it.
    layers: {
${layerEntries.map(([layer, dirs]) => `      ${layer}: ${JSON.stringify(dirs)},`).join('\n')}
    },
    layerPolicy: '${defaults.architecture.layerPolicy}',
  },

  thresholds: {
    maxFileLines: ${defaults.thresholds.maxFileLines},
    maxFunctionLines: ${defaults.thresholds.maxFunctionLines},
    maxComponentLines: ${defaults.thresholds.maxComponentLines},
    maxComplexity: ${defaults.thresholds.maxComplexity},
  },

  // Severity: 'off' | 'info' | 'warning' | 'error'
  rules: {
    'architecture/circular-dependency': 'error',
    'architecture/layer-violation': 'error',
    'architecture/layer-skip': '${defaults.rules['architecture/layer-skip']}',
  },

  ignore: ['generated/**'],

  ci: {
    failOn: 'error',
    maxOverallDrop: ${defaults.ci.maxOverallDrop},
  },
});
`;
}

function writeConfigFile(root: string, template: ConfigTemplate): string {
  const directory = ensureConfigDir(root);
  const file = path.join(directory, 'config.ts');
  fs.writeFileSync(file, renderConfigFile(template));

  // The config and the baseline belong in version control; the cache and the
  // local review log do not. `ensureConfigDir` has already written the ignore
  // file that keeps them apart.
  return file;
}
