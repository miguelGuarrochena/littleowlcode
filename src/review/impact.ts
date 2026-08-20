import type { AnalysisContext } from '../core/context.js';
import { basename, dirOf } from '../utils/paths.js';

export type ImpactLevel = 'high' | 'medium' | 'low';

export interface ImpactedFile {
  path: string;
  /** How many import hops away from the changed file. */
  distance: number;
  level: ImpactLevel;
}

export interface ImpactReport {
  changed: string[];
  impacted: ImpactedFile[];
  /** Test files that reach the change, directly or indirectly. */
  tests: string[];
  /** Route-like entry points among the impacted files. */
  routes: string[];
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

  return {
    changed: [...changed].sort(),
    impacted: impacted.slice(0, MAX_IMPACTED),
    tests,
    routes,
    truncated: impacted.length > MAX_IMPACTED,
  };
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
