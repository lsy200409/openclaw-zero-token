import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryStateTracker,
  getGlobalMemoryTracker,
  resetGlobalMemoryTracker,
  createMemoryFlushGuard,
  estimateTokenCount,
  DEFAULT_MEMORY_FLUSH_CONFIG,
} from "./memory-system-fix.js";

describe("memory-system-fix", () => {
  describe("MemoryStateTracker", () => {
    let tracker: MemoryStateTracker;

    beforeEach(() => {
      tracker = new MemoryStateTracker();
    });

    it("should initialize with default config", () => {
      const config = tracker.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.reserveTokensFloor).toBe(20_000);
      expect(config.softThresholdTokens).toBe(4_000);
    });

    it("should update and retrieve snapshots", () => {
      tracker.updateSnapshot("session-1", {
        promptTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        compactionCount: 1,
      });
      const snapshot = tracker.getSnapshot("session-1");
      expect(snapshot?.promptTokens).toBe(1000);
      expect(snapshot?.outputTokens).toBe(500);
      expect(snapshot?.compactionCount).toBe(1);
    });

    it("should track multiple sessions", () => {
      tracker.updateSnapshot("session-1", { promptTokens: 1000 });
      tracker.updateSnapshot("session-2", { promptTokens: 2000 });
      expect(tracker.getSnapshot("session-1")?.promptTokens).toBe(1000);
      expect(tracker.getSnapshot("session-2")?.promptTokens).toBe(2000);
    });

    it("should trigger flush with callback", async () => {
      let flushCalled = false;
      tracker.setOnFlushCallback(async (sessionKey, _snapshot) => {
        flushCalled = true;
        expect(sessionKey).toBe("session-1");
      });

      tracker.updateSnapshot("session-1", { totalTokens: 50000 });
      const result = await tracker.triggerFlush("session-1");
      expect(result).toBe(true);
      expect(flushCalled).toBe(true);
    });

    it("should not trigger flush when disabled", async () => {
      const disabledTracker = new MemoryStateTracker({ enabled: false });
      disabledTracker.updateSnapshot("session-1", { totalTokens: 50000 });
      const result = await disabledTracker.triggerFlush("session-1");
      expect(result).toBe(false);
    });

    it("should limit flush retries", async () => {
      const limitedTracker = new MemoryStateTracker({ maxFlushRetries: 2 });
      limitedTracker.updateSnapshot("session-1", { totalTokens: 50000 });

      await limitedTracker.triggerFlush("session-1");
      await limitedTracker.triggerFlush("session-1");
      await limitedTracker.triggerFlush("session-1");

      const count = limitedTracker.getPendingFlushCount();
      expect(count).toBe(1);
    });

    it("should clear session data", () => {
      tracker.updateSnapshot("session-1", { promptTokens: 1000 });
      tracker.clearSession("session-1");
      expect(tracker.getSnapshot("session-1")).toBeUndefined();
    });

    it("should update config", () => {
      tracker.updateConfig({ reserveTokensFloor: 30000 });
      const config = tracker.getConfig();
      expect(config.reserveTokensFloor).toBe(30000);
    });
  });

  describe("createMemoryFlushGuard", () => {
    let tracker: MemoryStateTracker;

    beforeEach(() => {
      tracker = new MemoryStateTracker();
    });

    it("should create flush guard", () => {
      const guard = createMemoryFlushGuard({
        sessionKey: "session-1",
        tracker,
        maxTokensPerFlush: 1000,
      });
      expect(guard.sessionKey).toBe("session-1");
    });

    it("should trigger flush when tokens exceed threshold", () => {
      const guard = createMemoryFlushGuard({
        sessionKey: "session-1",
        tracker,
        maxTokensPerFlush: 1000,
      });
      expect(guard.shouldFlush(1500)).toBe(true);
    });

    it("should not trigger flush when tokens below threshold", () => {
      const guard = createMemoryFlushGuard({
        sessionKey: "session-1",
        tracker,
        maxTokensPerFlush: 1000,
      });
      expect(guard.shouldFlush(500)).toBe(false);
    });

    it("should mark flush as in progress", () => {
      const guard = createMemoryFlushGuard({
        sessionKey: "session-1",
        tracker,
        maxTokensPerFlush: 1000,
      });
      guard.markFlushStarted();
      expect(guard.shouldFlush(1500)).toBe(false);
    });

    it("should mark flush as completed", () => {
      const guard = createMemoryFlushGuard({
        sessionKey: "session-1",
        tracker,
        maxTokensPerFlush: 1000,
      });
      guard.markFlushStarted();
      guard.markFlushCompleted();
      expect(guard.shouldFlush(1500)).toBe(true);
    });
  });

  describe("estimateTokenCount", () => {
    it("should estimate token count based on characters", () => {
      const text = "hello world";
      const tokens = estimateTokenCount(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(text.length);
    });

    it("should handle empty string", () => {
      const tokens = estimateTokenCount("");
      expect(tokens).toBe(0);
    });
  });

  describe("getGlobalMemoryTracker", () => {
    it("should return singleton instance", () => {
      resetGlobalMemoryTracker();
      const instance1 = getGlobalMemoryTracker();
      const instance2 = getGlobalMemoryTracker();
      expect(instance1).toBe(instance2);
    });

    it("should reset global tracker", () => {
      resetGlobalMemoryTracker();
      const instance1 = getGlobalMemoryTracker();
      resetGlobalMemoryTracker();
      const instance2 = getGlobalMemoryTracker();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_MEMORY_FLUSH_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.enabled).toBe(true);
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.reserveTokensFloor).toBeGreaterThan(0);
      expect(DEFAULT_MEMORY_FLUSH_CONFIG.maxFlushRetries).toBeGreaterThan(0);
    });
  });
});
