import fs from 'node:fs';
import path from 'node:path';
import type { ParsedFile } from './types.js';

/**
 * Parse cache keyed by file path and validated with mtime + size.
 *
 * Re-parsing is by far the most expensive part of an analysis, so watch mode
 * and repeated runs reuse results for files that have not been touched.
 */

const CACHE_VERSION = 1;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class ParseCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(private readonly file: string | null) {}

  static open(root: string, enabled = true): ParseCache {
    const file = enabled ? path.join(root, '.little-owl', 'cache', 'parse.json') : null;
    const cache = new ParseCache(file);
    if (file) cache.load();
    return cache;
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
      if (data.version !== CACHE_VERSION) return;
      this.entries = new Map(Object.entries(data.entries));
    } catch {
      this.entries = new Map();
    }
  }

  get(relativePath: string, stats: fs.Stats): ParsedFile | null {
    const entry = this.entries.get(relativePath);
    if (!entry) return null;
    if (entry.mtimeMs !== stats.mtimeMs || entry.size !== stats.size) return null;
    return entry.parsed;
  }

  set(relativePath: string, stats: fs.Stats, parsed: ParsedFile): void {
    this.entries.set(relativePath, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
    this.dirty = true;
  }

  /** Drops entries for files that no longer exist, then writes to disk. */
  save(livePaths: Set<string>): void {
    if (!this.file || !this.dirty) return;

    for (const key of [...this.entries.keys()]) {
      if (!livePaths.has(key)) this.entries.delete(key);
    }

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: CacheFile = {
        version: CACHE_VERSION,
        entries: Object.fromEntries(this.entries),
      };
      fs.writeFileSync(this.file, JSON.stringify(data));
      this.dirty = false;
    } catch {
      // A cache that cannot be written is a performance problem, never a
      // correctness one, so failures here are intentionally silent.
    }
  }

  invalidate(relativePath: string): void {
    this.entries.delete(relativePath);
    this.dirty = true;
  }

  get size(): number {
    return this.entries.size;
  }
}
