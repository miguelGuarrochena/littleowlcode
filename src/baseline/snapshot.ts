import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ensureLocalGitignore } from '../config/load.js';
import type { Finding, Metrics } from '../core/types.js';
import type { Issue } from '../output/issue.js';

/**
 * The numbered issue list from the last `check` or `review`.
 *
 * This is what lets `explain 2`, `fix 2` and `verify 2` mean anything. It is
 * machine state, not a project artefact: it is gitignored alongside the parse
 * cache, and losing it costs one re-run and nothing else.
 */

export const SNAPSHOT_VERSION = 1;

export interface SnapshotIssue {
  number: number;
  fingerprint: string;
  id: string;
  severity: Finding['severity'];
  title: string;
  file?: string;
  line?: number;
}

export interface RunSnapshot {
  version: number;
  at: string;
  command: 'check' | 'review';
  metrics: Metrics;
  issues: SnapshotIssue[];
}

export const snapshotPath = (root: string): string => path.join(root, CONFIG_DIR, 'last-run.json');

export const writeSnapshot = (
  root: string,
  command: RunSnapshot['command'],
  issues: Issue[],
  metrics: Metrics,
): void => {
  const snapshot: RunSnapshot = {
    version: SNAPSHOT_VERSION,
    at: new Date().toISOString(),
    command,
    metrics,
    issues: issues.map((issue) => ({
      number: issue.number,
      fingerprint: issue.fingerprint,
      id: issue.id,
      severity: issue.severity,
      title: issue.title,
      ...(issue.file ? { file: issue.file } : {}),
      ...(issue.line ? { line: issue.line } : {}),
    })),
  };

  try {
    ensureLocalGitignore(root);
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(snapshotPath(root), `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    // Losing the snapshot costs a re-run. It must never cost the report.
  }
};

export const readSnapshot = (root: string): RunSnapshot | null => {
  try {
    const file = snapshotPath(root);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RunSnapshot;
    if (parsed.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.issues)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const snapshotIssue = (snapshot: RunSnapshot, number: number): SnapshotIssue | null =>
  snapshot.issues.find((issue) => issue.number === number) ?? null;
