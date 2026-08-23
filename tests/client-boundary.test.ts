import { afterEach, describe, expect, it } from 'vitest';
import { TempProject } from './temp-project.js';
import { findingsFor } from './helpers.js';
import { isSecretEnvName } from '../src/architecture/client-boundary.js';
import { resolveGuidance } from '../src/guidance/guidance.js';
import { numberFindings } from '../src/output/issue.js';
import type { Finding } from '../src/core/types.js';

/**
 * The client/server boundary.
 *
 * Two failure modes matter here and they pull against each other. Missing a
 * leak means a credential ships to every visitor. Reporting one that is not
 * real — a Server Action, a type import, a publishable key — teaches people
 * that this rule cries wolf, and then the real one goes unread too. Roughly
 * half the tests below exist for the second case.
 */

let project: TempProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

const PACKAGE = '{"name":"t","dependencies":{"next":"14.0.0","react":"18.0.0"}}';

const SECRET = 'next/secret-in-client-bundle';
const SERVER_MODULE = 'next/server-module-in-client-bundle';
const DIRECT = 'next/server-import-in-client';

const leaks = (findings: Finding[], id: string): Finding[] => findingsFor(findings, id);

describe('secrets reaching the browser', () => {
  it('follows imports through a helper to the module holding the secret', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'const url = process.env.DATABASE_URL!;\nexport const query = () => [url];\n',
      'lib/user.ts': "import { query } from './db';\nexport const findUser = () => query();\n",
      'components/Profile.tsx':
        "'use client';\nimport { findUser } from '../lib/user';\nexport function Profile() { return <div>{String(findUser())}</div>; }\n",
    });

    const { result } = await project.analyze();
    const found = leaks(result.findings, SECRET);

    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    expect(found[0]!.file).toBe('components/Profile.tsx');
    // The chain is the finding: knowing a secret is reachable is useless
    // without knowing which import to delete.
    expect(found[0]!.current).toEqual(['components/Profile.tsx', 'lib/user.ts', 'lib/db.ts']);
    expect(found[0]!.detail?.[0]).toContain('components/Profile.tsx → lib/user.ts → lib/db.ts');
    expect(found[0]!.detail).toContain('reads process.env.DATABASE_URL');
  });

  it('reports the shortest route when several reach the same module', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'export const url = process.env.STRIPE_SECRET_KEY!;\n',
      'lib/short.ts': "import { url } from './db';\nexport const a = () => url;\n",
      'lib/long-a.ts': "import { b } from './long-b';\nexport const a2 = b;\n",
      'lib/long-b.ts': "import { url } from './db';\nexport const b = () => url;\n",
      'components/Both.tsx':
        "'use client';\nimport { a } from '../lib/short';\nimport { a2 } from '../lib/long-a';\nexport function Both() { return <div>{String(a) + String(a2)}</div>; }\n",
    });

    const { result } = await project.analyze();
    const found = leaks(result.findings, SECRET);

    // One problem, not one per route.
    expect(found).toHaveLength(1);
    expect(found[0]!.current).toEqual(['components/Both.tsx', 'lib/short.ts', 'lib/db.ts']);
  });

  it('flags a client component that reads the secret itself, with the line', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Bad.tsx':
        "'use client';\n\nconst key = process.env.API_SECRET_KEY;\nexport function Bad() { return <div>{key}</div>; }\n",
    });

    const { result } = await project.analyze();
    const found = leaks(result.findings, SECRET);

    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(3);
    expect(found[0]!.title).toContain('reads a secret');
  });

  it("reads a secret written as process.env['NAME'] too", async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Bracket.tsx':
        "'use client';\nexport const t = process.env['GITHUB_TOKEN'];\nexport function B() { return <i>{t}</i>; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(1);
  });

  it('ranks the leak above everything else on the screen', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'export const url = process.env.DATABASE_URL!;\n',
      'components/Leak.tsx':
        "'use client';\nimport { url } from '../lib/db';\nexport function Leak() { return <div>{url}</div>; }\n",
      'src/huge.ts': `${Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
    });

    const { result } = await project.analyze();
    const [first] = numberFindings(result.findings);

    expect(first?.id).toBe(SECRET);
    expect(first?.number).toBe(1);
  });

  it('explains the consequence and says to rotate the key', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Bad.tsx':
        "'use client';\nexport const k = process.env.API_SECRET_KEY;\nexport function Bad() { return <i>{k}</i>; }\n",
    });

    const { result } = await project.analyze();
    const guidance = resolveGuidance(leaks(result.findings, SECRET)[0]!);

    expect(guidance.why).toContain('visitor can read');
    // The code fix is not the whole fix: a deployed secret is already public.
    expect(guidance.risk.toLowerCase()).toContain('rotate');
    expect(guidance.verify).toContain('search');
  });
});

describe('what must never be reported', () => {
  it('leaves Server Actions alone', async () => {
    // A "use server" module is called over the network, not bundled. Flagging
    // this would condemn the standard, correct Next.js pattern.
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'export const url = process.env.DATABASE_URL!;\nexport const q = () => url;\n',
      'actions/save.ts':
        "'use server';\nimport { q } from '../lib/db';\nexport const save = async () => q();\n",
      'components/Save.tsx':
        "'use client';\nimport { save } from '../actions/save';\nexport function Save() { return <button onClick={() => save()} />; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
    expect(leaks(result.findings, SERVER_MODULE)).toHaveLength(0);
  });

  it('ignores type-only imports, which are erased before bundling', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts':
        'export const url = process.env.DATABASE_URL!;\nexport type Row = { id: string };\n',
      'components/Typed.tsx':
        "'use client';\nimport type { Row } from '../lib/db';\nexport function Typed({ r }: { r: Row }) { return <div>{r.id}</div>; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });

  it('leaves variables the bundler is designed to publish', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Public.tsx': `'use client';
export function Public() {
  return (
    <div>
      {process.env.NEXT_PUBLIC_STRIPE_KEY}
      {process.env.VITE_API_TOKEN}
      {process.env.PUBLIC_AUTH_URL}
      {process.env.NODE_ENV}
    </div>
  );
}
`,
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });

  it('says nothing about environment variables that are just configuration', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Conf.tsx':
        "'use client';\nexport function Conf() { return <div>{process.env.APP_NAME}{process.env.LOG_LEVEL}</div>; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });

  it('says nothing about server components, which are supposed to read secrets', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'export const url = process.env.DATABASE_URL!;\n',
      'app/page.tsx':
        "import { url } from '../lib/db';\nexport default function Page() { return <div>{url.length}</div>; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });

  it('does not report one problem twice when a module is both risks at once', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts':
        "import pg from 'pg';\nexport const url = process.env.DATABASE_URL!;\nexport const c = () => pg;\n",
      'lib/user.ts': "import { c } from './db';\nexport const u = c;\n",
      'components/P.tsx':
        "'use client';\nimport { u } from '../lib/user';\nexport function P() { return <div>{String(u)}</div>; }\n",
    });

    const { result } = await project.analyze();

    // The secret is the more serious half, and one fix addresses both.
    expect(leaks(result.findings, SECRET)).toHaveLength(1);
    expect(leaks(result.findings, SERVER_MODULE)).toHaveLength(0);
  });

  it('does not repeat the direct-import finding as a chain', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Direct.tsx':
        "'use client';\nimport fs from 'node:fs';\nexport function D() { return <div>{String(fs)}</div>; }\n",
    });

    const { result } = await project.analyze();

    expect(leaks(result.findings, DIRECT)).toHaveLength(1);
    expect(leaks(result.findings, SERVER_MODULE)).toHaveLength(0);
  });

  it('ignores test files', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/db.ts': 'export const url = process.env.DATABASE_URL!;\n',
      'components/Widget.test.tsx':
        "'use client';\nimport { url } from '../lib/db';\nit('works', () => expect(url).toBeDefined());\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });
});

describe('server-only modules reaching the browser', () => {
  it('follows a chain to a module that imports a server-only package', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/files.ts':
        "import fs from 'node:fs';\nexport const read = () => fs.readFileSync('x');\n",
      'lib/report.ts': "import { read } from './files';\nexport const report = () => read();\n",
      'components/Report.tsx':
        "'use client';\nimport { report } from '../lib/report';\nexport function R() { return <div>{String(report())}</div>; }\n",
    });

    const { result } = await project.analyze();
    const found = leaks(result.findings, SERVER_MODULE);

    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    expect(found[0]!.current).toEqual(['components/Report.tsx', 'lib/report.ts', 'lib/files.ts']);
  });

  it("believes a module that declares itself with 'server-only'", async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/secrets.ts': "import 'server-only';\nexport const load = () => ({});\n",
      'components/S.tsx':
        "'use client';\nimport { load } from '../lib/secrets';\nexport function S() { return <div>{String(load())}</div>; }\n",
    });

    const { result } = await project.analyze();
    const found = leaks(result.findings, SERVER_MODULE);

    expect(found).toHaveLength(1);
    expect(found[0]!.detail?.[1]).toContain('server-only');
  });
});

describe('the walk itself', () => {
  it('terminates on a cycle instead of chasing it', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'lib/a.ts': "import { b } from './b';\nexport const a = () => b;\n",
      'lib/b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      'components/C.tsx':
        "'use client';\nimport { a } from '../lib/a';\nexport function C() { return <div>{String(a)}</div>; }\n",
    });

    const { result } = await project.analyze();
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
    expect(result.metrics.overall).toBeGreaterThan(0);
  });

  it('can be switched off like any other rule', async () => {
    project = TempProject.create({
      'package.json': PACKAGE,
      'components/Bad.tsx':
        "'use client';\nexport const k = process.env.API_SECRET_KEY;\nexport function B() { return <i>{k}</i>; }\n",
    });

    const { result } = await project.analyze({ rules: { [SECRET]: 'off' } });
    expect(leaks(result.findings, SECRET)).toHaveLength(0);
  });
});

describe('which names count as secret', () => {
  it('recognises the shapes people actually use', () => {
    for (const name of [
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'GITHUB_TOKEN',
      'SMTP_PASSWORD',
      'JWT_SIGNING_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'AWS_PRIVATE_KEY',
      'SENTRY_DSN',
      'OPENAI_API_KEY',
      'SLACK_WEBHOOK_URL',
      'NEXTAUTH_SECRET',
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it('lets through what the bundler is meant to publish', () => {
    for (const name of [
      'NEXT_PUBLIC_STRIPE_KEY',
      'PUBLIC_API_TOKEN',
      'VITE_AUTH_DOMAIN',
      'REACT_APP_API_KEY',
      'EXPO_PUBLIC_TOKEN',
      'NUXT_PUBLIC_SECRET_HANDSHAKE',
      'NODE_ENV',
      'VERCEL_URL',
      'PORT',
      'APP_NAME',
      'LOG_LEVEL',
      'FEATURE_FLAGS',
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});
