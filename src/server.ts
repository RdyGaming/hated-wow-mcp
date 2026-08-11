import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { apiTools } from "./tools/api.tools.js";
import { devTools } from "./tools/dev.tools.js";
import { gameDataTools } from "./tools/gamedata.tools.js";
import { errorText, type ToolDef } from "./tools/shared.js";
import { uiSourceTools } from "./tools/uisource.tools.js";

export const ALL_TOOLS: ToolDef[] = [
  ...apiTools,
  ...uiSourceTools,
  ...devTools,
  ...gameDataTools,
];

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "hated-wow-mcp", version: "0.1.0" },
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
