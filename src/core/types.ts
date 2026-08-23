/**
 * Core domain model for Little Owl Code.
 *
 * Everything the engine produces flows through these types: files are parsed
 * into `ParsedFile`, rules turn an `AnalysisContext` into `Finding`s, and the
 * numeric summary lives in `Metrics`.
 */

export type Severity = 'off' | 'info' | 'warning' | 'error';

/** Severity a finding can actually carry (`off` means "not reported"). */
export type ReportedSeverity = Exclude<Severity, 'off'>;

export type FindingCategory =
  | 'architecture'
  | 'complexity'
  | 'maintainability'
  | 'dependencies'
  | 'type-safety'
  | 'scope'
  | 'impact';

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'unknown';

export interface Finding {
  /** Rule id, e.g. `architecture/circular-dependency`. */
  id: string;
  /**
   * Stable identity of this specific finding, used to diff runs against each
   * other ("is this a new problem or one we already knew about?").
   */
  fingerprint: string;
  severity: ReportedSeverity;
  category: FindingCategory;
  file?: string;
  line?: number;
  /** One short line: what happened. */
  title: string;
  /** Why it matters, in plain language. */
  message: string;
  /** Optional supporting lines (paths in a cycle, before/after numbers...). */
  detail?: string[];
  baseline?: unknown;
  current?: unknown;
  /** What the developer can do about it. */
  suggestion?: string;
}

export interface Metrics {
  overall: number;
  architecture: number;
  maintainability: number;
  complexity: number;
  dependencies: number;
  typeSafety: number;
}

export type MetricKey = keyof Metrics;

/** Raw counts behind the scores. Kept in the baseline so drift is explainable. */
export interface MetricStats {
  files: number;
  /**
   * Files that fall inside a declared (or inferred) layer. Boundary rules can
   * only see these, so the gap to `files` is how much of the tree the
   * architecture checks never looked at.
   */
  layeredFiles: number;
  linesOfCode: number;
  functions: number;
  cycles: number;
  layerViolations: number;
  layerSkips: number;
  crossFeatureImports: number;
  largeFiles: number;
  largeFunctions: number;
  deeplyNested: number;
  complexFunctions: number;
  duplicateBlocks: number;
  anyUsages: number;
  suppressions: number;
  unsafeAssertions: number;
  jsFilesInTsProject: number;
  unresolvedImports: number;
  maxImportDepth: number;
}

export interface ImportRef {
  /** Import specifier exactly as written. */
  raw: string;
  /** Repo-relative path when the specifier resolves inside the project. */
  resolved?: string;
  /** Bare package name when the specifier points at a dependency. */
  packageName?: string;
  kind: 'import' | 'require' | 'dynamic' | 'export-from';
  line: number;
  typeOnly: boolean;
  /**
   * The names taken from the module, as written at the import site. Needed to
   * tell an export nobody uses from one that is used somewhere else.
   */
  names?: string[];
  /**
   * True when the whole module is pulled in at once (`import * as ns`,
   * `export * from`, `require(...)`). Any export could be reached through it,
   * so unused-export detection has to stay silent for that module.
   */
  wildcard?: boolean;
  /**
   * True when the specifier is built at runtime (`import(\`./x/${name}\`)`).
   * Such an import can reach anything, so it caps confidence rather than
   * contributing an edge.
   */
  computed?: boolean;
}

export interface FunctionInfo {
  name: string;
  line: number;
  endLine: number;
  lines: number;
  /** Cyclomatic complexity (decision points + 1). */
  complexity: number;
  maxNesting: number;
  params: number;
  /** True when it looks like a React component (TS/JS only). */
  isComponent: boolean;
}

export interface Marker {
  kind:
    | 'any'
    | 'ts-ignore'
    | 'ts-expect-error'
    | 'unsafe-assertion'
    | 'bare-except'
    | 'mutable-default'
    | 'ignored-error'
    | 'global-state'
    | 'eslint-disable';
  line: number;
  text?: string;
}

export interface ParsedFile {
  /** Repo-relative POSIX path. This is the canonical file id everywhere. */
  path: string;
  absPath: string;
  language: Language;
  /** Content hash, used for incremental analysis. */
  hash: string;
  lines: number;
  /** Source lines of code: non-blank, non-comment. */
  sloc: number;
  imports: ImportRef[];
  functions: FunctionInfo[];
  exports: string[];
  markers: Marker[];
  isTest: boolean;
  /** Adapter-specific extras (`useClient`, `package`, ...). */
  meta: Record<string, unknown>;
}

export interface DependencyEdge {
  from: string;
  to: string;
  line: number;
  typeOnly: boolean;
}

export interface ProjectInfo {
  root: string;
  name: string;
  isGitRepo: boolean;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  languages: Language[];
  frameworks: string[];
  monorepo: { kind: 'pnpm' | 'npm' | 'yarn' | 'turborepo' | 'nx'; packages: string[] } | null;
  hasTypeScript: boolean;
  fileCount: number;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** Raw `main`/`module`/`bin`/`exports` values from package.json, if any. */
  entryPoints: unknown;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  previousPath?: string;
  insertions: number;
  deletions: number;
}

export interface ChangeSet {
  /** Human description of what was compared, e.g. `working tree vs HEAD`. */
  description: string;
  base?: string;
  files: ChangedFile[];
}

export interface Baseline {
  version: string;
  createdAt: string;
  commit?: string;
  branch?: string;
  /**
   * Identity of the configuration this baseline was recorded under. When the
   * config changes, findings that always existed can start looking new, so
   * every comparison checks this and says so instead of blaming the change.
   * Absent on baselines written before Little Owl recorded it.
   */
  configFingerprint?: string;
  metrics: Metrics;
  stats: MetricStats;
  /** Fingerprints of findings that existed when the baseline was taken. */
  findings: Finding[];
  fileMetrics: Record<string, FileMetric>;
}

export interface FileMetric {
  lines: number;
  sloc: number;
  functions: number;
  maxComplexity: number;
}

/** A file Little Owl could not process, and why. Never fatal. */
export interface AnalysisWarning {
  file?: string;
  message: string;
}

export interface AnalysisResult {
  metrics: Metrics;
  stats: MetricStats;
  findings: Finding[];
  fileMetrics: Record<string, FileMetric>;
  project: ProjectInfo;
  /** Files that were skipped. The analysis continues without them. */
  warnings: AnalysisWarning[];
  /**
   * True when the project has more source files than one run will scan, so
   * every number here describes part of the repository rather than all of it.
   */
  truncated: boolean;
  durationMs: number;
}

export type ReviewStatus = 'healthy' | 'needs-review' | 'degraded';

export interface ReviewResult {
  status: ReviewStatus;
  current: AnalysisResult;
  baseline: Baseline | null;
  changes: ChangeSet | null;
  /** Findings that are not present in the baseline. */
  newFindings: Finding[];
  /** Baseline findings that no longer reproduce. */
  resolvedFindings: Finding[];
  scope: ScopeResult | null;
  drift: Record<MetricKey, number> | null;
  /**
   * True when the configuration changed after the baseline was recorded, so
   * pre-existing findings may be reported as new. `null` when there is no
   * baseline, or it predates Little Owl recording the configuration.
   */
  configDrifted: boolean | null;
}

export interface ScopeResult {
  patterns: string[];
  inScope: string[];
  outOfScope: string[];
}
