import type { FunctionInfo, ImportRef, Marker, ParsedFile } from '../core/types.js';
import { hashContent } from '../utils/hash.js';
import { countSloc, looksLikeTest, type LanguageAdapter, type ParseInput } from './adapter.js';

/**
 * Go support is line-oriented: package clause, imports, function boundaries by
 * brace balance, and discarded return values. It is not a replacement for
 * `staticcheck` or `golangci-lint`, and does not attempt to be.
 */

const PACKAGE_RE = /^package\s+(\w+)/;
const SINGLE_IMPORT_RE = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/;
const GROUPED_ENTRY_RE = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;
const FUNC_RE = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)/;
const DECISION_RE = /(^|\s)(if|for|case|select|&&|\|\|)(\s|\{|$)/g;
/** `_ = doThing()` or `value, _ := doThing()` — a return value thrown away. */
const DISCARDED_RE =
  /(^|[\s(])_\s*(?:,\s*[\w.]+\s*)?(?::=|=)\s*[\w.]+\(|,\s*_\s*(?::=|=)\s*[\w.]+\(/;

function collectImports(lines: string[]): ImportRef[] {
  const imports: ImportRef[] = [];
  let inGroup = false;

  lines.forEach((line, index) => {
    if (inGroup) {
      if (line.trim().startsWith(')')) {
        inGroup = false;
        return;
      }
      const match = GROUPED_ENTRY_RE.exec(line);
      if (match) {
        imports.push({ raw: match[1]!, kind: 'import', line: index + 1, typeOnly: false });
      }
      return;
    }

    if (/^\s*import\s*\($/.test(line.trimEnd())) {
      inGroup = true;
      return;
    }
    const single = SINGLE_IMPORT_RE.exec(line);
    if (single) {
      imports.push({ raw: single[1]!, kind: 'import', line: index + 1, typeOnly: false });
    }
  });

  return imports;
}

function collectFunctions(lines: string[]): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  lines.forEach((line, index) => {
    const match = FUNC_RE.exec(line);
    if (!match) return;

    let depth = 0;
    let endIndex = index;
    let started = false;
    let complexity = 1;
    let maxNesting = 0;

    for (let i = index; i < lines.length; i += 1) {
      const current = lines[i]!;
      const opens = (current.match(/\{/g) ?? []).length;
      const closes = (current.match(/\}/g) ?? []).length;

      if (i > index) {
        const decisions = current.match(DECISION_RE);
        if (decisions) complexity += decisions.length;
        maxNesting = Math.max(maxNesting, depth - 1);
      }

      depth += opens - closes;
      if (opens > 0) started = true;
      if (started && depth <= 0) {
        endIndex = i;
        break;
      }
      endIndex = i;
    }

    const params = match[2]!
      .split(',')
      .map((param) => param.trim())
      .filter(Boolean);

    functions.push({
      name: match[1]!,
      line: index + 1,
      endLine: endIndex + 1,
      lines: endIndex - index + 1,
      complexity,
      maxNesting: Math.max(0, maxNesting),
      params: params.length,
      isComponent: false,
    });
  });

  return functions;
}

function collectMarkers(lines: string[]): Marker[] {
  const markers: Marker[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return;
    if (DISCARDED_RE.test(line)) {
      markers.push({ kind: 'ignored-error', line: index + 1, text: trimmed });
    }
  });
  return markers;
}

export const goAdapter: LanguageAdapter = {
  language: 'go',
  canHandle: (file) => file.endsWith('.go'),
  parse(input: ParseInput): ParsedFile {
    const lines = input.content.split('\n');
    const packageLine = lines.find((line) => PACKAGE_RE.test(line));
    const packageName = packageLine ? PACKAGE_RE.exec(packageLine)![1]! : '';
    const functions = collectFunctions(lines);

    return {
      path: input.path,
      absPath: input.absPath,
      language: 'go',
      hash: hashContent(input.content),
      lines: lines.length,
      sloc: countSloc(lines, ['//']),
      imports: collectImports(lines),
      functions,
      // Exported identifiers in Go start with a capital letter.
      exports: functions.filter((fn) => /^[A-Z]/.test(fn.name)).map((fn) => fn.name),
      markers: collectMarkers(lines),
      isTest: looksLikeTest(input.path),
      meta: { package: packageName },
    };
  },
};
