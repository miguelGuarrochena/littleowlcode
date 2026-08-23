import type { Finding } from './types.js';

/**
 * The single ranking every part of the product uses.
 *
 * Findings are *sorted* for reading (severity, category, path) and *ranked* for
 * acting. Those are different orders, and the difference matters: the reading
 * order puts whatever is alphabetically first at the top, so an assistant given
 * the first four items would refactor a throwaway script while a leaked secret
 * in a client bundle sat at number nine.
 *
 * Ranking lives here rather than next to any one command because issue numbers
 * are derived from it. `check` says "issue #1", `fix 1` acts on it and
 * `verify 1` confirms it — three commands that must agree about which problem
 * is number one.
 */

/** How much each rule tends to matter, lowest first. */
export const RULE_PRIORITY: Record<string, number> = {
  // A credential in a public bundle is the only finding here that can already
  // have caused harm by the time it is read.
  'next/secret-in-client-bundle': 0,
  'next/server-module-in-client-bundle': 0,
  'next/server-import-in-client': 0,
  'architecture/circular-dependency': 0,
  'scope/out-of-scope-change': 1,
  'architecture/layer-violation': 1,
  'architecture/forbidden-dependency': 1,
  'architecture/layer-skip': 2,
  'architecture/cross-feature-import': 2,
  'python/bare-except': 2,
  'python/mutable-default': 2,
  'go/ignored-error': 2,
  'patterns/parallel-implementations': 3,
  'patterns/duplicate-helper': 3,
  'dependencies/duplicate-dependency': 3,
  'complexity/large-file': 4,
  'complexity/large-component': 4,
  'react/effect-dependency-risk': 4,
  'type-safety/suppression': 5,
  'type-safety/explicit-any': 5,
  'complexity/large-function': 6,
  'complexity/high-complexity': 6,
};

const DEFAULT_PRIORITY = 7;
const SEVERITY_RANK: Record<Finding['severity'], number> = { error: 0, warning: 1, info: 2 };

/**
 * How far past its limit a finding is, as a multiple. Rules that carry a
 * `baseline` limit and a `current` measurement can be compared this way; the
 * rest all tie at 1 and fall through to the path.
 */
export const overshoot = (finding: Finding): number => {
  const limit = typeof finding.baseline === 'number' ? finding.baseline : 0;
  const actual = typeof finding.current === 'number' ? finding.current : 0;
  return limit > 0 && actual > 0 ? actual / limit : 1;
};

/** Most important first. Stable: the same findings always rank the same way. */
export const rankFindings = (findings: Finding[]): Finding[] =>
  [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;

    const byRule =
      (RULE_PRIORITY[a.id] ?? DEFAULT_PRIORITY) - (RULE_PRIORITY[b.id] ?? DEFAULT_PRIORITY);
    if (byRule !== 0) return byRule;

    // Worst offender first: five times over the limit before barely over it.
    const byOvershoot = overshoot(b) - overshoot(a);
    if (byOvershoot !== 0) return byOvershoot;

    const fileA = a.file ?? '';
    const fileB = b.file ?? '';
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
