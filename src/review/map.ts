import type { AnalysisContext } from '../core/context.js';
import { layerOf } from '../architecture/layers.js';
import { dirOf, segments } from '../utils/paths.js';

/**
 * A high-level map of the project, aimed at someone who has never opened it.
 *
 * The ordering principle is "what would you read first" — entry points, then
 * the modules the most code depends on. Listing every directory alphabetically
 * would be accurate and useless.
 */

export interface MapArea {
  path: string;
  files: number;
  lines: number;
  layer: string | null;
  /** How many imports cross into this area from outside it. */
  incoming: number;
  outgoing: number;
}

export interface CentralModule {
  path: string;
  dependents: number;
  lines: number;
}

export interface ExternalService {
  name: string;
  packages: string[];
  usedIn: number;
}

export interface ProjectMap {
  areas: MapArea[];
  layers: string[];
  entryPoints: string[];
  central: CentralModule[];
  external: ExternalService[];
  /** Suggested reading order for someone new to the codebase. */
  startHere: string[];
  totals: { files: number; lines: number; edges: number };
}

/**
 * Well-known packages grouped into the service they represent, so the map can
 * say "Stripe" rather than listing four SDK packages.
 */
const SERVICE_PACKAGES: Array<[string, RegExp]> = [
  ['Stripe', /^(stripe|@stripe\/)/],
  ['Supabase', /^@supabase\//],
  ['Firebase', /^(firebase|@firebase\/|firebase-admin)/],
  ['AWS', /^(aws-sdk|@aws-sdk\/)/],
  ['PostgreSQL', /^(pg|postgres|@neondatabase\/|@vercel\/postgres)$/],
  ['MySQL', /^(mysql|mysql2)$/],
  ['MongoDB', /^(mongodb|mongoose)$/],
  ['Redis', /^(redis|ioredis)$/],
  ['Prisma', /^(@prisma\/|prisma$)/],
  ['Drizzle', /^drizzle-orm/],
  ['Email', /^(nodemailer|resend|@sendgrid\/|postmark)/],
  ['Auth', /^(next-auth|@auth\/|@clerk\/|passport|jsonwebtoken)/],
  ['Analytics', /^(posthog|@sentry\/|mixpanel|@vercel\/analytics)/],
  ['OpenAI', /^openai$/],
  ['Anthropic', /^@anthropic-ai\//],
  ['Payments', /^(@paypal\/|mercadopago)/],
  ['Storage', /^(@aws-sdk\/client-s3|@uploadthing\/|cloudinary)/],
];

/** Areas that exist in most repositories but explain nothing about the product. */
const NOT_A_STARTING_POINT = /^(\.|scripts|bin|tools|public|static|assets|config|docs|examples)$/;

const ENTRY_PATTERNS =
  /(^|\/)(main|index|server|app|cli)\.[cm]?[jt]sx?$|(^|\/)(page|route|layout)\.[cm]?[jt]sx?$|(^|\/)main\.go$|(^|\/)manage\.py$|(^|\/)__main__\.py$/;

export function buildProjectMap(context: AnalysisContext): ProjectMap {
  const areas = groupIntoAreas(context);
  const external = groupExternalServices(context);

  const central = context.files
    .filter((file) => !file.isTest)
    .map((file) => ({
      path: file.path,
      dependents: context.graph.dependentsOf(file.path).length,
      lines: file.lines,
    }))
    .filter((entry) => entry.dependents > 1)
    .sort((a, b) => b.dependents - a.dependents || (a.path < b.path ? -1 : 1))
    .slice(0, 10);

  const entryPoints = context.files
    .filter((file) => !file.isTest && ENTRY_PATTERNS.test(file.path))
    .filter((file) => context.graph.dependentsOf(file.path).length === 0)
    .map((file) => file.path)
    .sort()
    .slice(0, 15);

  return {
    areas,
    layers: context.layers.order,
    entryPoints,
    central,
    external,
    startHere: readingOrder(context, areas, entryPoints),
    totals: {
      files: context.files.length,
      lines: context.files.reduce((sum, file) => sum + file.lines, 0),
      edges: context.graph.edges.length,
    },
  };
}

/**
 * Areas are the second path segment where there is one (`src/services`), which
 * is the level at which most projects are actually organised.
 */
function groupIntoAreas(context: AnalysisContext): MapArea[] {
  const buckets = new Map<string, { files: string[]; lines: number }>();

  for (const file of context.files) {
    if (file.isTest) continue;
    const key = areaOf(file.path);
    const bucket = buckets.get(key) ?? { files: [], lines: 0 };
    bucket.files.push(file.path);
    bucket.lines += file.lines;
    buckets.set(key, bucket);
  }

  const areaByFile = new Map<string, string>();
  for (const [area, bucket] of buckets) {
    for (const file of bucket.files) areaByFile.set(file, area);
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of context.graph.edges) {
    const from = areaByFile.get(edge.from);
    const to = areaByFile.get(edge.to);
    if (!from || !to || from === to) continue;
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .map(([path, bucket]) => ({
      path,
      files: bucket.files.length,
      lines: bucket.lines,
      layer: layerOf(bucket.files[0]!, context.layers),
      incoming: incoming.get(path) ?? 0,
      outgoing: outgoing.get(path) ?? 0,
    }))
    .sort((a, b) => b.files - a.files || (a.path < b.path ? -1 : 1));
}

function areaOf(file: string): string {
  const directory = dirOf(file);
  if (!directory) return '.';
  const parts = segments(directory);
  // `src` alone says nothing; take the segment below it when there is one.
  const depth = parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'packages' ? 2 : 1;
  return parts.slice(0, depth).join('/');
}

function groupExternalServices(context: AnalysisContext): ExternalService[] {
  const usageByPackage = new Map<string, number>();
  for (const packages of context.graph.external.values()) {
    for (const name of packages) {
      usageByPackage.set(name, (usageByPackage.get(name) ?? 0) + 1);
    }
  }

  const services = new Map<string, { packages: Set<string>; usedIn: number }>();
  for (const [name, usedIn] of usageByPackage) {
    const match = SERVICE_PACKAGES.find(([, pattern]) => pattern.test(name));
    if (!match) continue;
    const entry = services.get(match[0]) ?? { packages: new Set<string>(), usedIn: 0 };
    entry.packages.add(name);
    entry.usedIn += usedIn;
    services.set(match[0], entry);
  }

  return [...services.entries()]
    .map(([name, entry]) => ({
      name,
      packages: [...entry.packages].sort(),
      usedIn: entry.usedIn,
    }))
    .sort((a, b) => b.usedIn - a.usedIn || (a.name < b.name ? -1 : 1));
}

/**
 * Reading order: start where execution starts, then the areas that most of the
 * codebase depends on.
 */
function readingOrder(context: AnalysisContext, areas: MapArea[], entryPoints: string[]): string[] {
  const order: string[] = [];

  const entryArea = entryPoints[0] ? areaOf(entryPoints[0]) : null;
  if (entryArea) order.push(`${entryArea}/`);

  const byImportance = [...areas]
    .filter((area) => area.path !== entryArea && area.files > 1)
    // Loose root files, build scripts and static assets are not where anyone
    // should start reading a codebase.
    .filter((area) => !NOT_A_STARTING_POINT.test(area.path))
    .sort((a, b) => b.incoming - a.incoming || b.files - a.files);

  for (const area of byImportance) {
    if (order.length >= 5) break;
    order.push(`${area.path}/`);
  }

  // A layered project reads best top-down, so prefer that order when known.
  if (context.layers.order.length >= 2 && order.length > 1) {
    const layerRank = new Map(context.layers.order.map((layer, index) => [layer, index]));
    const areaByPath = new Map(areas.map((area) => [`${area.path}/`, area]));
    order.sort((a, b) => {
      const rankA = layerRank.get(areaByPath.get(a)?.layer ?? '') ?? 99;
      const rankB = layerRank.get(areaByPath.get(b)?.layer ?? '') ?? 99;
      return rankA - rankB;
    });
  }

  return order;
}
