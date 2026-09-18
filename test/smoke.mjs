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
