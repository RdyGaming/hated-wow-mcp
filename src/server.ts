import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadAtlasGeneratedAt, loadFilesGeneratedAt } from "./gamedata/files.js";
import { PKG_ROOT } from "./paths.js";
import { apiTools } from "./tools/api.tools.js";
import { devTools } from "./tools/dev.tools.js";
import { gameDataTools } from "./tools/gamedata.tools.js";
import { errorText, stalenessNote, type ToolDef } from "./tools/shared.js";
import { loadUiSourceGeneratedAt } from "./uisource/index.js";

import { uiSourceTools } from "./tools/uisource.tools.js";

/**
 * Read from package.json rather than repeated here — it was hardcoded once and
 * spent three releases reporting 0.1.0 to every client that asked.
 */
const SERVER_VERSION: string = (() => {
  try {
    return (
      JSON.parse(readFileSync(`${PKG_ROOT}/package.json`, "utf8")) as { version?: string }
    ).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Appends the staleness warning to tools that answer from synced data.
 *
 * Doing it here rather than in each handler means a tool added later gets the
 * behaviour by declaring `dataset`, and cannot forget to. Successful answers
 * only: an error already tells the caller what to do.
 */
function withStalenessNote(tool: ToolDef): ToolDef {
  if (!tool.dataset) return tool;

  return {
    ...tool,
    handler: async (args) => {
      const result = await tool.handler(args);
      if (result.isError) return result;

      const generatedAt =
        tool.dataset === "uisource"
          ? loadUiSourceGeneratedAt()
          : (loadFilesGeneratedAt() ?? loadAtlasGeneratedAt());
      const note = stalenessNote(generatedAt, tool.dataset!);
      if (!note) return result;

      const content = [...result.content];
      const last = content[content.length - 1];
      if (last) content[content.length - 1] = { ...last, text: last.text + note };
      return { ...result, content };
    },
  };
}

export const ALL_TOOLS: ToolDef[] = [
  ...apiTools,
  ...uiSourceTools,
  ...devTools,
  ...gameDataTools,
].map(withStalenessNote);

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "hated-wow-mcp", version: SERVER_VERSION },
    {
      instructions: [
        "This server exposes World of Warcraft addon development knowledge: the",
        "in-game Lua API, Blizzard's own shipped UI source, and the game's art and",
        "file data.",
        "",
        "Guidance:",
        "  - Check wow_api_search before writing any call into the game. The API",
        "    differs per client and moves between patches; do not rely on memory.",
        "  - Use wow_ui_grep and wow_ui_template_search to see how Blizzard itself",
        "    implements a piece of UI before building it from scratch.",
        "  - Run wow_lua_lint on addon Lua before considering it finished. It",
        "    catches removed APIs and taint problems that only appear at runtime.",
        "  - Reference art through wow_file_search / wow_atlas_search rather than",
        "    guessing texture paths; a wrong path fails silently in-game.",
      ].join("\n"),
    },
  );

  for (const tool of ALL_TOOLS) {
    server.registerTool(tool.name, tool.config, async (args: Record<string, unknown>) => {
      try {
        return await tool.handler(args ?? {});
      } catch (err) {
        // Surfacing the message as tool output rather than throwing keeps the
        // model able to recover — most failures here are "data not synced yet"
        // or a bad argument, both of which it can act on.
        return errorText(
          `${tool.name} failed: ${(err as Error).message}`,
        );
      }
    });
  }

  return server;
}
