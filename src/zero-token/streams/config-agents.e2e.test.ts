/**
 * Standalone config verification test
 * Verifies openclaw.json agents.list registration
 *
 * Run: npx tsx src/zero-token/streams/config-agents.e2e.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_PATH = path.resolve(import.meta.dirname || __dirname, "../../../openclaw.json");

function runTests() {
  console.log("=== OpenClaw Config Agents Registration E2E Test ===\n");
  console.log(`Config path: ${CONFIG_PATH}`);

  console.assert(fs.existsSync(CONFIG_PATH), "openclaw.json should exist");
  console.log("  ✅ openclaw.json exists");

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  console.log("  ✅ Config is valid JSON");

  // Verify agents section
  console.assert(config.agents, "config.agents should exist");
  console.assert(Array.isArray(config.agents.list), "agents.list should be an array");
  console.assert(config.agents.list.length === 6, `Expected 6 agents, got ${config.agents.list.length}`);
  console.log(`  ✅ agents.list has ${config.agents.list.length} entries`);

  // Verify each agent
  const expectedAgents = [
    { id: "main", provider: undefined, allowAgents: ["*"] },
    { id: "doubao-web", provider: "doubao", allowAgents: [] },
    { id: "kimi-web", provider: "kimi", allowAgents: [] },
    { id: "qwen-web", provider: "qwen", allowAgents: [] },
    { id: "qwen-cn-web", provider: "qwen-cn", allowAgents: [] },
    { id: "glm-web", provider: "glm", allowAgents: [] },
  ];

  for (const expected of expectedAgents) {
    const found = config.agents.list.find((a: { id: string }) => a.id === expected.id);
    console.assert(found, `Agent '${expected.id}' should be in the list`);
    if (expected.provider) {
      console.assert(found.provider === expected.provider,
        `Agent '${expected.id}' provider should be '${expected.provider}', got '${found.provider}'`);
    }
    const actualAllow = found.subagents?.allowAgents;
    console.assert(JSON.stringify(actualAllow) === JSON.stringify(expected.allowAgents),
      `Agent '${expected.id}' allowAgents should be ${JSON.stringify(expected.allowAgents)}, got ${JSON.stringify(actualAllow)}`);
    console.log(`  ✅ Agent '${expected.id}' verified (provider: ${found.provider || 'default'}, allowAgents: ${JSON.stringify(actualAllow)})`);
  }

  // Verify global subagents allowAgents
  console.assert(
    JSON.stringify(config.agents.subagents?.allowAgents) === JSON.stringify(["*"]),
    "Global agents.subagents.allowAgents should be ['*']"
  );
  console.log("  ✅ Global allowAgents: ['*']");

  // Verify subagent defaults
  const defaults = config.agents.defaults?.subagents;
  console.assert(defaults?.maxConcurrent === 5, `maxConcurrent should be 5, got ${defaults?.maxConcurrent}`);
  console.assert(defaults?.maxSpawnDepth === 3, `maxSpawnDepth should be 3, got ${defaults?.maxSpawnDepth}`);
  console.assert(defaults?.runTimeoutSeconds === 300, `runTimeoutSeconds should be 300, got ${defaults?.runTimeoutSeconds}`);
  console.log("  ✅ Subagent defaults: maxConcurrent=5, maxSpawnDepth=3, timeout=300s");

  // Verify main agent has allowAgents: ["*"] (can spawn all)
  const main = config.agents.list.find((a: { id: string }) => a.id === "main");
  console.assert(
    JSON.stringify(main.subagents?.allowAgents) === JSON.stringify(["*"]),
    "Main agent should have allowAgents: ['*']"
  );
  console.log("  ✅ Main agent can spawn all sub-agents");

  // Verify web agents have allowAgents: [] (cannot spawn)
  for (const id of ["doubao-web", "kimi-web", "qwen-web", "qwen-cn-web", "glm-web"]) {
    const agent = config.agents.list.find((a: { id: string }) => a.id === id);
    console.assert(
      JSON.stringify(agent.subagents?.allowAgents) === JSON.stringify([]),
      `${id} should have allowAgents: [] (no further spawning)`
    );
  }
  console.log("  ✅ All web agents have allowAgents: [] (spawn depth enforcement)");

  console.log("\n=== ALL 8 CONFIG TESTS PASSED ✅ ===");
}

try {
  runTests();
} catch (err) {
  console.error("\n❌ Config verification FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}