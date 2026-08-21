/**
 * One place that decides whether a declared package counts as used.
 *
 * The `dependencies/unused-dependency` rule and the `little-owl dependencies`
 * report both call in here, so they cannot disagree about the same package.
 */

/**
 * Packages that legitimately never appear in an import statement: type-only
 * packages, build tooling and framework CLIs.
 */
const IMPLICITLY_USED = [
  /^@types\//,
  // Required by React at runtime; App Router code never imports it directly.
  /^react-dom$/,
  /^eslint/,
  /^@eslint\//,
  /^typescript-eslint$/,
  /^prettier/,
  /^postcss/,
  /^tailwindcss$/,
  /^autoprefixer$/,
  /^typescript$/,
  /^tsx$/,
  /^tsup$/,
  /^vite$/,
  /^vitest/,
  /^@vitest\//,
  /^jest$/,
  /^husky$/,
  /^lint-staged$/,
  /^sharp$/,
  /^encoding$/,
];

/**
 * Node's own modules, which are importable without being declared. `node:`
 * prefixed specifiers are handled by the caller.
 */
const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'url',
  'util',
  'events',
  'stream',
  'crypto',
  'http',
  'https',
  'child_process',
  'assert',
  'buffer',
  'zlib',
  'net',
  'tls',
  'dns',
  'readline',
  'worker_threads',
  'perf_hooks',
  'string_decoder',
  'querystring',
  'timers',
  'tty',
  'v8',
  'vm',
  'process',
  'module',
]);

export const isNodeBuiltin = (name: string): boolean => {
  return name.startsWith('node:') || NODE_BUILTINS.has(name);
};

/** True when a package does its job without ever being imported. */
export const isImplicitlyUsed = (name: string): boolean => {
  return IMPLICITLY_USED.some((pattern) => pattern.test(name));
};

/**
 * Declared packages that nothing imports and that are not the kind of package
 * which works without being imported.
 */
export const unusedDependencies = (
  declared: Record<string, string>,
  imported: ReadonlySet<string>,
): string[] => {
  return Object.keys(declared)
    .filter((name) => !imported.has(name))
    .filter((name) => !isImplicitlyUsed(name))
    .sort();
};

/** Imported packages that no manifest declares, ignoring Node's own modules. */
export const undeclaredPackages = (
  imported: Iterable<string>,
  declared: Record<string, string>,
): string[] => {
  return [...imported].filter((name) => !isNodeBuiltin(name) && !(name in declared)).sort();
};
