import type { Finding } from '../core/types.js';
import { createFinding, type AnalysisContext, type Rule } from '../core/context.js';
import { classifyLayerDependency, featureOf, layerOf } from '../architecture/layers.js';
import { compilePattern, matchesCompiled } from '../utils/glob.js';

const circularDependency: Rule = {
  id: 'architecture/circular-dependency',
  category: 'architecture',
  description: 'Files that import each other, directly or through a chain.',
  run(context) {
    const findings: Finding[] = [];

    for (const cycle of context.cycles) {
      const [entry] = cycle.files;
      if (!entry) continue;
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

function layerFindings(
  context: AnalysisContext,
  rule: Pick<Rule, 'id' | 'category'>,
  wanted: 'inverted' | 'skip',
): Finding[] {
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
}

function nextLayer(layer: string, order: string[]): string {
  const index = order.indexOf(layer);
  return order[index + 1] ?? 'the next layer';
}

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
      from: compilePattern(from),
      to: compilePattern(to),
      source: `${from} -> ${to}`,
    }));
    const findings: Finding[] = [];

    for (const edge of context.graph.edges) {
      for (const rule of compiled) {
        if (!matchesCompiled(edge.from, [rule.from])) continue;
        if (!matchesCompiled(edge.to, [rule.to])) continue;

        const finding = createFinding(this, context, {
          file: edge.from,
          line: edge.line,
          title: 'Forbidden dependency',
          message: `${edge.from} imports ${edge.to}, which your configuration forbids (${rule.source}).`,
          suggestion: 'Remove the import, or relax the rule in .little-owl/config.ts if it no longer applies.',
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

export const architectureRules: Rule[] = [
  circularDependency,
  layerViolation,
  layerSkip,
  crossFeatureImport,
  forbiddenDependency,
  deepImportChain,
];
