export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

const FENCED_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/;

const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/;

const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/;

const FUZZY_TOOL_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/;

export function extractToolCall(text: string): ParsedToolCall | null {
  const fenced = FENCED_REGEX.exec(text);
  if (fenced) {
    return parseToolJson(fenced[1]);
  }

  const bare = BARE_JSON_REGEX.exec(text);
  if (bare) {
    try {
      const params = JSON.parse(bare[2]);
      return { tool: bare[1], parameters: params };
    } catch {
      return null;
    }
  }

  const xml = XML_TOOL_REGEX.exec(text);
  if (xml) {
    return parseToolJson(xml[1]);
  }

  const fuzzyMatch = FUZZY_TOOL_REGEX.exec(text);
  if (fuzzyMatch) {
    const repaired = `{"tool":"${fuzzyMatch[1]}","parameters":{${fuzzyMatch[2]}}}`;
    const result = parseToolJson(repaired);
    if (result) {
      return result;
    }
  }

  return null;
}

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    let cleaned = raw.trim();
    const opens = (cleaned.match(/\{/g) || []).length;
    const closes = (cleaned.match(/\}/g) || []).length;
    if (opens > closes) {
      cleaned += "}".repeat(opens - closes);
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

    return null;
  } catch {
    return null;
  }
}

export function hasToolCall(text: string): boolean {
  return FENCED_REGEX.test(text) || BARE_JSON_REGEX.test(text) || XML_TOOL_REGEX.test(text);
}

export interface ToolCallValidation {
  isValid: boolean;
  errors: string[];
  repaired: boolean;
  repairedText?: string;
}

export function validateAndRepairToolCall(text: string): ToolCallValidation {
  const result: ToolCallValidation = {
    isValid: false,
    errors: [],
    repaired: false,
  };

  const parsed = extractToolCall(text);
  if (parsed) {
    result.isValid = true;
    return result;
  }

  const errors: string[] = [];
  let repaired = false;

  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  if (opens > closes) {
    errors.push(`Unbalanced braces: ${opens} opening, ${closes} closing`);
  }

  const hasToolKey = /"tool"\s*:/.test(text);
  const hasNameKey = /"name"\s*:/.test(text);
  const hasParamsKey = /"parameters"\s*:/.test(text) || /"arguments"\s*:/.test(text);

  if (!hasToolKey && !hasNameKey) {
    errors.push('Missing "tool" or "name" key');
  }
  if (!hasParamsKey) {
    errors.push('Missing "parameters" or "arguments" key');
  }

  if (errors.length > 0 && (hasToolKey || hasNameKey) && opens > closes) {
    const repairedText = text + "}".repeat(opens - closes);
    try {
      JSON.parse(repairedText);
      result.repaired = true;
      result.repairedText = repairedText;
      result.errors = [`Repaired: added ${opens - closes} closing brace(s)`];
      result.isValid = true;
    } catch {
      errors.push("Auto-repair failed: JSON still invalid after brace repair");
    }
  } else {
    result.errors = errors;
  }

  return result;
}

export function extractMultipleToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  const fencedMatches = text.matchAll(FENCED_REGEX);
  for (const match of fencedMatches) {
    const parsed = parseToolJson(match[1]);
    if (parsed) {
      calls.push(parsed);
    }
  }

  const xmlMatches = text.matchAll(XML_TOOL_REGEX);
  for (const match of xmlMatches) {
    const parsed = parseToolJson(match[1]);
    if (parsed) {
      calls.push(parsed);
    }
  }

  const bareMatches = text.matchAll(BARE_JSON_REGEX);
  for (const match of bareMatches) {
    try {
      const params = JSON.parse(match[2]);
      calls.push({ tool: match[1], parameters: params });
    } catch {}
  }

  return calls;
}

export function stripToolCallFromText(text: string): string {
  let stripped = text.replace(FENCED_REGEX, "");
  stripped = stripped.replace(XML_TOOL_REGEX, "");
  stripped = stripped.replace(BARE_JSON_REGEX, "");
  return stripped.trim();
}
