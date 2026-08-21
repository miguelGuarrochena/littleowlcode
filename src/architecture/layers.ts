import type { ParsedFile } from '../core/types.js';
import type { LayerPolicy, ResolvedConfig } from '../config/schema.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';
import { segments } from '../utils/paths.js';

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

/** Drops wrapper directories so `src/components/x` is seen as `components/x`. */
const WRAPPER_SEGMENTS = new Set(['src', 'app_src', 'source']);

function meaningfulSegments(file: string): string[] {
  const parts = segments(file);
  return parts[0] !== undefined && WRAPPER_SEGMENTS.has(parts[0]) ? parts.slice(1) : parts;
}

export function inferLayers(files: ParsedFile[]): LayerModel {
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

  return { order, dirsByLayer, policy: 'adjacent', inferred: true, featureRoot };
}

export function buildLayerModel(config: ResolvedConfig, files: ParsedFile[]): LayerModel {
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
}

/**
 * Next.js route handlers live under `app/api/` or `pages/api/`, inside what is
 * otherwise the UI directory. They are server code and are supposed to talk to
 * services and data, so attributing them to the UI layer would turn every
 * normal route handler into a boundary violation.
 */
const API_ROUTE = /^(app|pages)\/api\//;

function apiRouteLayer(file: string, model: LayerModel): string | null {
  if (!API_ROUTE.test(file)) return null;

  const owningLayer = model.order.find((layer) =>
    (model.dirsByLayer[layer] ?? []).some((directory) => directory === 'api'),
  );
  if (owningLayer) return owningLayer;
  return model.order[1] ?? model.order[0] ?? null;
}

/** Which layer a file belongs to, or `null` when it sits outside the model. */
export function layerOf(file: string, model: LayerModel): string | null {
  const parts = meaningfulSegments(file);

  const routeLayer = apiRouteLayer(parts.join('/'), model);
  if (routeLayer) return routeLayer;

  for (const layer of model.order) {
    const directories = model.dirsByLayer[layer] ?? [];
    for (const directory of directories) {
      if (directory.includes('*')) {
        if (matchesCompiled(file, [compilePattern(directory)])) return layer;
        continue;
      }
      // Configured directories may or may not include a `src/` wrapper; both
      // sides are normalised so either form works.
      const directoryParts = meaningfulSegments(directory);
      if (
        directoryParts.length > 0 &&
        directoryParts.every((part, index) => parts[index] === part)
      ) {
        return layer;
      }
      // Also match when the layer directory appears as the first segment only.
      if (directoryParts.length === 1 && parts.slice(0, 2).includes(directoryParts[0]!)) {
        return layer;
      }
    }
  }

  return null;
}

export type LayerRelation = 'same' | 'ok' | 'inverted' | 'skip' | 'unknown';

/**
 * Classifies a dependency between two layers.
 *
 * - `inverted`: a lower layer depends on a higher one (data importing UI).
 * - `skip`: a layer reaches past its neighbour (UI importing the database).
 */
export function classifyLayerDependency(
  fromLayer: string | null,
  toLayer: string | null,
  model: LayerModel,
): LayerRelation {
  if (!fromLayer || !toLayer) return 'unknown';
  if (fromLayer === toLayer) return 'same';

  const fromIndex = model.order.indexOf(fromLayer);
  const toIndex = model.order.indexOf(toLayer);
  if (fromIndex === -1 || toIndex === -1) return 'unknown';

  if (toIndex < fromIndex) return 'inverted';
  if (model.policy === 'adjacent' && toIndex - fromIndex > 1) return 'skip';
  return 'ok';
}

/** The feature a file belongs to, when the project is organised by feature. */
export function featureOf(file: string, model: LayerModel): string | null {
  if (!model.featureRoot) return null;
  const parts = meaningfulSegments(file);
  if (parts[0] !== model.featureRoot) return null;
  return parts[1] ?? null;
}

export function describeLayerChain(model: LayerModel): string {
  return model.order.length > 0 ? model.order.join(' -> ') : 'no layers detected';
}
