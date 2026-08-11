/**
 * Hand-curated knowledge that cannot be derived from Blizzard's generated
 * documentation.
 *
 * Most deprecation detection in this server is data-driven: if a name is not
 * callable in a flavor's index but a namespaced function of the same name is,
 * the migration is obvious and `analyze.ts` infers it. This file covers the
 * cases where that inference fails — renames, signature changes, and semantic
 * traps that no index can express.
 */

export interface Migration {
  /** The removed or discouraged global. */
  from: string;
  /** What to call instead, or null when there is no drop-in replacement. */
  to: string | null;
  /** Flavors where the removal applies; omit for "all". */
  flavors?: string[];
  /**
   * Overrides the default grading. Without it, `to: null` is treated as a hard
   * removal (error) — which is wrong for entries that are advice about a
   * function that still works.
   */
  severity?: "error" | "warning" | "info";
  note: string;
}

/**
 * Renames where the replacement has a *different* name, so same-name lookup
 * cannot find it. Everything here was removed outright — calling it raises
 * "attempt to call a nil value".
 */
export const RENAMES: Migration[] = [
  {
    from: "UnitAura",
    to: "C_UnitAuras.GetAuraDataByIndex",
    note:
      "Removed. The replacement returns a single AuraData table instead of ~17 " +
      "return values; use AuraUtil.ForEachAura to iterate.",
  },
  {
    from: "UnitBuff",
    to: "C_UnitAuras.GetBuffDataByIndex",
    note: "Removed. Returns an AuraData table, not a multi-return.",
  },
  {
    from: "UnitDebuff",
    to: "C_UnitAuras.GetDebuffDataByIndex",
    note: "Removed. Returns an AuraData table, not a multi-return.",
  },
  {
    from: "UnitAuraByAuraInstanceID",
    to: "C_UnitAuras.GetAuraDataByAuraInstanceID",
    note: "Removed in favour of the C_UnitAuras namespace.",
  },
  {
    from: "GetMouseFocus",
    to: "GetMouseFoci",
    note:
      "Removed. GetMouseFoci returns a table of frames under the cursor; take " +
      "index [1] for the old behaviour.",
  },
  {
    from: "GetSpellDescription",
    to: "C_Spell.GetSpellDescription",
    note: "Moved into C_Spell.",
  },
  {
    from: "GetSpellLink",
    to: "C_Spell.GetSpellLink",
    note: "Moved into C_Spell.",
  },
  {
    from: "GetTalentInfo",
    to: null,
    flavors: ["mainline"],
    note:
      "The Dragonflight talent rework replaced the talent-tier model entirely. " +
      "Use C_ClassTalents and C_Traits instead; there is no drop-in equivalent.",
  },
  {
    from: "GetNumTalents",
    to: null,
    flavors: ["mainline"],
    note: "Removed with the talent rework. See C_Traits.",
  },
  {
    from: "GetQuestLogTitle",
    to: "C_QuestLog.GetInfo",
    flavors: ["mainline"],
    note:
      "Removed on retail. C_QuestLog.GetInfo(index) returns a QuestInfo table " +
      "keyed by field name rather than positional returns.",
  },
  {
    from: "GetQuestLogSelection",
    to: "C_QuestLog.GetSelectedQuest",
    flavors: ["mainline"],
    note: "Removed on retail.",
  },
  {
    from: "SetItemRef",
    to: null,
    severity: "info",
    note:
      "Still exists and is safe to call. If you mean to intercept chat links, " +
      "hook it with hooksecurefunc('SetItemRef', ...) rather than replacing it.",
  },
];

/**
 * Calls that still exist but whose *return shape* changed. Same name, same
 * namespace move, silently different data — the worst failure mode, because
 * the addon loads and then misbehaves.
 */
export const SIGNATURE_CHANGES: Migration[] = [
  {
    from: "C_Container.GetContainerItemInfo",
    to: "C_Container.GetContainerItemInfo",
    note:
      "Returns a single ContainerItemInfo table since 10.0 — the old multi-return " +
      "form (icon, count, locked, quality, ...) is gone. Index the table by field.",
  },
  {
    from: "C_Spell.GetSpellInfo",
    to: "C_Spell.GetSpellInfo",
    note:
      "Returns a SpellInfo table since 11.0, not (name, rank, icon, castTime, ...). " +
      "Read .name / .iconID / .castTime instead of positional returns.",
  },
  {
    from: "C_Spell.GetSpellCooldown",
    to: "C_Spell.GetSpellCooldown",
    note:
      "Returns a SpellCooldownInfo table since 11.0, not (start, duration, enabled).",
  },
  {
    from: "C_Item.GetItemInfo",
    to: "C_Item.GetItemInfo",
    note:
      "Still a multi-return, but returns nil for items not yet cached by the " +
      "client. Handle the nil case and retry on GET_ITEM_INFO_RECEIVED.",
  },
];

// ---------------------------------------------------------------------------
// Taint
// ---------------------------------------------------------------------------

/**
 * Functions the client refuses to run from addon (tainted) execution paths.
 * Calling one from an addon triggers "Interface action failed because of an
 * AddOn" — the single most common bug report an addon author receives.
 */
export const PROTECTED_FUNCTIONS = new Set([
  "CastSpellByName", "CastSpellByID", "UseAction", "UseInventoryItem",
  "UseContainerItem", "C_Container.UseContainerItem", "TargetUnit",
  "TargetNearestEnemy", "TargetNearestFriend", "FollowUnit", "AttackTarget",
  "PetAttack", "PetFollow", "PetPassiveMode", "PetDefensiveAssistMode",
  "RunMacro", "RunMacroText", "AcceptGroup", "ConfirmSummon",
  "JoinBattlefield", "AcceptBattlefieldPort", "CancelUnitBuff",
  "ClickTargetTradeButton", "InteractUnit", "TurnOrActionStart",
  "CameraOrSelectOrMoveStart", "MoveForwardStart", "JumpOrAscendStart",
  "SetView", "SaveView", "StopAttack", "PetStopAttack", "DismissCompanion",
  "SummonPetByGUID",
]);

/**
 * Frame methods that are protected while the player is in combat. Calling one
 * inside combat lockdown throws an error even for otherwise-secure frames.
 */
export const COMBAT_LOCKED_METHODS = new Set([
  "SetAttribute", "SetPoint", "ClearAllPoints", "SetParent", "Show", "Hide",
  "SetWidth", "SetHeight", "SetSize", "SetScale", "SetAllPoints",
  "RegisterForClicks", "SetFrameStrata", "SetFrameLevel", "EnableMouse",
]);

/** Templates whose frames are secure; touching them needs combat awareness. */
export const SECURE_TEMPLATES = [
  "SecureActionButtonTemplate",
  "SecureUnitButtonTemplate",
  "SecureHandlerStateTemplate",
  "SecureHandlerAttributeTemplate",
  "SecureHandlerClickTemplate",
  "SecureHandlerShowHideTemplate",
  "SecureHandlerEnterLeaveTemplate",
  "SecureHandlerDragTemplate",
  "SecureHandlerBaseTemplate",
  "SecureAuraHeaderTemplate",
  "SecureGroupHeaderTemplate",
  "SecureGroupPetHeaderTemplate",
];

/**
 * Assigning to any of these taints the global environment for everyone, not
 * just the offending addon. Blizzard's own UI reads them, so a tainted value
 * propagates into protected code paths.
 */
export const TAINTED_IF_ASSIGNED = new Set([
  "UIParent", "GameTooltip", "PlayerFrame", "TargetFrame", "ChatFrame1",
  "MainMenuBar", "ActionButton1", "CompactRaidFrameContainer",
  "CompactRaidFrameManager", "SlashCmdList", "StaticPopupDialogs",
  "UISpecialFrames", "UIPanelWindows", "hooksecurefunc", "issecure",
  "securecall", "getglobal", "setglobal",
]);

// ---------------------------------------------------------------------------
// Style / correctness patterns
// ---------------------------------------------------------------------------

export interface PatternRule {
  id: string;
  severity: "error" | "warning" | "info";
  /** Matched against each source line. */
  pattern: RegExp;
  message: string;
  /** Skip when the file is for one of these flavors. */
  notForFlavors?: string[];
}

export const PATTERN_RULES: PatternRule[] = [
  {
    id: "loadstring-in-addon",
    severity: "error",
    pattern: /\b(loadstring|load)\s*\(/,
    message:
      "loadstring/load runs arbitrary Lua. Addons using it are routinely " +
      "rejected by CurseForge and WoWInterface, and the compiled chunk is tainted.",
  },
  {
    id: "setfenv-global",
    severity: "warning",
    pattern: /\bsetfenv\s*\(\s*(0|1)\s*,/,
    message:
      "setfenv on the caller's environment leaks into other addons and taints " +
      "the global environment. Use a local table instead.",
  },
  {
    id: "onupdate-string-alloc",
    severity: "info",
    pattern: /SetScript\s*\(\s*["']OnUpdate["']/,
    message:
      "OnUpdate runs every frame. Avoid string concatenation, table creation " +
      "and format() inside it; throttle with an elapsed accumulator instead.",
  },
  {
    id: "global-frame-name",
    severity: "info",
    pattern: /CreateFrame\s*\(\s*["'][^"']+["']\s*,\s*["'][^"']*["']/,
    message:
      "Naming a frame creates a global with that name. Prefix it with your " +
      "addon name to avoid colliding with other addons.",
  },
  {
    id: "unitid-string-concat",
    severity: "warning",
    pattern: /["']raid["']\s*\.\.\s*\w+|["']party["']\s*\.\.\s*\w+/,
    message:
      "Building unit IDs with concatenation allocates a string per call. Cache " +
      "them in a table indexed by group slot if this runs in a hot path.",
  },
  {
    id: "print-left-in",
    severity: "info",
    pattern: /^\s*print\s*\(/,
    message:
      "A bare print() writes to the default chat frame. Route user-facing output " +
      "through your own prefixed printer so players can identify the source.",
  },
  {
    id: "combat-log-getcombatloginfo",
    severity: "warning",
    pattern: /COMBAT_LOG_EVENT_UNFILTERED/,
    message:
      "COMBAT_LOG_EVENT_UNFILTERED carries no payload arguments — read the event " +
      "with CombatLogGetCurrentEventInfo() inside the handler.",
  },
  {
    id: "deprecated-getglobal",
    severity: "warning",
    pattern: /\bgetglobal\s*\(/,
    message: "getglobal is deprecated. Index _G directly: _G[name].",
  },
  {
    id: "frame-strata-tooltip",
    severity: "info",
    pattern: /SetFrameStrata\s*\(\s*["']TOOLTIP["']/,
    message:
      "The TOOLTIP strata sits above almost everything, including menus. Use " +
      "DIALOG or FULLSCREEN_DIALOG unless the frame really is a tooltip.",
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const renameIndex = new Map(RENAMES.map((m) => [m.from, m]));
const signatureIndex = new Map(SIGNATURE_CHANGES.map((m) => [m.from, m]));

export function findRename(name: string, flavor: string): Migration | undefined {
  const m = renameIndex.get(name);
  if (!m) return undefined;
  if (m.flavors && !m.flavors.includes(flavor)) return undefined;
  return m;
}

export function findSignatureChange(name: string): Migration | undefined {
  return signatureIndex.get(name);
}
