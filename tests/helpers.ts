import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject, type Analysis } from '../src/core/analyze.js';
import { resolveConfig } from '../src/config/load.js';
import type { LittleOwlConfig } from '../src/config/schema.js';
import type { Finding } from '../src/core/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const fixture = (name: string): string => {
  return path.join(here, 'fixtures', name);
};

/** Runs a full analysis on a fixture with the parse cache disabled. */
export const analyzeFixture = (name: string, config: LittleOwlConfig = {}): Promise<Analysis> => {
  return analyzeProject({
    root: fixture(name),
    config: resolveConfig(config),
    cache: false,
  });
};

export const findingIds = (findings: Finding[]): string[] => {
  return findings.map((finding) => finding.id);
};

export const findingsFor = (findings: Finding[], id: string): Finding[] => {
  return findings.filter((finding) => finding.id === id);
};
