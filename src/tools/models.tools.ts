import { resolve } from "node:path";

import { z } from "zod";

import {
  loadModels,
  openDriver,
  resolveModel,
  searchModels,
  setupProblem,
} from "../wowexport/index.js";
import { READ_ONLY, cap, errorText, text, type ToolDef } from "./shared.js";

const WRITES_FILES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const FLAVOR_HELP =
  "Which installed client to read: mainline (retail), forever, classic or vanilla. " +
  "Defaults to the first install found.";

export const modelTools: ToolDef[] = [
  {
    name: "wow_model_search",
    config: {
      title: "Search game models",
      annotations: READ_ONLY,
      description:
        "Find M2 (creature, doodad, prop) and WMO (building, dungeon) models in the game's " +
        "listfile by path fragment, or resolve a numeric FileDataID. Returns the FileDataID " +
        "and path to pass to wow_model_export. Needs the game-data sync.",
      inputSchema: {
        query: z
          .string()
          .describe("Words that appear in the path, e.g. 'thunder bluff' or 'cairne', or a FileDataID."),
        kind: z
          .enum(["any", "m2", "wmo"])
          .optional()
          .describe("Restrict to creatures/props (m2) or buildings (wmo)."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler: async ({ query, kind, limit }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      const hits = searchModels(
        await loadModels(),
        query as string,
        (kind as string | undefined) ?? "any",
        (limit as number | undefined) ?? 40,
      );
      if (hits.length === 0) return text(`No models match "${query as string}".`);
      return text(cap(hits.map((h) => `${h.id}  ${h.path}`).join("\n")));
    },
  },
  {
    name: "wow_model_export",
    config: {
      title: "Export a game model",
      annotations: WRITES_FILES,
      description:
        "Export a model from the local WoW install's game files into a folder, headless. " +
        "M2 models become glTF with animations (or GLB/OBJ); WMO models become OBJ+MTL " +
        "(or glTF). Textures are decoded to PNG beside the model in wow.export's folder " +
        "layout, so relative texture paths resolve in Blender. The first call opens the " +
        "game storage and takes about 30 seconds. Needs the game-data and model-data syncs.",
      inputSchema: {
        model: z.union([z.string(), z.number()]).describe("FileDataID or listfile path."),
        outputDir: z.string().describe("Folder to write into (created if missing)."),
        format: z.enum(["gltf", "glb", "obj"]).optional().describe("Default: gltf for M2, obj for WMO."),
        animations: z.boolean().optional().describe("Include animations for M2 glTF. Default true."),
        splitGroups: z.boolean().optional().describe("WMO OBJ: one object per group."),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ model, outputDir, format, animations, splitGroups, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      const id = await resolveModel(model as string | number);
      if (id === null) {
        return errorText(`"${String(model)}" is not a FileDataID or a known model path. Try wow_model_search.`);
      }
      try {
        const driver = await openDriver(flavor as string | undefined);
        const r = await driver.exportModel({
          fileDataID: id,
          outDir: resolve(outputDir as string),
          ...(format ? { format: format as string } : {}),
          ...(animations !== undefined ? { animations: animations as boolean } : {}),
          ...(splitGroups !== undefined ? { splitGroups: splitGroups as boolean } : {}),
        });
        const counts: Record<string, number> = {};
        for (const f of r.files) counts[f.type] = (counts[f.type] ?? 0) + 1;
        return text(
          [
            `Exported ${r.name} (FileDataID ${id}, ${r.type.toUpperCase()})`,
            `Model file: ${r.path}`,
            ...(r.files.length
              ? [`Also written: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`]
              : ["Textures and animation data sit beside the model file."]),
          ].join("\n"),
        );
      } catch (err) {
        return errorText(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "wow_creature_search",
    config: {
      title: "Search creatures and NPCs",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Find creatures and NPCs by name (or creature id, or display id) in the local game " +
        "files, with the model each one uses. Opens the game storage, so the first call " +
        "takes about 40 seconds. Use the id with wow_creature_export.",
      inputSchema: {
        query: z.string().describe("Creature name fragment, creature id or display id."),
        limit: z.number().int().min(1).max(100).optional(),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ query, limit, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      try {
        const driver = await openDriver(flavor as string | undefined);
        const hits = await driver.searchCreatures({
          query: query as string,
          ...(limit ? { limit: limit as number } : {}),
        });
        if (hits.length === 0) return text(`No creatures match "${query as string}".`);
        return text(
          cap(
            hits
              .map(
                (h) =>
                  `${h.id}  ${h.name}  (display ${h.displayID}, ${h.model ?? "no model"}${h.humanoid ? ", humanoid" : ""})`,
              )
              .join("\n"),
          ),
        );
      } catch (err) {
        return errorText(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "wow_creature_export",
    config: {
      title: "Export a creature or NPC with its skin",
      annotations: WRITES_FILES,
      description:
        "Export a creature or NPC as glTF with animations and its skin textures, headless. " +
        "Beasts and monsters get their display skin and geosets. Humanoid NPCs (built from a " +
        "player race model) get the right race and sex model, the NPC's hair, beard and " +
        "similar geosets, and the baked NPC skin; worn gear is not applied yet. Written to " +
        "<outputDir>/creatures/.",
      inputSchema: {
        creatureId: z.number().int().optional().describe("Creature id from wow_creature_search."),
        displayId: z.number().int().optional().describe("Display id, when there is no creature id."),
        outputDir: z.string().describe("Folder to write into (created if missing)."),
        format: z.enum(["gltf", "glb", "obj"]).optional(),
        animations: z.boolean().optional().describe("Include animations. Default true."),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ creatureId, displayId, outputDir, format, animations, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      if (creatureId === undefined && displayId === undefined) {
        return errorText("Pass creatureId or displayId. Find one with wow_creature_search.");
      }
      try {
        const driver = await openDriver(flavor as string | undefined);
        const r = await driver.exportCreature({
          ...(creatureId !== undefined ? { creatureId: creatureId as number } : {}),
          ...(displayId !== undefined ? { displayId: displayId as number } : {}),
          outDir: resolve(outputDir as string),
          ...(format ? { format: format as string } : {}),
          ...(animations !== undefined ? { animations: animations as boolean } : {}),
        });
        return text(
          [
            `Exported ${r.name} (display ${r.displayID}, model FileDataID ${r.fileDataID})`,
            `Model file: ${r.path}`,
            "Textures and animation data sit beside the model file.",
          ].join("\n"),
        );
      } catch (err) {
        return errorText(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "wow_texture_export",
    config: {
      title: "Export a game texture as PNG",
      annotations: WRITES_FILES,
      description:
        "Decode a BLP texture from the local WoW install to PNG, keeping the game's folder " +
        "layout under outputDir. Accepts a FileDataID or listfile path.",
      inputSchema: {
        texture: z.union([z.string(), z.number()]).describe("FileDataID or listfile path of a .blp."),
        outputDir: z.string().describe("Folder to write into (created if missing)."),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ texture, outputDir, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      try {
        const driver = await openDriver(flavor as string | undefined);
        const out = await driver.exportTexture(texture as string | number, resolve(outputDir as string));
        return text(`Wrote ${out}`);
      } catch (err) {
        return errorText(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "wow_map_search",
    config: {
      title: "Search game maps",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Find maps (continents, instances, battlegrounds) by name, directory or id in the " +
        "local game files. Also converts a world position to the terrain tile that holds it. " +
        "Opens the game storage, so the first call takes about 40 seconds.",
      inputSchema: {
        query: z.string().describe("Map name fragment, directory (e.g. 'Kalimdor') or map id."),
        x: z.number().optional().describe("World x (north) to find the tile for."),
        y: z.number().optional().describe("World y (west) to find the tile for."),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ query, x, y, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      try {
        const driver = await openDriver(flavor as string | undefined);
        const hits = await driver.searchMaps(query as string);
        if (hits.length === 0) return text(`No maps match "${query as string}".`);
        const lines = hits.map((h) => `${h.id}  ${h.directory}  (${h.name})`);
        if (x !== undefined && y !== undefined) {
          const t = driver.tileForPosition(x as number, y as number);
          lines.push("", `Tile for (${x as number}, ${y as number}): ${t.a},${t.b}`);
        }
        return text(cap(lines.join("\n")));
      } catch (err) {
        return errorText(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: "wow_map_export",
    config: {
      title: "Export map terrain",
      annotations: WRITES_FILES,
      description:
        "Export terrain tiles of a map as OBJ with a texture, headless. Give a map id from " +
        "wow_map_search plus tiles, or a world position. Texture modes: 'tex0' blends the " +
        "tile's layers into one PNG (default), 'alpha' writes the layer textures and blend " +
        "masks, 'none' is geometry only. Optionally places the tile's buildings and props. " +
        "Written to <outputDir>/maps/<directory>/. Baked high-resolution textures are not " +
        "supported (they need a GPU).",
      inputSchema: {
        mapId: z.number().int().describe("Map id from wow_map_search."),
        tiles: z
          .array(z.tuple([z.number().int(), z.number().int()]))
          .optional()
          .describe("Tile pairs [a, b] from the file name map_a_b.adt."),
        x: z.number().optional().describe("World x (north); with y, picks the tile."),
        y: z.number().optional().describe("World y (west)."),
        outputDir: z.string().describe("Folder to write into (created if missing)."),
        texture: z.enum(["tex0", "alpha", "none"]).optional(),
        objects: z.boolean().optional().describe("Also export the tile's WMO and M2 placements. Slow."),
        flavor: z.string().optional().describe(FLAVOR_HELP),
      },
    },
    handler: async ({ mapId, tiles, x, y, outputDir, texture, objects, flavor }) => {
      const problem = setupProblem();
      if (problem) return errorText(problem);
      try {
        const driver = await openDriver(flavor as string | undefined);
        const map = (await driver.searchMaps(String(mapId as number))).find((m) => m.id === mapId);
        if (!map) return errorText(`No map with id ${mapId as number}. Try wow_map_search.`);
        const list = [...((tiles as [number, number][] | undefined) ?? [])];
        if (x !== undefined && y !== undefined) {
          const t = driver.tileForPosition(x as number, y as number);
          list.push([t.a, t.b]);
        }
        if (list.length === 0) return errorText("Pass tiles, or x and y.");
        const quality = { tex0: -2, alpha: -1, none: 0 }[(texture as string | undefined) ?? "tex0"]!;
        const r = await driver.exportMap({
          mapId: map.id,
          directory: map.directory,
          tiles: list,
          outDir: resolve(outputDir as string),
          quality,
          ...(objects ? { objects: true } : {}),
        });
        return text(`Exported ${list.length} tile(s) of ${map.directory}\nFolder: ${r.dir}\n${r.files.join("\n")}`);
      } catch (err) {
        return errorText(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
];
