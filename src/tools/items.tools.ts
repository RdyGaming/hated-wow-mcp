import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { dataDir, hotfixCachePath, openDriver, pickInstall, setupProblem } from "../wowexport/index.js";
import { cap, errorText, text, type ToolDef } from "./shared.js";

const QUALITY = ["poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom"];
const BINDING = ["none", "bop", "boe", "use", "quest"] as const;
const BIND_LABEL = ["", "BoP", "BoE", "BoU", "Quest"];
const SLOT: Record<number, string> = {
  1: "head", 2: "neck", 3: "shoulder", 4: "shirt", 5: "chest", 6: "waist", 7: "legs", 8: "feet",
  9: "wrist", 10: "hands", 11: "finger", 12: "trinket", 13: "one-hand", 14: "shield", 15: "ranged",
  16: "back", 17: "two-hand", 18: "bag", 19: "tabard", 20: "robe", 21: "main hand", 22: "off hand",
  23: "held in off hand", 24: "ammo", 25: "thrown", 26: "ranged (gun/wand)", 28: "relic",
};

export const itemTools: ToolDef[] = [
  {
    name: "wow_item_search",
    config: {
      title: "Search every item the client knows",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        "Search items in the local game files with the client's hotfix cache " +
        "(Cache/ADB/<locale>/DBCache.bin) laid over them. Hotfixes carry items added or changed " +
        "after the build shipped; on WoW Forever every new item exists only there. Filter by " +
        "name, quality, binding, required level, slot or new-only, and optionally write every " +
        "match as JSON (id, name, quality, item level, required level, binding, slot, class and " +
        "subclass, item set). Does not say where an item drops: loot sources are server-side. " +
        "Opens the game storage, so the first call takes about 40 seconds.",
      inputSchema: {
        query: z.string().optional().describe("Name fragment or exact item id. Empty matches everything."),
        quality: z.enum(QUALITY as [string, ...string[]]).optional(),
        binding: z.enum(BINDING).optional().describe("bop = bind on pickup, boe = bind on equip."),
        minLevel: z.number().int().optional().describe("Lowest required level."),
        maxLevel: z.number().int().optional().describe("Highest required level."),
        slot: z.number().int().optional().describe("Inventory type number, e.g. 2 neck, 16 back, 17 two-hand."),
        newOnly: z.boolean().optional().describe("Only items added after the build shipped (in the hotfix cache, not the game files)."),
        changedOnly: z.boolean().optional().describe("Only items the hotfix cache adds or changes."),
        limit: z.number().int().min(1).max(500).optional().describe("Rows listed in the reply. Default 50."),
        outputFile: z.string().optional().describe("Write every match (not just the listed rows) to this JSON file."),
        flavor: z.string().optional().describe("Which installed client: mainline, forever, classic or vanilla."),
      },
    },
    handler: async (args) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      for (const table of ["Item", "ItemSparse"]) {
        if (!existsSync(join(dataDir(), "dbd", `${table}.dbd`))) {
          return errorText(`Missing the ${table} table definition. Run the model-data sync (npm run sync-model-data).`);
        }
      }
      try {
        const flavor = args.flavor as string | undefined;
        const install = pickInstall(flavor);
        const cachePath = hotfixCachePath(install) ?? undefined;
        const driver = await openDriver(flavor);
        const quality = args.quality ? QUALITY.indexOf(args.quality as string) : undefined;
        const binding = args.binding ? BINDING.indexOf(args.binding as (typeof BINDING)[number]) : undefined;
        const res = await driver.searchItems({
          ...(cachePath ? { cachePath } : {}),
          ...(args.query !== undefined ? { query: args.query as string } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(binding !== undefined ? { binding } : {}),
          ...(args.minLevel !== undefined ? { minLevel: args.minLevel as number } : {}),
          ...(args.maxLevel !== undefined ? { maxLevel: args.maxLevel as number } : {}),
          ...(args.slot !== undefined ? { inventoryType: args.slot as number } : {}),
          ...(args.newOnly ? { newOnly: true } : {}),
          ...(args.changedOnly ? { hotfixOnly: true } : {}),
        });

        let written = "";
        if (args.outputFile) {
          const out = resolve(args.outputFile as string);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, JSON.stringify(res.items, null, 1));
          written = `\nWrote ${res.items.length} items to ${out}`;
        }

        const source = cachePath
          ? `${res.known} items known, ${res.hotfixCount} from the hotfix cache, ${res.newCount} of them new (build ${res.build ?? "?"})` +
            (res.skipped ? `, ${res.skipped} cache rows skipped (layout mismatch)` : "")
          : `${res.known} items known (no hotfix cache found for this install)`;
        if (res.total === 0) return text(`No items match. ${source}.${written}`);
        const limit = (args.limit as number | undefined) ?? 50;
        const lines = res.items.slice(0, limit).map((it) =>
          [
            `${it.id}  ${it.name}`,
            QUALITY[it.quality] ?? String(it.quality),
            `ilvl ${it.itemLevel}`,
            `req ${it.requiredLevel}`,
            BIND_LABEL[it.binding] ?? "",
            SLOT[it.inventoryType] ?? "",
            it.isNew ? "new" : it.hotfix ? "hotfix" : "",
          ]
            .filter(Boolean)
            .join("  "),
        );
        const more = res.total > limit ? `\n... ${res.total - limit} more (raise limit or use outputFile)` : "";
        return text(cap(`${res.total} match. ${source}.\n${lines.join("\n")}${more}${written}`));
      } catch (err) {
        return errorText(`Item search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
];
