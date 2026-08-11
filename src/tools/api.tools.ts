import { z } from "zod";

import { FLAVOR_IDS, resolveFlavor } from "../config.js";
import { loadIndex } from "../wowapi/index.js";
import {
  renderEvent,
  renderFunction,
  renderTable,
  searchEvents,
  searchFunctions,
  searchTables,
} from "../wowapi/search.js";
import { text, type ToolDef } from "./shared.js";

const flavorArg = z
  .enum(FLAVOR_IDS)
  .optional()
  .describe("Game client to answer for. Defaults to WOW_DEFAULT_FLAVOR, or retail.");

export const apiTools: ToolDef[] = [
  {
    name: "wow_api_search",
    config: {
      title: "Search the in-game Lua API",
      description:
        "Search World of Warcraft's in-game Lua API — the functions an addon can " +
        "call from inside the client. Covers namespaced functions (C_Item.GetItemInfo), " +
        "legacy globals (UnitHealth), and widget methods (Frame:SetPoint). Results " +
        "include full argument and return signatures. Use this before writing any " +
        "addon code that calls the game.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Function name or fragment. Matches exact names, prefixes, substrings " +
              "and camel-hump abbreviations (GIIBID finds GetItemInfoByID).",
          ),
        flavor: flavorArg,
        namespace: z
          .string()
          .optional()
          .describe("Restrict to one namespace, e.g. C_Spell."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handler: async ({ query, flavor, namespace, limit }) => {
      const f = resolveFlavor(flavor as string | undefined);
      const index = loadIndex(f);
      const hits = searchFunctions(index, query as string, {
        ...(namespace ? { namespace: namespace as string } : {}),
        limit: (limit as number) ?? 25,
      });

      if (hits.length === 0) {
        return text(
          `No API function matching "${query}" in ${f.label}.\n\n` +
            "It may be a widget method (try searching the bare method name), a " +
            "removed API (try wow_lua_lint on the calling code), or defined by a " +
            "library rather than the client.",
        );
      }

      return text(
        `${hits.length} result(s) for "${query}" in ${f.label}:\n\n` +
          hits.map((h) => renderFunction(h.item)).join("\n\n"),
      );
    },
  },

  {
    name: "wow_api_event_search",
    config: {
      title: "Search in-game events",
      description:
        "Search the events an addon can register with frame:RegisterEvent, and " +
        "show each event's payload arguments in order. Use this whenever writing " +
        "an OnEvent handler, so the argument list matches what the client sends.",
      inputSchema: {
        query: z.string().describe("Event name or fragment, e.g. COMBAT_LOG or BAG_UPDATE."),
        flavor: flavorArg,
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handler: async ({ query, flavor, limit }) => {
      const f = resolveFlavor(flavor as string | undefined);
      const index = loadIndex(f);
      const hits = searchEvents(index, query as string, (limit as number) ?? 25);

      if (hits.length === 0) {
        return text(`No event matching "${query}" in ${f.label}.`);
      }

      return text(
        `${hits.length} event(s) for "${query}" in ${f.label}:\n\n` +
          hits.map((h) => renderEvent(h.item)).join("\n\n"),
      );
    },
  },

  {
    name: "wow_api_type_search",
    config: {
      title: "Search API enums, structures and constants",
      description:
        "Search the Enum.*, Constants.* and structure tables the in-game API uses " +
        "— for example Enum.ItemQuality or the AuraData structure returned by " +
        "C_UnitAuras. Searching for a member name finds the table that contains it.",
      inputSchema: {
        query: z.string().describe("Type, enum, constant or member name."),
        flavor: flavorArg,
        kind: z
          .enum(["Enumeration", "Structure", "Constants", "CallbackType"])
          .optional()
          .describe("Restrict to one kind of table."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handler: async ({ query, flavor, kind, limit }) => {
      const f = resolveFlavor(flavor as string | undefined);
      const index = loadIndex(f);
      const hits = searchTables(index, query as string, {
        ...(kind ? { kind: kind as string } : {}),
        limit: (limit as number) ?? 25,
      });

      if (hits.length === 0) return text(`No type matching "${query}" in ${f.label}.`);

      return text(
        `${hits.length} type(s) for "${query}" in ${f.label}:\n\n` +
          hits.map((h) => renderTable(h.item)).join("\n\n"),
      );
    },
  },

  {
    name: "wow_api_diff",
    config: {
      title: "Compare API availability across clients",
      description:
        "Check whether a function, event or type exists in each game client " +
        "(retail, Classic progression, Classic Era). Use this before writing code " +
        "that has to run on more than one flavor, or to explain why something " +
        "works on Classic but not retail.",
      inputSchema: {
        name: z
          .string()
          .describe("Function, event or type name, e.g. GetSpellInfo or C_Item.GetItemInfo."),
      },
    },
    handler: async ({ name }) => {
      const target = name as string;
      const lines: string[] = [`Availability of "${target}":`, ""];

      for (const flavorId of ["mainline", "mists", "vanilla"]) {
        const f = resolveFlavor(flavorId);
        const index = loadIndex(f);

        // An exact signature match answers for a qualified name; for a bare
        // name only a *non-namespaced* function counts, because C_Spell.Foo
        // existing says nothing about whether bare Foo is still callable.
        const exact = index.bySignature.get(target.toLowerCase());
        const bareFn = target.includes(".")
          ? undefined
          : index.byName.get(target.toLowerCase())?.find((f) => !f.namespace);

        const isGlobal = index.globalSet.has(target);
        const isEvent = index.eventSet.has(target.toUpperCase());
        const type = index.byTable.get(target.toLowerCase());

        const found: string[] = [];
        if (isGlobal) found.push("callable as a global");
        if (exact) found.push(`documented as ${exact.signature}`);
        else if (bareFn && !isGlobal) found.push("documented");
        if (isEvent) found.push("valid event");
        if (type) found.push(`${type.kind} table`);

        lines.push(
          `  ${f.label.padEnd(34)} ${found.length ? found.join("; ") : "NOT AVAILABLE"}`,
        );
      }

      // A bare name missing everywhere usually means it moved into a namespace,
      // which is the actionable answer rather than a flat "not found".
      if (!target.includes(".")) {
        const retail = loadIndex(resolveFlavor("mainline"));
        const moved = (retail.byName.get(target.toLowerCase()) ?? [])
          .filter((f) => f.namespace)
          .map((f) => f.signature);
        if (moved.length && !retail.globalSet.has(target)) {
          lines.push("", `Moved into a namespace on retail: ${moved.join(", ")}`);
        }
      }

      return text(lines.join("\n"));
    },
  },

  {
    name: "wow_api_stats",
    config: {
      title: "Show what API data is loaded",
      description:
        "Report which API index, UI source and game data sets this server has, " +
        "when each was synced, and how large it is. Use this to confirm the data " +
        "is present and current before relying on other tools.",
      inputSchema: {},
    },
    handler: async () => {
      const lines: string[] = ["WoW MCP server — loaded data sets", ""];

      for (const flavorId of ["mainline", "mists", "vanilla"]) {
        const f = resolveFlavor(flavorId);
        try {
          const index = loadIndex(f);
          lines.push(
            `  ${f.label}`,
            `    index:    ${index.raw.upstream.uiSource}`,
            `    synced:   ${index.raw.generatedAt}`,
            `    contents: ${Object.entries(index.raw.counts)
              .map(([k, v]) => `${v} ${k}`)
              .join(", ")}`,
            "",
          );
        } catch (err) {
          lines.push(`  ${f.label}: ${(err as Error).message}`, "");
        }
      }

      return text(lines.join("\n"));
    },
  },
];
