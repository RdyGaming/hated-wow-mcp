## What this changes

<!-- One or two sentences. If it fixes an open issue, "Fixes #123". -->

## Why

<!-- The problem it solves. Skip if it is obvious from the above. -->

## How it was checked

<!--
The most useful thing you can put here is tool output before and after.
Delete the lines that do not apply.
-->

- [ ] `npm run build` passes
- [ ] `npm test` passes (65 checks, needs a completed `sync-all`)
- [ ] Tried it through an MCP client, not just the tests
- [ ] Verified against the game or Blizzard's source, if this changes what a tool reports

## Notes

<!--
Anything a reviewer should know: a flavor you could not test, a tradeoff you
made, a follow-up you are deliberately leaving out.
-->

---

<!--
A few things that will come up in review, worth checking now:

- No Blizzard-derived source or art committed. Heavy data is synced from public
  mirrors on the user's machine, never redistributed here — see CONTRIBUTING.md.
- Nothing writes inside the package directory. Synced data goes through
  `cacheRoot()` in src/paths.ts, or `npx` installs break.
- New tools have a description that tells a model when to call them, a failure
  path that suggests a next step, and a smoke test.
- Comments explain why, not what.
-->
