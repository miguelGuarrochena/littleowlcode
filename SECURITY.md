# Security Policy

## What Little Owl Code does with your code

Little Owl Code runs against source code, so it is worth stating plainly what it does and does not
do.

**It does not:**

- send your source code, findings, metrics or file names anywhere
- collect telemetry or usage analytics of any kind
- require or accept an API key
- call any AI service
- make any network request during analysis
- modify your application source code
- run `git commit`, `git add`, `git checkout`, `git push`, or any other write operation

**It does:**

- read files in the directory you point it at
- run read-only `git` subcommands (`status`, `diff`, `rev-parse`, `merge-base`, `show`,
  `ls-files`, `symbolic-ref`) to work out what changed
- write to a single directory: `.little-owl/` (configuration, baseline, local history, parse cache)

The analysis works fully offline. If you disconnect the network, nothing changes.

`.little-owl/config.ts` is executed as code when it is loaded, in the same way as any other
JavaScript tooling configuration. Treat it exactly like `vite.config.ts` or `eslint.config.js`: only
run Little Owl in a repository you trust.

## Supported versions

Security fixes are applied to the latest published minor version.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through
[GitHub Security Advisories](https://github.com/littleowlcode/little-owl-code/security/advisories/new),
or by email to `security@littleowlcode.com`.

Please include:

- a description of the issue and its impact
- steps to reproduce, ideally with a minimal project
- the version of Little Owl Code and of Node.js you used

You can expect an acknowledgement within 5 working days and an assessment within 15. If the report is
valid, we will agree a disclosure timeline with you and credit you in the advisory unless you prefer
otherwise.

## Scope

In scope: anything that lets Little Owl Code write outside `.little-owl/`, execute code the user did
not intend to run, exfiltrate data, or perform a git write operation.

Out of scope: vulnerabilities in the projects Little Owl analyses (it is not a security scanner —
use your package manager's audit command for that), and findings it reports or fails to report.
