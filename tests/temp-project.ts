import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeProject, type Analysis } from '../src/core/analyze.js';
import { resolveConfig } from '../src/config/load.js';
import type { LittleOwlConfig } from '../src/config/schema.js';

/** A throwaway project on disk, so tests exercise the real file pipeline. */
export class TempProject {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static create(files: Record<string, string>): TempProject {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'little-owl-'));
    const project = new TempProject(root);
    project.write(files);
    return project;
  }

  write(files: Record<string, string>): void {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(this.root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
  }

  remove(relative: string): void {
    fs.rmSync(path.join(this.root, relative), { force: true });
  }

  analyze(config: LittleOwlConfig = {}): Promise<Analysis> {
    return analyzeProject({ root: this.root, config: resolveConfig(config), cache: false });
  }

  /** Initialises a git repo and commits everything currently on disk. */
  initGit(message = 'initial'): void {
    this.git(['init', '-q']);
    this.git(['config', 'user.email', 'test@example.com']);
    this.git(['config', 'user.name', 'Test']);
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', message]);
  }

  git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  path(relative: string): string {
    return path.join(this.root, relative);
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
