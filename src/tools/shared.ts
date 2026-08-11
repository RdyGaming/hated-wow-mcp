import type { ZodRawShape } from "zod";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: ZodRawShape;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
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
