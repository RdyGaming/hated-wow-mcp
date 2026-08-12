/**
 * End-to-end exercise of every tool against the real synced data.
 *
 * This is deliberately not a unit test: the value of this server is entirely in
 * whether its answers are correct against Blizzard's actual data, so each case
 * asserts on real content rather than on shapes.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

import { ALL_TOOLS } from "../dist/server.js";

/**
 * Invokes a tool the way server.ts does — catching thrown errors and returning
 * them as an error result. Calling the raw handler would test a path no MCP
 * client ever takes, and would miss whether failures are reported usefully.
 */
const byName = new Map(
  ALL_TOOLS.map((t) => [
    t.name,
    {
      ...t,
      handler: async (args) => {
        try {
          return await t.handler(args ?? {});
        } catch (err) {
          return {
            content: [{ type: "text", text: `${t.name} failed: ${err.message}` }],
            isError: true,
          };
        }
      },
    },
  ]),
);

let passed = 0;
let failed = 0;
const failures = [];

async function check(label, toolName, args, assertion) {
  const tool = byName.get(toolName);
  if (!tool) {
    failed++;
    failures.push(`${label}: tool ${toolName} is not registered`);
    return;
  }
  try {
    const result = await tool.handler(args);
    const body = result.content.map((c) => c.text).join("\n");
    assertion(body, result);
    passed++;
    process.stdout.write(`  ok    ${label}\n`);
  } catch (err) {
    failed++;
    failures.push(`${label}: ${err.message}`);
    process.stdout.write(`  FAIL  ${label}\n        ${err.message.split("\n")[0]}\n`);
  }
}

/** For assertions that are not a tool call — the same reporting, no handler. */
async function verify(label, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ok    ${label}\n`);
  } catch (err) {
    failed++;
    failures.push(`${label}: ${err.message}`);
    process.stdout.write(`  FAIL  ${label}\n        ${err.message.split("\n")[0]}\n`);
  }
}

const has = (body, needle) =>
  assert.ok(
    body.includes(needle),
    `expected output to contain ${JSON.stringify(needle)}\n--- got ---\n${body.slice(0, 900)}`,
  );

const lacks = (body, needle) =>
  assert.ok(
    !body.includes(needle),
    `expected output NOT to contain ${JSON.stringify(needle)}\n--- got ---\n${body.slice(0, 900)}`,
  );

console.log("\n== API reference ==");

await check("finds a namespaced function with its signature", "wow_api_search",
  { query: "C_Item.GetItemInfo" }, (b) => {
    has(b, "C_Item.GetItemInfo");
    has(b, "itemName");
    has(b, "returns:");
  });

await check("camel-hump abbreviation matches", "wow_api_search",
  { query: "GetItemInfoByID", limit: 5 }, (b) => has(b, "GetItemInfoByID"));

await check("legacy global is reported as callable", "wow_api_search",
  { query: "UnitHealth", limit: 5 }, (b) => has(b, "UnitHealth"));

await check("widget method is findable", "wow_api_search",
  { query: "SetPoint", limit: 8 }, (b) => has(b, "SetPoint"));

await check("event payload is listed in order", "wow_api_event_search",
  { query: "BAG_UPDATE", limit: 5 }, (b) => {
    has(b, "BAG_UPDATE");
    has(b, "payload");
  });

await check("enum members carry their numeric values", "wow_api_type_search",
  { query: "ItemQuality" }, (b) => {
    has(b, "ItemQuality");
    has(b, "Epic");
  });

console.log("\n== Cross-client differences ==");

// The single most valuable correctness claim in the server: GetSpellInfo was
// removed as a global on retail but still exists on Classic.
await check("GetSpellInfo: gone on retail, present on Classic", "wow_api_diff",
  { name: "GetSpellInfo" }, (b) => {
    has(b, "NOT AVAILABLE");
    has(b, "C_Spell.GetSpellInfo");
    const retailLine = b.split("\n").find((l) => l.includes("Retail"));
    assert.ok(retailLine.includes("NOT AVAILABLE"), `retail should not have it: ${retailLine}`);
    const classicLine = b.split("\n").find((l) => l.includes("Mists"));
    assert.ok(classicLine.includes("callable as a global"), `classic should: ${classicLine}`);
  });

await check("CreateFrame exists everywhere", "wow_api_diff",
  { name: "CreateFrame" }, (b) => lacks(b, "NOT AVAILABLE"));

console.log("\n== Lua linting ==");

await check("flags a global moved into a namespace", "wow_lua_lint", {
  flavor: "mainline",
  code: `local n = GetContainerNumSlots(0)`,
}, (b) => {
  has(b, "api/moved-to-namespace");
  has(b, "C_Container.GetContainerNumSlots");
});

await check("same call is clean on Classic where it still exists", "wow_lua_lint", {
  flavor: "vanilla",
  code: `local info = C_Spell.GetSpellInfo(133)`,
}, (b) => lacks(b, "api/unknown-namespaced"));

await check("flags removed UnitAura with the real replacement", "wow_lua_lint", {
  flavor: "mainline",
  code: `local name = UnitAura("player", 1)`,
}, (b) => {
  has(b, "api/renamed");
  has(b, "C_UnitAuras.GetAuraDataByIndex");
});

await check("flags a protected function call as taint", "wow_lua_lint", {
  flavor: "mainline",
  code: `local f = CreateFrame("Button")\nf:SetScript("OnClick", function() CastSpellByName("Fireball") end)`,
}, (b) => {
  has(b, "taint/protected-call");
  has(b, "CastSpellByName");
});

await check("flags overwriting a Blizzard API", "wow_lua_lint", {
  flavor: "mainline",
  code: `CreateFrame = function() end`,
}, (b) => {
  has(b, "taint/overwrite-api");
  has(b, "hooksecurefunc");
});

await check("flags an unknown event name", "wow_lua_lint", {
  flavor: "mainline",
  code: `local f = CreateFrame("Frame")\nf:RegisterEvent("PLAYER_ENTERING_WORLD_TYPO")`,
}, (b) => has(b, "event/unknown"));

await check("accepts a real event name", "wow_lua_lint", {
  flavor: "mainline",
  code: `local f = CreateFrame("Frame")\nf:RegisterEvent("PLAYER_ENTERING_WORLD")`,
}, (b) => lacks(b, "event/unknown"));

await check("locals are not reported as unknown globals", "wow_lua_lint", {
  flavor: "mainline",
  code: `local function Helper() return 1 end\nlocal x = Helper()`,
}, (b) => lacks(b, "api/unknown"));

await check("respects knownGlobals for embedded libraries", "wow_lua_lint", {
  flavor: "mainline",
  code: `local lib = LibStub("AceAddon-3.0")`,
  knownGlobals: ["LibStub"],
}, (b) => lacks(b, "api/unknown"));

await check("clean idiomatic code produces no errors", "wow_lua_lint", {
  flavor: "mainline",
  code: [
    "local addonName, ns = ...",
    "local frame = CreateFrame(\"Frame\")",
    "frame:RegisterEvent(\"PLAYER_LOGIN\")",
    "frame:SetScript(\"OnEvent\", function(self, event)",
    "    local info = C_Item.GetItemInfo(6948)",
    "    ns.itemName = info",
    "end)",
  ].join("\n"),
}, (b) => lacks(b, "error  "));

console.log("\n== XML validation ==");

await check("accepts a valid template", "wow_xml_validate", {
  xml: `<Ui xmlns="http://www.blizzard.com/wow/ui/">
    <Frame name="MyTemplate" virtual="true">
        <Size x="100" y="50"/>
        <Anchors><Anchor point="CENTER"/></Anchors>
    </Frame>
</Ui>`,
}, (b) => has(b, "No issues found"));

await check("catches a misspelled attribute case", "wow_xml_validate", {
  xml: `<Ui xmlns="http://www.blizzard.com/wow/ui/"><Frame Name="X" virtual="true"/></Ui>`,
}, (b) => has(b, "case-sensitive"));

await check("catches an invalid enum value", "wow_xml_validate", {
  xml: `<Ui xmlns="http://www.blizzard.com/wow/ui/">
    <Frame name="X" virtual="true"><Anchors><Anchor point="MIDDLE"/></Anchors></Frame></Ui>`,
}, (b) => has(b, "not a valid value"));

await check("catches a virtual frame with no name", "wow_xml_validate", {
  xml: `<Ui xmlns="http://www.blizzard.com/wow/ui/"><Frame virtual="true"/></Ui>`,
}, (b) => has(b, "no name"));

await check("catches an unclosed tag", "wow_xml_validate", {
  xml: `<Ui xmlns="http://www.blizzard.com/wow/ui/"><Frame name="X" virtual="true"></Ui>`,
}, (b) => has(b, "error"));

console.log("\n== TOC validation ==");

await check("accepts a current retail toc", "wow_toc_validate", {
  fileName: "MyAddon.toc",
  toc: `## Interface: 120007\n## Title: MyAddon\n## SavedVariables: MyAddonDB\n\nCore.lua\n`,
}, (b) => has(b, "No issues found"));

await check("catches suffix/interface mismatch", "wow_toc_validate", {
  fileName: "MyAddon_Vanilla.toc",
  toc: `## Interface: 120007\n## Title: MyAddon\n\nCore.lua\n`,
}, (b) => {
  has(b, "filename suffix targets");
  has(b, "11509");
});

await check("catches an unknown directive", "wow_toc_validate", {
  fileName: "MyAddon.toc",
  toc: `## Interface: 120007\n## Title: MyAddon\n## Colour: blue\n\nCore.lua\n`,
}, (b) => {
  has(b, "not a directive");
  has(b, "X-Colour");
});

await check("catches a non-loadable file extension", "wow_toc_validate", {
  fileName: "MyAddon.toc",
  toc: `## Interface: 120007\n## Title: MyAddon\n\nCore.txt\n`,
}, (b) => has(b, "neither a .lua nor a .xml"));

console.log("\n== Blizzard UI source ==");

await check("finds a real Blizzard template", "wow_ui_template_search",
  { query: "UIPanelButtonTemplate", limit: 3 }, (b) => {
    has(b, "UIPanelButtonTemplate");
    has(b, "defined:");
  });

await check("finds a mixin by one of its methods", "wow_ui_mixin_search",
  { query: "OnLoad", limit: 3 }, (b) => has(b, "methods"));

await check("greps real source with context", "wow_ui_grep",
  { pattern: "hooksecurefunc", ext: "lua", limit: 5 }, (b) => has(b, "hooksecurefunc"));

await check("reads a real source file", "wow_ui_read_file",
  { path: "Interface/AddOns/Blizzard_UIParent/UIParent.lua", startLine: 1, endLine: 15 },
  (b) => has(b, "UIParent.lua"));

await check("refuses to escape the checkout", "wow_ui_read_file",
  { path: "../../../../etc/passwd" }, (b, r) => {
    assert.ok(r.isError, "should be an error result");
    has(b, "Refusing to read outside");
  });

await check("lists Blizzard packages", "wow_ui_list_packages",
  { filter: "ActionBar" }, (b) => has(b, "Blizzard_ActionBar"));

console.log("\n== Game data ==");

await check("resolves an icon name to a FileDataID", "wow_icon_search",
  { query: "spell_fire_fireball", limit: 5 }, (b) => {
    has(b, "135807");
    has(b, "Interface\\\\Icons");
  });

await check("resolves a numeric FileDataID back to its path", "wow_file_search",
  { query: "135807" }, (b) => has(b, "interface/icons/spell_fire_fireball.blp"));

await check("file search reports both usable forms", "wow_file_search",
  { query: "spell_fire_fireball", limit: 3 }, (b) => {
    has(b, "FileDataID:");
    has(b, "SetTexture(");
  });

await check("data status reports what is synced", "wow_data_status", {}, (b) =>
  has(b, "File index"));

await check("atlas tool explains itself when not synced", "wow_atlas_search",
  { query: "test" }, (b) =>
    assert.ok(
      b.includes("not been built") || b.includes("atlas element"),
      `expected either results or a clear not-synced message, got: ${b.slice(0, 300)}`,
    ));

console.log("\n== Scaffolding ==");

await check("generates a complete addon skeleton", "wow_addon_scaffold", {
  name: "TestAddon",
  flavors: ["mainline"],
  withFrame: true,
  withOptions: true,
}, (b) => {
  has(b, "TestAddon/TestAddon.toc");
  has(b, "## Interface: 120007");
  has(b, "TestAddon/Core.lua");
  has(b, "TestAddon/Templates.xml");
  has(b, "TestAddon/Options.lua");
  has(b, "SLASH_TESTADDON1");
});

await check("multi-flavor scaffold lists every interface", "wow_addon_scaffold", {
  name: "MultiAddon",
  flavors: ["mainline", "vanilla"],
}, (b) => {
  has(b, "120007");
  has(b, "11509");
});

console.log("\n== Generated output is itself valid ==");

// The strongest check available: run the scaffolder's own output back through
// the validators. If the skeleton we hand people does not pass our own lint,
// one of the two is wrong.
{
  const scaffold = byName.get("wow_addon_scaffold");
  const out = await scaffold.handler({
    name: "SelfCheck",
    flavors: ["mainline"],
    withFrame: true,
    withOptions: true,
  });
  const body = out.content[0].text;

  const section = (path) => {
    const start = body.indexOf(`===== ${path} =====`);
    if (start === -1) return null;
    const from = start + `===== ${path} =====\n`.length;
    const next = body.indexOf("\n===== ", from);
    return body.slice(from, next === -1 ? undefined : next);
  };

  await check("scaffolded .toc passes toc validation", "wow_toc_validate",
    { fileName: "SelfCheck.toc", toc: section("SelfCheck/SelfCheck.toc") },
    (b) => lacks(b, "error"));

  await check("scaffolded XML passes xml validation", "wow_xml_validate",
    { xml: section("SelfCheck/Templates.xml") },
    (b) => has(b, "No issues found"));

  await check("scaffolded Core.lua passes the linter", "wow_lua_lint",
    { flavor: "mainline", code: section("SelfCheck/Core.lua") },
    (b) => lacks(b, "error  "));

  await check("scaffolded UI.lua passes the linter", "wow_lua_lint",
    { flavor: "mainline", code: section("SelfCheck/UI.lua") },
    (b) => lacks(b, "error  "));

  await check("scaffolded Options.lua passes the linter", "wow_lua_lint",
    { flavor: "mainline", code: section("SelfCheck/Options.lua") },
    (b) => lacks(b, "error  "));
}

console.log("\n== Local install ==");

await check("install info answers without an install present", "wow_install_info", {}, (b) =>
  assert.ok(b.length > 0, "should always produce output"));

// ---------------------------------------------------------------------------
// Suggested commands
//
// 0.2.0 shipped `npx hated-wow-mcp-sync ui-source` in the message users hit the
// first time they called an unsynced tool. It 404s: npx resolves a bare command
// to a *package* of that name, and hated-wow-mcp-sync is a bin, not a package.
// Nothing caught it, because a wrong instruction is a string — every tool still
// behaved correctly while telling people to type something that cannot work.
//
// So: find every command this project tells a user to run, in the shipped code
// and in the README, and check it is actually runnable.
// ---------------------------------------------------------------------------

console.log("\n== Suggested commands are runnable ==");

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const binNames = Object.keys(pkg.bin ?? {});
const SYNC_TARGETS = ["api", "ui-source", "game-data", "all"];

/**
 * Only what a user can actually see. Comments in the shipped JS discuss the
 * broken forms on purpose — explaining why `npx hated-wow-mcp-sync` cannot work
 * requires writing it down — so scanning them would flag the explanation as the
 * defect. The `//` strip skips `://` so URLs inside strings survive.
 */
const stripComments = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");

/** Every shipped .js plus the README — anywhere a command string can hide. */
async function sourcesToScan() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".js")) files.push(path);
    }
  }
  await walk(new URL("../dist/", import.meta.url));
  files.push(new URL("../README.md", import.meta.url));

  return Promise.all(
    files.map(async (url) => {
      const raw = await readFile(url, "utf8");
      return { url, text: url.pathname.endsWith(".js") ? stripComments(raw) : raw };
    }),
  );
}

const sources = await sourcesToScan();
const label = (url) => url.pathname.split("/").slice(-2).join("/");

await verify("every `npm run` command names a real package script", () => {
  const bad = [];
  for (const { url, text } of sources) {
    for (const m of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      // `npm run sync-${name}` builds the script name at runtime, so the literal
      // half is not a script and never will be. The command that template
      // actually produces is checked below by calling the function itself.
      if (text.startsWith("${", m.index + m[0].length)) continue;
      if (!pkg.scripts?.[m[1]]) bad.push(`${label(url)}: npm run ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `commands naming a script that does not exist:\n  ${bad.join("\n  ")}`);
});

await verify("no npx command names a bin that is not the package", () => {
  const bad = [];
  for (const { url, text } of sources) {
    // `npx -p <pkg> <bin>` is legitimate — the -p names the package to fetch,
    // so the bin after it does not need to be resolvable on its own.
    for (const m of text.matchAll(/npx\s+(?:-y\s+|--yes\s+)?(?!-p\b|--package\b)([@a-z0-9._/-]+)/g)) {
      const token = m[1].replace(/@[^@/]*$/, ""); // strip @latest / @0.2.2
      if (token !== pkg.name && binNames.includes(token)) {
        bad.push(`${label(url)}: npx ${m[1]}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    "npx resolves a bare command to a package of that name, so a bin name " +
      `that is not "${pkg.name}" cannot work:\n  ${bad.join("\n  ")}`,
  );
});

await verify("every `<pkg> sync <target>` names a real sync", () => {
  const bad = [];
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const { url, text } of sources) {
    for (const [, target] of text.matchAll(
      new RegExp(`${escaped}(?:@[^\\s]+)?\\s+sync\\s+([a-z0-9-]+)`, "g"),
    )) {
      if (!SYNC_TARGETS.includes(target)) bad.push(`${label(url)}: sync ${target}`);
    }
  }
  assert.deepEqual(bad, [], `unknown sync targets:\n  ${bad.join("\n  ")}`);
});

await verify("the sync dispatcher still implements every target", async () => {
  const dispatcher = await readFile(new URL("../dist/sync/index.js", import.meta.url), "utf8");
  for (const target of SYNC_TARGETS) {
    assert.ok(dispatcher.includes(`"${target}"`), `dispatcher no longer handles "${target}"`);
  }
});

await verify("every declared bin exists in the build", async () => {
  for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
    const target = new URL(`../${rel}`, import.meta.url);
    assert.ok(existsSync(target), `bin "${name}" points at missing ${rel}`);
  }
});

await verify("the missing-data message suggests a command that resolves", async () => {
  const { dataMissingMessage } = await import("../dist/config.js");
  const message = dataMissingMessage("test", "ui-source");
  const command = message.match(/Run `([^`]+)`/)?.[1];
  assert.ok(command, `no command found in:\n${message}`);

  if (command.startsWith("npm run ")) {
    const script = command.slice("npm run ".length);
    assert.ok(pkg.scripts?.[script], `suggests missing script "${script}"`);
  } else {
    const parts = command.split(/\s+/).filter((p) => p !== "npx" && p !== "-y");
    assert.equal(parts[0], pkg.name, `suggests "${parts[0]}", which npx cannot resolve`);
    assert.equal(parts[1], "sync", `expected a sync subcommand, got "${parts[1]}"`);
    assert.ok(SYNC_TARGETS.includes(parts[2]), `unknown sync target "${parts[2]}"`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
