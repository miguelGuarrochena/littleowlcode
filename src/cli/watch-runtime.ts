import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { Finding } from '../core/types.js';

/**
 * The parts of watch mode that have to be right, kept away from the terminal
 * so they can be tested without a file system or a clock.
 */

export interface RunQueue {
  /** Records a changed file and (re)starts the debounce window. */
  add(file: string): void;
  /** Files waiting for the next run. */
  pending(): string[];
  /** Cancels any armed timer. Used when shutting down. */
  stop(): void;
}

/**
 * Debounces file changes into batched runs, without losing anything.
 *
 * The previous version returned early while an analysis was in flight, which
 * silently dropped every edit made during it — exactly the edits a developer is
 * most likely to care about, since they were typing while the tool was busy.
 * Changes that arrive mid-run are now kept and trigger another run afterwards.
 */
export function createRunQueue(
  debounceMs: number,
  run: (files: string[]) => Promise<void>,
  onError: (error: unknown) => void = () => {},
): RunQueue {
  const waiting = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  const flush = async (): Promise<void> => {
    // A run is already in progress. Whatever is waiting stays waiting; the
    // run in flight re-arms the timer when it finishes.
    if (running || waiting.size === 0) return;

    running = true;
    const batch = [...waiting].sort();
    waiting.clear();

    try {
      await run(batch);
    } catch (error) {
      // A run that throws must not take the watcher down with it, and must not
      // escape as an unhandled rejection either: the timer that started it has
      // nobody left to hand the failure to.
      onError(error);
    } finally {
      running = false;
      if (waiting.size > 0) arm();
    }
  };

  return {
    add(file) {
      waiting.add(file);
      arm();
    },
    pending() {
      return [...waiting].sort();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface AttributedFindings {
  /** Findings in the files that were just edited. */
  inChange: Finding[];
  /** Findings in files that import the edited ones, so the change may have caused them. */
  inAffected: Finding[];
  /** Everything else, including project-wide findings with no file of their own. */
  elsewhere: Finding[];
  /** Files that import the edited ones, directly or through a chain. */
  affectedFiles: string[];
}

/**
 * Works out which of the new findings the current edit can actually account for.
 *
 * Watch mode used to print the touched file as a heading and then list every
 * finding that was new since the baseline underneath it, which meant an
 * untouched file's problem was presented as if the last keystroke had caused
 * it. Reachability is the only honest link available here: a finding is tied to
 * the change if it is *in* a changed file, or in a file that imports one.
 * Anything else is reported separately and labelled as such.
 */
export function attributeFindings(
  touched: readonly string[],
  findings: readonly Finding[],
  graph: DependencyGraph,
): AttributedFindings {
  const changed = new Set(touched);
  const affected = new Set<string>();

  for (const file of touched) {
    for (const dependent of graph.reverseReachable(file).keys()) {
      if (!changed.has(dependent)) affected.add(dependent);
    }
  }

  const inChange: Finding[] = [];
  const inAffected: Finding[] = [];
  const elsewhere: Finding[] = [];

  for (const finding of findings) {
    if (finding.file !== undefined && changed.has(finding.file)) inChange.push(finding);
    else if (finding.file !== undefined && affected.has(finding.file)) inAffected.push(finding);
    else elsewhere.push(finding);
  }

  return { inChange, inAffected, elsewhere, affectedFiles: [...affected].sort() };
}
