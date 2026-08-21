/**
 * Little Owl Code, checking itself.
 *
 * No layers are declared: this is a library, not a layered application, and
 * inventing a hierarchy just to have one would produce findings that mean
 * nothing. What matters here is that no cycles appear, files stay a readable
 * size, and the type-safety escape hatches stay rare.
 *
 * Note: this config does not import `defineConfig` from the package, because a
 * package cannot resolve itself before it is built.
 */
export default {
  strictness: 'balanced',

  include: ['src/**'],

  architecture: {
    layerPolicy: 'downward',
  },

  thresholds: {
    maxFileLines: 500,
    maxFunctionLines: 80,
    maxComplexity: 15,
  },

  rules: {
    'architecture/circular-dependency': 'error',
    'type-safety/explicit-any': 'error',
    'type-safety/suppression': 'error',
    // The CLI command modules legitimately repeat option-plumbing shapes.
    'maintainability/duplicate-block': 'off',
  },

  ci: {
    failOn: 'error',
    maxOverallDrop: 5,
  },
};
