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
];
