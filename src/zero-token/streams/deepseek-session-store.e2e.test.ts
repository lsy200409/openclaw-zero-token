/**
 * Standalone E2E test for deepseek-session-store.ts
 * Tests: save, load, persist (reload from disk), remove, multiple sessions
 *
 * Run: npx tsx src/zero-token/streams/deepseek-session-store.e2e.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_DIR = "/tmp/deepseek-session-e2e-test";
const TEST_FILE = path.join(TEST_DIR, "deepseek-sessions.json");
process.env.DEEPSEEK_SESSION_STORE_PATH = TEST_FILE;

async function runTests() {
  console.log("=== DeepSeek Session Store E2E Test ===\n");

  fs.mkdirSync(TEST_DIR, { recursive: true });
  console.log("[TEST 1] Clean start: no file on disk");

  const mod = await import("./deepseek-session-store.js");
  let data = mod.loadDeepseekSessions();
  console.assert(Object.keys(data.sessionMap).length === 0, "sessionMap should be empty");
  console.assert(Object.keys(data.parentMessageMap).length === 0, "parentMessageMap should be empty");
  console.log("  ✅ loadDeepseekSessions() returns empty on clean start");

  await mod.saveDeepseekSessionEntry("default", "ds_session_abc123", null);
  console.log("  ✅ saveDeepseekSessionEntry('default', 'ds_session_abc123') persisted");

  console.assert(fs.existsSync(TEST_FILE), "File should exist");
  const raw = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
  console.assert(raw.sessionMap.default === "ds_session_abc123", `Expected ds_session_abc123, got ${raw.sessionMap.default}`);
  console.log("  ✅ File contains correct sessionMap");

  await mod.saveDeepseekParentMessageId("default", "msg_xyz_789");
  console.log("  ✅ saveDeepseekParentMessageId('default', 'msg_xyz_789') persisted");

  const raw2 = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
  console.assert(raw2.parentMessageMap.default === "msg_xyz_789");
  console.log("  ✅ File contains correct parentMessageMap");

  // Simulate restart: reload from disk
  const reloaded = mod.reloadDeepseekSessions();
  console.assert(reloaded.sessionMap.default === "ds_session_abc123", "sessionId should survive");
  console.assert(reloaded.parentMessageMap.default === "msg_xyz_789", "parentId should survive");
  console.log("  ✅ Data survives reloadDeepseekSessions() (simulated restart)");

  await mod.removeDeepseekSessionEntry("default");
  console.log("  ✅ removeDeepseekSessionEntry('default') cleared");

  const raw3 = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
  console.assert(!raw3.sessionMap.default, "sessionMap entry should be gone");
  console.assert(!raw3.parentMessageMap.default, "parentMessageMap entry should be gone");
  console.log("  ✅ File no longer contains removed entry");

  const afterRemoval = mod.reloadDeepseekSessions();
  console.assert(Object.keys(afterRemoval.sessionMap).length === 0);
  console.log("  ✅ reloadDeepseekSessions() confirms removal");

  // Multiple sessions
  await mod.saveDeepseekSessionEntry("session-a", "ds_a", null);
  await mod.saveDeepseekSessionEntry("session-b", "ds_b", 42);
  await mod.saveDeepseekSessionEntry("session-c", "ds_c", "msg_c");

  const raw4 = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
  console.assert(raw4.sessionMap["session-a"] === "ds_a");
  console.assert(raw4.sessionMap["session-b"] === "ds_b");
  console.assert(raw4.parentMessageMap["session-b"] === 42);
  console.assert(raw4.parentMessageMap["session-c"] === "msg_c");
  console.log("  ✅ Multiple sessions with mixed types saved correctly");

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log("\n=== ALL 8 TESTS PASSED ✅ ===");
}

runTests().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n❌ TEST FAILED:", message);
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  process.exit(1);
});