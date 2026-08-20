import type { DependencyEdge, ParsedFile } from '../core/types.js';
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

  addNode(file: string): void {
    if (!this.out.has(file)) this.out.set(file, new Set());
    if (!this.in.has(file)) this.in.set(file, new Set());
  }

  addEdge(edge: DependencyEdge): void {
    if (edge.from === edge.to) return;
    this.addNode(edge.from);
    this.addNode(edge.to);
    if (this.out.get(edge.from)!.has(edge.to)) return;
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

  /** Longest chain of imports starting at `file`, capped to stay linear-ish. */
  maxDepthFrom(file: string, seen = new Set<string>()): number {
    if (seen.has(file)) return 0;
    seen.add(file);
    let deepest = 0;
    for (const dependency of this.dependenciesOf(file)) {
      deepest = Math.max(deepest, 1 + this.maxDepthFrom(dependency, seen));
    }
    seen.delete(file);
    return deepest;
  }
}

export function buildDependencyGraph(
  files: ParsedFile[],
  context: ResolverContext,
): DependencyGraph {
  const graph = new DependencyGraph();
  for (const file of files) graph.addNode(file.path);

  for (const file of files) {
    for (const reference of file.imports) {
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

      const packageName = packageNameOf(reference.raw);
      if (packageName) {
        reference.packageName = packageName;
        graph.addExternal(file.path, packageName);
      } else {
        graph.unresolved.push({
          file: file.path,
          specifier: reference.raw,
          line: reference.line,
        });
      }
    }
  }

  return graph;
}
