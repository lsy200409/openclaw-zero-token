/**
 * AiToEarn tool — AI-powered content creation, publishing & monetization.
 *
 * Wraps the AiToEarn platform API so the agent can create content,
 * publish to social platforms, manage engagement, and track monetization.
 */
import type { SecretInput } from "../../config/types.secrets.js";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam, readNumberParam, jsonResult, failedTextResult, createActionGate } from "./common.js";
import { stringEnum } from "../schema/typebox.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AiToEarnToolConfig = {
  /** Base URL of the AiToEarn API (default: http://127.0.0.1:8080) */
  baseUrl?: string;
  /** JWT token for authenticated API calls */
  token?: SecretInput;
  /** Enable/disable specific actions */
  actions?: {
    create_content?: boolean;
    generate_image?: boolean;
    generate_video?: boolean;
    publish?: boolean;
    list_accounts?: boolean;
    list_materials?: boolean;
    create_material?: boolean;
    engagement?: boolean;
    list_tasks?: boolean;
  };
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AiToEarnSchema = Type.Object({
  action: stringEnum(
    [
      "create_content",
      "generate_image",
      "generate_video",
      "query_video_task",
      "publish",
      "list_accounts",
      "list_materials",
      "create_material",
      "ai_reply_comment",
      "list_tasks",
    ],
    { description: "Action to perform" },
  ),
  // Content creation params
  prompt: Type.Optional(Type.String({ description: "Content prompt for AI agent (required for create_content)" })),
  model: Type.Optional(Type.String({ description: "AI model to use (e.g. gpt-5.5, gemini-3-flash-preview)" })),
  // Image generation params
  image_prompt: Type.Optional(Type.String({ description: "Image generation prompt (required for generate_image)" })),
  image_model: Type.Optional(Type.String({ description: "Image model (e.g. gpt-image-2)" })),
  image_size: Type.Optional(Type.String({ description: "Image size (e.g. 1024x1024, 1536x1024)" })),
  n: Type.Optional(Type.Number({ description: "Number of images to generate (default: 1)" })),
  // Video generation params
  video_prompt: Type.Optional(Type.String({ description: "Video generation prompt (required for generate_video)" })),
  video_model: Type.Optional(Type.String({ description: "Video model (e.g. happyhorse-1.0, doubao-seedance-2-0-260128)" })),
  video_duration: Type.Optional(Type.Number({ description: "Video duration in seconds (default: 5)" })),
  video_task_id: Type.Optional(Type.String({ description: "Video task ID for query_video_task" })),
  // Publishing params
  account_id: Type.Optional(Type.String({ description: "Social account ID for publishing" })),
  account_type: Type.Optional(Type.String({ description: "Platform type: youtube, tiktok, douyin, bilibili, xhs, instagram, facebook, threads, twitter, pinterest, linkedin, kwai, wxSph, wxGzh" })),
  material_id: Type.Optional(Type.String({ description: "Material/draft ID to publish" })),
  title: Type.Optional(Type.String({ description: "Content title" })),
  desc: Type.Optional(Type.String({ description: "Content description" })),
  publish_time: Type.Optional(Type.String({ description: "Scheduled publish time (ISO 8601)" })),
  // Material params
  group_id: Type.Optional(Type.String({ description: "Material group ID" })),
  cover_url: Type.Optional(Type.String({ description: "Cover image URL" })),
  media_urls: Type.Optional(Type.Array(Type.String(), { description: "Media file URLs" })),
  // Engagement params
  post_id: Type.Optional(Type.String({ description: "Post ID for engagement" })),
  comment_prompt: Type.Optional(Type.String({ description: "Prompt for AI comment reply" })),
  // List params
  page: Type.Optional(Type.Number({ description: "Page number (default: 1)" })),
  page_size: Type.Optional(Type.Number({ description: "Page size (default: 10)" })),
  task_id: Type.Optional(Type.String({ description: "Agent task ID" })),
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function a2eFetch(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; token?: SecretInput } = {},
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof options.token === "string") {
    headers["Authorization"] = `Bearer ${options.token}`;
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

export function createAiToEarnTool(config?: AiToEarnToolConfig): AnyAgentTool {
  const baseUrl = (config?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = config?.token;
  const gate = createActionGate(config?.actions);

  return {
    label: "AiToEarn",
    name: "aitoearn",
    description:
      "AI content creation, publishing & monetization platform. " +
      "Actions: create_content (AI agent generates content via prompt), " +
      "generate_image (AI image generation), " +
      "generate_video (AI video generation), " +
      "query_video_task (check video generation status), " +
      "publish (publish content to social platforms), " +
      "list_accounts (list connected social accounts), " +
      "list_materials (list content drafts), " +
      "create_material (create a content draft), " +
      "ai_reply_comment (AI auto-reply to comments), " +
      "list_tasks (list agent tasks). " +
      "Supports YouTube, TikTok, Douyin, Bilibili, XHS, Instagram, Facebook, Threads, Twitter, Pinterest, LinkedIn, Kwai, WeChat.",
    parameters: AiToEarnSchema,
    ownerOnly: false,
    displaySummary: "AI content creation & publishing",
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          // ---- Create Content (Agent) ----
          case "create_content": {
            if (!gate("create_content")) {
              return failedTextResult("create_content action is disabled", { status: "failed" });
            }
            const prompt = readStringParam(params, "prompt", { required: true });
            const body: Record<string, unknown> = {
              prompt,
              model: readStringParam(params, "model") || "gpt-5.5",
              includePartialMessages: true,
            };
            const result = await a2eFetch(baseUrl, "/api/agent/tasks", { method: "POST", body, token });
            return jsonResult(result);
          }

          // ---- Generate Image ----
          case "generate_image": {
            if (!gate("generate_image")) {
              return failedTextResult("generate_image action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              prompt: readStringParam(params, "image_prompt", { required: true }),
              model: readStringParam(params, "image_model") || "gpt-image-2",
              n: readNumberParam(params, "n") || 1,
              size: readStringParam(params, "image_size") || "1024x1024",
              response_format: "url",
            };
            const result = await a2eFetch(baseUrl, "/api/ai/image/generate/async", { method: "POST", body, token });
            return jsonResult(result);
          }

          // ---- Generate Video ----
          case "generate_video": {
            if (!gate("generate_video")) {
              return failedTextResult("generate_video action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              model: readStringParam(params, "video_model") || "happyhorse-1.0",
              prompt: readStringParam(params, "video_prompt", { required: true }),
              duration: readNumberParam(params, "video_duration") || 5,
            };
            const result = await a2eFetch(baseUrl, "/api/ai/video/generations", { method: "POST", body, token });
            return jsonResult(result);
          }

          // ---- Query Video Task ----
          case "query_video_task": {
            if (!gate("generate_video")) {
              return failedTextResult("query_video_task action is disabled", { status: "failed" });
            }
            const taskId = readStringParam(params, "video_task_id", { required: true });
            const result = await a2eFetch(baseUrl, `/api/ai/video/generations/${taskId}`, { token });
            return jsonResult(result);
          }

          // ---- Publish ----
          case "publish": {
            if (!gate("publish")) {
              return failedTextResult("publish action is disabled", { status: "failed" });
            }
            const accountId = readStringParam(params, "account_id", { required: true });
            const accountType = readStringParam(params, "account_type", { required: true });
            const body: Record<string, unknown> = {
              accountId,
              accountType,
              materialId: readStringParam(params, "material_id") || undefined,
              title: readStringParam(params, "title") || undefined,
              desc: readStringParam(params, "desc") || undefined,
              publishTime: readStringParam(params, "publish_time") || new Date().toISOString(),
              topics: [],
            };
            const result = await a2eFetch(baseUrl, "/api/plat/publish/create", { method: "POST", body, token });
            return jsonResult(result);
          }

          // ---- List Accounts ----
          case "list_accounts": {
            if (!gate("list_accounts")) {
              return failedTextResult("list_accounts action is disabled", { status: "failed" });
            }
            const result = await a2eFetch(baseUrl, "/api/account/list/all", { token });
            return jsonResult(result);
          }

          // ---- List Materials ----
          case "list_materials": {
            if (!gate("list_materials")) {
              return failedTextResult("list_materials action is disabled", { status: "failed" });
            }
            const page = readNumberParam(params, "page") || 1;
            const pageSize = readNumberParam(params, "page_size") || 10;
            const result = await a2eFetch(baseUrl, `/api/material/list/${page}/${pageSize}`, { token });
            return jsonResult(result);
          }

          // ---- Create Material ----
          case "create_material": {
            if (!gate("create_material")) {
              return failedTextResult("create_material action is disabled", { status: "failed" });
            }
            const body: Record<string, unknown> = {
              groupId: readStringParam(params, "group_id") || "default",
              title: readStringParam(params, "title", { required: true }),
              desc: readStringParam(params, "desc") || "",
              coverUrl: readStringParam(params, "cover_url") || "",
              mediaList: (params.media_urls as string[] || []).map((url) => ({
                url,
                type: url.match(/\.(mp4|mov|avi)/i) ? "video" : "img",
              })),
              type: "image",
            };
            const result = await a2eFetch(baseUrl, "/api/material", { method: "POST", body, token });
            return jsonResult(result);
          }

          // ---- AI Reply Comment ----
          case "ai_reply_comment": {
            if (!gate("engagement")) {
              return failedTextResult("engagement action is disabled", { status: "failed" });
            }
            const accountId = readStringParam(params, "account_id", { required: true });
            const postId = readStringParam(params, "post_id", { required: true });
            const platform = readStringParam(params, "account_type", { required: true });
            const body: Record<string, unknown> = {
              accountId,
              postId,
              platform,
              prompt: readStringParam(params, "comment_prompt") || "",
              model: readStringParam(params, "model") || "gpt-5.5",
              taskType: "REPLY",
              targetScope: "ALL",
            };
            const result = await a2eFetch(baseUrl, "/api/channel/engagement/comment/ai/replies/tasks", {
              method: "POST",
              body,
              token,
            });
            return jsonResult(result);
          }

          // ---- List Tasks ----
          case "list_tasks": {
            if (!gate("list_tasks")) {
              return failedTextResult("list_tasks action is disabled", { status: "failed" });
            }
            const page = readNumberParam(params, "page") || 1;
            const pageSize = readNumberParam(params, "page_size") || 10;
            const result = await a2eFetch(baseUrl, `/api/agent/tasks?page=${page}&pageSize=${pageSize}`, { token });
            return jsonResult(result);
          }

          default:
            return failedTextResult(`Unknown action: ${action}`, { status: "failed" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failedTextResult(
          `AiToEarn API error: ${message}. Ensure the AiToEarn service is running at ${baseUrl}.`,
          { status: "failed" },
        );
      }
    },
  };
}
