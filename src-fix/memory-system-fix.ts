export interface MemorySnapshot {
  sessionKey: string;
  timestamp: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  compactionCount: number;
  memoryFlushAt?: number;
}

export interface MemoryFlushConfig {
  enabled: boolean;
  reserveTokensFloor: number;
  softThresholdTokens: number;
  forceFlushTranscriptBytes?: number;
  memoryFlushIntervalMs: number;
  maxFlushRetries: number;
}

export const DEFAULT_MEMORY_FLUSH_CONFIG: MemoryFlushConfig = {
  enabled: true,
  reserveTokensFloor: 20_000,
  softThresholdTokens: 4_000,
  forceFlushTranscriptBytes: undefined,
  memoryFlushIntervalMs: 60_000,
  maxFlushRetries: 3,
};

export class MemoryStateTracker {
  private snapshots = new Map<string, MemorySnapshot>();
  private pendingFlushes = new Map<string, { attempts: number; lastAttempt: number }>();
  private config: MemoryFlushConfig;
  private onFlushCallback?: (sessionKey: string, snapshot: MemorySnapshot) => Promise<void>;

  constructor(config: Partial<MemoryFlushConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_FLUSH_CONFIG, ...config };
  }

  setOnFlushCallback(cb: (sessionKey: string, snapshot: MemorySnapshot) => Promise<void>): void {
    this.onFlushCallback = cb;
  }

  updateSnapshot(sessionKey: string, update: Partial<MemorySnapshot>): void {
    const existing = this.snapshots.get(sessionKey);
    const snapshot: MemorySnapshot = {
      sessionKey,
      timestamp: Date.now(),
      compactionCount: 0,
      ...existing,
      ...update,
    };
    this.snapshots.set(sessionKey, snapshot);
  }

  getSnapshot(sessionKey: string): MemorySnapshot | undefined {
    return this.snapshots.get(sessionKey);
  }

  async triggerFlush(sessionKey: string): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const pending = this.pendingFlushes.get(sessionKey);
    if (pending) {
      if (pending.attempts >= this.config.maxFlushRetries) {
        return false;
      }
      const timeSinceLastAttempt = Date.now() - pending.lastAttempt;
      if (timeSinceLastAttempt < this.config.memoryFlushIntervalMs) {
        return false;
      }
      pending.attempts++;
      pending.lastAttempt = Date.now();
    } else {
      this.pendingFlushes.set(sessionKey, { attempts: 1, lastAttempt: Date.now() });
    }

    const snapshot = this.snapshots.get(sessionKey);
    if (!snapshot) {
      return false;
    }

    if (this.onFlushCallback) {
      try {
        await this.onFlushCallback(sessionKey, snapshot);
        this.pendingFlushes.delete(sessionKey);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  shouldFlush(sessionKey: string): boolean {
    const snapshot = this.snapshots.get(sessionKey);
    if (!snapshot) {
      return false;
    }

    const projectedTokens = (snapshot.promptTokens ?? 0) + (snapshot.outputTokens ?? 0);
    const threshold = (snapshot.totalTokens ?? 0) - this.config.reserveTokensFloor;

    return projectedTokens >= threshold;
  }

  getPendingFlushCount(): number {
    return this.pendingFlushes.size;
  }

  clearSession(sessionKey: string): void {
    this.snapshots.delete(sessionKey);
    this.pendingFlushes.delete(sessionKey);
  }

  getConfig(): MemoryFlushConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<MemoryFlushConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

let globalMemoryTracker: MemoryStateTracker | null = null;

export function getGlobalMemoryTracker(): MemoryStateTracker {
  if (!globalMemoryTracker) {
    globalMemoryTracker = new MemoryStateTracker();
  }
  return globalMemoryTracker;
}

export function resetGlobalMemoryTracker(): void {
  globalMemoryTracker = null;
}

export function estimateTokenCount(text: string): number {
  const chars = text.length;
  const tokens = Math.ceil(chars / 4);
  return tokens;
}

export function createMemoryFlushGuard(params: {
  sessionKey: string;
  tracker: MemoryStateTracker;
  maxTokensPerFlush: number;
}) {
  let flushInProgress = false;
  let lastFlushAt = 0;

  const shouldFlush = (currentTokens: number): boolean => {
    if (flushInProgress) {
      return false;
    }
    if (currentTokens >= params.maxTokensPerFlush) {
      return true;
    }
    const timeSinceLastFlush = Date.now() - lastFlushAt;
    return timeSinceLastFlush > 60_000 && currentTokens > params.maxTokensPerFlush * 0.8;
  };

  const markFlushStarted = (): void => {
    flushInProgress = true;
  };

  const markFlushCompleted = (): void => {
    flushInProgress = false;
    lastFlushAt = Date.now();
  };

  return {
    shouldFlush,
    markFlushStarted,
    markFlushCompleted,
    get sessionKey() {
      return params.sessionKey;
    },
  };
}
