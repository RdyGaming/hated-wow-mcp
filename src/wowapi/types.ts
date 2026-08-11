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
  cvars: string[];
}
