import fs from 'node:fs';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import { analyzeProject } from '../../core/analyze.js';
import { baseConfig } from '../../config/defaults.js';
import { ensureConfigDir, findConfigFile, loadConfig } from '../../config/load.js';
import { buildScopeReport } from '../../detect/scope-report.js';
import { inferLayers, type LayerModel } from '../../architecture/layers.js';
import { buildBaseline, writeBaseline } from '../../baseline/baseline.js';
import { colors, dim, icons } from '../../output/theme.js';
import { owlHeader, renderDetection, renderNextStep, renderScope } from '../../output/guided.js';
import { writeAgentFile, AGENT_FILE } from '../../agent/agent-file.js';
import { OwlError } from '../errors.js';
import type { Strictness } from '../../config/schema.js';
import type { AnalysisResult, ParsedFile, ProjectInfo } from '../../core/types.js';
import type { AnalysisContext } from '../../core/context.js';
import type { ResolvedConfig } from '../../config/schema.js';
import {
  cancelled,
  createProgress,
  isInteractive,
  loadProjectConfig,
  print,
  PROGRESS_LABELS,
  resolveRoot,
  type GlobalOptions,
} from '../runtime.js';

export interface InitOptions extends GlobalOptions {
  /** Accept every default without asking. This is now the default behaviour. */
  yes?: boolean;
  /** Ask about structure and strictness instead of detecting them. */
  interactive?: boolean;
  force?: boolean;
  baseline?: boolean;
  /** False to skip writing LITTLE_OWL.md. */
  agentFile?: boolean;
}

const STRUCTURE_HINTS: Record<string, string> = {
  feature: 'Code grouped by feature: features/orders, features/auth',
  layer: 'Code grouped by layer: components, services, repositories',
  domain: 'Domain-driven: domain, application, infrastructure',
  flat: 'Everything in a small number of top-level folders',
};

/**
 * `little-owl init` — set up, without an interview.
 *
 * The original version asked three questions before it would do anything:
 * how the project was organised, which folders held application code, and how
 * strict to be. Every one of those is answerable from the files on disk, and
 * asking someone who built their app with an assistant to choose between
 * "layer-based" and "domain-driven" is asking them to guess at a decision they
 * did not know they had made. So the default path asks nothing and says what it
 * decided; `--interactive` is there for people who want the choice.
 */
export const initCommand = async (options: InitOptions): Promise<number> => {
  const root = resolveRoot(options);
  const existing = findConfigFile(root);

  if (existing && !options.force) {
    throw new OwlError({
      what: 'Little Owl is already set up in this project.',
      why: `Its configuration is at ${path.relative(root, existing)}, so there is nothing to do.`,
      next: ['little-owl check', 'little-owl init --force'],
    });
  }

  const interactive = isInteractive() && options.interactive === true;
  const progress = createProgress(isInteractive());

  print(owlHeader("Let's protect your project."));
  progress.start(PROGRESS_LABELS['reading-project']!);
  const { result, context } = await analyzeProject({
    root,
    onProgress: (step) => {
      if (step !== 'done') progress.update(PROGRESS_LABELS[step] ?? step);
    },
  });
  progress.stop();

  await printWhatWillBeAnalysed(root, result, context);

  const detected = inferLayers(context.files);
  const template = interactive
    ? await askSetup(root, context.files, detected)
    : { strictness: 'balanced' as Strictness, include: [], layers: detected.dirsByLayer };

  const configFile = writeConfigFile(root, template);
  print(`${colors.green(icons.ok)} Wrote ${colors.bold(path.relative(root, configFile))}`);

  // Re-analyse under the configuration that was just written. The first pass
  // ran on defaults, and a baseline recorded under different settings than the
  // project will actually use is stale the moment it is created.
  const config = await loadProjectConfig(root);
  const { result: configured, context: settled } = await analyzeProject({ root, config });
  const layerModel = settled.layers;

  const shouldBaseline = options.baseline ?? (interactive ? await askBaseline() : true);
  if (shouldBaseline) {
    const file = writeBaseline(root, buildBaseline(root, configured, config));
    print(`${colors.green(icons.ok)} Wrote ${colors.bold(path.relative(root, file))}`);
  }
  if (options.agentFile !== false) {
    printAgentFile(root, configured.project, config, layerModel, options.force === true);
  }

  print('');
  if (shouldBaseline) {
    print(dim('The baseline is a snapshot of today. From now on Little Owl can show you'));
    print(dim('what changed, instead of everything at once.'));
    print('');
  }
  print(colors.green('Ready.'));
  print('');
  print(
    renderNextStep({ command: 'little-owl check', note: 'see what needs attention right now' }, [
      { command: 'little-owl review', note: 'after your next change' },
    ]),
  );
  print('');
  return 0;
};

const printAgentFile = (
  root: string,
  project: ProjectInfo,
  config: ResolvedConfig,
  layers: LayerModel,
  force: boolean,
): void => {
  const agent = writeAgentFile(root, { project, config, layers }, force ? { force: true } : {});
  print(
    agent.written
      ? `${colors.green(icons.ok)} Wrote ${colors.bold(AGENT_FILE)}   ${dim('so AI assistants know the rules here')}`
      : dim(`${icons.ok} ${AGENT_FILE} already exists — left as it is`),
  );
};

/**
 * The old questionnaire, still available behind `--interactive`.
 *
 * Nothing here is asked by default. It exists for the person who already knows
 * how they want their project described and would rather say so than have it
 * inferred — which is a real preference, just not the common one.
 */
const askSetup = async (
  root: string,
  files: ParsedFile[],
  detected: ReturnType<typeof inferLayers>,
): Promise<ConfigTemplate> => {
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

  return {
    strictness: level as Strictness,
    include: await askSourceDirectories(files),
    layers: layersFor(String(structure), detected.dirsByLayer, root),
  };
};

const askSourceDirectories = async (files: ParsedFile[]): Promise<string[]> => {
  const topLevel = sourceDirectories(files);
  if (topLevel.length === 0) return [];

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
  if (selected.length === 0 || selected.length === topLevel.length) return [];
  return selected.map((directory) => `${directory}/**`);
};

/**
 * What is in scope, and what Little Owl will look for in it.
 *
 * Printed before anything is written, and before any finding. A first run that
 * reports problems in code the reader does not consider theirs is the one
 * failure this tool cannot recover from.
 */
const printWhatWillBeAnalysed = async (
  root: string,
  result: AnalysisResult,
  context: AnalysisContext,
): Promise<void> => {
  print(renderDetection(result.project));
  print('');
  print(
    renderScope(
      buildScopeReport(
        root,
        await loadConfig(root),
        context.files.map((file) => file.path),
      ),
    ),
  );
  print('');
  print(dim('Little Owl will watch for:'));
  print('');
  for (const item of WATCHED) print(`${colors.green(icons.ok)} ${item}`);
  print('');
};

/** What `init` promises out loud, in the words of someone using the app. */
const WATCHED = [
  'Architecture drifting out of shape',
  'Files that depend on each other in loops',
  'Code that has grown too big to change safely',
  'The same logic written more than once',
  'Type safety being switched off',
  'Dependencies appearing that nobody asked for',
];

const askBaseline = async (): Promise<boolean> => {
  const answer = await prompts.confirm({
    message: 'Save the current state as the baseline?',
    initialValue: true,
  });
  if (prompts.isCancel(answer)) cancelled();
  return answer;
};

const layersFor = (
  structure: string,
  detected: Record<string, string[]>,
  root: string,
): Record<string, string[]> => {
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
};

/**
 * Top-level directories that actually hold analysable source.
 *
 * Derived from the files the scan already found, rather than from a list of
 * names to avoid. A deny-list is always one build tool behind — `init` used to
 * offer `playwright-report/` and `test-results/` as project code, because
 * nothing had told it otherwise. A directory with no source file in it cannot
 * be somewhere the analysis needs to look.
 */
const sourceDirectories = (files: ParsedFile[]): string[] => {
  const directories = new Set<string>();

  for (const file of files) {
    const [top] = file.path.split('/');
    // A path with no slash is a loose file at the root, not a directory.
    if (top && top !== file.path) directories.add(top);
  }

  return [...directories].sort();
};

const SUPPORT_DIRECTORIES = new Set([
  'scripts',
  'tests',
  'test',
  'docs',
  'examples',
  'e2e',
  'tools',
]);

const isProbablySupport = (directory: string): boolean => SUPPORT_DIRECTORIES.has(directory);

const guessRole = (directory: string): string => {
  if (isProbablySupport(directory)) return 'support';
  if (['app', 'pages', 'components', 'ui'].includes(directory)) return 'interface';
  if (['services', 'lib', 'domain', 'core'].includes(directory)) return 'logic';
  return '';
};

interface ConfigTemplate {
  strictness: Strictness;
  include: string[];
  layers: Record<string, string[]>;
}

/**
 * The architecture block.
 *
 * When nothing convincing was detected the block is written commented out,
 * with an example. An empty `layers: {}` reads as "checked, nothing here";
 * a commented example reads as "this is yours to fill in", which is the truth.
 */
const architectureBlock = (layers: Record<string, string[]>, policy: string): string => {
  const entries = Object.entries(layers).filter(([, dirs]) => dirs.length > 0);

  if (entries.length === 0) {
    return `  // No layered structure was detected, so boundary checks are off.
  // Describe your own to switch them on — two layers minimum, top to bottom:
  //
  // architecture: {
  //   layers: {
  //     ui: ['app', 'components'],
  //     data: ['lib/db'],
  //   },
  //   layerPolicy: '${policy}',
  // },`;
  }

  return `  architecture: {
    // Layers are listed top to bottom. A layer may depend on the one below it.
    layers: {
${entries.map(([layer, dirs]) => `      ${layer}: ${JSON.stringify(dirs)},`).join('\n')}
    },
    layerPolicy: '${policy}',
  },`;
};

export const renderConfigFile = (template: ConfigTemplate): string => {
  const defaults = baseConfig(template.strictness);

  // No import of `defineConfig` here. The documented way in is `npx
  // little-owl-code`, which never installs the package into the project, so an
  // import would leave every later command unable to load this file.
  return `/**
 * Little Owl Code configuration.
 * Docs: https://littleowlcode.com/docs/configuration
 *
 * Installing the package as a dev dependency gets you type checking here:
 *
 *   import { defineConfig } from 'little-owl-code';
 *   export default defineConfig({ ... });
 */
export default {
  strictness: '${template.strictness}',
${template.include.length > 0 ? `\n  // Only these paths are analysed.\n  include: ${JSON.stringify(template.include, null, 2).replace(/\n/g, '\n  ')},\n` : ''}
${architectureBlock(template.layers, defaults.architecture.layerPolicy)}

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

  // Added to the built-in ignore list. Put anything here that is not your
  // application: generated code, vendored copies, samples.
  // A \`!\` in front removes one of the built-in patterns, so
  // ignore: ['!examples/**'] analyses your examples directory after all.
  ignore: ['generated/**'],

  ci: {
    failOn: 'error',
    maxOverallDrop: ${defaults.ci.maxOverallDrop},
  },
};
`;
};

const writeConfigFile = (root: string, template: ConfigTemplate): string => {
  const directory = ensureConfigDir(root);
  const file = path.join(directory, 'config.ts');
  fs.writeFileSync(file, renderConfigFile(template));

  // The config and the baseline belong in version control; the cache and the
  // local review log do not. `ensureConfigDir` has already written the ignore
  // file that keeps them apart.
  return file;
};
