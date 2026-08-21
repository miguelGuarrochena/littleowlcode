import { describe, expect, it } from 'vitest';
import { analyzeFixture, findingsFor } from './helpers.js';
import { TempProject } from './temp-project.js';

describe('project analysis', () => {
  it('parses a clean project and reports no architecture problems', async () => {
    const { result, context } = await analyzeFixture('clean-project');

    expect(context.files.map((file) => file.path).sort()).toEqual([
      'app/page.tsx',
      'lib/db/client.ts',
      'services/orders.ts',
    ]);
    expect(context.cycles).toHaveLength(0);
    expect(findingsFor(result.findings, 'architecture/layer-violation')).toHaveLength(0);
    expect(result.metrics.architecture).toBe(100);
  });

  it('resolves relative imports into graph edges', async () => {
    const { context } = await analyzeFixture('clean-project');

    expect(context.graph.dependenciesOf('app/page.tsx')).toEqual(['services/orders.ts']);
    expect(context.graph.dependentsOf('lib/db/client.ts')).toEqual(['services/orders.ts']);
  });

  it('detects the project stack', async () => {
    const { result } = await analyzeFixture('clean-project');

    expect(result.project.name).toBe('clean-project');
    expect(result.project.frameworks).toContain('React');
    expect(result.project.languages).toContain('typescript');
  });

  it('finds circular dependencies and names the whole loop', async () => {
    const { result, context } = await analyzeFixture('circular-dependencies');

    expect(context.cycles).toHaveLength(1);
    expect(context.cycles[0]!.files.sort()).toEqual([
      'src/auth.ts',
      'src/orders.ts',
      'src/users.ts',
    ]);

    const findings = findingsFor(result.findings, 'architecture/circular-dependency');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.detail?.[0]).toMatch(/->/);
  });

  it('reports an inverted layer dependency and a skipped layer', async () => {
    const { result } = await analyzeFixture('bad-architecture');

    const skips = findingsFor(result.findings, 'architecture/layer-skip');
    expect(skips.map((finding) => finding.file)).toContain('components/Orders.tsx');

    const inverted = findingsFor(result.findings, 'architecture/layer-violation');
    expect(inverted.map((finding) => finding.file)).toContain('lib/db/client.ts');
  });

  it('produces identical results across runs', async () => {
    const first = await analyzeFixture('bad-architecture');
    const second = await analyzeFixture('bad-architecture');

    expect(second.result.findings.map((finding) => finding.fingerprint)).toEqual(
      first.result.findings.map((finding) => finding.fingerprint),
    );
    expect(second.result.metrics).toEqual(first.result.metrics);
  });
});

describe('python analysis', () => {
  it('reads imports, functions and smells', async () => {
    const { result, context } = await analyzeFixture('python-project');

    const routes = context.fileMap.get('api/routes.py');
    expect(routes?.imports.map((reference) => reference.raw)).toContain('services.orders');
    expect(context.graph.dependenciesOf('api/routes.py')).toContain('services/orders.py');

    expect(findingsFor(result.findings, 'python/bare-except')).toHaveLength(1);
    expect(findingsFor(result.findings, 'python/mutable-default')).toHaveLength(1);
    expect(findingsFor(result.findings, 'python/global-state')).toHaveLength(1);
  });
});

describe('go analysis', () => {
  it('resolves module-relative imports to package files', async () => {
    const { result, context } = await analyzeFixture('go-project');

    expect(context.graph.dependenciesOf('cmd/main.go')).toEqual(['internal/store/store.go']);
    expect(findingsFor(result.findings, 'go/ignored-error')).toHaveLength(1);
  });
});

/**
 * `package/__init__.py` importing a submodule that imports the package back is
 * how Python packages are normally written — it works because imports resolve
 * lazily. Reporting it flagged seven "errors" in pip alone, all of them
 * idiomatic.
 */
describe('python package cycles', () => {
  it('ignores a package re-exporting its own submodule', async () => {
    const project = TempProject.create({
      'requirements.txt': 'flask\n',
      'shop/__init__.py': 'from shop.orders import Order\n',
      'shop/orders.py': 'from shop import helper\n\n\nclass Order:\n    pass\n',
      'shop/helper.py': 'def helper():\n    return 1\n',
      'main.py': 'from shop import Order\n\nprint(Order)\n',
    });
    try {
      const { result } = await project.analyze();
      expect(findingsFor(result.findings, 'architecture/circular-dependency')).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it('still reports a real cycle between sibling modules', async () => {
    const project = TempProject.create({
      'requirements.txt': 'flask\n',
      'shop/orders.py': 'from shop.billing import charge\n\n\ndef place():\n    return charge()\n',
      'shop/billing.py': 'from shop.orders import place\n\n\ndef charge():\n    return place\n',
      'main.py': 'from shop.orders import place\n\nprint(place)\n',
    });
    try {
      const { result } = await project.analyze();
      expect(findingsFor(result.findings, 'architecture/circular-dependency')).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });

  it('still reports a cycle that only passes through a package boundary', async () => {
    // `__init__.py` is in the loop, but so is a module from another package —
    // that is not the lazy-import pattern.
    const project = TempProject.create({
      'requirements.txt': 'flask\n',
      'shop/__init__.py': 'from billing.core import charge\n',
      'billing/__init__.py': '\n',
      'billing/core.py': 'import shop\n\n\ndef charge():\n    return shop\n',
      'main.py': 'import shop\n\nprint(shop)\n',
    });
    try {
      const { result } = await project.analyze();
      expect(
        findingsFor(result.findings, 'architecture/circular-dependency').length,
      ).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });
});
