import type { Finding } from '../core/types.js';
import { createFinding, type AnalysisContext, type Rule } from '../core/context.js';
import {
  describeChain,
  findClientLeaks,
  serverOnlyPackages,
  type ClientLeak,
  type ServerOnlyReason,
} from '../architecture/client-boundary.js';

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
 * A `"use client"` module importing a server-only *package* directly.
 *
 * Kept separate from the reachability rule below because it is a different
 * conversation: this one is a single import statement someone can look at and
 * delete, and it is usually caught by the build. The indirect case is the one
 * that ships.
 *
 * Importing a `"use server"` module is deliberately not reported, here or
 * anywhere else in this file. That is the Server Actions pattern working
 * exactly as designed: the directive exists so client components can call the
 * module, and the bundler replaces the import with an RPC reference rather than
 * shipping the server code. Flagging it told Next.js developers their standard
 * login form was broken, which is both wrong and the fastest way to lose their
 * trust in everything else here.
 */
const serverImportInClient: Rule = {
  id: 'next/server-import-in-client',
  category: 'architecture',
  description: 'A "use client" module importing a package that only runs on the server.',
  run(context) {
    const findings: Finding[] = [];

    for (const file of context.files) {
      if (file.meta['useClient'] !== true) continue;

      const direct = serverOnlyPackages(file);
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

/**
 * Server-only code a client component can reach *through* other modules.
 *
 * The direct rule above catches `import { db } from 'pg'` in a component. It
 * catches nothing at all in the shape this actually takes:
 *
 *   ProfileCard.tsx  ("use client")
 *        ↓ imports
 *   lib/user.ts
 *        ↓ imports
 *   lib/db.ts        (reads process.env.DATABASE_URL)
 *
 * Every one of those imports is reasonable on its own, no file mentions the
 * browser, and the whole chain is compiled into JavaScript that any visitor can
 * open and read. There is no way to see it by reading a diff, and it is exactly
 * the kind of thing an assistant produces when asked to "reuse the existing
 * helper" — which is why it belongs in this tool rather than in a linter.
 *
 * Two rules come out of the same walk, split by what is at the end of the
 * chain. A leaked credential and a build error are not the same problem and
 * should not share a priority, a message, or a fix.
 */
const secretInClientBundle: Rule = {
  id: 'next/secret-in-client-bundle',
  category: 'architecture',
  description: 'A client component that can reach code reading a secret from the environment.',
  run(context) {
    return present(
      leaksBy(context, 'secret').map((leak) => {
        const secrets = leak.reasons.find((reason) => reason.kind === 'secret')!;
        const names = secrets.names.slice(0, 4);
        const direct = leak.chain.length === 1;

        return createFinding(this, context, {
          file: leak.client,
          ...(direct && secrets.line ? { line: secrets.line } : {}),
          title: direct
            ? 'Client component reads a secret from the environment'
            : 'A secret can reach the browser through this component',
          message:
            `${leak.client} runs in the browser. ` +
            (direct
              ? `It reads ${names.join(', ')} from the environment, so the value is compiled into the page and anyone can read it.`
              : `Following its imports reaches ${leak.target}, which reads ${names.join(', ')} from the environment. ` +
                'Everything on that path is compiled into the page, so the value ships to every visitor.'),
          detail: [
            describeChain(leak.chain),
            ...secrets.names.slice(0, 6).map((name) => `reads process.env.${name}`),
          ],
          suggestion:
            'Read the secret on the server only, and pass the result the browser is allowed to see down as props.',
          key: [leak.target, ...names],
          current: leak.chain,
        });
      }),
    );
  },
};

/** The same walk, ending at a package that cannot run in a browser at all. */
const serverModuleInClientBundle: Rule = {
  id: 'next/server-module-in-client-bundle',
  category: 'architecture',
  description: 'A client component that can reach a module importing server-only packages.',
  run(context) {
    return present(
      leaksBy(context, 'package')
        // A component importing the package itself is the rule above's finding.
        // Reporting it twice makes one problem look like two.
        .filter((leak) => leak.chain.length > 1)
        .map((leak) => {
          const packages = leak.reasons.find((reason) => reason.kind === 'package')!.names;
          const names = packages.slice(0, 4);

          return createFinding(this, context, {
            file: leak.client,
            title: 'Server-only code can reach the browser through this component',
            message:
              `${leak.client} runs in the browser. Following its imports reaches ${leak.target}, ` +
              `which uses ${names.join(', ')} — code that only works on a server. This either breaks ` +
              'the build or ships server code to every visitor.',
            detail: [
              describeChain(leak.chain),
              ...names.map((name) => `${leak.target} imports ${name}`),
            ],
            suggestion:
              'Break the chain: do the work in a server component or a server action, and pass the result down as props.',
            key: [leak.target, ...names],
            current: leak.chain,
          });
        }),
    );
  },
};

/** Drops the entries `createFinding` returned as `null` because the rule is off. */
const present = (findings: Array<Finding | null>): Finding[] =>
  findings.filter((finding): finding is Finding => finding !== null);

/**
 * Leaks whose deepest reason is of `kind`, computed once per analysis.
 *
 * A module that both reads a secret and imports `pg` is one problem, not two,
 * so the secret wins — it is the more serious half and the fix addresses both.
 */
const leaksBy = (context: AnalysisContext, kind: ServerOnlyReason['kind']): ClientLeak[] => {
  const worst = (leak: ClientLeak): ServerOnlyReason['kind'] =>
    leak.reasons.some((reason) => reason.kind === 'secret') ? 'secret' : 'package';
  return findClientLeaks(context).filter((leak) => worst(leak) === kind);
};

export const frameworkRules: Rule[] = [
  effectDependencyRisk,
  serverImportInClient,
  secretInClientBundle,
  serverModuleInClientBundle,
];
