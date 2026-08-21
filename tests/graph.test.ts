import { describe, expect, it } from 'vitest';
import { DependencyGraph } from '../src/graph/dependency-graph.js';
import { findCycles } from '../src/graph/cycles.js';
import { TempProject } from './temp-project.js';

/**
 * Import depth.
 *
 * Depth feeds the dependency score, so every command pays for it. Walking
 * paths rather than nodes explores a branching graph exponentially, and these
 * pin both halves of the contract: the answers, and the work staying
 * proportional to nodes and edges.
 */

const graphOf = (edges: Array<[string, string]>, nodes: string[] = []): DependencyGraph => {
  const graph = new DependencyGraph();
  for (const node of nodes) graph.addNode(node);
  for (const [from, to] of edges) graph.addEdge({ from, to, line: 1, typeOnly: false });
  return graph;
};

/** `m0 -> m1, m2, m3`, `m1 -> m2, m3, m4`, … — branching, with a long spine. */
const branchingGraph = (size: number, outDegree = 3): DependencyGraph => {
  const edges: Array<[string, string]> = [];
  for (let index = 0; index < size; index += 1) {
    for (let step = 1; step <= outDegree; step += 1) {
      const target = index + step;
      if (target < size) edges.push([`m${index}`, `m${target}`]);
    }
  }
  return graphOf(edges, [`m${size - 1}`]);
};

describe('import depth', () => {
  it('counts edges along the longest chain', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'c.ts'],
      ['c.ts', 'd.ts'],
    ]);

    expect(graph.maxDepthFrom('a.ts')).toBe(3);
    expect(graph.maxDepthFrom('c.ts')).toBe(1);
    expect(graph.maxDepthFrom('d.ts')).toBe(0);
  });

  it('takes the longest branch when a file has several', () => {
    const graph = graphOf([
      ['entry.ts', 'short.ts'],
      ['entry.ts', 'long-1.ts'],
      ['long-1.ts', 'long-2.ts'],
      ['long-2.ts', 'long-3.ts'],
    ]);

    expect(graph.maxDepthFrom('entry.ts')).toBe(3);
  });

  it('counts a shared dependency once rather than once per path', () => {
    // Both branches end at the same module. Depth is a property of the module,
    // not of the route taken to reach it.
    const graph = graphOf([
      ['entry.ts', 'left.ts'],
      ['entry.ts', 'right.ts'],
      ['left.ts', 'shared.ts'],
      ['right.ts', 'shared.ts'],
      ['shared.ts', 'leaf.ts'],
    ]);

    expect(graph.maxDepthFrom('entry.ts')).toBe(3);
    expect(graph.maxDepthFrom('left.ts')).toBe(2);
    expect(graph.maxDepthFrom('shared.ts')).toBe(1);
  });

  it('returns zero for a node the graph has never seen', () => {
    expect(graphOf([['a.ts', 'b.ts']]).maxDepthFrom('nowhere.ts')).toBe(0);
  });

  it('measures each component of a disconnected graph on its own', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'c.ts'],
      ['x.ts', 'y.ts'],
    ]);

    expect(graph.maxDepthFrom('a.ts')).toBe(2);
    expect(graph.maxDepthFrom('x.ts')).toBe(1);
  });

  it('terminates inside a cycle instead of looping forever', () => {
    const two = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'a.ts'],
    ]);
    expect(two.maxDepthFrom('a.ts')).toBe(1);

    const three = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'c.ts'],
      ['c.ts', 'a.ts'],
    ]);
    expect(three.maxDepthFrom('a.ts')).toBe(2);
  });

  it('continues past a cycle into what the cycle depends on', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'a.ts'],
      ['b.ts', 'tail-1.ts'],
      ['tail-1.ts', 'tail-2.ts'],
    ]);

    // One edge inside the loop, then two more out of it.
    expect(graph.maxDepthFrom('a.ts')).toBe(3);
  });

  it('reflects edges added after a depth was already read', () => {
    const graph = graphOf([['a.ts', 'b.ts']]);
    expect(graph.maxDepthFrom('a.ts')).toBe(1);

    graph.addEdge({ from: 'b.ts', to: 'c.ts', line: 1, typeOnly: false });
    expect(graph.maxDepthFrom('a.ts')).toBe(2);
  });
});

describe('import depth performance', () => {
  it('stays linear on a branching graph rather than growing with its paths', () => {
    // 30 nodes at out-degree 3: enough paths that a path-walking traversal
    // takes seconds, few enough that it still returns. Larger sizes hang
    // instead of failing, which is why this one is pinned.
    const graph = branchingGraph(30);

    const started = Date.now();
    const depth = graph.maxDepthFrom('m0');
    const elapsed = Date.now() - started;

    expect(depth).toBe(29);
    // Deliberately loose: the point is the difference between "instant" and
    // "seconds", not a millisecond budget that will flake on a busy CI runner.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('answers for every node of a large graph in one walk', () => {
    // 2,000 nodes and ~6,000 edges: the size at which a real repository stops
    // being a toy. Asking all 2,000 nodes must not cost 2,000 traversals —
    // the result is computed once for the whole graph and shared.
    const graph = branchingGraph(2_000);

    const started = Date.now();
    const depths = graph.nodes().map((node) => graph.maxDepthFrom(node));
    const elapsed = Date.now() - started;

    expect(depths).toHaveLength(2_000);
    expect(graph.maxDepthFrom('m0')).toBe(1_999);
    expect(graph.maxDepthFrom('m1999')).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('still finds cycles on a large graph', () => {
    const graph = branchingGraph(500);
    expect(findCycles(graph)).toEqual([]);

    graph.addEdge({ from: 'm499', to: 'm0', line: 1, typeOnly: false });
    expect(findCycles(graph)).toHaveLength(1);
  });
});

describe('large project analysis', () => {
  it('analyses a branching project end to end', async () => {
    // The same shape as above, but as real files through the real pipeline.
    const files: Record<string, string> = { 'package.json': '{"name":"branching"}' };
    const size = 150;

    for (let index = 0; index < size; index += 1) {
      const targets = [index + 1, index + 2, index + 3].filter((target) => target < size);
      const imports = targets.map((target) => `import { f${target} } from './m${target}';`);
      const body = targets.length > 0 ? targets.map((target) => `f${target}(n)`).join(' + ') : 'n';
      files[`src/m${index}.ts`] =
        `${imports.join('\n')}\nexport function f${index}(n: number): number {\n  return ${body};\n}\n`;
    }

    const project = TempProject.create(files);
    try {
      const started = Date.now();
      const { result, context } = await project.analyze();
      const elapsed = Date.now() - started;

      expect(result.project.fileCount).toBe(size);
      expect(context.graph.maxDepthFrom('src/m0.ts')).toBe(size - 1);
      expect(result.metrics.overall).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      project.cleanup();
    }
  });
});
