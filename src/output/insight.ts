import { colors, dim, icons } from './theme.js';
import { countLabel, heading, rule, wrap } from './ui.js';
import type { DeadCodeReport, Confidence } from '../review/dead-code.js';
import type { TestGapReport } from '../review/test-gap.js';
import type { ArchaeologyReport } from '../review/archaeology.js';
import type { ProjectMap } from '../review/map.js';
import { routeLabel } from '../review/impact.js';

/**
 * Renderers for the exploratory commands: dead code, test gaps, archaeology and
 * the project map.
 *
 * All four deal in evidence of varying strength, so each one states how much to
 * trust what it is showing rather than presenting everything as fact.
 */

const CONFIDENCE_PAINT: Record<Confidence, (text: string) => string> = {
  high: colors.green,
  medium: colors.yellow,
  low: dim,
};

export function renderDeadCode(report: DeadCodeReport): string {
  const lines: string[] = [heading('DEAD CODE'), ''];

  if (report.candidates.length === 0) {
    lines.push(colors.green(`${icons.ok} Every analysed file is reachable from somewhere.`));
    if (report.entryPoints.length > 0) {
      lines.push(
        '',
        dim(
          `${countLabel(report.entryPoints.length, 'file')} treated as entry points by framework convention.`,
        ),
      );
    }
    return lines.join('\n');
  }

  lines.push(
    `${countLabel(report.candidates.length, 'candidate')} — nothing in the project imports them.`,
    '',
  );

  for (const level of ['high', 'medium', 'low'] as const) {
    const group = report.candidates.filter((candidate) => candidate.confidence === level);
    if (group.length === 0) continue;

    const paint = CONFIDENCE_PAINT[level];
    lines.push(paint(`${level.toUpperCase()} CONFIDENCE  ${dim(`(${group.length})`)}`), '');

    for (const candidate of group.slice(0, 15)) {
      lines.push(`  ${colors.bold(candidate.path)} ${dim(`${candidate.lines} lines`)}`);
      for (const reason of candidate.reasons) lines.push(dim(`    ${icons.ok} ${reason}`));
      for (const caveat of candidate.caveats) lines.push(dim(`    ${icons.warn} but ${caveat}`));
      lines.push('');
    }
    if (group.length > 15) lines.push(dim(`  ... and ${group.length - 15} more`), '');
  }

  lines.push(rule(), '');
  lines.push(
    ...wrap(
      'Reachability is static. Framework conventions, dynamic imports and configuration can all ' +
        'keep a file alive without an import statement, so check before deleting anything.',
    ).map((line) => dim(line)),
  );

  if (report.hasUnresolvedDynamicImports) {
    lines.push(
      '',
      colors.yellow(
        `${icons.warn} This project uses dynamic imports Little Owl could not resolve, so confidence is capped.`,
      ),
    );
  }

  return lines.join('\n');
}

export function renderTestGaps(report: TestGapReport): string {
  const lines: string[] = [heading('TEST GAPS'), ''];

  if (report.hasNoTests) {
    lines.push(colors.yellow(`${icons.warn} No test files found in this project.`), '');
    lines.push(
      ...wrap('Little Owl looks for files matching common test naming conventions.').map(dim),
    );
    return lines.join('\n');
  }

  lines.push(
    dim(
      `${countLabel(report.testFileCount, 'test file')} reaching ` +
        `${countLabel(report.reachedCount, 'module')}`,
    ),
    '',
  );

  if (report.gaps.length === 0) {
    lines.push(colors.green(`${icons.ok} Every module with logic is reached by a test.`));
    return lines.join('\n');
  }

  const uncovered = report.gaps.filter((gap) => gap.coverage === 'none');
  const partial = report.gaps.filter((gap) => gap.coverage === 'partial');

  if (uncovered.length > 0) {
    lines.push(
      colors.red(`${icons.error} NO TEST REACHES THESE  ${dim(`(${uncovered.length})`)}`),
      '',
    );
    for (const gap of uncovered.slice(0, 12)) {
      lines.push(`  ${colors.bold(gap.file)}`);
      lines.push(dim(`    ${gap.reason}`));
      if (gap.untestedExports.length > 0) {
        lines.push(dim(`    exports: ${gap.untestedExports.slice(0, 6).join(', ')}`));
      }
      lines.push('');
    }
    if (uncovered.length > 12) lines.push(dim(`  ... and ${uncovered.length - 12} more`), '');
  }

  if (partial.length > 0) {
    lines.push(
      colors.yellow(
        `${icons.warn} REACHED, BUT SOME BEHAVIOUR LOOKS UNTESTED  ${dim(`(${partial.length})`)}`,
      ),
      '',
    );
    for (const gap of partial.slice(0, 8)) {
      lines.push(`  ${colors.bold(gap.file)}`);
      lines.push(dim(`    tested by: ${gap.reachedBy.slice(0, 3).join(', ')}`));
      for (const name of gap.untestedExports.slice(0, 5)) {
        lines.push(`    ${colors.red(icons.error)} ${name}()`);
      }
      lines.push('');
    }
    if (partial.length > 8) lines.push(dim(`  ... and ${partial.length - 8} more`), '');
  }

  lines.push(rule(), '');
  lines.push(
    ...wrap(
      'This is a risk signal, not a coverage report. Little Owl follows imports and names; it does ' +
        'not run your tests, so a module listed as untested may still be exercised indirectly.',
    ).map(dim),
  );

  return lines.join('\n');
}

export function renderArchaeology(report: ArchaeologyReport): string {
  const lines: string[] = [heading('CODE ARCHAEOLOGY'), '', colors.bold(report.file), ''];

  if (!report.exists) {
    lines.push(colors.yellow(`${icons.warn} This file is not part of the analysed source set.`));
    return lines.join('\n');
  }

  const evidenceLabel = {
    strong: colors.green('strong'),
    partial: colors.yellow('partial'),
    none: colors.red('none'),
  }[report.evidence];
  lines.push(dim(`Evidence: ${evidenceLabel}`), '');

  for (const line of report.assessment) {
    lines.push(...wrap(line, 74));
  }

  if (report.rationale.length > 0) {
    lines.push('', colors.bold('Commits that explain why'), '');
    for (const entry of report.rationale) lines.push(`  ${icons.bullet} ${entry}`);
  }

  if (report.authors.length > 0) {
    lines.push('', colors.bold('Maintained by'), '');
    for (const author of report.authors) {
      lines.push(`  ${author.name} ${dim(`(${countLabel(author.commits, 'commit')})`)}`);
    }
  }

  if (report.consumers.length > 0) {
    lines.push('', colors.bold('Used by'), '');
    for (const consumer of report.consumers.slice(0, 10)) lines.push(`  ${consumer}`);
    if (report.consumers.length > 10) {
      lines.push(dim(`  ... and ${report.consumers.length - 10} more`));
    }
  }

  if (report.tests.length > 0) {
    lines.push('', colors.bold('Tested by'), '');
    for (const test of report.tests.slice(0, 5)) lines.push(`  ${test}`);
  }

  if (report.coChanged.length > 0) {
    lines.push('', colors.bold('Usually changes alongside'), '');
    for (const entry of report.coChanged) {
      lines.push(`  ${entry.path} ${dim(`(${countLabel(entry.times, 'shared commit')})`)}`);
    }
  }

  if (report.recommendation) {
    lines.push('', rule(), '', ...wrap(`${icons.arrow} ${report.recommendation}`, 74));
  }

  if (report.evidence !== 'strong') {
    lines.push(
      '',
      ...wrap(
        'Little Owl only reports what the repository records. Where the history is silent it says ' +
          'so rather than guessing at a reason.',
      ).map(dim),
    );
  }

  return lines.join('\n');
}

export function renderProjectMap(map: ProjectMap): string {
  const lines: string[] = [heading('PROJECT MAP'), ''];

  lines.push(
    dim(
      `${countLabel(map.totals.files, 'file')}, ${map.totals.lines.toLocaleString()} lines, ` +
        `${map.totals.edges} internal imports`,
    ),
    '',
  );

  if (map.startHere.length > 0) {
    lines.push(colors.bold('START HERE'), '');
    map.startHere.forEach((area, index) => lines.push(`  ${index + 1}. ${area}`));
    lines.push('');
  }

  if (map.layers.length >= 2) {
    lines.push(colors.bold('Layers'), '');
    map.layers.forEach((layer, index) => {
      lines.push(`  ${layer}`);
      if (index < map.layers.length - 1) lines.push(dim('   ↓'));
    });
    lines.push('');
  }

  if (map.areas.length > 0) {
    lines.push(colors.bold('Areas'), '');
    for (const area of map.areas.slice(0, 12)) {
      const size = dim(`${countLabel(area.files, 'file')}, ${area.lines.toLocaleString()} lines`);
      const coupling = area.incoming > 0 ? dim(`  ←${area.incoming}`) : '';
      lines.push(`  ${area.path.padEnd(28)} ${size}${coupling}`);
    }
    if (map.areas.length > 12) lines.push(dim(`  ... and ${map.areas.length - 12} more`));
    lines.push('');
  }

  if (map.entryPoints.length > 0) {
    lines.push(colors.bold('Entry points'), '');
    for (const entry of map.entryPoints.slice(0, 10)) {
      const label = /\/(page|route|layout)\./.test(entry) ? dim(`  ${routeLabel(entry)}`) : '';
      lines.push(`  ${entry}${label}`);
    }
    if (map.entryPoints.length > 10) {
      lines.push(dim(`  ... and ${map.entryPoints.length - 10} more`));
    }
    lines.push('');
  }

  if (map.central.length > 0) {
    lines.push(colors.bold('Most depended on'), '');
    for (const module of map.central.slice(0, 8)) {
      lines.push(`  ${module.path.padEnd(40)} ${dim(countLabel(module.dependents, 'dependent'))}`);
    }
    lines.push('');
  }

  if (map.external.length > 0) {
    lines.push(colors.bold('External services'), '');
    for (const service of map.external) {
      lines.push(`  ${icons.bullet} ${service.name} ${dim(`(${service.packages.join(', ')})`)}`);
    }
    lines.push('');
  }

  lines.push(dim('Areas are inferred from the directory structure, not from configuration.'));
  return lines.join('\n');
}
