# Exploring a codebase

Five commands for understanding code rather than judging it. They are the ones
to reach for when you have just opened an unfamiliar repository, or when you are
about to change something and want to know what you are standing on.

All of them are read-only and work offline.

## `little-owl map`

A first orientation. Where is everything, what depends on what, and what should
you read first?

```bash
little-owl map
```

```
61 files, 9,473 lines, 266 internal imports

START HERE

  1. src/cli/
  2. src/core/
  3. src/output/

Areas

  src/cli                      13 files, 2,153 lines
  src/rules                    8 files, 1,171 lines  ←3
  src/core                     6 files, 939 lines  ←64

Entry points

  src/cli/cli.ts
  src/index.ts

Most depended on

  src/core/types.ts                        38 dependents
  src/core/context.ts                      19 dependents

External services

  • Stripe (stripe)
  • PostgreSQL (pg)
```

The `←` number is how many imports cross into that area from outside it. A high
number means a lot of the codebase leans on it.

**START HERE** is ordered by where execution begins and then by how much depends
on each area — not alphabetically. In a layered project it follows the layers
top-down.

External services are recognised from well-known packages (Stripe, Supabase,
Prisma, AWS, Redis, and others). Anything unrecognised simply does not appear;
the map never guesses at what a package does.

## `little-owl explain <file>`

Code archaeology: _why does this file exist?_

```bash
little-owl explain src/services/PaymentService.ts
```

```
src/services/PaymentService.ts

Evidence: strong

Introduced in 3f9a1c2 (about 7 months ago): "Add refund handling to fix
duplicate Stripe webhooks".
It has been touched in 14 commits.
6 files import it today.
2 test files reach it.

Commits that explain why
  • Add refund handling to fix duplicate Stripe webhooks (3f9a1c2, 2026-01-14)
  • Fix refund retry when Stripe returns 409 (a71b0e4, 2026-03-02)

Used by
  src/app/api/refunds/route.ts
  src/services/orders.ts

Usually changes alongside
  src/lib/stripe.ts (7 shared commits)

→ 6 modules depend on this. Changing its interface is a wide change — run
`little-owl impact` first.
```

Everything comes from evidence already in the repository: the commit that
introduced the file, commit messages that state a reason, who has maintained it,
what changes alongside it, and who imports it today.

**It never invents history.** The `Evidence` line tells you how much there is:

| Evidence  | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `strong`  | The introducing commit is known _and_ commit messages explain a reason |
| `partial` | There is history, but nothing that says why                            |
| `none`    | Not a git repository, or the file has never been committed             |

When the history is silent, the report says so rather than constructing a
plausible story. A confident wrong explanation is worse than no explanation.

"Usually changes alongside" is coupling the import graph cannot see: two files
that keep moving together are related whether or not they import each other.

## `little-owl dead-code`

Files nothing appears to reach.

```bash
little-owl dead-code
little-owl dead-code --min-confidence high
```

```
3 candidates — nothing in the project imports them.

HIGH CONFIDENCE  (1)

  src/lib/legacyFormatter.ts 84 lines
    ✓ nothing in the project imports it
    ✓ it exports nothing

MEDIUM CONFIDENCE  (2)

  src/lib/oldHelpers.ts 42 lines
    ✓ nothing in the project imports it
    ⚠ but it exports 3 names
```

Confidence is the whole point of this command. Static reachability cannot see
everything, so each candidate lists what supports the conclusion (`✓`) and what
undermines it (`⚠`):

- **high** — nothing imports it, it exports nothing, and no escape hatch applies
- **medium** — one caveat, usually that it exports names something could import
- **low** — several caveats, for example unresolved dynamic imports in the project

Never reported at all:

- framework convention files — `page.tsx`, `route.ts`, `layout.tsx`,
  `middleware.ts`, `+page.svelte`, `__init__.py`, `urls.py`, and similar
- anything under `pages/`, `app/`, `api/`, `routes/`, `migrations/`, `scripts/`,
  `bin/`, `cmd/`

### Unused exports

The same command also names exports that nothing imports, for files that are
otherwise in use:

```
UNUSED EXPORTS
7 names exported from files that are otherwise in use.

  src/lib/format.ts high
    formatOrdinal, parseLoosely

  src/lib/session.ts medium
    ⚠ test files are not counted as usage
    refreshToken
```

This is deliberately narrower than the file-level search:

- Only TypeScript and JavaScript. Python and Go export detection is too shallow
  to claim nobody uses a name.
- Only files something already imports. A file nothing imports is reported
  whole, above.
- Nothing at all is said about a module reached through `import * as ns`,
  `export * from`, `require()` or a dynamic import — those take everything and
  leave no record of which name was wanted.

Often the fix is just deleting the `export` keyword: the value may still be used
inside its own file.

- files named as entry points by `package.json` (`main`, `bin`, `exports`)
- test files, unless you pass `--include-tests`

If the project contains a dynamic import whose specifier is built at runtime
(`import(\`./plugins/${name}\`)`), confidence is capped across the whole run,
because such an import could reach anything.

**Little Owl never deletes anything.** Even at high confidence, check before
removing code.

## `little-owl tests`

Behaviour that no test appears to watch.

```bash
little-owl tests
little-owl tests --changed        # only what this change touched
```

```
56 test files reaching 65 modules

✗ NO TEST REACHES THESE  (12)

  src/app/api/avisos/route.ts
    POST() has 20 branches
    exports: POST

⚠ REACHED, BUT SOME BEHAVIOUR LOOKS UNTESTED  (23)

  src/lib/auth/store.ts
    tested by: src/tests/session.test.ts
    ✗ empresaOperativaId()
    ✗ rolEfectivoDe()
```

Two levels:

- **No test reaches these** — following imports from every test file, nothing
  arrives at this module. Reliable.
- **Reached, but some behaviour looks untested** — a test imports it, directly or
  transitively, but never names a particular export. Weaker: a test can exercise
  code without writing its name, so this only ever downgrades to "partial".

Modules with no logic worth testing are skipped: pure re-exports, type-only
files, and code that is not normally unit tested — build config, `scripts/`,
`bin/`, migrations and stories.

`--changed` narrows the report to the files in the current git change, which is
the version to run before opening a pull request.

This is a **risk signal, not a coverage report**. Little Owl does not run your
tests. For real coverage numbers, use a coverage tool.

## `little-owl doctor`

Is Little Owl set up to see this project properly?

```bash
little-owl doctor
```

```
🦉 Little Owl doctor

✓ Node.js              v20.11.0 (needs >= 18.18)
✓ Project type         typescript · Next.js, React
✓ Git                  available — review, drift and archaeology all work
ℹ Configuration        using defaults — run `little-owl init` to declare your layers
ℹ Baseline             none yet — run `little-owl baseline`
✓ Files analysed       294 files in 103ms
⚠ Import resolution    18 imports unresolved — usually a path alias missing from tsconfig
✓ Architecture         ui → application (inferred)
✓ Tests                56 test files found
```

Every check is about Little Owl's own ability to do its job, not about the
quality of your code. Run it when the output looks wrong — unresolved imports and
undetected layers are the two things that most often make findings incomplete.

`⚠` marks something that limits what Little Owl can see. `ℹ` marks something
optional you have not set up yet.
