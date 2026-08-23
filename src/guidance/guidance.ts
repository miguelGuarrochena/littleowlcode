import type { Finding } from '../core/types.js';
import { termsIn } from './glossary.js';

/**
 * The plain-language layer over the rule engine.
 *
 * A rule knows that `src/lib/db/client.ts` imports `src/app/page.ts` and that
 * this inverts the layering. That sentence is useless to someone who built
 * their app by asking an assistant for features. This table answers, for every
 * rule, the four questions a person actually has: what happened, why should I
 * care, what should it look like instead, and what do I do about it.
 *
 * Rules with no entry still work — `resolve` falls back to the finding's own
 * message and suggestion — so adding a rule never means the report goes blank.
 */

export interface RuleGuidance {
  /** Plain-language restatement of the finding. Defaults to the rule message. */
  what?: (finding: Finding) => string;
  /** Consequence in terms of the running application, not of the code. */
  why: string;
  /** The behaviour or shape the project should have instead. */
  expected: string;
  /** Concrete recommended fix. Defaults to the finding's own suggestion. */
  fix?: string;
  /** How to know the fix worked, beyond "the warning went away". */
  verify?: string;
  /** What could go wrong while fixing it. Written for whoever does the work. */
  risk?: string;
}

export interface ResolvedGuidance {
  what: string;
  why: string;
  expected: string;
  fix: string;
  verify: string;
  risk: string;
  /** Glossary terms that appear in the text above, in the order to explain them. */
  terms: string[];
}

const subject = (finding: Finding): string => finding.title.replace(/ (is|has|contains) .*/, '');

export const RULE_GUIDANCE: Record<string, RuleGuidance> = {
  'architecture/circular-dependency': {
    what: (finding) =>
      `Some of your files depend on each other in a loop: ${finding.detail?.[0] ?? finding.title}. Each one needs the other to load first.`,
    why: 'A loop like this makes the app fragile in ways that are hard to trace. You can get undefined values at startup for no visible reason, tests start depending on import order, and moving any one of these files tends to break the others.',
    expected:
      'Dependencies should flow one way. If two files need the same thing, that thing belongs in a third file both can import.',
    fix: 'Find the piece of code the files are passing back and forth — usually a type, a constant, or one helper function — and move it into its own file. Then have both files import it from there instead of from each other.',
    verify:
      'Run `little-owl verify`. The loop should be gone, and your app should still start and pass its tests.',
    risk: 'Breaking a loop by moving code can change the order things are initialised in. Start the app, not just the tests.',
  },

  'architecture/layer-violation': {
    what: (finding) =>
      `${finding.file ?? 'A file'} sits at a lower level of your app but imports code from a level above it.`,
    why: 'Your app is organised in levels — screens on top, business logic in the middle, data access at the bottom. When a lower level reaches up into a higher one, the bottom of your app starts depending on the top. Changing a screen can then break your database code, which is the opposite of how it should work.',
    expected:
      'Lower-level code should never import higher-level code. It should receive what it needs as arguments instead.',
    fix: 'Remove the upward import. If the lower-level file needs a value from the higher level, pass that value in as a function argument rather than importing it.',
    verify:
      'Run `little-owl verify`. The violation should be gone and nothing about how the feature behaves should have changed.',
  },

  'architecture/layer-skip': {
    what: (finding) =>
      `${finding.file ?? 'A file'} reaches straight past the level directly below it and talks to the one after that.`,
    why: 'A screen talking straight to the database skips whatever the middle layer was doing — permission checks, validation, business rules. That logic silently stops applying on this path, and it is easy to miss because the feature still appears to work.',
    expected:
      'Each level should talk to the one directly below it, so the rules living in between always run.',
    fix: 'Route the call through the layer in between. If no function exists there yet, add one that wraps the lower-level call along with whatever checks belong with it.',
    verify:
      'Run `little-owl verify`, then exercise the feature and confirm the checks in the middle layer actually run.',
  },

  'architecture/cross-feature-import': {
    why: "When one feature reaches into another feature's internals, the two become one thing that has to change together. Later, a small edit inside one feature breaks a screen somewhere else entirely.",
    expected:
      'Features should talk to each other through a small, deliberate entry point — usually an `index` file that exports only what other features are meant to use.',
    fix: "Export what the other feature needs from that feature's entry point, and import it from there instead of reaching into the internal file.",
    verify: 'Run `little-owl verify`. Both features should still work exactly as before.',
  },

  'architecture/forbidden-dependency': {
    why: 'This import is one your own configuration says must never exist. Rules like that are usually there because crossing this particular boundary caused a real problem before.',
    expected: 'These two parts of the project should stay independent of each other.',
    fix: 'Remove the import, or — if the rule is out of date — update the `forbidden` list in `.little-owl/config.ts` and say why in a comment.',
    verify: 'Run `little-owl verify`.',
  },

  'architecture/deep-import-chain': {
    what: (finding) =>
      `Loading ${finding.file ?? 'this file'} pulls in a long chain of other files, one after another.`,
    why: 'A long chain of imports means a change at the bottom quietly reaches a lot of code above it. It also makes the app slower to start, since everything in the chain has to load.',
    expected: 'Shorter chains, where most files depend on only a handful of things.',
    fix: 'Look for a file in the middle of the chain that exists only to pass things along, and let the caller import what it needs directly.',
    verify: 'Run `little-owl verify` and check the chain got shorter.',
  },

  'architecture/unlayered-code': {
    what: () =>
      'Some folders are not described in your configuration, so the boundary checks never looked at them.',
    why: 'Little Owl cannot check boundaries in parts of the project it has not been told about. These files are invisible to the architecture checks — not necessarily wrong, just unwatched.',
    expected:
      'Every folder holding real application code should belong to one of the levels in your config.',
    fix: 'Run `little-owl init --force` to re-detect your structure, or add these folders to `architecture.layers` in `.little-owl/config.ts`.',
    verify: 'Run `little-owl architecture`. Layer coverage should go up.',
  },

  'complexity/large-file': {
    what: (finding) =>
      `${subject(finding)} has grown large enough that it is hard to work with — and hard for an AI assistant to change safely.`,
    why: 'Big files are where bugs hide. When you ask an assistant to change one thing in a file this size, it has to hold the whole file in its head, and it is much more likely to rewrite something you did not ask it to touch.',
    expected:
      'A file should hold one clear responsibility. When you can describe it only with the word "and", it is doing too much.',
    fix: 'Split it along the seams that already exist — group the functions that belong together and move each group into its own file. Do this without changing any behaviour.',
    verify:
      'Run your tests first, split the file, then run them again. They should pass identically. Then run `little-owl verify`.',
  },

  'complexity/large-component': {
    what: (finding) =>
      `${subject(finding)} is a very large component — it is probably doing several jobs at once.`,
    why: 'A component this size usually mixes fetching data, deciding what to show, and drawing it. That makes it hard to change one part without breaking another, and hard to reuse any of it.',
    expected: 'A component should mostly describe what appears on screen.',
    fix: 'Pull the pieces of the screen out into their own smaller components, and move data fetching or calculations into their own functions or hooks.',
    verify:
      'Click through the screen and confirm it looks and behaves the same, then run `little-owl verify`.',
  },

  'complexity/large-function': {
    what: (finding) => `${subject(finding)} is long enough that it is doing more than one job.`,
    why: 'Long functions are hard to test, because you cannot check one part without running all of it. They are also the easiest place for an assistant to introduce a change you did not notice.',
    expected: 'A function should do one thing that you can name in a short sentence.',
    fix: 'Find the distinct steps inside it and pull each one into its own named function. The names become the documentation.',
    verify:
      'Run your tests before and after — the behaviour should be identical. Then run `little-owl verify`.',
  },

  'complexity/high-complexity': {
    what: (finding) =>
      `${subject(finding)} has a lot of separate paths through it — many ifs, loops and conditions stacked together.`,
    why: 'Every path is a case that can behave differently, and a case your tests would need to cover to be sure it works. Code like this is where "it works on my machine" comes from.',
    expected:
      'Fewer branches per function, with the special cases handled and returned early rather than nested.',
    fix: 'Handle the edge cases at the top and return early, then move each group of remaining branches into its own function.',
    verify: 'Run your tests, then `little-owl verify`.',
  },

  'complexity/deep-nesting': {
    what: (finding) =>
      `${subject(finding)} is indented very deeply — conditions inside conditions inside loops.`,
    why: 'Deeply indented code is hard to follow, and it is very easy to attach a condition to the wrong level by accident.',
    expected: 'Two or three levels of indentation inside a function, at most.',
    fix: 'Invert the conditions and return early, so the main path stays at the left edge.',
    verify: 'Run `little-owl verify`.',
  },

  'complexity/too-many-params': {
    what: (finding) => `${subject(finding)} takes a long list of arguments.`,
    why: 'With this many arguments it becomes easy to pass them in the wrong order, and the mistake often still compiles.',
    expected: 'A handful of arguments, or a single object when there are genuinely many values.',
    fix: 'Group the related arguments into one object, so each value is named at the call site.',
    verify: 'Run `little-owl verify` and make sure every caller was updated.',
  },

  'maintainability/duplicate-block': {
    why: 'The same logic in several places means a fix has to be made several times. In practice one of them gets missed, and you end up with two behaviours that were meant to be one.',
    expected: 'Logic that is genuinely the same should live in one place both callers use.',
    fix: 'Move the shared block into one function and call it from each place. If the copies have quietly drifted apart, decide which behaviour is the correct one first.',
    risk: 'The copies may not be identical. Diff them before merging — the differences are sometimes deliberate and sometimes the bug.',
    verify:
      'Run your tests — this is the change most likely to surface a difference you did not know about. Then run `little-owl verify`.',
  },

  'maintainability/unresolved-import': {
    what: (finding) =>
      `${finding.file ?? 'A file'} imports something Little Owl could not find on disk.`,
    why: 'Little Owl could not follow this import to a file. Usually it is a path alias it does not know about, which just means part of the dependency map is missing. Occasionally it is a genuinely broken path that only fails at runtime.',
    expected: 'Every import should point at a file that exists, or at an installed package.',
    fix: 'Check the path is right. If it uses an alias like `@/lib/...`, make sure that alias is declared in `tsconfig.json` under `compilerOptions.paths`.',
    verify: 'Run `little-owl doctor` — import resolution should improve.',
  },

  'type-safety/explicit-any': {
    what: (finding) =>
      `${finding.file ?? 'This file'} uses \`any\`, which switches off type checking for those values.`,
    why: 'TypeScript catches typos and wrong shapes before you run the code. Every `any` is a spot where it stops looking, so a misspelled field silently becomes `undefined` in production instead of a red squiggle in your editor.',
    expected: 'Values should have a real type, even a rough one.',
    fix: 'Replace each `any` with the actual shape. If you do not know it yet, `unknown` is a safe placeholder — it forces you to check before using the value.',
    verify: 'Run your TypeScript check (`npx tsc --noEmit`), then `little-owl verify`.',
  },

  'type-safety/suppression': {
    what: (finding) =>
      `${finding.file ?? 'This file'} has \`@ts-ignore\` or \`@ts-expect-error\` comments, which hide type errors rather than fixing them.`,
    why: 'The error is still there — it is just not being shown to you any more. These comments hide every future error on that line too, including ones nobody has made yet.',
    expected: 'Type errors should be fixed, not silenced.',
    fix: 'Remove the comment, look at the error it was hiding, and fix that. If the suppression really is necessary, use `@ts-expect-error` with a comment explaining why.',
    verify: 'Run `npx tsc --noEmit` and confirm it passes without the suppression.',
  },

  'type-safety/unsafe-assertion': {
    why: 'A cast like `as SomeType` tells TypeScript to trust you instead of checking. If the value is not actually that shape, nothing catches it and the app fails at runtime with a confusing error.',
    expected: 'Types should be proven by the code, not asserted over it.',
    fix: 'Narrow the value with a real check (`if (typeof x === "string")`) or validate it at the boundary where it enters your app.',
    verify: 'Run `npx tsc --noEmit`, then `little-owl verify`.',
  },

  'type-safety/js-in-ts-project': {
    why: 'Plain JavaScript files in a TypeScript project are not type checked, so mistakes in them are only found when the code runs.',
    expected: 'Everything in a TypeScript project should be TypeScript.',
    fix: 'Rename the files to `.ts`/`.tsx` and fix whatever the compiler then reports.',
    verify: 'Run `npx tsc --noEmit`.',
  },

  'react/effect-dependency-risk': {
    what: (finding) =>
      `${finding.file ?? 'This file'} has useEffect calls with no dependency list, so they run again after every single render.`,
    why: 'This is one of the most common causes of infinite loops and duplicated network requests in React apps. If the effect updates state, it triggers another render, which runs the effect again.',
    expected:
      'An effect should declare what it depends on, so React knows when it actually needs to run again.',
    fix: 'Add the dependency array as the second argument: `useEffect(() => { ... }, [thingItUses])`. Use `[]` if it should only run once when the component appears.',
    verify:
      'Open the screen and watch your network tab or console — the effect should fire once, not continuously.',
  },

  'next/server-import-in-client': {
    what: (finding) =>
      `${finding.file ?? 'This file'} runs in the browser but imports code that is only supposed to run on your server.`,
    why: 'This is a real security risk. Server code often holds database credentials or API keys, and anything the browser bundle contains can be read by anyone who visits your site. At best the build fails; at worst your secrets ship to every visitor.',
    expected:
      'Server code stays on the server. The browser receives only the results it is allowed to see.',
    fix: 'Do the work in a server component or a server action and pass the result down as props. Never import the database client, or anything reading `process.env` secrets, from a file marked "use client".',
    verify:
      'Build the app and search the client bundle for the secret value. It must not appear. Then run `little-owl verify`.',
    risk: 'If a secret has already been deployed in a client bundle, treat it as leaked and rotate it. Removing the import does not un-publish what already shipped.',
  },

  'next/secret-in-client-bundle': {
    what: (finding) =>
      finding.detail?.[0]?.includes('→')
        ? `Following the imports out of ${finding.file ?? 'this component'} leads to code that reads a password or key from your environment — and everything on that path is sent to the browser.`
        : `${finding.file ?? 'This component'} runs in the browser and reads a password or key from your environment.`,
    why: 'Anything a browser runs, a visitor can read. They open developer tools, search the page source, and the value is there in plain text — no hacking required. If this is a database URL, an API key or a service credential, treat it as public from the moment the page was deployed.',
    expected:
      'Secrets are read only by code that runs on your server. The browser receives the result of using them, never the values themselves.',
    fix: "Move the work into a server component, a route handler or a server action, and pass only the finished result down as props. If the value genuinely is meant to be public — a publishable key, an analytics id — rename it with your framework's public prefix (in Next.js, `NEXT_PUBLIC_`) so it is obvious to everyone reading the code.",
    verify:
      'Build the app and search the generated client files for the secret value. It must not appear anywhere. Then run `little-owl verify`.',
    risk: 'If this has already been deployed, the secret is out. Rotate it — issue a new key and revoke the old one — before or alongside the code change. Removing the import does not un-publish what visitors already downloaded.',
  },

  'next/server-module-in-client-bundle': {
    what: (finding) =>
      `${finding.file ?? 'This component'} runs in the browser, and following its imports reaches code that only works on a server.`,
    why: 'None of the imports look wrong on their own — a component imports a helper, the helper imports something else. But the browser has to download every file in that chain. At best the build fails with a confusing error about a missing module; at worst your server logic ends up readable by anyone who visits the page.',
    expected:
      'Server code stays on the server. A component in the browser asks for data and receives an answer; it does not contain the machinery that produced it.',
    fix: 'Break the chain at the first link you control. Fetch the data in a server component, a route handler or a server action, and pass the finished result to this component as props.',
    verify:
      'Build the app — it should compile without module-resolution errors — then run `little-owl verify`.',
    risk: 'Check what else imports the module in the middle of the chain. Splitting it is usually the right fix, but other callers may depend on the half you move.',
  },

  'python/bare-except': {
    what: (finding) =>
      `${finding.file ?? 'This file'} catches every possible error with a bare \`except:\`.`,
    why: 'This swallows errors you never meant to handle — including the one that tells you the program should stop. Bugs then show up much later, somewhere unrelated, with no trace of where they came from.',
    expected: 'Catch the specific errors you know how to handle, and let the rest surface.',
    fix: 'Replace `except:` with the specific exception type, for example `except ValueError:`. If you truly need everything, use `except Exception:` and log it.',
    verify: 'Run your tests and confirm real failures still surface.',
  },

  'python/mutable-default': {
    why: 'A list or dict used as a default argument in Python is created once and shared by every call. Values from one call leak into the next, which produces bugs that look impossible.',
    expected: 'Each call should start with its own fresh value.',
    fix: 'Use `None` as the default and create the value inside the function: `def f(items=None): items = items or []`.',
    verify: 'Call the function twice in a row and confirm the second call starts clean.',
  },

  'python/global-state': {
    why: 'Module-level state is shared by everything in the process, so one part of the app can change what another part sees without any visible connection between them.',
    expected: 'State should be passed in explicitly, or held by an object that owns it.',
    fix: 'Move the value into a function argument, a class, or a small container the callers pass around.',
    verify: 'Run your tests, especially any that run in a different order.',
  },

  'go/ignored-error': {
    why: 'An ignored error means the code carries on as if nothing went wrong, using a value that was never filled in. The failure surfaces later somewhere that has no idea what happened.',
    expected: 'Every returned error is either handled or deliberately passed up.',
    fix: 'Check the error and return it, or handle it. If ignoring is genuinely correct, use `_ =` and add a comment saying why.',
    verify: 'Run `go test ./...`.',
  },

  'go/large-package': {
    why: 'A package this size is hard to navigate and hard to reuse, and everything in it recompiles together.',
    expected: 'Packages grouped around one clear responsibility.',
    fix: 'Split it into packages along the lines that already exist in the file names.',
    verify: 'Run `go build ./...` and `little-owl verify`.',
  },

  'patterns/duplicate-helper': {
    what: (finding) =>
      `${finding.title} — the same helper appears to have been written more than once.`,
    why: 'This usually happens when an assistant writes a helper it could not find, because a version already existed somewhere else. Now there are two, they will drift apart, and callers will get different answers depending on which one they happened to import.',
    expected: 'One helper, in one place, that everything uses.',
    fix: 'Keep the better implementation, delete the other, and update its callers to import the one that remains.',
    verify: 'Run your tests, then `little-owl verify`.',
  },

  'patterns/parallel-implementations': {
    why: 'Two versions of the same thing means every future change has to be made twice, and half the time only one of them gets it. This is the single most common way an AI-assisted codebase drifts.',
    expected: 'One implementation the whole project agrees on.',
    fix: 'Decide which one is correct, migrate the callers to it, and delete the other.',
    verify: 'Run your tests, then `little-owl verify`.',
  },

  'patterns/thin-wrapper': {
    why: 'A file that only forwards calls somewhere else adds a step to read through without adding anything.',
    expected: 'Indirection should earn its place by hiding something.',
    fix: 'Have the callers import the real thing directly and delete the wrapper — unless it exists on purpose as a feature entry point.',
    verify: 'Run `little-owl verify`.',
  },

  'patterns/abstraction-growth': {
    why: 'Layers of abstraction are accumulating faster than features. Each one is somewhere else to look when you are trying to find where something actually happens.',
    expected: 'Abstractions added when a second real caller needs them, not before.',
    fix: 'Collapse the layers that have only one caller back into that caller.',
    verify: 'Run `little-owl verify`.',
  },

  'dependencies/major-version-change': {
    why: 'A major version change means the package authors deliberately broke something. Code that worked yesterday can behave differently or stop compiling.',
    expected: 'Major upgrades are done on purpose, with the release notes read.',
    fix: "Read the package's migration guide, run your tests, and click through the parts of the app that use it.",
    verify: 'Run your full test suite and start the app.',
  },

  'dependencies/new-dependency': {
    why: 'Every package is code you now ship, maintain and trust. Assistants add them freely, and the total tends to grow much faster than anyone intended.',
    expected: 'A new dependency is a decision someone made, not something that appeared.',
    fix: 'Check whether you needed it. If a few lines of your own would do, remove it with your package manager.',
    verify: 'Run `little-owl verify` after removing anything you did not want.',
  },

  'dependencies/unused-dependency': {
    why: 'Packages nothing imports still get installed, still slow down installs, and still show up in security scans.',
    expected: 'package.json should list what the project actually uses.',
    fix: 'Remove them with your package manager. If a package is used by tooling rather than imported (config files, CLI scripts), leave it and ignore this note.',
    verify: 'Reinstall and run your build to confirm nothing broke.',
  },

  'dependencies/duplicate-dependency': {
    why: 'The same package listed twice, or at two versions, means the one that actually loads depends on resolution order. Behaviour then differs between machines.',
    expected: 'One entry, one version.',
    fix: 'Keep one entry in `package.json` and reinstall.',
    verify: 'Run your build and tests.',
  },

  'scope/out-of-scope-change': {
    what: (finding) => finding.message,
    why: 'Files changed that were nothing to do with what you asked for. That is usually an assistant tidying up on its way past — sometimes helpful, sometimes a silent behaviour change in a part of the app you were not testing.',
    expected: 'A change touches the area it was meant to touch.',
    fix: 'Look at the diff for each file listed. Keep the edits you want; revert the rest with `git checkout -- <file>`.',
    verify: 'Run `git status` and confirm only the intended files are modified.',
  },
};

/** Generic wording for a rule with no entry above, chosen by category. */
const CATEGORY_FALLBACK: Record<string, { why: string; expected: string; risk?: string }> = {
  architecture: {
    why: 'The shape of the project is drifting away from how it was organised. Small drifts compound until nobody can predict what a change will affect.',
    expected: 'Parts of the app depend on each other in one clear direction.',
    risk: 'Moving code between files changes import paths. Anything importing the old location has to be updated in the same change.',
  },
  complexity: {
    why: 'Code this involved is hard to change safely, both for you and for an AI assistant working on it.',
    expected: 'Smaller pieces, each doing one nameable thing.',
    risk: 'Restructuring is where behaviour changes slip in unnoticed. Run the tests before starting so you know they passed to begin with.',
  },
  maintainability: {
    why: 'This will make future changes slower and more error-prone than they need to be.',
    expected: 'One clear place for each piece of logic.',
  },
  dependencies: {
    why: 'Dependencies are code you ship and maintain, so it is worth knowing exactly which ones you have.',
    expected: 'The packages listed are the packages you use.',
  },
  'type-safety': {
    why: 'Type checking is what catches mistakes before your users do. Where it is switched off, it catches nothing.',
    expected: 'Values have real types the compiler can check.',
  },
  scope: {
    why: 'Changes outside the area you were working in are the ones nobody reviews.',
    expected: 'A change touches only what it was meant to touch.',
  },
  impact: {
    why: 'This change reaches further through the project than it might appear.',
    expected: 'The blast radius of a change is understood before it lands.',
  },
};

const DEFAULT_FALLBACK = {
  why: 'This is worth looking at before it becomes harder to change.',
  expected: 'The project stays predictable as it grows.',
  risk: undefined,
};

const DEFAULT_RISK =
  'Change only what this issue names. Fixing a reported problem and tidying the surrounding code in the same pass makes it impossible to tell which edit caused a regression.';

/** Everything a report needs to explain one finding to a non-expert. */
export const resolveGuidance = (finding: Finding): ResolvedGuidance => {
  const entry = RULE_GUIDANCE[finding.id];
  const fallback = CATEGORY_FALLBACK[finding.category] ?? DEFAULT_FALLBACK;

  const what = entry?.what?.(finding) ?? finding.message;
  const why = entry?.why ?? fallback.why;
  const expected = entry?.expected ?? fallback.expected;
  const fix =
    entry?.fix ??
    finding.suggestion ??
    'Look at the file above and decide whether this is deliberate. If it is, you can turn the rule off in `.little-owl/config.ts`.';
  const verify =
    entry?.verify ?? 'Run `little-owl verify` — this issue should no longer be listed.';
  const risk = entry?.risk ?? fallback.risk ?? DEFAULT_RISK;

  return {
    what,
    why,
    expected,
    fix,
    verify,
    risk,
    terms: termsIn([what, why, expected, fix].join(' ')).slice(0, 2),
  };
};

export const hasGuidance = (ruleId: string): boolean => ruleId in RULE_GUIDANCE;
