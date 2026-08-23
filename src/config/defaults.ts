import type { Severity } from '../core/types.js';
import type { CiConfig, ResolvedConfig, Strictness, Thresholds } from './schema.js';

/**
 * Paths whose contents are not the application.
 *
 * Two kinds live here. Build output and dependencies are obvious. The second
 * kind is less obvious and matters more: **sample code**.
 *
 * A `tests/fixtures/` directory in a linter, a `__mocks__` folder, an
 * `examples/` directory in a library — these hold code that is deliberately
 * wrong, deliberately tiny, or deliberately illustrative. Analysing it produces
 * findings that are all true and all useless: "fix this circular dependency"
 * pointing at a fixture named `circular-dependencies` is the fastest way to
 * teach someone that this tool does not understand their project. Worse, acting
 * on the advice breaks their test suite.
 *
 * The cost of being wrong in each direction is not symmetric. Missing real
 * findings inside an `examples/` folder costs very little; drowning a first run
 * in findings about sample code costs the user's trust in everything else.
 */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/vendor/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.svelte-kit/**',
  '**/target/**',
  '**/*.min.js',
  '**/*.d.ts',
  '**/.little-owl/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/storybook-static/**',
  '**/.vercel/**',
  '**/.output/**',
  '**/.astro/**',

  // Sample code: deliberately broken, deliberately trivial, or illustrative.
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/testdata/**',
  'examples/**',
  'example/**',
  '**/*.stories.*',
  '**/*.fixture.*',
];

/**
 * The subset of `DEFAULT_IGNORE` that holds sample code rather than build
 * output. Reported separately by `init` and `doctor`, because excluding
 * `node_modules` needs no explanation and excluding somebody's `examples/`
 * directory does.
 */
export const SAMPLE_CODE_IGNORE = [
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/testdata/**',
  'examples/**',
  'example/**',
  '**/*.stories.*',
  '**/*.fixture.*',
];

export const THRESHOLD_PRESETS: Record<Strictness, Thresholds> = {
  relaxed: {
    maxFileLines: 1200,
    maxFunctionLines: 160,
    maxComponentLines: 1000,
    maxComplexity: 25,
    maxNesting: 6,
    maxParams: 8,
    maxImportDepth: 12,
    minDuplicateLines: 12,
    maxAnyPerKLoc: 12,
  },
  balanced: {
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
  strict: {
    maxFileLines: 400,
    maxFunctionLines: 60,
    maxComponentLines: 300,
    maxComplexity: 10,
    maxNesting: 3,
    maxParams: 4,
    maxImportDepth: 6,
    minDuplicateLines: 6,
    maxAnyPerKLoc: 2,
  },
};

/**
 * Default severities per rule id. Strictness raises or lowers a few of these so
 * a "strict" project is noisier on purpose and a "relaxed" one stays quiet.
 */
export const DEFAULT_RULE_SEVERITIES: Record<string, Severity> = {
  'architecture/circular-dependency': 'error',
  'architecture/layer-violation': 'error',
  'architecture/layer-skip': 'warning',
  'architecture/cross-feature-import': 'warning',
  'architecture/forbidden-dependency': 'error',
  'architecture/deep-import-chain': 'info',
  'architecture/unlayered-code': 'info',

  'complexity/large-file': 'warning',
  'complexity/large-function': 'warning',
  'complexity/large-component': 'warning',
  'complexity/high-complexity': 'warning',
  'complexity/deep-nesting': 'info',
  'complexity/too-many-params': 'info',

  'maintainability/duplicate-block': 'info',
  'maintainability/unresolved-import': 'info',

  'type-safety/explicit-any': 'warning',
  'type-safety/suppression': 'warning',
  'type-safety/unsafe-assertion': 'info',
  'type-safety/js-in-ts-project': 'info',

  'react/effect-dependency-risk': 'info',
  'next/server-import-in-client': 'error',
  'next/secret-in-client-bundle': 'error',
  'next/server-module-in-client-bundle': 'error',

  'python/bare-except': 'warning',
  'python/mutable-default': 'warning',
  'python/global-state': 'info',

  'go/ignored-error': 'warning',
  'go/large-package': 'info',

  'patterns/duplicate-helper': 'warning',
  'patterns/parallel-implementations': 'warning',
  'patterns/thin-wrapper': 'info',
  'patterns/abstraction-growth': 'info',

  'dependencies/major-version-change': 'warning',
  'dependencies/new-dependency': 'info',
  'dependencies/unused-dependency': 'info',
  'dependencies/duplicate-dependency': 'warning',
};

const STRICTNESS_OVERRIDES: Record<Strictness, Record<string, Severity>> = {
  relaxed: {
    'architecture/layer-skip': 'info',
    'architecture/cross-feature-import': 'info',
    'complexity/deep-nesting': 'off',
    'complexity/too-many-params': 'off',
    'maintainability/duplicate-block': 'off',
    'type-safety/explicit-any': 'info',
    'type-safety/unsafe-assertion': 'off',
    'type-safety/js-in-ts-project': 'off',
    'architecture/deep-import-chain': 'off',
    'patterns/thin-wrapper': 'off',
    'patterns/abstraction-growth': 'off',
    'patterns/parallel-implementations': 'info',
    'dependencies/new-dependency': 'off',
    'dependencies/unused-dependency': 'off',
  },
  balanced: {},
  strict: {
    'architecture/layer-skip': 'error',
    'architecture/cross-feature-import': 'error',
    'complexity/deep-nesting': 'warning',
    'complexity/too-many-params': 'warning',
    'maintainability/duplicate-block': 'warning',
    'type-safety/unsafe-assertion': 'warning',
    'type-safety/js-in-ts-project': 'warning',
    'react/effect-dependency-risk': 'warning',
    'patterns/thin-wrapper': 'warning',
    'patterns/abstraction-growth': 'warning',
    'dependencies/new-dependency': 'warning',
  },
};

export const DEFAULT_CI: CiConfig = {
  failOn: 'error',
  maxOverallDrop: 5,
  newFindingsOnly: true,
};

export const ruleSeveritiesFor = (strictness: Strictness): Record<string, Severity> => {
  return { ...DEFAULT_RULE_SEVERITIES, ...STRICTNESS_OVERRIDES[strictness] };
};

export const baseConfig = (strictness: Strictness = 'balanced'): ResolvedConfig => {
  return {
    strictness,
    include: [],
    ignore: [...DEFAULT_IGNORE],
    architecture: {
      layers: {},
      layerPolicy: strictness === 'relaxed' ? 'downward' : 'adjacent',
      featureRoot: null,
      forbidden: [],
    },
    thresholds: { ...THRESHOLD_PRESETS[strictness] },
    rules: ruleSeveritiesFor(strictness),
    ci: { ...DEFAULT_CI },
    scope: [],
    sourcePath: null,
    warnings: [],
  };
};
