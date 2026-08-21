import type { Finding, Marker } from '../core/types.js';
import { createFinding, type Rule } from '../core/context.js';

function markersOf(kinds: Marker['kind'][], markers: Marker[]): Marker[] {
  return markers.filter((marker) => kinds.includes(marker.kind));
}

const explicitAny: Rule = {
  id: 'type-safety/explicit-any',
  category: 'type-safety',
  description: 'Files leaning on `any` often enough to lose type coverage.',
  run(context) {
    const perKLoc = context.config.thresholds.maxAnyPerKLoc;
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'typescript' || file.isTest) continue;
      const anys = markersOf(['any'], file.markers);
      // A couple of `any`s in a big file is normal; a cluster is not.
      const budget = Math.max(2, Math.round((file.sloc / 1000) * perKLoc));
      if (anys.length <= budget) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        line: anys[0]!.line,
        title: `${anys.length} uses of \`any\` in ${file.path}`,
        message:
          `This file uses \`any\` ${anys.length} times over ${file.sloc.toLocaleString()} lines of code ` +
          `(budget: ${budget}). Every \`any\` switches off type checking for the values that flow through it.`,
        detail: [
          `lines: ${anys
            .slice(0, 8)
            .map((marker) => marker.line)
            .join(', ')}`,
        ],
        suggestion:
          'Replace the widest ones with `unknown` plus a narrowing check, or a real type.',
        baseline: budget,
        current: anys.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const suppression: Rule = {
  id: 'type-safety/suppression',
  category: 'type-safety',
  description: '`@ts-ignore` comments that hide a real type error.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      for (const marker of markersOf(['ts-ignore'], file.markers)) {
        const finding = createFinding(this, context, {
          file: file.path,
          line: marker.line,
          title: '@ts-ignore suppresses a type error',
          message:
            `${file.path}:${marker.line} silences the compiler without recording why. Unlike ` +
            '`@ts-expect-error`, it stays silent even after the underlying error is gone.',
          suggestion:
            'Fix the type, or switch to `@ts-expect-error` with a short comment so it fails once the error disappears.',
          key: [marker.line],
        });
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};

const unsafeAssertion: Rule = {
  id: 'type-safety/unsafe-assertion',
  category: 'type-safety',
  description: 'Assertions to `any`/`unknown` that bypass the type system.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.language !== 'typescript' || file.isTest) continue;
      const assertions = markersOf(['unsafe-assertion'], file.markers);
      if (assertions.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        line: assertions[0]!.line,
        title: `${assertions.length} unchecked type assertion${assertions.length === 1 ? '' : 's'}`,
        message:
          `${file.path} asserts through \`any\`/\`unknown\` ${assertions.length} time${assertions.length === 1 ? '' : 's'}. ` +
          'These assertions are never verified at runtime, so a wrong assumption surfaces as a crash later.',
        detail: [
          `lines: ${assertions
            .slice(0, 8)
            .map((marker) => marker.line)
            .join(', ')}`,
        ],
        suggestion:
          'Narrow with a type guard, or validate the value at the boundary where it enters.',
        current: assertions.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const jsInTsProject: Rule = {
  id: 'type-safety/js-in-ts-project',
  category: 'type-safety',
  description: 'Plain JavaScript files inside a TypeScript project.',
  run(context) {
    if (!context.project.hasTypeScript) return [];

    const jsFiles = context.files
      .filter((file) => file.language === 'javascript' && !file.isTest)
      .filter((file) => !/^[^/]*\.(config|setup)\.[cm]?js$/.test(file.path))
      .map((file) => file.path);

    if (jsFiles.length === 0) return [];

    const finding = createFinding(this, context, {
      file: jsFiles[0]!,
      title: `${jsFiles.length} JavaScript file${jsFiles.length === 1 ? '' : 's'} in a TypeScript project`,
      message:
        `This project is set up for TypeScript, but ${jsFiles.length} source file${jsFiles.length === 1 ? ' is' : 's are'} ` +
        'plain JavaScript. Those files are not type checked, and neither is the code that calls into them.',
      detail: jsFiles.slice(0, 8),
      suggestion:
        'Convert them to TypeScript, or add them to the ignore list if they are intentional.',
      key: jsFiles,
      current: jsFiles.length,
    });

    return finding ? [finding] : [];
  },
};

export const typeSafetyRules: Rule[] = [explicitAny, suppression, unsafeAssertion, jsInTsProject];
