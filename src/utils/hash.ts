import { createHash } from 'node:crypto';

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

/**
 * Builds the stable identity of a finding. Two runs that describe the same
 * problem must produce the same fingerprint, so drift comparison can tell a new
 * problem apart from one that already existed in the baseline.
 */
export function fingerprint(parts: readonly (string | number | undefined)[]): string {
  const key = parts.filter((part) => part !== undefined).join(' ');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
