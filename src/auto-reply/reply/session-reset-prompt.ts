import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";

const MODEL_INTRO: Record<string, string> = {
  "kimi-web": "你当前运行在 Kimi K2 平台。",
  "doubao-web": "你当前运行在豆包 Seed 平台。",
  "qwen-cn-web": "你当前运行在通义千问中国版平台。",
  "qwen-web": "你当前运行在 Qwen International 平台。",
  "deepseek-web": "你当前运行在 DeepSeek 平台。",
  "glm-intl-web": "你当前运行在 GLM International 平台。",
};

function buildResetPrompt(workspacePath: string, modelIntro: string): string {
  return `${modelIntro}
请立即执行会话初始化程序：

1. 使用 read 工具读取 ${workspacePath}/MEMORY.md 中的全部记忆内容。
2. 列举 ${workspacePath}/memory/ 目录下的文件，读取最近 3 天的记忆快照。
3. 根据以上内容，重建当前对话的上下文，并向我复述我们最近完成的工作。
4. 完成初始化后，回答："记忆恢复完成，我是你的智能助手，请继续下达指令。"`;
}

const GENERIC_WORKSPACE = "/home/luoshenye/.openclaw-zero/workspace";
const GENERIC_INTRO = "你当前运行在默认工作区。";

function resolveModelIntro(agentId: string): string {
  const id = agentId.toLowerCase();
  for (const [key, intro] of Object.entries(MODEL_INTRO)) {
    if (id.includes(key) || key.includes(id)) {
      return intro;
    }
  }
  return "";
}

function resolveWorkspacePath(cfg: OpenClawConfig, agentId: string): string {
  try {
    return resolveAgentWorkspaceDir(cfg, agentId);
  } catch {
    return `${GENERIC_WORKSPACE}-${agentId}`;
  }
}

export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  agentId?: string,
): string {
  let base: string;
  if (agentId && cfg) {
    const workspacePath = resolveWorkspacePath(cfg, agentId);
    const modelIntro = resolveModelIntro(agentId) || GENERIC_INTRO;
    base = buildResetPrompt(workspacePath, modelIntro);
  } else {
    base = buildResetPrompt(GENERIC_WORKSPACE, GENERIC_INTRO);
  }
  return appendCronStyleCurrentTimeLine(base, cfg ?? {}, nowMs ?? Date.now());
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = buildResetPrompt(GENERIC_WORKSPACE, GENERIC_INTRO);