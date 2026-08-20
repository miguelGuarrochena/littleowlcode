import type { Finding } from '../core/types.js';
import { createFinding, type Rule } from '../core/context.js';

const largeFile: Rule = {
  id: 'complexity/large-file',
  category: 'complexity',
  description: 'Files that have grown past the configured line budget.',
  run(context) {
    const limit = context.config.thresholds.maxFileLines;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      if (file.lines <= limit) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        title: `${file.path} is ${file.lines.toLocaleString()} lines`,
        message:
          `This file is over the ${limit.toLocaleString()}-line budget configured for the project. ` +
          'Large files are the usual place where unrelated responsibilities pile up.',
        detail: [`${file.functions.length} functions, ${file.sloc.toLocaleString()} lines of code`],
        suggestion: 'Split the file along its clearest seam — usually one exported concept per file.',
        baseline: limit,
        current: file.lines,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const largeFunction: Rule = {
  id: 'complexity/large-function',
  category: 'complexity',
  description: 'Functions longer than the configured limit.',
  run(context) {
    const limit = context.config.thresholds.maxFunctionLines;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const fn of file.functions) {
        if (fn.isComponent) continue; // handled by the component rule
        if (fn.lines <= limit) continue;

        const finding = createFinding(this, context, {
          file: file.path,
          line: fn.line,
          title: `${fn.name}() is ${fn.lines} lines`,
          message:
            `${fn.name}() in ${file.path} runs for ${fn.lines} lines, past the ${limit}-line limit. ` +
            'Long functions are hard to test and tend to hide more than one job.',
          suggestion: 'Pull the distinct steps out into named helpers.',
          key: [fn.name, fn.line],
          baseline: limit,
          current: fn.lines,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const largeComponent: Rule = {
  id: 'complexity/large-component',
  category: 'complexity',
  description: 'React components larger than the configured component budget.',
  run(context) {
    const limit = context.config.thresholds.maxComponentLines;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const fn of file.functions) {
        if (!fn.isComponent || fn.lines <= limit) continue;

        const finding = createFinding(this, context, {
          file: file.path,
          line: fn.line,
          title: `<${fn.name}> is ${fn.lines} lines`,
          message:
            `The ${fn.name} component is ${fn.lines} lines, past the ${limit}-line budget. ` +
            'Components this size usually mix data fetching, state and presentation.',
          suggestion:
            'Extract the sub-sections into their own components, and move data logic into hooks.',
          key: [fn.name, fn.line],
          baseline: limit,
          current: fn.lines,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const highComplexity: Rule = {
  id: 'complexity/high-complexity',
  category: 'complexity',
  description: 'Functions with too many independent branches.',
  run(context) {
    const limit = context.config.thresholds.maxComplexity;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const fn of file.functions) {
        if (fn.complexity <= limit) continue;

        const finding = createFinding(this, context, {
          file: file.path,
          line: fn.line,
          title: `${fn.name}() has a complexity of ${fn.complexity}`,
          message:
            `${fn.name}() contains ${fn.complexity} independent branches (limit ${limit}). ` +
            'Every branch is another path a change can break and another case tests must cover.',
          suggestion: 'Flatten early returns, or move each branch group into its own function.',
          key: [fn.name, fn.line],
          baseline: limit,
          current: fn.complexity,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const deepNesting: Rule = {
  id: 'complexity/deep-nesting',
  category: 'complexity',
  description: 'Deeply nested control flow inside a single function.',
  run(context) {
    const limit = context.config.thresholds.maxNesting;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const fn of file.functions) {
        if (fn.maxNesting <= limit) continue;

        const finding = createFinding(this, context, {
          file: file.path,
          line: fn.line,
          title: `${fn.name}() nests ${fn.maxNesting} levels deep`,
          message: `Control flow in ${fn.name}() reaches ${fn.maxNesting} levels (limit ${limit}).`,
          suggestion: 'Return early on the failure cases so the happy path stays at the top level.',
          key: [fn.name, fn.line],
          baseline: limit,
          current: fn.maxNesting,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const tooManyParams: Rule = {
  id: 'complexity/too-many-params',
  category: 'complexity',
  description: 'Functions taking a long list of positional parameters.',
  run(context) {
    const limit = context.config.thresholds.maxParams;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const fn of file.functions) {
        if (fn.params <= limit) continue;

        const finding = createFinding(this, context, {
          file: file.path,
          line: fn.line,
          title: `${fn.name}() takes ${fn.params} parameters`,
          message: `${fn.name}() has ${fn.params} parameters (limit ${limit}), which is easy to call wrongly.`,
          suggestion: 'Group related parameters into a single options object.',
          key: [fn.name, fn.line],
          baseline: limit,
          current: fn.params,
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

export const complexityRules: Rule[] = [
  largeFile,
  largeFunction,
  largeComponent,
  highComplexity,
  deepNesting,
  tooManyParams,
];
