import fs from 'node:fs';
import type { Finding } from '../core/types.js';
import { createFinding, type Rule } from '../core/context.js';

/** Lines that say nothing about duplication and would create false matches. */
function isStructuralLine(line: string): boolean {
  if (line.length < 8) return true;
  if (/^[}\]);,]+$/.test(line)) return true;
  if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) return true;
  if (/^(import|export|from|package|use\s)/.test(line)) return true;
  return false;
}

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

interface Block {
  file: string;
  line: number;
}

const duplicateBlock: Rule = {
  id: 'maintainability/duplicate-block',
  category: 'maintainability',
  description: 'Identical blocks of code appearing in more than one place.',
  run(context) {
    const window = context.config.thresholds.minDuplicateLines;
    const seen = new Map<string, Block[]>();

    for (const file of context.files) {
      if (file.isTest) continue;
      let content: string;
      try {
        content = fs.readFileSync(file.absPath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n').map(normalize);
      for (let start = 0; start + window <= lines.length; start += 1) {
        const slice = lines.slice(start, start + window);
        if (slice.some((line) => isStructuralLine(line))) continue;

        const key = slice.join('\n');
        const blocks = seen.get(key) ?? [];
        // Overlapping windows inside one file describe the same block once.
        const last = blocks[blocks.length - 1];
        if (last && last.file === file.path && start + 1 - last.line < window) continue;
        blocks.push({ file: file.path, line: start + 1 });
        seen.set(key, blocks);
      }
    }

    const findings: Finding[] = [];
    for (const [key, blocks] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (blocks.length < 2) continue;
      const first = blocks[0]!;

      const finding = createFinding(this, context, {
        file: first.file,
        line: first.line,
        title: `${window} identical lines repeated ${blocks.length} times`,
        message:
          `The same block appears in ${blocks.length} places. Duplicated logic drifts apart: a fix ` +
          'applied in one copy silently leaves the others behind.',
        detail: blocks.slice(0, 5).map((block) => `${block.file}:${block.line}`),
        suggestion: 'Extract the block into a shared function and call it from each site.',
        key: [key.slice(0, 64), blocks.length],
        current: blocks.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const unresolvedImport: Rule = {
  id: 'maintainability/unresolved-import',
  category: 'maintainability',
  description: 'Imports that point at neither a project file nor a known package.',
  run(context) {
    const byFile = new Map<string, { specifier: string; line: number }[]>();
    for (const entry of context.graph.unresolved) {
      const list = byFile.get(entry.file) ?? [];
      list.push({ specifier: entry.specifier, line: entry.line });
      byFile.set(entry.file, list);
    }

    const findings: Finding[] = [];
    for (const [file, entries] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const finding = createFinding(this, context, {
        file,
        line: entries[0]!.line,
        title: `${entries.length} import${entries.length === 1 ? '' : 's'} could not be resolved`,
        message:
          `Little Owl could not match ${entries.length} import${entries.length === 1 ? '' : 's'} in ${file} ` +
          'to a file in the project or to a declared dependency.',
        detail: entries.slice(0, 5).map((entry) => `${entry.specifier} (line ${entry.line})`),
        suggestion:
          'Usually a path alias Little Owl does not know about — add it to tsconfig paths, or to ' +
          'the ignore list if the import is intentional.',
        key: entries.map((entry) => entry.specifier),
        current: entries.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

export const maintainabilityRules: Rule[] = [duplicateBlock, unresolvedImport];
