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

const createSourceFile = (input: ParseInput): ts.SourceFile => {
  const isTsx = input.path.endsWith('.tsx') || input.path.endsWith('.jsx');
  return ts.createSourceFile(
    input.path,
    input.content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
};

const isFunctionLike = (node: ts.Node): node is ts.SignatureDeclaration => {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
};

const functionName = (node: ts.Node): string => {
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
};

/**
 * Cyclomatic complexity of a single function body, not counting nested
 * function declarations — those are measured on their own.
 */
const measureBody = (body: ts.Node): { complexity: number; maxNesting: number } => {
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
};

const returnsJsx = (node: ts.Node): boolean => {
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
};

const collectFunctions = (source: ts.SourceFile): FunctionInfo[] => {
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
};

/** What an import statement actually takes out of the module. */
const bindingOf = (
  clause: ts.ImportClause | undefined,
): { names?: string[]; wildcard?: boolean } => {
  if (!clause) return { wildcard: true }; // `import './side-effect'`

  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) return { wildcard: true };

  const names: string[] = [];
  if (clause.name) names.push('default');
  if (bindings && ts.isNamedImports(bindings)) {
    // `import { a as b }` consumes `a` from the module.
    for (const element of bindings.elements)
      names.push((element.propertyName ?? element.name).text);
  }
  return { names };
};

/** The same question for `export … from './x'`. */
const reExportBindingOf = (
  clause: ts.NamedExportBindings | undefined,
): {
  names?: string[];
  wildcard?: boolean;
} => {
  if (!clause || !ts.isNamedExports(clause)) return { wildcard: true };
  return { names: clause.elements.map((element) => (element.propertyName ?? element.name).text) };
};

const collectImports = (source: ts.SourceFile): ImportRef[] => {
  const imports: ImportRef[] = [];

  const push = (
    specifier: string,
    kind: ImportRef['kind'],
    node: ts.Node,
    typeOnly: boolean,
    computed = false,
    binding: { names?: string[]; wildcard?: boolean } = {},
  ): void => {
    imports.push({
      raw: specifier,
      kind,
      typeOnly,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      ...(computed ? { computed: true } : {}),
      ...(binding.names && binding.names.length > 0 ? { names: binding.names } : {}),
      ...(binding.wildcard ? { wildcard: true } : {}),
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
      push(node.moduleSpecifier.text, 'import', node, typeOnly === true, false, bindingOf(clause));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(
        node.moduleSpecifier.text,
        'export-from',
        node,
        node.isTypeOnly,
        false,
        reExportBindingOf(node.exportClause),
      );
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;

      if ((isRequire || isDynamic) && first) {
        if (ts.isStringLiteral(first)) {
          push(first.text, isDynamic ? 'dynamic' : 'require', node, false, false, {
            wildcard: true,
          });
        } else if (isDynamic) {
          // A specifier built at runtime could point anywhere. Recording it
          // is what stops dead-code and impact from sounding more certain
          // than they are.
          push(first.getText(), 'dynamic', node, false, true);
        }
      }
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return imports;
};

const collectExports = (source: ts.SourceFile): string[] => {
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
};

const collectMarkers = (source: ts.SourceFile, content: string, isTs: boolean): Marker[] => {
  const markers: Marker[] = [];
  const lineOf = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;

  if (isTs) {
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        markers.push({ kind: 'any', line: lineOf(node.getStart(source)) });
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        // `as Foo` is normal TypeScript. Only the escape hatches are flagged,
        // and `x as unknown as Y` counts once, at the outer assertion.
        const isInnerOfChain = node.parent !== undefined && ts.isAsExpression(node.parent);
        const typeText = isInnerOfChain ? 'skip' : node.type.getText();
        const isUnsafe =
          typeText === 'any' ||
          typeText === 'unknown' ||
          /\bas\s+unknown\s+as\b/.test(node.getText());
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

  for (const comment of comments(source, content)) {
    // TypeScript and ESLint only honour a directive at the start of a comment,
    // so prose that merely mentions `@ts-ignore` is correctly left alone.
    const directive =
      /^\/[/*]+\s*@?(ts-ignore|ts-expect-error|eslint-disable(?:-next-line)?)\b/.exec(comment.text);
    if (!directive) continue;

    const kind = directive[1]!.startsWith('eslint-disable')
      ? 'eslint-disable'
      : (directive[1] as 'ts-ignore' | 'ts-expect-error');

    markers.push({ kind, line: lineOf(comment.position), text: comment.text.trim() });
  }

  return markers;
};

interface CommentRange {
  text: string;
  position: number;
}

/**
 * Every comment in the file, found with the TypeScript lexer.
 *
 * Scanning raw lines would also match `'@ts-ignore'` written inside a string —
 * which is exactly what happens in code that talks *about* suppressions, this
 * file included.
 */
const comments = (source: ts.SourceFile, content: string): CommentRange[] => {
  const found: CommentRange[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    source.languageVariant,
    content,
  );

  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      found.push({ text: scanner.getTokenText(), position: scanner.getTokenStart() });
    }
    token = scanner.scan();
  }

  return found;
};

/**
 * Lines where `useEffect` is called without a dependency array, meaning the
 * effect re-runs after every single render.
 */
const collectEffectsWithoutDeps = (source: ts.SourceFile): number[] => {
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
};

const parseTypeScriptLike = (input: ParseInput, isTs: boolean): ParsedFile => {
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
      pathLiterals: collectPathLiterals(input.content),
    },
  };
};

/**
 * Quoted strings that name a file, outside of any import.
 *
 * Plenty of files are referenced without being imported: a jest config naming
 * its setup file, a service worker registered as `'/sw.js'`, a route table
 * built from paths. Reachability that only follows imports calls all of them
 * dead, so this is the trace that keeps them alive.
 */
const PATH_LITERAL = /['"`]([^'"`\n\s]*\/[^'"`\n\s]*\.[A-Za-z0-9]{1,5})['"`]/g;

/** Enough to cover a config file; a cap keeps a generated file from bloating the cache. */
const MAX_PATH_LITERALS = 200;

const collectPathLiterals = (content: string): string[] => {
  const found = new Set<string>();
  for (const match of content.matchAll(PATH_LITERAL)) {
    found.add(normalizeLiteral(match[1]!));
    if (found.size >= MAX_PATH_LITERALS) break;
  }
  return [...found];
};

/** Drops the prefixes tools put in front of a path: `./`, `/`, `<rootDir>/`. */
const normalizeLiteral = (value: string): string =>
  value
    .replace(/^<[^>]+>\//, '')
    .replace(/^\.{1,2}\//, '')
    .replace(/^\//, '');

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
