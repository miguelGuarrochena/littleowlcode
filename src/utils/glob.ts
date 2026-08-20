/**
 * A small, dependency-free glob matcher.
 *
 * Supports the subset developers actually reach for in ignore/scope patterns:
 * `**`, `*`, `?`, `{a,b}` alternation and a leading `!` for negation. Paths are
 * always POSIX, repo-relative and without a leading `./`.
 */

const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

function escapeLiteral(value: string): string {
  return value.replace(REGEX_SPECIALS, '\\$&');
}

function translate(pattern: string): string {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        // `**/` may match zero directories, so `src/**/a.ts` matches `src/a.ts`.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '{') {
      const end = pattern.indexOf('}', i);
      if (end !== -1) {
        const options = pattern.slice(i + 1, end).split(',');
        out += `(?:${options.map((option) => translate(option)).join('|')})`;
        i = end + 1;
        continue;
      }
    }

    out += escapeLiteral(char);
    i += 1;
  }

  return out;
}

export interface CompiledPattern {
  source: string;
  negated: boolean;
  test(path: string): boolean;
}

export function compilePattern(pattern: string): CompiledPattern {
  const negated = pattern.startsWith('!');
  const body = normalizePattern(negated ? pattern.slice(1) : pattern);
  const regex = new RegExp(`^${translate(body)}$`);

  // A bare directory name (`dist`, `app/generated`) is treated as "this path or
  // anything under it", which is what people mean when they write it.
  const isBareDirectory = !/[*?{}]/.test(body);
  const prefixRegex = isBareDirectory ? new RegExp(`^${escapeLiteral(body)}/`) : null;

  return {
    source: pattern,
    negated,
    test(path: string) {
      if (regex.test(path)) return true;
      return prefixRegex ? prefixRegex.test(path) : false;
    },
  };
}

function normalizePattern(pattern: string): string {
  let value = pattern.trim().replace(/\\/g, '/');
  if (value.startsWith('./')) value = value.slice(2);
  if (value.endsWith('/')) value = `${value}**`;
  return value;
}

/**
 * Matches `path` against a pattern list. Later negated patterns (`!foo`) win
 * over earlier positive ones, matching `.gitignore` intuition.
 */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return matchesCompiled(path, patterns.map(compilePattern));
}

export function matchesCompiled(path: string, patterns: readonly CompiledPattern[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (!pattern.test(path)) continue;
    matched = !pattern.negated;
  }
  return matched;
}
