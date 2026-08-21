## What does this change?

<!-- One or two sentences. What is different after this PR? -->

## Why?

<!-- What problem does it solve? Link an issue if there is one. -->

## Output before and after

<!--
If this changes anything a user sees — wording, a finding, a score — paste
the before and after. Wording is part of the product.
-->

```
before:

after:
```

## Checklist

- [ ] `pnpm check` passes (typecheck, lint, tests, build)
- [ ] New or changed rules have tests covering both the case that should fire
      and a case that must **not** fire
- [ ] Findings say what happened, where, why it matters, and what to do
- [ ] Nothing writes outside `.little-owl/`, and no network calls were added
- [ ] Docs updated if behaviour or configuration changed
