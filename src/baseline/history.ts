import fs from 'node:fs';
import path from 'node:path';
import type { Metrics, ReviewStatus } from '../core/types.js';
import { ensureConfigDir } from '../config/load.js';

/**
 * A short local log of reviews and snapshots.
 *
 * It answers "is the last round of changes better or worse than the previous
 * one?" without ever moving the baseline, which stays where the developer put
 * it until they explicitly update it.
 */

export interface HistoryEntry {
  id: number;
  at: string;
  kind: 'review' | 'snapshot';
  commit?: string;
  branch?: string;
  status?: ReviewStatus;
  metrics: Metrics;
  baselineOverall?: number;
  findingCounts: { error: number; warning: number; info: number };
  note?: string;
}

interface HistoryFile {
  version: string;
  entries: HistoryEntry[];
}

const HISTORY_VERSION = '1';
const MAX_ENTRIES = 50;

export function historyPath(root: string): string {
  return path.join(root, '.little-owl', 'history.json');
}

export function readHistory(root: string): HistoryEntry[] {
  const file = historyPath(root);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryFile;
    if (parsed.version !== HISTORY_VERSION) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

export function appendHistory(root: string, entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
  const entries = readHistory(root);
  const id = (entries[entries.length - 1]?.id ?? 0) + 1;
  const full: HistoryEntry = { ...entry, id };

  const next = [...entries, full].slice(-MAX_ENTRIES);
  ensureConfigDir(root);
  fs.writeFileSync(
    historyPath(root),
    `${JSON.stringify({ version: HISTORY_VERSION, entries: next }, null, 2)}\n`,
  );
  return full;
}

export function latestEntries(root: string, count: number): HistoryEntry[] {
  return readHistory(root).slice(-count);
}
