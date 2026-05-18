/**
 * Parse tool calls from web model text responses.
 *
 * Supports three formats (tried in order):
 * 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n```
 * 2. Bare JSON: {"tool":"...","parameters":{...}}
 * 3. XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 *
 * Also supports truncated JSON from streaming (fuzzy repair).
 */

export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallParseResult {
  success: boolean;
  toolCall?: ParsedToolCall;
  rawText?: string;
  error?: string;
  isTruncated?: boolean;
}

const MAX_PARAMETERS_LENGTH = 100_000;

/**
 * Remove invalid backslash escapes that models sometimes hallucinate
 * (e.g. \` \' \$ \#). Only JSON-legal escapes are preserved:
 *   \" \\ \/ \b \f \n \r \t \uXXXX
 */
function cleanInvalidJsonEscapes(raw: string): string {
  return raw.replace(/\\(?![\\\/bfnrtu"']|u[0-9a-fA-F]{4})/g, "");
}

const LOG_PREFIX = "[WebToolParser]";

function logParseAttempt(format: string, matched: boolean, details?: string): void {
  if (details) {
    console.log(`${LOG_PREFIX} ${format} match: ${matched ? "YES" : "NO"} - ${details}`);
  } else {
    console.log(`${LOG_PREFIX} ${format} match: ${matched ? "YES" : "NO"}`);
  }
}

function logError(format: string, error: string): void {
  console.warn(`${LOG_PREFIX} ${format} parse error: ${error}`);
}

const FENCED_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/i;

const BARE_JSON_REGEX = /\{\s*"?tool"?\s*:\s*"([^"]+)"\s*,\s*"?parameters"?\s*:\s*(\{[\s\S]*?\})\s*\}/i;

const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i;

export function extractToolCall(text: string): ToolCallParseResult {
  if (!text || text.length === 0) {
    return { success: false, error: "Empty input" };
  }

  const originalLength = text.length;
  const truncated = originalLength > 1000 ? text.slice(0, 1000) + "..." : text;
  console.log(`${LOG_PREFIX} Parsing tool call, input length=${originalLength}, preview="${truncated.replace(/\n/g, " ")}"`);

  const fenced = FENCED_REGEX.exec(text);
  if (fenced) {
    logParseAttempt("Fenced", true, `matched ${fenced[1].length} chars`);
    const result = parseToolJson(fenced[1]);
    if (result) {
      console.log(`${LOG_PREFIX} Fenced parse SUCCESS: tool=${result.tool}, paramCount=${Object.keys(result.parameters).length}`);
      return { success: true, toolCall: result, rawText: fenced[1] };
    }
    logError("Fenced", "parseToolJson returned null");
    return { success: false, error: "Fenced format parse failed", rawText: fenced[1] };
  }

  const bare = BARE_JSON_REGEX.exec(text);
  if (bare) {
    logParseAttempt("Bare JSON", true, `tool=${bare[1]}, params=${bare[2].length} chars`);
    try {
      let paramsRaw = bare[2];
      paramsRaw = paramsRaw.replace(/\\\\"/g, '"');
      const params = JSON.parse(paramsRaw);
      const result = { tool: bare[1], parameters: params };
      console.log(`${LOG_PREFIX} Bare JSON parse SUCCESS: tool=${result.tool}, paramCount=${Object.keys(result.parameters).length}`);
      return { success: true, toolCall: result, rawText: bare[0] };
    } catch (err) {
      logError("Bare JSON", `JSON.parse failed: ${err}`);
      // Retry with cleaned escapes — model may output invalid \` or \' etc.
      try {
        const cleaned = cleanInvalidJsonEscapes(bare[2]);
        const params = JSON.parse(cleaned);
        const result = { tool: bare[1], parameters: params };
        console.log(`${LOG_PREFIX} Bare JSON parse SUCCESS (after cleaning): tool=${result.tool}`);
        return { success: true, toolCall: result, rawText: bare[0] };
      } catch (retryErr) {
        return { success: false, error: `Bare JSON parse error: ${err}`, rawText: bare[0] };
      }
    }
  }

  const xml = XML_TOOL_REGEX.exec(text);
  if (xml) {
    logParseAttempt("XML", true, `matched ${xml[1].length} chars`);
    const result = parseToolJson(xml[1]);
    if (result) {
      console.log(`${LOG_PREFIX} XML parse SUCCESS: tool=${result.tool}, paramCount=${Object.keys(result.parameters).length}`);
      return { success: true, toolCall: result, rawText: xml[1] };
    }
    logError("XML", "parseToolJson returned null");
    return { success: false, error: "XML format parse failed", rawText: xml[1] };
  }

  const fuzzyResult = tryFuzzyParse(text);
  if (fuzzyResult.success) {
    console.log(`${LOG_PREFIX} Fuzzy parse SUCCESS: tool=${fuzzyResult.toolCall?.tool}, isTruncated=${fuzzyResult.isTruncated}`);
    return fuzzyResult;
  }

  logParseAttempt("All formats", false, `input="${truncated.replace(/\n/g, " ")}"`);
  return { success: false, error: "No valid tool call format found", rawText: text };
}

/**
 * Extract ALL tool calls from text, preserving their order of appearance.
 * Supports multiple fenced (```tool_json) and XML (<tool_call>) blocks.
 * Falls back to extractToolCall if no multiple matches found.
 */
export function extractAllToolCalls(text: string): ToolCallParseResult[] {
  if (!text || text.length === 0) return [];

  const candidates: Array<{ pos: number; raw: string }> = [];

  const FENCED_GLOBAL = /```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/gi;
  let m: RegExpExecArray | null;
  while ((m = FENCED_GLOBAL.exec(text)) !== null) {
    candidates.push({ pos: m.index, raw: m[1] });
  }

  const XML_GLOBAL = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
  while ((m = XML_GLOBAL.exec(text)) !== null) {
    candidates.push({ pos: m.index, raw: m[1] });
  }

  candidates.sort((a, b) => a.pos - b.pos);

  const results: ToolCallParseResult[] = [];
  for (const c of candidates) {
    const parsed = parseToolJson(c.raw);
    if (parsed) {
      results.push({ success: true, toolCall: parsed, rawText: c.raw });
    }
  }

  if (results.length === 0) {
    const single = extractToolCall(text);
    if (single.success) results.push(single);
  }

  // Ultra-broad fallback: scan every {…} block in the text for tool-like JSON
  if (results.length === 0 && text.length > 0) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") { continue; }
      const close = findClosingBracePosition(text.slice(i + 1));
      if (close === -1) { continue; }
      const block = text.slice(i, i + close + 2);
      if (!block.includes('"tool":') && !block.includes('"name":')) { continue; }
      try {
        const cleaned = cleanInvalidJsonEscapes(block);
        const obj = JSON.parse(cleaned);
        if (obj.tool && typeof obj.tool === "string") {
          console.log(`${LOG_PREFIX} Broad fallback SUCCESS: tool=${obj.tool}`);
          results.push({ success: true, toolCall: { tool: obj.tool, parameters: obj.parameters ?? {} }, rawText: block });
          break;
        }
        if (obj.name && typeof obj.name === "string") {
          console.log(`${LOG_PREFIX} Broad fallback SUCCESS: tool=${obj.name}`);
          results.push({ success: true, toolCall: { tool: obj.name, parameters: obj.arguments ?? {} }, rawText: block });
          break;
        }
      } catch { /* skip unparseable block */ }
    }
  }

  return results;
}

function tryFuzzyParse(text: string): ToolCallParseResult {
  const fuzzyPattern = /\{\s*"?tool"?\s*:\s*"([^"]+)"\s*,\s*"?parameters"?\s*:\s*\{([\s\S]*)/i;
  const match = fuzzyPattern.exec(text);

  if (!match) {
    return { success: false, error: "Fuzzy pattern no match" };
  }

  const toolName = match[1];
  const rawParams = match[2];

  if (rawParams.length > MAX_PARAMETERS_LENGTH) {
    logError("Fuzzy", `Parameters too long: ${rawParams.length} > ${MAX_PARAMETERS_LENGTH}`);
    return { success: false, error: `Parameters exceed max length ${MAX_PARAMETERS_LENGTH}` };
  }

  logParseAttempt("Fuzzy", true, `tool=${toolName}, rawParams=${rawParams.length} chars, inputEnds=${text.slice(-20).replace(/\n/g, " ")}`);

  let params: Record<string, unknown>;
  let isTruncated = false;

  const closeBraceIndex = findClosingBracePosition(rawParams);
  if (closeBraceIndex === -1) {
    logParseAttempt("Fuzzy", true, "No closing brace found - truncated JSON");
    isTruncated = true;
    return { success: false, error: "Truncated JSON - no closing brace", isTruncated: true };
  }

  const paramsJson = rawParams.slice(0, closeBraceIndex + 1);
  try {
    params = JSON.parse(paramsJson);
  } catch (err) {
    logError("Fuzzy", `JSON.parse failed: ${err}`);
    return { success: false, error: `Fuzzy JSON parse error: ${err}` };
  }

  return {
    success: true,
    toolCall: { tool: toolName, parameters: params },
    isTruncated,
  };
}

function findClosingBracePosition(str: string): number {
  let depth = 1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    let cleaned = raw.trim();

    const opens = (cleaned.match(/\{/g) || []).length;
    const closes = (cleaned.match(/\}/g) || []).length;
    if (opens > closes) {
      const missing = opens - closes;
      console.log(`${LOG_PREFIX} Auto-repair: adding ${missing} closing braces`);
      cleaned += "}".repeat(missing);
    }

    if (cleaned.length > MAX_PARAMETERS_LENGTH) {
      console.warn(`${LOG_PREFIX} parseToolJson: cleaned result too long (${cleaned.length}), truncating`);
      return null;
    }

    const obj = JSON.parse(cleaned);

    if (obj.tool && typeof obj.tool === "string") {
      return {
        tool: obj.tool,
        parameters: obj.parameters ?? {},
      };
    }

    if (obj.name && typeof obj.name === "string") {
      return {
        tool: obj.name,
        parameters: obj.arguments ?? {},
      };
    }

    console.warn(`${LOG_PREFIX} parseToolJson: no valid tool or name field found`);
    return null;
  } catch (err) {
    logError("parseToolJson", `${err}`);
    return null;
  }
}

export function hasToolCall(text: string): boolean {
  if (!text) return false;
  return FENCED_REGEX.test(text) || BARE_JSON_REGEX.test(text) || XML_TOOL_REGEX.test(text);
}

export function formatToolError(toolName: string, error: string, suggestion?: string): string {
  let msg = `工具调用失败\n工具名称: ${toolName}\n错误原因: ${error}`;
  if (suggestion) {
    msg += `\n建议: ${suggestion}`;
  }
  return msg;
}
