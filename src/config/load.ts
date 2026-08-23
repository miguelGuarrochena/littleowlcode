import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import type { LittleOwlConfig, ResolvedConfig, Strictness } from './schema.js';
import { baseConfig, ruleSeveritiesFor, THRESHOLD_PRESETS } from './defaults.js';
import { validateConfig } from './validate.js';

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

export const findConfigFile = (root: string): string | null => {
  for (const candidate of CANDIDATES) {
    const absolute = path.join(root, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
};

/**
 * Loads and resolves configuration for `root`.
 *
 * Missing configuration is not an error: Little Owl is designed to be useful on
 * the very first run, before `init` has been executed.
 */
export const loadConfig = async (root: string): Promise<ResolvedConfig> => {
  const file = findConfigFile(root);
  if (!file) return baseConfig('balanced');

  const raw = await readConfigFile(file);
  const resolved = resolveConfig(raw);
  resolved.sourcePath = file;
  return resolved;
};

const readConfigFile = async (file: string): Promise<LittleOwlConfig> => {
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

  let loaded: LittleOwlConfig;
  try {
    loaded = (await jiti.import(file, { default: true })) as LittleOwlConfig;
  } catch (error) {
    throw new Error(describeConfigFailure(file, error));
  }

  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`Config at ${file} did not export an object.`);
  }
  return loaded;
};

/**
 * Turns a module-resolution stack trace into something a reader can act on.
 *
 * The common case by far: the config was written by `init` run through `npx`,
 * so it imports a package that was never installed into the project. A raw
 * require stack does not tell anybody that.
 */
const describeConfigFailure = (file: string, error: unknown): string => {
  const reason = error instanceof Error ? error.message : String(error);
  const missing = /Cannot find module '([^']+)'/.exec(reason)?.[1];

  if (missing === 'little-owl-code') {
    return (
      `${file} imports 'little-owl-code', which is not installed in this project.\n` +
      '  Either install it — npm install -D little-owl-code — or drop the import and\n' +
      '  export a plain object, which works the same and needs nothing installed.'
    );
  }

  if (missing) {
    return `${file} imports '${missing}', which could not be resolved from this project.`;
  }

  return `Could not load ${file}: ${reason}`;
};

/**
 * The project's ignore list on top of the built-in one.
 *
 * Additive, with one escape: a pattern written as `!something` *removes* a
 * built-in entry instead of adding one. Without it the defaults would be
 * unremovable, and Little Owl would be telling people to exclude their
 * `examples/` directory with no way to say "no, that one is real code".
 *
 * `!` matches how every other ignore file in a developer's life behaves, so it
 * needs no explanation the first time someone sees it.
 */
export const mergeIgnore = (defaults: readonly string[], project: readonly string[]): string[] => {
  const removed = new Set(
    project.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1)),
  );
  return [
    ...defaults.filter((pattern) => !removed.has(pattern)),
    ...project.filter((pattern) => !pattern.startsWith('!')),
  ];
};

/** Merges a user config on top of the strictness preset it selected. */
export const resolveConfig = (raw: LittleOwlConfig): ResolvedConfig => {
  const strictness: Strictness = raw.strictness ?? 'balanced';
  const base = baseConfig(strictness);

  return {
    strictness,
    include: raw.include ?? base.include,
    ignore: mergeIgnore(base.ignore, raw.ignore ?? []),
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
    warnings: validateConfig(raw),
  };
};

export const configDir = (root: string): string => path.join(root, CONFIG_DIR);

export const ensureConfigDir = (root: string): string => {
  ensureLocalGitignore(root);
  return configDir(root);
};

/** Entries inside `.little-owl/` that are local state, not project source. */
const LOCAL_ONLY = ['cache/', 'history.json', 'last-run.json'];

/**
 * Keeps Little Owl's local state out of version control.
 *
 * The config and the baseline are meant to be committed — they are the team's
 * agreement about the project. The parse cache and the review log are machine
 * state, and a cache file that lands in a pull request is noise at best. This
 * runs whenever anything under `.little-owl/` is written, so the protection
 * does not depend on the developer having run `init` first.
 *
 * An existing file is never rewritten, only extended with entries it lacks.
 */
export const ensureLocalGitignore = (root: string): void => {
  const directory = configDir(root);
  const file = path.join(directory, '.gitignore');

  try {
    fs.mkdirSync(directory, { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing === null) {
      fs.writeFileSync(file, `${LOCAL_ONLY.join('\n')}\n`);
      return;
    }

    const lines = existing.split('\n').map((line) => line.trim());
    const missing = LOCAL_ONLY.filter(
      (entry) => !lines.includes(entry) && !lines.includes(entry.replace(/\/$/, '')),
    );
    if (missing.length === 0) return;

    const separator = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
    fs.appendFileSync(file, `${separator}${missing.join('\n')}\n`);
  } catch {
    // Not being able to write the ignore file is a tidiness problem, never a
    // correctness one. The analysis carries on either way.
  }
};
