import type { Language, ParsedFile } from '../core/types.js';

export interface ParseInput {
  /** Repo-relative POSIX path. */
  path: string;
  absPath: string;
  content: string;
}

/**
 * Turns a source file into the common representation the engine understands.
 *
 * Adapters are intentionally shallow: they extract imports, function shapes and
 * a handful of language-specific markers. Everything cross-file (dependency
 * graph, layers, drift) is the engine's job, not the adapter's.
 */
export interface LanguageAdapter {
  language: Language;
  canHandle(file: string): boolean;
  parse(input: ParseInput): ParsedFile;
}

const TEST_PATTERN = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;

export function looksLikeTest(file: string): boolean {
  return TEST_PATTERN.test(file);
}

/**
 * Counts lines that carry actual code. Comment detection is line-based and
 * therefore approximate — good enough for size metrics, and it never needs a
 * second parse of the file.
 */
export function countSloc(lines: string[], commentPrefixes: string[]): number {
  let count = 0;
  let inBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('*')) continue;
    if (commentPrefixes.some((prefix) => line.startsWith(prefix))) continue;

    count += 1;
  }

  return count;
}

export function emptyParsedFile(input: ParseInput, language: Language, hash: string): ParsedFile {
  const lines = input.content.split('\n');
  return {
    path: input.path,
    absPath: input.absPath,
    language,
    hash,
    lines: lines.length,
    sloc: countSloc(lines, ['//', '#']),
    imports: [],
    functions: [],
    exports: [],
    markers: [],
    isTest: looksLikeTest(input.path),
    meta: {},
  };
}
