import fs from 'node:fs';
import path from 'node:path';
import type { Language } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { compilePattern, matchesCompiled, type CompiledPattern } from '../utils/glob.js';
import { toPosix } from '../utils/paths.js';

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
};

export const SOURCE_EXTENSIONS = Object.keys(LANGUAGE_BY_EXTENSION);

export function languageOf(file: string): Language {
  return LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] ?? 'unknown';
}

/** Directories skipped before we even stat their contents, for speed. */
const HARD_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'coverage',
  '.cache',
  '.svelte-kit',
  'target',
  '.little-owl',
  '.idea',
  '.vscode',
]);

/**
 * Cap on files scanned in one run. It exists so that pointing Little Owl at a
 * home directory by mistake cannot run for an hour. Reaching it is reported,
 * never silently absorbed.
 */
export const MAX_SCANNED_FILES = 20_000;

export interface ScanOptions {
  /** Cap on files scanned; protects against accidentally huge trees. */
  maxFiles?: number;
}

export interface ScanResult {
  files: string[];
  /** True when `maxFiles` cut the walk short. */
  truncated: boolean;
}

/**
 * Walks the project and returns repo-relative POSIX paths of source files,
 * sorted so that every run produces the same order.
 */
export function scanFiles(
  root: string,
  config: ResolvedConfig,
  options: ScanOptions = {},
): ScanResult {
  const maxFiles = options.maxFiles ?? MAX_SCANNED_FILES;
  const ignore = [...config.ignore, ...readGitignore(root)].map(compilePattern);
  const include = config.include.map(compilePattern);
  const files: string[] = [];
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));

      if (entry.isDirectory()) {
        if (HARD_SKIP.has(entry.name)) continue;
        if (matchesCompiled(`${relative}/`, ignore) || matchesCompiled(relative, ignore)) continue;
        walk(absolute);
        continue;
      }

      if (!isReadableFile(entry, absolute)) continue;
      if (languageOf(entry.name) === 'unknown') continue;
      if (matchesCompiled(relative, ignore)) continue;
      if (include.length > 0 && !matchesCompiled(relative, include)) continue;

      files.push(relative);
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(root);
  files.sort();
  return { files, truncated };
}

/**
 * Whether a directory entry is a file worth reading.
 *
 * A symlink is neither a directory nor a file to `readdir`. Package managers
 * and Homebrew-style layouts link individual source files into place, and
 * skipping them silently reported those projects as empty. Only links to files
 * are followed — a linked directory is still skipped, so a link pointing back
 * up the tree cannot make the walk loop.
 */
function isReadableFile(entry: fs.Dirent, absolute: string): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return fs.statSync(absolute).isFile();
  } catch {
    // A broken link points at nothing worth analysing.
    return false;
  }
}

/**
 * Reads the root `.gitignore` and converts it into glob patterns. This is a
 * pragmatic subset — enough to avoid analysing generated output that projects
 * already exclude from version control.
 */
export function readGitignore(root: string): string[] {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return [];

  const patterns: string[] = [];
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const body = line.replace(/\/$/, '');
    if (body.includes('/')) {
      patterns.push(body.replace(/^\//, ''));
    } else {
      patterns.push(`**/${body}`);
      patterns.push(`**/${body}/**`);
    }
  }
  return patterns;
}

export function isIgnored(relative: string, patterns: CompiledPattern[]): boolean {
  return matchesCompiled(relative, patterns);
}
