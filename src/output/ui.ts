import { colors, dim, icons, scoreColor } from './theme.js';

// Matching the escape character is the whole point of this pattern.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Printable width of a string, ignoring colour codes and counting emoji as the
 * two columns a terminal actually gives them. Box borders line up because of
 * this, so it is worth the few lines.
 */
export const visibleWidth = (text: string): number => {
  let width = 0;
  for (const character of text.replace(ANSI, '')) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0xfe0f || code === 0x200d) continue; // variation selector, ZWJ
    width += code >= 0x1f300 || (code >= 0x2600 && code <= 0x27bf) ? 2 : 1;
  }
  return width;
};

export const padEnd = (text: string, width: number): string => {
  const padding = Math.max(0, width - visibleWidth(text));
  return text + ' '.repeat(padding);
};

export const padStart = (text: string, width: number): string => {
  const padding = Math.max(0, width - visibleWidth(text));
  return ' '.repeat(padding) + text;
};

export interface BoxOptions {
  width?: number;
  padding?: number;
  color?: (text: string) => string;
}

export const box = (lines: string[], options: BoxOptions = {}): string => {
  const padding = options.padding ?? 1;
  const contentWidth = options.width ?? Math.max(...lines.map(visibleWidth), 20) + padding * 2 + 2;
  const paint = options.color ?? dim;

  const top = paint(`╭${'─'.repeat(contentWidth)}╮`);
  const bottom = paint(`╰${'─'.repeat(contentWidth)}╯`);
  const body = lines.map((line) => {
    const inner = ' '.repeat(padding + 1) + padEnd(line, contentWidth - padding - 1);
    return `${paint('│')}${inner}${paint('│')}`;
  });

  return [top, ...body, bottom].join('\n');
};

export const heading = (text: string): string => {
  return box([colors.bold(text)], { width: Math.max(46, visibleWidth(text) + 4) });
};

export const rule = (width = 46): string => dim('─'.repeat(width));

/** `█████████████████░░░` — a 20 cell bar for a 0-100 score. */
export const scoreBar = (score: number, width = 20): string => {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width);
  return scoreColor(score)('█'.repeat(filled)) + dim('░'.repeat(width - filled));
};

export interface MetricRow {
  label: string;
  value: number;
  previous?: number;
}

/**
 * Renders `Architecture   91 → 84 ↓`, keeping the arrow column aligned and
 * omitting the before/after form when there is nothing to compare against.
 */
export const metricLine = (row: MetricRow, labelWidth = 16): string => {
  const label = padEnd(row.label, labelWidth);
  const value = scoreColor(row.value)(padStart(String(row.value), 3));

  if (row.previous === undefined || row.previous === row.value) {
    const suffix = row.previous === undefined ? '' : dim(`   ${icons.flat}`);
    return `${label}${value}${suffix}`;
  }

  const before = dim(padStart(String(row.previous), 3));
  const delta = row.value - row.previous;
  const arrow = delta > 0 ? colors.green(icons.up) : colors.red(icons.down);
  return `${label}${before} ${dim(icons.arrow)} ${value} ${arrow}`;
};

export const indent = (text: string, spaces = 2): string => {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
};

/** Wraps text to `width` columns without breaking words. */
export const wrap = (text: string, width = 76): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (visibleWidth(current) + 1 + visibleWidth(word) > width) {
      lines.push(current);
      current = word;
      continue;
    }
    current += ` ${word}`;
  }
  if (current.length > 0) lines.push(current);
  return lines;
};

export const countLabel = (count: number, singular: string, plural = `${singular}s`): string => {
  return `${count} ${count === 1 ? singular : plural}`;
};
