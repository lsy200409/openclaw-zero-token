export interface ZeroTokenHeartbeatConfig {
  tickIntervalMs: number;
  tickTimeoutMultiplier: number;
  consecutiveMissesBeforeDisconnect: number;
  reconnectJitterMs: number;
  enableAdaptiveTimeout: boolean;
  minTickTimeoutMs: number;
}

export const DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG: ZeroTokenHeartbeatConfig = {
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 3.0,
  consecutiveMissesBeforeDisconnect: 3,
  reconnectJitterMs: 2000,
  enableAdaptiveTimeout: true,
  minTickTimeoutMs: 60_000,
};

export class ZeroTokenHeartbeatManager {
  private lastTickTime: number = 0;
  private consecutiveMisses: number = 0;
  private tickIntervalMs: number;
  private tickTimeoutMs: number;
  private consecutiveMissesBeforeDisconnect: number;
  private reconnectJitterMs: number;
  private enableAdaptiveTimeout: boolean;
  private minTickTimeoutMs: number;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private onTickMissedCallback?: (missedCount: number) => void;
  private onTickTimeoutCallback?: () => void;
  private sessionActive: boolean = true;

  constructor(config: Partial<ZeroTokenHeartbeatConfig> = {}) {
    const finalConfig = { ...DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG, ...config };
    this.tickIntervalMs = finalConfig.tickIntervalMs;
    this.consecutiveMissesBeforeDisconnect = finalConfig.consecutiveMissesBeforeDisconnect;
    this.reconnectJitterMs = finalConfig.reconnectJitterMs;
    this.enableAdaptiveTimeout = finalConfig.enableAdaptiveTimeout;
    this.minTickTimeoutMs = finalConfig.minTickTimeoutMs;
    this.tickTimeoutMs = Math.max(
      this.minTickTimeoutMs,
      this.tickIntervalMs * finalConfig.tickTimeoutMultiplier
    );
  }

  setOnTickMissed(callback: (missedCount: number) => void): void {
    this.onTickMissedCallback = callback;
  }

  setOnTickTimeout(callback: () => void): void {
    this.onTickTimeoutCallback = callback;
  }

  recordTick(): void {
    this.lastTickTime = Date.now();
    this.consecutiveMisses = 0;
  }

  setSessionActive(active: boolean): void {
    this.sessionActive = active;
    if (!active) {
      this.consecutiveMisses = 0;
    }
  }

  start(): void {
    this.stop();
    this.lastTickTime = Date.now();
    this.consecutiveMisses = 0;

    const checkInterval = Math.min(this.tickIntervalMs, 5000);

    this.watchdogTimer = setInterval(() => {
      this.checkTickStatus();
    }, checkInterval);
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private checkTickStatus(): void {
    if (!this.sessionActive) {
      return;
    }

    const now = Date.now();
    const timeSinceLastTick = now - this.lastTickTime;

    if (timeSinceLastTick > this.tickTimeoutMs) {
      this.consecutiveMisses++;

      this.onTickMissedCallback?.(this.consecutiveMisses);

      if (this.consecutiveMisses >= this.consecutiveMissesBeforeDisconnect) {
        this.stop();
        this.onTickTimeoutCallback?.();
      }
    } else if (timeSinceLastTick > this.tickIntervalMs) {
      this.consecutiveMisses++;
      this.onTickMissedCallback?.(this.consecutiveMisses);
    }
  }

  calculateReconnectDelay(attempt: number): number {
    const baseDelay = Math.min(this.tickIntervalMs * Math.pow(1.5, attempt), 120_000);
    const jitter = (Math.random() - 0.5) * 2 * this.reconnectJitterMs;
    return Math.max(1000, baseDelay + jitter);
  }

  getStatus(): {
    lastTickAge: number;
    consecutiveMisses: number;
    isActive: boolean;
    tickTimeoutMs: number;
  } {
    return {
      lastTickAge: this.lastTickTime ? Date.now() - this.lastTickTime : -1,
      consecutiveMisses: this.consecutiveMisses,
      isActive: this.sessionActive,
      tickTimeoutMs: this.tickTimeoutMs,
    };
  }

  getTickTimeoutMs(): number {
    return this.tickTimeoutMs;
  }
}

let globalHeartbeatManager: ZeroTokenHeartbeatManager | null = null;

export function getZeroTokenHeartbeatManager(): ZeroTokenHeartbeatManager {
  if (!globalHeartbeatManager) {
    globalHeartbeatManager = new ZeroTokenHeartbeatManager();
  }
  return globalHeartbeatManager;
}

export function resetZeroTokenHeartbeatManager(): void {
  if (globalHeartbeatManager) {
    globalHeartbeatManager.stop();
    globalHeartbeatManager = null;
  }
}
