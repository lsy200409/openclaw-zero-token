import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  IdleDetector,
  SessionActivityTracker,
  getGlobalActivityTracker,
  resetGlobalActivityTracker,
  DEFAULT_IDLE_DETECTOR_CONFIG,
} from "./idle-detector.js";

describe("idle-detector", () => {
  describe("IdleDetector", () => {
    let detector: IdleDetector;

    beforeEach(() => {
      detector = new IdleDetector("test-session", {
        idleTimeoutMs: 100,
        checkIntervalMs: 10,
      });
    });

    afterEach(() => {
      detector.stop();
    });

    it("should initialize with config", () => {
      expect(detector.getStatus().isIdle).toBe(false);
      expect(detector.getStatus().isPaused).toBe(false);
      expect(detector.getStatus().sessionKey).toBe("test-session");
    });

    it("should record activity and reset idle state", () => {
      detector.start();

      detector.recordActivity("user_input");
      expect(detector.getStatus().isIdle).toBe(false);
      expect(detector.getStatus().consecutiveIdleChecks).toBe(0);
    });

    it("should trigger idle start after timeout", async () => {
      let idleStartCalled = false;
      detector.setEvents({
        onIdleStart: () => {
          idleStartCalled = true;
        },
      });

      detector.start();

      detector.recordActivity("user_input");
      detector.forceIdle();

      await new Promise((r) => setTimeout(r, 150));

      expect(idleStartCalled).toBe(true);
      expect(detector.getStatus().isIdle).toBe(true);
    });

    it("should trigger idle end when activity resumes", async () => {
      let idleEndCalled = false;
      detector.setEvents({
        onIdleStart: () => {},
        onIdleEnd: () => {
          idleEndCalled = true;
        },
      });

      detector.start();
      detector.forceIdle();

      await new Promise((r) => setTimeout(r, 50));

      detector.recordActivity("user_input");

      expect(idleEndCalled).toBe(true);
      expect(detector.getStatus().isIdle).toBe(false);
    });

    it("should pause and resume", () => {
      detector.start();
      expect(detector.getStatus().isPaused).toBe(false);

      detector.pause();
      expect(detector.getStatus().isPaused).toBe(true);

      detector.resume();
      expect(detector.getStatus().isPaused).toBe(false);
    });

    it("should call onActivity callback", () => {
      let activityType: string | undefined;
      detector.setEvents({
        onActivity: (type) => {
          activityType = type;
        },
      });

      detector.recordActivity("ai_response");

      expect(activityType).toBe("ai_response");
    });

    it("should use default config", () => {
      const defaultDetector = new IdleDetector("default-test");
      expect(defaultDetector.getStatus().sessionKey).toBe("default-test");
      defaultDetector.stop();
    });

    it("should update config", () => {
      detector.updateConfig({ idleTimeoutMs: 500 });
      expect(detector.getStatus().lastActivityAge).toBeLessThan(100);
    });
  });

  describe("SessionActivityTracker", () => {
    let tracker: SessionActivityTracker;

    beforeEach(() => {
      tracker = new SessionActivityTracker();
    });

    afterEach(() => {
      for (const [key] of tracker["activeDetectors"]) {
        tracker.removeDetector(key);
      }
    });

    it("should create detector for session", () => {
      const detector = tracker.createDetector("session-1");
      expect(detector).toBeInstanceOf(IdleDetector);
      expect(tracker.getActiveSessionCount()).toBe(1);
    });

    it("should get detector by session key", () => {
      tracker.createDetector("session-1");
      const detector = tracker.getDetector("session-1");
      expect(detector).toBeInstanceOf(IdleDetector);
    });

    it("should return undefined for non-existent detector", () => {
      const detector = tracker.getDetector("non-existent");
      expect(detector).toBeUndefined();
    });

    it("should remove detector", () => {
      tracker.createDetector("session-1");
      tracker.removeDetector("session-1");
      expect(tracker.getActiveSessionCount()).toBe(0);
    });

    it("should record activity for session", () => {
      const detector = tracker.createDetector("session-1");
      const spy = vi.spyOn(detector, "recordActivity");

      tracker.recordActivity("session-1", "tool_execution");

      expect(spy).toHaveBeenCalledWith("tool_execution");
    });

    it("should notify global idle callback", async () => {
      let notifiedSession = "";
      tracker.onAnySessionIdle((sessionKey) => {
        notifiedSession = sessionKey;
      });

      const detector = tracker.createDetector("idle-session", {
        idleTimeoutMs: 50,
        checkIntervalMs: 10,
      });

      detector.start();
      detector.forceIdle();

      await new Promise((r) => setTimeout(r, 100));

      expect(notifiedSession).toBe("idle-session");
    });

    it("should get all statuses", () => {
      tracker.createDetector("session-1");
      tracker.createDetector("session-2");

      const statuses = tracker.getAllStatuses();
      expect(statuses).toHaveLength(2);
    });

    it("should unsubscribe from global idle callback", () => {
      let callCount = 0;
      const unsubscribe = tracker.onAnySessionIdle(() => {
        callCount++;
      });

      unsubscribe();

      const detector = tracker.createDetector("session-1", {
        idleTimeoutMs: 50,
        checkIntervalMs: 10,
      });
      detector.start();
      detector.forceIdle();
    });
  });

  describe("getGlobalActivityTracker", () => {
    it("should return singleton instance", () => {
      resetGlobalActivityTracker();
      const instance1 = getGlobalActivityTracker();
      const instance2 = getGlobalActivityTracker();
      expect(instance1).toBe(instance2);
    });

    it("should reset global tracker", () => {
      resetGlobalActivityTracker();
      const instance1 = getGlobalActivityTracker();
      resetGlobalActivityTracker();
      const instance2 = getGlobalActivityTracker();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("DEFAULT_IDLE_DETECTOR_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_IDLE_DETECTOR_CONFIG.idleTimeoutMs).toBe(5000);
      expect(DEFAULT_IDLE_DETECTOR_CONFIG.checkIntervalMs).toBe(500);
      expect(DEFAULT_IDLE_DETECTOR_CONFIG.enableAdaptiveTimeout).toBe(true);
    });
  });
});
