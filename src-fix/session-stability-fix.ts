export type SessionStabilityConfig = {
  maxBufferSize: number;
  maxBufferAge: number;
  maxConcurrentRuns: number;
  bufferCleanupInterval: number;
  enableMetrics: boolean;
};

export const DEFAULT_STABILITY_CONFIG: SessionStabilityConfig = {
  maxBufferSize: 100 * 1024 * 1024,
  maxBufferAge: 30 * 60 * 1000,
  maxConcurrentRuns: 10,
  bufferCleanupInterval: 5 * 60 * 1000,
  enableMetrics: true,
};

export interface SessionMetrics {
  totalSessions: number;
  activeSessions: number;
  bufferSizeBytes: number;
  avgSessionAge: number;
  totalRuns: number;
  activeRuns: number;
  errors: number;
}

export class SessionStabilityMonitor {
  private buffers = new Map<string, { data: string; timestamp: number; runId: string }>();
  private runs = new Map<string, { sessionKey: string; startedAt: number; status: string }>();
  private metrics: SessionMetrics;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private config: SessionStabilityConfig;

  constructor(config: Partial<SessionStabilityConfig> = {}) {
    this.config = { ...DEFAULT_STABILITY_CONFIG, ...config };
    this.metrics = this.initMetrics();
    this.startCleanupTimer();
  }

  private initMetrics(): SessionMetrics {
    return {
      totalSessions: 0,
      activeSessions: 0,
      bufferSizeBytes: 0,
      avgSessionAge: 0,
      totalRuns: 0,
      activeRuns: 0,
      errors: 0,
    };
  }

  private startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.config.bufferCleanupInterval);
    this.cleanupTimer.unref?.();
  }

  registerSession(sessionKey: string): void {
    this.metrics.totalSessions++;
    this.metrics.activeSessions++;
  }

  unregisterSession(sessionKey: string): void {
    const sessions = Array.from(this.buffers.entries()).filter(
      ([, v]) => v.sessionKey === sessionKey
    );
    for (const [key] of sessions) {
      const entry = this.buffers.get(key);
      if (entry) {
        this.metrics.bufferSizeBytes -= entry.data.length;
        this.buffers.delete(key);
      }
    }
    this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
  }

  registerRun(runId: string, sessionKey: string): void {
    this.metrics.totalRuns++;
    this.metrics.activeRuns++;
    this.runs.set(runId, {
      sessionKey,
      startedAt: Date.now(),
      status: "active",
    });
  }

  unregisterRun(runId: string): void {
    this.runs.delete(runId);
    this.metrics.activeRuns = Math.max(0, this.metrics.activeRuns - 1);
  }

  updateBuffer(clientRunId: string, data: string, sessionKey: string, runId: string): boolean {
    const existing = this.buffers.get(clientRunId);
    if (existing) {
      this.metrics.bufferSizeBytes -= existing.data.length;
    }

    const newSize = this.metrics.bufferSizeBytes + data.length;
    if (newSize > this.config.maxBufferSize) {
      return false;
    }

    this.buffers.set(clientRunId, {
      data,
      timestamp: Date.now(),
      sessionKey,
      runId,
    });
    this.metrics.bufferSizeBytes = newSize;
    return true;
  }

  getBuffer(clientRunId: string): string | undefined {
    return this.buffers.get(clientRunId)?.data;
  }

  clearBuffer(clientRunId: string): void {
    const entry = this.buffers.get(clientRunId);
    if (entry) {
      this.metrics.bufferSizeBytes -= entry.data.length;
      this.buffers.delete(clientRunId);
    }
  }

  recordError(): void {
    this.metrics.errors++;
  }

  private performCleanup(): void {
    const now = Date.now();
    const maxAge = this.config.maxBufferAge;
    const toDelete: string[] = [];

    for (const [key, entry] of this.buffers) {
      if (now - entry.timestamp > maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      const entry = this.buffers.get(key);
      if (entry) {
        this.metrics.bufferSizeBytes -= entry.data.length;
        this.buffers.delete(key);
      }
    }

    const staleRuns: string[] = [];
    const staleThreshold = 60 * 60 * 1000;
    for (const [runId, run] of this.runs) {
      if (now - run.startedAt > staleThreshold && run.status === "completed") {
        staleRuns.push(runId);
      }
    }
    for (const runId of staleRuns) {
      this.runs.delete(runId);
    }

    if (toDelete.length > 0 || staleRuns.length > 0) {
      this.metrics.activeRuns = Math.max(0, this.metrics.activeRuns - staleRuns.length);
    }
  }

  getMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  checkHealth(): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];

    if (this.metrics.bufferSizeBytes > this.config.maxBufferSize * 0.9) {
      issues.push(`Buffer size critical: ${Math.round(this.metrics.bufferSizeBytes / 1024 / 1024)}MB`);
    }

    if (this.metrics.activeRuns > this.config.maxConcurrentRuns) {
      issues.push(`Too many active runs: ${this.metrics.activeRuns}`);
    }

    if (this.metrics.errors > 100) {
      issues.push(`Error count high: ${this.metrics.errors}`);
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buffers.clear();
    this.runs.clear();
  }
}

let globalStabilityMonitor: SessionStabilityMonitor | null = null;

export function getGlobalStabilityMonitor(): SessionStabilityMonitor {
  if (!globalStabilityMonitor) {
    globalStabilityMonitor = new SessionStabilityMonitor();
  }
  return globalStabilityMonitor;
}

export function resetGlobalStabilityMonitor(): void {
  if (globalStabilityMonitor) {
    globalStabilityMonitor.stop();
    globalStabilityMonitor = null;
  }
}
