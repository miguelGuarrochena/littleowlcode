import type { AnalysisContext } from '../core/context.js';
import type { Finding } from '../core/types.js';

/**
 * The other files someone will need open to understand a finding.
 *
 * Little Owl already knows the import graph, so it can answer "what else is
 * involved here?" instead of leaving the reader to grep for it. The list is
 * kept short on purpose: five paths is context, thirty is another problem to
 * solve before you can start on the first one.
 */

export interface RelatedFile {
  path: string;
  /** Why this file is in the list, in plain words. */
  reason: string;
}

const MAX_PER_DIRECTION = 3;

/**
 * Findings whose subject is a single file's insides.
 *
 * "Here are five files that import this one" helps when the finding is about a
 * relationship — a cycle, a leak, a boundary crossed. It is pure noise when the
 * problem is that one function has too many branches: the neighbours are not
 * involved, cannot be involved, and listing them buries the one line that is.
 */
const SELF_CONTAINED = /^(complexity|type-safety)\//;

const isSelfContained = (finding: Finding): boolean =>
  SELF_CONTAINED.test(finding.id) || finding.id === 'react/effect-dependency-risk';

export const relatedFiles = (
  finding: Finding,
  context: AnalysisContext,
  limit = 5,
): RelatedFile[] => {
  if (isSelfContained(finding)) return [];

  const related: RelatedFile[] = [];
  const seen = new Set<string>();

  const add = (path: string, reason: string): void => {
    if (path === finding.file || seen.has(path)) return;
    seen.add(path);
    related.push({ path, reason });
  };

  // A cycle names its own members, and they matter more than any importer.
  if (finding.id === 'architecture/circular-dependency') {
    for (const step of cyclePaths(finding)) add(step, 'part of the same loop');
  }

  // A leak finding is *about* a path through the project. The files on that
  // path are the answer, not context for it, so they come before anything the
  // graph would otherwise volunteer.
  const chain = chainOf(finding);
  for (const [index, step] of chain.entries()) {
    if (index === 0) continue;
    add(step, index === chain.length - 1 ? 'where the problem is' : 'links the two together');
  }

  if (finding.file) {
    for (const path of context.graph.dependentsOf(finding.file).slice(0, MAX_PER_DIRECTION)) {
      add(path, 'uses this file');
    }
    for (const path of context.graph.dependenciesOf(finding.file).slice(0, MAX_PER_DIRECTION)) {
      add(path, 'this file uses it');
    }
  }

  return related.slice(0, limit);
};

/**
 * The file paths inside a cycle finding's detail lines.
 *
 * The rule writes them as `a.ts → b.ts → a.ts`, which is right for reading and
 * useless for anything else, so they are pulled back apart here rather than
 * duplicating the list on the finding.
 */
const cyclePaths = (finding: Finding): string[] => {
  const chain = finding.detail?.[0];
  if (!chain) return [];
  return [
    ...new Set(
      chain
        .split(/->|→/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part.includes('.')),
    ),
  ];
};

/**
 * The exact route a finding travelled, when the rule recorded one.
 *
 * Rules that answer "can A reach B?" put the shortest path in `current`,
 * because a chain of three files is the finding — knowing that a secret is
 * reachable is useless without knowing which import to delete.
 */
const chainOf = (finding: Finding): string[] => {
  const { current } = finding;
  if (!Array.isArray(current)) return [];
  if (current.length < 2) return [];
  return current.every((step) => typeof step === 'string' && step.includes('.'))
    ? (current as string[])
    : [];
};

/**
 * The chain a finding sits in, as a diagram: `app/page.tsx ↓ services/orders.ts`.
 *
 * A recorded path wins over the graph's own neighbours: for a leak, "these two
 * files happen to import this one" is trivia, while "this is the route the
 * secret takes to the browser" is the whole point.
 *
 * Only produced when there is something to show — a single file with nothing
 * around it is not a diagram, it is a filename with decoration.
 */
export const renderFlow = (finding: Finding, context: AnalysisContext): string | null => {
  const chain = chainOf(finding);
  if (chain.length >= 2) return chain.join('\n   ↓\n');

  if (!finding.file || isSelfContained(finding)) return null;

  const above = context.graph.dependentsOf(finding.file)[0];
  const below = context.graph.dependenciesOf(finding.file)[0];
  if (!above && !below) return null;

  const steps = [above, finding.file, below].filter((step): step is string => Boolean(step));
  return steps.join('\n   ↓\n');
};
