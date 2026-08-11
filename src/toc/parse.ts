import { FLAVORS, flavorForInterface, type Flavor } from "../config.js";

export interface TocDirective {
  key: string;
  /** Locale suffix from `## Title-frFR:`, if any. */
  locale?: string;
  value: string;
  line: number;
}

export interface ParsedToc {
  directives: TocDirective[];
  /** File paths listed in the .toc, in load order. */
  files: { path: string; line: number }[];
  /** Case-insensitive lookup of the non-localised directives. */
  get(key: string): string | undefined;
}

/**
 * Directives the client understands. Anything else must be prefixed `X-`,
 * or the client silently ignores it — a common source of "why is my
 * SavedVariable not saving" reports.
 */
export const KNOWN_DIRECTIVES = new Set([
  "interface", "title", "notes", "author", "version", "category", "group",
  "dependencies", "requireddeps", "optionaldeps", "loadondemand", "loadwith",
  "loadmanagers", "defaultstate", "allowloadgametype", "onlybetaandptr",
  "savedvariables", "savedvariablespercharacter", "loadsavedvariablesfirst",
  "icontexture", "iconatlas", "addoncompartmentfunc",
  "addoncompartmentfunconenter", "addoncompartmentfunconleave",
  "allowaddontableaccess",
]);

/** Directives whose value is a comma-separated list. */
export const LIST_DIRECTIVES = new Set([
  "interface", "dependencies", "requireddeps", "optionaldeps",
  "savedvariables", "savedvariablespercharacter",
]);

export function parseToc(source: string): ParsedToc {
  const directives: TocDirective[] = [];
  const files: { path: string; line: number }[] = [];

  source.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const text = raw.trim();
    if (text === "") return;

    if (text.startsWith("##")) {
      const body = text.slice(2).trim();
      const sep = body.indexOf(":");
      if (sep === -1) {
        directives.push({ key: body, value: "", line });
        return;
      }
      const rawKey = body.slice(0, sep).trim();
      const value = body.slice(sep + 1).trim();
      // `Title-frFR` -> key "Title", locale "frFR"
      const localeMatch = /^(.*?)-([a-z]{2}[A-Z]{2})$/.exec(rawKey);
      if (localeMatch) {
        directives.push({
          key: localeMatch[1]!,
          locale: localeMatch[2]!,
          value,
          line,
        });
      } else {
        directives.push({ key: rawKey, value, line });
      }
      return;
    }

    // `#` alone is a comment; anything else is a file to load.
    if (text.startsWith("#")) return;
    files.push({ path: text, line });
  });

  const lookup = new Map<string, string>();
  for (const d of directives) {
    if (!d.locale) lookup.set(d.key.toLowerCase(), d.value);
  }

  return {
    directives,
    files,
    get: (key: string) => lookup.get(key.toLowerCase()),
  };
}

// ---------------------------------------------------------------------------

export interface TocIssue {
  severity: "error" | "warning" | "info";
  line: number;
  message: string;
  suggestion?: string;
}

export interface TocValidation {
  fileName: string;
  /** Flavor inferred from the filename suffix, if the name carries one. */
  suffixFlavor?: Flavor;
  /** Flavors implied by the `## Interface:` values. */
  interfaceFlavors: Flavor[];
  issues: TocIssue[];
  parsed: ParsedToc;
}

/**
 * Reads the flavor suffix off a .toc filename. Returns undefined for a base
 * `MyAddon.toc`, which is legal and means "every flavor not covered by a
 * more specific file".
 */
export function flavorFromFileName(fileName: string): Flavor | undefined {
  const stem = fileName.replace(/\.toc$/i, "");
  for (const flavor of Object.values(FLAVORS)) {
    const suffixes = [flavor.tocSuffix, ...flavor.altTocSuffixes];
    for (const suffix of suffixes) {
      if (suffix && stem.toLowerCase().endsWith(suffix.toLowerCase())) return flavor;
    }
  }
  return undefined;
}

export function validateToc(
  source: string,
  fileName: string,
  opts: { presentFiles?: string[] } = {},
): TocValidation {
  const parsed = parseToc(source);
  const issues: TocIssue[] = [];
  const suffixFlavor = flavorFromFileName(fileName);

  // -- Interface ------------------------------------------------------------
  const interfaceDirective = parsed.directives.find(
    (d) => d.key.toLowerCase() === "interface" && !d.locale,
  );
  const interfaceFlavors: Flavor[] = [];

  if (!interfaceDirective) {
    issues.push({
      severity: "error",
      line: 1,
      message:
        "Missing `## Interface:`. Without it the client treats the addon as " +
        "out of date and disables it by default.",
      suggestion: `## Interface: ${(suffixFlavor ?? FLAVORS.mainline!).interfaceVersion}`,
    });
  } else {
    const values = interfaceDirective.value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    for (const v of values) {
      if (!/^\d{5,6}$/.test(v)) {
        issues.push({
          severity: "error",
          line: interfaceDirective.line,
          message: `"${v}" is not a valid Interface number (expected 5-6 digits, e.g. 120007).`,
        });
        continue;
      }
      const num = Number(v);
      const f = flavorForInterface(num);
      if (!f) {
        issues.push({
          severity: "warning",
          line: interfaceDirective.line,
          message: `Interface ${v} does not match any current client.`,
        });
        continue;
      }
      interfaceFlavors.push(f);
      if (num !== f.interfaceVersion) {
        issues.push({
          severity: "info",
          line: interfaceDirective.line,
          message:
            `Interface ${v} is behind the current ${f.label} build (${f.interfaceVersion}). ` +
            "The addon still loads, but shows as out of date in the addon list.",
          suggestion: `## Interface: ${f.interfaceVersion}`,
        });
      }
    }

    // A suffixed .toc naming one flavor but declaring another's Interface is
    // the classic multi-flavor packaging mistake: the file loads for a client
    // whose API it was not written against.
    if (suffixFlavor && interfaceFlavors.length > 0) {
      const matches = interfaceFlavors.some(
        (f) => f.apiIndex === suffixFlavor.apiIndex,
      );
      if (!matches) {
        issues.push({
          severity: "error",
          line: interfaceDirective.line,
          message:
            `The filename suffix targets ${suffixFlavor.label}, but the Interface ` +
            `number(s) belong to ${interfaceFlavors.map((f) => f.label).join(", ")}.`,
          suggestion: `## Interface: ${suffixFlavor.interfaceVersion}`,
        });
      }
    }

    if (values.length > 1 && suffixFlavor) {
      issues.push({
        severity: "info",
        line: interfaceDirective.line,
        message:
          "A flavor-suffixed .toc only ever loads on one client, so a multi-value " +
          "Interface list has no effect here. Multi-value lists are for a single " +
          "unsuffixed .toc that serves several clients.",
      });
    }
  }

  // -- required metadata ----------------------------------------------------
  if (!parsed.get("title")) {
    issues.push({
      severity: "warning",
      line: 1,
      message: "Missing `## Title:` — the addon list will show the folder name instead.",
    });
  }

  // -- unknown directives ---------------------------------------------------
  for (const d of parsed.directives) {
    const key = d.key.toLowerCase();
    if (key.startsWith("x-")) continue;
    if (KNOWN_DIRECTIVES.has(key)) continue;
    issues.push({
      severity: "warning",
      line: d.line,
      message:
        `"## ${d.key}:" is not a directive the client recognises, so it is ignored.`,
      suggestion: `## X-${d.key}: ${d.value}`,
    });
  }

  // -- SavedVariables sanity ------------------------------------------------
  for (const key of ["savedvariables", "savedvariablespercharacter"]) {
    const d = parsed.directives.find((x) => x.key.toLowerCase() === key && !x.locale);
    if (!d) continue;
    const names = d.value.split(",").map((v) => v.trim()).filter(Boolean);
    for (const name of names) {
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        issues.push({
          severity: "error",
          line: d.line,
          message: `"${name}" is not a valid global variable name for ${d.key}.`,
        });
      }
    }
    if (names.length === 0) {
      issues.push({
        severity: "warning",
        line: d.line,
        message: `## ${d.key}: is empty.`,
      });
    }
  }

  // -- LoadOnDemand / dependency coherence -----------------------------------
  const lod = parsed.get("loadondemand");
  if (lod && lod !== "1" && lod.toLowerCase() !== "true") {
    issues.push({
      severity: "warning",
      line: parsed.directives.find((d) => d.key.toLowerCase() === "loadondemand")!.line,
      message: "## LoadOnDemand: expects 1. Any other value is treated as unset.",
      suggestion: "## LoadOnDemand: 1",
    });
  }

  // -- listed files ---------------------------------------------------------
  const present = opts.presentFiles?.map((f) => f.replace(/\\/g, "/").toLowerCase());
  const seen = new Set<string>();

  for (const f of parsed.files) {
    const normalised = f.path.replace(/\\/g, "/").toLowerCase();

    if (seen.has(normalised)) {
      issues.push({
        severity: "warning",
        line: f.line,
        message: `"${f.path}" is listed more than once; it will be executed twice.`,
      });
    }
    seen.add(normalised);

    if (!/\.(lua|xml)$/i.test(f.path)) {
      issues.push({
        severity: "error",
        line: f.line,
        message:
          `"${f.path}" is neither a .lua nor a .xml file. The client only loads ` +
          "those two extensions from a .toc.",
      });
      continue;
    }

    if (f.path.includes("\\")) {
      issues.push({
        severity: "warning",
        line: f.line,
        message:
          `"${f.path}" uses backslashes. They work on Windows but fail on macOS; ` +
          "use forward slashes.",
        suggestion: f.path.replace(/\\/g, "/"),
      });
    }

    if (present && !present.includes(normalised)) {
      issues.push({
        severity: "error",
        line: f.line,
        message: `"${f.path}" is listed in the .toc but does not exist in the addon folder.`,
      });
    }
  }

  if (present) {
    const listed = new Set(seen);
    for (const file of present) {
      if (!/\.(lua|xml)$/i.test(file)) continue;
      if (!listed.has(file)) {
        issues.push({
          severity: "info",
          line: parsed.files.at(-1)?.line ?? 1,
          message: `"${file}" exists in the addon folder but is not listed in the .toc, so it never loads.`,
        });
      }
    }
  }

  issues.sort((a, b) => a.line - b.line);

  return { fileName, suffixFlavor, interfaceFlavors, issues, parsed };
}

export function formatTocValidation(v: TocValidation): string {
  const header = [
    v.fileName,
    v.suffixFlavor ? `  targets: ${v.suffixFlavor.label} (filename suffix)` : "  targets: all flavors (no filename suffix)",
    v.interfaceFlavors.length
      ? `  interface: ${v.interfaceFlavors.map((f) => f.label).join(", ")}`
      : "",
    `  ${v.parsed.files.length} file(s) listed, ${v.parsed.directives.length} directive(s)`,
    "",
  ].filter(Boolean);

  if (v.issues.length === 0) return [...header, "No issues found."].join("\n");

  const body = v.issues.flatMap((i) => {
    const out = [`  line ${i.line}  ${i.severity.padEnd(7)} ${i.message}`];
    if (i.suggestion) out.push(`      -> ${i.suggestion}`);
    return out;
  });

  const counts = v.issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {});

  return [
    ...header,
    ...body,
    "",
    `${counts.error ?? 0} error(s), ${counts.warning ?? 0} warning(s), ${counts.info ?? 0} note(s).`,
  ].join("\n");
}
