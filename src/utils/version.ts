import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * The installed version of Little Owl Code, read from the shipped package.json.
 *
 * It identifies the analyser as much as the CLI: cached analysis results from a
 * different version cannot be trusted, because the rules that produced them may
 * have changed.
 */
export function readVersion(): string {
  if (cached !== null) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of ['../package.json', '../../package.json', '../../../package.json']) {
    const file = path.resolve(here, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === 'little-owl-code' && parsed.version) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      continue;
    }
  }

  cached = '0.0.0';
  return cached;
}
