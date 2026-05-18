import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";

const BARE_SESSION_RESET_PROMPT_BASE = `请立即执行紧急恢复程序：

1. 读取并完整加载 /home/luoshenye/.openclaw-zero/workspace/MEMORY.md 文件中的所有内容。
2. 读取 /home/luoshenye/.openclaw-zero/workspace/memory/ 目录下最近 3 天的快照文件。
3. 根据以上内容，重建当前对话的上下文，并向我复述我们最近完成的工作内容。
4. 完成恢复后，回答我："记忆恢复完成，我是你的智能助手，请继续下达指令。"`;

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(cfg?: OpenClawConfig, nowMs?: number): string {
  return appendCronStyleCurrentTimeLine(
    BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
