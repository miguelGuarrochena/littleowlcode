import type { AnalysisContext } from '../core/context.js';
import { basename, dirOf } from '../utils/paths.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';

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

export interface DeadCodeReport {
  candidates: DeadCodeCandidate[];
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

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function findDeadCode(
  context: AnalysisContext,
  options: DeadCodeOptions = {},
): DeadCodeReport {
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

  for (const file of context.files) {
    if (file.isTest && !options.includeTests) continue;

    const dependents = context.graph.dependentsOf(file.path);
    if (dependents.length > 0) continue;

    if (
      matchesCompiled(file.path, conventions) ||
      isInEntryDirectory(file.path) ||
      packageEntries.has(file.path)
    ) {
      entryPoints.push(file.path);
      continue;
    }

    const reasons = ['nothing in the project imports it'];
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

    const confidence: Confidence =
      caveats.length === 0 ? 'high' : caveats.length === 1 ? 'medium' : 'low';

    candidates.push({
      path: file.path,
      confidence,
      reasons,
      caveats,
      lines: file.lines,
      exports: file.exports.length,
    });
  }

  const floor = CONFIDENCE_RANK[options.minConfidence ?? 'low'];

  return {
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
}

function isInEntryDirectory(file: string): boolean {
  const parts = dirOf(file).split('/');
  return parts.some((part) => ENTRY_DIRECTORIES.includes(part));
}

/** Files named as entry points by package.json (`main`, `bin`, `exports`). */
function packageEntryPoints(context: AnalysisContext): Set<string> {
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
}
