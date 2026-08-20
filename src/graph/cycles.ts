import type { DependencyGraph } from './dependency-graph.js';

export interface Cycle {
  /** Files in import order; the first file is repeated implicitly at the end. */
  files: string[];
}

interface TarjanState {
  index: number;
  indices: Map<string, number>;
  lowLinks: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  components: string[][];
}

/**
 * Finds import cycles using Tarjan's strongly connected components.
 *
 * Type-only edges are excluded: `import type` is erased at build time and does
 * not create a runtime cycle, so reporting it would be noise.
 */
export function findCycles(graph: DependencyGraph, includeTypeOnly = false): Cycle[] {
  const adjacency = buildAdjacency(graph, includeTypeOnly);
  const state: TarjanState = {
    index: 0,
    indices: new Map(),
    lowLinks: new Map(),
    stack: [],
    onStack: new Set(),
    components: [],
  };

  for (const node of [...adjacency.keys()].sort()) {
    if (!state.indices.has(node)) strongConnect(node, adjacency, state);
  }

  const cycles: Cycle[] = [];
  for (const component of state.components) {
    if (component.length < 2) continue;
    const path = extractCyclePath(component, adjacency);
    if (path.length >= 2) cycles.push({ files: path });
  }

  cycles.sort((a, b) => a.files.join('>').localeCompare(b.files.join('>')));
  return cycles;
}

function buildAdjacency(graph: DependencyGraph, includeTypeOnly: boolean): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes()) adjacency.set(node, []);
  for (const edge of graph.edges) {
    if (edge.typeOnly && !includeTypeOnly) continue;
    const list = adjacency.get(edge.from);
    if (list && !list.includes(edge.to)) list.push(edge.to);
  }
  for (const list of adjacency.values()) list.sort();
  return adjacency;
}

/** Iterative Tarjan so deep graphs cannot blow the call stack. */
function strongConnect(start: string, adjacency: Map<string, string[]>, state: TarjanState): void {
  const callStack: Array<{ node: string; childIndex: number }> = [{ node: start, childIndex: 0 }];

  state.indices.set(start, state.index);
  state.lowLinks.set(start, state.index);
  state.index += 1;
  state.stack.push(start);
  state.onStack.add(start);

  while (callStack.length > 0) {
    const frame = callStack[callStack.length - 1]!;
    const neighbours = adjacency.get(frame.node) ?? [];

    if (frame.childIndex < neighbours.length) {
      const next = neighbours[frame.childIndex]!;
      frame.childIndex += 1;

      if (!state.indices.has(next)) {
        state.indices.set(next, state.index);
        state.lowLinks.set(next, state.index);
        state.index += 1;
        state.stack.push(next);
        state.onStack.add(next);
        callStack.push({ node: next, childIndex: 0 });
      } else if (state.onStack.has(next)) {
        state.lowLinks.set(
          frame.node,
          Math.min(state.lowLinks.get(frame.node)!, state.indices.get(next)!),
        );
      }
      continue;
    }

    callStack.pop();
    const parent = callStack[callStack.length - 1];
    if (parent) {
      state.lowLinks.set(
        parent.node,
        Math.min(state.lowLinks.get(parent.node)!, state.lowLinks.get(frame.node)!),
      );
    }

    if (state.lowLinks.get(frame.node) === state.indices.get(frame.node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = state.stack.pop();
        if (member === undefined) break;
        state.onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      state.components.push(component);
    }
  }
}

/**
 * Pulls one concrete cycle out of a strongly connected component so the report
 * can show `a -> b -> c -> a` rather than an unordered set of files.
 */
function extractCyclePath(component: string[], adjacency: Map<string, string[]>): string[] {
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
}
