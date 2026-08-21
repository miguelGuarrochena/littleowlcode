import type { Finding, ParsedFile } from '../core/types.js';
import { createFinding, type AnalysisContext, type Rule } from '../core/context.js';
import { basename } from '../utils/paths.js';

/**
 * Patterns that show up when a codebase is edited in many small AI-assisted
 * passes: the same helper written three times, two modules that implement the
 * same concept in parallel, wrappers that only forward a call.
 *
 * None of these prove anything about *who* wrote the code, and Little Owl never
 * claims a pattern is "AI-generated" — it only reports the shape. The reason
 * they matter here is that each one is easy to introduce when the person making
 * the change cannot see the whole codebase at once.
 *
 * Only reliably detectable patterns live here. Things like "unnecessary
 * abstraction" are real problems but cannot be told apart from deliberate
 * design without understanding intent, so they are deliberately absent.
 */

/**
 * Names that are supposed to repeat across files: framework exports, route
 * handlers and conventional entry points.
 */
const CONVENTIONAL_NAMES = new Set([
  'default',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'handler',
  'middleware',
  'config',
  'metadata',
  'generateMetadata',
  'generateStaticParams',
  'loader',
  'action',
  'Page',
  'Layout',
  'Error',
  'Loading',
  'main',
  'run',
  'setup',
  'init',
  'render',
]);

/**
 * Names a file actually defines, as opposed to re-exports. A barrel file that
 * forwards `formatDate` is not a second implementation of it.
 */
const definedExports = (file: ParsedFile): string[] => {
  const exported = new Set(file.exports);
  return file.functions
    .filter((fn) => exported.has(fn.name))
    .map((fn) => fn.name)
    .filter((name) => !CONVENTIONAL_NAMES.has(name) && name.length >= 4);
};

interface SharedNameGroup {
  files: string[];
  names: string[];
  /** Set when the overlap looks deliberate, with the reason why. */
  intentional: string | null;
}

/**
 * Groups duplicated export names by the exact set of files that define them.
 *
 * Grouping first is what keeps the output honest. Two modules implementing the
 * same 140-function interface is *one* situation; reporting it 140 times would
 * bury everything else in the run.
 */
const sharedNameGroups = (context: AnalysisContext): SharedNameGroup[] => {
  const byName = new Map<string, string[]>();

  for (const file of context.files) {
    if (file.isTest) continue;
    for (const name of definedExports(file)) {
      const files = byName.get(name) ?? [];
      files.push(file.path);
      byName.set(name, files);
    }
  }

  const byFileSet = new Map<string, { files: string[]; names: string[] }>();
  for (const [name, files] of byName) {
    if (files.length < 2) continue;
    const sorted = [...files].sort();
    const key = sorted.join('|');
    const group = byFileSet.get(key) ?? { files: sorted, names: [] };
    group.names.push(name);
    byFileSet.set(key, group);
  }

  return [...byFileSet.values()]
    .map((group) => ({
      files: group.files,
      names: group.names.sort(),
      intentional: intentionalReason(context, group.files),
    }))
    .sort((a, b) => (a.files.join() < b.files.join() ? -1 : 1));
};

/**
 * Recognises overlaps that are a design, not an accident.
 *
 * The strategy/facade pattern — a demo implementation and a real one behind a
 * module that picks between them — deliberately gives both the same signatures.
 * Flagging it would be telling the developer their architecture is a mistake.
 */
const intentionalReason = (context: AnalysisContext, files: string[]): string | null => {
  for (const file of files) {
    const others = files.filter((other) => other !== file);
    const dependencies = context.graph.dependenciesOf(file);
    if (others.every((other) => dependencies.includes(other))) {
      return `${file} delegates to the others`;
    }
  }

  // A third module importing every one of them is choosing between them.
  for (const candidate of context.graph.nodes()) {
    if (files.includes(candidate)) continue;
    const dependencies = context.graph.dependenciesOf(candidate);
    if (files.every((file) => dependencies.includes(file))) {
      return `${candidate} selects between them`;
    }
  }

  return null;
};

/** Below this, an overlap reads as a repeated helper rather than a whole module. */
const PARALLEL_THRESHOLD = 3;

const duplicateHelper: Rule = {
  id: 'patterns/duplicate-helper',
  category: 'maintainability',
  description: 'The same helper name implemented in more than one file.',
  run(context) {
    const findings: Finding[] = [];

    for (const group of sharedNameGroups(context)) {
      // Large overlaps are a module-level situation, reported once by
      // `patterns/parallel-implementations` instead of once per name.
      if (group.names.length >= PARALLEL_THRESHOLD) continue;
      if (group.intentional) continue;

      for (const name of group.names) {
        const finding = createFinding(this, context, {
          file: group.files[0]!,
          title: `${name}() is implemented in ${group.files.length} places`,
          message:
            `${group.files.length} files each define and export their own \`${name}\`. When the same ` +
            'helper exists more than once, a fix applied to one copy silently leaves the others behind.',
          detail: group.files,
          suggestion:
            `Keep one implementation of \`${name}\` and import it, or give the variants names that ` +
            'say how they differ.',
          key: [name, ...group.files],
          current: group.files,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const parallelImplementations: Rule = {
  id: 'patterns/parallel-implementations',
  category: 'maintainability',
  description: 'Two modules that implement the same set of names.',
  run(context) {
    const findings: Finding[] = [];

    for (const group of sharedNameGroups(context)) {
      if (group.names.length < PARALLEL_THRESHOLD) continue;
      if (group.intentional) continue;

      const names = group.names;
      const finding = createFinding(this, context, {
        file: group.files[0]!,
        title: `${group.files.length} modules define the same ${names.length} names`,
        message:
          `${group.files.join(' and ')} each define ${names.slice(0, 4).join(', ')}` +
          `${names.length > 4 ? ' and others' : ''}. Nothing ties them together, so this is usually ` +
          'the same concept implemented more than once.',
        detail: names,
        suggestion:
          'Decide which one is the real implementation and have the others import it. If they are ' +
          'meant to be interchangeable, put a module in front that selects between them.',
        key: [...group.files, ...names],
        current: names,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const thinWrapper: Rule = {
  id: 'patterns/thin-wrapper',
  category: 'maintainability',
  description: 'A module whose only job is to forward a call to another module.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;

      // One export, one internal import, one trivial function: the module adds
      // a name and nothing else.
      const internalImports = file.imports.filter((reference) => reference.resolved);
      if (internalImports.length !== 1) continue;
      if (file.exports.length !== 1 || file.functions.length !== 1) continue;

      const fn = file.functions[0]!;
      if (fn.complexity > 1 || fn.lines > 3) continue;
      if (!file.exports.includes(fn.name)) continue;
      if (context.graph.dependentsOf(file.path).length === 0) continue;

      const target = internalImports[0]!.resolved!;

      const finding = createFinding(this, context, {
        file: file.path,
        line: fn.line,
        title: `${basename(file.path)} only forwards to ${basename(target)}`,
        message:
          `${file.path} exports a single ${fn.lines}-line function that calls into ${target} and does ` +
          'nothing else. Each layer like this is one more file to open before reaching the real code.',
        detail: [`${file.path} -> ${target}`],
        suggestion:
          'If the indirection is not buying anything, import the target directly and delete this module.',
        key: [target],
        current: target,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const abstractionGrowth: Rule = {
  id: 'patterns/abstraction-growth',
  category: 'architecture',
  description: 'A directory that has grown many small single-use modules.',
  run(context) {
    const byDirectory = new Map<string, ParsedFile[]>();

    for (const file of context.files) {
      if (file.isTest) continue;
      const directory = file.path.includes('/')
        ? file.path.slice(0, file.path.lastIndexOf('/'))
        : '.';
      const list = byDirectory.get(directory) ?? [];
      list.push(file);
      byDirectory.set(directory, list);
    }

    const findings: Finding[] = [];

    for (const [directory, files] of [...byDirectory.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (files.length < 8) continue;

      // "Small and used once" is the shape of an abstraction added for a single
      // caller. A few are normal; a directory full of them is a pattern.
      const singleUse = files.filter(
        (file) =>
          file.sloc <= 30 &&
          file.functions.length <= 2 &&
          context.graph.dependentsOf(file.path).length === 1,
      );

      if (singleUse.length < 5 || singleUse.length / files.length < 0.5) continue;

      const finding = createFinding(this, context, {
        file: singleUse[0]!.path,
        title: `${directory}/ holds ${singleUse.length} small modules each used once`,
        message:
          `${singleUse.length} of the ${files.length} files in ${directory}/ are under 30 lines and have ` +
          'exactly one caller. That is the shape a directory takes when abstractions are added one ' +
          'change at a time without anyone stepping back.',
        detail: singleUse.slice(0, 8).map((file) => file.path),
        suggestion:
          'Consider folding the single-use pieces back into their callers, or grouping them into ' +
          'one module with a clear purpose.',
        key: [directory, singleUse.length],
        current: singleUse.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

export const patternRules: Rule[] = [
  duplicateHelper,
  parallelImplementations,
  thinWrapper,
  abstractionGrowth,
];
