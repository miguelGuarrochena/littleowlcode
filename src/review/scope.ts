import type { ChangeSet, ScopeResult } from '../core/types.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';

/**
 * Compares what a change was supposed to touch against what it actually
 * touched. This is the guardrail for "I asked the assistant to fix orders and
 * it also rewrote authentication".
 */
export function checkScope(changes: ChangeSet, patterns: string[]): ScopeResult | null {
  if (patterns.length === 0) return null;

  const compiled = patterns.map(compilePattern);
  const inScope: string[] = [];
  const outOfScope: string[] = [];

  for (const file of changes.files) {
    if (matchesCompiled(file.path, compiled)) inScope.push(file.path);
    else outOfScope.push(file.path);
  }

  return { patterns, inScope: inScope.sort(), outOfScope: outOfScope.sort() };
}

/**
 * Groups out-of-scope files by their top two path segments, so the report can
 * say "3 files under features/auth" instead of listing every file.
 */
export function groupByArea(files: string[]): Array<{ area: string; files: string[] }> {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const parts = file.split('/');
    const area = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.';
    const list = groups.get(area) ?? [];
    list.push(file);
    groups.set(area, list);
  }

  return [...groups.entries()]
    .map(([area, groupFiles]) => ({ area, files: groupFiles.sort() }))
    .sort((a, b) => (a.area < b.area ? -1 : 1));
}
