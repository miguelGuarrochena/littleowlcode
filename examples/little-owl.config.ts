/**
 * A fully annotated Little Owl Code configuration.
 *
 * Copy the parts you need into `.little-owl/config.ts`. Everything is optional:
 * with no configuration at all, Little Owl infers a structure and says so.
 */
import { defineConfig } from 'little-owl-code';

export default defineConfig({
  /**
   * Sets the default thresholds and rule severities.
   * 'relaxed'  — only clear structural problems
   * 'balanced' — the default
   * 'strict'   — small files, tight boundaries, more findings
   */
  strictness: 'balanced',

  /**
   * Paths that contain application code. Leave this out to analyse everything
   * that is not ignored.
   */
  include: ['app/**', 'components/**', 'services/**', 'lib/**'],

  architecture: {
    /**
     * Layers listed top (most abstract) to bottom (most concrete). The order of
     * the keys is the order of the layers.
     */
    layers: {
      ui: ['app', 'components'],
      application: ['services', 'domain'],
      data: ['repositories', 'lib/db'],
    },

    /**
     * 'adjacent' — a layer may only depend on the layer directly below it, so
     *              `ui -> data` is reported as a skipped layer.
     * 'downward' — a layer may depend on any layer below it.
     */
    layerPolicy: 'adjacent',

    /** Directory holding independent features, checked for cross-imports. */
    featureRoot: 'features',

    /** Dependencies that must never exist, as [from, to] glob pairs. */
    forbidden: [
      ['components/**', 'lib/db/**'],
      ['features/*/internal/**', 'features/*/internal/**'],
    ],
  },

  thresholds: {
    maxFileLines: 800,
    maxFunctionLines: 100,
    maxComponentLines: 800,
    maxComplexity: 15,
    maxNesting: 4,
    maxParams: 5,
    maxImportDepth: 8,
    minDuplicateLines: 8,
    maxAnyPerKLoc: 6,
  },

  /** Severity: 'off' | 'info' | 'warning' | 'error'. */
  rules: {
    'architecture/circular-dependency': 'error',
    'architecture/layer-violation': 'error',
    'architecture/layer-skip': 'warning',
    'architecture/cross-feature-import': 'warning',
    'complexity/large-file': 'warning',
    'complexity/large-component': 'warning',
    'type-safety/explicit-any': 'warning',
    'type-safety/suppression': 'warning',
    'maintainability/duplicate-block': 'info',

    // The client/server boundary. Both are `error` by default and there is
    // rarely a good reason to lower them: a secret in a browser bundle is
    // readable by anyone who visits the page.
    'next/secret-in-client-bundle': 'error',
    'next/server-module-in-client-bundle': 'error',

    // Turn off anything that does not fit how this project works.
    'dependencies/unused-dependency': 'off',
  },

  /** Added to the built-in ignore list, never replacing it. */
  ignore: ['generated/**', 'src/legacy/**', '**/*.stories.tsx'],

  /** Default scope for `little-owl review`, overridable with --scope. */
  scope: [],

  ci: {
    /** Severity that fails the build: 'error' | 'warning' | 'never'. */
    failOn: 'error',
    /** Fail if the overall score drops by more than this many points. */
    maxOverallDrop: 5,
    /** Only judge findings this change introduced, not pre-existing debt. */
    newFindingsOnly: true,
  },
});
