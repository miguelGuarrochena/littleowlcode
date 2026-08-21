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

/** One duplicated region: the same lines, at these places, this many lines long. */
interface Region {
  files: string[];
  /** Start line per file, in the same order as `files`. */
  lines: number[];
  /** How many lines the region covers. */
  span: number;
}

/**
 * Collapses the sliding windows back into whole regions.
 *
 * The scan reports every N-line window, so a thirty-line copy-paste arrives as
 * two dozen overlapping matches. Consecutive windows that repeat in the same
 * files at the same relative offsets are one region, and reporting it once —
 * with its real length — is both shorter and more accurate.
 */
function mergeRegions(regions: Region[], window: number): Region[] {
  const byPlacement = new Map<string, Region[]>();

  for (const region of regions) {
    // Regions only merge when they repeat across the same files with the same
    // spacing between the copies.
    const offsets = region.lines.map((line) => line - region.lines[0]!).join(',');
    const key = `${region.files.join('|')}#${offsets}`;
    const list = byPlacement.get(key) ?? [];
    list.push(region);
    byPlacement.set(key, list);
  }

  const merged: Region[] = [];

  for (const list of byPlacement.values()) {
    list.sort((a, b) => a.lines[0]! - b.lines[0]!);
    let current: Region | null = null;

    for (const region of list) {
      if (current && region.lines[0]! <= current.lines[0]! + current.span) {
        current.span = Math.max(current.span, region.lines[0]! + window - current.lines[0]!);
        continue;
      }
      current = { ...region, lines: [...region.lines] };
      merged.push(current);
    }
  }

  return merged.sort(
    (a, b) => b.span - a.span || (a.files[0]! < b.files[0]! ? -1 : 1) || a.lines[0]! - b.lines[0]!,
  );
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

    const regions: Region[] = [];
    for (const blocks of seen.values()) {
      if (blocks.length < 2) continue;
      regions.push({
        files: blocks.map((block) => block.file),
        lines: blocks.map((block) => block.line),
        span: window,
      });
    }

    const findings: Finding[] = [];

    for (const region of mergeRegions(regions, window)) {
      const places = region.files.map((file, index) => `${file}:${region.lines[index]}`);
      const copies = region.files.length;

      const finding = createFinding(this, context, {
        file: region.files[0]!,
        line: region.lines[0]!,
        title: `${region.span} identical lines repeated ${copies} times`,
        message:
          `The same ${region.span}-line block appears in ${copies} places. Duplicated logic drifts ` +
          'apart: a fix applied in one copy silently leaves the others behind.',
        detail: places.slice(0, 5),
        suggestion: 'Extract the block into a shared function and call it from each site.',
        key: [...places, region.span],
        current: copies,
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
