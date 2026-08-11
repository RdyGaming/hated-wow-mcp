import { loadUiSchema, type UiSchema } from "./schema.js";

export interface XmlIssue {
  severity: "error" | "warning" | "info";
  line: number;
  column: number;
  message: string;
  suggestion?: string;
}

export interface XmlValidation {
  file: string;
  issues: XmlIssue[];
  stats: { elements: number; depth: number };
}

interface OpenTag {
  name: string;
  line: number;
  column: number;
  selfClosing: boolean;
}

/** The document element of every WoW UI XML file. */
const ROOT_ELEMENT = "Ui";
const UI_NAMESPACE = "http://www.blizzard.com/wow/ui/";

/**
 * Bindings.xml is a second, much smaller XML dialect the client loads from a
 * .toc alongside UI files. It has its own root and elements and is not
 * described by UI.xsd, so validating it against that schema would report every
 * line as invalid.
 */
const BINDINGS_ATTRIBUTES: Record<string, string[]> = {
  Bindings: [],
  Binding: ["name", "header", "runOnUp", "category", "default", "description"],
  ModifiedClick: ["name", "default", "description"],
};

function validateBindings(source: string, file: string): XmlValidation {
  const issues: XmlIssue[] = [];
  let elements = 0;

  const tagRe = /<(\/)?([A-Za-z_][\w.:-]*)([^>]*?)(\/)?>/g;
  for (const m of source.matchAll(tagRe)) {
    if (m[1]) continue;
    elements++;
    const name = m[2]!;
    const before = source.slice(0, m.index);
    const line = before.split("\n").length;
    const column = m.index! - before.lastIndexOf("\n");

    const allowed = BINDINGS_ATTRIBUTES[name];
    if (!allowed) {
      issues.push({
        severity: "error",
        line,
        column,
        message: `<${name}> is not valid in a Bindings.xml file (expected Bindings, Binding or ModifiedClick).`,
      });
      continue;
    }

    for (const a of (m[3] ?? "").matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
      if (a[1]!.startsWith("xmlns")) continue;
      if (!allowed.includes(a[1]!)) {
        issues.push({
          severity: "warning",
          line,
          column,
          message: `Attribute "${a[1]}" is not defined for <${name}> in a bindings file.`,
        });
      }
    }

    if (name === "Binding" && !/\bname\s*=\s*"/.test(m[3] ?? "")) {
      issues.push({
        severity: "error",
        line,
        column,
        message: "<Binding> requires a name attribute; it is the binding's identifier.",
      });
    }
  }

  return { file, issues, stats: { elements, depth: 2 } };
}

/**
 * Validates a WoW interface XML file against Blizzard's own UI.xsd.
 *
 * A generic XSD validator would report the same structural errors, but not the
 * ones that actually bite addon authors: a misspelled attribute the client
 * silently ignores, a script handler that is not a real handler name, or a
 * `virtual="true"` frame with no name. Those need the schema plus WoW-specific
 * knowledge, which is what this adds.
 */
export function validateXml(source: string, file = "<inline>"): XmlValidation {
  // Dispatch on the actual root element rather than the filename, so an
  // inline snippet is handled the same way a file would be.
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<Bindings\b/.test(source)) {
    return validateBindings(source, file);
  }

  const schema = loadUiSchema();
  const issues: XmlIssue[] = [];

  const lineOf = (offset: number): { line: number; column: number } => {
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    return { line, column };
  };

  const stack: OpenTag[] = [];
  let elementCount = 0;
  let maxDepth = 0;
  let sawRoot = false;

  // Strip comments and CDATA before scanning so their contents cannot look
  // like markup. Replacing with same-length whitespace preserves offsets.
  const blanked = source
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));

  const tagRe = /<(\/)?([A-Za-z_][\w.:-]*)([^>]*?)(\/)?>/g;

  for (const m of blanked.matchAll(tagRe)) {
    const [, closing, rawName, rawAttrs = "", selfClose] = m;
    const pos = lineOf(m.index!);
    const name = rawName!.includes(":") ? rawName!.split(":").pop()! : rawName!;

    if (closing) {
      const open = stack.pop();
      if (!open) {
        issues.push({
          severity: "error",
          ...pos,
          message: `Closing tag </${name}> has no matching opening tag.`,
        });
      } else if (open.name !== name) {
        issues.push({
          severity: "error",
          ...pos,
          message: `Closing tag </${name}> does not match <${open.name}> opened at line ${open.line}.`,
        });
      }
      continue;
    }

    elementCount++;

    // -- root element -------------------------------------------------------
    if (stack.length === 0) {
      if (!sawRoot) {
        sawRoot = true;
        if (name !== ROOT_ELEMENT) {
          issues.push({
            severity: "error",
            ...pos,
            message: `A UI XML file must have <${ROOT_ELEMENT}> as its root element, not <${name}>.`,
            suggestion: `<Ui xmlns="${UI_NAMESPACE}">`,
          });
        } else if (!rawAttrs.includes(UI_NAMESPACE)) {
          issues.push({
            severity: "warning",
            ...pos,
            message:
              "The <Ui> root is missing the Blizzard UI namespace. Without it " +
              "some tooling (and XSD-aware editors) cannot resolve the schema.",
            suggestion: `<Ui xmlns="${UI_NAMESPACE}">`,
          });
        }
      } else {
        issues.push({
          severity: "error",
          ...pos,
          message: `<${name}> appears after the document element closed; XML allows only one root.`,
        });
      }
    }

    const element = schema.elements.get(name);

    // -- unknown element ----------------------------------------------------
    if (!element) {
      const canonical = schema.canonical.get(name.toLowerCase());
      issues.push({
        severity: "error",
        ...pos,
        message: canonical
          ? `<${name}> is not a valid element; XML element names are case-sensitive.`
          : `<${name}> is not an element defined in Blizzard's UI schema.`,
        ...(canonical ? { suggestion: `<${canonical}>` } : {}),
      });
    } else {
      // -- nesting ----------------------------------------------------------
      const parent = stack[stack.length - 1];
      if (parent) {
        const parentEl = schema.elements.get(parent.name);
        if (parentEl && parentEl.children.size > 0 && !parentEl.children.has(name)) {
          issues.push({
            severity: "error",
            ...pos,
            message:
              `<${name}> is not allowed directly inside <${parent.name}>. ` +
              `Valid children: ${[...parentEl.children].sort().slice(0, 12).join(", ")}` +
              (parentEl.children.size > 12 ? ", …" : "") +
              ".",
          });
        }
      }

      // -- attributes -------------------------------------------------------
      validateAttributes(rawAttrs!, name, element, schema, m.index!, lineOf, issues);
    }

    if (!selfClose) {
      stack.push({ name, line: pos.line, column: pos.column, selfClosing: false });
      maxDepth = Math.max(maxDepth, stack.length);
    }
  }

  for (const unclosed of stack) {
    issues.push({
      severity: "error",
      line: unclosed.line,
      column: unclosed.column,
      message: `<${unclosed.name}> is never closed.`,
    });
  }

  if (!sawRoot) {
    issues.push({
      severity: "error",
      line: 1,
      column: 1,
      message: "No elements found — a UI XML file must contain a <Ui> root element.",
    });
  }

  issues.sort((a, b) => a.line - b.line || a.column - b.column);

  return {
    file,
    issues,
    stats: { elements: elementCount, depth: maxDepth },
  };
}

function validateAttributes(
  rawAttrs: string,
  elementName: string,
  element: ReturnType<UiSchema["elements"]["get"]> & object,
  schema: UiSchema,
  tagOffset: number,
  lineOf: (offset: number) => { line: number; column: number },
  issues: XmlIssue[],
): void {
  const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  const seen = new Set<string>();

  for (const a of rawAttrs.matchAll(attrRe)) {
    const [, name, value] = a;
    const pos = lineOf(tagOffset + (a.index ?? 0));

    if (name!.startsWith("xmlns")) continue;

    if (seen.has(name!)) {
      issues.push({
        severity: "error",
        ...pos,
        message: `Attribute "${name}" is repeated on <${elementName}>.`,
      });
    }
    seen.add(name!);

    const attr = element.attributes.get(name!);
    if (!attr) {
      // Case-insensitive near-match is the overwhelmingly common mistake here
      // (`Name` vs `name`, `Virtual` vs `virtual`).
      const near = [...element.attributes.keys()].find(
        (k) => k.toLowerCase() === name!.toLowerCase(),
      );
      issues.push({
        severity: near ? "error" : "warning",
        ...pos,
        message: near
          ? `Attribute "${name}" on <${elementName}> should be "${near}" — attribute names are case-sensitive and the client ignores unknown ones.`
          : `Attribute "${name}" is not defined for <${elementName}>, so the client will ignore it.`,
        ...(near ? { suggestion: `${near}="${value}"` } : {}),
      });
      continue;
    }

    // XML Schema collapses whitespace in enum and boolean values before
    // validating, and Blizzard's own markup relies on that (`hidden=" true"`).
    const collapsed = value!.trim().replace(/\s+/g, " ");

    if (attr.values && collapsed !== "" && !attr.values.includes(collapsed)) {
      const near = attr.values.find((v) => v.toLowerCase() === collapsed.toLowerCase());
      issues.push({
        severity: "error",
        ...pos,
        message:
          `"${value}" is not a valid value for ${elementName}.${name}. ` +
          `Expected one of: ${attr.values.slice(0, 10).join(", ")}` +
          (attr.values.length > 10 ? ", …" : "") +
          ".",
        ...(near ? { suggestion: `${name}="${near}"` } : {}),
      });
    }

    // XML Schema booleans accept 1/0 as well as true/false, and Blizzard's own
    // markup uses both forms.
    if (attr.type === "boolean" && !["true", "false", "1", "0"].includes(collapsed)) {
      issues.push({
        severity: "error",
        ...pos,
        message: `${elementName}.${name} is a boolean; expected "true" or "false", got "${value}".`,
      });
    }
  }

  // -- WoW-specific structural rules ----------------------------------------
  const isVirtual = /\bvirtual\s*=\s*"true"/i.test(rawAttrs);
  const hasName = /\bname\s*=\s*"/.test(rawAttrs);
  const pos = lineOf(tagOffset);

  if (isVirtual && !hasName) {
    issues.push({
      severity: "error",
      ...pos,
      message:
        `<${elementName} virtual="true"> has no name, so nothing can inherit from it.`,
    });
  }

  for (const [attrName, attr] of element.attributes) {
    if (attr.required && !seen.has(attrName)) {
      issues.push({
        severity: "error",
        ...pos,
        message: `<${elementName}> is missing required attribute "${attrName}".`,
      });
    }
  }

  // `inherits` naming a template this file cannot see is a load-order bug that
  // shows up only at runtime, so it is worth calling out as a reminder.
  const inherits = /\binherits\s*=\s*"([^"]+)"/i.exec(rawAttrs)?.[1];
  if (inherits && schema.elements.has(inherits)) {
    issues.push({
      severity: "warning",
      ...pos,
      message:
        `inherits="${inherits}" names an element type, not a template. ` +
        "The inherits attribute takes the name of a virtual frame.",
    });
  }
}

export function formatXmlValidation(v: XmlValidation): string {
  const header = `${v.file}  (${v.stats.elements} elements, max depth ${v.stats.depth})`;
  if (v.issues.length === 0) return `${header}\n\nNo issues found.`;

  const body = v.issues.flatMap((i) => {
    const out = [`  ${i.line}:${i.column}  ${i.severity.padEnd(7)} ${i.message}`];
    if (i.suggestion) out.push(`      -> ${i.suggestion}`);
    return out;
  });

  const counts = v.issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {});

  return [
    header,
    "",
    ...body,
    "",
    `${counts.error ?? 0} error(s), ${counts.warning ?? 0} warning(s), ${counts.info ?? 0} note(s).`,
  ].join("\n");
}
