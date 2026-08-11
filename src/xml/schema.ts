import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { XMLParser } from "fast-xml-parser";

import { DATA_DIR } from "../config.js";

/**
 * A digest of Blizzard's UI.xsd, reduced to the questions a validator actually
 * asks: which elements exist, what may nest inside each, and which attributes
 * each accepts (with enumerated values where the schema restricts them).
 *
 * Parsing the XSD at startup rather than shipping a hand-written table means
 * the validator tracks whatever `npm run sync-data` last pulled, so new frame
 * types and attributes do not need a code change.
 */
export interface SchemaElement {
  name: string;
  /** Element name this one extends, if any. */
  base?: string;
  attributes: Map<string, SchemaAttribute>;
  /** Child element names allowed directly under this element. */
  children: Set<string>;
  /** True for elements in a substitution group — they accept their group. */
  substitutionGroup?: string;
}

export interface SchemaAttribute {
  name: string;
  type: string;
  /** Allowed values when the type is an enumeration. */
  values?: string[];
  required: boolean;
}

export interface UiSchema {
  elements: Map<string, SchemaElement>;
  /** Lowercased name -> canonical name, for case-suggestion. */
  canonical: Map<string, string>;
  /** Simple types that enumerate their values, e.g. FRAMEPOINT. */
  enums: Map<string, string[]>;
  /** substitutionGroup head -> members. */
  substitutions: Map<string, string[]>;
}

let cached: UiSchema | null = null;

type XsdNode = Record<string, unknown>;

const arr = (v: unknown): XsdNode[] =>
  v === undefined ? [] : Array.isArray(v) ? (v as XsdNode[]) : [v as XsdNode];

const attr = (node: XsdNode, name: string): string | undefined => {
  const v = node[`@_${name}`];
  return v === undefined ? undefined : String(v);
};

/** Strips the `ui:` / `xs:` namespace prefix from a QName. */
const localName = (qname: string | undefined): string | undefined =>
  qname?.includes(":") ? qname.split(":").pop() : qname;

export function loadUiSchema(): UiSchema {
  if (cached) return cached;

  const path = resolve(DATA_DIR, "ui.xsd");
  let xsd: string;
  try {
    xsd = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read the UI schema at ${path}. Run \`npm run sync-data\`. ` +
        `Cause: ${(err as Error).message}`,
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    allowBooleanAttributes: true,
    parseAttributeValue: false,
  });
  const doc = parser.parse(xsd) as XsdNode;
  const schema = (doc.schema ?? {}) as XsdNode;

  const enums = new Map<string, string[]>();
  for (const st of arr(schema.simpleType)) {
    const name = attr(st, "name");
    if (!name) continue;
    const restriction = arr(st.restriction)[0];
    if (!restriction) continue;
    const values = arr(restriction.enumeration)
      .map((e) => attr(e, "value"))
      .filter((v): v is string => v !== undefined);
    if (values.length) enums.set(name, values);
  }

  const elements = new Map<string, SchemaElement>();
  const substitutions = new Map<string, string[]>();

  /** Collects attributes declared directly on a complexType-ish node. */
  const collectAttributes = (node: XsdNode, into: Map<string, SchemaAttribute>): void => {
    for (const a of arr(node.attribute)) {
      const name = attr(a, "name");
      if (!name) continue;
      const typeName = localName(attr(a, "type")) ?? "string";
      const inlineEnum = arr(arr(a.simpleType)[0]?.restriction)[0];
      const values =
        enums.get(typeName) ??
        (inlineEnum
          ? arr(inlineEnum.enumeration)
              .map((e) => attr(e, "value"))
              .filter((v): v is string => v !== undefined)
          : undefined);
      into.set(name, {
        name,
        type: typeName,
        ...(values?.length ? { values } : {}),
        required: attr(a, "use") === "required",
      });
    }
    for (const g of arr(node.attributeGroup)) {
      const ref = localName(attr(g, "ref"));
      if (ref) into.set(`@group:${ref}`, { name: ref, type: "group", required: false });
    }
  };

  /** Walks the particle tree (sequence/choice/all) collecting child names. */
  const collectChildren = (node: XsdNode, into: Set<string>, depth = 0): void => {
    if (depth > 20) return;
    for (const key of ["sequence", "choice", "all"]) {
      for (const particle of arr(node[key])) {
        for (const el of arr(particle.element)) {
          const name = attr(el, "name") ?? localName(attr(el, "ref"));
          if (name) into.add(name);
        }
        for (const g of arr(particle.group)) {
          const ref = localName(attr(g, "ref"));
          if (ref) into.add(`@group:${ref}`);
        }
        collectChildren(particle, into, depth + 1);
      }
    }
  };

  const readComplexType = (node: XsdNode, name: string, base?: string): SchemaElement => {
    const attributes = new Map<string, SchemaAttribute>();
    const children = new Set<string>();

    collectAttributes(node, attributes);
    collectChildren(node, children);

    let resolvedBase = base;

    // `simpleContent` types hold text plus attributes and no child elements.
    // Blizzard uses this for every script handler (`<OnLoad method="..."/>`),
    // so skipping it would drop those attributes entirely.
    for (const sc of arr(node.simpleContent)) {
      for (const ext of [...arr(sc.extension), ...arr(sc.restriction)]) {
        const extBase = localName(attr(ext, "base"));
        // xs:string and friends are not element types to inherit from.
        if (extBase && !extBase.startsWith("string") && namedTypes.has(extBase)) {
          resolvedBase = extBase;
        }
        collectAttributes(ext, attributes);
      }
    }

    for (const cc of arr(node.complexContent)) {
      for (const ext of arr(cc.extension)) {
        resolvedBase = localName(attr(ext, "base")) ?? resolvedBase;
        collectAttributes(ext, attributes);
        collectChildren(ext, children);
      }
      for (const res of arr(cc.restriction)) {
        resolvedBase = localName(attr(res, "base")) ?? resolvedBase;
        collectAttributes(res, attributes);
        collectChildren(res, children);
      }
    }

    return {
      name,
      ...(resolvedBase ? { base: resolvedBase } : {}),
      attributes,
      children,
    };
  };

  // Named complexTypes first — elements reference them by name.
  const namedTypes = new Map<string, SchemaElement>();
  for (const ct of arr(schema.complexType)) {
    const name = attr(ct, "name");
    if (!name) continue;
    namedTypes.set(name, readComplexType(ct, name));
  }

  // Named groups, so `@group:Foo` references can be expanded.
  const namedGroups = new Map<string, Set<string>>();
  for (const g of arr(schema.group)) {
    const name = attr(g, "name");
    if (!name) continue;
    const children = new Set<string>();
    collectChildren(g, children);
    namedGroups.set(name, children);
  }

  const namedAttrGroups = new Map<string, Map<string, SchemaAttribute>>();
  for (const g of arr(schema.attributeGroup)) {
    const name = attr(g, "name");
    if (!name) continue;
    const attrs = new Map<string, SchemaAttribute>();
    collectAttributes(g, attrs);
    namedAttrGroups.set(name, attrs);
  }

  /** Registers one `xs:element` declaration, wherever it appears. */
  const registerElement = (el: XsdNode): void => {
    const name = attr(el, "name");
    if (!name) return;

    const typeRef = localName(attr(el, "type"));
    const inline = arr(el.complexType)[0];

    let entry: SchemaElement;
    if (inline) {
      entry = readComplexType(inline, name);
    } else if (typeRef && namedTypes.has(typeRef)) {
      const t = namedTypes.get(typeRef)!;
      entry = {
        name,
        ...(t.base ? { base: t.base } : {}),
        attributes: new Map(t.attributes),
        children: new Set(t.children),
      };
    } else {
      entry = { name, attributes: new Map(), children: new Set() };
    }

    const sub = localName(attr(el, "substitutionGroup"));
    if (sub) {
      entry.substitutionGroup = sub;
      const list = substitutions.get(sub) ?? [];
      list.push(name);
      substitutions.set(sub, list);
    }

    // The same element name is declared more than once with different content
    // models — `<Scripts>` holds frame handlers under a frame but animation
    // handlers (OnPlay, OnFinished) under an AnimationGroup. Since this
    // validator has no type context at the point of use, it unions the
    // declarations. That is deliberately permissive: rejecting valid markup is
    // far worse here than missing a rare misplacement.
    const existing = elements.get(name);
    if (!existing) {
      elements.set(name, entry);
      return;
    }
    for (const c of entry.children) existing.children.add(c);
    for (const [an, a] of entry.attributes) {
      if (!existing.attributes.has(an)) existing.attributes.set(an, a);
    }
    if (!existing.base && entry.base) existing.base = entry.base;
  };

  /**
   * Walks the whole schema for `xs:element` declarations.
   *
   * Blizzard's XSD declares most of the elements addons actually write —
   * Anchor, Layer, OnLoad, Offset — *locally*, nested inside the complexType
   * of their parent rather than at the top level. Registering only top-level
   * elements would leave the validator rejecting almost every real UI file.
   */
  const collectElementsDeep = (node: unknown, depth = 0): void => {
    if (depth > 30 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectElementsDeep(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as XsdNode)) {
      if (key.startsWith("@_")) continue;
      if (key === "element") {
        for (const el of arr(value)) {
          registerElement(el);
          collectElementsDeep(el, depth + 1);
        }
        continue;
      }
      collectElementsDeep(value, depth + 1);
    }
  };

  // Top-level declarations first so they win over any local shadow.
  for (const el of arr(schema.element)) registerElement(el);
  collectElementsDeep(schema);

  // Expand group references now that every group and type is known.
  const expandGroups = (el: SchemaElement, seen = new Set<string>()): void => {
    for (const child of [...el.children]) {
      if (!child.startsWith("@group:")) continue;
      el.children.delete(child);
      const groupName = child.slice(7);
      if (seen.has(groupName)) continue;
      seen.add(groupName);
      for (const member of namedGroups.get(groupName) ?? []) el.children.add(member);
    }
    for (const [key, value] of [...el.attributes]) {
      if (!key.startsWith("@group:")) continue;
      el.attributes.delete(key);
      for (const [an, a] of namedAttrGroups.get(value.name) ?? []) {
        if (!el.attributes.has(an)) el.attributes.set(an, a);
      }
    }
  };

  // Groups can reference other groups, so run to a fixpoint rather than a
  // fixed number of passes.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const el of [...elements.values(), ...namedTypes.values()]) {
      const before = el.children.size + el.attributes.size;
      expandGroups(el);
      if (el.children.size + el.attributes.size !== before) changed = true;
    }
    if (!changed) break;
  }

  // Fold inherited attributes and children down the `base` chain, so a lookup
  // on <Button> sees everything <Frame> and <LayoutFrame> declare.
  const resolveInheritance = (el: SchemaElement, depth = 0): void => {
    if (!el.base || depth > 12) return;
    const parent = namedTypes.get(el.base) ?? elements.get(el.base);
    if (!parent) return;
    resolveInheritance(parent, depth + 1);
    for (const [name, a] of parent.attributes) {
      if (!el.attributes.has(name)) el.attributes.set(name, a);
    }
    for (const c of parent.children) el.children.add(c);
  };

  for (const el of elements.values()) resolveInheritance(el);

  /**
   * Substitution groups are transitive and several levels deep here:
   * `Frame` substitutes for `FrameRef`, which substitutes for `LayoutFrameRef`,
   * which substitutes for `UiField` — the only thing `<Ui>` accepts directly.
   * Expanding one level would still reject `<Frame>` inside `<Ui>`, so this
   * closes over the whole chain.
   */
  const membersOf = (head: string, seen = new Set<string>()): string[] => {
    if (seen.has(head)) return [];
    seen.add(head);
    const direct = substitutions.get(head) ?? [];
    return [...direct, ...direct.flatMap((m) => membersOf(m, seen))];
  };

  for (const el of elements.values()) {
    for (const child of [...el.children]) {
      for (const member of membersOf(child)) el.children.add(member);
    }
  }

  const canonical = new Map<string, string>();
  for (const name of elements.keys()) canonical.set(name.toLowerCase(), name);

  cached = { elements, canonical, enums, substitutions };
  return cached;
}
