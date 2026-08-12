# Hated WoW MCP

[![npm](https://img.shields.io/npm/v/hated-wow-mcp)](https://www.npmjs.com/package/hated-wow-mcp)
[![license](https://img.shields.io/npm/l/hated-wow-mcp)](LICENSE)

**An MCP server for writing World of Warcraft addons.** Free and open source.

It gives your AI assistant three things it otherwise guesses at: the **in-game
Lua API** for the client you are targeting, **Blizzard's own shipped UI source**
so it can see how the game itself does something, and the **game's art and file
data** so texture references are real rather than invented.

19 tools. Works with Claude Desktop, Claude Code, Cursor, Cline, and anything
else that speaks MCP — or
[browse them in a local web UI](#browse-it-without-an-ai-client) with no AI at
all.

> ### ☕ Support this project
> Hated WoW MCP is free and always will be. If it saves you time, you can buy me
> a coffee — it genuinely helps keep it maintained through patch cycles.
>
> ### **[buymeacoffee.com/rdygaming](https://buymeacoffee.com/rdygaming)**

Everything here is about code that runs *inside* the client. There is no
Battle.net web API in this server — no armory lookups, no auction house.

---

## Quick start

Requires **Node 20+**. Nothing to clone, nothing to build.

### Claude Code

```bash
claude mcp add wow -- npx -y hated-wow-mcp
```

Add `-s user` to make it available in every project instead of just the current
one. Verify with `claude mcp list`.

### Claude Desktop

Edit your config file:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

> **Windows Store install?** If that path doesn't exist, look under
> `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` instead.

Add the `mcpServers` block. **If the file already has other keys, keep them** —
merge this in rather than replacing the file:

```json
{
  "mcpServers": {
    "wow": {
      "command": "npx",
      "args": ["-y", "hated-wow-mcp"],
      "env": {
        "WOW_DEFAULT_FLAVOR": "mainline"
      }
    }
  }
}
```

Then **fully quit Claude Desktop from the system tray** and reopen it — closing
the window is not enough, and the config is only read at startup.

### Cursor / Cline / Windsurf / other MCP clients

Same JSON block as above. Cursor reads `.cursor/mcp.json` in your project, or
`~/.cursor/mcp.json` globally. See `mcp-config.example.json` in this repo.

### Then sync the game data

The Lua API indexes ship inside the package, so **API search, type and event
lookup, linting, TOC/XML validation and scaffolding work the moment you add it**
— no sync, no waiting.

The UI source corpus and the art/FileDataID lookups are too large to ship, so
those eight tools need a one-time sync. It needs **git** on your PATH:

```bash
npx -y hated-wow-mcp sync all
```

> **Before you sync:** open **<https://wago.tools/>** once in your browser and
> let the page fully load. wago.tools sits behind bot protection, and visiting
> it first from the same connection lets the atlas download through. Skip this
> and the atlas step may fail with HTTP 403.

That fetches a ~44 MB shallow clone of Blizzard's UI source and a ~149 MB
listfile — a few minutes on first run. Re-running later is cheap: an unchanged
listfile is revalidated rather than re-downloaded, so a no-op sync takes about
two seconds.

### Verify it worked

Ask your assistant: *"Using the WoW MCP, what does C_Item.GetItemInfo return?"*
You should get a full 18-value signature. Or run the server directly:

```bash
npx hated-wow-mcp --list
```

That should print all 19 tools.

### Where the data lives

Synced data never goes inside the package — that is what makes `npx` work. It
lands in your OS cache directory:

| Platform | Location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\hated-wow-mcp\Cache` |
| macOS | `~/Library/Caches/hated-wow-mcp` |
| Linux | `$XDG_CACHE_HOME/hated-wow-mcp`, else `~/.cache/hated-wow-mcp` |

Set `WOW_MCP_DATA_DIR` to override — useful for putting ~70 MB on another
drive, or sharing one sync between several installs. `wow_data_status` always
reports where it resolved to and why.

---

## Running from a clone

You only need this to modify the server, or to use the
[local web UI](#browse-it-without-an-ai-client), which is not part of the
published package. Requires **Node 20+** and **git**.

```bash
git clone https://github.com/RdyGaming/hated-wow-mcp.git
cd hated-wow-mcp
npm install
npm run build
npm run sync-all
npm test
```

`npm test` should report **46 passed, 0 failed**. On Windows, `setup.cmd` does
all five steps and prints the absolute path you need below.

A clone keeps its synced data in `data/` beside the source rather than in the OS
cache, so working on the server never disturbs an npx install you already have.

Point your client at the built entry point instead of npx:

```json
{
  "mcpServers": {
    "wow": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\hated-wow-mcp\\dist\\index.js"]
    }
  }
}
```

On Windows, backslashes must be doubled in JSON. On macOS/Linux use a normal
path like `/Users/you/hated-wow-mcp/dist/index.js`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

---

## Browse it without an AI client

Every tool also runs in a local web UI — no assistant, no API key, no tokens.
Useful for looking something up quickly, or for checking what a tool returns
before you wire it into a prompt.

This one needs [a clone](#running-from-a-clone); it is not part of the npm
package.

```bash
npm run web
```

Then open **<http://localhost:3001>**.

Pick a tool from the sidebar and it builds the form for you: the fields, their
types, and the help text all come from the tool's own schema, so the UI always
matches what the tool actually accepts. Results render in a Monaco editor with
a copy button.

This talks to the tools directly — it does **not** speak the MCP protocol, so
nothing here interferes with the server your assistant is using. Both can run
at the same time.

Two things worth knowing:

- **Run `npm run sync-all` first.** The UI is only as complete as your synced
  data; without it the UI source and game data tools return nothing.
- **Art tools show paths, not pictures.** `wow_icon_search` and friends return
  FileDataIDs and texture paths — there is no BLP decoding (see
  [Known limits](#known-limits)). Paste a FileDataID into
  [wago.tools](https://wago.tools) to see the actual image.

Set `PORT` if 3001 is taken:

```bash
PORT=4000 npm run web
```

The UI's dependencies (`express`, `cors`) are dev dependencies — a normal
`npm install` picks them up, and the MCP server itself never imports them.

---

## Configuration

All settings are optional — see `.env.example`.

| Variable | Purpose |
| --- | --- |
| `WOW_DEFAULT_FLAVOR` | Client to answer for when a tool call doesn't name one: `mainline`, `mists`, `cata`, `wrath`, `tbc`, `vanilla`. Defaults to `mainline`. |
| `WOW_INSTALL_PATH` | Your WoW folder. Auto-detected if unset. |
| `WOW_ADDON_PATH` | AddOns folder the file tools read and write. Confines them to that directory. |

---

## What it knows

| Data set | Contents | Source |
| --- | --- | --- |
| Lua API index | 6,335 functions, 1,783 events, 1,676 enums/structures, 6,704 globals (retail; Classic and Classic Era indexed separately) | Blizzard's own generated `/api` documentation, mirrored at [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) |
| UI source | 4,036 files across 348 `Blizzard_*` packages — 4,044 inheritable XML templates, 3,488 mixins, 26,859 mixin methods | Same mirror |
| UI schema | Blizzard's `UI.xsd`, parsed for element/attribute validation | Same mirror |
| File index | 172,175 interface files including 36,624 icons, mapped to FileDataIDs | [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile) |
| Atlas index | 17,465 named `SetAtlas` elements with sizes and coordinates | [wago.tools](https://wago.tools) DB2 exports |

All of it is synced from public mirrors by the scripts in `src/sync/`, so it
tracks patches without anyone hand-maintaining a list.

---

## Tools

**API reference**

| Tool | Purpose |
| --- | --- |
| `wow_api_search` | Find a function with its full argument and return signature |
| `wow_api_event_search` | Find an event and its payload arguments, in order |
| `wow_api_type_search` | Find an `Enum.*`, `Constants.*` or structure table |
| `wow_api_diff` | Compare availability across retail / Classic / Classic Era |
| `wow_api_stats` | Show which indexes are loaded and when they were synced |

**Blizzard's UI source**

| Tool | Purpose |
| --- | --- |
| `wow_ui_template_search` | Find an inheritable XML template, with its inheritance chain |
| `wow_ui_mixin_search` | Find a mixin by name or by one of its methods |
| `wow_ui_grep` | Regex-search all 4,036 shipped Lua/XML files |
| `wow_ui_read_file` | Read a shipped source file in context |
| `wow_ui_list_packages` | List the `Blizzard_*` packages |

**Authoring**

| Tool | Purpose |
| --- | --- |
| `wow_lua_lint` | Removed/moved APIs, unknown events, taint, performance traps |
| `wow_xml_validate` | Validate interface XML against Blizzard's `UI.xsd` |
| `wow_toc_validate` | Validate a `.toc`: interface version, flavor suffix, file list |
| `wow_addon_scaffold` | Generate a working addon skeleton |
| `wow_install_info` | Report local installs and installed addons |

**Game data and art**

| Tool | Purpose |
| --- | --- |
| `wow_file_search` | Path ↔ FileDataID, both directions |
| `wow_icon_search` | Find an icon and get both usable reference forms |
| `wow_atlas_search` | Find a `SetAtlas` element with size and coordinates |
| `wow_data_status` | Show which game data sets are synced |

---

## Why the linter is worth running

It is built on the per-flavor index rather than a hand-written deprecation list,
so it knows things that are true *for the client you are targeting*:

```
$ wow_lua_lint --flavor mainline
local n = GetContainerNumSlots(0)

  1:9  warning  api/moved-to-namespace
      "GetContainerNumSlots" has moved into a namespace in Retail (Midnight)…
      -> C_Container.GetContainerNumSlots
```

The same code is clean on Classic, because there the global still exists. That
distinction is derived from Blizzard's data, not asserted by hand.

It also catches the taint mistakes that produce "Interface action failed because
of an AddOn" — calling protected functions, reassigning Blizzard globals,
touching secure frames during combat lockdown.

**Measured false-positive rate**, checked by running both validators across
Blizzard's own shipped code:

- XML validator: **0 of 1,091** files report an error.
- Lua linter: **48 of 2,551** files (1.9%), and those are almost entirely
  correct — they are Blizzard's own `Blizzard_Deprecated*` shims, which exist
  precisely to redefine removed APIs.

---

## Keeping it current

Re-run after a patch. `wow_api_stats` and `wow_data_status` show what you have
and when it was synced.

| Command | Fetches | Notes |
| --- | --- | --- |
| `npm run sync-api` | Lua API index for all three clients | ~1,700 small HTTPS requests |
| `npm run sync-ui-source` | Blizzard UI source (shallow git clone, ~44 MB) | Re-run fast-forwards |
| `npm run sync-game-data` | Listfile + atlas tables | Add `--full` for models/maps/sounds |
| `npm run sync-all` | All three | |

Those are the commands for a clone. An installed copy has no package scripts, so
it uses the `sync` subcommand instead:

```bash
npx -y hated-wow-mcp sync all
npx -y hated-wow-mcp sync game-data -- --full
```

`sync-api` is checkout-only — it regenerates data that ships inside the package,
so an installed copy gets a newer API index by upgrading rather than syncing.

The data comes from public upstream mirrors, so re-syncing picks up patch changes
without waiting on a release here. Note that those mirrors typically lag a live
patch by hours to days.

**Re-syncing is cheap when nothing changed.** The 149 MB listfile is revalidated
with its `ETag`, so an unchanged one costs a single round trip rather than a
fresh download, and the index is left alone rather than rebuilt — a no-op
`sync-game-data` finishes in about two seconds. Pass `--force` to ignore the
cache and rebuild regardless.

### wago.tools access

**Open <https://wago.tools/> in a browser and let it load before running
`sync-game-data` or `sync-all`.** The site is behind bot protection, and a
browser visit from the same connection clears the way for the atlas download
that follows. Doing this first avoids most atlas failures.

If the atlas step still reports HTTP 403, wago.tools is refusing the connection
outright — it blocks many datacentre, cloud and VPN IP ranges. Run it from a
normal desktop connection, with any VPN off.

This never blocks the rest of the sync. The file index in the same script comes
from GitHub and works regardless, and only `wow_atlas_search` depends on the
atlas step — the other 18 tools are unaffected.

---

## Layout

```
src/
  config.ts            flavors, interface versions, install detection
  wowapi/              API index loading, search, rendering
  uisource/            Blizzard UI source index, template/mixin/grep search
  gamedata/            listfile and atlas lookup
  lua/                 tokenizer, analyzer, rule tables
  xml/                 UI.xsd parser, XML validator
  toc/                 .toc parser and validator
  scaffold/            addon generator
  tools/               MCP tool definitions
  sync/                the three sync scripts, plus their shared entry point
  paths.ts             bundled vs. synced data locations
server.js              local web UI backend (npm run web)
index.html             local web UI frontend
test/smoke.mjs         46 end-to-end checks against real data
data/                  bundled API indexes, plus synced ones in a clone
```

---

## Known limits

- **Widget method inheritance is not modelled.** `Frame:SetPoint` is found, but
  the server does not know that `Button` inherits it from `Frame`. Searching the
  bare method name works.
- **Classic progression flavors share one index.** Blizzard publishes generated
  docs for three running clients; Cata/Wrath/TBC map onto the Classic index, so
  answers for those are approximate.
- **No BLP decoding.** Art tools return paths, FileDataIDs and atlas coordinates
  — not rendered images. Extracting actual textures needs a CASC tool such as
  wow.export against your own installation.
- **The linter's scope model is approximate.** It is a lexer with a scope stack,
  not a full Lua parser. It errs toward silence on ambiguous code.

---

## Troubleshooting

**Server doesn't appear in Claude Desktop.** Fully quit from the system tray, not
just the window. Check the JSON is valid and backslashes are doubled.

**"Cannot find module ... dist/index.js".** Only applies when running from a
clone: you skipped `npm run build`, or the path in your config is wrong. It must
be absolute. On npx, use `"command": "npx", "args": ["-y", "hated-wow-mcp"]` and
there is no path to get wrong.

**UI source, art or icon lookups return nothing.** Those need the one-time sync.
Run `npx -y hated-wow-mcp sync all` (or `npm run sync-all` from a clone), then check
`wow_data_status` — it reports where it looked and when that data was built.

**The sync fails.** You need `git` on your PATH for the UI source step. For an
HTTP 403 on the atlas step, see the wago.tools note in
[Quick start](#then-sync-the-game-data).

**Data seems stale after an update.** `npx` caches the package. Force the newest
release with `npx -y hated-wow-mcp@latest`, or clear it with `npm cache clean
--force`. `wow_api_stats` shows which index is actually loaded.

**"Filename too long" / "Clone succeeded, but checkout failed" (Windows).** Some
Blizzard filenames are 108 characters on their own, so a deep clone path can
exceed Windows' 260-character limit. The sync scripts pass `core.longpaths=true`
to git to handle this. If you still hit it, clone somewhere shorter — keep the
path under about 150 characters (`C:\dev\hated-wow-mcp` is plenty of room) — or
enable long paths system-wide in Windows.

---

## Contributing

Issues and pull requests welcome at
[github.com/RdyGaming/hated-wow-mcp](https://github.com/RdyGaming/hated-wow-mcp).

[CONTRIBUTING.md](CONTRIBUTING.md) covers the dev setup, how the two data sets
differ, and what to know before adding a tool. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

The most valuable report is a lookup that returns something **wrong** rather
than nothing — there is an issue template for it that asks how you verified the
real behaviour, so the fix can be checked against the game.

Found a security problem? Please report it privately — see
[SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a
trademark of Blizzard Entertainment, Inc. All game data is fetched at runtime
from public community mirrors and is not redistributed by this project.
