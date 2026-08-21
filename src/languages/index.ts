import type { LanguageAdapter, ParseInput } from './adapter.js';
import { javaScriptAdapter, typeScriptAdapter } from './typescript.js';
import { pythonAdapter } from './python.js';
import { goAdapter } from './go.js';
import type { ParsedFile } from '../core/types.js';

export const adapters: LanguageAdapter[] = [
  typeScriptAdapter,
  javaScriptAdapter,
  pythonAdapter,
  goAdapter,
];

export const adapterFor = (file: string): LanguageAdapter | null => {
  return adapters.find((adapter) => adapter.canHandle(file)) ?? null;
};

/** Parses a file, or returns `null` when no adapter claims it. */
export const parseFile = (input: ParseInput): ParsedFile | null => {
  const adapter = adapterFor(input.path);
  return adapter ? adapter.parse(input) : null;
};

export type { LanguageAdapter, ParseInput } from './adapter.js';
export { typeScriptAdapter, javaScriptAdapter } from './typescript.js';
export { pythonAdapter } from './python.js';
export { goAdapter } from './go.js';
