# World of Warcraft Addon Development Rules

When developing, maintaining, or modifying World of Warcraft addons, you must adhere to the following principles:

## 1. Zero-Guesswork API Grounding
- **Never rely on training memory for WoW APIs.** Blizzard frequently refactors the API between expansions (notably the 10.0 Dragonflight and 11.0 The War Within overhauls).
- Always use `wow_api_search` to verify:
  - Exact namespace (e.g., `C_Item.*`, `C_Spell.*`, `C_Container.*`, `C_UnitAuras.*`).
  - Expected arguments, nilability, and parameter types.
  - Return signatures (many legacy multi-returns are now structured table objects).
  - Taint permission level (`AllowedWhenUntainted` vs `AllowedWhenTainted`).
- When an API is missing or behavior differs between Retail and Classic, check `wow_api_diff` to determine availability and migration paths.

## 2. Blizzard-First UI Discovery
- Do not build complex widgets, buttons, or scroll views from scratch in Lua.
- Use `wow_ui_template_search` and `wow_ui_mixin_search` to find and inherit existing Blizzard templates (e.g., `UIPanelButtonTemplate`, `BasicMessageDialogTemplate`, `ScrollBoxList`).
- Inspect Blizzard's reference implementations using `wow_ui_grep` and `wow_ui_read_file` to see how stock FrameXML handles similar UI patterns.

## 3. Execution Taint & Combat Lockdown
- **Protected Functions:** Never attempt to call protected functions (`CastSpellByName`, `TargetUnit`, `AttackTarget`, etc.) from generic addon execution paths. Use `SecureActionButtonTemplate` attributes or secure handlers.
- **Combat Lockdown:** Do not show, hide, re-anchor, or resize secure frames while `InCombatLockdown()` is true.
- **Safe Hooking:** Never overwrite Blizzard global functions or tables. Use `hooksecurefunc(functionName, hook)` or `hooksecurefunc(table, methodName, hook)` for post-hooks.
- **Global Pollution:** Namespace all globals under the addon's unique prefix, or use the private table `local addonName, ns = ...` passed into each addon file.

## 4. Texture and Asset Resolution
- Never invent hardcoded file paths (e.g., `"Interface\\AddOns\\MyAddon\\texture.png"`).
- For modern UI art, use `wow_atlas_search` to locate the atlas name and call `frame:SetAtlas(atlasName)`.
- For spell/item icons, use `wow_icon_search` to retrieve the numeric `FileDataID` and call `frame:SetTexture(fileDataID)`.

## 5. Mandatory Validation Gate
Before completing any task that adds, edits, or refactors addon files:
- Run `wow_lua_lint` on all touched `.lua` files (or inline snippets). Resolve all errors and warnings.
- Run `wow_toc_validate` on all touched `.toc` manifests.
- Run `wow_xml_validate` on all touched `.xml` files.
