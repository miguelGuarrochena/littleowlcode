import { analyzeProject } from '../../core/analyze.js';
import { loadConfig } from '../../config/load.js';
import { detectChanges } from '../../git/git.js';
import { analyzeImpact } from '../../review/impact.js';
import { printJson } from '../../output/json.js';
import { renderArchitecture, renderDependencies, renderImpact } from '../../output/report.js';
import { dim } from '../../output/theme.js';
import { layerOf } from '../../architecture/layers.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';

export interface InspectOptions extends GlobalOptions {
  json?: boolean;
}

/** `little-owl architecture` — how the code is layered, and where that breaks. */
export async function architectureCommand(options: InspectOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const { context } = await analyzeProject({ root, config });

  if (options.json) {
    const filesByLayer: Record<string, string[]> = {};
    for (const file of context.files) {
      const layer = layerOf(file.path, context.layers) ?? 'unassigned';
      (filesByLayer[layer] ??= []).push(file.path);
    }
    printJson({
      layers: context.layers.order,
      policy: context.layers.policy,
      inferred: context.layers.inferred,
      directories: context.layers.dirsByLayer,
      featureRoot: context.layers.featureRoot,
      filesByLayer,
      cycles: context.cycles.map((cycle) => cycle.files),
      edges: context.graph.edges.length,
    });
    return 0;
  }

  print('');
  print(renderArchitecture(context));
  print('');
  if (context.cycles.length > 0) {
    print(dim(`${context.cycles.length} circular dependenc${context.cycles.length === 1 ? 'y' : 'ies'} — see \`little-owl check\`.`));
    print('');
  }
  return 0;
}

export interface ImpactOptions extends InspectOptions {
  files?: string[];
  base?: string;
}

/** `little-owl impact` — what else could this change touch? */
export async function impactCommand(options: ImpactOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const { context } = await analyzeProject({ root, config });

  let changed = options.files ?? [];
  if (changed.length === 0) {
    const changes = detectChanges(root, options.base ? { base: options.base } : {});
    changed = (changes?.files ?? [])
      .filter((file) => file.status !== 'deleted')
      .map((file) => file.path);
  }

  const known = changed.filter((file) => context.fileMap.has(file));
  const report = analyzeImpact(context, known);

  if (options.json) {
    printJson(report);
    return 0;
  }

  print('');
  if (changed.length > 0 && known.length === 0) {
    print(dim('The changed files are not part of the analysed source set.'));
    print('');
    return 0;
  }
  print(renderImpact(report));
  print('');
  return 0;
}

/** `little-owl dependencies` — declared vs actually imported packages. */
export async function dependenciesCommand(options: InspectOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);
  const { context } = await analyzeProject({ root, config });

  if (options.json) {
    const byFile: Record<string, string[]> = {};
    for (const [file, packages] of context.graph.external) {
      byFile[file] = [...packages].sort();
    }
    printJson({
      declared: {
        dependencies: context.project.dependencies,
        devDependencies: context.project.devDependencies,
      },
      imported: [...context.graph.externalPackages()].sort(),
      byFile,
    });
    return 0;
  }

  print('');
  print(renderDependencies(context));
  print('');
  return 0;
}
