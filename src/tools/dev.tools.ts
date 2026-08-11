import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { z } from "zod";

import {
  FLAVOR_IDS,
  addonRoot,
  findInstallations,
  listAddons,
  resolveFlavor,
} from "../config.js";
import { analyzeLua, formatDiagnostics } from "../lua/analyze.js";
import { scaffoldAddon } from "../scaffold/addon.js";
import { formatTocValidation, validateToc } from "../toc/parse.js";
import { formatXmlValidation, validateXml } from "../xml/validate.js";
import { cap, errorText, text, type ToolDef } from "./shared.js";

const flavorArg = z.enum(FLAVOR_IDS).optional().describe("Target client. Defaults to retail.");

/**
 * Resolves a user-supplied path against the addon root when one is configured,
 * and refuses paths that escape it. Absolute paths are allowed only when no
 * addon root is set, so a configured workspace acts as a real boundary.
 */
function resolveAddonPath(input: string): string {
  const root = addonRoot();
  if (!root) return resolve(input);

  const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `"${input}" resolves outside the configured addon folder (${root}). ` +
        "Pass a path inside it, or unset WOW_ADDON_PATH to work with absolute paths.",
    );
  }
  return target;
}

export const devTools: ToolDef[] = [
  {
    name: "wow_lua_lint",
    config: {
      title: "Lint addon Lua against a game client",
      description:
        "Analyse addon Lua for problems specific to World of Warcraft: APIs that " +
        "were removed or moved into a namespace in the target client, unknown " +
        "events, taint (calling protected functions, overwriting Blizzard globals, " +
        "touching secure frames in combat), and performance traps. Run this on any " +
        "addon Lua before shipping it, and whenever porting between clients.",
      inputSchema: {
        code: z.string().optional().describe("Lua source to analyse."),
        path: z
          .string()
          .optional()
          .describe("Path to a .lua file to analyse instead of inline code."),
        flavor: flavorArg,
        knownGlobals: z
          .array(z.string())
          .optional()
          .describe("Globals defined elsewhere (embedded libraries, other files) — suppresses unknown-API warnings for them."),
        disable: z.array(z.string()).optional().describe("Rule ids to suppress."),
      },
    },
    handler: async ({ code, path, flavor, knownGlobals, disable }) => {
      const f = resolveFlavor(flavor as string | undefined);

      let source: string;
      let name: string;
      if (typeof code === "string") {
        source = code;
        name = "<inline>";
      } else if (typeof path === "string") {
        const target = resolveAddonPath(path);
        if (!existsSync(target)) return errorText(`No such file: ${target}`);
        source = readFileSync(target, "utf8");
        name = basename(target);
      } else {
        return errorText("Provide either `code` or `path`.");
      }

      const result = analyzeLua(source, {
        file: name,
        flavor: f,
        ...(knownGlobals ? { knownGlobals: knownGlobals as string[] } : {}),
        ...(disable ? { disable: disable as string[] } : {}),
      });

      return text(cap(formatDiagnostics(result)));
    },
  },

  {
    name: "wow_xml_validate",
    config: {
      title: "Validate interface XML",
      description:
        "Validate WoW interface XML against Blizzard's own UI.xsd: unknown or " +
        "misspelled elements and attributes, invalid nesting, bad enum values, and " +
        "structural mistakes like a virtual frame with no name. Run this on every " +
        "XML file an addon loads — the client silently ignores what it does not " +
        "understand, so these mistakes are otherwise invisible.",
      inputSchema: {
        xml: z.string().optional().describe("XML source to validate."),
        path: z.string().optional().describe("Path to a .xml file to validate."),
      },
    },
    handler: async ({ xml, path }) => {
      let source: string;
      let name: string;
      if (typeof xml === "string") {
        source = xml;
        name = "<inline>";
      } else if (typeof path === "string") {
        const target = resolveAddonPath(path);
        if (!existsSync(target)) return errorText(`No such file: ${target}`);
        source = readFileSync(target, "utf8");
        name = basename(target);
      } else {
        return errorText("Provide either `xml` or `path`.");
      }

      return text(cap(formatXmlValidation(validateXml(source, name))));
    },
  },

  {
    name: "wow_toc_validate",
    config: {
      title: "Validate an addon .toc manifest",
      description:
        "Validate a .toc manifest: interface version against the target client, " +
        "flavor suffix consistency, unrecognised directives the client silently " +
        "drops, SavedVariables names, and files listed but missing (or present but " +
        "unlisted). Run this whenever an addon fails to load or shows as out of date.",
      inputSchema: {
        toc: z.string().optional().describe(".toc contents to validate."),
        path: z.string().optional().describe("Path to a .toc file, or to an addon folder."),
        fileName: z
          .string()
          .optional()
          .describe("Filename to assume when validating inline contents, e.g. MyAddon_Vanilla.toc."),
      },
    },
    handler: async ({ toc, path, fileName }) => {
      if (typeof toc === "string") {
        const validation = validateToc(toc, (fileName as string) ?? "MyAddon.toc");
        return text(cap(formatTocValidation(validation)));
      }

      if (typeof path !== "string") {
        return errorText("Provide either `toc` or `path`.");
      }

      const target = resolveAddonPath(path);
      if (!existsSync(target)) return errorText(`No such path: ${target}`);

      // Pointing at a folder validates every .toc in it, which is what you want
      // for a multi-flavor addon.
      const isDir = !target.toLowerCase().endsWith(".toc");
      const tocFiles = isDir
        ? readdirSync(target).filter((f) => f.toLowerCase().endsWith(".toc"))
        : [basename(target)];
      const dir = isDir ? target : resolve(target, "..");

      if (tocFiles.length === 0) {
        return errorText(`No .toc file found in ${target}.`);
      }

      // Knowing what is actually on disk lets the validator catch listed-but-
      // missing and present-but-unlisted files.
      const presentFiles = collectFiles(dir, dir);

      const reports = tocFiles.map((file) => {
        const source = readFileSync(join(dir, file), "utf8");
        return formatTocValidation(validateToc(source, file, { presentFiles }));
      });

      return text(cap(reports.join("\n\n" + "-".repeat(70) + "\n\n")));
    },
  },

  {
    name: "wow_addon_scaffold",
    config: {
      title: "Generate an addon skeleton",
      description:
        "Generate a complete, working addon skeleton: .toc manifests for the chosen " +
        "clients, an event-dispatch Core.lua with SavedVariables handling and a " +
        "slash command, and optionally an XML frame template with its Lua mixin and " +
        "a Settings-API options panel. Use this to start a new addon rather than " +
        "writing boilerplate by hand.",
      inputSchema: {
        name: z.string().describe("Addon name; also the folder name."),
        flavors: z
          .array(z.enum(FLAVOR_IDS))
          .optional()
          .describe("Clients to support. Defaults to retail only."),
        author: z.string().optional(),
        version: z.string().optional(),
        notes: z.string().optional().describe("One-line description for the .toc and README."),
        slashCommand: z.string().optional().describe("Slash command without the leading slash."),
        withFrame: z.boolean().optional().describe("Include an XML template and frame mixin."),
        withOptions: z.boolean().optional().describe("Include a Settings API options panel."),
        savedVariables: z.array(z.string()).optional(),
        write: z
          .boolean()
          .optional()
          .describe("Write the files into the configured addon folder instead of just returning them."),
      },
    },
    handler: async (args) => {
      const flavorIds = (args.flavors as string[] | undefined) ?? ["mainline"];
      const files = scaffoldAddon({
        name: args.name as string,
        flavors: flavorIds.map((id) => resolveFlavor(id)),
        ...(args.author ? { author: args.author as string } : {}),
        ...(args.version ? { version: args.version as string } : {}),
        ...(args.notes ? { notes: args.notes as string } : {}),
        ...(args.slashCommand ? { slashCommand: args.slashCommand as string } : {}),
        ...(args.withFrame !== undefined ? { withFrame: args.withFrame as boolean } : {}),
        ...(args.withOptions !== undefined ? { withOptions: args.withOptions as boolean } : {}),
        ...(args.savedVariables ? { savedVariables: args.savedVariables as string[] } : {}),
      });

      if (args.write) {
        const root = addonRoot();
        if (!root) {
          return errorText(
            "Cannot write: no addon folder is configured and no WoW install was " +
              "found. Set WOW_ADDON_PATH or WOW_INSTALL_PATH, or omit `write` to " +
              "receive the file contents instead.",
          );
        }

        const { mkdirSync, writeFileSync } = await import("node:fs");
        const written: string[] = [];
        for (const file of files) {
          const target = join(root, file.path);
          mkdirSync(resolve(target, ".."), { recursive: true });
          writeFileSync(target, file.content, "utf8");
          written.push(target);
        }
        return text(
          `Wrote ${written.length} file(s):\n\n` +
            written.map((w) => `  ${w}`).join("\n") +
            "\n\nReload the game (/reload) or restart the client to load the addon.",
        );
      }

      return text(
        cap(
          files
            .map((f) => `===== ${f.path} =====\n${f.content}`)
            .join("\n"),
          120_000,
        ),
      );
    },
  },

  {
    name: "wow_install_info",
    config: {
      title: "Show the local WoW installation",
      description:
        "Report the World of Warcraft installations found on this machine — their " +
        "paths, flavors, build numbers, and the addons currently installed. Use " +
        "this to confirm which client tools will target and to discover addon " +
        "folders to lint.",
      inputSchema: {},
    },
    handler: async () => {
      const installs = findInstallations();
      const lines: string[] = [];

      if (installs.length === 0) {
        lines.push(
          "No World of Warcraft installation found.",
          "",
          "Checked the standard install locations. Set WOW_INSTALL_PATH to the",
          "folder containing _retail_ / _classic_era_ if yours is elsewhere.",
          "",
          "Everything except the local-file tools works without an install.",
        );
      } else {
        lines.push(`${installs.length} installation(s):`, "");
        for (const i of installs) {
          lines.push(
            `  ${i.flavor.label}`,
            `    path:   ${i.flavorPath}`,
            `    addons: ${i.addonsPath}`,
            ...(i.build ? [`    build:  ${i.build}`] : []),
            "",
          );
        }
      }

      const root = addonRoot();
      if (root) {
        const addons = listAddons();
        const thirdParty = addons.filter((a) => !a.startsWith("Blizzard_"));
        lines.push(
          `Addon folder in use: ${root}`,
          `  ${addons.length} folder(s), ${thirdParty.length} third-party:`,
          "",
          ...thirdParty.slice(0, 60).map((a) => `    ${a}`),
          ...(thirdParty.length > 60 ? [`    … and ${thirdParty.length - 60} more`] : []),
        );
      }

      return text(cap(lines.join("\n")));
    },
  },
];

/** Recursively lists addon files relative to `root`, forward-slashed. */
function collectFiles(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, root, out);
    else out.push(full.slice(root.length + 1).split("\\").join("/"));
  }
  return out;
}
