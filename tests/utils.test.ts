/* eslint-disable no-control-regex -- these tests assert on real ANSI sequences. */
import { describe, expect, it } from 'vitest';
import { compilePattern, matchesAny } from '../src/utils/glob.js';
import { fingerprint, hashContent } from '../src/utils/hash.js';
import { dirOf, extname, topSegment, toPosix } from '../src/utils/paths.js';
import { visibleWidth, wrap, scoreBar, metricLine, box, heading } from '../src/output/ui.js';

describe('glob matching', () => {
  it('matches single-segment wildcards', () => {
    expect(matchesAny('src/index.ts', ['src/*.ts'])).toBe(true);
    expect(matchesAny('src/deep/index.ts', ['src/*.ts'])).toBe(false);
  });

  it('matches globstar across any depth, including zero', () => {
    expect(matchesAny('features/orders/list.tsx', ['features/**'])).toBe(true);
    expect(matchesAny('src/a.ts', ['src/**/a.ts'])).toBe(true);
    expect(matchesAny('src/x/y/a.ts', ['src/**/a.ts'])).toBe(true);
  });

  it('treats a bare directory name as everything under it', () => {
    expect(matchesAny('dist/bundle.js', ['dist'])).toBe(true);
    expect(matchesAny('distant/file.ts', ['dist'])).toBe(false);
  });

  it('supports brace alternation', () => {
    expect(matchesAny('a.spec.ts', ['*.{test,spec}.ts'])).toBe(true);
    expect(matchesAny('a.other.ts', ['*.{test,spec}.ts'])).toBe(false);
  });

  it('lets a later negation override an earlier match', () => {
    expect(matchesAny('src/generated/api.ts', ['src/**', '!src/generated/**'])).toBe(false);
    expect(matchesAny('src/real/api.ts', ['src/**', '!src/generated/**'])).toBe(true);
  });

  it('does not let regex characters in a pattern escape', () => {
    expect(compilePattern('a.b.ts').test('axbxts')).toBe(false);
    expect(compilePattern('a.b.ts').test('a.b.ts')).toBe(true);
  });
});

describe('hashing', () => {
  it('produces the same fingerprint for the same inputs', () => {
    expect(fingerprint(['rule', 'file.ts', 12])).toBe(fingerprint(['rule', 'file.ts', 12]));
  });

  it('ignores undefined parts so optional fields do not change identity', () => {
    expect(fingerprint(['rule', undefined, 'file.ts'])).toBe(fingerprint(['rule', 'file.ts']));
  });

  it('changes when the content changes', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('path helpers', () => {
  it('splits paths predictably', () => {
    expect(dirOf('features/orders/list.tsx')).toBe('features/orders');
    expect(dirOf('index.ts')).toBe('');
    expect(topSegment('features/orders/list.tsx')).toBe('features');
    expect(extname('list.tsx')).toBe('.tsx');
    expect(extname('.gitignore')).toBe('');
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });
});

describe('terminal rendering', () => {
  it('counts emoji as two columns and ignores colour codes', () => {
    expect(visibleWidth('abc')).toBe(3);
    expect(visibleWidth('🦉')).toBe(2);
    expect(visibleWidth('\u001B[31mabc\u001B[39m')).toBe(3);
  });

  it('wraps text without breaking words', () => {
    const lines = wrap('one two three four five', 9);
    expect(lines.every((line) => line.length <= 9)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four five');
  });

  it('keeps every box line the same width, emoji included', () => {
    for (const rendered of [
      heading('\u{1F989} CODEBASE REVIEW'),
      heading('SHORT'),
      box(['plain'], { width: 30 }),
      box(['\u{1F534} 1 critical', 'short'], { width: 30 }),
    ]) {
      const widths = new Set(rendered.split('\n').map(visibleWidth));
      expect(widths.size).toBe(1);
    }
  });

  it('draws a proportional score bar', () => {
    expect(scoreBar(100, 10).replace(/\u001B\[[0-9;]*m/g, '')).toBe('█'.repeat(10));
    expect(scoreBar(0, 10).replace(/\u001B\[[0-9;]*m/g, '')).toBe('░'.repeat(10));
  });

  it('shows a before/after arrow only when there is something to compare', () => {
    const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, '');
    expect(plain(metricLine({ label: 'Architecture', value: 91 }))).toContain('91');
    expect(plain(metricLine({ label: 'Architecture', value: 84, previous: 91 }))).toContain('91');
    expect(plain(metricLine({ label: 'Architecture', value: 84, previous: 91 }))).toContain('↓');
    expect(plain(metricLine({ label: 'Architecture', value: 95, previous: 91 }))).toContain('↑');
  });
});
