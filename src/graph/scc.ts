/**
 * Strongly connected components over a plain adjacency map.
 *
 * Both cycle detection and import-depth measurement need the same answer:
 * which nodes can reach each other. Computing it once, here, keeps the two
 * from drifting apart and keeps the depth calculation linear.
 */

interface TarjanState {
  index: number;
  indices: Map<string, number>;
  lowLinks: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  components: string[][];
}

/**
 * Tarjan's algorithm, iterative so a deep graph cannot blow the call stack.
 *
 * Components come out in reverse topological order of the condensation: a
 * component is only emitted once everything it can reach has been emitted.
 * Callers that fold values along the graph can rely on that ordering.
 */
export function stronglyConnectedComponents(adjacency: Map<string, string[]>): string[][] {
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

  return state.components;
}

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
