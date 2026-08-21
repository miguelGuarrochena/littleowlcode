import fs from 'node:fs';
import type { AnalysisContext } from '../core/context.js';
import type { ChangeSet, ParsedFile } from '../core/types.js';
import { basename, dirOf } from '../utils/paths.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';

/**
 * Test gap analysis.
 *
 * The question is not "what is the coverage percentage" — a coverage tool
 * answers that far better. The question is: *this change altered behaviour, is
 * any test watching that behaviour?* That is a risk signal, not a metric.
 *
 * Little Owl never generates tests. It points at the gap and stops.
 */

export type Coverage = 'covered' | 'partial' | 'none';

export interface TestGap {
  file: string;
  coverage: Coverage;
  /** Test files that reach this file, directly or through imports. */
  reachedBy: string[];
  /** Exported functions with no test file mentioning them by name. */
  untestedExports: string[];
  /** Why this file matters — the reason it was worth checking at all. */
  reason: string;
}

export interface TestGapReport {
  /** True when the project appears to have no tests at all. */
  hasNoTests: boolean;
  testFileCount: number;
  /** Modules at least one test reaches. */
  reachedCount: number;
  gaps: TestGap[];
  /** Modules reached by a test that also names every exported behaviour. */
  covered: string[];
  /** Files that were considered but hold no behaviour worth testing. */
  skipped: string[];
}

/**
 * Code that is real but not normally covered by unit tests: build
 * configuration, one-off scripts, migrations and CLI entry points. Listing
 * these as gaps would bury the findings that matter.
 */
const NOT_USUALLY_TESTED = [
  '*.config.*',
  '*.setup.*',
  '*.d.ts',
  'scripts/**',
  'bin/**',
  'tools/**',
  '**/migrations/**',
  '**/*.stories.*',
  'next.config.*',
  'jest.setup.*',
  'vitest.setup.*',
].map(compilePattern);

/**
 * Files with no logic worth testing: pure re-exports, type declarations and
 * constant tables. Flagging these would be noise.
 */
function hasBehaviour(file: ParsedFile): boolean {
  if (file.functions.length === 0) return false;
  // A barrel file re-exports and does nothing else.
  const onlyReExports = file.imports.every((reference) => reference.kind === 'export-from');
  if (onlyReExports && file.imports.length > 0 && file.functions.length === 0) return false;
  return file.functions.some((fn) => fn.complexity > 1 || fn.lines > 5);
}

export interface TestGapOptions {
  /** Restrict the analysis to these files. Defaults to everything. */
  files?: string[];
}

export function analyzeTestGaps(
  context: AnalysisContext,
  options: TestGapOptions = {},
): TestGapReport {
  const testFiles = context.files.filter((file) => file.isTest);
  const subjects = context.files.filter((file) => {
    if (file.isTest) return false;
    if (options.files && !options.files.includes(file.path)) return false;
    return true;
  });

  // What each test file can reach, following imports transitively.
  const reachedByTest = new Map<string, Set<string>>();
  for (const test of testFiles) {
    for (const reached of reachableFrom(context, test.path)) {
      const set = reachedByTest.get(reached) ?? new Set<string>();
      set.add(test.path);
      reachedByTest.set(reached, set);
    }
  }

  const gaps: TestGap[] = [];
  const covered: string[] = [];
  const skipped: string[] = [];
  // Scoped to this call: the same relative path in another project is a
  // different file, and a file can change between runs.
  const sourceCache = new Map<string, string | null>();

  for (const file of subjects) {
    if (!hasBehaviour(file) || matchesCompiled(file.path, NOT_USUALLY_TESTED)) {
      skipped.push(file.path);
      continue;
    }

    const reachedBy = [...(reachedByTest.get(file.path) ?? [])].sort();
    const sidecar = siblingTestFor(context, file.path);
    if (sidecar && !reachedBy.includes(sidecar)) reachedBy.push(sidecar);

    if (reachedBy.length === 0) {
      gaps.push({
        file: file.path,
        coverage: 'none',
        reachedBy: [],
        untestedExports: exportedBehaviour(file),
        reason: reasonFor(file),
      });
      continue;
    }

    // A test can reach a module without exercising much of it. Naming is the
    // only signal available without running the suite, so it is used as a
    // hint — never as proof.
    const untested = exportedBehaviour(file).filter(
      (name) => !reachedBy.some((test) => mentions(context, test, name, sourceCache)),
    );

    if (untested.length > 0) {
      gaps.push({
        file: file.path,
        coverage: 'partial',
        reachedBy,
        untestedExports: untested,
        reason: reasonFor(file),
      });
    } else {
      covered.push(file.path);
    }
  }

  return {
    hasNoTests: testFiles.length === 0,
    testFileCount: testFiles.length,
    reachedCount: reachedByTest.size,
    gaps: gaps.sort((a, b) => {
      if (a.coverage !== b.coverage) return a.coverage === 'none' ? -1 : 1;
      return a.file < b.file ? -1 : 1;
    }),
    covered: covered.sort(),
    skipped: skipped.sort(),
  };
}

/** Everything a file imports, transitively. */
function reachableFrom(context: AnalysisContext, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const dependency of context.graph.dependenciesOf(current)) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push(dependency);
    }
  }

  return seen;
}

/** `orders.ts` -> `orders.test.ts` in the same directory, if it exists. */
function siblingTestFor(context: AnalysisContext, file: string): string | null {
  const directory = dirOf(file);
  const stem = basename(file).replace(/\.[cm]?[jt]sx?$|\.py$|\.go$/, '');

  for (const candidate of context.files) {
    if (!candidate.isTest) continue;
    if (dirOf(candidate.path) !== directory && !dirOf(candidate.path).endsWith('__tests__')) {
      continue;
    }
    const candidateStem = basename(candidate.path).replace(
      /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|^test_/,
      '',
    );
    if (candidateStem === stem || candidateStem.startsWith(`${stem}.`)) return candidate.path;
  }

  return null;
}

/** Exported functions and components — the behaviour other code depends on. */
function exportedBehaviour(file: ParsedFile): string[] {
  const exported = new Set(file.exports);
  return file.functions
    .filter((fn) => exported.has(fn.name) && (fn.complexity > 1 || fn.lines > 5))
    .map((fn) => fn.name)
    .sort();
}

/**
 * Whether a test file names a given export.
 *
 * This reads the test source, because the parsed representation records the
 * test's own functions, not the ones it calls. Naming is a weak signal — a test
 * can exercise code without writing its name — so it only ever downgrades a
 * module to "partial", never to "untested".
 */
function mentions(
  context: AnalysisContext,
  testFile: string,
  name: string,
  cache: Map<string, string | null>,
): boolean {
  const source = testSource(context, testFile, cache);
  if (!source) return true; // Unreadable: assume covered rather than cry wolf.
  return new RegExp(`\\b${escapeForRegExp(name)}\\b`).test(source);
}

function testSource(
  context: AnalysisContext,
  testFile: string,
  cache: Map<string, string | null>,
): string | null {
  const cached = cache.get(testFile);
  if (cached !== undefined) return cached;

  const parsed = context.fileMap.get(testFile);
  let content: string | null = null;
  if (parsed) {
    try {
      content = fs.readFileSync(parsed.absPath, 'utf8');
    } catch {
      content = null;
    }
  }
  cache.set(testFile, content);
  return content;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reasonFor(file: ParsedFile): string {
  const branchiest = [...file.functions].sort((a, b) => b.complexity - a.complexity)[0];
  if (branchiest && branchiest.complexity >= 5) {
    return `${branchiest.name}() has ${branchiest.complexity} branches`;
  }
  return `${file.functions.length} function${file.functions.length === 1 ? '' : 's'} with logic`;
}

/** Narrows a report to the files a change actually touched. */
export function changedFilesOf(changes: ChangeSet | null): string[] | undefined {
  if (!changes) return undefined;
  const files = changes.files.filter((file) => file.status !== 'deleted').map((file) => file.path);
  return files.length > 0 ? files : undefined;
}
