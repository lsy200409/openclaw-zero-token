/**
 * Tool Call Enhancements for Zero Token Web Providers
 *
 * Adds structured error handling, retry with backoff, and loop detection
 * to the web-stream-middleware tool calling pipeline.
 */

import type { StreamFn, AssistantMessage, ToolCall, TextContent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// ── Module A: Structured Error Format ───────────────────────────────────

interface ToolError {
  success: false;
  tool: string;
  error_type: "TIMEOUT" | "PERMISSION_DENIED" | "NOT_FOUND" | "RATE_LIMIT" | "SERVER_ERROR" | "INVALID_ARGUMENT" | "UNKNOWN";
  error_message: string;
  is_retryable: boolean;
  suggestion?: string;
}

function classifyToolError(err: Error): { error_type: ToolError["error_type"]; is_retryable: boolean; suggestion?: string } {
  const msg = err.message.toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("timed out")) {
    return { error_type: "TIMEOUT", is_retryable: true, suggestion: "Please retry with a simpler or shorter request" };
  }
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many")) {
    return { error_type: "RATE_LIMIT", is_retryable: true, suggestion: "Please wait before retrying" };
  }
  if (msg.includes("enoent") || msg.includes("not found") || msg.includes("404")) {
    return { error_type: "NOT_FOUND", is_retryable: false, suggestion: "Please check the path exists" };
  }
  if (msg.includes("permission") || msg.includes("eacces") || msg.includes("403")) {
    return { error_type: "PERMISSION_DENIED", is_retryable: false, suggestion: "Please use a different path or tool" };
  }
  if (msg.includes("eisdir") || msg.includes("is a directory")) {
    return { error_type: "INVALID_ARGUMENT", is_retryable: false, suggestion: "Please specify a file, not a directory" };
  }
  return { error_type: "UNKNOWN", is_retryable: false, suggestion: "Please try a different approach" };
}

export function formatToolError(toolName: string, err: Error): string {
  const cl = classifyToolError(err);
  const error: ToolError = { success: false, tool: toolName, ...cl, error_message: err.message };
  return JSON.stringify(error);
}

// ── Module B: Retry with Backoff ────────────────────────────────────────

export async function wrapToolExecution(
  toolName: string,
  executeFn: () => Promise<string>,
  maxRetries = 2,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeFn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const cl = classifyToolError(lastErr);
      if (!cl.is_retryable || attempt >= maxRetries) {
        break;
      }
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return formatToolError(toolName, lastErr!);
}

// ── Module D: Loop Detection ────────────────────────────────────────────

const actionWindow = new Map<string, number[]>();
const LOOP_WINDOW_SIZE = 5;
const MAX_DUPLICATE_COUNT = 2;

function fingerprint(toolName: string, params: Record<string, unknown>): string {
  return `${toolName}::${JSON.stringify(params, Object.keys(params).sort())}`;
}

export function detectLoop(toolName: string, params: Record<string, unknown>): boolean {
  const fp = fingerprint(toolName, params);
  const now = Date.now();
  const timestamps = actionWindow.get(fp) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  if (recent.length >= MAX_DUPLICATE_COUNT) {
    return true;
  }
  recent.push(now);
  actionWindow.set(fp, recent);
  // Evict old entries
  if (actionWindow.size > LOOP_WINDOW_SIZE) {
    const oldestKey = actionWindow.keys().next().value;
    if (oldestKey !== undefined) actionWindow.delete(oldestKey);
  }
  return false;
}

export function resetLoopDetection(): void {
  actionWindow.clear();
}

// ── Module E: Completeness Report ───────────────────────────────────────

const toolFailures: Array<{ tool: string; error: string; ts: number }> = [];

export function recordToolFailure(toolName: string, result: string): void {
  toolFailures.push({ tool: toolName, error: result, ts: Date.now() });
}

export function resetFailureLog(): void {
  toolFailures.length = 0;
}

export function buildCompletenessReport(): string {
  if (toolFailures.length === 0) return "";
  const seen = new Set<string>();
  const lines = ["\n\n## 信息完整性报告", "以下数据未能成功获取:"];
  for (const entry of toolFailures) {
    const key = `${entry.tool}:${entry.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let msg = entry.error;
    try {
      const parsed = JSON.parse(entry.error);
      msg = parsed.error_message || entry.error;
    } catch {}
    lines.push(`- [${entry.tool}]: ${msg}`);
  }
  return lines.join("\n");
}

export { ToolError };
