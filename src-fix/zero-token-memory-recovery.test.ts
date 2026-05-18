import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ZeroTokenMemoryRecovery,
  getZeroTokenMemoryRecovery,
  resetZeroTokenMemoryRecovery,
  DEFAULT_ZERO_TOKEN_MEMORY_CONFIG,
} from "./zero-token-memory-recovery.js";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
});

describe("zero-token-memory-recovery", () => {
  let memoryRecovery: ZeroTokenMemoryRecovery;

  beforeEach(() => {
    localStorageMock.clear();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    memoryRecovery = new ZeroTokenMemoryRecovery();
  });

  describe("ZeroTokenMemoryRecovery", () => {
    it("should initialize with default config", () => {
      expect(memoryRecovery.getConfig().enableMemoryRecovery).toBe(true);
      expect(memoryRecovery.getConfig().maxStoredSessions).toBe(10);
    });

    it("should snapshot memory", () => {
      const snapshot = memoryRecovery.snapshotMemory({
        sessionKey: "test-session",
        messages: [{ role: "user", content: "hello" }],
        promptTokens: 100,
        outputTokens: 50,
      });

      expect(snapshot.sessionKey).toBe("test-session");
      expect(snapshot.totalTokens).toBe(150);
      expect(snapshot.messages.length).toBeGreaterThan(0);
    });

    it("should compact large memory", () => {
      const messages = Array(200)
        .fill(null)
        .map((_, i) => ({ role: "user", content: `message ${i}` }));

      const snapshot = memoryRecovery.snapshotMemory({
        sessionKey: "large-session",
        messages,
        promptTokens: 100_000,
        outputTokens: 60_000,
      });

      expect(snapshot.context_summary).toBeDefined();
      expect(snapshot.messages.length).toBeLessThan(messages.length);
    });

    it("should store and retrieve memory", () => {
      const snapshot = memoryRecovery.snapshotMemory({
        sessionKey: "store-test",
        messages: [{ role: "user", content: "test" }],
        promptTokens: 50,
        outputTokens: 25,
      });

      memoryRecovery.storeMemory(snapshot);

      const retrieved = memoryRecovery.getMemory("store-test");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionKey).toBe("store-test");
    });

    it("should return null for non-existent memory", () => {
      const retrieved = memoryRecovery.getMemory("non-existent");
      expect(retrieved).toBeNull();
    });

    it("should prepare for disconnect", () => {
      const messages = [{ role: "user", content: "hello" }];
      memoryRecovery.prepareForDisconnect("disconnect-session", messages);

      expect(memoryRecovery.hasPendingRestore()).toBe(true);
    });

    it("should restore on reconnect", () => {
      const messages = [{ role: "user", content: "hello" }];
      memoryRecovery.prepareForDisconnect("reconnect-session", messages);

      const restored = memoryRecovery.restoreOnReconnect();

      expect(restored).not.toBeNull();
      expect(restored?.sessionKey).toBe("reconnect-session");
      expect(memoryRecovery.hasPendingRestore()).toBe(false);
    });

    it("should not restore if no pending", () => {
      const restored = memoryRecovery.restoreOnReconnect();
      expect(restored).toBeNull();
    });

    it("should clear memory", () => {
      const snapshot = memoryRecovery.snapshotMemory({
        sessionKey: "clear-test",
        messages: [{ role: "user", content: "test" }],
        promptTokens: 50,
        outputTokens: 25,
      });

      memoryRecovery.storeMemory(snapshot);
      memoryRecovery.clearMemory("clear-test");

      const retrieved = memoryRecovery.getMemory("clear-test");
      expect(retrieved).toBeNull();
    });

    it("should clear all memory", () => {
      const snapshot1 = memoryRecovery.snapshotMemory({
        sessionKey: "session-1",
        messages: [{ role: "user", content: "test1" }],
        promptTokens: 50,
        outputTokens: 25,
      });

      const snapshot2 = memoryRecovery.snapshotMemory({
        sessionKey: "session-2",
        messages: [{ role: "user", content: "test2" }],
        promptTokens: 60,
        outputTokens: 30,
      });

      memoryRecovery.storeMemory(snapshot1);
      memoryRecovery.storeMemory(snapshot2);

      expect(memoryRecovery.getStoredSessionCount()).toBe(2);

      memoryRecovery.clearAllMemory();

      expect(memoryRecovery.getStoredSessionCount()).toBe(0);
    });

    it("should respect max stored sessions", () => {
      const limitedRecovery = new ZeroTokenMemoryRecovery({ maxStoredSessions: 2 });

      for (let i = 0; i < 5; i++) {
        const snapshot = limitedRecovery.snapshotMemory({
          sessionKey: `session-${i}`,
          messages: [{ role: "user", content: `test${i}` }],
          promptTokens: 50,
          outputTokens: 25,
        });
        limitedRecovery.storeMemory(snapshot);
      }

      expect(limitedRecovery.getStoredSessionCount()).toBeLessThanOrEqual(2);
    });

    it("should prune old messages", () => {
      const messages = Array(150)
        .fill(null)
        .map((_, i) => ({ role: "user", content: `message ${i}` }));

      const snapshot = memoryRecovery.snapshotMemory({
        sessionKey: "prune-test",
        messages,
        promptTokens: 50,
        outputTokens: 25,
      });

      expect(snapshot.messages.length).toBeLessThanOrEqual(100);
    });

    it("should update config", () => {
      memoryRecovery.updateConfig({
        compactionThresholdTokens: 50_000,
        memoryTtlMs: 3 * 24 * 60 * 60 * 1000,
      });

      const config = memoryRecovery.getConfig();
      expect(config.compactionThresholdTokens).toBe(50_000);
      expect(config.memoryTtlMs).toBe(3 * 24 * 60 * 60 * 1000);
    });
  });

  describe("getZeroTokenMemoryRecovery", () => {
    it("should return singleton instance", () => {
      resetZeroTokenMemoryRecovery();
      const instance1 = getZeroTokenMemoryRecovery();
      const instance2 = getZeroTokenMemoryRecovery();
      expect(instance1).toBe(instance2);
    });

    it("should reset global recovery", () => {
      resetZeroTokenMemoryRecovery();
      const instance1 = getZeroTokenMemoryRecovery();
      resetZeroTokenMemoryRecovery();
      const instance2 = getZeroTokenMemoryRecovery();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_ZERO_TOKEN_MEMORY_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_ZERO_TOKEN_MEMORY_CONFIG.enableMemoryRecovery).toBe(true);
      expect(DEFAULT_ZERO_TOKEN_MEMORY_CONFIG.maxStoredSessions).toBe(10);
      expect(DEFAULT_ZERO_TOKEN_MEMORY_CONFIG.compactionThresholdTokens).toBe(150_000);
    });
  });
});
