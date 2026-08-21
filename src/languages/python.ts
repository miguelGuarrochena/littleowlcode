import type { FunctionInfo, ImportRef, Marker, ParsedFile } from '../core/types.js';
import { hashContent } from '../utils/hash.js';
import { countSloc, looksLikeTest, type LanguageAdapter, type ParseInput } from './adapter.js';

/**
 * Python support is deliberately line-oriented rather than AST-based.
 *
 * It reads imports, function boundaries (via indentation) and a small set of
 * well-known smells. It does not try to understand Python semantics, and it
 * never claims to replace a real Python linter.
 */

const IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
const FROM_IMPORT_RE = /^\s*from\s+(\.*[\w.]*)\s+import\s+/;
const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;
const DECISION_RE = /(^|\s)(if|elif|for|while|except|assert|and|or)(\s|:|$)/g;
const MUTABLE_DEFAULT_RE = /=\s*(\[\s*\]|\{\s*\}|set\(\)|list\(\)|dict\(\))/;

const indentOf = (line: string): number => {
  const match = /^(\s*)/.exec(line);
  return match ? match[1]!.replace(/\t/g, '    ').length : 0;
};

const isBlank = (line: string): boolean => line.trim().length === 0 || line.trim().startsWith('#');

/** Finds the last line of a block that starts at `startIndex` with `indent`. */
const blockEnd = (lines: string[], startIndex: number, indent: number): number => {
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) <= indent) break;
    end = i;
  }
  return end;
};

const collectFunctions = (lines: string[]): FunctionInfo[] => {
  const functions: FunctionInfo[] = [];

  lines.forEach((line, index) => {
    const match = DEF_RE.exec(line);
    if (!match) return;

    const indent = indentOf(line);
    const name = match[2]!;
    const params = match[3]!
      .split(',')
      .map((param) => param.trim())
      .filter((param) => param.length > 0 && param !== 'self' && param !== 'cls');

    const endIndex = blockEnd(lines, index, indent);
    const body = lines.slice(index + 1, endIndex + 1);

    let complexity = 1;
    let maxNesting = 0;
    for (const bodyLine of body) {
      if (isBlank(bodyLine)) continue;
      const matches = bodyLine.match(DECISION_RE);
      if (matches) complexity += matches.length;
      maxNesting = Math.max(maxNesting, Math.floor((indentOf(bodyLine) - indent) / 4));
    }

    functions.push({
      name,
      line: index + 1,
      endLine: endIndex + 1,
      lines: endIndex - index + 1,
      complexity,
      maxNesting: Math.max(0, maxNesting - 1),
      params: params.length,
      isComponent: false,
    });
  });

  return functions;
};

const collectImports = (lines: string[]): ImportRef[] => {
  const imports: ImportRef[] = [];

  lines.forEach((line, index) => {
    const fromMatch = FROM_IMPORT_RE.exec(line);
    if (fromMatch) {
      imports.push({ raw: fromMatch[1]!, kind: 'import', line: index + 1, typeOnly: false });
      return;
    }
    const importMatch = IMPORT_RE.exec(line);
    if (importMatch) {
      for (const name of importMatch[1]!.split(',')) {
        imports.push({ raw: name.trim(), kind: 'import', line: index + 1, typeOnly: false });
      }
    }
  });

  return imports;
};

const collectMarkers = (lines: string[]): Marker[] => {
  const markers: Marker[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^except\s*:\s*$/.test(trimmed) || /^except\s+BaseException\s*:/.test(trimmed)) {
      markers.push({ kind: 'bare-except', line: index + 1, text: trimmed });
    }
    if (DEF_RE.test(line) && MUTABLE_DEFAULT_RE.test(line)) {
      markers.push({ kind: 'mutable-default', line: index + 1, text: trimmed });
    }
    if (/^global\s+\w/.test(trimmed)) {
      markers.push({ kind: 'global-state', line: index + 1, text: trimmed });
    }
  });

  return markers;
};

const collectExports = (lines: string[]): string[] => {
  const names: string[] = [];
  for (const line of lines) {
    if (indentOf(line) !== 0) continue;
    const classMatch = CLASS_RE.exec(line);
    if (classMatch) {
      names.push(classMatch[2]!);
      continue;
    }
    const defMatch = DEF_RE.exec(line);
    if (defMatch && !defMatch[2]!.startsWith('_')) names.push(defMatch[2]!);
  }
  return names;
};

export const pythonAdapter: LanguageAdapter = {
  language: 'python',
  canHandle: (file) => file.endsWith('.py') || file.endsWith('.pyi'),
  parse(input: ParseInput): ParsedFile {
    const lines = input.content.split('\n');
    return {
      path: input.path,
      absPath: input.absPath,
      language: 'python',
      hash: hashContent(input.content),
      lines: lines.length,
      sloc: countSloc(lines, ['#']),
      imports: collectImports(lines),
      functions: collectFunctions(lines),
      exports: collectExports(lines),
      markers: collectMarkers(lines),
      isTest: looksLikeTest(input.path),
      meta: {},
    };
  },
};
