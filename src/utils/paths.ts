import path from 'node:path';

/** Converts any platform path to the POSIX form used as the canonical file id. */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function relativePath(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}

/** `features/orders/OrderList.tsx` -> `features/orders` */
export function dirOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

export function basename(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? file : file.slice(index + 1);
}

export function extname(file: string): string {
  const name = basename(file);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index);
}

/** First path segment, used for top-level layer/feature attribution. */
export function topSegment(file: string): string {
  const index = file.indexOf('/');
  return index === -1 ? file : file.slice(0, index);
}

export function segments(file: string): string[] {
  return file.split('/').filter(Boolean);
}
