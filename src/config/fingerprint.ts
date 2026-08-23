import { hashContent } from '../utils/hash.js';
import type { ResolvedConfig } from './schema.js';

/**
 * A stable identity for the settings that decide what gets reported.
 *
 * The baseline stores this alongside the findings it recorded. If the config
 * changes afterwards, findings that were always there can start appearing as
 * "new", and a review would blame the current change for pre-existing debt.
 * Comparing fingerprints is what lets Little Owl notice and say so.
 *
 * Only the settings that affect findings are included. `ci` thresholds and the
 * default `scope` change exit codes and framing, not what the rules find, so
 * editing them does not invalidate a baseline.
 */
export const configFingerprint = (config: ResolvedConfig): string => {
  return hashContent(stableStringify(identity(config)));
};

const identity = (config: ResolvedConfig): unknown => ({
  strictness: config.strictness,
  include: [...config.include].sort(),
  ignore: [...config.ignore].sort(),
  architecture: {
    layers: config.architecture.layers,
    layerPolicy: config.architecture.layerPolicy,
    featureRoot: config.architecture.featureRoot,
    forbidden: [...config.architecture.forbidden].map(([from, to]) => `${from} -> ${to}`).sort(),
  },
  thresholds: config.thresholds,
  rules: config.rules,
});

/** JSON with object keys in a fixed order, so the hash does not depend on them. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
};
