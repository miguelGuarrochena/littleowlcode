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

/**
 * A `"use client"` module importing a server-only *package*.
 *
 * Importing a `"use server"` module is deliberately not reported. That is the
 * Server Actions pattern working exactly as designed: the directive exists so
 * client components can call the module, and the bundler replaces the import
 * with an RPC reference rather than shipping the server code. Flagging it told
 * Next.js developers their standard login form was broken, which is both wrong
 * and the fastest way to lose their trust in everything else here.
 */
const serverImportInClient: Rule = {
  id: 'next/server-import-in-client',
  category: 'architecture',
  description: 'A "use client" module importing a package that only runs on the server.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.meta['useClient'] !== true) continue;

      const direct = (file.meta['serverOnlyImports'] as string[] | undefined) ?? [];
      if (direct.length === 0) continue;

      const finding = createFinding(this, context, {
        file: file.path,
        title: 'Client component imports a server-only package',
        message:
          `${file.path} is marked "use client" but imports ${direct.join(', ')}, which only runs ` +
          'on the server. This either fails at build time or pulls server code into the browser bundle.',
        detail: direct.map((name) => `imports ${name}`),
        suggestion:
          'Move the work into a server component or a server action, and pass the result down as props.',
        key: [...direct],
        current: [...direct],
      });
      if (finding) findings.push(finding);
    }

    return findings;
  },
};

export const frameworkRules: Rule[] = [effectDependencyRisk, serverImportInClient];
