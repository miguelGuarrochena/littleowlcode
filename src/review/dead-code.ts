import type { AnalysisContext } from '../core/context.js';
import type { ParsedFile } from '../core/types.js';
import { basename, dirOf } from '../utils/paths.js';
import { compilePattern, matchesCompiled, type CompiledPattern } from '../utils/glob.js';

/**
 * Dead code detection, deliberately cautious.
 *
 * Static reachability cannot see everything: framework file conventions,
 * dynamic imports built from variables, plugin registries and config-driven
 * loading all make a file reachable without a single import statement. So this
 * reports *candidates* with a confidence level, and reserves `high` for files
 * where none of those escape hatches apply.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface DeadCodeCandidate {
  path: string;
  confidence: Confidence;
  /** Why Little Owl thinks it is unused. */
  reasons: string[];
  /** Why it might still be reachable. Non-empty means confidence is capped. */
  caveats: string[];
  lines: number;
  exports: number;
}

export interface UnusedExport {
  file: string;
  /** Exported names nothing else imports. */
  names: string[];
  confidence: Confidence;
  caveats: string[];
}

export interface DeadCodeReport {
  candidates: DeadCodeCandidate[];
  /** Names exported from a live file that no other file imports. */
  unusedExports: UnusedExport[];
  /** Files skipped because a framework convention makes them entry points. */
  entryPoints: string[];
  /** True when the project uses dynamic imports we could not fully resolve. */
  hasUnresolvedDynamicImports: boolean;
}

/**
 * Files a framework loads by name rather than by import. None of these are ever
 * reported: a Next.js `page.tsx` has no importer by design.
 */
const CONVENTION_ENTRY_POINTS = [
  '**/page.{ts,tsx,js,jsx}',
  '**/layout.{ts,tsx,js,jsx}',
  '**/route.{ts,tsx,js,jsx}',
  '**/loading.{ts,tsx,js,jsx}',
  '**/error.{ts,tsx,js,jsx}',
  '**/not-found.{ts,tsx,js,jsx}',
  '**/template.{ts,tsx,js,jsx}',
  '**/default.{ts,tsx,js,jsx}',
  '**/middleware.{ts,js}',
  '**/instrumentation.{ts,js}',
  '**/opengraph-image.{ts,tsx}',
  '**/sitemap.{ts,js}',
  '**/robots.{ts,js}',
  '**/global-error.{ts,tsx}',
  '**/+page.{svelte,ts,js}',
  '**/+layout.{svelte,ts,js}',
  '**/index.{ts,tsx,js,jsx,mjs,cjs}',
  '**/main.{ts,tsx,js,jsx,go}',
  '**/*.config.{ts,js,mjs,cjs}',
  '**/*.d.ts',
  '**/conftest.py',
  '**/__init__.py',
  '**/manage.py',
  '**/setup.py',
  '**/urls.py',
  '**/wsgi.py',
  '**/asgi.py',
  '**/settings.py',
  '**/models.py',
  '**/admin.py',
];

/** Directories whose contents are entry points by convention. */
const ENTRY_DIRECTORIES = ['pages', 'app', 'api', 'routes', 'migrations', 'scripts', 'bin', 'cmd'];

export interface DeadCodeOptions {
  /** Include test files in the search. Off by default; tests have no importers. */
  includeTests?: boolean;
  /** Only report candidates at or above this confidence. */
  minConfidence?: Confidence;
}

/**
 * Exported names that nothing imports.
 *
 * Deliberately narrower than the file-level search. It only looks at files
 * something already imports — a file nobody imports at all is reported as a
 * whole, not name by name — and it goes quiet for any module reached through
 * `import * as ns`, `export * from`, `require()` or a dynamic import, because
 * those take everything and leave no record of which name was wanted.
 *
 * Only TypeScript and JavaScript participate. Python and Go export detection is
 * too shallow to say "nobody uses this name" without being wrong regularly.
 */
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** What each module has taken out of it, and which modules were taken whole. */
interface NameUsage {
  byFile: Map<string, Set<string>>;
  /**
   * The same, counting only test files. An export nothing but a test reaches is
   * still reachable, but it is worth saying which kind of reachable it is.
   */
  byTests: Map<string, Set<string>>;
  /** Modules reached through a wildcard, where no name can be ruled out. */
  wildcarded: Set<string>;
}

const collectNameUsage = (context: AnalysisContext): NameUsage => {
  const byFile = new Map<string, Set<string>>();
  const byTests = new Map<string, Set<string>>();
  const wildcarded = new Set<string>();

  for (const file of context.files) {
    for (const reference of file.imports) {
      const target = reference.resolved;
      if (!target) continue;

      if (reference.wildcard) {
        wildcarded.add(target);
        continue;
      }

      const names = byFile.get(target) ?? new Set<string>();
      for (const name of reference.names ?? []) names.add(name);
      byFile.set(target, names);

      if (!file.isTest) continue;
      const testNames = byTests.get(target) ?? new Set<string>();
      for (const name of reference.names ?? []) testNames.add(name);
      byTests.set(target, testNames);
    }
  }

  return { byFile, byTests, wildcarded };
};

/** Whether a file's exported names can be judged at all. */
const canJudgeExports = (
  file: ParsedFile,
  context: AnalysisContext,
  usage: NameUsage,
  conventions: CompiledPattern[],
  packageEntries: Set<string>,
): boolean => {
  if (file.isTest) return false;
  // Python and Go export detection is too shallow to say "nobody uses this".
  if (file.language !== 'typescript' && file.language !== 'javascript') return false;
  if (file.exports.length === 0) return false;
  // No importers at all is the file-level case, reported separately.
  if (context.graph.dependentsOf(file.path).length === 0) return false;
  // Something takes the whole module; any name could be the one it wanted.
  if (usage.wildcarded.has(file.path)) return false;
  if (matchesCompiled(file.path, conventions)) return false;
  if (packageEntries.has(file.path)) return false;
  return !isInEntryDirectory(file.path);
};

const findUnusedExports = (
  context: AnalysisContext,
  conventions: CompiledPattern[],
  packageEntries: Set<string>,
): UnusedExport[] => {
  const usage = collectNameUsage(context);
  const unused: UnusedExport[] = [];

  for (const file of context.files) {
    if (!canJudgeExports(file, context, usage, conventions, packageEntries)) continue;

    const used = usage.byFile.get(file.path) ?? new Set<string>();
    const names = file.exports.filter((name) => !used.has(name)).sort();
    if (names.length === 0) continue;

    // Tests do count as usage, so a name listed here is reached by nothing at
    // all. What is worth flagging is the neighbouring case: names in this file
    // that only a test reaches.
    const fromTests = usage.byTests.get(file.path) ?? new Set<string>();
    const testOnly = file.exports.filter((name) => fromTests.has(name)).sort();
    const caveats =
      testOnly.length > 0
        ? [
            `${testOnly.join(', ')} in this file ${testOnly.length === 1 ? 'is' : 'are'} only used from tests`,
          ]
        : [];

    unused.push({
      file: file.path,
      names,
      confidence: caveats.length === 0 ? 'high' : 'medium',
      caveats,
    });
  }

  return unused.sort((a, b) => (a.file < b.file ? -1 : 1));
};

/** Every path-shaped string literal anywhere in the project. */
const pathLiterals = (context: AnalysisContext): Set<string> => {
  const literals = new Set<string>();
  for (const file of context.files) {
    const found = file.meta['pathLiterals'];
    if (!Array.isArray(found)) continue;
    for (const literal of found) if (typeof literal === 'string') literals.add(literal);
  }
  return literals;
};

/**
 * Whether some string in the project names this file.
 *
 * A config that points at `<rootDir>/jest.setup.js`, or a component that
 * registers `'/sw.js'`, keeps that file alive without importing it. The literal
 * has to match the whole filename plus whatever directories it gave, so a
 * passing mention of `foo.ts` cannot silence a real finding about `a/b/foo.ts`.
 */
const isNamedInSource = (file: string, literals: Set<string>): boolean => {
  for (const literal of literals) {
    if (literal === file || file.endsWith(`/${literal}`)) return true;
  }
  return false;
};

/**
 * The barrel that is the only thing keeping this file alive, if there is one.
 *
 * `index.ts` doing `export { X } from './X'` counts as an importer, so dead
 * code hides behind barrels: the file has a dependent, the barrel is an entry
 * point by convention, and neither is ever reported. A re-export only keeps a
 * module alive if somebody actually takes that name out of the barrel.
 */
const reachedOnlyByUnusedReExport = (
  file: ParsedFile,
  context: AnalysisContext,
  usage: NameUsage,
  packageEntries: Set<string>,
): string | null => {
  let barrel: string | null = null;

  for (const dependent of context.graph.dependentsOf(file.path)) {
    // A published entry point can be imported from outside the repository.
    if (packageEntries.has(dependent)) return null;

    const parsed = context.fileMap.get(dependent);
    if (!parsed) return null;

    const references = parsed.imports.filter((reference) => reference.resolved === file.path);
    if (references.length === 0) return null;
    // Anything that is not a re-export is somebody genuinely using the module.
    if (references.some((reference) => reference.kind !== 'export-from')) return null;
    // `export * from` republishes everything, so no name can be ruled out.
    if (references.some((reference) => reference.wildcard)) return null;
    // Something takes the barrel whole; any name could be the one it wanted.
    if (usage.wildcarded.has(dependent)) return null;

    const republished = references.flatMap((reference) => reference.names ?? []);
    if (republished.length === 0) return null;

    const takenFromBarrel = usage.byFile.get(dependent) ?? new Set<string>();
    if (republished.some((name) => takenFromBarrel.has(name))) return null;

    barrel = dependent;
  }

  return barrel;
};

export const findDeadCode = (
  context: AnalysisContext,
  options: DeadCodeOptions = {},
): DeadCodeReport => {
  const conventions = CONVENTION_ENTRY_POINTS.map(compilePattern);
  const entryPoints: string[] = [];
  const candidates: DeadCodeCandidate[] = [];

  // A dynamic import whose specifier is not a plain string could reach
  // anything, so its presence caps confidence across the whole project.
  const hasUnresolvedDynamicImports = context.files.some((file) =>
    file.imports.some(
      (reference) =>
        reference.computed === true || (reference.kind === 'dynamic' && !reference.resolved),
    ),
  );

  // Packages re-export through their manifest, not through imports.
  const packageEntries = packageEntryPoints(context);
  const usage = collectNameUsage(context);
  const namedInSource = pathLiterals(context);

  for (const file of context.files) {
    if (file.isTest && !options.includeTests) continue;

    const dependents = context.graph.dependentsOf(file.path);
    const barrel =
      dependents.length === 0
        ? null
        : reachedOnlyByUnusedReExport(file, context, usage, packageEntries);
    if (dependents.length > 0 && !barrel) continue;

    if (
      matchesCompiled(file.path, conventions) ||
      isInEntryDirectory(file.path) ||
      packageEntries.has(file.path) ||
      isNamedInSource(file.path, namedInSource)
    ) {
      entryPoints.push(file.path);
      continue;
    }

    candidates.push(describeCandidate(file, barrel, hasUnresolvedDynamicImports));
  }

  const floor = CONFIDENCE_RANK[options.minConfidence ?? 'low'];

  return {
    unusedExports: findUnusedExports(context, conventions, packageEntries),
    candidates: candidates
      .filter((candidate) => CONFIDENCE_RANK[candidate.confidence] >= floor)
      .sort(
        (a, b) =>
          CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
          (a.path < b.path ? -1 : 1),
      ),
    entryPoints: entryPoints.sort(),
    hasUnresolvedDynamicImports,
  };
};

/**
 * The case for and against one candidate.
 *
 * Confidence falls with every reason the conclusion might be wrong, which is
 * the whole contract of this command: it never claims to know, it says how much
 * of a guess each answer is.
 */
const describeCandidate = (
  file: ParsedFile,
  barrel: string | null,
  hasUnresolvedDynamicImports: boolean,
): DeadCodeCandidate => {
  const reasons = [
    barrel
      ? `only re-exported by ${barrel}, and nothing takes that name from it`
      : 'nothing in the project imports it',
  ];
  const caveats: string[] = [];

  if (file.exports.length === 0) {
    reasons.push('it exports nothing');
  } else {
    caveats.push(`it exports ${file.exports.length} name${file.exports.length === 1 ? '' : 's'}`);
  }

  if (hasUnresolvedDynamicImports) {
    caveats.push('the project uses dynamic imports Little Owl could not resolve');
  }
  if (file.language === 'python' || file.language === 'go') {
    caveats.push(`${file.language} resolution is shallower than for TypeScript`);
  }

  return {
    path: file.path,
    confidence: caveats.length === 0 ? 'high' : caveats.length === 1 ? 'medium' : 'low',
    reasons,
    caveats,
    lines: file.lines,
    exports: file.exports.length,
  };
};

const isInEntryDirectory = (file: string): boolean => {
  const parts = dirOf(file).split('/');
  return parts.some((part) => ENTRY_DIRECTORIES.includes(part));
};

/** Files named as entry points by package.json (`main`, `bin`, `exports`). */
const packageEntryPoints = (context: AnalysisContext): Set<string> => {
  const entries = new Set<string>();
  const candidates = new Set<string>();

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      candidates.add(value.replace(/^\.\//, ''));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collect(item);
    }
  };

  collect(context.project.entryPoints);

  for (const candidate of candidates) {
    // A manifest points at built output; the source that produced it is what
    // exists in the file tree, so match on the name rather than the exact path.
    const name = basename(candidate).replace(/\.[cm]?js$/, '');
    for (const file of context.files) {
      if (file.path === candidate || basename(file.path).replace(/\.[cm]?tsx?$/, '') === name) {
        entries.add(file.path);
      }
    }
  }

  return entries;
};
