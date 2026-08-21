import type { Finding, Marker } from '../core/types.js';
import { createFinding, type Rule } from '../core/context.js';
import { dirOf } from '../utils/paths.js';

function groupMarkers(kind: Marker['kind']) {
  return (markers: Marker[]): Marker[] => markers.filter((marker) => marker.kind === kind);
}

const bareExcept: Rule = {
  id: 'python/bare-except',
  category: 'maintainability',
  description: 'Python `except:` blocks that swallow every exception.',
  run(context) {
    const pick = groupMarkers('bare-except');
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'python' || file.isTest) continue;
      for (const marker of pick(file.markers)) {
        const finding = createFinding(this, context, {
          file: file.path,
          line: marker.line,
          title: 'Bare `except:` catches everything',
          message:
            `${file.path}:${marker.line} catches every exception, including KeyboardInterrupt and ` +
            'SystemExit. Real failures end up hidden behind a generic handler.',
          suggestion: 'Catch the specific exception types this block knows how to handle.',
          key: [marker.line],
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const mutableDefault: Rule = {
  id: 'python/mutable-default',
  category: 'maintainability',
  description: 'Python default arguments that are mutable and shared between calls.',
  run(context) {
    const pick = groupMarkers('mutable-default');
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'python') continue;
      for (const marker of pick(file.markers)) {
        const finding = createFinding(this, context, {
          file: file.path,
          line: marker.line,
          title: 'Mutable default argument',
          message:
            `${file.path}:${marker.line} uses a mutable default. Python evaluates defaults once, so ` +
            'every call shares the same object and changes leak between calls.',
          suggestion: 'Default to `None` and build the value inside the function.',
          key: [marker.line],
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const globalState: Rule = {
  id: 'python/global-state',
  category: 'maintainability',
  description: 'Python functions writing to module-level globals.',
  run(context) {
    const pick = groupMarkers('global-state');
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'python' || file.isTest) continue;
      const markers = pick(file.markers);
      if (markers.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        line: markers[0]!.line,
        title: `${markers.length} \`global\` statement${markers.length === 1 ? '' : 's'}`,
        message:
          `${file.path} rebinds module-level state from inside functions. Shared mutable state makes ` +
          'behaviour depend on call order and breaks under concurrency.',
        detail: [
          `lines: ${markers
            .slice(0, 8)
            .map((marker) => marker.line)
            .join(', ')}`,
        ],
        suggestion: 'Pass the value in and return the new one, or hold the state in a class.',
        current: markers.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const ignoredError: Rule = {
  id: 'go/ignored-error',
  category: 'maintainability',
  description: 'Go return values discarded with `_`.',
  run(context) {
    const pick = groupMarkers('ignored-error');
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'go' || file.isTest) continue;
      const markers = pick(file.markers);
      if (markers.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        line: markers[0]!.line,
        title: `${markers.length} discarded return value${markers.length === 1 ? '' : 's'}`,
        message:
          `${file.path} throws away a call's return value with \`_\` ${markers.length} time${markers.length === 1 ? '' : 's'}. ` +
          'In Go that is usually an error being dropped.',
        detail: markers
          .slice(0, 5)
          .map((marker) => `line ${marker.line}: ${marker.text ?? ''}`.trim()),
        suggestion: 'Handle the error, or add a short comment explaining why ignoring it is safe.',
        current: markers.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const largePackage: Rule = {
  id: 'go/large-package',
  category: 'complexity',
  description: 'Go packages that have grown far past the file budget.',
  run(context) {
    const byDirectory = new Map<string, { files: string[]; lines: number }>();

    for (const file of context.files) {
      if (file.language !== 'go' || file.isTest) continue;
      const directory = dirOf(file.path) || '.';
      const entry = byDirectory.get(directory) ?? { files: [], lines: 0 };
      entry.files.push(file.path);
      entry.lines += file.lines;
      byDirectory.set(directory, entry);
    }

    const limit = context.config.thresholds.maxFileLines * 5;
    const findings: Finding[] = [];

    for (const [directory, entry] of [...byDirectory.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (entry.lines <= limit) continue;

      const finding = createFinding(this, context, {
        file: entry.files[0]!,
        title: `Package ${directory} is ${entry.lines.toLocaleString()} lines`,
        message:
          `The ${directory} package spans ${entry.files.length} files and ${entry.lines.toLocaleString()} lines ` +
          `(budget ${limit.toLocaleString()}). Packages this size usually cover several concerns.`,
        suggestion: 'Split the package along its clearest responsibility boundary.',
        key: [directory],
        baseline: limit,
        current: entry.lines,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

export const languageRules: Rule[] = [
  bareExcept,
  mutableDefault,
  globalState,
  ignoredError,
  largePackage,
];
