import type { ParsedFile } from '../core/types.js';

/**
 * Which JavaScript files in a TypeScript project are actually a type-safety gap.
 *
 * Not every `.js` file is one. Several kinds of file have to be JavaScript:
 *
 *  - `.mjs` / `.cjs` scripts, run directly by node, where a TypeScript file
 *    would need a loader before it would even start;
 *  - tool configuration at the repository root;
 *  - anything served verbatim as a static asset — a service worker under
 *    `public/` is shipped to the browser as-is.
 *
 * Counting those as untyped code produces a finding nobody can act on, and
 * costs type-safety points for a problem that does not exist. The rule and the
 * score share this predicate so they can never disagree about it.
 */

/** Directories whose contents are shipped as-is rather than compiled. */
const SERVED_DIRECTORIES = ['public', 'static', 'assets'];

/** Root-level tool configuration: `jest.config.js`, `jest.setup.js`, ... */
const ROOT_TOOLING = /^[^/]*\.(config|setup|conf|rc)\.[cm]?js$/;

export const isUntypedSource = (file: ParsedFile): boolean => {
  if (file.language !== 'javascript' || file.isTest) return false;

  // A module-format-specific extension is a deliberate choice to be JavaScript.
  if (/\.[cm]js$/.test(file.path)) return false;
  if (ROOT_TOOLING.test(file.path)) return false;

  const [top] = file.path.split('/');
  return top === undefined || !SERVED_DIRECTORIES.includes(top);
};

/** The untyped files in a project, or none when it is not a TypeScript project. */
export const untypedSources = (files: ParsedFile[], hasTypeScript: boolean): string[] => {
  if (!hasTypeScript) return [];
  return files.filter(isUntypedSource).map((file) => file.path);
};
