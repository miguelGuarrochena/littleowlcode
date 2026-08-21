import type { AnalysisContext } from '../core/context.js';
import { basename, dirOf } from '../utils/paths.js';

export type ImpactLevel = 'high' | 'medium' | 'low';

export interface ImpactedFile {
  path: string;
  /** How many import hops away from the changed file. */
  distance: number;
  level: ImpactLevel;
}

export type RiskLevel = 'high' | 'medium' | 'low';

export interface ImpactReport {
  changed: string[];
  impacted: ImpactedFile[];
  /** Test files that reach the change, directly or indirectly. */
  tests: string[];
  /** Route-like entry points among the impacted files. */
  routes: string[];
  /** External packages the changed files talk to, e.g. `stripe`. */
  externals: string[];
  /**
   * How much of the codebase this change could reach. Derived from how many
   * files depend on it, how close they are, and whether routes are involved.
   */
  risk: RiskLevel;
  /**
   * How much to trust the answer. Dynamic imports Little Owl could not resolve
   * mean the real blast radius may be larger than what is listed here.
   */
  confidence: 'high' | 'medium';
  /** Set when confidence is below `high`, explaining what limits it. */
  confidenceNote: string | null;
  truncated: boolean;
}

const MAX_IMPACTED = 200;

/**
 * Answers "if I change this, what could be affected?" by walking the reverse
 * dependency graph.
 *
 * Everything here is phrased as *potentially* affected: reachability through
 * imports is a real signal, but it is not proof that behaviour changes.
 */
export function analyzeImpact(context: AnalysisContext, changed: string[]): ImpactReport {
  const distances = new Map<string, number>();

  for (const file of changed) {
    if (!context.fileMap.has(file)) continue;
    for (const [dependent, distance] of context.graph.reverseReachable(file)) {
      if (changed.includes(dependent)) continue;
      const existing = distances.get(dependent);
      if (existing === undefined || distance < existing) distances.set(dependent, distance);
    }
  }

  const impacted: ImpactedFile[] = [...distances.entries()]
    .map(([path, distance]) => ({ path, distance, level: levelFor(distance) }))
    .sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : 1));

  const tests = impacted
    .filter((entry) => context.fileMap.get(entry.path)?.isTest)
    .map((entry) => entry.path);

  const routes = impacted
    .map((entry) => entry.path)
    .filter((path) => isRouteLike(path))
    .slice(0, 20);

  const externals = [
    ...new Set(changed.flatMap((file) => [...(context.graph.external.get(file) ?? [])])),
  ]
    .filter((name) => !name.startsWith('node:'))
    .sort();

  const unresolvedDynamic = changed.some((file) =>
    context.fileMap
      .get(file)
      ?.imports.some(
        (reference) =>
          reference.computed === true || (reference.kind === 'dynamic' && !reference.resolved),
      ),
  );

  return {
    changed: [...changed].sort(),
    impacted: impacted.slice(0, MAX_IMPACTED),
    tests,
    routes,
    externals,
    risk: assessRisk(impacted, routes, context.files.length),
    confidence: unresolvedDynamic ? 'medium' : 'high',
    confidenceNote: unresolvedDynamic
      ? 'Some dynamic imports could not be resolved, so more files may be affected than listed.'
      : null,
    truncated: impacted.length > MAX_IMPACTED,
  };
}

/**
 * Risk is about reach, not correctness: a change touching a module a third of
 * the codebase depends on is risky even if the change itself is trivial.
 */
function assessRisk(impacted: ImpactedFile[], routes: string[], totalFiles: number): RiskLevel {
  if (impacted.length === 0) return 'low';

  const direct = impacted.filter((entry) => entry.level === 'high').length;
  const share = totalFiles > 0 ? impacted.length / totalFiles : 0;

  // Share is meaningless on a handful of files: one dependent out of three is
  // 33% of the project and still just one file. Absolute counts gate it.
  if ((share >= 0.2 && impacted.length >= 5) || direct >= 10 || routes.length >= 4) return 'high';
  if ((share >= 0.05 && impacted.length >= 2) || direct >= 3 || routes.length >= 1) return 'medium';
  return 'low';
}

function levelFor(distance: number): ImpactLevel {
  if (distance <= 1) return 'high';
  if (distance <= 3) return 'medium';
  return 'low';
}

/** Next.js, Remix and Nuxt style entry points, plus classic route folders. */
function isRouteLike(file: string): boolean {
  const name = basename(file);
  if (/^(page|route|layout|index)\.[cm]?[jt]sx?$/.test(name)) return true;
  return /(^|\/)(routes|pages|views|screens)\//.test(file);
}

/**
 * Turns a route path into the URL a developer would recognise, e.g.
 * `app/orders/[id]/page.tsx` -> `/orders/[id]`.
 */
export function routeLabel(file: string): string {
  const directory = dirOf(file);
  const cleaned = directory
    .replace(/^(src\/)?(app|pages|routes)\/?/, '')
    .replace(/\/?\([^/]*\)/g, '')
    .replace(/^\/+/, '');
  return `/${cleaned}`.replace(/\/$/, '') || '/';
}
