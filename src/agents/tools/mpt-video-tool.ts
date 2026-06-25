/**
 * MoneyPrinterTurbo tool — AI-powered short video generation.
 *
 * Wraps the MoneyPrinterTurbo FastAPI service so the agent can generate
 * videos, scripts, and social metadata on demand.
 */
import type { SecretInput } from "../../config/types.secrets.js";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam, readNumberParam, jsonResult, failedTextResult, createActionGate } from "./common.js";
import { stringEnum } from "../schema/typebox.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type MoneyPrinterTurboToolConfig = {
  /** Base URL of the MoneyPrinterTurbo API (default: http://127.0.0.1:8080) */
  baseUrl?: string;
  /** API key (if auth is enabled on the MPT side) */
  apiKey?: SecretInput;
  /** Enable/disable specific actions */
  actions?: {
    generate_video?: boolean;
    generate_script?: boolean;
    generate_terms?: boolean;
    generate_social_metadata?: boolean;
    query_task?: boolean;
    list_tasks?: boolean;
  };
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const VideoAspectEnum = stringEnum(["9:16", "16:9", "1:1"], {
  description: "Video aspect ratio: 9:16 (portrait/TikTok), 16:9 (landscape/YouTube), 1:1 (square)",
});

const VideoConcatModeEnum = stringEnum(["random", "sequential"], {
  description: "How clips are ordered: random or sequential",
});

const MoneyPrinterTurboSchema = Type.Object({
  action: stringEnum(
    ["generate_video", "generate_script", "generate_terms", "generate_social_metadata", "query_task", "list_tasks"],
    { description: "Action to perform" },
  ),
  // generate_video params
  video_subject: Type.Optional(Type.String({ description: "Video topic or keyword (required for generate_video/generate_script)" })),
  video_script: Type.Optional(Type.String({ description: "Pre-written video script (optional, auto-generated if empty)" })),
  video_aspect: Type.Optional(VideoAspectEnum),
  video_concat_mode: Type.Optional(VideoConcatModeEnum),
  video_clip_duration: Type.Optional(Type.Number({ description: "Duration per clip in seconds (default: 5)" })),
  video_count: Type.Optional(Type.Number({ description: "Number of videos to generate (default: 1)" })),
  voice_name: Type.Optional(Type.String({ description: "TTS voice name (e.g. zh-CN-XiaoxiaoNeural-Female)" })),
  subtitle_enabled: Type.Optional(Type.Boolean({ description: "Enable subtitles (default: true)" })),
  bgm_type: Type.Optional(Type.String({ description: "BGM type: random, custom (default: random)" })),
  video_language: Type.Optional(Type.String({ description: "Video language (auto-detect if empty)" })),
  // generate_terms params
  amount: Type.Optional(Type.Number({ description: "Number of search terms to generate (default: 5)" })),
  // generate_social_metadata params
  platform: Type.Optional(Type.String({ description: "Social platform for metadata (default: tiktok)" })),
  language: Type.Optional(Type.String({ description: "Language for social metadata (default: auto)" })),
  // query_task / list_tasks params
  task_id: Type.Optional(Type.String({ description: "Task ID to query" })),
  page: Type.Optional(Type.Number({ description: "Page number for list_tasks (default: 1)" })),
  page_size: Type.Optional(Type.Number({ description: "Page size for list_tasks (default: 10)" })),
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function mptFetch(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; apiKey?: SecretInput } = {},
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof options.apiKey === "string") {
    headers["x-api-key"] = options.apiKey;
  }

  const response = await fetch(url, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, raw: text };
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMoneyPrinterTurboTool(config?: MoneyPrinterTurboToolConfig): AnyAgentTool {
  const baseUrl = (config?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config?.apiKey;
  const gate = createActionGate(config?.actions);

  return {
    label: "MoneyPrinterTurbo",
    name: "mpt_video",
    description:
      "AI short video generation tool powered by MoneyPrinterTurbo. " +
      "Actions: generate_video (create a short video from a topic), " +
      "generate_script (generate video script from a topic), " +
      "generate_terms (generate search keywords for video materials), " +
      "generate_social_metadata (generate title/caption/hashtags for social media), " +
      "query_task (check video generation task status), " +
      "list_tasks (list all tasks). " +
      "Video generation is async — use generate_video first, then query_task to check progress.",
    parameters: MoneyPrinterTurboSchema,
    ownerOnly: false,
    displaySummary: "Generate AI short videos",
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          // ---- Generate Video ----
          case "generate_video": {
            if (!gate("generate_video")) {
              return failedTextResult("generate_video action is disabled", { status: "failed" });
            }
            const videoSubject = readStringParam(params, "video_subject", { required: true });
            const body: Record<string, unknown> = {
              video_subject: videoSubject,
              video_script: readStringParam(params, "video_script") || "",
              video_aspect: readStringParam(params, "video_aspect") || "9:16",
              video_concat_mode: readStringParam(params, "video_concat_mode") || "random",
              video_clip_duration: readNumberParam(params, "video_clip_duration") || 5,
              video_count: readNumberParam(params, "video_count") || 1,
              voice_name: readStringParam(params, "voice_name") || "",
              subtitle_enabled: params.subtitle_enabled !== false,
              bgm_type: readStringParam(params, "bgm_type") || "random",
              video_language: readStringParam(params, "video_language") || "",
            };
            const result = await mptFetch(baseUrl, "/api/v1/videos", { method: "POST", body, apiKey });
            return jsonResult(result);
          }

          // ---- Generate Script ----
          case "generate_script": {
            if (!gate("generate_script")) {
              return failedTextResult("generate_script action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              video_subject: readStringParam(params, "video_subject", { required: true }),
              video_language: readStringParam(params, "video_language") || "",
              paragraph_number: readNumberParam(params, "video_count") || 1,
              video_script_prompt: readStringParam(params, "video_script") || "",
            };
            const result = await mptFetch(baseUrl, "/api/v1/scripts", { method: "POST", body, apiKey });
            return jsonResult(result);
          }

          // ---- Generate Terms ----
          case "generate_terms": {
            if (!gate("generate_terms")) {
              return failedTextResult("generate_terms action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              video_subject: readStringParam(params, "video_subject", { required: true }),
              video_script: readStringParam(params, "video_script") || "",
              amount: readNumberParam(params, "amount") || 5,
            };
            const result = await mptFetch(baseUrl, "/api/v1/terms", { method: "POST", body, apiKey });
            return jsonResult(result);
          }

          // ---- Generate Social Metadata ----
          case "generate_social_metadata": {
            if (!gate("generate_social_metadata")) {
              return failedTextResult("generate_social_metadata action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              video_subject: readStringParam(params, "video_subject", { required: true }),
              video_script: readStringParam(params, "video_script") || "",
              language: readStringParam(params, "language") || "auto",
              platform: readStringParam(params, "platform") || "tiktok",
            };
            const result = await mptFetch(baseUrl, "/api/v1/social-metadata", { method: "POST", body, apiKey });
            return jsonResult(result);
          }

          // ---- Query Task ----
          case "query_task": {
            if (!gate("query_task")) {
              return failedTextResult("query_task action is disabled", { status: "failed" });
            }
            const taskId = readStringParam(params, "task_id", { required: true });
            const result = await mptFetch(baseUrl, `/api/v1/tasks/${taskId}`, { apiKey });
            return jsonResult(result);
          }

          // ---- List Tasks ----
          case "list_tasks": {
            if (!gate("list_tasks")) {
              return failedTextResult("list_tasks action is disabled", { status: "failed" });
            }
            const page = readNumberParam(params, "page") || 1;
            const pageSize = readNumberParam(params, "page_size") || 10;
            const result = await mptFetch(baseUrl, `/api/v1/tasks?page=${page}&page_size=${pageSize}`, { apiKey });
            return jsonResult(result);
          }

          default:
            return failedTextResult(`Unknown action: ${action}`, { status: "failed" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failedTextResult(
          `MoneyPrinterTurbo API error: ${message}. Ensure the MPT service is running at ${baseUrl}.`,
          { status: "failed" },
        );
      }
    },
  };
}
