// Local web UI for Hated WoW MCP.
//
// This deliberately does NOT speak the MCP protocol. Every tool is a plain
// async function (`ToolDef.handler`), so the browser can drive them directly —
// no stdio transport, no JSON-RPC, no model in the loop.
//
//   npm run web   →   http://localhost:3001

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import cors from "cors";
import express from "express";
import { z } from "zod";

import { ALL_TOOLS } from "./dist/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors()); // so index.html still works if opened straight off disk
app.use(express.json({ limit: "2mb" }));
app.use(express.static(HERE)); // serves index.html at /

// ---------------------------------------------------------------------------
// Schema introspection — turns each tool's Zod shape into something the
// browser can render as a form. Unwraps Optional/Default to reach the real type.
// ---------------------------------------------------------------------------

function describeField(name, schema) {
  let def = schema._def;
  let optional = false;

  while (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    optional = true;
    def = def.innerType._def;
  }

  const kind =
    def.typeName === "ZodNumber" ? "number"
    : def.typeName === "ZodBoolean" ? "boolean"
    : def.typeName === "ZodEnum" ? "enum"
    : def.typeName === "ZodArray" ? "array"
    : "string";

  return {
    name,
    kind,
    optional,
    description: schema.description ?? "",
    ...(kind === "enum" ? { options: def.values } : {}),
  };
}

function describeTool(tool) {
  return {
    name: tool.name,
    title: tool.config.title,
    description: tool.config.description,
    fields: Object.entries(tool.config.inputSchema).map(([k, v]) => describeField(k, v)),
  };
}

const TOOLS = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/tools", (_req, res) => {
  res.json({ tools: ALL_TOOLS.map(describeTool) });
});

app.post("/api/call", async (req, res) => {
  const { tool: toolName, args = {} } = req.body ?? {};
  const tool = TOOLS.get(toolName);

  if (!tool) {
    return res.status(404).json({
      error: `Unknown tool "${toolName}". Try GET /api/tools.`,
    });
  }

  // Coerce what an HTML form can't express: everything arrives as a string, and
  // blank optional fields must be dropped rather than sent as "".
  const shape = tool.config.inputSchema;
  const cleaned = {};
  for (const [key, raw] of Object.entries(args)) {
    if (raw === "" || raw === null || raw === undefined) continue;
    const field = shape[key] ? describeField(key, shape[key]) : null;
    if (field?.kind === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        return res.status(400).json({ error: `"${key}" must be a number.` });
      }
      cleaned[key] = n;
    } else if (field?.kind === "boolean") {
      cleaned[key] = raw === true || raw === "true";
    } else {
      cleaned[key] = raw;
    }
  }

  const parsed = z.object(shape).safeParse(cleaned);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n"),
    });
  }

  try {
    const started = Date.now();
    const result = await tool.handler(parsed.data);
    res.json({
      text: (result.content ?? []).map((c) => c.text).join("\n"),
      isError: Boolean(result.isError),
      ms: Date.now() - started,
    });
  } catch (err) {
    // Data-not-synced and bad-argument failures both land here; surface the
    // message rather than a bare 500 so the page can show something actionable.
    res.status(500).json({ error: `${toolName} failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  process.stdout.write(
    `Hated WoW MCP web UI — ${ALL_TOOLS.length} tools\n` +
      `  open http://localhost:${PORT}\n`,
  );
});
