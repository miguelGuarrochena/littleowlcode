import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '../core/types.js';

/**
 * The commands this project already has for checking its own work.
 *
 * "Run your tests" is not an instruction if you do not know what this project
 * calls them. Little Owl reads the scripts that are actually defined and quotes
 * them back, so the verification step is something to copy rather than
 * something to work out.
 */

export interface ProjectCommands {
  test?: string;
  build?: string;
  typecheck?: string;
  lint?: string;
}

const RUNNER: Record<NonNullable<ProjectInfo['packageManager']>, string> = {
  pnpm: 'pnpm',
  npm: 'npm run',
  yarn: 'yarn',
  bun: 'bun run',
};

export const detectCommands = (root: string, project: ProjectInfo): ProjectCommands => {
  const commands: ProjectCommands = {};

  if (project.languages.includes('go')) {
    commands.test = 'go test ./...';
    commands.build = 'go build ./...';
    return commands;
  }

  const scripts = readScripts(root);
  const run = RUNNER[project.packageManager ?? 'npm'];

  if (scripts) {
    for (const [key, target] of [
      ['test', 'test'],
      ['build', 'build'],
      ['typecheck', 'typecheck'],
      ['lint', 'lint'],
    ] as const) {
      const name = findScript(scripts, target);
      if (name) commands[key] = `${run} ${name}`;
    }
  }

  // A TypeScript project can always be type checked, script or not, and that
  // is the single most useful "did I break it?" command for these findings.
  if (!commands.typecheck && project.hasTypeScript) commands.typecheck = 'npx tsc --noEmit';

  if (!commands.test && project.languages.includes('python')) {
    commands.test = 'pytest';
  }

  return commands;
};

const ALIASES: Record<string, string[]> = {
  test: ['test', 'test:unit', 'tests', 'vitest', 'jest'],
  build: ['build', 'compile'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
  lint: ['lint', 'eslint'],
};

const findScript = (scripts: Record<string, string>, target: string): string | null => {
  for (const candidate of ALIASES[target] ?? [target]) {
    if (typeof scripts[candidate] === 'string') return candidate;
  }
  return null;
};

const readScripts = (root: string): Record<string, string> | null => {
  try {
    const file = path.join(root, 'package.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? null;
  } catch {
    return null;
  }
};

/** The best single "did this break anything?" command, if the project has one. */
export const verificationCommand = (commands: ProjectCommands): string | null =>
  commands.test ?? commands.typecheck ?? commands.build ?? null;
