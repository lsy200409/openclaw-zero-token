/**
 * DS2API Adapter Bridge for Zero-Token Gateway
 *
 * 功能: 将原生Gateway的openai-completions provider请求桥接到DS2API后端
 * 端口: 3003（HTTP OpenAI兼容API网关）
 * 上游: http://localhost:5001 (DS2API Go后端)
 *
 * 架构:
 *   WebUI → Gateway:3002 (原生) → DS2API Adapter:3003 → DS2API:5001 → DeepSeek
 *   或 HTTP客户端 → DS2API Adapter:3003 → DS2API:5001 → DeepSeek
 *
 * 特性:
 *   - 支持 SSE 流式输出 (stream: true)
 *   - 支持工具调用 (tools / tool_choice)
 *   - 完整 CORS 支持
 *   - 健康检查和模型列表
 */

import http from "node:http";
import { Readable } from "node:stream";

const DS2API_UPSTREAM = "http://localhost:5001";
const DS2API_KEY = "local-dev-key";
const PORT = parseInt(process.env.ADAPTER_PORT || "3003", 10);

const ADAPTER_MODELS = [
  { id: "deepseek-v4-flash", object: "model", created: 1677610602, owned_by: "deepseek" },
  { id: "deepseek-v4-flash-nothinking", object: "model", created: 1677610602, owned_by: "deepseek" },
  { id: "deepseek-v4-pro", object: "model", created: 1677610602, owned_by: "deepseek" },
  { id: "deepseek-v4-flash-search", object: "model", created: 1677610602, owned_by: "deepseek" },
  { id: "deepseek-v4-pro-search", object: "model", created: 1677610602, owned_by: "deepseek" },
];

const MODEL_MAP = {
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-nothinking": "deepseek-v4-flash-nothinking",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-flash-search": "deepseek-v4-flash-search",
  "deepseek-v4-pro-search": "deepseek-v4-pro-search",
};

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenClaw-Scopes, X-OpenClaw-Model");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
}

function sendJson(res, status, data) {
  corsHeaders(res);
  const json = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function startSseStream(res) {
  corsHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/**
 * Handle non-streaming chat completion.
 * Reads full response from DS2API and sends back as single JSON.
 */
async function handleNonStreaming(body, model, res) {
  const t0 = Date.now();
  try {
    const upstreamUrl = `${DS2API_UPSTREAM}/v1/chat/completions`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DS2API_KEY}`,
      },
      body: JSON.stringify({ ...body, stream: false }),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      log("ERROR", `DS2API ${upstreamRes.status}: ${errText.slice(0, 200)}`);
      const errJson = tryParseJson(errText);
      sendJson(res, upstreamRes.status, {
        error: errJson?.error || {
          message: `DS2API error: ${upstreamRes.status}`,
          type: "api_error",
        },
      });
      return;
    }

    const data = await upstreamRes.json();
    sendJson(res, 200, data);
    log("INFO", `[${model}] non-stream OK ${Date.now() - t0}ms tokens=${data?.usage?.total_tokens || "?"}`);
  } catch (err) {
    log("ERROR", `[${model}] non-stream failed: ${err.message}`);
    sendJson(res, 502, { error: { message: "Upstream unavailable", type: "api_error" } });
  }
}

/**
 * Handle streaming chat completion.
 * Pipes SSE chunks from DS2API directly to client.
 */
async function handleStreaming(body, model, res) {
  const t0 = Date.now();
  startSseStream(res);

  let totalChunks = 0;
  let closed = false;

  res.on("close", () => {
    closed = true;
  });

  try {
    const upstreamUrl = `${DS2API_UPSTREAM}/v1/chat/completions`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DS2API_KEY}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      log("ERROR", `DS2API stream ${upstreamRes.status}: ${errText.slice(0, 200)}`);
      if (!closed) {
        sendSseError(res, `DS2API error: ${upstreamRes.status}`);
      }
      return;
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (closed) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          res.write(line + "\n");
          if (line.startsWith("data:") && !line.includes("[DONE]")) {
            totalChunks++;
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim() && !closed) {
      res.write(buffer + "\n");
    }

    if (!closed) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
    log("INFO", `[${model}] stream OK ${Date.now() - t0}ms chunks=${totalChunks}`);
  } catch (err) {
    log("ERROR", `[${model}] stream failed: ${err.message}`);
    if (!closed) {
      sendSseError(res, `Stream error: ${err.message}`);
    }
  }
}

function sendSseError(res, message) {
  try {
    res.write(`data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (_) {
    // connection already closed
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function validateModel(model) {
  return ADAPTER_MODELS.some((m) => m.id === model);
}

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url;
  const pathname = url.split("?")[0];

  corsHeaders(res);

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /v1/models
  if (method === "GET" && pathname === "/v1/models") {
    sendJson(res, 200, { object: "list", data: ADAPTER_MODELS });
    return;
  }

  // GET /health
  if (pathname === "/health") {
    sendJson(res, 200, { ok: true, status: "live", upstream: DS2API_UPSTREAM });
    return;
  }

  // POST /v1/chat/completions
  if (method === "POST" && pathname === "/v1/chat/completions") {
    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      sendJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
      return;
    }

    const model = body.model || "deepseek-v4-flash";
    const stream = body.stream === true;

    if (!validateModel(model)) {
      sendJson(res, 404, {
        error: { message: `Unknown model: ${model}`, type: "invalid_request_error" },
      });
      return;
    }

    const upstreamBody = {
      model: MODEL_MAP[model] || model,
      messages: body.messages || [],
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      stop: body.stop,
      tools: body.tools || body.functions,
      tool_choice: body.tool_choice || body.function_call,
    };

    // Remove undefined fields
    Object.keys(upstreamBody).forEach((k) => {
      if (upstreamBody[k] === undefined) delete upstreamBody[k];
    });

    // Log incoming request
    const msgPreview = body.messages?.length
      ? body.messages[body.messages.length - 1]?.content?.slice(0, 80) || ""
      : "";
    log(
      "INFO",
      `[${model}] ${stream ? "STREAM" : "SYNC"} msgs=${body.messages?.length || 0} prompt="${msgPreview}"`,
    );

    if (stream) {
      await handleStreaming(upstreamBody, model, res);
    } else {
      await handleNonStreaming(upstreamBody, model, res);
    }
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
});

server.listen(PORT, () => {
  log("INFO", `DS2API Adapter Bridge v2 listening on http://127.0.0.1:${PORT}`);
  log("INFO", `Upstream: ${DS2API_UPSTREAM} (key: ${DS2API_KEY.slice(0, 8)}...)`);
  log("INFO", `Models: ${ADAPTER_MODELS.map((m) => m.id).join(", ")}`);
  log("INFO", "Features: SSE streaming, tool calling, CORS");
});