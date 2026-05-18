import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ZeroTokenSessionRecovery,
  getZeroTokenSessionRecovery,
  resetZeroTokenSessionRecovery,
  DEFAULT_SESSION_RECOVERY_CONFIG,
} from "./zero-token-session-recovery.js";

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

describe("zero-token-session-recovery", () => {
  let recovery: ZeroTokenSessionRecovery;

  beforeEach(() => {
    localStorageMock.clear();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    recovery = new ZeroTokenSessionRecovery();
  });

  describe("ZeroTokenSessionRecovery", () => {
    it("should initialize with default config", () => {
      expect(recovery.getConfig().enableSessionRecovery).toBe(true);
      expect(recovery.getConfig().maxRecoveryAttempts).toBe(3);
    });

    it("should create snapshot", () => {
      const snapshot = recovery.createSnapshot({
        sessionKey: "test-session",
        runId: "run-123",
        chatMessages: [{ role: "user", content: "hello" }],
        chatAttachments: [],
      });

      expect(snapshot.sessionKey).toBe("test-session");
      expect(snapshot.runId).toBe("run-123");
      expect(snapshot.connectionState).toBe("connected");
    });

    it("should mark disconnected", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      recovery.markDisconnected();

      const snapshot = recovery.getCurrentSnapshot();
      expect(snapshot?.connectionState).toBe("disconnected");
    });

    it("should mark reconnecting", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      recovery.markReconnecting();

      const snapshot = recovery.getCurrentSnapshot();
      expect(snapshot?.connectionState).toBe("reconnecting");
    });

    it("should mark reconnected and reset attempts", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      recovery.markReconnecting();
      recovery.markReconnecting();
      recovery.markReconnected();

      const snapshot = recovery.getCurrentSnapshot();
      expect(snapshot?.connectionState).toBe("connected");
    });

    it("should check if recovery is possible", () => {
      expect(recovery.canAttemptRecovery()).toBe(false);

      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      expect(recovery.canAttemptRecovery()).toBe(true);
    });

    it("should limit recovery attempts", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      for (let i = 0; i < 3; i++) {
        recovery.markReconnecting();
      }

      expect(recovery.canAttemptRecovery()).toBe(false);
    });

    it("should get restorable messages", () => {
      const messages = [{ role: "user", content: "hello" }];
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: messages,
        chatAttachments: [],
      });

      const restorable = recovery.getRestorableMessages();
      expect(restorable.messages).toEqual(messages);
    });

    it("should detect stale session", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      expect(recovery.isSessionStale()).toBe(false);
    });

    it("should clear recovery data", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [],
        chatAttachments: [],
      });

      recovery.clearRecoveryData();

      expect(recovery.getCurrentSnapshot()).toBeNull();
      expect(recovery.getRecoverySessionKey()).toBeNull();
    });

    it("should persist session to localStorage", () => {
      recovery.createSnapshot({
        sessionKey: "persist-session",
        runId: null,
        chatMessages: [{ role: "user", content: "test" }],
        chatAttachments: [],
      });

      expect(localStorageMock.setItem).toHaveBeenCalled();
    });

    it("should update snapshot messages", () => {
      recovery.createSnapshot({
        sessionKey: "test-session",
        runId: null,
        chatMessages: [{ role: "user", content: "original" }],
        chatAttachments: [],
      });

      recovery.updateSnapshotMessages(
        [{ role: "user", content: "updated" }],
        []
      );

      const snapshot = recovery.getCurrentSnapshot();
      expect(snapshot?.chatMessages).toHaveLength(1);
      expect((snapshot?.chatMessages[0] as { content: string }).content).toBe("updated");
    });
  });

  describe("getZeroTokenSessionRecovery", () => {
    it("should return singleton instance", () => {
      resetZeroTokenSessionRecovery();
      const instance1 = getZeroTokenSessionRecovery();
      const instance2 = getZeroTokenSessionRecovery();
      expect(instance1).toBe(instance2);
    });

    it("should reset global recovery", () => {
      resetZeroTokenSessionRecovery();
      const instance1 = getZeroTokenSessionRecovery();
      resetZeroTokenSessionRecovery();
      const instance2 = getZeroTokenSessionRecovery();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_SESSION_RECOVERY_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_SESSION_RECOVERY_CONFIG.enableSessionRecovery).toBe(true);
      expect(DEFAULT_SESSION_RECOVERY_CONFIG.maxRecoveryAttempts).toBe(3);
      expect(DEFAULT_SESSION_RECOVERY_CONFIG.preserveChatHistoryOnDisconnect).toBe(true);
    });
  });
});
