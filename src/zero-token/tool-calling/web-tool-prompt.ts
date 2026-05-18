/**
 * Per-model tool calling prompt templates.
 */

/* --- Core Tool Templates (brief, inline) --- */

const CORE_TOOLS_EN = `## Core Tools
### exec — Run shell commands
\`\`\`tool_json
{"tool":"exec","parameters":{"command":"ls -la workspace/"}}
\`\`\`

### read — Read file contents
\`\`\`tool_json
{"tool":"read","parameters":{"path":"workspace/MEMORY.md"}}
\`\`\`

### write — Write content to files (creates/overwrites)
\`\`\`tool_json
{"tool":"write","parameters":{"path":"workspace/test.txt","content":"hello"}}
\`\`\`

## Web Search
Use your OWN built-in web search capability when you need current information. Do NOT use a "web_search" tool.

## Other Tools
- memory_read: Query saved memories (by keyword or full text)
- memory_write: Save key-value memories (KV mode, update/append by key)
- sessions_spawn: Delegate tasks to other platform models (creates isolated sub-session)
- agents_list: List available sub-agents
- web_fetch: Fetch content from URLs (fallback, prefer built-in search)

Full documentation: workspace/TOOLS_REFERENCE.md
Each skill has docs at: workspace/skills/{skill-name}/SKILL.md
Worker docs at: workspace/{platform-name}/WORKER.md

Use \`ls workspace/\` to explore. Read docs with \`read\` when needed.`;

const CORE_TOOLS_CN = `## 核心工具
### exec — 执行 shell 命令
\`\`\`tool_json
{"tool":"exec","parameters":{"command":"ls -la workspace/"}}
\`\`\`

### read — 读取文件内容
\`\`\`tool_json
{"tool":"read","parameters":{"path":"workspace/MEMORY.md"}}
\`\`\`

### write — 写入文件（创建/覆盖）
\`\`\`tool_json
{"tool":"write","parameters":{"path":"workspace/test.txt","content":"hello"}}
\`\`\`

## 联网搜索
当你需要最新信息时，使用你自身内置的联网搜索能力。不需要调用任何搜索工具。

## 其他工具
- memory_read: 查询已保存的记忆（按关键词或全文搜索）
- memory_write: 存储记忆（KV 模式，按 key 追加/更新）
- sessions_spawn: 创建子会话，委托任务给其他平台模型运行（独立会话隔离）
- agents_list: 列出可用的子智能体列表
- web_fetch: 获取 URL 内容（备选，优先用内置搜索）

完整文档: workspace/TOOLS_REFERENCE.md
各 Skill 文档: workspace/skills/{skill名}/SKILL.md
Worker 文档: workspace/{平台名}/WORKER.md

用 \`ls workspace/\` 浏览工作区。需要时用 \`read\` 读取文档。`;

const FORMAT_RULE = `## Output Format - MANDATORY
- To call a tool: \`\`\`tool_json\n{"tool":"name","parameters":{...}}\n\`\`\`
- NEVER use XML tags (<invoke>, <function_calls>, etc.)
- NO extra text around the tool_json block
- No tool needed? Reply with text only.`;

/* --- Templates --- */

const EN_TEMPLATE = `${CORE_TOOLS_EN}

${FORMAT_RULE}`;

const EN_STRICT_TEMPLATE = `${EN_TEMPLATE}

STRICT: Absolutely no text outside tool_json block.`;

const CN_TEMPLATE = `工作区目录: workspace/

${CORE_TOOLS_CN}

${FORMAT_RULE}`;

/** No web models skip prompt injection — web interfaces don't pass native tools.
 *  Even DeepSeek/Claude/GLM need prompt injection when accessed via browser. */
const NATIVE_TOOL_MODELS = new Set<string>();

/** Models excluded from tool calling entirely */
const EXCLUDED_MODELS = new Set(["perplexity-web"]);

/** Chinese-language models */
const CN_MODELS = new Set([
  "deepseek-web",
  "doubao-web",
  "qwen-cn-web",
  "kimi-web",
  "glm-web",
  "xiaomimo-web",
]);

/** Models that tend to add extra text after JSON */
const STRICT_MODELS = new Set(["chatgpt-web"]);

export function shouldInjectToolPrompt(api: string): boolean {
  return !NATIVE_TOOL_MODELS.has(api) && !EXCLUDED_MODELS.has(api);
}

export function getToolPrompt(api: string): string {
  if (STRICT_MODELS.has(api)) {
    return EN_STRICT_TEMPLATE;
  }
  if (CN_MODELS.has(api)) {
    return CN_TEMPLATE;
  }
  return EN_TEMPLATE;
}

/** Format tool result for feedback to the model */
export function formatToolResult(toolName: string, result: string): string {
  return `Tool ${toolName} returned: ${result}\nPlease continue answering based on this result.`;
}
