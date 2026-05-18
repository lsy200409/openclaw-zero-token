import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ZeroTokenHeartbeatManager,
  getZeroTokenHeartbeatManager,
  resetZeroTokenHeartbeatManager,
  DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG,
} from "./zero-token-heartbeat-fix.js";

describe("zero-token-heartbeat-fix", () => {
  let manager: ZeroTokenHeartbeatManager;

  beforeEach(() => {
    manager = new ZeroTokenHeartbeatManager();
  });

  afterEach(() => {
    manager.stop();
  });

  describe("ZeroTokenHeartbeatManager", () => {
    it("should initialize with default config", () => {
      expect(manager.getStatus().isActive).toBe(true);
      expect(manager.getStatus().consecutiveMisses).toBe(0);
    });

    it("should record tick and reset miss count", () => {
      manager.recordTick();
      expect(manager.getStatus().consecutiveMisses).toBe(0);
    });

    it("should stop and start properly", () => {
      manager.start();
      expect(manager.getStatus().isActive).toBe(true);

      manager.stop();
      expect(manager.getStatus().isActive).toBe(false);
    });

    it("should set session active state", () => {
      manager.setSessionActive(false);
      expect(manager.getStatus().isActive).toBe(false);

      manager.setSessionActive(true);
      expect(manager.getStatus().isActive).toBe(true);
    });

    it("should calculate reconnect delay with jitter", () => {
      const delay1 = manager.calculateReconnectDelay(0);
      const delay2 = manager.calculateReconnectDelay(0);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay2).toBeGreaterThanOrEqual(1000);
    });

    it("should use custom config", () => {
      const customManager = new ZeroTokenHeartbeatManager({
        tickIntervalMs: 60_000,
        tickTimeoutMultiplier: 4.0,
        consecutiveMissesBeforeDisconnect: 5,
      });

      expect(customManager.getTickTimeoutMs()).toBe(240_000);
      customManager.stop();
    });

    it("should respect minimum tick timeout", () => {
      const customManager = new ZeroTokenHeartbeatManager({
        tickIntervalMs: 10_000,
        tickTimeoutMultiplier: 1.5,
        minTickTimeoutMs: 60_000,
      });

      expect(customManager.getTickTimeoutMs()).toBe(60_000);
      customManager.stop();
    });

    it("should call tick missed callback", () => {
      let missedCount = -1;
      manager.setOnTickMissedCallback((count) => {
        missedCount = count;
      });

      manager.start();
      manager.recordTick();

      manager.setSessionActive(false);
      manager.setSessionActive(true);

      manager.stop();
    });

    it("should call tick timeout callback", () => {
      let timeoutCalled = false;
      manager.setOnTickTimeoutCallback(() => {
        timeoutCalled = true;
      });

      manager.start();
      manager.recordTick();

      manager.stop();
    });
  });

  describe("getZeroTokenHeartbeatManager", () => {
    it("should return singleton instance", () => {
      resetZeroTokenHeartbeatManager();
      const instance1 = getZeroTokenHeartbeatManager();
      const instance2 = getZeroTokenHeartbeatManager();
      expect(instance1).toBe(instance2);
    });

    it("should reset global manager", () => {
      resetZeroTokenHeartbeatManager();
      const instance1 = getZeroTokenHeartbeatManager();
      resetZeroTokenHeartbeatManager();
      const instance2 = getZeroTokenHeartbeatManager();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG.tickIntervalMs).toBe(30_000);
      expect(DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG.tickTimeoutMultiplier).toBe(3.0);
      expect(DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG.consecutiveMissesBeforeDisconnect).toBe(3);
      expect(DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG.minTickTimeoutMs).toBe(60_000);
    });
  });
});
