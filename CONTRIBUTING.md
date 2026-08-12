# Contributing

Thanks for taking a look. This is a small project and PRs are welcome —
especially ones that make the server's answers more accurate, since that is the
entire point of it.

## Getting set up

You need **Node 20+** and **git** on your PATH.

```bash
git clone https://github.com/RdyGaming/hated-wow-mcp.git
cd hated-wow-mcp
npm install
npm run build
npm run sync-all
npm test
```

Before the first `sync-all`, open <https://wago.tools/> once in a browser and
let it load — the atlas step is fetched from there and the site blocks requests
that arrive without a prior visit from the same connection.

`npm test` should report **46 passed, 0 failed**. The tests run against the real
synced data, so they will fail in ways that look alarming if the sync has not
finished.

## How the data works

There are two kinds, and the distinction matters when you touch anything under
`src/sync/`:

- **Bundled** — `data/api-*.json`, `data/ui.xsd`, `data/manifest.json`. These
  are committed and ship inside the npm package. `npm run sync-api` regenerates
  them, and that only works from a git checkout.
- **Synced** — the UI source checkout, the listfile index and the atlas index,
  roughly 70 MB. These are **never committed**. They are built on each user's
  machine by `sync-ui-source` and `sync-game-data`.

`src/paths.ts` decides where synced data lives: beside the source in a checkout,
in the OS cache directory for an installed copy. Nothing may ever write inside
the package directory — that is what makes `npx` installation work.

**Please do not commit Blizzard-derived source or art.** The heavy data is
synced from public upstream mirrors rather than redistributed here, and that is
deliberate. If a change would add Blizzard's files to this repository, it needs
a different design.

## Project layout

```
src/
  config.ts            flavors, interface versions, install detection
  paths.ts             bundled vs. synced data locations
  wowapi/              API index loading, search, rendering
  uisource/            Blizzard UI source index, template/mixin/grep search
  gamedata/            listfile and atlas lookup
  lua/                 tokenizer, analyzer, rule tables
  xml/                 UI.xsd parser, XML validator
  toc/                 .toc parser and validator
  scaffold/            addon generator
  tools/               MCP tool definitions
  sync/                the three sync scripts and their shared entry point
test/smoke.mjs         end-to-end checks against real data
```

## Adding or changing a tool

Tools are defined in `src/tools/*.tools.ts` as plain objects — a name, a config
with a Zod input schema, and a handler. Add yours to the matching file's
exported array and it is registered automatically.

Two things are worth getting right:

- **The description is a prompt.** It is the only thing an AI client reads when
  deciding whether to call your tool. Say what the tool answers and when to
  reach for it, not just what it wraps.
- **Fail with a next step.** When data is missing or a lookup finds nothing, say
  what to run or what to try instead. `dataMissingMessage` exists for this.

If you add a tool, add a smoke test for it in `test/smoke.mjs`.

## Code style

There is no linter to argue with; match what is already there.

The one convention worth stating: **comments explain why, not what.** The
codebase assumes you can read TypeScript. Comments are there for the things the
code cannot say — why a flavor maps onto a different index, why a path is
revalidated instead of re-fetched, why a guard exists. If a comment restates the
line below it, delete it.

Run `npm run build` before pushing; the build is strict and CI runs it.

## Commits and PRs

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat(scope):`, `fix(scope):`, `docs:`, `chore(data):`. Keep the subject in the
imperative and under about 72 characters.

Open a PR against `main`. Describe what changed and how you checked it — if you
touched a tool, the output before and after is the most useful thing you can
paste.

## Reporting data problems

If a lookup returns something wrong rather than nothing, that is the most
valuable kind of bug report here. Use the **Incorrect or missing game data**
issue template and include the tool call and what the client actually does, so
the fix can be verified against the game rather than against an assumption.
