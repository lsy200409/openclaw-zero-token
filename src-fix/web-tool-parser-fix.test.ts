import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractToolCall,
  hasToolCall,
  validateAndRepairToolCall,
  extractMultipleToolCalls,
  stripToolCallFromText,
  type ParsedToolCall,
} from "./web-tool-parser-fix.js";

describe("web-tool-parser-fix", () => {
  describe("extractToolCall", () => {
    it("should extract tool call from fenced format", () => {
      const text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```';
      const result = extractToolCall(text);
      expect(result).toEqual({
        tool: "exec",
        parameters: { command: "ls" },
      });
    });

    it("should extract tool call from bare JSON format", () => {
      const text = '{"tool":"read","parameters":{"path":"/etc/passwd"}}';
      const result = extractToolCall(text);
      expect(result).toEqual({
        tool: "read",
        parameters: { path: "/etc/passwd" },
      });
    });

    it("should extract tool call from XML format", () => {
      const text = '<tool_call id="123" name="write">{"path":"/tmp/test","content":"hello"}</tool_call>';
      const result = extractToolCall(text);
      expect(result?.tool).toBe("write");
      expect(result?.parameters).toHaveProperty("path");
    });

    it("should repair truncated JSON", () => {
      const text = '{"tool":"exec","parameters":{"command":"ls"';
      const result = extractToolCall(text);
      expect(result).toEqual({
        tool: "exec",
        parameters: { command: "ls" },
      });
    });

    it("should handle OpenAI format with name and arguments", () => {
      const text = '{"name":"bash","arguments":{"cmd":"echo hi"}}';
      const result = extractToolCall(text);
      expect(result).toEqual({
        tool: "bash",
        parameters: { cmd: "echo hi" },
      });
    });

    it("should return null for invalid input", () => {
      expect(extractToolCall("")).toBeNull();
      expect(extractToolCall("not a tool call")).toBeNull();
      expect(extractToolCall('{"type":"text"}')).toBeNull();
    });
  });

  describe("hasToolCall", () => {
    it("should detect fenced tool call", () => {
      const text = '```tool_json\n{"tool":"exec"}\n```';
      expect(hasToolCall(text)).toBe(true);
    });

    it("should detect bare JSON tool call", () => {
      const text = '{"tool":"read","parameters":{}}';
      expect(hasToolCall(text)).toBe(true);
    });

    it("should detect XML tool call", () => {
      const text = "<tool_call>test</tool_call>";
      expect(hasToolCall(text)).toBe(true);
    });

    it("should return false for plain text", () => {
      expect(hasToolCall("hello world")).toBe(false);
    });
  });

  describe("validateAndRepairToolCall", () => {
    it("should validate correct tool call", () => {
      const text = '{"tool":"exec","parameters":{"command":"ls"}}';
      const result = validateAndRepairToolCall(text);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.repaired).toBe(false);
    });

    it("should detect missing tool key", () => {
      const text = '{"parameters":{}}';
      const result = validateAndRepairToolCall(text);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing "tool" or "name" key');
    });

    it("should repair unbalanced braces", () => {
      const text = '{"tool":"exec","parameters":{"command":"ls"';
      const result = validateAndRepairToolCall(text);
      expect(result.repaired).toBe(true);
      expect(result.isValid).toBe(true);
    });
  });

  describe("extractMultipleToolCalls", () => {
    it("should extract multiple tool calls", () => {
      const text = `
        First tool: ```tool_json\n{"tool":"read","parameters":{"path":"/a"}}\n```
        Second tool: <tool_call id="2" name="write">{"path":"/b","content":"x"}</tool_call>
        Third tool: {"tool":"exec","parameters":{"cmd":"ls"}}
      `;
      const results = extractMultipleToolCalls(text);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("stripToolCallFromText", () => {
    it("should remove fenced tool calls", () => {
      const text = 'Hello ```tool_json\n{"tool":"exec"}\n``` World';
      const result = stripToolCallFromText(text);
      expect(result).not.toContain("tool_json");
      expect(result).toContain("Hello");
      expect(result).toContain("World");
    });
  });
});
