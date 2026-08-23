import fs from 'node:fs';
import path from 'node:path';
import type { ParsedFile } from './types.js';
import { readVersion } from '../utils/version.js';
import { ensureLocalGitignore } from '../config/load.js';

/**
 * Parse cache keyed by file path and validated with mtime + size.
 *
 * Re-parsing is by far the most expensive part of an analysis, so watch mode
 * and repeated runs reuse results for files that have not been touched.
 */

/**
 * Bump whenever the shape of `ParsedFile` changes.
 *
 * The tool version alone is not enough to invalidate on: it stays put while the
 * shape moves, so an entry missing a newly added field still looks valid and
 * the rules reading that field see nothing.
 */
const CACHE_VERSION = 3;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

interface CacheFile {
  version: number;
  /**
   * The Little Owl version that produced these entries. A different version may
   * parse or measure differently, so its results are not reusable.
   */
  tool: string;
  entries: Record<string, CacheEntry>;
}

export class ParseCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(
    private readonly file: string | null,
    private readonly root: string | null = null,
  ) {}

  static open(root: string, enabled = true): ParseCache {
    const file = enabled ? path.join(root, '.little-owl', 'cache', 'parse.json') : null;
    const cache = new ParseCache(file, root);
    if (file) cache.load();
    return cache;
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
      if (data.version !== CACHE_VERSION || data.tool !== readVersion()) return;
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

  /**
   * The stored entry for a path regardless of whether it is still valid.
   *
   * `get` refuses an entry whose mtime or size moved, because that is the cheap
   * check. Once the file has been read anyway, its content hash can still show
   * the change was cosmetic — a `git checkout` or a `touch` rewrites mtimes
   * without changing a byte — and re-parsing it would be wasted work.
   */
  peek(relativePath: string): ParsedFile | null {
    return this.entries.get(relativePath)?.parsed ?? null;
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
      // The cache is machine state. Make sure it cannot drift into the repo
      // even for someone who never ran `little-owl init`.
      if (this.root) ensureLocalGitignore(this.root);
      const data: CacheFile = {
        version: CACHE_VERSION,
        tool: readVersion(),
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
