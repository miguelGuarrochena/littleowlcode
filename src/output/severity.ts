import pc from 'picocolors';
import type { Finding, ReportedSeverity } from '../core/types.js';

/**
 * The words Little Owl uses with people, as opposed to the words the engine
 * uses with itself.
 *
 * Rules are configured with `error | warning | info`, because that is the
 * vocabulary every linter config in the world already uses and changing it
 * would break every existing `.little-owl/config.ts`. Nobody reading a report
 * wants to be told their app has "an error-level info", though, so everything
 * a person sees goes through this translation instead.
 */

export type Priority = 'critical' | 'important' | 'minor';

export const PRIORITY_OF: Record<ReportedSeverity, Priority> = {
  error: 'critical',
  warning: 'important',
  info: 'minor',
};

export const SEVERITY_OF: Record<Priority, ReportedSeverity> = {
  critical: 'error',
  important: 'warning',
  minor: 'info',
};

export const PRIORITY_ORDER: Priority[] = ['critical', 'important', 'minor'];

export const priorityOf = (finding: Finding): Priority => PRIORITY_OF[finding.severity];

export const PRIORITY_ICON: Record<Priority, string> = {
  critical: '🔴',
  important: '🟠',
  minor: '🟡',
};

/** One line telling the reader how urgently this level deserves their time. */
export const PRIORITY_MEANING: Record<Priority, string> = {
  critical: 'Fix before your app goes live.',
  important: 'Fix soon — this gets more expensive the longer it waits.',
  minor: 'Improve when you have time. Nothing is broken.',
};

export const priorityColor = (priority: Priority): ((text: string) => string) => {
  if (priority === 'critical') return pc.red;
  if (priority === 'important') return pc.yellow;
  return pc.blue;
};

export const priorityLabel = (priority: Priority): string => priority.toUpperCase();

export interface PriorityCounts {
  critical: number;
  important: number;
  minor: number;
  total: number;
}

export const countByPriority = (findings: Finding[]): PriorityCounts => {
  const counts: PriorityCounts = { critical: 0, important: 0, minor: 0, total: findings.length };
  for (const finding of findings) counts[priorityOf(finding)] += 1;
  return counts;
};

/**
 * How many issues, at which level — `🔴 2 critical   🟠 3 important`.
 *
 * Levels with nothing in them are left out: a line reading "0 critical" makes
 * the reader stop and check a number that was never a number.
 */
export const renderPriorityCounts = (counts: PriorityCounts): string => {
  const parts = PRIORITY_ORDER.filter((priority) => counts[priority] > 0).map((priority) =>
    priorityColor(priority)(`${PRIORITY_ICON[priority]} ${counts[priority]} ${priority}`),
  );
  if (parts.length === 0) return pc.green('✓ nothing to fix');
  return parts.join('   ');
};

/**
 * The counts with a plain-language key underneath.
 *
 * Shown once per report rather than next to every issue: three colours with no
 * key is a puzzle, and the same key repeated eleven times is noise.
 */
export const renderPriorityLegend = (counts: PriorityCounts): string => {
  const present = PRIORITY_ORDER.filter((priority) => counts[priority] > 0);
  if (present.length === 0) return renderPriorityCounts(counts);

  const width = Math.max(...present.map((priority) => priority.length));
  return present
    .map((priority) => {
      const label = priorityColor(priority)(priority.padEnd(width));
      const count = String(counts[priority]).padStart(3);
      return `${PRIORITY_ICON[priority]} ${count}  ${label}   ${pc.dim(PRIORITY_MEANING[priority])}`;
    })
    .join('\n');
};
