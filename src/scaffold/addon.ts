import type { Flavor } from "../config.js";

export interface ScaffoldOptions {
  name: string;
  author?: string;
  version?: string;
  notes?: string;
  /** Flavors to generate .toc files for. */
  flavors: Flavor[];
  savedVariables?: string[];
  savedVariablesPerCharacter?: string[];
  /** Include a slash-command handler. */
  slashCommand?: string;
  /** Include an options panel registered with the Settings API. */
  withOptions?: boolean;
  /** Include a movable main frame and an XML template file. */
  withFrame?: boolean;
  /** Include a LibStub/Ace-style embed folder layout. */
  withLibs?: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Generates a working addon skeleton.
 *
 * The generated code is deliberately idiomatic rather than minimal: it uses
 * the addon-vararg private table, defers work to ADDON_LOADED/PLAYER_LOGIN
 * rather than running at file scope, and registers settings through the modern
 * Settings API. Those are the three things new addons most often get wrong.
 */
export function scaffoldAddon(opts: ScaffoldOptions): GeneratedFile[] {
  const name = opts.name.replace(/[^\w-]/g, "");
  if (!name) throw new Error("Addon name must contain at least one word character.");

  const files: GeneratedFile[] = [];
  const sv = opts.savedVariables ?? [`${name}DB`];
  const svpc = opts.savedVariablesPerCharacter ?? [];

  // -- .toc files -----------------------------------------------------------
  const listedFiles = [
    ...(opts.withLibs ? ["Libs/LibStub/LibStub.lua"] : []),
    "Core.lua",
    ...(opts.withFrame ? ["Templates.xml", "UI.lua"] : []),
    ...(opts.withOptions ? ["Options.lua"] : []),
  ];

  // A single unsuffixed .toc with a comma-separated Interface list is the
  // simplest thing that works when one codebase serves every client; separate
  // suffixed files are only needed when the code itself differs per flavor.
  const singleToc = opts.flavors.length > 1;

  const tocBody = (flavors: Flavor[]): string => {
    const lines = [
      `## Interface: ${flavors.map((f) => f.interfaceVersion).join(", ")}`,
      `## Title: ${name}`,
      `## Notes: ${opts.notes ?? `${name} — a World of Warcraft addon.`}`,
      `## Author: ${opts.author ?? "Your Name"}`,
      `## Version: ${opts.version ?? "1.0.0"}`,
      `## X-Curse-Project-ID: `,
      sv.length ? `## SavedVariables: ${sv.join(", ")}` : "",
      svpc.length ? `## SavedVariablesPerCharacter: ${svpc.join(", ")}` : "",
      "## IconTexture: Interface\\Icons\\INV_Misc_QuestionMark",
      "",
      ...listedFiles,
      "",
    ];
    return lines.filter((l) => l !== "").join("\n") + "\n";
  };

  if (singleToc) {
    files.push({ path: `${name}/${name}.toc`, content: tocBody(opts.flavors) });
  } else {
    for (const flavor of opts.flavors) {
      const suffix = opts.flavors.length === 1 ? "" : flavor.tocSuffix;
      files.push({
        path: `${name}/${name}${suffix}.toc`,
        content: tocBody([flavor]),
      });
    }
  }

  // -- Core.lua -------------------------------------------------------------
  files.push({ path: `${name}/Core.lua`, content: coreLua(name, opts, sv[0]!) });

  if (opts.withFrame) {
    files.push({ path: `${name}/Templates.xml`, content: templatesXml(name) });
    files.push({ path: `${name}/UI.lua`, content: uiLua(name) });
  }

  if (opts.withOptions) {
    files.push({ path: `${name}/Options.lua`, content: optionsLua(name) });
  }

  files.push({ path: `${name}/README.md`, content: readme(name, opts) });

  return files;
}

// ---------------------------------------------------------------------------

function coreLua(name: string, opts: ScaffoldOptions, dbName: string): string {
  const slash = opts.slashCommand ?? name.toLowerCase();

  return `-- ${name}/Core.lua
-- Every addon file is called with (addonName, privateTable). The private table
-- is shared across this addon's files and is invisible to other addons, which
-- makes it the right place for shared state instead of a global.
local addonName, ns = ...

ns.name = addonName
ns.version = C_AddOns.GetAddOnMetadata(addonName, "Version") or "dev"

-- Defaults are kept separate from saved data so new settings appear for
-- existing users without wiping what they already configured.
local defaults = {
    enabled = true,
    scale = 1.0,
}

local function ApplyDefaults(target, source)
    for key, value in pairs(source) do
        if type(value) == "table" then
            if type(target[key]) ~= "table" then target[key] = {} end
            ApplyDefaults(target[key], value)
        elseif target[key] == nil then
            target[key] = value
        end
    end
    return target
end

-- ---------------------------------------------------------------------------
-- Event handling
-- ---------------------------------------------------------------------------

-- One frame with a dispatch table beats one frame per event: registration stays
-- in a single place and the handler lookup is a table index, not a chain of ifs.
local events = CreateFrame("Frame")
local handlers = {}

function ns:RegisterEvent(event, handler)
    handlers[event] = handler
    events:RegisterEvent(event)
end

events:SetScript("OnEvent", function(_, event, ...)
    local handler = handlers[event]
    if handler then handler(...) end
end)

-- ---------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------

ns:RegisterEvent("ADDON_LOADED", function(loadedAddon)
    if loadedAddon ~= addonName then return end

    -- SavedVariables only exist once ADDON_LOADED has fired for this addon;
    -- reading ${dbName} at file scope would always see nil.
    ${dbName} = ApplyDefaults(${dbName} or {}, defaults)
    ns.db = ${dbName}

    events:UnregisterEvent("ADDON_LOADED")
end)

ns:RegisterEvent("PLAYER_LOGIN", function()
    -- PLAYER_LOGIN is the first point at which player and UI state is reliable.
    if ns.db.enabled then
        ns:Print("loaded. Type /${slash} for options.")
    end
end)

-- ---------------------------------------------------------------------------
-- Output
-- ---------------------------------------------------------------------------

local PREFIX = "|cff33ff99" .. addonName .. "|r:"

function ns:Print(...)
    print(PREFIX, ...)
end

function ns:Debug(...)
    if ns.db and ns.db.debug then
        print("|cffff9900" .. addonName .. " debug|r:", ...)
    end
end

-- ---------------------------------------------------------------------------
-- Slash command
-- ---------------------------------------------------------------------------

SLASH_${name.toUpperCase()}1 = "/${slash}"
SlashCmdList["${name.toUpperCase()}"] = function(msg)
    local command, rest = msg:match("^(%S*)%s*(.-)$")
    command = command:lower()

    if command == "" or command == "config" then
${
  opts.withOptions
    ? `        Settings.OpenToCategory(ns.settingsCategory:GetID())`
    : `        ns:Print("version " .. ns.version)`
}
    elseif command == "toggle" then
        ns.db.enabled = not ns.db.enabled
        ns:Print("now " .. (ns.db.enabled and "enabled" or "disabled") .. ".")
    elseif command == "debug" then
        ns.db.debug = not ns.db.debug
        ns:Print("debug " .. (ns.db.debug and "on" or "off") .. ".")
    else
        ns:Print("commands: config, toggle, debug")
    end

    -- rest is unused in the skeleton; kept so subcommands can take arguments.
    local _ = rest
end
`;
}

function templatesXml(name: string): string {
  return `<Ui xmlns="http://www.blizzard.com/wow/ui/">
    <!--
        Virtual frames are templates: they are never created on their own, but
        can be inherited by name from Lua (CreateFrame's fourth argument) or
        from other XML.
    -->
    <Frame name="${name}MainFrameTemplate" mixin="${name}MainFrameMixin" virtual="true"
           movable="true" enableMouse="true" clampedToScreen="true">
        <Size x="320" y="200"/>
        <Anchors>
            <Anchor point="CENTER"/>
        </Anchors>

        <Layers>
            <Layer level="ARTWORK">
                <FontString parentKey="Title" inherits="GameFontNormalLarge" text="${name}">
                    <Anchors>
                        <Anchor point="TOP" x="0" y="-14"/>
                    </Anchors>
                </FontString>
            </Layer>
        </Layers>

        <Frames>
            <Button parentKey="CloseButton" inherits="UIPanelCloseButton">
                <Anchors>
                    <Anchor point="TOPRIGHT" x="-4" y="-4"/>
                </Anchors>
            </Button>
        </Frames>

        <Scripts>
            <OnLoad method="OnLoad"/>
            <OnShow method="OnShow"/>
            <OnDragStart method="OnDragStart"/>
            <OnDragStop method="OnDragStop"/>
        </Scripts>
    </Frame>
</Ui>
`;
}

function uiLua(name: string): string {
  return `-- ${name}/UI.lua
local addonName, ns = ...

-- A mixin is a plain table of methods that XML attaches to a frame via the
-- mixin="" attribute. Inside these methods, self is the frame.
${name}MainFrameMixin = {}

function ${name}MainFrameMixin:OnLoad()
    self:RegisterForDrag("LeftButton")
    self:SetClampedToScreen(true)

    -- Escape closes the frame, matching the rest of the UI.
    tinsert(UISpecialFrames, self:GetName())
end

function ${name}MainFrameMixin:OnShow()
    self:SetScale(ns.db and ns.db.scale or 1.0)
end

function ${name}MainFrameMixin:OnDragStart()
    self:StartMoving()
end

function ${name}MainFrameMixin:OnDragStop()
    self:StopMovingOrSizing()
end

-- Created lazily: building frames at load time costs every player memory even
-- if they never open the window.
function ns:GetMainFrame()
    if not ns.mainFrame then
        ns.mainFrame = CreateFrame("Frame", addonName .. "MainFrame", UIParent,
                                   "${name}MainFrameTemplate")
        ns.mainFrame:Hide()
    end
    return ns.mainFrame
end

function ns:ToggleMainFrame()
    local frame = ns:GetMainFrame()
    frame:SetShown(not frame:IsShown())
end
`;
}

function optionsLua(name: string): string {
  return `-- ${name}/Options.lua
local addonName, ns = ...

-- The Settings API replaced InterfaceOptions_AddCategory in 10.0. Registering
-- through it is what puts the panel in the modern options window.
local function BuildSettings()
    local category, layout = Settings.RegisterVerticalLayoutCategory("${name}")
    ns.settingsCategory = category

    do
        local setting = Settings.RegisterAddOnSetting(
            category, addonName .. "_Enabled", "enabled", ns.db,
            Settings.VarType.Boolean, "Enable ${name}", true)
        Settings.CreateCheckbox(category, setting, "Turn ${name} on or off.")
    end

    do
        local setting = Settings.RegisterAddOnSetting(
            category, addonName .. "_Scale", "scale", ns.db,
            Settings.VarType.Number, "Scale", 1.0)

        local function GetOptions()
            local container = Settings.CreateSliderOptions(0.5, 2.0, 0.05)
            container:SetLabelFormatter(MinimalSliderWithSteppersMixin.Label.Right,
                function(value) return string.format("%.0f%%", value * 100) end)
            return container
        end

        Settings.CreateSlider(category, setting, GetOptions(),
                              "Scale of the ${name} window.")
    end

    Settings.RegisterAddOnCategory(category)

    -- layout is available for custom initializers; unused in the skeleton.
    local _ = layout
end

-- The settings panel reads ns.db, so it can only be built after SavedVariables
-- have loaded.
ns:RegisterEvent("PLAYER_LOGIN", BuildSettings)
`;
}

function readme(name: string, opts: ScaffoldOptions): string {
  const flavorList = opts.flavors.map((f) => `${f.label} (${f.interfaceVersion})`);

  return `# ${name}

${opts.notes ?? `A World of Warcraft addon.`}

## Supported clients

${flavorList.map((f) => `- ${f}`).join("\n")}

## Installing for development

Copy or symlink this folder into your AddOns directory:

\`\`\`
World of Warcraft/_retail_/Interface/AddOns/${name}/
\`\`\`

A symlink is usually better than a copy — the client reads the files at load
time, so \`/reload\` picks up your edits without another copy step.

## Layout

| File | Purpose |
| --- | --- |
| \`${name}.toc\` | Manifest: interface version, metadata, and load order |
| \`Core.lua\` | Event dispatch, SavedVariables, slash command |
${opts.withFrame ? `| \`Templates.xml\` | Virtual frame templates |\n| \`UI.lua\` | Frame mixin and lazy construction |\n` : ""}${opts.withOptions ? `| \`Options.lua\` | Settings panel |\n` : ""}
## Notes

- Files load in the order they are listed in the \`.toc\`.
- \`SavedVariables\` are only populated once \`ADDON_LOADED\` fires for this addon.
- Use \`/reload\` after editing Lua; \`/console scriptErrors 1\` shows Lua errors.
`;
}
