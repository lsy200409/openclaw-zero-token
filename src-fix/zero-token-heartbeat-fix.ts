export interface ZeroTokenHeartbeatConfig {
  tickIntervalMs: number;
  tickTimeoutMultiplier: number;
  consecutiveMissesBeforeDisconnect: number;
  reconnectJitterMs: number;
  enableAdaptiveTimeout: boolean;
  minTickTimeoutMs: number;
  /** Extra tolerance multiplier applied when a conversation/stream is active.
   *  E.g. 2.0 means the timeout doubles during active sessions. */
  activeConversationTolerance?: number;
  /** How long (ms) since last conversation activity before we consider the
   *  session idle again.  Default: 120_000 (2 minutes). */
  activeConversationIdleMs?: number;
  /** Enable graduated response: warn → soft-probe → disconnect. */
  enableGraduatedResponse?: boolean;
  /** How many consecutive misses before sending a soft probe (ping). */
  missesBeforeSoftProbe?: number;
}

export const DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG: ZeroTokenHeartbeatConfig = {
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 3.0,
  consecutiveMissesBeforeDisconnect: 3,
  reconnectJitterMs: 2000,
  enableAdaptiveTimeout: true,
  minTickTimeoutMs: 60_000,
  activeConversationTolerance: 2.0,
  activeConversationIdleMs: 120_000,
  enableGraduatedResponse: true,
  missesBeforeSoftProbe: 1,
};

export type TickMissedSeverity = "warning" | "soft-probe" | "disconnect";

export class ZeroTokenHeartbeatManager {
  private lastTickTime: number = 0;
  private consecutiveMisses: number = 0;
  private tickIntervalMs: number;
  private tickTimeoutMs: number;
  private consecutiveMissesBeforeDisconnect: number;
  private reconnectJitterMs: number;
  private enableAdaptiveTimeout: boolean;
  private minTickTimeoutMs: number;
  private activeConversationTolerance: number;
  private activeConversationIdleMs: number;
  private enableGraduatedResponse: boolean;
  private missesBeforeSoftProbe: number;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private onTickMissedCallback?: (missedCount: number, severity: TickMissedSeverity) => void;
  private onTickTimeoutCallback?: () => void;
  private onSoftProbeCallback?: () => void;
  private sessionActive: boolean = true;
  /** Timestamp of last non-tick conversation activity (message, tool call, etc.) */
  private lastConversationActivity: number = 0;
  /** Whether a soft probe has been sent during the current miss streak */
  private softProbeSent: boolean = false;

  constructor(config: Partial<ZeroTokenHeartbeatConfig> = {}) {
    const finalConfig = { ...DEFAULT_ZERO_TOKEN_HEARTBEAT_CONFIG, ...config };
    this.tickIntervalMs = finalConfig.tickIntervalMs;
    this.consecutiveMissesBeforeDisconnect = finalConfig.consecutiveMissesBeforeDisconnect;
    this.reconnectJitterMs = finalConfig.reconnectJitterMs;
    this.enableAdaptiveTimeout = finalConfig.enableAdaptiveTimeout;
    this.minTickTimeoutMs = finalConfig.minTickTimeoutMs;
    this.activeConversationTolerance = finalConfig.activeConversationTolerance ?? 2.0;
    this.activeConversationIdleMs = finalConfig.activeConversationIdleMs ?? 120_000;
    this.enableGraduatedResponse = finalConfig.enableGraduatedResponse ?? true;
    this.missesBeforeSoftProbe = finalConfig.missesBeforeSoftProbe ?? 1;
    this.tickTimeoutMs = Math.max(
      this.minTickTimeoutMs,
      this.tickIntervalMs * finalConfig.tickTimeoutMultiplier,
    );
  }

  setOnTickMissed(callback: (missedCount: number, severity: TickMissedSeverity) => void): void {
    this.onTickMissedCallback = callback;
  }

  setOnTickTimeout(callback: () => void): void {
    this.onTickTimeoutCallback = callback;
  }

  /** Register a callback to be invoked when a soft probe (ping) should be sent. */
  setOnSoftProbe(callback: () => void): void {
    this.onSoftProbeCallback = callback;
  }

  recordTick(): void {
    this.lastTickTime = Date.now();
    this.consecutiveMisses = 0;
    this.softProbeSent = false;
  }

  /** Record that a conversation activity (message, tool call, stream data) occurred.
   *  This extends the tick timeout tolerance to avoid disconnecting during active use. */
  recordConversationActivity(): void {
    this.lastConversationActivity = Date.now();
  }

  setSessionActive(active: boolean): void {
    this.sessionActive = active;
    if (!active) {
      this.consecutiveMisses = 0;
      this.softProbeSent = false;
    }
  }

  /** Whether the session has had recent conversation activity and should get extra tolerance. */
  private isConversationActive(): boolean {
    if (this.lastConversationActivity === 0) {
      return false;
    }
    return Date.now() - this.lastConversationActivity < this.activeConversationIdleMs;
  }

  /** Effective tick timeout, extended when conversation is active. */
  private getEffectiveTickTimeoutMs(): number {
    const base = this.tickTimeoutMs;
    if (this.isConversationActive()) {
      return base * this.activeConversationTolerance;
    }
    return base;
  }

  start(): void {
    this.stop();
    this.lastTickTime = Date.now();
    this.consecutiveMisses = 0;
    this.softProbeSent = false;

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
    const effectiveTimeoutMs = this.getEffectiveTickTimeoutMs();

    if (timeSinceLastTick > effectiveTimeoutMs) {
      this.consecutiveMisses++;

      // Graduated response: determine severity
      const severity = this.resolveMissSeverity();

      this.onTickMissedCallback?.(this.consecutiveMisses, severity);

      // Soft probe: send a lightweight ping before disconnecting
      if (this.enableGraduatedResponse && severity === "soft-probe" && !this.softProbeSent) {
        this.softProbeSent = true;
        this.onSoftProbeCallback?.();
      }

      if (this.consecutiveMisses >= this.consecutiveMissesBeforeDisconnect) {
        this.stop();
        this.onTickTimeoutCallback?.();
      }
    } else if (timeSinceLastTick > this.tickIntervalMs) {
      this.consecutiveMisses++;

      const severity = this.resolveMissSeverity();
      this.onTickMissedCallback?.(this.consecutiveMisses, severity);
    }
  }

  /** Determine the severity level for the current miss count. */
  private resolveMissSeverity(): TickMissedSeverity {
    if (this.consecutiveMisses >= this.consecutiveMissesBeforeDisconnect) {
      return "disconnect";
    }
    if (this.enableGraduatedResponse && this.consecutiveMisses >= this.missesBeforeSoftProbe) {
      return "soft-probe";
    }
    return "warning";
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
    effectiveTickTimeoutMs: number;
    isConversationActive: boolean;
  } {
    return {
      lastTickAge: this.lastTickTime ? Date.now() - this.lastTickTime : -1,
      consecutiveMisses: this.consecutiveMisses,
      isActive: this.sessionActive,
      tickTimeoutMs: this.tickTimeoutMs,
      effectiveTickTimeoutMs: this.getEffectiveTickTimeoutMs(),
      isConversationActive: this.isConversationActive(),
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
