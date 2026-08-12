import { z } from "zod";

import {
  loadAtlas,
  loadFiles,
  renderAtlasEntry,
  renderFileEntry,
  searchAtlas,
  searchFiles,
} from "../gamedata/files.js";
import {
  BUNDLED_DIR,
  cacheRoot,
  cacheRootReason,
  type CacheRootReason,
} from "../paths.js";
import { cap, text, type ToolDef } from "./shared.js";

/** Why the synced data landed where it did, in words a user can act on. */
const CACHE_ROOT_REASONS: Record<CacheRootReason, string> = {
  env: "set by WOW_MCP_DATA_DIR",
  checkout: "git checkout — data kept beside the source",
  legacy: "existing sync found in the package directory",
  cache: "OS cache directory",
};

export const gameDataTools: ToolDef[] = [
  {
    name: "wow_file_search",
    config: {
      title: "Look up game files and FileDataIDs",
      description:
        "Find game art and asset files by name, and get the FileDataID and texture " +
        "path an addon needs to reference them. Covers every interface texture and " +
        "icon (and models and maps when the full index is synced). A numeric query " +
        "is treated as a FileDataID and resolved back to its path. Use this " +
        "whenever writing SetTexture, SetNormalTexture or SetModel.",
      inputSchema: {
        query: z
          .string()
          .describe("File name fragment, or a numeric FileDataID to resolve."),
        under: z
          .string()
          .optional()
          .describe("Restrict to a path prefix, e.g. interface/icons/ or interface/buttons/."),
        ext: z.string().optional().describe("Restrict by extension, e.g. blp or m2."),
        includeNonInterface: z
          .boolean()
          .optional()
          .describe("Search beyond interface/** — models, maps, sounds. Requires the full index."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler: async ({ query, under, ext, includeNonInterface, limit }) => {
      const files = loadFiles();

      if (includeNonInterface && !files.hasFull) {
        return text(
          "The full file index is not built — only interface/** is available.\n\n" +
            "Run `npm run sync-game-data -- --full` to index models, maps and sounds " +
            "as well (this makes the index considerably larger).",
        );
      }

      const hits = searchFiles(files, query as string, {
        ...(under ? { under: under as string } : {}),
        ...(ext ? { ext: ext as string } : {}),
        ...(includeNonInterface !== undefined
          ? { includeNonInterface: includeNonInterface as boolean }
          : {}),
        limit: (limit as number) ?? 30,
      });

      if (hits.length === 0) {
        return text(
          `No file matching "${query}".\n\n` +
            `The index holds ${files.raw.counts.interface} interface files ` +
            `(${files.raw.counts.icons} icons)` +
            (files.hasFull ? " plus the full listfile" : "") +
            ". Try a shorter fragment, or drop the `under` filter.",
        );
      }

      return text(
        cap(
          `${hits.length} file(s) matching "${query}":\n\n` +
            hits.map(renderFileEntry).join("\n\n"),
        ),
      );
    },
  },

  {
    name: "wow_icon_search",
    config: {
      title: "Find an icon texture",
      description:
        "Search the game's icon textures by name and return the path and FileDataID " +
        "for each. Icons follow a naming convention (spell_fire_*, inv_sword_*, " +
        "ability_warrior_*), so searching by theme works well. Use this to pick an " +
        "icon for a button, an addon compartment entry, or a .toc IconTexture.",
      inputSchema: {
        query: z.string().describe("Icon name fragment, e.g. fireball, sword, warrior."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler: async ({ query, limit }) => {
      const files = loadFiles();
      const hits = searchFiles(files, query as string, {
        under: "interface/icons/",
        limit: (limit as number) ?? 40,
      });

      if (hits.length === 0) {
        return text(
          `No icon matching "${query}" among ${files.raw.counts.icons} icons.`,
        );
      }

      const body = hits
        .map((h) => {
          const name = h.path.slice("interface/icons/".length).replace(/\.blp$/, "");
          return `  ${String(h.id).padStart(8)}  ${name}`;
        })
        .join("\n");

      return text(
        cap(
          `${hits.length} icon(s) matching "${query}":\n\n` +
            `  ${"FileDataID".padStart(8)}  name\n${body}\n\n` +
            "Use either form in Lua:\n" +
            `  button:SetNormalTexture(${hits[0]!.id})\n` +
            `  button:SetNormalTexture("Interface\\\\Icons\\\\${hits[0]!.path
              .slice("interface/icons/".length)
              .replace(/\.blp$/, "")}")`,
        ),
      );
    },
  },

  {
    name: "wow_atlas_search",
    config: {
      title: "Find a texture atlas element",
      description:
        "Search the named texture atlas elements the UI uses with SetAtlas — the " +
        "modern way to reference Blizzard art, since an atlas name carries its own " +
        "size and coordinates. Returns dimensions, the sheet FileDataID and the " +
        "exact SetAtlas call. Prefer atlases over raw texture paths for UI art.",
      inputSchema: {
        query: z.string().describe("Atlas element name or fragment."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler: async ({ query, limit }) => {
      const hits = searchAtlas(query as string, (limit as number) ?? 30);

      if (hits.length === 0) {
        const { raw } = loadAtlas();
        return text(
          `No atlas element matching "${query}" among ${raw.counts.atlases} elements.`,
        );
      }

      // The sheet path is only resolvable when the file index is present; the
      // atlas data is still useful without it.
      let files;
      try {
        files = loadFiles();
      } catch {
        files = undefined;
      }

      return text(
        cap(
          `${hits.length} atlas element(s) matching "${query}":\n\n` +
            hits.map((h) => renderAtlasEntry(h, files)).join("\n\n"),
        ),
      );
    },
  },

  {
    name: "wow_data_status",
    config: {
      title: "Show game data availability",
      description:
        "Report which game data sets are synced — the file/FileDataID index and the " +
        "texture atlas index — with counts and sync dates, and what to run for any " +
        "that are missing. Use this when a game data lookup returns nothing.",
      inputSchema: {},
    },
    handler: async () => {
      const lines: string[] = ["Game data sets", ""];

      lines.push(
        "  Locations",
        `    bundled:  ${BUNDLED_DIR}`,
        `    synced:   ${cacheRoot()}  (${CACHE_ROOT_REASONS[cacheRootReason()]})`,
        "",
      );

      try {
        const files = loadFiles();
        lines.push(
          "  File index",
          `    synced:   ${files.raw.generatedAt}`,
          `    source:   ${files.raw.source}`,
          `    contents: ${files.raw.counts.interface} interface files, ` +
            `${files.raw.counts.icons} icons, ${files.raw.counts.total} total known`,
          `    mode:     ${files.hasFull ? "full (models, maps, sounds indexed)" : "interface only"}`,
          "",
        );
      } catch (err) {
        lines.push("  File index: NOT BUILT", `    ${(err as Error).message}`, "");
      }

      try {
        const atlas = loadAtlas();
        lines.push(
          "  Atlas index",
          `    synced:   ${atlas.raw.generatedAt}`,
          `    build:    ${atlas.raw.build}`,
          `    contents: ${atlas.raw.counts.atlases} elements across ${atlas.raw.counts.sheets} sheets`,
          "",
        );
      } catch (err) {
        lines.push("  Atlas index: NOT BUILT", `    ${(err as Error).message}`, "");
      }

      return text(lines.join("\n"));
    },
  },
];
