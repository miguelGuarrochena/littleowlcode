import type { AnalysisContext } from '../core/context.js';
import type { ParsedFile } from '../core/types.js';

/**
 * The client/server boundary in a bundled app.
 *
 * A `"use client"` module and everything it imports gets compiled into
 * JavaScript that is downloaded and run by the browser. Anyone can read it.
 * That is fine for a button and catastrophic for a database URL, and the
 * distance between the two is usually three import statements — a component
 * imports a helper, the helper imports the client, the client reads the key.
 * Nobody wrote anything obviously wrong at any step.
 *
 * Little Owl already has the import graph, so it can answer the question the
 * eye cannot: from this component, is there *any* path to code that was never
 * meant to leave the server?
 */

/** Environment variable prefixes a bundler is designed to expose publicly. */
const PUBLIC_ENV_PREFIXES = [
  'NEXT_PUBLIC_',
  'PUBLIC_',
  'VITE_',
  'REACT_APP_',
  'NUXT_PUBLIC_',
  'EXPO_PUBLIC_',
  'GATSBY_',
  'STORYBOOK_',
  'VUE_APP_',
];

/** Names that are build metadata rather than configuration. */
const HARMLESS_ENV_NAMES = new Set([
  'NODE_ENV',
  'VERCEL_ENV',
  'VERCEL_URL',
  'CI',
  'PORT',
  'TZ',
  'npm_package_version',
]);

/**
 * Word fragments that make a variable name look like a credential.
 *
 * A deny-list of *shapes*, not of names: nobody can enumerate what a team calls
 * its keys, but almost everyone reaches for one of these words when naming one.
 * The cost of a miss is a leaked credential; the cost of a false positive is a
 * question. The list is deliberately tilted towards asking the question.
 */
const SECRET_NAME_PATTERN =
  /(SECRET|_KEY|^KEY_|APIKEY|API_KEY|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SERVICE_ROLE|ACCESS_ID|CLIENT_SECRET|WEBHOOK|SIGNING|SALT|CERT|_PEM|_DSN|DATABASE_URL|DB_URL|CONNECTION_STRING|AUTH)/i;

export interface EnvRead {
  name: string;
  line: number;
}

/**
 * Whether reading this variable in the browser would give something away.
 *
 * A public prefix is the bundler's own promise that the value is meant to ship,
 * so it wins over everything else — `NEXT_PUBLIC_STRIPE_KEY` is a publishable
 * key, and reporting it would teach people to ignore this rule.
 */
export const isSecretEnvName = (name: string): boolean => {
  if (PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (HARMLESS_ENV_NAMES.has(name)) return false;
  return SECRET_NAME_PATTERN.test(name);
};

export const secretEnvReads = (file: ParsedFile): EnvRead[] => {
  const reads = (file.meta['envReads'] as EnvRead[] | undefined) ?? [];
  return reads.filter((read) => isSecretEnvName(read.name));
};

export const serverOnlyPackages = (file: ParsedFile): string[] =>
  (file.meta['serverOnlyImports'] as string[] | undefined) ?? [];

/** Why a module must not end up in a browser bundle. */
export interface ServerOnlyReason {
  /** `secret` outranks `package`: one leaks a credential, the other breaks a build. */
  kind: 'secret' | 'package';
  /** Environment variable names, or package names. */
  names: string[];
  /** First line in the module that shows it, when there is one. */
  line?: number;
}

/**
 * Why this module is server-only, or an empty list if it is not.
 *
 * `import 'server-only'` arrives here as a package, which is right: it is the
 * explicit, framework-sanctioned way of saying exactly this, and it deserves to
 * be believed without further evidence.
 */
export const serverOnlyReasons = (file: ParsedFile): ServerOnlyReason[] => {
  const reasons: ServerOnlyReason[] = [];

  const secrets = secretEnvReads(file);
  if (secrets.length > 0) {
    reasons.push({
      kind: 'secret',
      names: secrets.map((read) => read.name),
      line: secrets[0]!.line,
    });
  }

  const packages = serverOnlyPackages(file);
  if (packages.length > 0) reasons.push({ kind: 'package', names: packages });

  return reasons;
};

export interface ClientLeak {
  /** The `"use client"` module the browser starts from. */
  client: string;
  /** The module that should never have been reachable from it. */
  target: string;
  /** Shortest import chain from `client` to `target`, both ends included. */
  chain: string[];
  reasons: ServerOnlyReason[];
}

/** Depth beyond which a chain stops being an explanation and becomes a haystack. */
const MAX_DEPTH = 10;

/** Ceiling on nodes visited per client component, so a huge graph stays fast. */
const MAX_VISITS = 2_000;

export interface BoundaryOptions {
  maxDepth?: number;
}

/**
 * Every path from a client component to code that should stay on the server.
 *
 * One result per (component, module) pair, carrying the shortest chain between
 * them — breadth-first, so the chain reported is the shortest one and therefore
 * the easiest to break.
 */
/**
 * One walk per analysis, shared by every rule that needs it.
 *
 * Two rules ask the same question about the same graph and differ only in what
 * they do with the answer; keyed on the context, so it dies with the run and
 * can never be handed a stale graph.
 */
const cache = new WeakMap<AnalysisContext, ClientLeak[]>();

export const findClientLeaks = (
  context: AnalysisContext,
  options: BoundaryOptions = {},
): ClientLeak[] => {
  if (options.maxDepth === undefined) {
    const cached = cache.get(context);
    if (cached) return cached;
    const computed = walkAll(context, {});
    cache.set(context, computed);
    return computed;
  }
  return walkAll(context, options);
};

const walkAll = (context: AnalysisContext, options: BoundaryOptions): ClientLeak[] => {
  const clients = context.files.filter((file) => file.meta['useClient'] === true && !file.isTest);
  if (clients.length === 0) return [];

  const graph = runtimeGraph(context);
  const reasons = new Map<string, ServerOnlyReason[]>();
  const reasonsFor = (path: string): ServerOnlyReason[] => {
    let cached = reasons.get(path);
    if (!cached) {
      const file = context.fileMap.get(path);
      cached = file ? serverOnlyReasons(file) : [];
      reasons.set(path, cached);
    }
    return cached;
  };

  const leaks: ClientLeak[] = [];
  for (const client of clients) {
    leaks.push(...walk(client.path, graph, context, reasonsFor, options.maxDepth ?? MAX_DEPTH));
  }
  return leaks;
};

/**
 * Import edges as the browser bundler sees them.
 *
 * Two kinds of edge are dropped, and both matter:
 *
 * `import type` is erased before anything is bundled, so a component importing
 * a *type* from the database module ships no database code. Following it would
 * report a leak that cannot physically exist.
 *
 * Imports of a `"use server"` module are not inclusions at all. That directive
 * exists precisely so a client component can call server code: the bundler
 * replaces the import with a network call, and the body stays on the server.
 * Walking through it would flag every correct Server Action in the project,
 * which is both wrong and the fastest way to make people stop reading.
 */
const runtimeGraph = (context: AnalysisContext): Map<string, string[]> => {
  const adjacency = new Map<string, string[]>();

  for (const edge of context.graph.edges) {
    if (edge.typeOnly) continue;
    if (context.fileMap.get(edge.to)?.meta['useServer'] === true) continue;
    const existing = adjacency.get(edge.from);
    if (existing) existing.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  return adjacency;
};

const walk = (
  start: string,
  graph: Map<string, string[]>,
  context: AnalysisContext,
  reasonsFor: (path: string) => ServerOnlyReason[],
  maxDepth: number,
): ClientLeak[] => {
  const leaks: ClientLeak[] = [];
  const cameFrom = new Map<string, string | null>([[start, null]]);
  let frontier = [start];
  let depth = 0;
  let visits = 0;

  while (frontier.length > 0 && depth <= maxDepth && visits < MAX_VISITS) {
    const next: string[] = [];

    for (const current of frontier) {
      visits += 1;
      const found = reasonsFor(current);
      // A component that reads a secret itself is still a leak, so the start
      // node is checked too — the chain is then just the component.
      if (found.length > 0) {
        leaks.push({
          client: start,
          target: current,
          chain: chainTo(current, cameFrom),
          reasons: found,
        });
        // No point descending: everything below inherits the same verdict, and
        // reporting it would turn one problem into a list of them.
        continue;
      }

      for (const dependency of graph.get(current) ?? []) {
        if (cameFrom.has(dependency)) continue;
        if (!context.fileMap.has(dependency)) continue;
        cameFrom.set(dependency, current);
        next.push(dependency);
      }
    }

    frontier = next;
    depth += 1;
  }

  return leaks;
};

const chainTo = (target: string, cameFrom: Map<string, string | null>): string[] => {
  const chain = [target];
  let step = cameFrom.get(target) ?? null;
  while (step) {
    chain.unshift(step);
    step = cameFrom.get(step) ?? null;
  }
  return chain;
};

/** `a.tsx → b.ts → c.ts`, the form every report and prompt uses. */
export const describeChain = (chain: string[]): string => chain.join(' → ');
