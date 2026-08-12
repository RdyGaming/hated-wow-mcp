import type { ZodRawShape } from "zod";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Which synced data set a tool's answers come from, if any. */
export type Dataset = "uisource" | "gamedata";

export interface ToolDef {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Set when a tool answers from synced data rather than the bundled indexes.
   * Declaring it here rather than in each handler is what lets the staleness
   * note be applied in one place.
   */
  dataset?: Dataset;
}

/**
 * How old a synced index may get before answers are worth doubting.
 *
 * WoW patches land every few weeks, and the failure mode of stale data is the
 * dangerous one: a confident answer about a function or texture that no longer
 * exists. A month is long enough that a real patch has probably shipped.
 */
export const STALE_AFTER_DAYS = 30;

export function ageInDays(generatedAt: string): number | null {
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/**
 * A one-line warning to append to output derived from an old index. Returns
 * empty for fresh data, so callers can append it unconditionally.
 */
export function stalenessNote(generatedAt: string | undefined, dataset: Dataset): string {
  if (!generatedAt) return "";
  const days = ageInDays(generatedAt);
  if (days === null || days < STALE_AFTER_DAYS) return "";

  const command =
    dataset === "uisource" ? "the UI source sync" : "the game data sync";
  return (
    `\n\n[This answer comes from data synced ${days} days ago. WoW has very ` +
    `likely patched since — re-run ${command} before trusting it. ` +
    `wow_data_status shows the details.]`
  );
}

export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function errorText(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/**
 * Truncates tool output to keep a single response from flooding the model's
 * context. The cut is reported explicitly so the caller knows to narrow the
 * query rather than assuming it saw everything.
 */
export function cap(body: string, maxChars = 60_000): string {
  if (body.length <= maxChars) return body;
  return (
    body.slice(0, maxChars) +
    `\n\n[output truncated at ${maxChars} characters — narrow the query or lower \`limit\` to see the rest]`
  );
}
