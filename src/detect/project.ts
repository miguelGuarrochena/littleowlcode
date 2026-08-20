import fs from 'node:fs';
import path from 'node:path';
import type { Language, ProjectInfo } from '../core/types.js';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  scripts?: Record<string, string>;
}

export function readPackageJson(root: string): PackageJson | null {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function detectPackageManager(root: string, pkg: PackageJson | null): ProjectInfo['packageManager'] {
  if (pkg?.packageManager?.startsWith('pnpm')) return 'pnpm';
  if (pkg?.packageManager?.startsWith('yarn')) return 'yarn';
  if (pkg?.packageManager?.startsWith('bun')) return 'bun';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  return pkg ? 'npm' : null;
}

/** Frameworks are inferred from dependencies plus a few unmistakable files. */
const FRAMEWORK_BY_DEPENDENCY: Array<[string, string]> = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['react-native', 'React Native'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['astro', 'Astro'],
  ['vite', 'Vite'],
  ['express', 'Express'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['@remix-run/react', 'Remix'],
  ['electron', 'Electron'],
];

const PYTHON_FRAMEWORKS: Array<[RegExp, string]> = [
  [/(^|\n)\s*django/i, 'Django'],
  [/(^|\n)\s*fastapi/i, 'FastAPI'],
  [/(^|\n)\s*flask/i, 'Flask'],
];

function detectPythonFrameworks(root: string): string[] {
  const found: string[] = [];
  const files = ['requirements.txt', 'pyproject.toml', 'Pipfile'];
  for (const name of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of PYTHON_FRAMEWORKS) {
      if (pattern.test(content) && !found.includes(label)) found.push(label);
    }
  }
  if (fs.existsSync(path.join(root, 'manage.py')) && !found.includes('Django')) found.push('Django');
  return found;
}

function detectMonorepo(root: string, pkg: PackageJson | null): ProjectInfo['monorepo'] {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(workspaceFile)) {
    const content = fs.readFileSync(workspaceFile, 'utf8');
    const packages = [...content.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1]!);
    return { kind: 'pnpm', packages };
  }
  if (fs.existsSync(path.join(root, 'nx.json'))) return { kind: 'nx', packages: [] };
  if (fs.existsSync(path.join(root, 'turbo.json'))) {
    const workspaces = normalizeWorkspaces(pkg?.workspaces);
    return { kind: 'turborepo', packages: workspaces };
  }
  const workspaces = normalizeWorkspaces(pkg?.workspaces);
  if (workspaces.length > 0) {
    const kind = fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    return { kind, packages: workspaces };
  }
  return null;
}

function normalizeWorkspaces(workspaces: PackageJson['workspaces']): string[] {
  if (!workspaces) return [];
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces.packages ?? [];
}

export function detectLanguages(root: string, fileList: string[]): Language[] {
  const languages = new Set<Language>();
  for (const file of fileList) {
    if (/\.(ts|tsx|mts|cts)$/.test(file)) languages.add('typescript');
    else if (/\.(js|jsx|mjs|cjs)$/.test(file)) languages.add('javascript');
    else if (/\.py$/.test(file)) languages.add('python');
    else if (/\.go$/.test(file)) languages.add('go');
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) languages.add('go');
  return [...languages].sort();
}

export function isGitRepo(root: string): boolean {
  let current = root;
  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

export interface DetectOptions {
  files: string[];
}

export function detectProject(root: string, options: DetectOptions): ProjectInfo {
  const pkg = readPackageJson(root);
  const dependencies = pkg?.dependencies ?? {};
  const devDependencies = pkg?.devDependencies ?? {};
  const allDependencies = { ...dependencies, ...devDependencies };

  const frameworks: string[] = [];
  for (const [dependency, label] of FRAMEWORK_BY_DEPENDENCY) {
    if (allDependencies[dependency]) frameworks.push(label);
  }
  frameworks.push(...detectPythonFrameworks(root));
  if (fs.existsSync(path.join(root, 'go.mod')) && !frameworks.includes('Go modules')) {
    frameworks.push('Go modules');
  }

  const hasTypeScript =
    fs.existsSync(path.join(root, 'tsconfig.json')) || Boolean(allDependencies['typescript']);

  return {
    root,
    name: pkg?.name ?? path.basename(root),
    isGitRepo: isGitRepo(root),
    packageManager: detectPackageManager(root, pkg),
    languages: detectLanguages(root, options.files),
    frameworks,
    monorepo: detectMonorepo(root, pkg),
    hasTypeScript,
    fileCount: options.files.length,
    dependencies,
    devDependencies,
  };
}

/** Short one-line stack description, e.g. `Next.js · TypeScript`. */
export function describeStack(project: ProjectInfo): string {
  const parts: string[] = [];
  const primaryFramework = project.frameworks[0];
  if (primaryFramework) parts.push(primaryFramework);
  if (project.hasTypeScript || project.languages.includes('typescript')) parts.push('TypeScript');
  else if (project.languages.includes('javascript')) parts.push('JavaScript');
  if (project.languages.includes('python')) parts.push('Python');
  if (project.languages.includes('go')) parts.push('Go');
  return parts.length > 0 ? [...new Set(parts)].join(' · ') : 'Unknown';
}
