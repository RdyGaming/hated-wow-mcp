export type TokenType =
  | "name"
  | "keyword"
  | "number"
  | "string"
  | "operator"
  | "comment"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Byte offset into the source. */
  offset: number;
}

export const LUA_KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
  "true", "until", "while",
]);

/**
 * Lua's base library plus everything WoW's sandbox adds on top of it. These are
 * legitimate globals in every addon, so the "undefined global" check must not
 * flag them.
 */
export const LUA_BASE_GLOBALS = new Set([
  // Lua 5.1 base
  "assert", "collectgarbage", "dofile", "error", "getfenv", "getmetatable",
  "ipairs", "load", "loadfile", "loadstring", "module", "next", "pairs",
  "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require",
  "select", "setfenv", "setmetatable", "tonumber", "tostring", "type",
  "unpack", "xpcall", "newproxy",
  // Lua 5.1 libraries WoW exposes
  "bit", "coroutine", "debug", "math", "os", "string", "table", "_G", "_VERSION",
  // WoW additions to the base sandbox
  "wipe", "strsplit", "strjoin", "strtrim", "strlower", "strupper", "strrep",
  "strbyte", "strchar", "strfind", "strmatch", "strgmatch", "strgsub",
  "strsub", "strlen", "strconcat", "format", "gsub", "gmatch", "tinsert",
  "tremove", "tContains", "tDeleteItem", "tIndexOf", "tInvert", "tFilter",
  "tAppendAll", "sort", "max", "min", "abs", "ceil", "floor", "sqrt", "mod",
  "random", "date", "time", "difftime", "securecall", "seterrorhandler",
  "geterrorhandler", "issecure", "issecurevariable", "forceinsecure",
  "hooksecurefunc", "scrub", "Mixin", "CreateFromMixins", "CreateAndInitFromMixin",
  "CreateFrame", "GenerateClosure", "EnumUtil", "Enum", "Constants",
  "C_Timer", "LibStub", "coroutinecreate", "PI", "huge", "Round", "Clamp",
  "Saturate", "Lerp", "DeltaLerp", "Wrap", "WrapMod", "CopyTable", "CopyValuesAsKeys",
  "MergeTable", "Flags_CreateMask", "Flags_CreateMaskFromTable",
  "FrameDeltaLerp", "GetTimePreciseSec", "GetTime", "debugprofilestop",
  "debugstack", "geterrorhandler", "nop", "setprinthandler", "getprinthandler",
]);

/**
 * Tokenises Lua 5.1 (plus WoW's `continue`-free dialect and Lua 5.2 goto
 * labels, both of which the client's parser accepts).
 *
 * This is a lexer only — it is deliberately not a full parser. Every check in
 * `analyze.ts` is expressible over a token stream, and a lexer degrades
 * gracefully on syntax it does not expect, which matters when linting a file
 * mid-edit.
 */
export function tokenize(source: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];

  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = (): number => i - lineStart + 1;

  const advanceNewlines = (text: string): void => {
    for (const ch of text) {
      if (ch === "\n") {
        line++;
        lineStart = i;
      }
    }
  };

  /** Reads a `[[ ]]` / `[==[ ]==]` long bracket at `i`, or returns null. */
  const readLongBracket = (): string | null => {
    if (source[i] !== "[") return null;
    let level = 0;
    let j = i + 1;
    while (source[j] === "=") {
      level++;
      j++;
    }
    if (source[j] !== "[") return null;

    const close = `]${"=".repeat(level)}]`;
    const end = source.indexOf(close, j + 1);
    const stop = end === -1 ? source.length : end + close.length;
    const text = source.slice(i, stop);
    if (end === -1) {
      errors.push({ line, column: col(), message: "unterminated long bracket" });
    }
    i = stop;
    advanceNewlines(text);
    return text;
  };

  while (i < source.length) {
    const startLine = line;
    const startCol = col();
    const startOffset = i;
    const ch = source[i]!;

    // Whitespace
    if (ch === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comments
    if (source.startsWith("--", i)) {
      i += 2;
      const long = readLongBracket();
      if (long !== null) {
        tokens.push({
          type: "comment",
          value: `--${long}`,
          line: startLine,
          column: startCol,
          offset: startOffset,
        });
        continue;
      }
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      tokens.push({
        type: "comment",
        value: source.slice(startOffset, stop),
        line: startLine,
        column: startCol,
        offset: startOffset,
      });
      i = stop;
      continue;
    }

    // Long strings
    if (ch === "[") {
      const long = readLongBracket();
      if (long !== null) {
        tokens.push({
          type: "string",
          value: long,
          line: startLine,
          column: startCol,
          offset: startOffset,
        });
        continue;
      }
    }

    // Quoted strings
    if (ch === '"' || ch === "'") {
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          if (source[i + 1] === "\n") {
            i++;
            line++;
            lineStart = i + 1;
          }
          i += 2;
          continue;
        }
        if (c === "\n") break; // unterminated: Lua forbids raw newlines here
        if (c === ch) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        errors.push({ line: startLine, column: startCol, message: "unterminated string" });
      }
      tokens.push({
        type: "string",
        value: source.slice(startOffset, i),
        line: startLine,
        column: startCol,
        offset: startOffset,
      });
      continue;
    }

    // Numbers
    const numMatch = /^(?:0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][-+]?\d+)?|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(
      source.slice(i),
    );
    if (numMatch && (/\d/.test(ch) || (ch === "." && /\d/.test(source[i + 1] ?? "")))) {
      i += numMatch[0].length;
      tokens.push({
        type: "number",
        value: numMatch[0],
        line: startLine,
        column: startCol,
        offset: startOffset,
      });
      continue;
    }

    // Names and keywords
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*/.exec(source.slice(i))!;
      i += m[0].length;
      tokens.push({
        type: LUA_KEYWORDS.has(m[0]) ? "keyword" : "name",
        value: m[0],
        line: startLine,
        column: startCol,
        offset: startOffset,
      });
      continue;
    }

    // Operators, longest match first
    const ops = ["...", "==", "~=", "<=", ">=", "..", "::"];
    const op = ops.find((o) => source.startsWith(o, i)) ?? ch;
    i += op.length;
    tokens.push({
      type: "operator",
      value: op,
      line: startLine,
      column: startCol,
      offset: startOffset,
    });
  }

  tokens.push({ type: "eof", value: "", line, column: col(), offset: i });
  return { tokens, errors };
}

export interface LexError {
  line: number;
  column: number;
  message: string;
}

/** Tokens with comments removed — most analysis wants this view. */
export function codeTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== "comment");
}
