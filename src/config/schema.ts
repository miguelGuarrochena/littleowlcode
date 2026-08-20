import type { Severity } from '../core/types.js';

export type Strictness = 'relaxed' | 'balanced' | 'strict';

/**
 * How strictly layered dependencies are enforced.
 *
 * - `downward`: a layer may depend on any layer below it.
 * - `adjacent`: a layer may only depend on the layer directly below it, so
 *   `ui -> data` is reported as a skipped layer.
 */
export type LayerPolicy = 'downward' | 'adjacent';

export interface ArchitectureConfig {
  /**
   * Layers in dependency order, top first. Each entry maps a layer name to the
   * directories that belong to it.
   */
  layers?: Record<string, string[]>;
  layerPolicy?: LayerPolicy;
  /** Directory holding independent features, e.g. `features` or `modules`. */
  featureRoot?: string | null;
  /** Explicit `[from, to]` pairs that must never appear, as glob patterns. */
  forbidden?: Array<[string, string]>;
}

export interface Thresholds {
  maxFileLines: number;
  maxFunctionLines: number;
  maxComponentLines: number;
  maxComplexity: number;
  maxNesting: number;
  maxParams: number;
  maxImportDepth: number;
  /** Minimum identical statement lines before a duplicate block is reported. */
  minDuplicateLines: number;
  /** `any` usages per 1000 source lines before type safety is penalised. */
  maxAnyPerKLoc: number;
}

export interface CiConfig {
  /** Exit non-zero when a finding at this level (or above) is present. */
  failOn: 'error' | 'warning' | 'never';
  /** Exit non-zero when the overall score drops more than this vs baseline. */
  maxOverallDrop: number;
  /** Only consider findings that are new relative to the baseline. */
  newFindingsOnly: boolean;
}

export interface LittleOwlConfig {
  strictness?: Strictness;
  /** Directories that contain application code. Empty means "the whole repo". */
  include?: string[];
  ignore?: string[];
  architecture?: ArchitectureConfig;
  thresholds?: Partial<Thresholds>;
  /** Per-rule severity overrides, keyed by rule id. */
  rules?: Record<string, Severity>;
  ci?: Partial<CiConfig>;
  /** Default scope patterns for `review --scope`. */
  scope?: string[];
}

export interface ResolvedConfig {
  strictness: Strictness;
  include: string[];
  ignore: string[];
  architecture: Required<Omit<ArchitectureConfig, 'layers' | 'forbidden' | 'featureRoot'>> & {
    layers: Record<string, string[]>;
    forbidden: Array<[string, string]>;
    featureRoot: string | null;
  };
  thresholds: Thresholds;
  rules: Record<string, Severity>;
  ci: CiConfig;
  scope: string[];
  /** Absolute path of the config file that was loaded, if any. */
  sourcePath: string | null;
}

/** Helper for `.little-owl/config.ts` that gives users type checking. */
export function defineConfig(config: LittleOwlConfig): LittleOwlConfig {
  return config;
}
