import ts from 'typescript';

/**
 * Things worth noticing about a file that are not part of its structure.
 *
 * The adapter's job is shape — imports, functions, exports. These are the
 * smaller observations rules ask for later: which secrets a file reads, which
 * effects have no dependency list, which paths it mentions in a string. They
 * live together because they share nothing with the shape extraction except the
 * syntax tree, and separating them keeps the adapter readable.
 *
 * Everything here is recorded raw, without judgement. The results go into the
 * parse cache, so a file parsed today must still answer correctly under a rule
 * written next month.
 */

export interface EnvRead {
  name: string;
  line: number;
}

/**
 * Every `process.env.X` this file reads.
 *
 * Collected raw — no judgement about which names are secret. That call depends
 * on configuration and on rules that change more often than the parser does,
 * and this result is written to the parse cache: classifying here would mean a
 * cached file kept whichever answer was correct on the day it was parsed.
 */
const MAX_ENV_READS = 60;

export const collectEnvReads = (source: ts.SourceFile): EnvRead[] => {
  const found: EnvRead[] = [];
  const seen = new Set<string>();

  const record = (name: string, node: ts.Node): void => {
    if (seen.has(name) || found.length >= MAX_ENV_READS) return;
    seen.add(name);
    found.push({
      name,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  const isProcessEnv = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process';

  const visit = (node: ts.Node): void => {
    // `process.env.STRIPE_SECRET_KEY`
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      record(node.name.text, node);
    }
    // `process.env['STRIPE_SECRET_KEY']`
    if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      record(node.argumentExpression.text, node);
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return found;
};

/**
 * Lines where `useEffect` is called without a dependency array, meaning the
 * effect re-runs after every single render.
 */
export const collectEffectsWithoutDeps = (source: ts.SourceFile): number[] => {
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'useEffect' || node.expression.text === 'useLayoutEffect') &&
      node.arguments.length === 1
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return lines;
};

/**
 * Quoted strings that name a file, outside of any import.
 *
 * Plenty of files are referenced without being imported: a jest config naming
 * its setup file, a service worker registered as `'/sw.js'`, a route table
 * built from paths. Reachability that only follows imports calls all of them
 * dead, so this is the trace that keeps them alive.
 */
const PATH_LITERAL = /['"`]([^'"`\n\s]*\/[^'"`\n\s]*\.[A-Za-z0-9]{1,5})['"`]/g;

/** Enough to cover a config file; a cap keeps a generated file from bloating the cache. */
const MAX_PATH_LITERALS = 200;

export const collectPathLiterals = (content: string): string[] => {
  const found = new Set<string>();
  for (const match of content.matchAll(PATH_LITERAL)) {
    found.add(normalizeLiteral(match[1]!));
    if (found.size >= MAX_PATH_LITERALS) break;
  }
  return [...found];
};

/** Drops the prefixes tools put in front of a path: `./`, `/`, `<rootDir>/`. */
const normalizeLiteral = (value: string): string =>
  value
    .replace(/^<[^>]+>\//, '')
    .replace(/^\.{1,2}\//, '')
    .replace(/^\//, '');
