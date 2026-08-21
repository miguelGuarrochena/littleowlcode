import pc from 'picocolors';
import type { ReportedSeverity, ReviewStatus } from '../core/types.js';

/**
 * Semantic colours and icons.
 *
 * Colour is never the only signal: every state also has an icon and a word, so
 * the output still reads correctly when piped, logged, or seen by someone who
 * does not distinguish the colours.
 */

export const colors = pc;

export const icons = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
  info: 'ℹ',
  up: '↑',
  down: '↓',
  flat: '·',
  arrow: '→',
  owl: '🦉',
  bullet: '•',
} as const;

export const severityIcon: Record<ReportedSeverity, string> = {
  error: '🔴',
  warning: '🟡',
  info: '🔵',
};

export const severityColor = (severity: ReportedSeverity): ((text: string) => string) => {
  if (severity === 'error') return pc.red;
  if (severity === 'warning') return pc.yellow;
  return pc.blue;
};

export const severityLabel = (severity: ReportedSeverity): string => {
  return severity === 'error' ? 'critical' : severity === 'warning' ? 'warning' : 'info';
};

export const statusText: Record<ReviewStatus, string> = {
  healthy: 'HEALTHY',
  'needs-review': 'NEEDS REVIEW',
  degraded: 'DEGRADED',
};

export const statusColor = (status: ReviewStatus): ((text: string) => string) => {
  if (status === 'degraded') return pc.red;
  if (status === 'needs-review') return pc.yellow;
  return pc.green;
};

export const statusIcon = (status: ReviewStatus): string => {
  if (status === 'degraded') return icons.error;
  if (status === 'needs-review') return icons.warn;
  return icons.ok;
};

/** Colour for a score, using the same thresholds everywhere. */
export const scoreColor = (score: number): ((text: string) => string) => {
  if (score >= 85) return pc.green;
  if (score >= 70) return pc.yellow;
  return pc.red;
};

export const dim = (text: string): string => pc.dim(text);
