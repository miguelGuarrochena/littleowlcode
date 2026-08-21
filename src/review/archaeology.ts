import type { AnalysisContext } from '../core/context.js';
import {
  coChangedFiles,
  commitCount,
  fileAuthors,
  fileCreation,
  fileHistory,
  isGitRepository,
  type Commit,
} from '../git/git.js';

/**
 * Code archaeology: why does this file exist?
 *
 * Everything here comes from evidence already in the repository — the commit
 * that introduced the file, what its message said, who has maintained it, what
 * changes alongside it, and who imports it today.
 *
 * The hard rule: **never invent history.** Where the evidence is thin, the
 * report says so rather than filling the gap with a plausible story. A
 * confident-sounding wrong explanation is worse than no explanation.
 */

export type EvidenceStrength = 'strong' | 'partial' | 'none';

export interface ArchaeologyReport {
  file: string;
  exists: boolean;
  /** False when the project is not a git repository. */
  hasHistory: boolean;
  evidence: EvidenceStrength;

  created: Commit | null;
  ageDays: number | null;
  lastChanged: Commit | null;
  commits: number;
  authors: Array<{ name: string; commits: number }>;

  /** Commit subjects that look like they explain a reason, newest first. */
  rationale: string[];

  /** Files that import this one today. */
  consumers: string[];
  /** Files that keep changing alongside it, even without importing it. */
  coChanged: Array<{ path: string; times: number }>;
  tests: string[];

  /** What the evidence supports. Never a guess dressed up as a fact. */
  assessment: string[];
  recommendation: string | null;
}

/** Commit subjects that carry a reason rather than just an action. */
const RATIONALE_PATTERNS = [
  /\bbecause\b/i,
  /\bto (?:fix|handle|support|avoid|prevent|allow|enable|work around)\b/i,
  /\bfix(?:es|ed)?\b/i,
  /\bworkaround\b/i,
  /\bso that\b/i,
  /\bneeded (?:for|by)\b/i,
  /\brequired (?:for|by)\b/i,
  /\bintroduc(?:e|es|ed)\b/i,
  /\badd(?:s|ed)? support\b/i,
  /#\d+/,
];

const looksLikeRationale = (commit: Commit): boolean => {
  const text = `${commit.subject} ${commit.body}`;
  return RATIONALE_PATTERNS.some((pattern) => pattern.test(text));
};

const daysSince = (iso: string): number | null => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
};

export const explainFile = (context: AnalysisContext, file: string): ArchaeologyReport => {
  const parsed = context.fileMap.get(file);
  const consumers = context.graph.dependentsOf(file);
  const tests = consumers.filter((path) => context.fileMap.get(path)?.isTest);
  const hasHistory = isGitRepository(context.root);

  const empty: ArchaeologyReport = {
    file,
    exists: parsed !== undefined,
    hasHistory,
    evidence: 'none',
    created: null,
    ageDays: null,
    lastChanged: null,
    commits: 0,
    authors: [],
    rationale: [],
    consumers: consumers.filter((path) => !tests.includes(path)),
    coChanged: [],
    tests,
    assessment: [],
    recommendation: null,
  };

  if (!hasHistory) {
    empty.assessment.push(
      'This project is not a git repository, so there is no history to read. Only the current ' +
        'import graph is available.',
    );
    empty.assessment.push(...structuralAssessment(context, file, empty.consumers, tests));
    return empty;
  }

  const created = fileCreation(context.root, file);
  const history = fileHistory(context.root, file);
  const commits = commitCount(context.root, file);

  if (!created && history.length === 0) {
    empty.assessment.push(
      'Git has no record of this file — it is probably new and not yet committed, so there is ' +
        'nothing to say about why it was introduced.',
    );
    empty.assessment.push(...structuralAssessment(context, file, empty.consumers, tests));
    return empty;
  }

  const rationale = history
    .filter(looksLikeRationale)
    .slice(0, 5)
    .map((commit) => `${commit.subject} (${commit.shortHash}, ${commit.date.slice(0, 10)})`);

  const report: ArchaeologyReport = {
    ...empty,
    created,
    ageDays: created ? daysSince(created.date) : null,
    lastChanged: history[0] ?? null,
    commits,
    authors: fileAuthors(context.root, file).slice(0, 5),
    rationale,
    coChanged: coChangedFiles(context.root, file).slice(0, 5),
    evidence: evidenceStrength(created, rationale.length, commits),
  };

  report.assessment = buildAssessment(context, report);
  report.recommendation = buildRecommendation(report);
  return report;
};

const evidenceStrength = (
  created: Commit | null,
  rationaleCount: number,
  commits: number,
): EvidenceStrength => {
  if (created && rationaleCount > 0) return 'strong';
  if (created || commits > 0) return 'partial';
  return 'none';
};

const structuralAssessment = (
  context: AnalysisContext,
  file: string,
  consumers: string[],
  tests: string[],
): string[] => {
  const lines: string[] = [];
  const parsed = context.fileMap.get(file);

  if (!parsed) {
    lines.push('This file is not part of the analysed source set.');
    return lines;
  }

  if (consumers.length === 0) {
    lines.push('Nothing in the project imports it today.');
  } else {
    lines.push(
      `${consumers.length} file${consumers.length === 1 ? '' : 's'} import${consumers.length === 1 ? 's' : ''} it today.`,
    );
  }
  if (tests.length > 0) {
    lines.push(`${tests.length} test file${tests.length === 1 ? '' : 's'} reach it.`);
  }

  return lines;
};

const buildAssessment = (context: AnalysisContext, report: ArchaeologyReport): string[] => {
  const lines: string[] = [];

  if (report.created) {
    const age =
      report.ageDays === null
        ? ''
        : report.ageDays < 60
          ? ` (${report.ageDays} day${report.ageDays === 1 ? '' : 's'} ago)`
          : ` (about ${Math.round(report.ageDays / 30)} months ago)`;
    lines.push(`Introduced in ${report.created.shortHash}${age}: "${report.created.subject}".`);
  }

  if (report.rationale.length === 0) {
    lines.push(
      'No commit message explains why it was introduced, so the original reason is not recorded ' +
        'anywhere Little Owl can read.',
    );
  }

  if (report.commits > 0) {
    const churn =
      report.commits > 30
        ? 'It changes often, which usually means it holds logic that is still evolving.'
        : report.commits <= 2
          ? 'It has barely changed since it was written.'
          : `It has been touched in ${report.commits} commits.`;
    lines.push(churn);
  }

  lines.push(...structuralAssessment(context, report.file, report.consumers, report.tests));

  if (report.coChanged.length > 0) {
    const top = report.coChanged[0]!;
    if (top.times >= 3 && !report.consumers.includes(top.path)) {
      lines.push(
        `It usually changes at the same time as ${top.path} (${top.times} shared commits), even ` +
          'though neither imports the other.',
      );
    }
  }

  return lines;
};

const buildRecommendation = (report: ArchaeologyReport): string | null => {
  if (report.evidence === 'none') return null;

  if (report.consumers.length === 0 && report.tests.length === 0) {
    return report.commits <= 2
      ? 'Nothing imports it and it has hardly changed. Worth checking whether it is still needed — ' +
          'run `little-owl dead-code` before deciding.'
      : 'Nothing imports it today. It may be reached dynamically, or it may be left over.';
  }

  if (report.consumers.length >= 3) {
    return (
      `${report.consumers.length} modules depend on this. Changing its interface is a wide change — ` +
      'run `little-owl impact` first.'
    );
  }

  if (report.tests.length === 0) {
    return 'It is in use but no test reaches it. Worth covering before changing its behaviour.';
  }

  return 'It is in use and covered by tests.';
};
