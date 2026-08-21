import type { DependencyEdge, ImportRef, ParsedFile } from '../core/types.js';
import { stronglyConnectedComponents } from './scc.js';
import {
  packageNameOf,
  resolveGoImport,
  resolveJsImport,
  resolvePythonImport,
  type ResolverContext,
} from './resolve.js';

export interface UnresolvedImport {
  file: string;
  specifier: string;
  line: number;
}

/**
 * Specifiers that are assets rather than modules.
 *
 * Bundlers let you `import './globals.css'` or `import logo from './logo.png'`.
 * Little Owl only reads source files, so those specifiers can never resolve —
 * and calling them unresolved would report a broken path alias that is not
 * there, while costing the project dependency-score points.
 */
const ASSET_EXTENSION =
  /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|wav|ogg|pdf|txt|md|mdx|csv|ya?ml|json|json5|graphql|gql|wasm|glsl|frag|vert)(\?.*)?$/i;

export const isAssetImport = (specifier: string): boolean => ASSET_EXTENSION.test(specifier);

/**
 * File-level import graph for the whole project.
 *
 * Nodes are repo-relative paths. Edges carry the line they came from so a
 * finding can point at the exact import that caused it.
 */
export class DependencyGraph {
  readonly edges: DependencyEdge[] = [];
  readonly external = new Map<string, Set<string>>();
  readonly unresolved: UnresolvedImport[] = [];

  private readonly out = new Map<string, Set<string>>();
  private readonly in = new Map<string, Set<string>>();
  /** Import depth per node, computed lazily and dropped whenever an edge is added. */
  private depthCache: Map<string, number> | null = null;

  addNode(file: string): void {
    if (this.out.has(file) && this.in.has(file)) return;
    this.depthCache = null;
    if (!this.out.has(file)) this.out.set(file, new Set());
    if (!this.in.has(file)) this.in.set(file, new Set());
  }

  addEdge(edge: DependencyEdge): void {
    if (edge.from === edge.to) return;
    this.addNode(edge.from);
    this.addNode(edge.to);
    if (this.out.get(edge.from)!.has(edge.to)) return;
    this.depthCache = null;
    this.out.get(edge.from)!.add(edge.to);
    this.in.get(edge.to)!.add(edge.from);
    this.edges.push(edge);
  }

  addExternal(file: string, packageName: string): void {
    const set = this.external.get(file) ?? new Set<string>();
    set.add(packageName);
    this.external.set(file, set);
  }

  nodes(): string[] {
    return [...this.out.keys()].sort();
  }

  dependenciesOf(file: string): string[] {
    return [...(this.out.get(file) ?? [])].sort();
  }

  dependentsOf(file: string): string[] {
    return [...(this.in.get(file) ?? [])].sort();
  }

  edgeFor(from: string, to: string): DependencyEdge | undefined {
    return this.edges.find((edge) => edge.from === from && edge.to === to);
  }

  /** All packages imported anywhere in the project. */
  externalPackages(): Set<string> {
    const all = new Set<string>();
    for (const packages of this.external.values()) {
      for (const name of packages) all.add(name);
    }
    return all;
  }

  /** Transitive dependents, i.e. "who could break if this file changes". */
  reverseReachable(file: string, maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
    const distances = new Map<string, number>();
    let frontier = [file];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      depth += 1;
      const next: string[] = [];
      for (const current of frontier) {
        for (const dependent of this.dependentsOf(current)) {
          if (dependent === file || distances.has(dependent)) continue;
          distances.set(dependent, depth);
          next.push(dependent);
        }
      }
      frontier = next;
    }

    return distances;
  }

  /**
   * Longest chain of imports starting at `file`, counted in edges.
   *
   * Computed for the whole graph at once and cached, because both the
   * dependency score and the deep-import-chain rule ask for it, and asking
   * twice would mean walking the graph twice.
   */
  maxDepthFrom(file: string): number {
    return this.depths().get(file) ?? 0;
  }

  /**
   * Depth of every node, in O(nodes + edges).
   *
   * Longest path is only well defined on an acyclic graph, so the graph is
   * first condensed into its strongly connected components. Inside a component
   * every node reaches every other, so the chain through it can be at most
   * `size - 1` edges long; between components the depth is the usual longest
   * path over a DAG. Tarjan emits components in reverse topological order, so
   * one pass in emission order is enough — every successor is already known.
   *
   * Walking nodes rather than paths is what keeps this linear: a graph with any
   * branching has exponentially more paths than nodes.
   */
  private depths(): Map<string, number> {
    if (this.depthCache) return this.depthCache;

    const adjacency = new Map<string, string[]>();
    for (const [node, dependencies] of this.out) adjacency.set(node, [...dependencies]);

    const components = stronglyConnectedComponents(adjacency);
    const componentOf = new Map<string, number>();
    components.forEach((component, index) => {
      for (const node of component) componentOf.set(node, index);
    });

    const componentDepth: number[] = new Array<number>(components.length).fill(0);
    const depths = new Map<string, number>();

    components.forEach((component, index) => {
      let beyond = 0;
      for (const node of component) {
        for (const dependency of adjacency.get(node) ?? []) {
          const target = componentOf.get(dependency);
          // Edges back into this component are covered by the size term.
          if (target === undefined || target === index) continue;
          beyond = Math.max(beyond, 1 + componentDepth[target]!);
        }
      }

      const depth = component.length - 1 + beyond;
      componentDepth[index] = depth;
      for (const node of component) depths.set(node, depth);
    });

    this.depthCache = depths;
    return depths;
  }
}

/**
 * Files an import points at something outside the project: a package, an asset,
 * or nothing Little Owl can account for.
 */
const recordUnresolved = (graph: DependencyGraph, from: string, reference: ImportRef): void => {
  const packageName = packageNameOf(reference.raw);
  if (packageName) {
    // `bootstrap/dist/bootstrap.css` still means bootstrap is in use, so the
    // package is recorded before assets are filtered out.
    reference.packageName = packageName;
    graph.addExternal(from, packageName);
    return;
  }

  // A relative asset import is not a module Little Owl failed to find; it is
  // one it was never going to read.
  if (isAssetImport(reference.raw)) return;

  graph.unresolved.push({ file: from, specifier: reference.raw, line: reference.line });
};

export const buildDependencyGraph = (
  files: ParsedFile[],
  context: ResolverContext,
): DependencyGraph => {
  const graph = new DependencyGraph();
  for (const file of files) graph.addNode(file.path);

  for (const file of files) {
    for (const reference of file.imports) {
      // A runtime-built specifier resolves to nothing knowable. It is kept on
      // the file so callers can lower their confidence, but it is not an edge.
      if (reference.computed) continue;

      if (file.language === 'go') {
        const targets = resolveGoImport(reference.raw, context);
        if (targets.length === 0) {
          if (!reference.raw.includes('.') || reference.raw.startsWith('.')) continue;
          graph.addExternal(file.path, reference.raw);
          continue;
        }
        for (const target of targets) {
          graph.addEdge({ from: file.path, to: target, line: reference.line, typeOnly: false });
        }
        continue;
      }

      if (file.language === 'python') {
        const target = resolvePythonImport(file.path, reference.raw, context);
        if (target) {
          reference.resolved = target;
          graph.addEdge({ from: file.path, to: target, line: reference.line, typeOnly: false });
        } else if (!reference.raw.startsWith('.')) {
          const name = reference.raw.split('.')[0]!;
          reference.packageName = name;
          graph.addExternal(file.path, name);
        }
        continue;
      }

      const target = resolveJsImport(file.path, reference.raw, context);
      if (target) {
        reference.resolved = target;
        graph.addEdge({
          from: file.path,
          to: target,
          line: reference.line,
          typeOnly: reference.typeOnly,
        });
        continue;
      }

      recordUnresolved(graph, file.path, reference);
    }
  }

  return graph;
};
