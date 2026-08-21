import { describe, expect, it } from 'vitest';
import { attributeFindings, createRunQueue } from '../src/cli/watch-runtime.js';
import { DependencyGraph } from '../src/graph/dependency-graph.js';
import type { Finding } from '../src/core/types.js';

function finding(id: string, file?: string): Finding {
  return {
    id,
    fingerprint: `${id}:${file ?? ''}`,
    severity: 'warning',
    category: 'maintainability',
    ...(file === undefined ? {} : { file }),
    title: `finding in ${file ?? 'the project'}`,
    message: 'message',
  };
}

function graphOf(edges: Array<[string, string]>): DependencyGraph {
  const graph = new DependencyGraph();
  for (const [from, to] of edges) graph.addEdge({ from, to, line: 1, typeOnly: false });
  return graph;
}

/** Waits for a condition without pinning the test to an exact schedule. */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('watch finding attribution', () => {
  /**
   * Watch mode used to print the file that was just saved as a heading and
   * then list every finding that was new since the baseline underneath it, so
   * an untouched file's problem was presented as if the last keystroke had
   * caused it.
   */
  it('does not blame the changed file for a finding somewhere else', () => {
    const graph = graphOf([['src/utils/paths.ts', 'src/utils/format.ts']]);
    const unrelated = finding('type-safety/explicit-any', 'src/utils/paths.ts');

    const attributed = attributeFindings(['src/utils/hash.ts'], [unrelated], graph);

    expect(attributed.inChange).toEqual([]);
    expect(attributed.inAffected).toEqual([]);
    expect(attributed.elsewhere).toEqual([unrelated]);
  });

  it('keeps findings in the changed files separate from the rest', () => {
    const graph = graphOf([['src/a.ts', 'src/b.ts']]);
    const mine = finding('complexity/large-file', 'src/a.ts');
    const theirs = finding('complexity/large-file', 'src/z.ts');

    const attributed = attributeFindings(['src/a.ts'], [mine, theirs], graph);

    expect(attributed.inChange).toEqual([mine]);
    expect(attributed.elsewhere).toEqual([theirs]);
  });

  it('counts a finding in a file that imports the change as affected', () => {
    // page imports service imports helper. Editing the helper can plausibly
    // explain a new finding in either of its importers.
    const graph = graphOf([
      ['src/app/page.ts', 'src/services/orders.ts'],
      ['src/services/orders.ts', 'src/lib/helper.ts'],
    ]);

    const direct = finding('complexity/high-complexity', 'src/services/orders.ts');
    const indirect = finding('complexity/high-complexity', 'src/app/page.ts');

    const attributed = attributeFindings(['src/lib/helper.ts'], [direct, indirect], graph);

    expect(attributed.inChange).toEqual([]);
    expect(attributed.inAffected).toEqual([direct, indirect]);
    expect(attributed.affectedFiles).toEqual(['src/app/page.ts', 'src/services/orders.ts']);
  });

  it('does not treat a file the change imports as affected by it', () => {
    // orders imports helper. Changing orders cannot have caused a finding
    // inside helper.
    const graph = graphOf([['src/services/orders.ts', 'src/lib/helper.ts']]);
    const downstream = finding('complexity/large-file', 'src/lib/helper.ts');

    const attributed = attributeFindings(['src/services/orders.ts'], [downstream], graph);

    expect(attributed.inAffected).toEqual([]);
    expect(attributed.elsewhere).toEqual([downstream]);
  });

  it('treats a project-wide finding with no file as global', () => {
    const global = finding('dependencies/unused-dependency');
    const attributed = attributeFindings(['src/a.ts'], [global], graphOf([]));

    expect(attributed.elsewhere).toEqual([global]);
  });
});

describe('watch scheduling', () => {
  it('batches changes inside the debounce window', async () => {
    const runs: string[][] = [];
    const queue = createRunQueue(20, async (files) => {
      runs.push(files);
    });

    queue.add('b.ts');
    queue.add('a.ts');

    await until(() => runs.length === 1);
    expect(runs[0]).toEqual(['a.ts', 'b.ts']);
  });

  /**
   * The scheduler used to return early while an analysis was in flight, which
   * threw away every edit made during it — the edits a developer is most
   * likely to care about, since they were typing while the tool was busy.
   */
  it('does not lose a change that arrives while an analysis is running', async () => {
    const runs: string[][] = [];
    let releaseFirstRun = (): void => {};
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });

    const queue = createRunQueue(10, async (files) => {
      runs.push(files);
      if (runs.length === 1) await firstRunGate;
    });

    queue.add('first.ts');
    await until(() => runs.length === 1);

    // Saved while the first analysis is still running.
    queue.add('during.ts');
    expect(queue.pending()).toEqual(['during.ts']);

    releaseFirstRun();
    await until(() => runs.length === 2);

    expect(runs[0]).toEqual(['first.ts']);
    expect(runs[1]).toEqual(['during.ts']);
    expect(queue.pending()).toEqual([]);
  });

  it('collects several changes made during one run into the next', async () => {
    const runs: string[][] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = createRunQueue(10, async (files) => {
      runs.push(files);
      if (runs.length === 1) await gate;
    });

    queue.add('first.ts');
    await until(() => runs.length === 1);

    queue.add('second.ts');
    queue.add('third.ts');
    release();

    await until(() => runs.length === 2);
    expect(runs[1]).toEqual(['second.ts', 'third.ts']);
  });

  it('keeps a failing analysis from wedging the queue', async () => {
    const runs: string[][] = [];
    const errors: unknown[] = [];
    const queue = createRunQueue(
      10,
      async (files) => {
        runs.push(files);
        if (runs.length === 1) throw new Error('analysis blew up');
      },
      // A failing run is reported here rather than escaping as an unhandled
      // rejection: the timer that started it has nobody to hand it to.
      (error) => errors.push(error),
    );

    queue.add('first.ts');
    await until(() => runs.length === 1);

    queue.add('second.ts');
    await until(() => runs.length === 2);
    expect(runs[1]).toEqual(['second.ts']);
    expect((errors[0] as Error).message).toBe('analysis blew up');
  });

  it('runs nothing after stop', async () => {
    const runs: string[][] = [];
    const queue = createRunQueue(20, async (files) => {
      runs.push(files);
    });

    queue.add('a.ts');
    queue.stop();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(runs).toEqual([]);
  });
});
