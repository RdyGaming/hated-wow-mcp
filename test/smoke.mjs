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

import { FLAVORS } from "../dist/config.js";
import { ALL_TOOLS } from "../dist/server.js";

// The Interface number for the current retail build, read from config rather
// than written out. It changes every patch, and these tests used to hard-code
// the previous one, so each bump failed them for a reason unrelated to the code.
const CURRENT_RETAIL = FLAVORS.mainline.interfaceVersion;

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
  toc: `## Interface: ${CURRENT_RETAIL}\n## Title: MyAddon\n## SavedVariables: MyAddonDB\n\nCore.lua\n`,
}, (b) => has(b, "No issues found"));

await check("catches suffix/interface mismatch", "wow_toc_validate", {
  fileName: "MyAddon_Vanilla.toc",
  toc: `## Interface: ${CURRENT_RETAIL}\n## Title: MyAddon\n\nCore.lua\n`,
}, (b) => {
  has(b, "filename suffix targets");
  has(b, "11509");
});

await check("catches an unknown directive", "wow_toc_validate", {
  fileName: "MyAddon.toc",
  toc: `## Interface: ${CURRENT_RETAIL}\n## Title: MyAddon\n## Colour: blue\n\nCore.lua\n`,
}, (b) => {
  has(b, "not a directive");
  has(b, "X-Colour");
});

await check("catches a non-loadable file extension", "wow_toc_validate", {
  fileName: "MyAddon.toc",
  toc: `## Interface: ${CURRENT_RETAIL}\n## Title: MyAddon\n\nCore.txt\n`,
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

await check("a bare filename suggests the full path", "wow_ui_read_file",
  { path: "UIParent.lua" }, (b, r) => {
    assert.ok(r.isError, "should be an error result");
    has(b, "Did you mean");
    has(b, "Interface/AddOns/Blizzard_UIParent/UIParent.lua");
    assert.ok(!b.includes("wow_ui_find_file"), "must not name a tool that does not exist");
  });

await check("a wrong-case filename suggests the right one", "wow_ui_read_file",
  { path: "uiparent.lua" }, (b, r) => {
    assert.ok(r.isError, "should be an error result");
    has(b, "Interface/AddOns/Blizzard_UIParent/UIParent.lua");
  });

await check("a partial path with backslashes still suggests", "wow_ui_read_file",
  { path: "Blizzard_UIParent\\UIParent.lua" }, (b, r) => {
    assert.ok(r.isError, "should be an error result");
    has(b, "Interface/AddOns/Blizzard_UIParent/UIParent.lua");
  });

await check("a missing file points at tools that exist", "wow_ui_read_file",
  { path: "Interface/AddOns/NoSuchAddon/NoSuchFile.lua" }, (b, r) => {
    assert.ok(r.isError, "should be an error result");
    assert.ok(!b.includes("Did you mean"), "nothing matches, so nothing to suggest");
    has(b, "wow_ui_grep");
    assert.ok(!b.includes("wow_ui_find_file"), "must not name a tool that does not exist");
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
  has(b, `## Interface: ${CURRENT_RETAIL}`);
  has(b, "TestAddon/Core.lua");
  has(b, "TestAddon/Templates.xml");
  has(b, "TestAddon/Options.lua");
  has(b, "SLASH_TESTADDON1");
});

await check("multi-flavor scaffold lists every interface", "wow_addon_scaffold", {
  name: "MultiAddon",
  flavors: ["mainline", "vanilla"],
}, (b) => {
  has(b, String(CURRENT_RETAIL));
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

console.log("\n== Console variables ==");

await check("finds a CVar with its options-UI label", "wow_cvar_search",
  { query: "colorblindMode" }, (b) => {
    has(b, "colorblindMode");
    has(b, "USE_COLORBLIND_MODE");
    // The label is a GlobalString key, not text — the localized string lives in
    // the client. Claiming otherwise would be the kind of confident-but-wrong
    // answer this server exists to avoid.
    has(b, '_G["USE_COLORBLIND_MODE"]');
  });

await check("infers the value shape from how Blizzard reads it", "wow_cvar_search",
  { query: "colorblindMode" }, (b) => has(b, "boolean"));

// The CVar that used to be here, nameplateShowOnlyNameForFriendlyPlayerUnits, is
// set through the options screen with no direct GetCVar/SetCVar call. The test
// asserted "never touches it" about it, so it was checking the bug rather than
// the behavior. This one has neither a call nor a settings registration.
await check("reports a CVar the UI never touches rather than hiding it", "wow_cvar_search",
  { query: "nameplateCheckDistanceForTarget" }, (b) =>
    has(b, "never touches it"));

await check("a CVar set only through the options screen is not called untouched", "wow_cvar_search",
  { query: "nameplateShowOnlyNameForFriendlyPlayerUnits" }, (b) => {
    lacks(b, "never touches it");
    has(b, "options screen");
    has(b, "UNIT_NAMEPLATES_FRIENDLY_PLAYER_SHOW_ONLY_NAME");
  });

await check("usedOnly drops registry-only entries", "wow_cvar_search",
  { query: "nameplate", usedOnly: true, limit: 20 }, (b) =>
    lacks(b, "never touches it"));

await check("explains itself when nothing matches", "wow_cvar_search",
  { query: "zzzzNotARealCVar" }, (b) => has(b, "No CVar matching"));

await check("reports the registry default and description", "wow_cvar_search",
  { query: "ActionButtonUseKeyDown" }, (b) => {
    has(b, "Activate the action button on a keydown");
    has(b, "default:");
    has(b, "category:  Game");
  });

await check("warns that a protected CVar cannot be set by an addon", "wow_cvar_search",
  { query: "ActionButtonUseKeyDown" }, (b) => has(b, "PROTECTED"));

await check("answers usefully for a CVar the UI never touches", "wow_cvar_search",
  { query: "cameraDistanceMaxZoomFactor" }, (b) => {
    // Before the registry was parsed this returned a bare name and nothing
    // else. The default alone makes it worth asking.
    has(b, "default:");
    has(b, "stored:");
  });

await verify("the CVar parser handles the shapes upstream actually uses", async () => {
  const { parseCVars } = await import("../dist/sync/api.js");

  const fixture = `
local CVars = {
\tvar = {
\t\t-- var = default, category, account, character, secure, help
\t\t["plain"] = {"1", 4, true, false, false, "A plain one"},
\t\t["nilFlags"] = {"0", 1, nil, nil, nil, "Flags may be nil"},
\t\t["emptyDefault"] = {"", 5, false, false, false, ""},
\t\t["commaInHelp"] = {"2", 7, false, true, true, "One, two, three"},
\t\t["urlDefault"] = {"https://example.com/a,b", 6, false, false, false, "Has a comma in the value"},
\t},
\tcommand = {
\t\t-- command = category, help
\t\t["reloadui"] = {2, "Reloads the UI"},
\t},
}
`;

  const rows = parseCVars(fixture);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  assert.equal(rows.length, 5, "console commands must not be counted as CVars");
  assert.ok(!byName.reloadui, "reloadui is a command, not a CVar");

  assert.deepEqual(byName.plain, {
    name: "plain", default: "1", category: "Game",
    account: true, character: false, secure: false, help: "A plain one",
  });
  assert.equal(byName.nilFlags.account, false, "nil means not set, not true");
  assert.equal(byName.emptyDefault.category, "", "category 5 is the unnamed default");
  assert.equal(byName.emptyDefault.help, undefined, "an empty help string is omitted");
  assert.equal(byName.commaInHelp.help, "One, two, three", "commas in help survive");
  assert.equal(byName.commaInHelp.secure, true);
  assert.equal(byName.urlDefault.default, "https://example.com/a,b", "commas in values survive");
});

await verify("the shipped registry carries the fields the tool renders", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  for (const flavor of ["mainline", "classic", "vanilla"]) {
    const index = JSON.parse(
      await rf(new URL(`../data/api-${flavor}.json`, import.meta.url), "utf8"),
    );
    const entries = index.cvars.filter((c) => typeof c === "object");
    assert.ok(entries.length > 1000, `${flavor}: only ${entries.length} CVar entries`);
    assert.ok(
      entries.some((c) => c.help) && entries.some((c) => c.secure),
      `${flavor}: registry is missing help or secure flags`,
    );
  }
});

console.log("\n== Sync determinism ==");

await verify("sorting functions is a total order, not just by signature", async () => {
  const { byFunction } = await import("../dist/sync/api.js");

  // Two entries that legitimately share a signature but differ in system -
  // exactly the shape that made the old signature-only sort unstable, since
  // Array.sort is stable and left ties in fetch-completion order.
  const a = { signature: "AddPoint", system: "LuaCurveObjectAPI", name: "AddPoint" };
  const b = { signature: "AddPoint", system: "LuaColorCurveObjectAPI", name: "AddPoint" };

  const sortedAB = [a, b].sort(byFunction);
  const sortedBA = [b, a].sort(byFunction);
  assert.deepEqual(
    sortedAB.map((x) => x.system),
    sortedBA.map((x) => x.system),
    "the comparator must resolve the tie itself, not depend on input order",
  );
});

await verify("shuffled input sorts to the same order regardless of starting order", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const { byFunction } = await import("../dist/sync/api.js");

  const index = JSON.parse(
    await rf(new URL("../data/api-mainline.json", import.meta.url), "utf8"),
  );
  const fns = index.functions;

  // A fixed-seed shuffle, not Math.random - a flaky failure here would be
  // exactly the kind of intermittent, hard-to-reproduce bug this exists to
  // rule out for good.
  function shuffled(arr, seed) {
    const out = [...arr];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  const orderings = [1, 2, 3].map((seed) =>
    JSON.stringify(shuffled(fns, seed).sort(byFunction)),
  );
  assert.ok(
    orderings.every((o) => o === orderings[0]),
    "the same 6000+ functions in three different starting orders produced " +
      "three different sorted results - the comparator has a remaining tie",
  );
});

await verify("writeIfChanged ignores generatedAt when deciding whether to write", async () => {
  const { mkdtemp, readFile: rf } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeIfChanged } = await import("../dist/sync/api.js");

  const dir = await mkdtemp(join(tmpdir(), "hated-wow-mcp-test-"));
  const target = join(dir, "index.json");

  const wroteFirst = writeIfChanged(target, { generatedAt: "2020-01-01T00:00:00Z", n: 1 });
  assert.equal(wroteFirst, true, "a file that does not exist yet must be written");

  const before = await rf(target, "utf8");
  const wroteSecond = writeIfChanged(target, { generatedAt: "2099-12-31T00:00:00Z", n: 1 });
  const reason = "only generatedAt differs - this is what used to defeat the weekly syncs commit-only-if-changed guard";
  assert.equal(wroteSecond, false, reason);
  assert.equal(await rf(target, "utf8"), before, "the file on disk must be untouched");

  const wroteThird = writeIfChanged(target, { generatedAt: "2099-12-31T00:00:00Z", n: 2 });
  assert.equal(wroteThird, true, "a real content change must still be written");
});
console.log("\n== Data staleness ==");

// This used to assert that the machine's data was fresh ("synced today"). That
// was true the day it was written and false a month later, so the suite failed
// for a reason unrelated to any change. The invariant worth testing is that the
// warning appears exactly when the data is past the threshold, whatever age the
// data on this machine happens to be, and that each flavor is aged on its own.
await verify("the staleness warning tracks each flavor's own data age", async () => {
  const { loadUiSourceGeneratedAt } = await import("../dist/uisource/index.js");
  const { resolveFlavor } = await import("../dist/config.js");
  const { ageInDays, STALE_AFTER_DAYS } = await import("../dist/tools/shared.js");

  let checked = 0;
  for (const id of ["mainline", "forever"]) {
    const flavor = resolveFlavor(id);
    const syncedAt = loadUiSourceGeneratedAt(flavor);
    if (!syncedAt) continue; // not synced on this machine, so nothing to age

    const result = await byName.get("wow_cvar_search").handler({
      query: "colorblindMode",
      flavor: id,
    });
    const body = result.content.map((c) => c.text).join("\n");
    const flagged = body.includes("This answer comes from data synced");
    const stale = ageInDays(syncedAt) >= STALE_AFTER_DAYS;

    assert.equal(
      flagged,
      stale,
      `${id}: data is ${ageInDays(syncedAt)} days old, warning shown: ${flagged}`,
    );
    checked++;
  }
  assert.ok(checked > 0, "no UI source synced at all, so this checked nothing");
});

await verify("the note fires past the threshold, and not before", async () => {
  const { stalenessNote, STALE_AFTER_DAYS } = await import("../dist/tools/shared.js");
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

  assert.equal(stalenessNote(daysAgo(STALE_AFTER_DAYS - 1), "uisource"), "", "just inside");
  assert.match(stalenessNote(daysAgo(STALE_AFTER_DAYS + 1), "uisource"), /UI source sync/);
  assert.match(stalenessNote(daysAgo(400), "gamedata"), /game data sync/);
  assert.equal(stalenessNote(undefined, "uisource"), "", "unsynced data has no age to report");
  assert.equal(stalenessNote("not a date", "uisource"), "", "an unparseable date is not a warning");
});

await verify("every synced-data tool declares its dataset", async () => {
  const { ALL_TOOLS: tools } = await import("../dist/server.js");
  const SYNCED = [
    "wow_ui_template_search", "wow_ui_mixin_search", "wow_cvar_search",
    "wow_ui_grep", "wow_ui_read_file", "wow_ui_list_packages",
    "wow_file_search", "wow_icon_search", "wow_atlas_search",
  ];
  const missing = SYNCED.filter((n) => !tools.find((t) => t.name === n)?.dataset);
  assert.deepEqual(missing, [], `these would never warn when their data goes stale: ${missing}`);
});

console.log("\n== WoW Forever ==");

// Blizzard's internal game type for WoW Forever is "camelot", and its UI source
// is the retail codebase with Camelot overrides, so it is neither Classic Era
// nor a Classic progression client. These pin the places where treating it like
// one of those would give confident wrong answers.

await verify("WoW Forever is its own flavor at Interface 16001", async () => {
  const { resolveFlavor } = await import("../dist/config.js");
  const f = resolveFlavor("forever");
  assert.equal(f.interfaceVersion, 16001);
  assert.equal(f.apiIndex, "forever", "must not share the classic or vanilla index");
});

await verify("Interface numbers sharing a major version resolve to the right flavor", async () => {
  const { flavorForInterface } = await import("../dist/config.js");
  // Classic Era (1.15.x) and WoW Forever (1.60.x) are both major 1.
  assert.equal(flavorForInterface(16001).id, "forever");
  assert.equal(flavorForInterface(16002).id, "forever", "a patch bump stays Forever");
  assert.equal(flavorForInterface(11509).id, "vanilla");
  assert.equal(flavorForInterface(11508).id, "vanilla", "an older Era number stays Era");
  assert.equal(flavorForInterface(120100).id, "mainline");
});

await check("a .toc declaring 16001 is not judged against Classic Era", "wow_toc_validate", {
  fileName: "Test.toc",
  toc: "## Interface: 16001\n## Title: Test\nCore.lua\n",
}, (b) => {
  lacks(b, "behind the current");
  lacks(b, "does not match any current client");
  has(b, "WoW Forever");
});

await check("a multi-Interface line maps each number to its own flavor", "wow_toc_validate", {
  fileName: "Test.toc",
  toc: "## Interface: 16001, 50504, 11509\n## Title: Test\nCore.lua\n",
}, (b) => {
  has(b, "WoW Forever (Camelot)");
  has(b, "Classic Era");
  lacks(b, "does not match any current client");
});

await check("a newer Interface number is not called out of date", "wow_toc_validate", {
  fileName: "Test.toc",
  toc: "## Interface: 129999\n## Title: Test\nCore.lua\n",
}, (b) => {
  // This used to say "behind the current build" and suggest the *lower*
  // number, telling authors targeting a PTR to downgrade.
  lacks(b, "behind the current");
  has(b, "newer than");
});

await verify("the shipped index for WoW Forever says what upstream does not publish", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const idx = JSON.parse(
    await rf(new URL("../data/api-forever.json", import.meta.url), "utf8"),
  );
  assert.ok(idx.counts.functions > 1000, `only ${idx.counts.functions} functions`);
  assert.equal(idx.upstream.resources, null, "there is no Ketho branch for it");
  // Empty lists here mean "no source", not "this client has none".
  for (const k of ["globals", "eventNames", "cvars"]) {
    assert.ok(idx.unavailable.includes(k), `${k} should be marked unavailable`);
  }
});

await verify("the manifest still lists every flavor after a single-flavor sync", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const m = JSON.parse(await rf(new URL("../data/manifest.json", import.meta.url), "utf8"));
  for (const f of ["mainline", "classic", "vanilla", "forever"]) {
    assert.ok(m.flavors[f], `manifest is missing ${f}`);
  }
});

await check("API search answers from the WoW Forever index", "wow_api_search", {
  query: "C_Item.GetItemInfo", flavor: "forever", limit: 1,
}, (b) => {
  has(b, "WoW Forever (Camelot)");
  has(b, "C_Item.GetItemInfo");
});

await check("lint does not flag legacy globals it has no list for", "wow_lua_lint", {
  flavor: "forever",
  code: `local a = strsplit("-", "a-b")\ntinsert({}, 1)\nlocal x = DefinitelyNotABlizzardApi(1)`,
}, (b) => {
  lacks(b, "api/unknown");
  lacks(b, "api/moved-to-namespace");
  has(b, "api/unchecked");
});

await check("lint still catches removed API on WoW Forever", "wow_lua_lint", {
  flavor: "forever",
  code: `local name = UnitAura("player", 1)`,
}, (b) => has(b, "C_UnitAuras.GetAuraDataByIndex"));

await check("the same unknown call is still flagged on retail", "wow_lua_lint", {
  flavor: "mainline",
  code: `local x = DefinitelyNotABlizzardApi(1)`,
}, (b) => {
  // Guards against the Forever carve-out leaking: retail has a global list,
  // so the unknown-function check must keep running there.
  has(b, "api/unknown");
  lacks(b, "api/unchecked");
});

await check("api diff does not claim a bare name is absent when it cannot know", "wow_api_diff", {
  name: "strsplit",
}, (b) => has(b, "may still be a legacy global"));

await check("api diff stays definite for a qualified name", "wow_api_diff", {
  name: "C_DefinitelyNotAnApi.Nothing",
}, (b) => has(b, "NOT AVAILABLE"));

await verify("a CVar hit with no registry is not reported as unregistered", async () => {
  const { searchCVars, renderCVar } = await import("../dist/uisource/cvars.js");
  const used = [{ name: "someCVar", refs: 3, files: ["a.lua"], accessors: ["GetCVar"] }];
  const hits = searchCVars("someCVar", new Set(), new Map(), used, 5, false);
  assert.equal(hits.length, 1);
  assert.ok(!renderCVar(hits[0]).includes("not listed"), "there is no registry to be missing from");
});

await verify("a CVar set only through the options screen is not called untouched", async () => {
  const { renderCVar } = await import("../dist/uisource/cvars.js");
  const optionsOnly = renderCVar({
    name: "onlyInOptions", refs: 0, files: [], accessors: [],
    labelKey: "SOME_LABEL", tooltipKey: "OPTION_TOOLTIP_SOME_LABEL", known: true,
  });
  // 134 of 524 CVars in the WoW Forever UI index look like this. They have no
  // direct GetCVar/SetCVar call but are registered in the settings screen.
  assert.ok(!optionsOnly.includes("never touches"), optionsOnly);
  assert.ok(optionsOnly.includes("options screen"), optionsOnly);
  assert.ok(optionsOnly.includes("SOME_LABEL"), "the label it has must not be dropped");
  assert.ok(!optionsOnly.includes("seen in:"), "no files means no dangling header");

  const untouched = renderCVar({
    name: "unused", refs: 0, files: [], accessors: [], known: true,
  });
  assert.ok(untouched.includes("never touches"), "genuinely unused CVars still say so");
});

await verify("an unsynced flavor never gets another flavor's UI source", async () => {
  const { loadUiSource } = await import("../dist/uisource/index.js");
  const { FLAVORS } = await import("../dist/config.js");
  for (const flavor of Object.values(FLAVORS)) {
    try {
      const src = loadUiSource(flavor);
      // Whatever machine this runs on, a returned index must be the one asked
      // for. It used to fall back to retail, silently.
      assert.equal(src.raw.flavor, flavor.apiIndex, `${flavor.id} was answered from ${src.raw.flavor}`);
    } catch (err) {
      assert.match(err.message, /sync/i, `${flavor.id}: an error must say how to fix it`);
    }
  }
});

await verify("a WoW Forever install is detected under _classic_beta_", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findInstallations } = await import("../dist/config.js");

  const root = mkdtempSync(join(tmpdir(), "wowroot-"));
  const prior = process.env.WOW_INSTALL_PATH;
  try {
    mkdirSync(join(root, "_classic_beta_", "Interface", "AddOns"), { recursive: true });
    writeFileSync(
      join(root, ".build.info"),
      "Branch!STRING:0|Product!STRING:0|Version!STRING:0\nus|wow_classic_beta|1.60.1.69893\n",
    );
    process.env.WOW_INSTALL_PATH = root;
    const found = findInstallations();
    assert.equal(found.length, 1);
    assert.equal(found[0].flavor.id, "forever");
    assert.equal(found[0].build, "1.60.1.69893", "the build must come from the wow_classic_beta row");
  } finally {
    if (prior === undefined) delete process.env.WOW_INSTALL_PATH;
    else process.env.WOW_INSTALL_PATH = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

await verify("a bare UI source sync follows the installed clients", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultSyncIndexes } = await import("../dist/config.js");

  const priorPath = process.env.WOW_INSTALL_PATH;
  const priorFlavor = process.env.WOW_DEFAULT_FLAVOR;
  const keysFor = (dirs, defaultFlavor) => {
    const root = mkdtempSync(join(tmpdir(), "wowroot-"));
    try {
      for (const d of dirs) mkdirSync(join(root, d, "Interface", "AddOns"), { recursive: true });
      process.env.WOW_INSTALL_PATH = root;
      if (defaultFlavor) process.env.WOW_DEFAULT_FLAVOR = defaultFlavor;
      else delete process.env.WOW_DEFAULT_FLAVOR;
      return defaultSyncIndexes().keys;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  try {
    // The point of the feature: an installed WoW Forever is indexed with no flag.
    assert.deepEqual(keysFor(["_retail_", "_classic_beta_"]), ["mainline", "forever"]);
    // The default flavor is always indexed, even if that client is not installed,
    // because every tool answers for it when a call names none.
    assert.deepEqual(keysFor(["_classic_beta_"]), ["mainline", "forever"]);
    // Nothing installed: behaves exactly as before, retail only.
    assert.deepEqual(keysFor([]), ["mainline"]);
    // Retail-only developers get no extra download.
    assert.deepEqual(keysFor(["_retail_"]), ["mainline"]);
    // Each client maps to its own index; retail leads and nothing repeats.
    const all = keysFor(["_classic_beta_", "_classic_era_", "_classic_", "_retail_"]);
    assert.equal(all[0], "mainline");
    assert.deepEqual([...all].sort(), ["classic", "forever", "mainline", "vanilla"]);
    // A different default flavor is honoured.
    assert.deepEqual(keysFor([], "forever"), ["forever"]);
  } finally {
    if (priorPath === undefined) delete process.env.WOW_INSTALL_PATH;
    else process.env.WOW_INSTALL_PATH = priorPath;
    if (priorFlavor === undefined) delete process.env.WOW_DEFAULT_FLAVOR;
    else process.env.WOW_DEFAULT_FLAVOR = priorFlavor;
  }
});

console.log("\n== MCP protocol ==");

// Everything above calls tool handlers directly. A real client never does: it
// spawns the server, speaks JSON-RPC over stdio, and reads the schemas the SDK
// serialises. Whether stdout stays clean, what tools/list actually carries, and
// how a bad call is reported are properties of that wire, and only a test that
// speaks it can notice them change.
async function withServer(run) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { tmpdir } = await import("node:os");
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  // A different cwd, as npx and every client launch it from somewhere else.
  const child = spawn(process.execPath, [entry], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stray = 0;
  let nextId = 0;
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && waiting.has(msg.id)) {
          waiting.get(msg.id)(msg);
          waiting.delete(msg.id);
        }
      } catch {
        stray++; // anything on stdout that is not JSON corrupts the transport
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await run({ request, init: init.result, stray: () => stray });
  } finally {
    child.kill();
  }
}

await verify("the server speaks MCP over stdio and lists every tool", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await withServer(async ({ request, init, stray }) => {
    assert.equal(init.serverInfo.version, pkg.version, "reports package.json's version");
    assert.ok(init.capabilities.tools, "declares the tools capability");
    assert.ok(init.instructions, "sends its usage instructions");
    const list = await request("tools/list", {});
    assert.equal(list.result.tools.length, ALL_TOOLS.length);
    assert.equal(stray(), 0, "stdout carried something that is not JSON-RPC");
  });
});

await verify("no tool schema carries keywords that Gemini-based clients reject", async () => {
  await withServer(async ({ request }) => {
    const { tools } = (await request("tools/list", {})).result;
    const bad = [];
    const walk = (node, tool) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, tool));
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "$schema" || (k === "additionalProperties" && typeof v === "boolean")) {
          bad.push(`${tool}: ${k}`);
        }
        walk(v, tool);
      }
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    assert.deepEqual(bad, [], `these fail Gemini function declarations:\n  ${bad.join("\n  ")}`);
  });
});

await verify("stripping strict keywords keeps schemas that mean something", async () => {
  const { stripStrictKeywords } = await import("../dist/server.js");
  const out = stripStrictKeywords({
    $schema: "x",
    type: "object",
    additionalProperties: false,
    properties: {
      // A property named after the keyword holds a schema, so it stays.
      additionalProperties: { type: "string" },
      byName: { type: "object", additionalProperties: { type: "number" } },
    },
  });
  assert.equal(out.$schema, undefined);
  assert.equal(out.additionalProperties, undefined);
  assert.deepEqual(out.properties.additionalProperties, { type: "string" });
  assert.deepEqual(out.properties.byName.additionalProperties, { type: "number" });
});

await verify("every tool declares annotations and only the scaffold can write", async () => {
  await withServer(async ({ request }) => {
    const { tools } = (await request("tools/list", {})).result;
    for (const t of tools) {
      assert.ok(t.annotations, `${t.name} declares no annotations`);
      if (t.name === "wow_addon_scaffold") {
        assert.equal(t.annotations.readOnlyHint, false, "the scaffold writes files");
        assert.equal(t.annotations.destructiveHint, true, "and can overwrite them");
      } else {
        assert.equal(t.annotations.readOnlyHint, true, `${t.name} should be read-only`);
      }
      assert.equal(t.annotations.openWorldHint, false, `${t.name} reaches nothing beyond the machine`);
    }
  });
});

await verify("a tool call works end to end over the wire", async () => {
  await withServer(async ({ request, stray }) => {
    const res = await request("tools/call", {
      name: "wow_api_search",
      arguments: { query: "UnitHealth", limit: 3 },
    });
    assert.ok(!res.result.isError, JSON.stringify(res.result).slice(0, 200));
    assert.ok(res.result.content[0].text.includes("UnitHealth"));
    assert.equal(stray(), 0);
  });
});

await verify("a bad call is reported without taking the server down", async () => {
  await withServer(async ({ request }) => {
    const bad = await request("tools/call", {
      name: "wow_api_search",
      arguments: { query: "x", flavor: "not-a-flavor" },
    });
    // Either a tool error or a JSON-RPC error is acceptable. Silence is not.
    assert.ok(bad.error || bad.result?.isError, "an invalid flavor was accepted");
    const after = await request("tools/list", {});
    assert.equal(after.result.tools.length, ALL_TOOLS.length, "the server stopped answering");
  });
});

console.log("\n== Scaffold write safety ==");

// wow_addon_scaffold with `write` saves into the real AddOns folder. It used to
// call writeFileSync without looking first, so scaffolding a name that matched
// an installed addon silently replaced that addon's files.
async function scaffoldInTempRoot(run) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "addons-"));
  const prior = process.env.WOW_ADDON_PATH;
  process.env.WOW_ADDON_PATH = root;
  try {
    await run(root, join);
  } finally {
    if (prior === undefined) delete process.env.WOW_ADDON_PATH;
    else process.env.WOW_ADDON_PATH = prior;
    rmSync(root, { recursive: true, force: true });
  }
}

await verify("scaffold without write returns files and touches nothing", async () => {
  await scaffoldInTempRoot(async (root) => {
    const res = await byName.get("wow_addon_scaffold").handler({ name: "Probe" });
    assert.ok(res.content[0].text.includes("Probe/Probe.toc"));
    assert.ok(!existsSync(`${root}/Probe`), "wrote to disk without being asked");
  });
});

await verify("scaffold refuses to overwrite an existing addon", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  await scaffoldInTempRoot(async (root, join) => {
    const tool = byName.get("wow_addon_scaffold");
    const first = await tool.handler({ name: "Probe", write: true });
    assert.ok(!first.isError, first.content[0].text);

    // Stand in for the user's own edits to an addon that already exists.
    const core = join(root, "Probe", "Core.lua");
    writeFileSync(core, "-- the user's real work\n");

    const second = await tool.handler({ name: "Probe", write: true });
    assert.ok(second.isError, "a second write over existing files was allowed");
    assert.match(second.content[0].text, /already exist/);
    assert.equal(readFileSync(core, "utf8"), "-- the user's real work\n", "their file was changed");
  });
});

await verify("scaffold overwrites only when explicitly told to", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  await scaffoldInTempRoot(async (root, join) => {
    const tool = byName.get("wow_addon_scaffold");
    await tool.handler({ name: "Probe", write: true });
    const core = join(root, "Probe", "Core.lua");
    writeFileSync(core, "-- old\n");

    const res = await tool.handler({ name: "Probe", write: true, overwrite: true });
    assert.ok(!res.isError, res.content[0].text);
    assert.notEqual(readFileSync(core, "utf8"), "-- old\n", "overwrite: true did not overwrite");
  });
});

await verify("a refused scaffold leaves nothing half-written", async () => {
  const { writeFileSync, readdirSync } = await import("node:fs");
  await scaffoldInTempRoot(async (root, join) => {
    const tool = byName.get("wow_addon_scaffold");
    await tool.handler({ name: "Probe", write: true });
    // Only one of the files exists. The refusal must still cover the whole set,
    // not write the ones that are missing and stop at the one that is there.
    const { rmSync } = await import("node:fs");
    rmSync(join(root, "Probe", "Core.lua"));
    writeFileSync(join(root, "Probe", "Probe.toc"), "## Interface: 1\n");
    const before = readdirSync(join(root, "Probe")).sort();

    const res = await tool.handler({ name: "Probe", write: true });
    assert.ok(res.isError);
    assert.deepEqual(readdirSync(join(root, "Probe")).sort(), before, "it wrote some files anyway");
  });
});

await verify("a path-like addon name cannot escape the addon folder", async () => {
  const { readdirSync } = await import("node:fs");
  await scaffoldInTempRoot(async (root, join) => {
    const { dirname } = await import("node:path");
    const res = await byName.get("wow_addon_scaffold").handler({ name: "../Escaped", write: true });
    assert.ok(!res.isError, res.content[0].text);
    assert.ok(readdirSync(root).includes("Escaped"), "expected it inside the addon folder");
    assert.ok(!readdirSync(dirname(root)).includes("Escaped"), "it wrote outside the addon folder");
  });
});

console.log("\n== Per-client atlas ==");

// Atlases differ between clients: on the data synced for this work, 3,666
// exist only on WoW Forever and 720 only on retail. One shared file meant a
// Forever question was answered from retail's list, recommending atlases that do
// not exist there and hiding ones that do.

await verify("each client's atlas has its own file, and retail keeps the original name", async () => {
  const { DATA_PATHS } = await import("../dist/config.js");
  const files = ["mainline", "classic", "vanilla", "forever"].map((k) => DATA_PATHS.atlasFor(k));
  assert.equal(new Set(files).size, 4, "two clients would share a file");
  assert.ok(DATA_PATHS.atlasFor("mainline").endsWith("atlas-index.json"),
    "retail must keep its original name or existing synced data is orphaned");
  assert.ok(DATA_PATHS.atlasFor("forever").endsWith("atlas-index-forever.json"));
});

await verify("every client's synced atlas file is git-ignored", async () => {
  // These are Blizzard-derived and must never be committed. The ignore rule once
  // named only the retail file, so a new client's atlas sat untracked and one
  // broad `git add` away from being pushed.
  const { DATA_PATHS, FLAVORS } = await import("../dist/config.js");
  const { basename } = await import("node:path");
  const rules = (await readFile(new URL("../.gitignore", import.meta.url), "utf8"))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, (c) => "\\" + c).replace(/\*/g, "[^/]*") + "$"));

  for (const key of new Set(Object.values(FLAVORS).map((f) => f.apiIndex))) {
    const file = `data/${basename(DATA_PATHS.atlasFor(key))}`;
    assert.ok(rules.some((r) => r.test(file)), `${file} is not covered by .gitignore`);
  }
});

await verify("an atlas is never served for a different client", async () => {
  const { loadAtlas } = await import("../dist/gamedata/files.js");
  const { FLAVORS } = await import("../dist/config.js");
  for (const flavor of Object.values(FLAVORS)) {
    try {
      const atlas = loadAtlas(flavor);
      // A retail atlas synced before there was one per client has no flavor field.
      const servedFor = atlas.raw.flavor ?? (flavor.apiIndex === "mainline" ? "mainline" : undefined);
      assert.equal(servedFor, flavor.apiIndex, `${flavor.id} was answered from the ${servedFor} atlas`);
    } catch (err) {
      assert.match(err.message, /sync/i, `${flavor.id}: an error must say how to fix it`);
    }
  }
});

await verify("an unbuilt atlas says which client and the exact command", async () => {
  const { loadAtlas } = await import("../dist/gamedata/files.js");
  const { FLAVORS } = await import("../dist/config.js");
  // Whichever clients are built on this machine, an unbuilt one must name itself.
  for (const flavor of Object.values(FLAVORS)) {
    try { loadAtlas(flavor); } catch (err) {
      assert.ok(err.message.includes(flavor.label), `does not name ${flavor.label}`);
      assert.ok(err.message.includes(flavor.apiIndex), "does not give the client to sync");
      return;
    }
  }
});

await verify("every 'not synced' message tells a shell-less assistant what to do", async () => {
  const { dataMissingMessage, RUN_IT_YOURSELF, FLAVORS } = await import("../dist/config.js");
  const { loadAtlas } = await import("../dist/gamedata/files.js");
  const { loadUiSource } = await import("../dist/uisource/index.js");

  assert.ok(dataMissingMessage("x", "ui-source").includes(RUN_IT_YOURSELF));
  // The atlas and UI source loaders build their own messages, so check them too.
  for (const flavor of Object.values(FLAVORS)) {
    for (const load of [loadAtlas, loadUiSource]) {
      try { load(flavor); } catch (err) {
        assert.ok(err.message.includes(RUN_IT_YOURSELF), `${flavor.id}: ${err.message.split("\n")[0]}`);
      }
    }
  }
});

await verify("the atlas tool takes a flavor and ages its own data", async () => {
  const tool = ALL_TOOLS.find((t) => t.name === "wow_atlas_search");
  assert.ok("flavor" in tool.config.inputSchema, "no flavor argument");
  assert.equal(tool.dataset, "atlas", "it must age the atlas, not the listfile");
});

await verify("the newest real wago build is picked per client", async () => {
  const { pickLatestBuild, WAGO_PRODUCT } = await import("../dist/sync/wago.js");
  const builds = {
    wow_classic_beta: [
      { version: "1.60.1.69876", created_at: "2026-09-16 18:23:04" },
      { version: "1.60.1.69913", created_at: "2026-09-18 03:02:04" },
      { version: "1.60.1.69893", created_at: "2026-09-16 23:14:03" },
      // A background-download staging copy is newer but is not what players run.
      { version: "1.60.1.69999", created_at: "2026-09-19 01:00:00", is_bgdl: true },
    ],
    wow: [{ version: "12.1.0.69814", created_at: "2026-09-12 20:00:00" }],
  };
  assert.equal(pickLatestBuild(builds, "wow_classic_beta"), "1.60.1.69913");
  assert.equal(pickLatestBuild(builds, "wow"), "12.1.0.69814");
  assert.equal(pickLatestBuild(builds, "wow_classic_era"), undefined, "no builds must not invent one");

  const { FLAVORS } = await import("../dist/config.js");
  for (const key of new Set(Object.values(FLAVORS).map((f) => f.apiIndex))) {
    assert.ok(WAGO_PRODUCT[key], `${key} has no wago product, so its atlas can never be built`);
  }
});

console.log("\n== MCP Registry metadata ==");

// server.json is what `mcp-publisher publish` sends to the official registry, and
// the registry rejects a package whose mcpName or version does not match it.
// Both files are edited by hand at release time, so this is what notices one
// being bumped without the other.
await verify("server.json agrees with package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));

  assert.equal(server.name, pkg.mcpName, "the registry name must equal package.json mcpName");
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, "not a valid registry name");
  assert.ok(server.name.startsWith("io.github.RdyGaming/"), "GitHub auth requires the io.github.<user>/ prefix");
  assert.ok(server.description.length >= 1 && server.description.length <= 100,
    `description is ${server.description.length} characters; the registry allows 100`);

  assert.equal(server.version, pkg.version, "bump server.json with package.json");
  const npm = server.packages.find((p) => p.registryType === "npm");
  assert.ok(npm, "no npm package entry");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version, "the registry rejects a package version that is not published");
  assert.match(npm.version, /^\d+\.\d+\.\d+/, "must be an exact version, not a range or 'latest'");
  assert.equal(npm.transport.type, "stdio");
  assert.equal(server.repository.url.replace(/\.git$/, ""), pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
});

await verify("server.json declares exactly the environment variables the code reads", async () => {
  const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
  const declared = new Set(server.packages[0].environmentVariables.map((v) => v.name));

  const used = new Set();
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const next = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
      if (e.isDirectory()) await walk(next);
      else if (e.name.endsWith(".js")) {
        const src = await readFile(next, "utf8");
        for (const m of src.matchAll(/process\.env\.(WOW_[A-Z_]+)/g)) used.add(m[1]);
      }
    }
  };
  await walk(new URL("../dist/", import.meta.url));

  const undeclared = [...used].filter((n) => !declared.has(n));
  const unused = [...declared].filter((n) => !used.has(n));
  assert.deepEqual(undeclared, [], `read by the code but missing from server.json: ${undeclared}`);
  assert.deepEqual(unused, [], `declared in server.json but never read: ${unused}`);

  const choices = server.packages[0].environmentVariables.find((v) => v.name === "WOW_DEFAULT_FLAVOR").choices;
  assert.deepEqual([...choices].sort(), Object.keys(FLAVORS).sort(), "flavor choices drifted from config");
});

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
