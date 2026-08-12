export interface ApiParam {
  name: string;
  type: string;
  nilable: boolean;
  default?: string | number | boolean;
  mixin?: string;
  innerType?: string;
  enumValue?: number;
  documentation?: string[];
}

export interface ApiFunction {
  name: string;
  system: string;
  namespace?: string;
  /** Fully-qualified call name, e.g. `C_Item.GetItemInfo`. */
  signature: string;
  arguments: ApiParam[];
  returns: ApiParam[];
  documentation?: string[];
  /** Events this call is documented as firing. */
  events?: string[];
  secretArguments?: string;
  secretReturns?: string;
}

export interface ApiEvent {
  name: string;
  system: string;
  /** The string you pass to `frame:RegisterEvent`. */
  literalName: string;
  payload: ApiParam[];
  documentation?: string[];
}

export interface ApiTable {
  name: string;
  system: string;
  /** "Enumeration" | "Structure" | "Constants" | "CallbackType" | ... */
  kind: string;
  fields?: ApiParam[];
  values?: { name: string; value: number | string; type?: string }[];
  documentation?: string[];
}

export interface ApiIndex {
  flavor: string;
  generatedAt: string;
  upstream: { uiSource: string; resources: string };
  counts: Record<string, number>;
  functions: ApiFunction[];
  events: ApiEvent[];
  tables: ApiTable[];
  /** Legacy non-namespaced globals (`UnitHealth`, `CreateFrame`, …). */
  globals: string[];
  /** Every event name valid in this flavor, documented or not. */
  eventNames: string[];
  /**
   * Objects since 0.4.0; a bare `string[]` in indexes built before that. The
   * loader normalises both, so an old bundled index still works.
   */
  cvars: ApiCVar[] | string[];
}

export interface ApiCVar {
  name: string;
  /** The client's default, as a string — CVar values are always strings. */
  default: string;
  /** Debug, Graphics, Console, Combat, Game, Net, Sound, Gm, Reveal, None. */
  category: string;
  /** Stored per WoW account rather than per character. */
  account: boolean;
  /** Stored per character. */
  character: boolean;
  /** Protected: an addon cannot set it, and trying taints. */
  secure: boolean;
  /** Blizzard's own one-line description, where there is one. */
  help?: string;
}
