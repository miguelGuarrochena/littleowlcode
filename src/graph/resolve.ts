import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Language } from '../core/types.js';
import { dirOf, toPosix } from '../utils/paths.js';

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface AliasRule {
  /** Prefix before the `*`, e.g. `@/`. Empty means an exact-match alias. */
  prefix: string;
  /** Replacement prefixes, repo-relative. */
  targets: string[];
  exact: boolean;
}

export interface ResolverContext {
  root: string;
  files: Set<string>;
  aliases: AliasRule[];
  /** Go module path from `go.mod`, used to map imports back to directories. */
  goModule: string | null;
  /** Directories that behave as Python/JS source roots. */
  sourceRoots: string[];
}

/** Reads `paths`/`baseUrl` from tsconfig so aliased imports resolve properly. */
export const readTsAliases = (root: string): AliasRule[] => {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return [];

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return [];

  const options = (read.config.compilerOptions ?? {}) as {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  const configDir = path.dirname(configPath);
  const baseUrl = options.baseUrl ? path.resolve(configDir, options.baseUrl) : configDir;
  const rules: AliasRule[] = [];

  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const exact = !pattern.includes('*');
    const prefix = exact ? pattern : pattern.slice(0, pattern.indexOf('*'));
    rules.push({
      prefix,
      exact,
      targets: targets.map((target) => {
        const cleaned = exact ? target : target.slice(0, target.indexOf('*'));
        return toPosix(path.relative(root, path.resolve(baseUrl, cleaned)));
      }),
    });
  }

  // Projects frequently use `@/` without declaring it (Next.js templates do).
  if (!rules.some((rule) => rule.prefix === '@/')) {
    const guesses = ['src', 'app', ''].filter((dir) =>
      dir === '' ? true : fs.existsSync(path.join(root, dir)),
    );
    rules.push({ prefix: '@/', exact: false, targets: guesses });
  }

  return rules;
};

export const readGoModule = (root: string): string | null => {
  const file = path.join(root, 'go.mod');
  if (!fs.existsSync(file)) return null;
  const match = /^module\s+(\S+)/m.exec(fs.readFileSync(file, 'utf8'));
  return match ? match[1]! : null;
};

const firstExisting = (candidates: string[], files: Set<string>): string | undefined => {
  return candidates.find((candidate) => files.has(candidate));
};

const jsCandidates = (base: string): string[] => {
  const candidates: string[] = [base];
  for (const extension of JS_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of JS_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  // `./foo.js` in an ESM TypeScript project actually points at `./foo.ts`.
  const withoutJs = base.replace(/\.[cm]?js$/, '');
  if (withoutJs !== base) {
    for (const extension of JS_EXTENSIONS) candidates.push(`${withoutJs}${extension}`);
  }
  return candidates;
};

const normalizeJoin = (fromDir: string, specifier: string): string => {
  return toPosix(path.posix.normalize(path.posix.join(fromDir, specifier))).replace(/^\.\//, '');
};

export const resolveJsImport = (
  fromFile: string,
  specifier: string,
  context: ResolverContext,
): string | undefined => {
  if (specifier.startsWith('.')) {
    const base = normalizeJoin(dirOf(fromFile), specifier);
    return firstExisting(jsCandidates(base), context.files);
  }

  for (const alias of context.aliases) {
    if (alias.exact) {
      if (specifier !== alias.prefix) continue;
      for (const target of alias.targets) {
        const hit = firstExisting(jsCandidates(target), context.files);
        if (hit) return hit;
      }
      continue;
    }
    if (!specifier.startsWith(alias.prefix)) continue;
    const rest = specifier.slice(alias.prefix.length);
    for (const target of alias.targets) {
      const base = target ? `${target}/${rest}` : rest;
      const hit = firstExisting(jsCandidates(base), context.files);
      if (hit) return hit;
    }
  }

  // Some projects import from the repo root without configuring an alias.
  for (const sourceRoot of context.sourceRoots) {
    const base = sourceRoot ? `${sourceRoot}/${specifier}` : specifier;
    const hit = firstExisting(jsCandidates(base), context.files);
    if (hit) return hit;
  }

  return undefined;
};

export const packageNameOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    // `@/foo` has an empty scope, so it is not an installable package name —
    // it is a path alias. Reporting `@/styles` as a missing dependency sends
    // people looking for a package that cannot exist.
    if (parts[0] === '@') return undefined;
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return parts[0];
};

/**
 * Whether a specifier is addressed through one of the project's own path
 * aliases, and is therefore internal however it ends up resolving.
 */
export const isAliasedSpecifier = (specifier: string, context: ResolverContext): boolean => {
  return context.aliases.some((alias) =>
    alias.exact
      ? specifier === alias.prefix
      : alias.prefix.length > 0 && specifier.startsWith(alias.prefix),
  );
};

export const resolvePythonImport = (
  fromFile: string,
  specifier: string,
  context: ResolverContext,
): string | undefined => {
  const pythonCandidates = (base: string): string[] => [`${base}.py`, `${base}/__init__.py`];

  if (specifier.startsWith('.')) {
    const upLevels = /^\.+/.exec(specifier)![0]!.length;
    const moduleName = specifier.slice(upLevels).replace(/\./g, '/');
    let dir = dirOf(fromFile);
    for (let level = 1; level < upLevels; level += 1) dir = dirOf(dir);
    const base = moduleName ? `${dir}/${moduleName}` : `${dir}/__init__`;
    return firstExisting(
      moduleName ? pythonCandidates(base) : [`${dir}/__init__.py`],
      context.files,
    );
  }

  const asPath = specifier.replace(/\./g, '/');
  for (const sourceRoot of ['', ...context.sourceRoots]) {
    const base = sourceRoot ? `${sourceRoot}/${asPath}` : asPath;
    const hit = firstExisting(pythonCandidates(base), context.files);
    if (hit) return hit;
  }
  return undefined;
};

/**
 * Go imports address packages (directories). We resolve to every non-test file
 * of the target package so the file-level graph still reflects package edges.
 */
export const resolveGoImport = (specifier: string, context: ResolverContext): string[] => {
  if (!context.goModule) return [];
  if (specifier !== context.goModule && !specifier.startsWith(`${context.goModule}/`)) return [];

  const relative =
    specifier === context.goModule ? '' : specifier.slice(context.goModule.length + 1);
  const targets: string[] = [];

  for (const file of context.files) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    if (dirOf(file) !== relative) continue;
    targets.push(file);
  }

  return targets.sort();
};

export const createResolverContext = (
  root: string,
  files: string[],
  languages: Language[],
): ResolverContext => {
  const sourceRoots = ['src', 'app', 'lib', 'packages'].filter((dir) =>
    fs.existsSync(path.join(root, dir)),
  );

  return {
    root,
    files: new Set(files),
    aliases:
      languages.includes('typescript') || languages.includes('javascript')
        ? readTsAliases(root)
        : [],
    goModule: readGoModule(root),
    sourceRoots,
  };
};
