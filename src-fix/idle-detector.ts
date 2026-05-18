export interface IdleDetectorConfig {
  idleTimeoutMs: number;
  checkIntervalMs: number;
  maxIdlePeriodsBeforeWarn: number;
  enableAdaptiveTimeout: boolean;
}

export const DEFAULT_IDLE_DETECTOR_CONFIG: IdleDetectorConfig = {
  idleTimeoutMs: 5000,
  checkIntervalMs: 500,
  maxIdlePeriodsBeforeWarn: 10,
  enableAdaptiveTimeout: true,
};

export type SessionActivityType =
  | "user_input"
  | "ai_response"
  | "tool_execution"
  | "system_event"
  | "manual_trigger";

export interface IdleDetectorEvents {
  onIdleStart: () => void;
  onIdleEnd: () => void;
  onIdleTimeout: () => void;
  onActivity: (type: SessionActivityType) => void;
}

export class IdleDetector {
  private lastActivityTime: number = Date.now();
  private isIdle: boolean = false;
  private isPaused: boolean = false;
  private consecutiveIdleChecks: number = 0;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private config: IdleDetectorConfig;
  private events: Partial<IdleDetectorEvents> = {};
  private sessionKey: string;

  constructor(
    sessionKey: string,
    config: Partial<IdleDetectorConfig> = {},
    events: Partial<IdleDetectorEvents> = {}
  ) {
    this.sessionKey = sessionKey;
    this.config = { ...DEFAULT_IDLE_DETECTOR_CONFIG, ...config };
    this.events = events;
  }

  setEvents(events: Partial<IdleDetectorEvents>): void {
    this.events = { ...this.events, ...events };
  }

  recordActivity(type: SessionActivityType = "system_event"): void {
    this.lastActivityTime = Date.now();

    if (this.isIdle) {
      this.isIdle = false;
      this.consecutiveIdleChecks = 0;
      this.events.onIdleEnd?.();
    }

    this.events.onActivity?.(type);
  }

  pause(): void {
    this.isPaused = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  resume(): void {
    this.isPaused = false;
    this.lastActivityTime = Date.now();
    this.startChecking();
  }

  start(): void {
    this.isPaused = false;
    this.lastActivityTime = Date.now();
    this.isIdle = false;
    this.consecutiveIdleChecks = 0;
    this.startChecking();
  }

  stop(): void {
    this.isPaused = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private startChecking(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    this.checkTimer = setInterval(() => {
      this.checkIdleStatus();
    }, this.config.checkIntervalMs);

    this.checkTimer.unref?.();
  }

  private checkIdleStatus(): void {
    if (this.isPaused) {
      return;
    }

    const now = Date.now();
    const idleTime = now - this.lastActivityTime;

    if (idleTime >= this.config.idleTimeoutMs) {
      if (!this.isIdle) {
        this.isIdle = true;
        this.consecutiveIdleChecks = 0;
        this.events.onIdleStart?.();
      }

      this.consecutiveIdleChecks++;

      const effectiveTimeout = this.getEffectiveTimeout();
      if (idleTime >= effectiveTimeout) {
        this.events.onIdleTimeout?.();
      }

      if (this.consecutiveIdleChecks >= this.config.maxIdlePeriodsBeforeWarn) {
        this.consecutiveIdleChecks = 0;
      }
    }
  }

  private getEffectiveTimeout(): number {
    if (!this.config.enableAdaptiveTimeout) {
      return this.config.idleTimeoutMs;
    }

    const multiplier = Math.min(1 + this.consecutiveIdleChecks * 0.1, 2);
    return this.config.idleTimeoutMs * multiplier;
  }

  forceIdle(): void {
    this.lastActivityTime = Date.now() - this.config.idleTimeoutMs * 2;
    this.checkIdleStatus();
  }

  getStatus(): {
    isIdle: boolean;
    isPaused: boolean;
    lastActivityAge: number;
    consecutiveIdleChecks: number;
    sessionKey: string;
  } {
    return {
      isIdle: this.isIdle,
      isPaused: this.isPaused,
      lastActivityAge: Date.now() - this.lastActivityTime,
      consecutiveIdleChecks: this.consecutiveIdleChecks,
      sessionKey: this.sessionKey,
    };
  }

  updateConfig(config: Partial<IdleDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export class SessionActivityTracker {
  private activeDetectors = new Map<string, IdleDetector>();
  private globalIdleCallbacks: Array<(sessionKey: string) => void> = [];
  private allIdleCallbacks: Array<() => void> = [];

  createDetector(
    sessionKey: string,
    config?: Partial<IdleDetectorConfig>,
    events?: Partial<IdleDetectorEvents>
  ): IdleDetector {
    const detector = new IdleDetector(sessionKey, config, events);

    detector.setEvents({
      onIdleStart: () => {
        events?.onIdleStart?.();
      },
      onIdleEnd: () => {
        events?.onIdleEnd?.();
      },
      onIdleTimeout: () => {
        this.notifyGlobalIdle(sessionKey);
        events?.onIdleTimeout?.();
      },
      onActivity: (type) => {
        events?.onActivity?.(type);
      },
    });

    this.activeDetectors.set(sessionKey, detector);
    return detector;
  }

  getDetector(sessionKey: string): IdleDetector | undefined {
    return this.activeDetectors.get(sessionKey);
  }

  removeDetector(sessionKey: string): void {
    const detector = this.activeDetectors.get(sessionKey);
    if (detector) {
      detector.stop();
      this.activeDetectors.delete(sessionKey);
    }
  }

  onAnySessionIdle(callback: (sessionKey: string) => void): () => void {
    this.globalIdleCallbacks.push(callback);
    return () => {
      const index = this.globalIdleCallbacks.indexOf(callback);
      if (index !== -1) {
        this.globalIdleCallbacks.splice(index, 1);
      }
    };
  }

  onAllSessionsIdle(callback: () => void): () => void {
    this.allIdleCallbacks.push(callback);
    return () => {
      const index = this.allIdleCallbacks.indexOf(callback);
      if (index !== -1) {
        this.allIdleCallbacks.splice(index, 1);
      }
    };
  }

  private notifyGlobalIdle(sessionKey: string): void {
    for (const callback of this.globalIdleCallbacks) {
      try {
        callback(sessionKey);
      } catch {}
    }

    const allIdle = Array.from(this.activeDetectors.values()).every((d) => d.getStatus().isIdle);
    if (allIdle && this.activeDetectors.size > 0) {
      for (const callback of this.allIdleCallbacks) {
        try {
          callback();
        } catch {}
      }
    }
  }

  recordActivity(sessionKey: string, type?: SessionActivityType): void {
    const detector = this.activeDetectors.get(sessionKey);
    detector?.recordActivity(type ?? "system_event");
  }

  getActiveSessionCount(): number {
    return this.activeDetectors.size;
  }

  getAllStatuses(): Array<{ sessionKey: string; status: ReturnType<IdleDetector["getStatus"]> }> {
    return Array.from(this.activeDetectors.entries()).map(([sessionKey, detector]) => ({
      sessionKey,
      status: detector.getStatus(),
    }));
  }
}

let globalActivityTracker: SessionActivityTracker | null = null;

export function getGlobalActivityTracker(): SessionActivityTracker {
  if (!globalActivityTracker) {
    globalActivityTracker = new SessionActivityTracker();
  }
  return globalActivityTracker;
}

export function resetGlobalActivityTracker(): void {
  if (globalActivityTracker) {
    Array.from(globalActivityTracker["activeDetectors"].keys()).forEach((sessionKey) => {
      globalActivityTracker!.removeDetector(sessionKey);
    });
    globalActivityTracker = null;
  }
}
