import type { Finding, MetricStats } from '../core/types.js';
import { createFinding, isEnabled, type AnalysisContext, type Rule } from '../core/context.js';
import {
  classifyLayerDependency,
  featureOf,
  layerCoverage,
  layerOf,
  type LayerCoverage,
} from '../architecture/layers.js';
import { LAYER_COVERAGE_TARGET, uncheckedArchitecturePenalty } from '../core/metrics.js';
import { compileProjectPattern, matchesProjectPath } from '../utils/glob.js';

/**
 * A cycle that only exists because a package re-exports its own submodules.
 *
 * `package/__init__.py` importing `package/thing.py` which imports the package
 * back is the ordinary way Python packages are written, and it works because
 * imports resolve lazily at call time. Reporting it would flag almost every
 * published Python package.
 */
const isPackageInitCycle = (files: string[]): boolean => {
  const inits = files.filter((file) => file.endsWith('/__init__.py') || file === '__init__.py');
  if (inits.length === 0) return false;

  // Every other file in the loop must live under a package the loop passes
  // through, otherwise this is a real cycle that happens to include an
  // `__init__.py` along the way.
  const packages = inits.map((file) => file.slice(0, file.lastIndexOf('/') + 1));
  return files.every(
    (file) => inits.includes(file) || packages.some((directory) => file.startsWith(directory)),
  );
};

const circularDependency: Rule = {
  id: 'architecture/circular-dependency',
  category: 'architecture',
  description: 'Files that import each other, directly or through a chain.',
  run(context) {
    const findings: Finding[] = [];

    for (const cycle of context.cycles) {
      const [entry] = cycle.files;
      if (!entry) continue;
      if (isPackageInitCycle(cycle.files)) continue;
      const chain = [...cycle.files, cycle.files[0]!];

      const finding = createFinding(this, context, {
        file: entry,
        title: `Circular dependency across ${cycle.files.length} files`,
        message:
          'These files depend on each other in a loop. Cycles make modules impossible to load, ' +
          'test or reason about independently, and they tend to spread as more code is added.',
        detail: [chain.join(' -> ')],
        suggestion:
          'Move the shared pieces into a module that both sides can import, or invert one of the ' +
          'dependencies so the loop is broken.',
        key: [...cycle.files],
        current: cycle.files,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const layerViolation: Rule = {
  id: 'architecture/layer-violation',
  category: 'architecture',
  description: 'A lower layer importing a higher one (for example data importing UI).',
  run(context) {
    return layerFindings(context, this, 'inverted');
  },
};

const layerSkip: Rule = {
  id: 'architecture/layer-skip',
  category: 'architecture',
  description: 'A layer reaching past its neighbour, e.g. UI importing the database directly.',
  run(context) {
    return layerFindings(context, this, 'skip');
  },
};

const layerFindings = (
  context: AnalysisContext,
  rule: Pick<Rule, 'id' | 'category'>,
  wanted: 'inverted' | 'skip',
): Finding[] => {
  const { layers } = context;
  if (layers.order.length < 2) return [];

  const findings: Finding[] = [];

  for (const edge of context.graph.edges) {
    if (edge.typeOnly) continue;
    const source = context.fileMap.get(edge.from);
    if (source?.isTest) continue;

    const fromLayer = layerOf(edge.from, layers);
    const toLayer = layerOf(edge.to, layers);
    if (classifyLayerDependency(fromLayer, toLayer, layers) !== wanted) continue;

    const chain = layers.order.join(' -> ');
    const expected =
      wanted === 'skip'
        ? `${fromLayer} -> ${nextLayer(fromLayer!, layers.order)} -> ${toLayer}`
        : `${toLayer} -> ${fromLayer}`;

    const finding = createFinding(rule, context, {
      file: edge.from,
      line: edge.line,
      title:
        wanted === 'skip'
          ? `${fromLayer} imports ${toLayer} directly`
          : `${fromLayer} imports ${toLayer}, which sits above it`,
      message:
        wanted === 'skip'
          ? `${edge.from} imports ${edge.to}, skipping the ${nextLayer(fromLayer!, layers.order)} layer. ` +
            `The structure detected in this project is ${chain}.`
          : `${edge.from} imports ${edge.to}. In this project ${chain} flows downward, so this ` +
            'dependency points the wrong way.',
      detail: [`found:    ${fromLayer} -> ${toLayer}`, `expected: ${expected}`],
      suggestion:
        wanted === 'skip'
          ? `Route the call through ${nextLayer(fromLayer!, layers.order)} instead of importing ${toLayer} from here.`
          : `Invert the dependency so ${toLayer} calls into ${fromLayer}, or move the shared piece into a module both layers can import.`,
      key: [edge.to, edge.line],
      current: `${fromLayer} -> ${toLayer}`,
    });
    if (finding) findings.push(finding);
  }

  return findings;
};

const nextLayer = (layer: string, order: string[]): string => {
  const index = order.indexOf(layer);
  return order[index + 1] ?? 'the next layer';
};

const crossFeatureImport: Rule = {
  id: 'architecture/cross-feature-import',
  category: 'architecture',
  description: 'One feature reaching into the internals of another feature.',
  run(context) {
    if (!context.layers.featureRoot) return [];
    const findings: Finding[] = [];

    for (const edge of context.graph.edges) {
      if (edge.typeOnly) continue;
      const source = context.fileMap.get(edge.from);
      if (source?.isTest) continue;

      const fromFeature = featureOf(edge.from, context.layers);
      const toFeature = featureOf(edge.to, context.layers);
      if (!fromFeature || !toFeature || fromFeature === toFeature) continue;

      const finding = createFinding(this, context, {
        file: edge.from,
        line: edge.line,
        title: `Feature "${fromFeature}" imports from feature "${toFeature}"`,
        message:
          `${edge.from} imports ${edge.to}. Features in this project live side by side under ` +
          `${context.layers.featureRoot}/, which usually means they are meant to be independent.`,
        detail: [`${fromFeature} -> ${toFeature}`],
        suggestion:
          `Export what "${toFeature}" wants to share from its public entry point, or move the ` +
          'shared code somewhere both features can depend on.',
        key: [edge.to, edge.line],
        current: `${fromFeature} -> ${toFeature}`,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const forbiddenDependency: Rule = {
  id: 'architecture/forbidden-dependency',
  category: 'architecture',
  description: 'Dependencies explicitly forbidden in the project configuration.',
  run(context) {
    const rules = context.config.architecture.forbidden;
    if (rules.length === 0) return [];

    const compiled = rules.map(([from, to]) => ({
      from: compileProjectPattern(from),
      to: compileProjectPattern(to),
      source: `${from} -> ${to}`,
    }));
    const findings: Finding[] = [];

    for (const edge of context.graph.edges) {
      for (const rule of compiled) {
        if (!matchesProjectPath(edge.from, rule.from)) continue;
        if (!matchesProjectPath(edge.to, rule.to)) continue;

        const finding = createFinding(this, context, {
          file: edge.from,
          line: edge.line,
          title: 'Forbidden dependency',
          message: `${edge.from} imports ${edge.to}, which your configuration forbids (${rule.source}).`,
          suggestion:
            'Remove the import, or relax the rule in .little-owl/config.ts if it no longer applies.',
          key: [edge.to, rule.source],
          current: rule.source,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const deepImportChain: Rule = {
  id: 'architecture/deep-import-chain',
  category: 'architecture',
  description: 'Modules sitting at the bottom of a very long import chain.',
  run(context) {
    // Measuring depth means walking the whole graph. A rule that is switched
    // off should not pay for an answer nobody will read.
    if (!isEnabled(this.id, context.config)) return [];

    const limit = context.config.thresholds.maxImportDepth;
    const findings: Finding[] = [];

    // Entry points are files nothing imports; their chains show real depth.
    for (const file of context.graph.nodes()) {
      if (context.graph.dependentsOf(file).length > 0) continue;
      const depth = context.graph.maxDepthFrom(file);
      if (depth <= limit) continue;

      const finding = createFinding(this, context, {
        file,
        title: `Import chain ${depth} modules deep`,
        message:
          `Loading ${file} pulls in a chain ${depth} modules long (the configured limit is ${limit}). ` +
          'Long chains make it hard to see what a module really needs and slow down cold starts.',
        suggestion: 'Consider flattening the middle of the chain or splitting the entry point.',
        key: [depth],
        baseline: limit,
        current: depth,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

/**
 * Code the boundary rules cannot see.
 *
 * Every other architecture rule needs both ends of an import to belong to a
 * layer. When the model reaches only part of the tree the remaining files are
 * never checked, and "no boundary violations found" is a statement about the
 * part that was examined. This rule names the gap, and explains the points the
 * architecture score withholds for it.
 */
const unlayeredCode: Rule = {
  id: 'architecture/unlayered-code',
  category: 'architecture',
  description: 'Directories that no declared layer covers, so boundary rules never see them.',
  run(context) {
    const coverage = layerCoverage(context.files, context.layers);
    if (coverage.total === 0) return [];

    if (!coverage.applicable) {
      const finding = createFinding(this, context, {
        title: 'No layered structure to check',
        message:
          `Little Owl recognises ${context.layers.order.length === 1 ? 'only one layer' : 'no layers'} ` +
          'here, and a boundary needs two sides, so no boundary checks ran. The architecture score ' +
          'reflects cycles and import depth only.',
        detail: coverage.unplaced.slice(0, 6).map((entry) => `${entry.directory} (${entry.files})`),
        suggestion:
          'Declare your layers under `architecture.layers` in .little-owl/config.ts to turn boundary checks on.',
        key: ['none'],
        current: 0,
      });
      return finding ? [finding] : [];
    }

    if (coverage.share >= LAYER_COVERAGE_TARGET) return [];

    const percent = Math.round(coverage.share * 100);
    const withheld = Math.round(uncheckedArchitecturePenalty(statsShim(coverage)));
    const finding = createFinding(this, context, {
      title: `${coverage.total - coverage.layered} files sit outside every declared layer`,
      message:
        `Only ${percent}% of source files belong to a layer, so boundary rules never looked at the ` +
        `other ${100 - percent}%. The architecture score is ${withheld} point${withheld === 1 ? '' : 's'} ` +
        'lower than the violation count alone, for what could not be checked.',
      detail: coverage.unplaced
        .slice(0, 6)
        .map((entry) => `${entry.directory} — ${entry.files} file${entry.files === 1 ? '' : 's'}`),
      suggestion:
        'Add the directories above to `architecture.layers` in .little-owl/config.ts, or leave them out deliberately.',
      key: [percent],
      baseline: Math.round(LAYER_COVERAGE_TARGET * 100),
      current: percent,
    });
    return finding ? [finding] : [];
  },
};

/** The two fields `uncheckedArchitecturePenalty` reads, so the rule and the score agree. */
const statsShim = (coverage: LayerCoverage): MetricStats =>
  ({ files: coverage.total, layeredFiles: coverage.layered }) as MetricStats;

export const architectureRules: Rule[] = [
  circularDependency,
  layerViolation,
  layerSkip,
  crossFeatureImport,
  forbiddenDependency,
  deepImportChain,
  unlayeredCode,
];
