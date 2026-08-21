import { execFileSync } from 'node:child_process';
import type { ChangeSet, ChangedFile } from '../core/types.js';
import { NEVER_ANALYSED } from '../core/scan.js';

/**
 * Git access through plain subprocesses. Little Owl only ever reads: it never
 * commits, stages, checks out or pushes.
 */

export interface GitOptions {
  root: string;
}

const git = (root: string, args: string[]): string | null => {
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
};

export const isGitRepository = (root: string): boolean => {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
};

export const currentBranch = (root: string): string | null => {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
};

export const headCommit = (root: string): string | null => git(root, ['rev-parse', 'HEAD']);

export const shortCommit = (root: string, ref = 'HEAD'): string | null => {
  return git(root, ['rev-parse', '--short', ref]);
};

export const hasUncommittedChanges = (root: string): boolean => {
  const status = git(root, ['status', '--porcelain']);
  return Boolean(status && status.length > 0);
};

export const defaultBranch = (root: string): string | null => {
  const remoteHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace('refs/remotes/origin/', '');
  for (const candidate of ['main', 'master', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
};

const parseNameStatus = (output: string): ChangedFile[] => {
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
    const status: ChangedFile['status'] = code.startsWith('A')
      ? 'added'
      : code.startsWith('D')
        ? 'deleted'
        : 'modified';
    files.push({ path: filePath, status, insertions: 0, deletions: 0 });
  }
  return files;
};

const applyNumstat = (files: ChangedFile[], output: string): void => {
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
};

const untrackedFiles = (root: string): ChangedFile[] => {
  const output = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((path) => ({ path, status: 'untracked' as const, insertions: 0, deletions: 0 }));
};

const diffAgainst = (root: string, ref: string): ChangedFile[] => {
  const nameStatus = git(root, ['diff', '--name-status', ref]);
  if (nameStatus === null) return [];
  const files = parseNameStatus(nameStatus);
  const numstat = git(root, ['diff', '--numstat', ref]);
  if (numstat) applyNumstat(files, numstat);
  return files;
};

const diffRange = (root: string, range: string): ChangedFile[] => {
  const nameStatus = git(root, ['diff', '--name-status', range]);
  if (nameStatus === null) return [];
  const files = parseNameStatus(nameStatus);
  const numstat = git(root, ['diff', '--numstat', range]);
  if (numstat) applyNumstat(files, numstat);
  return files;
};

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
export const detectChanges = (root: string, query: ChangeQuery = {}): ChangeSet | null => {
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
};

/** Little Owl's own files are not part of the change being reviewed. */
const SELF_MANAGED = /^\.little-owl\//;

/**
 * Whether a path lives somewhere that is never project source.
 *
 * `git ls-files --others` honours .gitignore, so a project without one reports
 * every installed dependency as an untracked change — turning a seven-file edit
 * into "235 files changed". Those directories are not part of anybody's change.
 */
const isNotProjectSource = (path: string): boolean =>
  path.split('/').some((segment) => NEVER_ANALYSED.has(segment));

const dedupe = (files: ChangedFile[]): ChangedFile[] => {
  const byPath = new Map<string, ChangedFile>();
  for (const file of files) {
    if (SELF_MANAGED.test(file.path)) continue;
    if (isNotProjectSource(file.path)) continue;
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      continue;
    }
    existing.insertions = Math.max(existing.insertions, file.insertions);
    existing.deletions = Math.max(existing.deletions, file.deletions);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

/** Reads a file as it exists at a given ref, or `null` when absent there. */
export const readFileAtRef = (root: string, ref: string, file: string): string | null => {
  return git(root, ['show', `${ref}:${file}`]);
};

export interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
  body: string;
}

/**
 * Separators chosen so they cannot appear in a commit message. Parsing git
 * output on newlines alone breaks the moment someone writes a multi-line body.
 */
const FIELD = '\u001F';
const RECORD = '\u001E';
const LOG_FORMAT = `--pretty=format:%H${FIELD}%h${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%b${RECORD}`;

const parseLog = (output: string | null): Commit[] => {
  if (!output) return [];
  const commits: Commit[] = [];

  for (const record of output.split(RECORD)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash, shortHash, date, author, subject, body] = trimmed.split(FIELD);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      date: date ?? '',
      author: author ?? '',
      subject: subject ?? '',
      body: (body ?? '').trim(),
    });
  }

  return commits;
};

/**
 * Commits that touched a file, newest first.
 *
 * `--follow` keeps the history across renames, which matters when asking why a
 * file exists: a rename would otherwise hide its whole origin story.
 */
export const fileHistory = (root: string, file: string, limit = 50): Commit[] => {
  return parseLog(git(root, ['log', '--follow', `-n${limit}`, LOG_FORMAT, '--', file]));
};

/** The commit that introduced a file, or `null` when git has no record of it. */
export const fileCreation = (root: string, file: string): Commit | null => {
  const history = parseLog(
    git(root, ['log', '--follow', '--diff-filter=A', '-n1', LOG_FORMAT, '--', file]),
  );
  return history[0] ?? null;
};

/** How many commits touched a file — a rough proxy for how much it churns. */
export const commitCount = (root: string, file: string): number => {
  const output = git(root, ['rev-list', '--count', 'HEAD', '--', file]);
  return output ? Number.parseInt(output, 10) || 0 : 0;
};

/** Distinct authors who touched a file, most frequent first. */
export const fileAuthors = (
  root: string,
  file: string,
): Array<{ name: string; commits: number }> => {
  const output = git(root, ['shortlog', '-sn', '--no-merges', 'HEAD', '--', file]);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[2]!, commits: Number.parseInt(match[1]!, 10) || 0 }));
};

/**
 * Files that changed together with `file` most often.
 *
 * Repeated co-change is evidence of coupling that the import graph cannot see —
 * two files that always move together are related whether or not they import
 * each other.
 */
export const coChangedFiles = (
  root: string,
  file: string,
  limit = 30,
): Array<{ path: string; times: number }> => {
  const output = git(root, [
    'log',
    `-n${limit}`,
    '--format=%H',
    '--name-only',
    '--no-merges',
    '--',
    file,
  ]);
  if (!output) return [];

  const counts = new Map<string, number>();
  for (const line of output.split('\n')) {
    const path = line.trim();
    if (!path || path === file) continue;
    // Commit hashes are 40 hex characters and never contain a dot or slash.
    if (/^[0-9a-f]{40}$/.test(path)) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([path, times]) => ({ path, times }))
    .sort((a, b) => b.times - a.times || (a.path < b.path ? -1 : 1));
};
