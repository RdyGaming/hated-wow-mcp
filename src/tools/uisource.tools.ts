import { z } from "zod";

import { FLAVOR_IDS, resolveFlavor } from "../config.js";
import { loadUiSource, readUiFile } from "../uisource/index.js";
import { renderCVar, searchCVars } from "../uisource/cvars.js";
import {
  grepUiSource,
  renderMixin,
  renderTemplate,
  searchMixins,
  searchTemplates,
} from "../uisource/search.js";
import { loadIndex } from "../wowapi/index.js";
import { cap, text, type ToolDef } from "./shared.js";

const flavorArg = z.enum(FLAVOR_IDS).optional().describe("Game client. Defaults to retail.");

export const uiSourceTools: ToolDef[] = [
  {
    name: "wow_ui_template_search",
    dataset: "uisource",
    config: {
      title: "Search Blizzard's XML frame templates",
      description:
        "Search the virtual XML templates that ship with the game — the frames an " +
        "addon can inherit by name to get Blizzard's own look and behaviour " +
        "(buttons, scroll lists, panels, tooltips). Shows the inheritance chain, " +
        "attached mixins and where each is defined. Use this instead of writing " +
        "frame art from scratch.",
      inputSchema: {
        query: z.string().describe("Template name or fragment, e.g. ScrollBox or UIPanelButton."),
        flavor: flavorArg,
        type: z
          .string()
          .optional()
          .describe("Restrict to an element type, e.g. Button, Frame, CheckButton."),
        limit: z.number().int().min(1).max(60).optional(),
      },
    },
    handler: async ({ query, flavor, type, limit }) => {
      const source = loadUiSource(resolveFlavor(flavor as string | undefined));
      const hits = searchTemplates(source, query as string, {
        ...(type ? { type: type as string } : {}),
        limit: (limit as number) ?? 20,
      });

      if (hits.length === 0) {
        return text(
          `No template matching "${query}".\n\n` +
            "Templates must be virtual to be inheritable; try wow_ui_grep to find " +
            "non-virtual frames, or search a shorter fragment.",
        );
      }

      return text(
        cap(
          `${hits.length} template(s) matching "${query}":\n\n` +
            hits.map((t) => renderTemplate(source, t)).join("\n\n"),
        ),
      );
    },
  },

  {
    name: "wow_ui_mixin_search",
    dataset: "uisource",
    config: {
      title: "Search Blizzard's Lua mixins",
      description:
        "Search the mixin tables Blizzard's UI uses — reusable method sets attached " +
        "to frames via the XML mixin attribute or CreateFromMixins. Searching a " +
        "method name finds the mixin that defines it. Use this to reuse Blizzard's " +
        "behaviour or to understand what a template's methods do.",
      inputSchema: {
        query: z.string().describe("Mixin name, fragment, or an exact method name."),
        flavor: flavorArg,
        limit: z.number().int().min(1).max(60).optional(),
      },
    },
    handler: async ({ query, flavor, limit }) => {
      const source = loadUiSource(resolveFlavor(flavor as string | undefined));
      const hits = searchMixins(source, query as string, (limit as number) ?? 15);

      if (hits.length === 0) return text(`No mixin matching "${query}".`);

      return text(
        cap(
          `${hits.length} mixin(s) matching "${query}":\n\n` +
            hits.map(renderMixin).join("\n\n"),
        ),
      );
    },
  },

  {
    name: "wow_cvar_search",
    dataset: "uisource",
    config: {
      title: "Look up console variables (CVars)",
      description:
        "Find the game's console variables — the settings behind SetCVar/GetCVar. " +
        "Covers every CVar the client registers, and for the ones Blizzard's own " +
        "UI touches, shows how it reads them, where, and what the options screen " +
        "calls them. Use this before writing SetCVar, or to discover which CVar " +
        "controls a piece of game behaviour.",
      inputSchema: {
        query: z.string().describe("CVar name or fragment, e.g. nameplate, cameraDistance."),
        flavor: flavorArg,
        usedOnly: z
          .boolean()
          .optional()
          .describe("Only CVars Blizzard's own UI reads or writes — the documented-by-example ones."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    handler: async ({ query, flavor, usedOnly, limit }) => {
      const resolved = resolveFlavor(flavor as string | undefined);
      const api = loadIndex(resolved);

      // The UI source is optional here: the registry alone still answers "does
      // this CVar exist", which is most of the value, so a missing sync degrades
      // rather than fails.
      let used;
      let sourceNote = "";
      try {
        used = loadUiSource(resolved).raw.cvars;
        if (!used) {
          sourceNote =
            "\n\nUsage details need a newer UI source index — re-run the sync to add them.";
        }
      } catch {
        sourceNote =
          "\n\nOnly the CVar registry is loaded; sync the Blizzard UI source to see " +
          "how the game itself uses these.";
      }

      let hits = searchCVars(
        query as string,
        api.cvarSet,
        api.cvarByName,
        used,
        (limit as number) ?? 20,
      );
      if (usedOnly) hits = hits.filter((h) => h.refs > 0);

      if (hits.length === 0) {
        return text(
          `No CVar matching "${query}" in ${resolved.label}.` +
            "\n\nCVar names are case-insensitive here but often camelCase in game " +
            "(nameplateShowAll, cameraDistanceMaxZoomFactor). Try a shorter fragment." +
            sourceNote,
        );
      }

      return text(
        cap(
          `${hits.length} CVar(s) matching "${query}" in ${resolved.label}:\n\n` +
            hits.map(renderCVar).join("\n\n") +
            sourceNote,
        ),
      );
    },
  },

  {
    name: "wow_ui_grep",
    dataset: "uisource",
    config: {
      title: "Search Blizzard's UI source code",
      description:
        "Regex-search the full Lua and XML source of the 348 Blizzard addons that " +
        "ship with the client. This is the ground truth for how the game itself " +
        "does something — event handling, secure frames, data providers, layout. " +
        "Use it when the API reference tells you what a function is but not how " +
        "it is meant to be used.",
      inputSchema: {
        pattern: z.string().describe("JavaScript regular expression to search for."),
        flavor: flavorArg,
        ext: z.enum(["lua", "xml", "toc"]).optional().describe("Restrict by file type."),
        pkg: z
          .string()
          .optional()
          .describe("Restrict to one Blizzard package, e.g. Blizzard_ActionBar."),
        pathContains: z.string().optional().describe("Restrict to paths containing this."),
        context: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Lines of surrounding context per hit."),
        ignoreCase: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler: async ({ pattern, flavor, ext, pkg, pathContains, context, ignoreCase, limit }) => {
      const source = loadUiSource(resolveFlavor(flavor as string | undefined));
      const result = grepUiSource(source, pattern as string, {
        ...(ext ? { ext: ext as "lua" | "xml" | "toc" } : {}),
        ...(pkg ? { pkg: pkg as string } : {}),
        ...(pathContains ? { pathContains: pathContains as string } : {}),
        ...(context !== undefined ? { context: context as number } : {}),
        ...(ignoreCase !== undefined ? { ignoreCase: ignoreCase as boolean } : {}),
        limit: (limit as number) ?? 40,
      });

      if (result.hits.length === 0) {
        return text(
          `No matches for /${pattern}/ across ${result.filesSearched} file(s).`,
        );
      }

      const body = result.hits
        .map((h) => `${h.file}:${h.line}\n${h.text}`)
        .join("\n\n");

      return text(
        cap(
          `${result.hits.length} match(es) for /${pattern}/` +
            (result.truncated ? " (limit reached)" : "") +
            `:\n\n${body}`,
        ),
      );
    },
  },

  {
    name: "wow_ui_read_file",
    dataset: "uisource",
    config: {
      title: "Read a file from Blizzard's UI source",
      description:
        "Read a Lua or XML file from Blizzard's shipped interface source, by the " +
        "path that wow_ui_grep or wow_ui_template_search reported. Use this to see " +
        "a full implementation in context rather than a single matching line.",
      inputSchema: {
        path: z
          .string()
          .describe("Path relative to the UI source root, e.g. Interface/AddOns/Blizzard_UIParent/UIParent.lua."),
        flavor: flavorArg,
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
    },
    handler: async ({ path, flavor, startLine, endLine }) => {
      const source = loadUiSource(resolveFlavor(flavor as string | undefined));
      const file = readUiFile(source, path as string);

      const lines = file.content.split("\n");
      const from = Math.max(1, (startLine as number) ?? 1);
      // Default to a readable window rather than dumping a 4,000-line file.
      const to = Math.min(lines.length, (endLine as number) ?? from + 300);

      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");

      return text(
        cap(
          `${file.path}  (lines ${from}-${to} of ${lines.length})\n\n${body}` +
            (to < lines.length
              ? `\n\n[${lines.length - to} more line(s); pass startLine/endLine to continue]`
              : ""),
        ),
      );
    },
  },

  {
    name: "wow_ui_list_packages",
    dataset: "uisource",
    config: {
      title: "List Blizzard's shipped UI packages",
      description:
        "List the Blizzard_* addon packages that ship with the client, optionally " +
        "filtered. Use this to find which package owns a piece of the UI before " +
        "grepping it, e.g. Blizzard_ActionBar for action buttons.",
      inputSchema: {
        filter: z.string().optional().describe("Substring filter on the package name."),
        flavor: flavorArg,
      },
    },
    handler: async ({ filter, flavor }) => {
      const source = loadUiSource(resolveFlavor(flavor as string | undefined));
      const needle = (filter as string | undefined)?.toLowerCase();
      const packages = source.raw.packages.filter(
        (p) => !needle || p.toLowerCase().includes(needle),
      );

      const fileCounts = new Map<string, number>();
      for (const f of source.raw.files) {
        fileCounts.set(f.pkg, (fileCounts.get(f.pkg) ?? 0) + 1);
      }

      return text(
        cap(
          `${packages.length} package(s)` +
            (needle ? ` matching "${filter}"` : "") +
            ` (synced from ${source.raw.branch} @ ${source.raw.commit.slice(0, 8)}):\n\n` +
            packages
              .map((p) => `  ${p.padEnd(46)} ${fileCounts.get(p) ?? 0} file(s)`)
              .join("\n"),
        ),
      );
    },
  },
];
