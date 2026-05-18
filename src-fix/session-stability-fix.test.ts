import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionStabilityMonitor,
  getGlobalStabilityMonitor,
  resetGlobalStabilityMonitor,
  DEFAULT_STABILITY_CONFIG,
  type SessionStabilityConfig,
} from "./session-stability-fix.js";

describe("session-stability-fix", () => {
  let monitor: SessionStabilityMonitor;

  beforeEach(() => {
    monitor = new SessionStabilityMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  describe("SessionStabilityMonitor", () => {
    it("should initialize with default config", () => {
      expect(monitor.getMetrics().totalSessions).toBe(0);
      expect(monitor.getMetrics().activeSessions).toBe(0);
      expect(monitor.getMetrics().bufferSizeBytes).toBe(0);
    });

    it("should register and track sessions", () => {
      monitor.registerSession("session-1");
      monitor.registerSession("session-2");
      const metrics = monitor.getMetrics();
      expect(metrics.totalSessions).toBe(2);
      expect(metrics.activeSessions).toBe(2);
    });

    it("should unregister sessions and clean up buffers", () => {
      monitor.registerSession("session-1");
      monitor.updateBuffer("run-1", "test data", "session-1", "agent-1");
      monitor.unregisterSession("session-1");
      const metrics = monitor.getMetrics();
      expect(metrics.activeSessions).toBe(0);
    });

    it("should register and track runs", () => {
      monitor.registerRun("run-1", "session-1");
      monitor.registerRun("run-2", "session-1");
      const metrics = monitor.getMetrics();
      expect(metrics.totalRuns).toBe(2);
      expect(metrics.activeRuns).toBe(2);
    });

    it("should unregister runs", () => {
      monitor.registerRun("run-1", "session-1");
      monitor.unregisterRun("run-1");
      const metrics = monitor.getMetrics();
      expect(metrics.activeRuns).toBe(0);
    });

    it("should update and retrieve buffers", () => {
      monitor.updateBuffer("run-1", "test content", "session-1", "agent-1");
      const buffer = monitor.getBuffer("run-1");
      expect(buffer).toBe("test content");
    });

    it("should reject buffers exceeding max size", () => {
      const smallConfig: Partial<SessionStabilityConfig> = {
        maxBufferSize: 10,
      };
      const smallMonitor = new SessionStabilityMonitor(smallConfig);
      const result = smallMonitor.updateBuffer("run-1", "this is too long", "session-1", "agent-1");
      expect(result).toBe(false);
      smallMonitor.stop();
    });

    it("should clear buffers", () => {
      monitor.updateBuffer("run-1", "test content", "session-1", "agent-1");
      monitor.clearBuffer("run-1");
      const buffer = monitor.getBuffer("run-1");
      expect(buffer).toBeUndefined();
    });

    it("should record errors", () => {
      monitor.recordError();
      monitor.recordError();
      const metrics = monitor.getMetrics();
      expect(metrics.errors).toBe(2);
    });

    it("should check health status", () => {
      const health = monitor.checkHealth();
      expect(health.healthy).toBe(true);
      expect(health.issues).toHaveLength(0);
    });

    it("should detect unhealthy state", () => {
      const smallConfig: SessionStabilityConfig = {
        maxBufferSize: 100,
        maxBufferAge: 1000,
        maxConcurrentRuns: 2,
        bufferCleanupInterval: 1000,
        enableMetrics: true,
      };
      const smallMonitor = new SessionStabilityMonitor(smallConfig);
      for (let i = 0; i < 5; i++) {
        smallMonitor.registerRun(`run-${i}`, "session-1");
      }
      const health = smallMonitor.checkHealth();
      expect(health.healthy).toBe(false);
      expect(health.issues.length).toBeGreaterThan(0);
      smallMonitor.stop();
    });
  });

  describe("getGlobalStabilityMonitor", () => {
    it("should return singleton instance", () => {
      resetGlobalStabilityMonitor();
      const instance1 = getGlobalStabilityMonitor();
      const instance2 = getGlobalStabilityMonitor();
      expect(instance1).toBe(instance2);
    });

    it("should reset global monitor", () => {
      resetGlobalStabilityMonitor();
      const instance1 = getGlobalStabilityMonitor();
      resetGlobalStabilityMonitor();
      const instance2 = getGlobalStabilityMonitor();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_STABILITY_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_STABILITY_CONFIG.maxBufferSize).toBeGreaterThan(0);
      expect(DEFAULT_STABILITY_CONFIG.maxBufferAge).toBeGreaterThan(0);
      expect(DEFAULT_STABILITY_CONFIG.maxConcurrentRuns).toBeGreaterThan(0);
      expect(DEFAULT_STABILITY_CONFIG.bufferCleanupInterval).toBeGreaterThan(0);
    });
  });
});
