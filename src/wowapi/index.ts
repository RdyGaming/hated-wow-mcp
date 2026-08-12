import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DATA_DIR, bundledDataMessage, type Flavor } from "../config.js";
import type { ApiEvent, ApiFunction, ApiIndex, ApiTable } from "./types.js";

/**
 * The three bundled indexes total ~8 MB of JSON. Loading one costs ~150 ms, so
 * they are parsed on first use and kept — a long-lived MCP server will answer
 * many reference questions, and re-parsing per call would dominate latency.
 */
const cache = new Map<string, LoadedIndex>();

export interface LoadedIndex {
  raw: ApiIndex;
  /** Lowercased signature -> function, for exact lookup. */
  bySignature: Map<string, ApiFunction>;
  /** Lowercased bare name -> functions sharing it across namespaces. */
  byName: Map<string, ApiFunction[]>;
  byEvent: Map<string, ApiEvent>;
  byTable: Map<string, ApiTable>;
  globalSet: Set<string>;
  eventSet: Set<string>;
  cvarSet: Set<string>;
  /**
   * Every name that resolves to something callable in this flavor: documented
   * functions, their bare names, legacy globals and namespace roots. This is
   * the allowlist the linter checks unknown calls against.
   */
  callableSet: Set<string>;
  namespaces: Set<string>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export function loadIndex(flavor: Flavor): LoadedIndex {
  const key = flavor.apiIndex;
  const cached = cache.get(key);
  if (cached) return cached;

  const file = resolve(DATA_DIR, `api-${key}.json`);
  let raw: ApiIndex;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as ApiIndex;
  } catch (err) {
    throw new Error(
      `Could not load the bundled API index for "${key}" (${file}). ` +
        `${bundledDataMessage()} Cause: ${(err as Error).message}`,
    );
  }

  const bySignature = new Map<string, ApiFunction>();
  const byName = new Map<string, ApiFunction[]>();
  const namespaces = new Set<string>();
  const callableSet = new Set<string>();

  for (const fn of raw.functions) {
    bySignature.set(fn.signature.toLowerCase(), fn);
    push(byName, fn.name.toLowerCase(), fn);
    callableSet.add(fn.signature);
    if (fn.namespace) {
      namespaces.add(fn.namespace);
    } else {
      // Non-namespaced documented functions are callable by bare name.
      callableSet.add(fn.name);
    }
  }

  for (const g of raw.globals) callableSet.add(g);

  const byEvent = new Map<string, ApiEvent>();
  for (const ev of raw.events) byEvent.set(ev.literalName.toUpperCase(), ev);

  const byTable = new Map<string, ApiTable>();
  for (const t of raw.tables) byTable.set(t.name.toLowerCase(), t);

  const loaded: LoadedIndex = {
    raw,
    bySignature,
    byName,
    byEvent,
    byTable,
    globalSet: new Set(raw.globals),
    eventSet: new Set(raw.eventNames),
    cvarSet: new Set(raw.cvars),
    callableSet,
    namespaces,
  };

  cache.set(key, loaded);
  return loaded;
}

export type { ApiEvent, ApiFunction, ApiIndex, ApiParam, ApiTable } from "./types.js";
