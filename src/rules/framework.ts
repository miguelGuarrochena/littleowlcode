import type { Finding } from '../core/types.js';
import { createFinding, type Rule } from '../core/context.js';

const effectDependencyRisk: Rule = {
  id: 'react/effect-dependency-risk',
  category: 'maintainability',
  description: 'useEffect calls with no dependency array, which re-run every render.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.isTest) continue;
      const lines = (file.meta['effectsWithoutDeps'] as number[] | undefined) ?? [];
      if (lines.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        line: lines[0]!,
        title: `${lines.length} effect${lines.length === 1 ? '' : 's'} with no dependency array`,
        message:
          `${file.path} calls useEffect without a dependency array ${lines.length} time${lines.length === 1 ? '' : 's'}. ` +
          'Those effects run after every render, which is occasionally intended and usually not.',
        detail: [`lines: ${lines.slice(0, 8).join(', ')}`],
        suggestion:
          'Add the dependency array. If it really should run every render, say so in a comment.',
        current: lines.length,
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

const serverImportInClient: Rule = {
  id: 'next/server-import-in-client',
  category: 'architecture',
  description: 'Server-only code reachable from a "use client" module.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.meta['useClient'] !== true) continue;

      const direct = (file.meta['serverOnlyImports'] as string[] | undefined) ?? [];
      const viaServerModule = context.graph
        .dependenciesOf(file.path)
        .filter((dependency) => context.fileMap.get(dependency)?.meta['useServer'] === true);

      if (direct.length === 0 && viaServerModule.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        title: 'Client component reaches server-only code',
        message:
          `${file.path} is marked "use client" but imports code that only runs on the server. ` +
          'This either fails at build time or silently ships server code to the browser.',
        detail: [
          ...direct.map((name) => `imports ${name}`),
          ...viaServerModule.map((name) => `imports ${name} ("use server")`),
        ],
        suggestion:
          'Move the server work into a server component or a server action, and pass the result down as props.',
        key: [...direct, ...viaServerModule],
        current: [...direct, ...viaServerModule],
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

export const frameworkRules: Rule[] = [effectDependencyRisk, serverImportInClient];
