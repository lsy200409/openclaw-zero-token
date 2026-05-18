/**
 * Web Stream Middleware — unified input/output processing for all web models.
 *
 * Input:  extract last user message → strip metadata → inject tool prompt
 * Output: parse tool calls from response → emit ToolCall events
 *
 * This middleware replaces the per-stream prompt manipulation that was
 * previously duplicated across 13 stream files.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import { extractAllToolCalls } from "./web-tool-parser.js";
import { shouldInjectToolPrompt, getToolPrompt } from "./web-tool-prompt.js";

const DEFAULT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let subSessionCounter = 0;

function nextSubSessionKey(parentKey: string): string {
  subSessionCounter += 1;
  return `${parentKey}:tool-round-${subSessionCounter}`;
}

const MEMORY_WORKSPACE = process.env.HOME
  ? `${process.env.HOME}/.openclaw-zero/workspace`
  : "/tmp/openclaw-workspace";

/**
 * Known tool parameter names for each registered web tool.
 * Any extra params the model hallucinates (e.g. requires_approval)
 * are stripped to avoid tool schema validation failures.
 */
const KNOWN_TOOL_PARAMS: Record<string, Set<string>> = {
  web_search: new Set(["query"]),
  web_fetch: new Set(["url"]),
  exec: new Set(["command"]),
  read: new Set(["path"]),
  write: new Set(["path", "content"]),
  message: new Set(["text", "channel"]),
  memory_read: new Set(["query"]),
  memory_write: new Set(["key", "value"]),
};

function stripUnknownParams(tool: string, params: Record<string, string>): Record<string, string> {
  const allowed = KNOWN_TOOL_PARAMS[tool];
  if (!allowed) {
    return params;
  }
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(params)) {
    if (allowed.has(key)) {
      cleaned[key] = params[key];
    }
  }
  return cleaned;
}

/**
 * Classify a tool result text into an error category with guidance.
 */
function classifyToolErrorWithGuidance(resultText: string): {
  hasError: boolean;
  guidance: string;
} {
  const lower = resultText.toLowerCase();
  const hasError =
    lower.includes("error") ||
    lower.includes("fail") ||
    lower.includes("exception") ||
    lower.includes("失败") ||
    lower.includes("错误") ||
    lower.includes("not found") ||
    lower.includes("denied") ||
    lower.includes("permission") ||
    lower.includes("timeout") ||
    lower.includes("exit code") ||
    lower.includes("traceback") ||
    lower.includes("eacces") ||
    lower.includes("enoent") ||
    lower.includes("eisdir") ||
    lower.includes("syntaxerror") ||
    lower.includes("typeerror") ||
    lower.includes("referenceerror");

  if (!hasError) {
    return { hasError: false, guidance: "" };
  }

  let guidance = "";

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    guidance = "\n\n⏱ 命令执行超时。请尝试：1) 简化命令 2) 拆分为多个小步骤 3) 使用后台运行 (&)";
  } else if (lower.includes("enoent") || lower.includes("not found") || lower.includes("找不到")) {
    guidance =
      "\n\n📂 文件或命令不存在。请尝试：1) 检查路径拼写 2) 使用 read 或 exec(ls) 查看目录内容 3) 确认软件已安装";
  } else if (
    lower.includes("eacces") ||
    lower.includes("permission") ||
    lower.includes("denied") ||
    lower.includes("权限") ||
    lower.includes("拒绝")
  ) {
    guidance = "\n\n🔒 权限不足。请尝试：1) 使用其他路径 2) 用 ls -la 查看权限 3) 选择可访问的目录";
  } else if (lower.includes("eisdir") || lower.includes("is a directory")) {
    guidance = "\n\n📁 指定的是目录而非文件。请添加文件名或使用 ls 列出目录内容";
  } else if (
    lower.includes("syntaxerror") ||
    lower.includes("typeerror") ||
    lower.includes("referenceerror")
  ) {
    guidance = "\n\n🐛 脚本/代码执行错误。请尝试：1) 检查代码语法 2) 查看错误行号 3) 修改后重试";
  } else if (
    lower.includes("exit code") ||
    lower.includes("exit code 1") ||
    lower.includes("exit code 2")
  ) {
    guidance =
      "\n\n⚠️ 命令以非零退出码结束。请尝试：1) 单独执行各步骤定位问题 2) 检查输入参数 3) 查阅相关文档";
  } else if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) {
    guidance = "\n\n🔄 请求频率过高被限流。请等待几秒后重试";
  } else {
    guidance =
      "\n\n❓ 工具调用遇到未知错误。请尝试：1) 换一种方式实现 2) 拆分为更小的步骤 3) 使用 read 查阅相关文档或手册";
  }

  return { hasError: true, guidance };
}

function resolveMemoryTool(
  tool: string,
  params: Record<string, string>,
): { name: string; params: Record<string, string> } {
  if (tool === "memory_read") {
    const query = params.query || "";
    const path = query ? `${MEMORY_WORKSPACE}/MEMORY.md` : `${MEMORY_WORKSPACE}/MEMORY.md`;
    return { name: "read", params: { path } };
  }
  if (tool === "memory_write") {
    const key = params.key || "memory";
    const value = params.value || "";
    const content = `\n## ${key}\n${value}\n\n`;
    return {
      name: "write",
      params: { path: `${MEMORY_WORKSPACE}/MEMORY.md`, content },
    };
  }
  return { name: tool, params };
}

/**
 * Quick keyword check: does this message likely need tool use?
 * Only inject tool prompt when keywords suggest a tool action,
 * keeping normal chat messages short to reduce ban risk.
 */
function needsToolInjection(message: string): boolean {
  const lower = message.toLowerCase();
  // Always inject tools for tool result feedback messages
  if (message.includes(" returned:") || message.includes(" returned ")) {
    return true;
  }
  const keywords = [
    // ── File operations ──
    "文件",
    "file",
    "read",
    "write",
    "创建",
    "写入",
    "读取",
    "打开",
    "保存",
    "桌面",
    "desktop",
    "目录",
    "directory",
    "folder",
    "文件夹",
    "编辑",
    "edit",
    "修改",
    "modify",
    "删除",
    "delete",
    "remove",
    "复制",
    "copy",
    "移动",
    "move",
    "重命名",
    "rename",
    "追加",
    "append",
    "内容",
    "content",
    "文本",
    "text",
    "代码",
    "code",
    "脚本",
    "script",
    "配置",
    "config",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "env",
    "路径",
    "path",
    "地址",
    "地址栏",
    // ── Command execution ──
    "执行",
    "运行",
    "命令",
    "command",
    "run",
    "exec",
    "terminal",
    "终端",
    "shell",
    "bash",
    "zsh",
    "sh",
    "cmd",
    "powershell",
    "编译",
    "compile",
    "构建",
    "build",
    "部署",
    "deploy",
    "启动",
    "start",
    "停止",
    "stop",
    "重启",
    "restart",
    "进程",
    "process",
    "服务",
    "service",
    "守护进程",
    "daemon",
    // ── Web operations ──
    "搜索",
    "search",
    "查找",
    "find",
    "查询",
    "query",
    "fetch",
    "抓取",
    "爬取",
    "crawl",
    "网页",
    "web",
    "page",
    "url",
    "http",
    "https",
    "api",
    "接口",
    "天气",
    "weather",
    "新闻",
    "news",
    "百科",
    "wiki",
    "维基",
    "打开网站",
    "访问",
    "visit",
    "browse",
    // ── Message / Notification ──
    "发送",
    "send",
    "消息",
    "message",
    "通知",
    "notify",
    "转发",
    "forward",
    "广播",
    "broadcast",
    "推送",
    "push",
    // ── System / Info ──
    "查看",
    "check",
    "look",
    "看看",
    "show",
    "显示",
    "display",
    "列出",
    "list",
    "ls",
    "统计",
    "统计",
    "info",
    "信息",
    "状态",
    "status",
    "监控",
    "monitor",
    // ── Download / Install / Update ──
    "下载",
    "download",
    "安装",
    "install",
    "更新",
    "update",
    "升级",
    "upgrade",
    "卸载",
    "uninstall",
    // ── General tool hints ──
    "帮我",
    "help me",
    "能不能",
    "自动化",
    "auto",
    "测试",
    "test",
    "automation",
    "定时",
    "scheduled",
    "cron",
    // ── Problem solving / Error recovery ──
    "修复",
    "fix",
    "解决",
    "resolve",
    "排查",
    "troubleshoot",
    "诊断",
    "diagnose",
    "调试",
    "debug",
    // ── Tool call context（在无注入路径中检测工具调用上下文）──
    "tool_json",
    "tool_call",
    "工具调用",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Wrap a web stream function with tool calling middleware.
 * - Rewrites context: only sends last user message + optional tool prompt
 * - Parses response: extracts tool_call JSON → emits ToolCall events
 */
export function wrapWithToolCalling(streamFn: StreamFn, api: string): StreamFn {
  return (model, context, options) => {
    // --- Input rewriting ---
    const messages = context.messages || [];

    // Collect ALL tool results after the last assistant message.
    // When pi-ai processes multiple tool calls in one round (e.g. read + exec),
    // it pushes multiple toolResult messages to context. We must combine all of
    // them into a single feedback prompt so the web model sees every result.
    const toolResultsSinceLastAssistant: Array<{
      toolName?: string;
      content?: Array<{ type: string; text?: string }>;
    }> = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "toolResult") {
        toolResultsSinceLastAssistant.unshift(msg);
      } else if (msg?.role === "assistant") {
        break;
      }
    }

    if (toolResultsSinceLastAssistant.length > 0) {
      let combinedText = "";
      let hasError = false;
      let errorGuidance = "";

      for (const tr of toolResultsSinceLastAssistant) {
        let resultText = "";
        const content = (tr as unknown as { content?: Array<{ type: string; text?: string }> })
          .content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text" && part.text) {
              resultText += part.text;
            }
          }
        }

        const toolName = (tr as unknown as { toolName?: string }).toolName || "unknown";
        if (toolResultsSinceLastAssistant.length > 1) {
          combinedText += `Tool ${toolName} returned: ${resultText}\n\n`;
        } else {
          combinedText = `Tool ${toolName} returned: ${resultText}`;
        }

        if (!hasError) {
          const classified = classifyToolErrorWithGuidance(resultText);
          if (classified.hasError) {
            hasError = true;
            errorGuidance = classified.guidance;
          }
        }
      }

      // Include the original user request so the web model remembers the task
      // after multiple tool rounds. Without it, the model may not know what to do next.
      // Scan backwards from the most recent messages to find the LAST user message
      // (the one that triggered this tool chain), not the first message in history.
      const originalRequest = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === "user") {
            const text =
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? (msg.content as TextContent[])
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("")
                  : "";
            // Skip feedback prompt messages injected by the system
            if (text.startsWith("Tool ") && text.includes(" returned:")) {
              continue;
            }
            if (text.length > 0) {
              return text;
            }
          }
        }
        return "";
      })();

      const subSessionKey = nextSubSessionKey(
        (context as unknown as { sessionKey?: string }).sessionKey || "default",
      );

      const feedbackPrompt = `${combinedText}${errorGuidance}

Original request: ${originalRequest}

CRITICAL: If the task is NOT COMPLETE, you MUST call another tool NOW. Reply with ONLY the tool_json block, nothing else. Example: \`\`\`tool_json\n{"tool":"exec","parameters":{"command":"next command"}}\n\`\`\``;

      const hasAgentTools = (context.tools?.length ?? 0) > 0;
      const injectTools = shouldInjectToolPrompt(api) && hasAgentTools;
      const prompt = injectTools ? getToolPrompt(api) + feedbackPrompt : feedbackPrompt;

      const feedbackContext = Object.assign({}, context, {
        messages: [{ role: "user" as const, content: prompt }],
        tools: context.tools,
        systemPrompt: "",
        subSessionKey,
      });
      console.log(
        `[WebStreamMiddleware] FEEDBACK subSession=${subSessionKey} injectTools=${injectTools}, promptLen=${prompt.length}`,
      );

      // Wrap feedback stream with tool calling support
      const originalStreamOrPromise = streamFn(model, feedbackContext, options);
      const wrappedStream = createAssistantMessageEventStream();

      const processFeedbackEvents = async () => {
        try {
          const originalStream = await Promise.resolve(originalStreamOrPromise);
          let accumulatedText = "";

          for await (const event of originalStream) {
            if (event.type === "done") {
              const finalMsg = event.message;
              if (finalMsg && Array.isArray(finalMsg.content)) {
                for (const part of finalMsg.content) {
                  if (part.type === "text" && part.text) {
                    accumulatedText += part.text;
                  }
                }
              }

              const toolCalls = extractAllToolCalls(accumulatedText);

              if (toolCalls.length > 0) {
                const toolCallParts: ToolCall[] = [];

                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i];
                  if (!tc.toolCall) {
                    continue;
                  }

                  // Strip unknown params that may confuse tool schema validation
                  const safeParams = stripUnknownParams(
                    tc.toolCall.tool,
                    (tc.toolCall.parameters || {}) as Record<string, string>,
                  );

                  const toolId = `web_tool_${Date.now()}_${i}`;
                  const resolved = resolveMemoryTool(tc.toolCall.tool, safeParams);
                  console.log(
                    `[WebStreamMiddleware] FEEDBACK TOOL DETECTED[${i + 1}/${toolCalls.length}]: ${tc.toolCall.tool}${resolved.name !== tc.toolCall.tool ? ` → ${resolved.name}` : ""}`,
                  );

                  const toolCallPart: ToolCall = {
                    type: "toolCall",
                    id: toolId,
                    name: resolved.name,
                    arguments: resolved.params,
                  };
                  toolCallParts.push(toolCallPart);

                  const partialToolMsg: AssistantMessage = {
                    role: "assistant",
                    content: [...toolCallParts],
                    stopReason: "toolUse",
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage: finalMsg?.usage ?? DEFAULT_USAGE,
                    timestamp: Date.now(),
                  };

                  wrappedStream.push({
                    type: "toolcall_start",
                    contentIndex: i,
                    partial: partialToolMsg,
                  });
                  wrappedStream.push({
                    type: "toolcall_end",
                    contentIndex: i,
                    toolCall: toolCallPart,
                    partial: partialToolMsg,
                  });
                }

                const finalToolMsg: AssistantMessage = {
                  role: "assistant",
                  content: toolCallParts,
                  stopReason: "toolUse",
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  usage: finalMsg?.usage ?? DEFAULT_USAGE,
                  timestamp: Date.now(),
                };
                wrappedStream.push({
                  type: "done",
                  reason: "toolUse" as const,
                  message: finalToolMsg,
                });
                wrappedStream.end();
                return;
              }

              wrappedStream.push({ type: "done", reason: "stop" as const, message: finalMsg! });
              wrappedStream.end();
              return;
            } else {
              wrappedStream.push(event);
            }
          }
        } catch (err) {
          console.error(`[WebStreamMiddleware] FEEDBACK error: ${err}`);
          const errorMsg: AssistantMessage = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: DEFAULT_USAGE,
            timestamp: Date.now(),
          };
          wrappedStream.push({ type: "done", reason: "stop" as const, message: errorMsg });
        } finally {
          wrappedStream.end();
        }
      };

      queueMicrotask(() => void processFeedbackEvents());
      return wrappedStream;
    }

    // Extract just the last user message (web models can't handle full context)
    let userMessage = "";
    const lastUserMsg = [...messages].toReversed().find((m) => m.role === "user");
    if (lastUserMsg) {
      if (typeof lastUserMsg.content === "string") {
        userMessage = lastUserMsg.content;
      } else if (Array.isArray(lastUserMsg.content)) {
        userMessage = (lastUserMsg.content as TextContent[])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
    }

    // Strip OpenClaw metadata
    userMessage = stripInboundMeta(userMessage);

    if (!userMessage) {
      return streamFn(model, context, options);
    }

    // Only inject tool prompt when the message likely needs tool use.
    // This reduces ban risk by keeping most messages short and natural.
    const hasAgentTools = (context.tools?.length ?? 0) > 0;
    const injectTools =
      shouldInjectToolPrompt(api) && hasAgentTools && needsToolInjection(userMessage);

    // Build the prompt: tool prompt (if applicable) + user message
    const prompt = injectTools ? getToolPrompt(api) + userMessage : userMessage;

    console.log(
      `[WebStreamMiddleware] api=${api} injectTools=${injectTools} promptLen=${prompt.length} userMsgLen=${userMessage.length}`,
    );

    // Create modified context with just the user message.
    // Spread the original context to preserve the full type, then override.
    const modifiedContext = Object.assign({}, context, {
      messages: [{ role: "user" as const, content: prompt }],
      tools: [] as typeof context.tools,
      systemPrompt: "",
    });

    if (!injectTools) {
      // Pass through with cleaned context, but still detect tool calls post-hoc.
      // The model may have learned the tool_json format from previous rounds and
      // output it unprompted — we still want to capture those invocations.
      const passThroughStreamOrPromise = streamFn(model, modifiedContext, options);
      const passWrapped = createAssistantMessageEventStream();

      const processPassThrough = async () => {
        console.log(`[WebStreamMiddleware] pass-through STARTED for api=${api}`);
        try {
          const originalStream = await Promise.resolve(passThroughStreamOrPromise);
          let accumulatedText = "";

          for await (const event of originalStream) {
            if (event.type === "done") {
              const finalMsg = event.message;

              // Priority 1: Stream function already parsed tool calls
              // (e.g. deepseek-web-stream parsed <tool_call> XML into type: "toolCall" blocks)
              const preParsedToolCalls =
                finalMsg?.content?.filter((p): p is ToolCall => p.type === "toolCall") ?? [];
              if (preParsedToolCalls.length > 0) {
                console.log(
                  `[WebStreamMiddleware] Using pre-parsed tool calls (stream fn already parsed ${preParsedToolCalls.length}): ${preParsedToolCalls.map((t) => t.name).join(", ")}`,
                );
                passWrapped.push(event);
                passWrapped.end();
                return;
              }

              if (finalMsg && Array.isArray(finalMsg.content)) {
                for (const part of finalMsg.content) {
                  if (part.type === "text" && part.text) {
                    accumulatedText += part.text;
                  }
                }
              }

              // Priority 2: regex-parse tool calls from accumulated text
              const toolCalls = extractAllToolCalls(accumulatedText);
              console.log(
                `[WebStreamMiddleware] pass-through done: textLen=${accumulatedText.length} toolCalls=${toolCalls.length} preview="${accumulatedText.slice(0, 120).replace(/\n/g, "\\n")}"`,
              );

              if (toolCalls.length > 0) {
                const toolCallParts: ToolCall[] = [];

                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i];
                  if (!tc.toolCall) {
                    continue;
                  }

                  const safeParams = stripUnknownParams(
                    tc.toolCall.tool,
                    (tc.toolCall.parameters || {}) as Record<string, string>,
                  );

                  const toolId = `web_tool_${Date.now()}_${i}`;
                  const resolved = resolveMemoryTool(tc.toolCall.tool, safeParams);
                  console.log(
                    `[WebStreamMiddleware] DETECTED (no-inject)[${i + 1}/${toolCalls.length}]: ${tc.toolCall.tool}${resolved.name !== tc.toolCall.tool ? ` → ${resolved.name}` : ""}`,
                  );

                  const toolCallPart: ToolCall = {
                    type: "toolCall",
                    id: toolId,
                    name: resolved.name,
                    arguments: resolved.params,
                  };
                  toolCallParts.push(toolCallPart);

                  const partialToolMsg: AssistantMessage = {
                    role: "assistant",
                    content: [...toolCallParts],
                    stopReason: "toolUse",
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage: finalMsg?.usage ?? DEFAULT_USAGE,
                    timestamp: Date.now(),
                  };

                  passWrapped.push({
                    type: "toolcall_start",
                    contentIndex: i,
                    partial: partialToolMsg,
                  });
                  passWrapped.push({
                    type: "toolcall_end",
                    contentIndex: i,
                    toolCall: toolCallPart,
                    partial: partialToolMsg,
                  });
                }

                const finalToolMsg: AssistantMessage = {
                  role: "assistant",
                  content: toolCallParts,
                  stopReason: "toolUse",
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  usage: finalMsg?.usage ?? DEFAULT_USAGE,
                  timestamp: Date.now(),
                };
                passWrapped.push({
                  type: "done",
                  reason: "toolUse" as const,
                  message: finalToolMsg,
                });
                passWrapped.end();
                return;
              }

              passWrapped.push(event);
            } else {
              passWrapped.push(event);
            }
          }
        } catch (err) {
          console.error(`[WebStreamMiddleware] pass-through error: ${err}`);
        } finally {
          passWrapped.end();
        }
      };

      queueMicrotask(() => void processPassThrough());
      return passWrapped;
    }

    // --- With tool calling: wrap the output stream ---
    const originalStreamOrPromise = streamFn(model, modifiedContext, options);
    const wrappedStream = createAssistantMessageEventStream();

    // Process events from original stream
    const processEvents = async () => {
      try {
        const originalStream = await Promise.resolve(originalStreamOrPromise);
        let accumulatedText = "";
        let toolCallEmitted = false;

        for await (const event of originalStream) {
          // On stream completion, check final message for tool calls
          if (event.type === "done") {
            // Use final message content (already deduplicated by stream parser)
            // instead of accumulating text_delta events which may contain duplicates
            const finalMsg = event.message;
            if (finalMsg && Array.isArray(finalMsg.content)) {
              for (const part of finalMsg.content) {
                if (part.type === "text" && part.text) {
                  accumulatedText += part.text;
                }
              }
            }

            const toolCalls = extractAllToolCalls(accumulatedText);

            if (toolCalls.length > 0) {
              toolCallEmitted = true;
              const toolCallParts: ToolCall[] = [];

              for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                if (!tc.toolCall) {
                  continue;
                }

                const safeParams = stripUnknownParams(
                  tc.toolCall.tool,
                  (tc.toolCall.parameters || {}) as Record<string, string>,
                );

                const toolId = `web_tool_${Date.now()}_${i}`;
                const resolved = resolveMemoryTool(tc.toolCall.tool, safeParams);
                console.log(
                  `[WebStreamMiddleware] TOOL DETECTED[${i + 1}/${toolCalls.length}]: ${tc.toolCall.tool}${resolved.name !== tc.toolCall.tool ? ` → ${resolved.name}` : ""}`,
                );

                const toolCallPart: ToolCall = {
                  type: "toolCall",
                  id: toolId,
                  name: resolved.name,
                  arguments: resolved.params,
                };
                toolCallParts.push(toolCallPart);

                const partialToolMsg: AssistantMessage = {
                  role: "assistant",
                  content: [...toolCallParts],
                  stopReason: "toolUse",
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  usage: finalMsg?.usage ?? DEFAULT_USAGE,
                  timestamp: Date.now(),
                };

                wrappedStream.push({
                  type: "toolcall_start",
                  contentIndex: i,
                  partial: partialToolMsg,
                });
                wrappedStream.push({
                  type: "toolcall_end",
                  contentIndex: i,
                  toolCall: toolCallPart,
                  partial: partialToolMsg,
                });
              }

              const finalToolMsg: AssistantMessage = {
                role: "assistant",
                content: toolCallParts,
                stopReason: "toolUse",
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: finalMsg?.usage ?? DEFAULT_USAGE,
                timestamp: Date.now(),
              };
              wrappedStream.push({
                type: "done",
                reason: "toolUse",
                message: finalToolMsg,
              });
            } else {
              // No tool call — forward the done event as-is
              wrappedStream.push(event);
            }
          } else if (!toolCallEmitted) {
            // Forward non-done events as-is
            wrappedStream.push(event);
          }
        }

        // Check if this was a tool result feedback that resulted in no further tool calls
        const lastMsg = context.messages?.[context.messages.length - 1];
        if (lastMsg?.role === "toolResult" && !toolCallEmitted) {
          console.log(
            "[WebStreamMiddleware] Tool result feedback produced no more tool calls - stopping loop",
          );
        }
      } catch (err) {
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: DEFAULT_USAGE,
            timestamp: Date.now(),
          },
        } as AssistantMessageEvent);
      } finally {
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void processEvents());
    return wrappedStream;
  };
}
