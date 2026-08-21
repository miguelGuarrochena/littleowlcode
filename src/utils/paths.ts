import path from 'node:path';

/** Converts any platform path to the POSIX form used as the canonical file id. */
export const toPosix = (value: string): string => value.split(path.sep).join('/');

export const relativePath = (root: string, absolute: string): string => {
  return toPosix(path.relative(root, absolute));
};

/** `features/orders/OrderList.tsx` -> `features/orders` */
export const dirOf = (file: string): string => {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
};

export const basename = (file: string): string => {
  const index = file.lastIndexOf('/');
  return index === -1 ? file : file.slice(index + 1);
};

export const extname = (file: string): string => {
  const name = basename(file);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index);
};

/** First path segment, used for top-level layer/feature attribution. */
export const topSegment = (file: string): string => {
  const index = file.indexOf('/');
  return index === -1 ? file : file.slice(0, index);
};

export const segments = (file: string): string[] => file.split('/').filter(Boolean);
