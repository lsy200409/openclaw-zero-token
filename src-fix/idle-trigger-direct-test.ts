import { IdleDetector, SessionActivityTracker } from "../src-fix/idle-detector.js";
import { LazyMemoryManager } from "../src-fix/lazy-memory-manager.js";
import { ChildSessionBridge } from "../src-fix/child-session-bridge.js";
import type { MemorySaveRequest } from "../src-fix/child-session-bridge.js";

async function runTest() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Idle-Triggered Memory Save - Direct Test               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const activityTracker = new SessionActivityTracker();
  const childSessionBridge = new ChildSessionBridge();

  const lazyMemoryManager = new LazyMemoryManager(activityTracker, {
    idleTimeoutMs: 2000,
    memorySaveDebounceMs: 500,
    enableChildSessionFork: true,
  });

  lazyMemoryManager.setChildSessionCallback(async (request: MemorySaveRequest) => {
    console.log(`[CHILD SESSION] Executing memory save for: ${request.sessionKey}`);
    console.log(`  Reason: ${request.reason}, Priority: ${request.priority}`);
    await new Promise((r) => setTimeout(r, 100));
    return {
      taskId: `test-${Date.now()}`,
      sessionKey: request.sessionKey,
      success: true,
      tokensSaved: 1000,
      messagesPruned: 5,
      contextSummary: "Test compaction",
      durationMs: 100,
    };
  });

  lazyMemoryManager.onSaveComplete((result) => {
    console.log(`[CALLBACK] Memory save complete: ${result.sessionKey}, Success: ${result.success}\n`);
  });

  const sessionKey = "test-session:main";

  lazyMemoryManager.registerSession(sessionKey, "root");

  console.log("--- Step 1: Record activity to reset idle timer ---");
  activityTracker.recordActivity(sessionKey, "user_input");
  console.log("  Activity recorded (user_input)\n");

  console.log("--- Step 2: Wait 1 second (below idle threshold) ---");
  await new Promise((r) => setTimeout(r, 1000));
  console.log("  1 second passed, no idle trigger expected\n");

  console.log("--- Step 3: Record more activity ---");
  activityTracker.recordActivity(sessionKey, "ai_response");
  console.log("  Activity recorded (ai_response)\n");

  console.log("--- Step 4: Wait 3 seconds (above 2s idle threshold) ---");
  console.log("  Waiting...");
  await new Promise((r) => setTimeout(r, 3000));
  console.log("  3 seconds passed, idle should have triggered\n");

  console.log("--- Step 5: Check pending tasks ---");
  console.log(`  Pending tasks: ${lazyMemoryManager.getPendingTaskCount()}`);
  console.log(`  Running tasks: ${lazyMemoryManager.getRunningTaskCount()}\n`);

  await new Promise((r) => setTimeout(r, 1000));

  console.log("--- Step 6: Cleanup ---");
  lazyMemoryManager.unregisterSession(sessionKey);
  lazyMemoryManager.shutdown();
  childSessionBridge.stop();

  console.log("\nTest complete!\n");
}

runTest().catch(console.error);
