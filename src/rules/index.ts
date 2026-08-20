import type { Rule } from '../core/context.js';
import { architectureRules } from './architecture.js';
import { complexityRules } from './complexity.js';
import { maintainabilityRules } from './maintainability.js';
import { typeSafetyRules } from './type-safety.js';
import { frameworkRules } from './framework.js';
import { languageRules } from './languages.js';
import { dependencyRules } from './dependencies.js';

/** Every rule Little Owl ships, in a fixed order so output is reproducible. */
export const allRules: Rule[] = [
  ...architectureRules,
  ...complexityRules,
  ...maintainabilityRules,
  ...typeSafetyRules,
  ...frameworkRules,
  ...languageRules,
  ...dependencyRules,
];

export function ruleById(id: string): Rule | undefined {
  return allRules.find((rule) => rule.id === id);
}

export {
  architectureRules,
  complexityRules,
  maintainabilityRules,
  typeSafetyRules,
  frameworkRules,
  languageRules,
  dependencyRules,
};
