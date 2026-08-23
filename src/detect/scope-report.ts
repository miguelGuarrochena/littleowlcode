import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_CODE_IGNORE } from '../config/defaults.js';
import type { ResolvedConfig } from '../config/schema.js';
import { matchesAny } from '../utils/glob.js';
import { toPosix } from '../utils/paths.js';

/**
 * What Little Owl is looking at, and what it decided to leave out.
 *
 * The single most damaging thing this tool can do is analyse the wrong files
 * and say nothing about it. A first run that reports critical problems inside
 * `tests/fixtures/` is not a tool with a bug — it is a tool the reader will
 * never trust again, because the first thing it ever told them was wrong.
 *
 * So the scope is stated out loud, before any findings: these directories are
 * your project, these ones were skipped and here is the line to change if that
 * was wrong.
 */

export interface ScopeArea {
  directory: string;
  files: number;
}

export interface SkippedArea {
  directory: string;
  files: number;
  /** Which ignore pattern caught it, so the reader can go and edit that. */
  pattern: string;
}

export interface ScopeReport {
  /** Top-level areas that are being analysed, largest first. */
  analysed: ScopeArea[];
  /** Directories skipped because they look like sample code, largest first. */
  skipped: SkippedArea[];
  totalFiles: number;
}

/** How deep a skipped directory is reported, e.g. `tests/fixtures`. */
const SKIPPED_DEPTH = 2;

/** Label for files sitting directly in the project root. */
const ROOT_AREA = '(project root)';

export const buildScopeReport = (
  root: string,
  config: ResolvedConfig,
  analysedFiles: string[],
): ScopeReport => {
  const areas = new Map<string, number>();
  for (const file of analysedFiles) {
    // Loose files at the root are config, not an area. Listing each one as its
    // own "area" buries the directories that actually hold the application.
    const directory = file.includes('/') ? file.slice(0, file.indexOf('/')) : ROOT_AREA;
    areas.set(directory, (areas.get(directory) ?? 0) + 1);
  }

  return {
    analysed: [...areas]
      .map(([directory, files]) => ({ directory, files }))
      .sort((a, b) => b.files - a.files || a.directory.localeCompare(b.directory)),
    skipped: findSkippedSamples(root, config),
    totalFiles: analysedFiles.length,
  };
};

/**
 * Sample-code directories that exist in this project and were skipped.
 *
 * Only reports what is really there. Listing every pattern Little Owl knows
 * about would be a wall of paths the project does not have, and the one entry
 * that matters would be lost in it.
 */
const findSkippedSamples = (root: string, config: ResolvedConfig): SkippedArea[] => {
  const patterns = config.ignore.filter((pattern) => SAMPLE_CODE_IGNORE.includes(pattern));
  if (patterns.length === 0) return [];

  const found: SkippedArea[] = [];
  for (const directory of walkDirectories(root, SKIPPED_DEPTH)) {
    const pattern = patterns.find((candidate) => matchesAny(`${directory}/x`, [candidate]));
    if (!pattern) continue;
    // A directory inside one already reported adds nothing.
    if (found.some((entry) => directory.startsWith(`${entry.directory}/`))) continue;
    const files = countSourceish(path.join(root, directory));
    if (files > 0) found.push({ directory, files, pattern });
  }

  return found.sort((a, b) => b.files - a.files || a.directory.localeCompare(b.directory));
};

const SKIP_WALK = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

const walkDirectories = (root: string, maxDepth: number): string[] => {
  const found: string[] = [];

  const visit = (relative: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_WALK.has(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      found.push(next);
      visit(next, depth + 1);
    }
  };

  visit('', 1);
  return found.map(toPosix);
};

const SOURCEISH = /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/;

const countSourceish = (directory: string): number => {
  let count = 0;
  const visit = (current: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(current, entry.name), depth + 1);
      else if (SOURCEISH.test(entry.name)) count += 1;
    }
  };
  visit(directory, 0);
  return count;
};
