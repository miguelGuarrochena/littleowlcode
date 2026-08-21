import { runReview } from '../../review/review.js';
import { generatePrompt } from '../../prompts/generate.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';

export interface PromptOptions extends GlobalOptions {
  base?: string;
  scope?: string[];
  /** Include findings that already existed before this change. */
  all?: boolean;
  max?: number;
}

/**
 * `little-owl prompt` — a short brief for whichever assistant you use.
 *
 * Little Owl never calls a model and needs no API key; it just writes the text
 * and stays out of the way.
 */
export const promptCommand = async (options: PromptOptions): Promise<number> => {
  const root = resolveRoot(options);

  const review = await runReview({
    root,
    ...(options.base ? { base: options.base } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });

  print(
    generatePrompt(review, {
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.all ? { includeExisting: true } : {}),
      ...(options.max ? { maxInstructions: options.max } : {}),
    }),
  );
  return 0;
};
