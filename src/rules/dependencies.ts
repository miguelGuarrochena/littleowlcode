import type { Finding } from '../core/types.js';
import { createFinding, type AnalysisContext, type Rule } from '../core/context.js';
import { readFileAtRef } from '../git/git.js';

/**
 * Packages that legitimately never appear in an import statement: type-only
 * packages, build tooling and framework CLIs.
 */
const IMPLICITLY_USED = [
  /^@types\//,
  /^eslint/,
  /^@eslint\//,
  /^prettier/,
  /^postcss/,
  /^tailwindcss$/,
  /^autoprefixer$/,
  /^typescript$/,
  /^tsx$/,
  /^tsup$/,
  /^vite$/,
  /^vitest$/,
  /^jest$/,
  /^husky$/,
  /^lint-staged$/,
  /^sharp$/,
  /^encoding$/,
];

function baseManifest(context: AnalysisContext): Record<string, string> | null {
  const base = context.changes?.base;
  if (!base) return null;
  const raw = readFileAtRef(context.root, base, 'package.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  } catch {
    return null;
  }
}

function majorOf(range: string): string | null {
  const match = /(\d+)\./.exec(range.replace(/^[\^~>=<\s]*/, ''));
  return match ? match[1]! : null;
}

const majorVersionChange: Rule = {
  id: 'dependencies/major-version-change',
  category: 'dependencies',
  description: 'Dependencies whose major version moved in this change.',
  run(context) {
    const before = baseManifest(context);
    if (!before) return [];

    const now = { ...context.project.dependencies, ...context.project.devDependencies };
    const findings: Finding[] = [];

    for (const [name, range] of Object.entries(now).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const previous = before[name];
      if (!previous) continue;
      const previousMajor = majorOf(previous);
      const currentMajor = majorOf(range);
      if (!previousMajor || !currentMajor || previousMajor === currentMajor) continue;

      const finding = createFinding(this, context, {
        file: 'package.json',
        title: `${name} moved from v${previousMajor} to v${currentMajor}`,
        message:
          `${name} changed major version (${previous} -> ${range}). Major versions are where breaking ` +
          'changes live, so this is worth a deliberate look rather than a glance at the diff.',
        suggestion: `Check ${name}'s changelog for the breaking changes between v${previousMajor} and v${currentMajor}.`,
        key: [name, previous, range],
        baseline: previous,
        current: range,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const newDependency: Rule = {
  id: 'dependencies/new-dependency',
  category: 'dependencies',
  description: 'Dependencies added by this change.',
  run(context) {
    const before = baseManifest(context);
    if (!before) return [];

    const now = { ...context.project.dependencies, ...context.project.devDependencies };
    const added = Object.keys(now)
      .filter((name) => !(name in before))
      .sort();
    if (added.length === 0) return [];

    const finding = createFinding(this, context, {
      file: 'package.json',
      title: `${added.length} new dependenc${added.length === 1 ? 'y' : 'ies'}`,
      message:
        `This change adds ${added.join(', ')}. New dependencies are worth a conscious decision: each ` +
        'one is code you now ship, update and trust.',
      detail: added.map((name) => `${name}@${now[name]}`),
      suggestion:
        'Confirm each addition is needed and that nothing already in the project does the job.',
      key: added,
      current: added,
    });

    return finding ? [finding] : [];
  },
};

const unusedDependency: Rule = {
  id: 'dependencies/unused-dependency',
  category: 'dependencies',
  description: 'Declared runtime dependencies that are never imported.',
  run(context) {
    const imported = context.graph.externalPackages();
    const findings: Finding[] = [];
    const unused = Object.keys(context.project.dependencies)
      .filter((name) => !imported.has(name))
      .filter((name) => !IMPLICITLY_USED.some((pattern) => pattern.test(name)))
      .sort();

    if (unused.length === 0) return findings;

    const finding = createFinding(this, context, {
      file: 'package.json',
      title: `${unused.length} dependenc${unused.length === 1 ? 'y' : 'ies'} with no imports found`,
      message:
        `Little Owl found no import of ${unused.join(', ')} anywhere in the analysed source. They may ` +
        'still be loaded through configuration or at runtime, so treat this as a prompt to check, not proof.',
      detail: unused,
      suggestion:
        'Remove the ones that really are unused; they slow installs and widen the attack surface.',
      key: unused,
      current: unused,
    });
    if (finding) findings.push(finding);

    return findings;
  },
};

const duplicateDependency: Rule = {
  id: 'dependencies/duplicate-dependency',
  category: 'dependencies',
  description: 'Packages declared in both dependencies and devDependencies.',
  run(context) {
    const duplicates = Object.keys(context.project.dependencies)
      .filter((name) => name in context.project.devDependencies)
      .sort();
    if (duplicates.length === 0) return [];

    const finding = createFinding(this, context, {
      file: 'package.json',
      title: `${duplicates.length} package${duplicates.length === 1 ? '' : 's'} declared twice`,
      message:
        `${duplicates.join(', ')} appear${duplicates.length === 1 ? 's' : ''} in both dependencies and ` +
        'devDependencies. Which version wins depends on the package manager, so installs can differ between machines.',
      detail: duplicates,
      suggestion:
        'Keep the declaration in one place — dependencies if it ships, devDependencies if it does not.',
      key: duplicates,
      current: duplicates,
    });

    return finding ? [finding] : [];
  },
};

export const dependencyRules: Rule[] = [
  majorVersionChange,
  newDependency,
  unusedDependency,
  duplicateDependency,
];
