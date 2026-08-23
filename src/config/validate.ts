import type { ParsedFile } from '../core/types.js';
import { matchesLayerDirectory, type LayerModel } from '../architecture/layers.js';
import { compileProjectPattern, matchesProjectPath } from '../utils/glob.js';
import { DEFAULT_RULE_SEVERITIES } from './defaults.js';
import type { LittleOwlConfig, ResolvedConfig } from './schema.js';

/**
 * Configuration is checked, not merely parsed.
 *
 * A misspelled key or a rule id that does not exist is accepted silently by a
 * plain object merge, and a switched-off rule looks exactly like a rule that
 * found nothing. Believing you have a check you do not have is worse than
 * having no check at all, so every one of these is said out loud.
 */

const TOP_LEVEL_KEYS = [
  'strictness',
  'include',
  'ignore',
  'architecture',
  'thresholds',
  'rules',
  'ci',
  'scope',
] as const;

const ARCHITECTURE_KEYS = ['layers', 'layerPolicy', 'featureRoot', 'forbidden'] as const;

const THRESHOLD_KEYS = [
  'maxFileLines',
  'maxFunctionLines',
  'maxComponentLines',
  'maxComplexity',
  'maxNesting',
  'maxParams',
  'maxImportDepth',
  'minDuplicateLines',
  'maxAnyPerKLoc',
] as const;

const CI_KEYS = ['failOn', 'maxOverallDrop', 'newFindingsOnly'] as const;

const STRICTNESS_VALUES = ['relaxed', 'balanced', 'strict'];
const LAYER_POLICIES = ['adjacent', 'downward'];
const SEVERITIES = ['off', 'info', 'warning', 'error'];

/** Every rule id that can be given a severity. */
export const knownRuleIds = (): string[] => Object.keys(DEFAULT_RULE_SEVERITIES);

/**
 * Checks the shape of a config object, before defaults are merged in.
 *
 * Never throws: a warning that stops the run helps nobody, and the analysis is
 * still useful with one setting ignored.
 */
export const validateConfig = (raw: LittleOwlConfig): string[] => {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return warnings;

  const record = raw as Record<string, unknown>;

  unknownKeys(record, TOP_LEVEL_KEYS, '', warnings);
  unknownKeys(nested(record, 'architecture'), ARCHITECTURE_KEYS, 'architecture.', warnings);
  unknownKeys(nested(record, 'thresholds'), THRESHOLD_KEYS, 'thresholds.', warnings);
  unknownKeys(nested(record, 'ci'), CI_KEYS, 'ci.', warnings);

  oneOf(record['strictness'], STRICTNESS_VALUES, 'strictness', warnings);
  oneOf(
    nested(record, 'architecture')['layerPolicy'],
    LAYER_POLICIES,
    'architecture.layerPolicy',
    warnings,
  );
  oneOf(nested(record, 'ci')['failOn'], [...SEVERITIES.slice(2), 'never'], 'ci.failOn', warnings);

  for (const [ruleId, severity] of Object.entries(nested(record, 'rules'))) {
    if (!(ruleId in DEFAULT_RULE_SEVERITIES)) {
      const hint = suggest(ruleId, knownRuleIds());
      warnings.push(
        `rules: "${ruleId}" is not a rule, so this severity is ignored` +
          (hint === '.' ? ' — see `little-owl config --rules` for the full list.' : hint),
      );
      continue;
    }
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
      warnings.push(
        `rules["${ruleId}"]: ${JSON.stringify(severity)} is not a severity — use ${SEVERITIES.join(', ')}.`,
      );
    }
  }

  for (const [index, pair] of (
    record['architecture'] as LittleOwlConfig['architecture']
  )?.forbidden?.entries() ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      warnings.push(
        `architecture.forbidden[${index}]: expected a [from, to] pair of glob patterns.`,
      );
    }
  }

  return warnings;
};

/**
 * Checks configuration against the project it was written for.
 *
 * A pattern that matches nothing is the failure mode that costs the most time:
 * it looks identical to a rule that is working and finding no problems.
 */
export const validateAgainstProject = (
  config: ResolvedConfig,
  files: ParsedFile[],
  layers: LayerModel,
): string[] => {
  const warnings: string[] = [];
  if (files.length === 0) return warnings;

  const paths = files.map((file) => file.path);

  // Only configured layers are worth reporting. An inferred model is built from
  // the directories that exist, so it cannot name one that does not.
  if (!layers.inferred) {
    for (const [layer, directories] of Object.entries(config.architecture.layers)) {
      for (const directory of directories) {
        if (paths.some((candidate) => matchesLayerDirectory(candidate, directory))) continue;
        warnings.push(
          `architecture.layers.${layer}: "${directory}" matches no file, so that layer is ` +
            'smaller than you declared it.',
        );
      }
    }
  }

  for (const [from, to] of config.architecture.forbidden) {
    for (const [side, pattern] of [
      ['from', from],
      ['to', to],
    ] as const) {
      const compiled = compileProjectPattern(pattern);
      if (paths.some((candidate) => matchesProjectPath(candidate, compiled))) continue;
      warnings.push(
        `architecture.forbidden: the ${side} pattern "${pattern}" matches no file, so the rule ` +
          'never fires.',
      );
    }
  }

  return warnings;
};

const nested = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const unknownKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  warnings: string[],
): void => {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    warnings.push(`${prefix}${key} is not a Little Owl setting${suggest(key, allowed)}`);
  }
};

const oneOf = (
  value: unknown,
  allowed: readonly string[],
  label: string,
  warnings: string[],
): void => {
  if (value === undefined) return;
  if (typeof value === 'string' && allowed.includes(value)) return;
  warnings.push(`${label}: ${JSON.stringify(value)} is not valid — use ${allowed.join(', ')}.`);
};

/**
 * " — did you mean X?" when something close enough exists, otherwise ".".
 *
 * Both endings are terminal punctuation, so callers never append their own.
 */
const suggest = (value: string, candidates: readonly string[]): string => {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(value.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Allow roughly one mistake per four characters, so unrelated names stay out.
  const budget = Math.max(1, Math.floor(Math.max(value.length, best?.length ?? 0) / 4));
  return best && bestDistance <= budget ? ` — did you mean "${best}"?` : '.';
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
};
