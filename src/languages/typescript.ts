import ts from 'typescript';
import type { FunctionInfo, ImportRef, Marker, ParsedFile } from '../core/types.js';
import { hashContent } from '../utils/hash.js';
import { countSloc, looksLikeTest, type LanguageAdapter, type ParseInput } from './adapter.js';

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

/** Modules that must not be reachable from a client component in Next.js. */
const SERVER_ONLY_MODULES = [
  'node:fs',
  'node:child_process',
  'node:crypto',
  'fs',
  'fs/promises',
  'child_process',
  'server-only',
  'pg',
  'mysql',
  'mysql2',
  'mongodb',
  'ioredis',
  'nodemailer',
];

function createSourceFile(input: ParseInput): ts.SourceFile {
  const isTsx = input.path.endsWith('.tsx') || input.path.endsWith('.jsx');
  return ts.createSourceFile(
    input.path,
    input.content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText() ?? '<anonymous>';
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText();
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isExportAssignment(parent)) return 'default';
  if (parent && ts.isCallExpression(parent)) {
    // `memo(function Card() {})`, `forwardRef((props, ref) => ...)`
    const callee = parent.expression.getText();
    return `${callee}(...)`;
  }
  return '<anonymous>';
}

/**
 * Cyclomatic complexity of a single function body, not counting nested
 * function declarations — those are measured on their own.
 */
function measureBody(body: ts.Node): { complexity: number; maxNesting: number } {
  let complexity = 1;
  let maxNesting = 0;

  const visit = (node: ts.Node, depth: number): void => {
    let nextDepth = depth;

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        complexity += 1;
        nextDepth = depth + 1;
        maxNesting = Math.max(maxNesting, nextDepth);
        break;
      case ts.SyntaxKind.ConditionalExpression:
        complexity += 1;
        break;
      case ts.SyntaxKind.CaseClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const operator = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
        break;
      }
      default:
        break;
    }

    node.forEachChild((child) => {
      // Nested functions get their own measurement.
      if (isFunctionLike(child)) return;
      visit(child, nextDepth);
    });
  };

  body.forEachChild((child) => visit(child, 0));
  return { complexity, maxNesting };
}

function returnsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function collectFunctions(source: ts.SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const body = (node as ts.FunctionLikeDeclaration).body;
      if (body) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const name = functionName(node);
        const { complexity, maxNesting } = measureBody(body);

        functions.push({
          name,
          line: start,
          endLine: end,
          lines: end - start + 1,
          complexity,
          maxNesting,
          params: (node as ts.SignatureDeclaration).parameters.length,
          isComponent: /^[A-Z]/.test(name) && returnsJsx(body),
        });
      }
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return functions;
}

function collectImports(source: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];

  const push = (
    specifier: string,
    kind: ImportRef['kind'],
    node: ts.Node,
    typeOnly: boolean,
  ): void => {
    imports.push({
      raw: specifier,
      kind,
      typeOnly,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      push(node.moduleSpecifier.text, 'import', node, typeOnly === true);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text, 'export-from', node, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamic) && first && ts.isStringLiteral(first)) {
        push(first.text, isDynamic ? 'dynamic' : 'require', node, false);
      }
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return imports;
}

function collectExports(source: ts.SourceFile): string[] {
  const names: string[] = [];

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  source.forEachChild((node) => {
    if (ts.isExportAssignment(node)) {
      names.push('default');
      return;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) names.push(element.name.text);
      return;
    }
    if (!hasExportModifier(node)) return;

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        names.push(declaration.name.getText());
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) names.push(node.name.getText());
    }
  });

  return names;
}

function collectMarkers(source: ts.SourceFile, content: string, isTs: boolean): Marker[] {
  const markers: Marker[] = [];
  const lineOf = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;

  if (isTs) {
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        markers.push({ kind: 'any', line: lineOf(node.getStart(source)) });
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        // `as Foo` is normal TypeScript. Only the escape hatches are flagged.
        const typeText = node.type.getText();
        const isUnsafe =
          typeText === 'any' || typeText === 'unknown' || /\bas\s+unknown\s+as\b/.test(node.getText());
        if (isUnsafe) {
          markers.push({
            kind: 'unsafe-assertion',
            line: lineOf(node.getStart(source)),
            text: typeText,
          });
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }

  content.split('\n').forEach((line, index) => {
    if (line.includes('@ts-ignore')) {
      markers.push({ kind: 'ts-ignore', line: index + 1, text: line.trim() });
    } else if (line.includes('@ts-expect-error')) {
      markers.push({ kind: 'ts-expect-error', line: index + 1, text: line.trim() });
    }
    if (/eslint-disable(-next-line)?\s/.test(line)) {
      markers.push({ kind: 'eslint-disable', line: index + 1, text: line.trim() });
    }
  });

  return markers;
}

/**
 * Lines where `useEffect` is called without a dependency array, meaning the
 * effect re-runs after every single render.
 */
function collectEffectsWithoutDeps(source: ts.SourceFile): number[] {
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'useEffect' || node.expression.text === 'useLayoutEffect') &&
      node.arguments.length === 1
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return lines;
}

function parseTypeScriptLike(input: ParseInput, isTs: boolean): ParsedFile {
  const source = createSourceFile(input);
  const lines = input.content.split('\n');
  const imports = collectImports(source);
  const directives = source.statements
    .filter((statement) => ts.isExpressionStatement(statement))
    .map((statement) => (statement as ts.ExpressionStatement).expression)
    .filter((expression) => ts.isStringLiteral(expression))
    .map((expression) => (expression as ts.StringLiteral).text);

  const useClient = directives.includes('use client');
  const useServer = directives.includes('use server');

  return {
    path: input.path,
    absPath: input.absPath,
    language: isTs ? 'typescript' : 'javascript',
    hash: hashContent(input.content),
    lines: lines.length,
    sloc: countSloc(lines, ['//']),
    imports,
    functions: collectFunctions(source),
    exports: collectExports(source),
    markers: collectMarkers(source, input.content, isTs),
    isTest: looksLikeTest(input.path),
    meta: {
      useClient,
      useServer,
      hasJsx: input.path.endsWith('.tsx') || input.path.endsWith('.jsx'),
      effectsWithoutDeps: collectEffectsWithoutDeps(source),
      serverOnlyImports: imports
        .filter((reference) => SERVER_ONLY_MODULES.includes(reference.raw))
        .map((reference) => reference.raw),
    },
  };
}

export const typeScriptAdapter: LanguageAdapter = {
  language: 'typescript',
  canHandle: (file) => TS_EXTENSIONS.some((extension) => file.endsWith(extension)),
  parse: (input) => parseTypeScriptLike(input, true),
};

export const javaScriptAdapter: LanguageAdapter = {
  language: 'javascript',
  canHandle: (file) => JS_EXTENSIONS.some((extension) => file.endsWith(extension)),
  parse: (input) => parseTypeScriptLike(input, false),
};

export const SERVER_ONLY_MODULE_LIST = SERVER_ONLY_MODULES;
