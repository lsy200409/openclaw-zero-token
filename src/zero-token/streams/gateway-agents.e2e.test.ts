/**
 * WebSocket E2E test: calls agents.list and config.get via Gateway WebSocket RPC
 *
 * Run: npx tsx src/zero-token/streams/gateway-agents.e2e.test.ts
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3002";
const TOKEN = "62b791625fa441be036acd3c206b7e14e2bb13c803355823";

async function wsCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${WS_URL}/__openclaw__/ws/operator`,
    );
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout for ${method}`));
    }, 15_000);

    let handshakeDone = false;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Step 1: handle connect handshake response
        if (!handshakeDone && msg.type === "res" && msg.id === "connect-1") {
          handshakeDone = true;
          if (!msg.ok) {
            clearTimeout(timeout);
            ws.close();
            reject(
              new Error(`connect failed: ${JSON.stringify(msg.error)}`),
            );
            return;
          }
          // Now send the actual request
          ws.send(
            JSON.stringify({
              type: "req",
              method,
              id: "req-1",
              params,
            }),
          );
          return;
        }

        // Step 2: handle the actual request response
        if (msg.id === "req-1") {
          clearTimeout(timeout);
          ws.close();
          if (msg.ok) {
            resolve(msg.payload);
          } else {
            reject(
              new Error(`${method} failed: ${JSON.stringify(msg.error)}`),
            );
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on("open", () => {
      // Send connect handshake first
      ws.send(
        JSON.stringify({
          type: "req",
          method: "connect",
          id: "connect-1",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "test",
              version: "0.0.1",
              platform: "node",
              mode: "test",
            },
            auth: {
              token: TOKEN,
            },
            scopes: ["operator.read", "operator.write", "operator.admin"],
          },
        }),
      );
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function runTests() {
  console.log("=== Gateway WebSocket RPC E2E Test ===\n");
  console.log(`Gateway URL: ${WS_URL}`);

  try {
    // Test 1: agents.list
    const agentsResult = (await wsCall("agents.list")) as {
      agents?: Array<{ id: string; name?: string }>;
    };
    const agents = agentsResult?.agents ?? [];
    console.log(`\n[TEST 1] agents.list returned ${agents.length} agents:`);
    for (const a of agents) {
      console.log(`  - ${a.id}${a.name ? ` (${a.name})` : ""}`);
    }

    const agentIds = agents.map((a) => a.id);
    const expected = [
      "main",
      "doubao-web",
      "kimi-web",
      "qwen-web",
      "qwen-cn-web",
      "glm-web",
    ];
    console.log("");
    for (const id of expected) {
      const found = agentIds.includes(id);
      console.log(
        found
          ? `  ✅ Agent '${id}' registered`
          : `  ❌ Agent '${id}' NOT registered!`,
      );
    }
    console.log(
      agents.length >= 6
        ? `  ✅ Total: ${agents.length} agents (6+ expected)`
        : `  ❌ Only ${agents.length} agents found (6 expected)`,
    );

    // Test 2: config.get to verify agents config section
    const configResult = (await wsCall("config.get")) as {
      agents?: {
        list?: Array<{ id: string }>;
        subagents?: { allowAgents?: string[] };
      };
    };
    const configAgents = configResult?.agents?.list ?? [];
    const configAllowAgents =
      configResult?.agents?.subagents?.allowAgents ?? [];
    console.log(
      `\n[TEST 2] config.get agents.list = ${configAgents.length} entries`,
    );
    console.log(
      `  agents.subagents.allowAgents = ${JSON.stringify(configAllowAgents)}`,
    );
    const hasStarGlobal = configAllowAgents.includes("*");
    console.log(
      hasStarGlobal
        ? "  ✅ Global allowAgents includes '*'"
        : "  ❌ Global allowAgents missing '*'!",
    );

    // Test 3: health
    const health = (await wsCall("health")) as { status?: string };
    console.log(`\n[TEST 3] health: ${JSON.stringify(health)}`);
    console.log("  ✅ Gateway is alive");

    console.log("\n=== Gateway E2E Tests PASSED ✅ ===");
  } catch (err) {
    console.error(
      "\n❌ Gateway E2E FAILED:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

runTests();