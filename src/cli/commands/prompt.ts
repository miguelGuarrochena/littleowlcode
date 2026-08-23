import { runReviewWithContext } from '../../review/review.js';
import { generatePrompt } from '../../prompts/generate.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';

export interface PromptOptions extends GlobalOptions {
  base?: string;
  scope?: string[];
  /** Include findings that already existed before this change. */
  all?: boolean;
  /** A short numbered list instead of the full brief. */
  compact?: boolean;
  max?: number;
}

/**
 * `little-owl prompt` — a brief for whichever assistant you use.
 *
 * Little Owl never calls a model and needs no API key; it writes the text and
 * stays out of the way. The brief carries the file, the line, the function, the
 * related files and the acceptance criteria, because the alternative is the
 * assistant spending its first several steps rediscovering all of that — and
 * arriving at a guess where Little Owl already had a measurement.
 */
export const promptCommand = async (options: PromptOptions): Promise<number> => {
  const root = resolveRoot(options);

  const { review, context } = await runReviewWithContext({
    root,
    ...(options.base ? { base: options.base } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });

  print(
    generatePrompt(review, {
      context,
      root,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.all ? { includeExisting: true } : {}),
      ...(options.max ? { maxInstructions: options.max } : {}),
      ...(options.compact ? { style: 'compact' as const } : {}),
    }),
  );
  return 0;
};
