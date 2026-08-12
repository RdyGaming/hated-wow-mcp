#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ALL_TOOLS, createServer } from "./server.js";

async function main(): Promise<void> {
  // `npx hated-wow-mcp sync …` rather than the hated-wow-mcp-sync bin, because
  // npx resolves a bare command to a *package* of that name. There is no
  // package called hated-wow-mcp-sync, so `npx hated-wow-mcp-sync` 404s; only a
  // global install puts that bin on PATH. Routing through the main bin gives
  // every install one command that works.
  if (process.argv[2] === "sync") {
    const dispatcher = fileURLToPath(new URL("sync/index.js", import.meta.url));
    const result = spawnSync(process.execPath, [dispatcher, ...process.argv.slice(3)], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 1);
  }

  // `--list` is a smoke test: it proves the tool table and every data set load
  // without needing an MCP client attached.
  if (process.argv.includes("--list")) {
    process.stdout.write(`Hated WoW MCP — ${ALL_TOOLS.length} tools\n\n`);
    for (const tool of ALL_TOOLS) {
      process.stdout.write(`  ${tool.name}\n      ${tool.config.title}\n`);
    }
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP transport; anything written there that is not a protocol
  // message corrupts the stream. All diagnostics go to stderr.
  process.stderr.write("Hated WoW MCP ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Hated WoW MCP failed to start: ${(err as Error).stack}\n`);
  process.exit(1);
});
