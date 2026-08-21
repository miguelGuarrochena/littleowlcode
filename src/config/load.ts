import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import type { LittleOwlConfig, ResolvedConfig, Strictness } from './schema.js';
import { baseConfig, ruleSeveritiesFor, THRESHOLD_PRESETS } from './defaults.js';

export const CONFIG_DIR = '.little-owl';

/**
 * Config locations, in priority order. The `.little-owl/` directory is what
 * `init` writes; the root-level forms exist because that is where people look
 * first when they add configuration by hand.
 */
const CANDIDATES = [
  '.little-owl/config.ts',
  '.little-owl/config.mts',
  '.little-owl/config.js',
  '.little-owl/config.mjs',
  '.little-owl/config.json',
  'little-owl.config.ts',
  'little-owl.config.mts',
  'little-owl.config.js',
  'little-owl.config.mjs',
  'little-owl.config.json',
  '.littleowlrc.ts',
  '.littleowlrc.js',
  '.littleowlrc.mjs',
  '.littleowlrc.json',
  '.littleowlrc',
];

export function findConfigFile(root: string): string | null {
  for (const candidate of CANDIDATES) {
    const absolute = path.join(root, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

/**
 * Loads and resolves configuration for `root`.
 *
 * Missing configuration is not an error: Little Owl is designed to be useful on
 * the very first run, before `init` has been executed.
 */
export async function loadConfig(root: string): Promise<ResolvedConfig> {
  const file = findConfigFile(root);
  if (!file) return baseConfig('balanced');

  const raw = await readConfigFile(file);
  const resolved = resolveConfig(raw);
  resolved.sourcePath = file;
  return resolved;
}

async function readConfigFile(file: string): Promise<LittleOwlConfig> {
  // A bare `.littleowlrc` is JSON, matching how every other rc file behaves.
  if (file.endsWith('.json') || file.endsWith('.littleowlrc')) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as LittleOwlConfig;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse ${file} as JSON: ${reason}`);
    }
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const loaded = (await jiti.import(file, { default: true })) as LittleOwlConfig;
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`Config at ${file} did not export an object.`);
  }
  return loaded;
}

/** Merges a user config on top of the strictness preset it selected. */
export function resolveConfig(raw: LittleOwlConfig): ResolvedConfig {
  const strictness: Strictness = raw.strictness ?? 'balanced';
  const base = baseConfig(strictness);

  return {
    strictness,
    include: raw.include ?? base.include,
    ignore: [...base.ignore, ...(raw.ignore ?? [])],
    architecture: {
      layers: raw.architecture?.layers ?? base.architecture.layers,
      layerPolicy: raw.architecture?.layerPolicy ?? base.architecture.layerPolicy,
      featureRoot: raw.architecture?.featureRoot ?? base.architecture.featureRoot,
      forbidden: raw.architecture?.forbidden ?? base.architecture.forbidden,
    },
    thresholds: { ...THRESHOLD_PRESETS[strictness], ...(raw.thresholds ?? {}) },
    rules: { ...ruleSeveritiesFor(strictness), ...(raw.rules ?? {}) },
    ci: { ...base.ci, ...(raw.ci ?? {}) },
    scope: raw.scope ?? base.scope,
    sourcePath: null,
  };
}

export function configDir(root: string): string {
  return path.join(root, CONFIG_DIR);
}

export function ensureConfigDir(root: string): string {
  const dir = configDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
