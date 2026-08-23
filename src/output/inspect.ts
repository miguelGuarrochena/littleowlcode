/**
 * Renderers for the inspection commands: `architecture`, `impact` and
 * `dependencies`.
 *
 * These answer "how is this project put together?" rather than "what did this
 * change do?", which is what `report.ts` is for. They were split out when the
 * combined file grew past the size Little Owl asks of everyone else.
 */
import type { AnalysisContext } from '../core/context.js';
import { colors, dim, icons } from './theme.js';
import { countLabel, heading, wrap } from './ui.js';
import {
  isImplicitlyUsed,
  undeclaredPackages,
  unusedDependencies,
} from '../detect/dependencies.js';
import {
  describeLayerChain,
  layerCoverage,
  layerOf,
  type LayerCoverage,
} from '../architecture/layers.js';
import { LAYER_COVERAGE_TARGET } from '../core/metrics.js';
import type { ImpactReport } from '../review/impact.js';
import { routeLabel } from '../review/impact.js';
import type { RenderOptions } from './report.js';

export const renderArchitecture = (
  context: AnalysisContext,
  options: RenderOptions = {},
): string => {
  const { layers, graph } = context;
  const sections: string[] = [heading('ARCHITECTURE'), ''];

  if (layers.order.length === 0) {
    sections.push(
      dim('No layered structure detected.'),
      '',
      ...wrap(
        'Little Owl looks for conventional directories such as app, components, services and ' +
          'repositories. Declare your own layers in .little-owl/config.ts to get boundary checks.',
      ),
    );
    return sections.join('\n');
  }

  sections.push(
    layers.inferred
      ? dim('Detected from the directory structure (not configured):')
      : dim('From your configuration:'),
    '',
  );

  layers.order.forEach((layer, index) => {
    const directories = (layers.dirsByLayer[layer] ?? []).join(', ');
    sections.push(`  ${colors.bold(layer)} ${dim(directories ? `(${directories})` : '')}`);
    if (index < layers.order.length - 1) sections.push(dim('   ↓'));
  });

  const fileCounts = new Map<string, number>();
  for (const file of context.files) {
    const layer = layerOf(file.path, layers);
    if (!layer) continue;
    fileCounts.set(layer, (fileCounts.get(layer) ?? 0) + 1);
  }

  sections.push(
    '',
    dim(
      `Policy: ${layers.policy === 'adjacent' ? 'a layer may only use the layer directly below it' : 'a layer may use any layer below it'}`,
    ),
  );
  sections.push(dim(`Chain:  ${describeLayerChain(layers)}`));
  sections.push('');

  const coverage = layerCoverage(context.files, layers);
  const violations = context.files.length > 0 ? architectureSummary(context, options) : [];

  if (violations.length === 0) {
    // "No violations" is a claim about the files the model reaches. Saying it
    // unqualified over a partial model is how an unexamined codebase gets a
    // clean bill of health.
    const partial = coverage.applicable && coverage.share < LAYER_COVERAGE_TARGET;
    sections.push(
      partial
        ? colors.yellow(
            `${icons.warn} No boundary violations among the ${Math.round(coverage.share * 100)}% of files inside a layer.`,
          )
        : colors.green(`${icons.ok} No boundary violations found.`),
    );
  } else {
    sections.push(colors.yellow(`${icons.warn} Boundary issues:`), '');
    sections.push(...violations.map((line) => `  ${line}`));
  }

  const coverageLines = renderLayerCoverage(coverage);
  if (coverageLines.length > 0) sections.push('', ...coverageLines);
  sections.push(
    '',
    dim(`${graph.edges.length} internal imports across ${graph.nodes().length} files`),
  );
  return sections.join('\n');
};

/** Coverage, plus the directories worth declaring next. */
const renderLayerCoverage = (coverage: LayerCoverage): string[] => {
  if (!coverage.applicable) return [];
  const percent = Math.round(coverage.share * 100);
  const label = `Coverage: ${coverage.layered} of ${coverage.total} source files are inside a layer (${percent}%)`;
  if (coverage.share >= LAYER_COVERAGE_TARGET || coverage.unplaced.length === 0) {
    return [dim(label)];
  }

  return [
    dim(label),
    '',
    dim('Not covered by any layer:'),
    ...coverage.unplaced
      .slice(0, 6)
      .map((entry) => dim(`  ${entry.directory.padEnd(28)} ${countLabel(entry.files, 'file')}`)),
    ...(coverage.unplaced.length > 6
      ? [dim(`  ... and ${coverage.unplaced.length - 6} more directories`)]
      : []),
    '',
    dim(`${icons.arrow} Declare these under \`architecture.layers\` to have them checked.`),
  ];
};

/** How many offending imports to name per layer pair before `--details`. */
const VIOLATIONS_SHOWN = 3;

/**
 * The broken layer pairs, each followed by the imports that break it.
 *
 * A count on its own ("ui → data (3 imports)") tells you a problem exists and
 * leaves you to go and find it. The files are the part you can act on.
 */
const architectureSummary = (context: AnalysisContext, options: RenderOptions = {}): string[] => {
  const pairs = new Map<string, string[]>();

  for (const edge of context.graph.edges) {
    if (edge.typeOnly) continue;
    const from = layerOf(edge.from, context.layers);
    const to = layerOf(edge.to, context.layers);
    if (!from || !to || from === to) continue;
    const fromIndex = context.layers.order.indexOf(from);
    const toIndex = context.layers.order.indexOf(to);
    if (fromIndex === -1 || toIndex === -1) continue;

    const isProblem =
      toIndex < fromIndex || (context.layers.policy === 'adjacent' && toIndex - fromIndex > 1);
    if (!isProblem) continue;

    const key = `${from} → ${to}`;
    const imports = pairs.get(key) ?? [];
    imports.push(`${edge.from}:${edge.line} → ${edge.to}`);
    pairs.set(key, imports);
  }

  const limit = options.details ? Number.POSITIVE_INFINITY : VIOLATIONS_SHOWN;

  return [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([pair, imports]) => [
      `${colors.red(icons.error)} ${pair}  ${dim(`(${countLabel(imports.length, 'import')})`)}`,
      ...imports.slice(0, limit).map((entry) => dim(`    ${entry}`)),
      ...(imports.length > limit
        ? [dim(`    ... and ${imports.length - limit} more — run with --details`)]
        : []),
      '',
    ])
    .slice(0, -1);
};

export const renderImpact = (report: ImpactReport): string => {
  const sections: string[] = [heading('CHANGE IMPACT'), ''];

  if (report.changed.length === 0) {
    sections.push(dim('No changed files to analyse.'));
    return sections.join('\n');
  }

  sections.push(colors.bold('Changed'), ...report.changed.slice(0, 10).map((file) => `  ${file}`));
  if (report.changed.length > 10) {
    sections.push(dim(`  ... and ${report.changed.length - 10} more`));
  }

  if (report.impacted.length === 0) {
    sections.push('', colors.green(`${icons.ok} Nothing else imports these files.`));
    return sections.join('\n');
  }

  sections.push('', colors.bold('Potentially affected'), '');
  for (const level of ['high', 'medium', 'low'] as const) {
    const entries = report.impacted.filter((entry) => entry.level === level);
    if (entries.length === 0) continue;
    const paint = level === 'high' ? colors.red : level === 'medium' ? colors.yellow : dim;
    sections.push(
      paint(`  ${level.toUpperCase()}  ${dim(`(${countLabel(entries.length, 'file')})`)}`),
    );
    sections.push(...entries.slice(0, 8).map((entry) => `    ${entry.path}`));
    if (entries.length > 8) sections.push(dim(`    ... and ${entries.length - 8} more`));
    sections.push('');
  }

  if (report.routes.length > 0) {
    sections.push(
      colors.bold('Routes'),
      ...report.routes.map((file) => `  ${routeLabel(file)} ${dim(file)}`),
      '',
    );
  }

  if (report.tests.length > 0) {
    sections.push(
      colors.bold('Tests that reach this change'),
      ...report.tests.slice(0, 10).map((file) => `  ${file}`),
      '',
    );
  }

  sections.push(
    dim('These files import the change directly or indirectly. That makes them worth testing —'),
    dim('it does not mean they are broken.'),
  );

  return sections.join('\n');
};

export const renderDependencies = (context: AnalysisContext): string => {
  const imported = context.graph.externalPackages();
  const packages = [...imported].sort();
  const declared = {
    ...context.project.dependencies,
    ...context.project.devDependencies,
  };
  const declaredNames = Object.keys(declared).sort();

  // Same helpers the `unused-dependency` rule uses, so the command and the
  // finding can never disagree about the same package.
  const undeclared = undeclaredPackages(packages, declared);
  const unused = unusedDependencies(declared, imported);
  const implicit = declaredNames.filter(
    (name) => !imported.has(name) && isImplicitlyUsed(name),
  ).length;

  const lines = [
    heading('DEPENDENCIES'),
    '',
    `${colors.bold(String(declaredNames.length))} declared   ${colors.bold(String(packages.length))} imported`,
    '',
  ];

  if (undeclared.length > 0) {
    lines.push(colors.yellow(`${icons.warn} Imported but not declared in package.json`), '');
    lines.push(...undeclared.slice(0, 15).map((name) => `  ${name}`), '');
  }

  if (unused.length > 0) {
    lines.push(
      dim(`${icons.info} Declared but never imported (may be used via config or at runtime)`),
      '',
    );
    lines.push(...unused.slice(0, 15).map((name) => dim(`  ${name}`)), '');
  }

  if (undeclared.length === 0 && unused.length === 0) {
    lines.push(colors.green(`${icons.ok} Declared and imported dependencies line up.`));
  }

  if (implicit > 0) {
    lines.push(
      '',
      dim(
        `${implicit} package${implicit === 1 ? '' : 's'} (type definitions, linters, build tooling) do their job`,
      ),
      dim('without being imported and are not counted above.'),
    );
  }

  lines.push(
    '',
    dim('Little Owl checks dependency hygiene, not security. For vulnerabilities run your'),
    dim('package manager audit command.'),
  );

  return lines.join('\n');
};
