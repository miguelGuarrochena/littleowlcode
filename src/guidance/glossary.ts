/**
 * Short definitions for the words Little Owl cannot avoid using.
 *
 * The audience for this tool includes people who shipped a real application
 * without ever having read a definition of "cyclomatic complexity". A report
 * they cannot read is a report that does not help them, so any term that could
 * stop someone mid-sentence gets one clause of explanation the first time it
 * appears — never a lecture, and never a link they have to go and read.
 */
export const GLOSSARY: Record<string, string> = {
  layer:
    'A layer is a level of your app — screens on top, business logic in the middle, database at the bottom. Code should call downwards, not upwards.',
  'circular dependency':
    'Two files that each need the other to load first. Nothing can start cleanly, and tools get confused about the order.',
  complexity:
    'How many different paths run through a piece of code. More paths means more ways for it to go wrong and more cases to test.',
  'dependency graph':
    'The map of which file imports which. Little Owl builds it from your code, nothing is guessed.',
  baseline:
    'A saved snapshot of your project. Later runs compare against it, so you see what changed rather than everything at once.',
  drift: 'How far the project has moved away from the baseline snapshot.',
  any: '`any` in TypeScript switches off type checking for that value, so typos and wrong shapes stop being caught.',
  'type assertion':
    'Code that tells TypeScript "trust me, this is that type". If you are wrong, nothing catches it.',
  'server-only code':
    'Code meant to run on your server — database access, secret keys. It must never end up in the browser.',
  'client component':
    'A file marked "use client" in Next.js. It runs in the browser, so anything it imports gets sent to the browser too.',
  'client bundle':
    'The JavaScript your app sends to the browser. Anyone visiting your site can open it and read every line, including any values baked into it.',
  'server action':
    'A function in a file marked "use server". A client component can call it, but the code runs on your server — only the arguments and the result travel over the network.',
  'environment variable':
    'A value configured outside your code, read with process.env. Some are meant to be public; the ones holding keys and passwords are not.',
  'dependency array':
    'The list in the second argument of useEffect that tells React when to re-run it. Without one, it runs after every single render.',
  'dead code': 'Files nothing else imports. They are usually leftovers from an earlier version.',
  'entry point': 'A file your app actually starts from, like a page, a route, or a script.',
  scope: 'The part of the project a change was supposed to touch.',
  'source lines': 'Lines of real code, not counting blanks and comments.',
  strictness:
    'How picky Little Owl is. Relaxed reports only clear structural problems, strict reports everything.',
};

/**
 * How to spot a term in prose.
 *
 * Substring matching is not good enough here: "any" appears inside "many",
 * "company" and the phrase "any one of these files", and an explanation of
 * TypeScript's `any` attached to a sentence about circular dependencies makes
 * the reader doubt everything else on the screen. Short terms therefore only
 * count when they appear in the form the text actually uses for them.
 */
const PATTERNS: Record<string, string> = {
  any: '`any`',
};

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The glossary keys mentioned anywhere in `text`, longest match first. */
export const termsIn = (text: string): string[] =>
  Object.keys(GLOSSARY)
    .filter((term) => {
      const needle = PATTERNS[term] ?? term;
      // `\b` only means anything next to a word character, so a needle wrapped
      // in backticks has to be matched without it at that end.
      const start = /^\w/.test(needle) ? '\\b' : '';
      const end = /\w$/.test(needle) ? '\\b' : '';
      return new RegExp(`${start}${escape(needle)}${end}`, 'i').test(text);
    })
    .sort((a, b) => b.length - a.length);

export const defineTerm = (term: string): string | undefined => GLOSSARY[term.toLowerCase()];
