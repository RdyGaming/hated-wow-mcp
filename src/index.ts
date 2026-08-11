#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ALL_TOOLS, createServer } from "./server.js";

async function main(): Promise<void> {
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
