import type { DependencyGraph } from './dependency-graph.js';
import { stronglyConnectedComponents } from './scc.js';

export interface Cycle {
  /** Files in import order; the first file is repeated implicitly at the end. */
  files: string[];
}

/**
 * Finds import cycles using Tarjan's strongly connected components.
 *
 * Type-only edges are excluded: `import type` is erased at build time and does
 * not create a runtime cycle, so reporting it would be noise.
 */
export const findCycles = (graph: DependencyGraph, includeTypeOnly = false): Cycle[] => {
  const adjacency = buildAdjacency(graph, includeTypeOnly);

  const cycles: Cycle[] = [];
  for (const component of stronglyConnectedComponents(adjacency)) {
    if (component.length < 2) continue;
    const path = extractCyclePath(component, adjacency);
    if (path.length >= 2) cycles.push({ files: path });
  }

  cycles.sort((a, b) => a.files.join('>').localeCompare(b.files.join('>')));
  return cycles;
};

const buildAdjacency = (
  graph: DependencyGraph,
  includeTypeOnly: boolean,
): Map<string, string[]> => {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes()) adjacency.set(node, []);
  for (const edge of graph.edges) {
    if (edge.typeOnly && !includeTypeOnly) continue;
    const list = adjacency.get(edge.from);
    if (list && !list.includes(edge.to)) list.push(edge.to);
  }
  for (const list of adjacency.values()) list.sort();
  return adjacency;
};

/**
 * Pulls one concrete cycle out of a strongly connected component so the report
 * can show `a -> b -> c -> a` rather than an unordered set of files.
 */
const extractCyclePath = (component: string[], adjacency: Map<string, string[]>): string[] => {
  const members = new Set(component);
  const start = [...component].sort()[0]!;
  const path: string[] = [];
  const visited = new Set<string>();

  const walk = (node: string): boolean => {
    path.push(node);
    visited.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start && path.length > 1) return true;
      if (visited.has(next)) continue;
      if (walk(next)) return true;
    }

    path.pop();
    return false;
  };

  return walk(start) ? path : [...component].sort();
};
