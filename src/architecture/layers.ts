import type { ParsedFile } from '../core/types.js';
import type { LayerPolicy, ResolvedConfig } from '../config/schema.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';
import { meaningfulSegments, segments } from '../utils/paths.js';

export interface LayerModel {
  /** Layer names ordered top (most abstract) to bottom (most concrete). */
  order: string[];
  dirsByLayer: Record<string, string[]>;
  policy: LayerPolicy;
  /** True when Little Owl guessed the layers instead of reading them from config. */
  inferred: boolean;
  featureRoot: string | null;
}

/**
 * Directory names that conventionally belong to each layer. Used only when the
 * project has not declared its own layers — Little Owl says so in the output,
 * because a guess is not the same as a rule the team agreed on.
 */
const CONVENTIONAL_LAYERS: Array<[string, string[]]> = [
  ['ui', ['app', 'pages', 'components', 'views', 'screens', 'ui', 'widgets', 'templates']],
  [
    'application',
    [
      'services',
      'application',
      'usecases',
      'use-cases',
      'actions',
      'controllers',
      'handlers',
      'api',
    ],
  ],
  ['domain', ['domain', 'entities', 'models', 'core', 'business']],
  [
    'infrastructure',
    [
      'infrastructure',
      'infra',
      'repositories',
      'adapters',
      'db',
      'database',
      'data',
      'persistence',
      'clients',
    ],
  ],
];

const FEATURE_ROOT_CANDIDATES = ['features', 'modules', 'domains', 'packages'];

/**
 * How many layers it takes to have an architecture worth checking.
 *
 * Every boundary rule compares two ends of an import. With one layer there is
 * no second end, so nothing can ever be reported — and a model that cannot
 * report anything is not a model, it is a label. Saying so in one place stops
 * `check`, `doctor` and `init` from each deciding it differently, which is
 * exactly what they used to do.
 */
export const LAYERS_NEEDED = 2;

export const hasUsableLayers = (model: Pick<LayerModel, 'order'>): boolean =>
  model.order.length >= LAYERS_NEEDED;

export const inferLayers = (files: ParsedFile[]): LayerModel => {
  const present = new Map<string, Set<string>>();

  for (const file of files) {
    const parts = meaningfulSegments(file.path);
    for (const [layer, directories] of CONVENTIONAL_LAYERS) {
      // Only the first two segments count, so `components/orders/db` is UI.
      const candidate = parts.slice(0, 2).find((part) => directories.includes(part));
      if (!candidate) continue;
      const set = present.get(layer) ?? new Set<string>();
      set.add(candidate);
      present.set(layer, set);
      break;
    }
  }

  const order: string[] = [];
  const dirsByLayer: Record<string, string[]> = {};
  for (const [layer] of CONVENTIONAL_LAYERS) {
    const directories = present.get(layer);
    if (!directories || directories.size === 0) continue;
    order.push(layer);
    dirsByLayer[layer] = [...directories].sort();
  }

  const featureRoot =
    FEATURE_ROOT_CANDIDATES.find((candidate) =>
      files.some((file) => meaningfulSegments(file.path)[0] === candidate),
    ) ?? null;

  // One conventional directory name is not evidence of a layered architecture.
  // Guessing `domain: ["core"]` from a folder called `core` and writing it into
  // someone's config states a decision they never made, and enables rules that
  // can never fire.
  if (order.length < LAYERS_NEEDED) {
    return { order: [], dirsByLayer: {}, policy: 'adjacent', inferred: true, featureRoot };
  }

  return { order, dirsByLayer, policy: 'adjacent', inferred: true, featureRoot };
};

export const buildLayerModel = (config: ResolvedConfig, files: ParsedFile[]): LayerModel => {
  const configured = config.architecture.layers;
  const hasConfiguredLayers = Object.keys(configured).length > 0;

  if (!hasConfiguredLayers) {
    const inferred = inferLayers(files);
    return {
      ...inferred,
      policy: config.architecture.layerPolicy,
      featureRoot: config.architecture.featureRoot ?? inferred.featureRoot,
    };
  }

  return {
    order: Object.keys(configured),
    dirsByLayer: configured,
    policy: config.architecture.layerPolicy,
    inferred: false,
    featureRoot: config.architecture.featureRoot,
  };
};

/**
 * Next.js route handlers live under `app/api/` or `pages/api/`, inside what is
 * otherwise the UI directory. They are server code and are supposed to talk to
 * services and data, so attributing them to the UI layer would turn every
 * normal route handler into a boundary violation.
 */
const API_ROUTE = /^(app|pages)\/api\//;

const apiRouteLayer = (file: string, model: LayerModel): string | null => {
  if (!API_ROUTE.test(file)) return null;

  const owningLayer = model.order.find((layer) =>
    (model.dirsByLayer[layer] ?? []).some((directory) => directory === 'api'),
  );
  if (owningLayer) return owningLayer;
  return model.order[1] ?? model.order[0] ?? null;
};

/** Which layer a file belongs to, or `null` when it sits outside the model. */
export const layerOf = (file: string, model: LayerModel): string | null => {
  const parts = meaningfulSegments(file);

  const routeLayer = apiRouteLayer(parts.join('/'), model);
  if (routeLayer) return routeLayer;

  for (const layer of model.order) {
    for (const directory of model.dirsByLayer[layer] ?? []) {
      if (matchesLayerDirectory(file, directory, parts)) return layer;
    }
  }

  return null;
};

/**
 * Whether one configured layer directory claims this file.
 *
 * Split out from `layerOf` so configuration validation can ask the same
 * question per directory and tell the user when one of theirs matches nothing.
 */
export const matchesLayerDirectory = (
  file: string,
  directory: string,
  fileParts = meaningfulSegments(file),
): boolean => {
  if (directory.includes('*')) return matchesCompiled(file, [compilePattern(directory)]);

  // Configured directories may or may not include a `src/` wrapper; both sides
  // are normalised so either form works.
  const directoryParts = meaningfulSegments(directory);
  if (directoryParts.length === 0) return false;
  if (directoryParts.every((part, index) => fileParts[index] === part)) return true;

  // Also match when the layer directory appears as the first segment only.
  return directoryParts.length === 1 && fileParts.slice(0, 2).includes(directoryParts[0]!);
};

export type LayerRelation = 'same' | 'ok' | 'inverted' | 'skip' | 'unknown';

/**
 * Classifies a dependency between two layers.
 *
 * - `inverted`: a lower layer depends on a higher one (data importing UI).
 * - `skip`: a layer reaches past its neighbour (UI importing the database).
 */
export const classifyLayerDependency = (
  fromLayer: string | null,
  toLayer: string | null,
  model: LayerModel,
): LayerRelation => {
  if (!fromLayer || !toLayer) return 'unknown';
  if (fromLayer === toLayer) return 'same';

  const fromIndex = model.order.indexOf(fromLayer);
  const toIndex = model.order.indexOf(toLayer);
  if (fromIndex === -1 || toIndex === -1) return 'unknown';

  if (toIndex < fromIndex) return 'inverted';
  if (model.policy === 'adjacent' && toIndex - fromIndex > 1) return 'skip';
  return 'ok';
};

/** The feature a file belongs to, when the project is organised by feature. */
export const featureOf = (file: string, model: LayerModel): string | null => {
  if (!model.featureRoot) return null;
  const parts = meaningfulSegments(file);
  if (parts[0] !== model.featureRoot) return null;
  return parts[1] ?? null;
};

export const describeLayerChain = (model: LayerModel): string => {
  return model.order.length > 0 ? model.order.join(' -> ') : 'no layers detected';
};

export interface LayerCoverage {
  /**
   * False when the model has fewer than two layers. A boundary needs two sides,
   * so a one-layer model has nothing to check and nothing to be missing —
   * coverage is not a meaningful question about it.
   */
  applicable: boolean;
  /** Non-test files that fall inside a declared layer. */
  layered: number;
  total: number;
  /** `layered / total`, or 1 when there is nothing to place. */
  share: number;
  /** The largest directories sitting outside the model, biggest first. */
  unplaced: Array<{ directory: string; files: number }>;
}

/**
 * How much of the codebase the layer model actually reaches.
 *
 * Boundary rules can only fire between two files that both belong to a layer.
 * A model covering a third of the tree will happily report "no violations",
 * which reads as a clean bill of health for code nothing ever looked at. This
 * is the number that keeps that claim honest.
 */
export const layerCoverage = (files: ParsedFile[], model: LayerModel): LayerCoverage => {
  const source = files.filter((file) => !file.isTest);
  if (model.order.length < 2 || source.length === 0) {
    return { applicable: false, layered: 0, total: source.length, share: 1, unplaced: [] };
  }

  const unplacedByDirectory = new Map<string, number>();
  let layered = 0;

  for (const file of source) {
    if (layerOf(file.path, model)) {
      layered += 1;
      continue;
    }
    const directory = unplacedLabel(file.path);
    unplacedByDirectory.set(directory, (unplacedByDirectory.get(directory) ?? 0) + 1);
  }

  const unplaced = [...unplacedByDirectory.entries()]
    .map(([directory, count]) => ({ directory, files: count }))
    .sort((a, b) => b.files - a.files || (a.directory < b.directory ? -1 : 1));

  return {
    applicable: true,
    layered,
    total: source.length,
    share: layered / source.length,
    unplaced,
  };
};

/**
 * The directory an unplaced file would be declared under. Two segments deep,
 * because `src/lib/supabase` is the useful answer and `src/lib` is not.
 */
const unplacedLabel = (file: string): string => {
  const parts = segments(file);
  if (parts.length <= 1) return '.';
  const meaningful = meaningfulSegments(file);
  if (meaningful.length <= 1) return parts.slice(0, -1).join('/') || '.';
  const prefix = parts.length > meaningful.length ? `${parts[0]}/` : '';
  return `${prefix}${meaningful.slice(0, Math.min(2, meaningful.length - 1)).join('/')}`;
};
