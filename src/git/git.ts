import { execFileSync } from 'node:child_process';
import type { ChangeSet, ChangedFile } from '../core/types.js';

/**
 * Git access through plain subprocesses. Little Owl only ever reads: it never
 * commits, stages, checks out or pushes.
 */

export interface GitOptions {
  root: string;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepository(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function currentBranch(root: string): string | null {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function headCommit(root: string): string | null {
  return git(root, ['rev-parse', 'HEAD']);
}

export function shortCommit(root: string, ref = 'HEAD'): string | null {
  return git(root, ['rev-parse', '--short', ref]);
}

export function hasUncommittedChanges(root: string): boolean {
  const status = git(root, ['status', '--porcelain']);
  return Boolean(status && status.length > 0);
}

export function defaultBranch(root: string): string | null {
  const remoteHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace('refs/remotes/origin/', '');
  for (const candidate of ['main', 'master', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    if (code.startsWith('R') && parts.length >= 3) {
      files.push({
        path: parts[2]!,
        previousPath: parts[1]!,
        status: 'renamed',
        insertions: 0,
        deletions: 0,
      });
      continue;
    }
    const filePath = parts[1];
    if (!filePath) continue;
    const status: ChangedFile['status'] =
      code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    files.push({ path: filePath, status, insertions: 0, deletions: 0 });
  }
  return files;
}

function applyNumstat(files: ChangedFile[], output: string): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [insertions, deletions, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    const file = byPath.get(filePath);
    if (!file) continue;
    file.insertions = Number.parseInt(insertions ?? '0', 10) || 0;
    file.deletions = Number.parseInt(deletions ?? '0', 10) || 0;
  }
}

function untrackedFiles(root: string): ChangedFile[] {
  const output = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((path) => ({ path, status: 'untracked' as const, insertions: 0, deletions: 0 }));
}

function diffAgainst(root: string, ref: string): ChangedFile[] {
  const nameStatus = git(root, ['diff', '--name-status', ref]);
  if (nameStatus === null) return [];
  const files = parseNameStatus(nameStatus);
  const numstat = git(root, ['diff', '--numstat', ref]);
  if (numstat) applyNumstat(files, numstat);
  return files;
}

function diffRange(root: string, range: string): ChangedFile[] {
  const nameStatus = git(root, ['diff', '--name-status', range]);
  if (nameStatus === null) return [];
  const files = parseNameStatus(nameStatus);
  const numstat = git(root, ['diff', '--numstat', range]);
  if (numstat) applyNumstat(files, numstat);
  return files;
}

export interface ChangeQuery {
  /** Explicit git ref or range to compare against. */
  base?: string;
  /** Include files that git does not track yet. Defaults to true. */
  includeUntracked?: boolean;
}

/**
 * Works out "what changed recently", trying the most local interpretation
 * first: uncommitted work, then the current branch, then the last commit.
 */
export function detectChanges(root: string, query: ChangeQuery = {}): ChangeSet | null {
  if (!isGitRepository(root)) return null;
  const includeUntracked = query.includeUntracked ?? true;

  if (query.base) {
    const range = query.base.includes('..') ? query.base : `${query.base}...HEAD`;
    return {
      description: `changes vs ${query.base}`,
      base: query.base,
      files: dedupe(diffRange(root, range)),
    };
  }

  const working = [...diffAgainst(root, 'HEAD'), ...(includeUntracked ? untrackedFiles(root) : [])];
  if (working.length > 0) {
    return { description: 'uncommitted changes vs HEAD', base: 'HEAD', files: dedupe(working) };
  }

  const base = defaultBranch(root);
  const branch = currentBranch(root);
  if (base && branch && base !== branch) {
    const mergeBase = git(root, ['merge-base', base, 'HEAD']);
    if (mergeBase) {
      const files = diffRange(root, `${mergeBase}..HEAD`);
      if (files.length > 0) {
        return { description: `branch changes vs ${base}`, base: mergeBase, files: dedupe(files) };
      }
    }
  }

  const lastCommit = diffRange(root, 'HEAD~1..HEAD');
  if (lastCommit.length > 0) {
    return { description: 'last commit', base: 'HEAD~1', files: dedupe(lastCommit) };
  }

  return { description: 'no changes detected', files: [] };
}

function dedupe(files: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      continue;
    }
    existing.insertions = Math.max(existing.insertions, file.insertions);
    existing.deletions = Math.max(existing.deletions, file.deletions);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Reads a file as it exists at a given ref, or `null` when absent there. */
export function readFileAtRef(root: string, ref: string, file: string): string | null {
  return git(root, ['show', `${ref}:${file}`]);
}
