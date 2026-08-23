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

/**
 * Directory names that wrap a project rather than describe it. Dropping them
 * lets `src/components/x` and `components/x` be talked about as one thing,
 * which is what people mean when they name a layer `components`.
 */
export const WRAPPER_SEGMENTS = new Set(['src', 'app_src', 'source']);

/** `src/lib/db/client.ts` -> `['lib', 'db', 'client.ts']` */
export const meaningfulSegments = (file: string): string[] => {
  const parts = segments(file);
  return parts[0] !== undefined && WRAPPER_SEGMENTS.has(parts[0]) ? parts.slice(1) : parts;
};

/** `src/lib/db` -> `lib/db` */
export const meaningfulPath = (file: string): string => meaningfulSegments(file).join('/');
