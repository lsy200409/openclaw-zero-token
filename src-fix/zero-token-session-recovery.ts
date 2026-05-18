export interface SessionRecoveryConfig {
  enableSessionRecovery: boolean;
  sessionKeyPersistenceKey: string;
  maxRecoveryAttempts: number;
  recoveryTimeoutMs: number;
  preserveChatHistoryOnDisconnect: boolean;
  autoRestoreSession: boolean;
}

export const DEFAULT_SESSION_RECOVERY_CONFIG: SessionRecoveryConfig = {
  enableSessionRecovery: true,
  sessionKeyPersistenceKey: "zero_token_last_session_key",
  maxRecoveryAttempts: 3,
  recoveryTimeoutMs: 30_000,
  preserveChatHistoryOnDisconnect: true,
  autoRestoreSession: true,
};

export interface SessionSnapshot {
  sessionKey: string;
  runId: string | null;
  chatMessages: unknown[];
  chatAttachments: unknown[];
  lastActiveAt: number;
  connectionState: "connected" | "disconnected" | "reconnecting";
  gatewayConnId?: string;
}

export class ZeroTokenSessionRecovery {
  private config: SessionRecoveryConfig;
  private currentSnapshot: SessionSnapshot | null = null;
  private previousMessages: unknown[] = [];
  private previousAttachments: unknown[] = [];
  private recoveryAttempts: number = 0;

  constructor(config: Partial<SessionRecoveryConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_RECOVERY_CONFIG, ...config };
    this.loadSavedSession();
  }

  private loadSavedSession(): void {
    try {
      const saved = localStorage.getItem(this.config.sessionKeyPersistenceKey);
      if (saved) {
        const parsed = JSON.parse(saved) as SessionSnapshot;
        if (parsed && parsed.sessionKey) {
          this.currentSnapshot = parsed;
        }
      }
    } catch {
      this.currentSnapshot = null;
    }
  }

  private saveSession(): void {
    if (!this.config.enableSessionRecovery || !this.currentSnapshot) {
      return;
    }
    try {
      localStorage.setItem(
        this.config.sessionKeyPersistenceKey,
        JSON.stringify(this.currentSnapshot)
      );
    } catch {}
  }

  createSnapshot(params: {
    sessionKey: string;
    runId: string | null;
    chatMessages: unknown[];
    chatAttachments: unknown[];
    gatewayConnId?: string;
  }): SessionSnapshot {
    const snapshot: SessionSnapshot = {
      sessionKey: params.sessionKey,
      runId: params.runId,
      chatMessages: [...params.chatMessages],
      chatAttachments: [...params.chatAttachments],
      lastActiveAt: Date.now(),
      connectionState: "connected",
      gatewayConnId: params.gatewayConnId,
    };

    if (
      this.config.preserveChatHistoryOnDisconnect &&
      this.currentSnapshot &&
      this.currentSnapshot.connectionState === "disconnected"
    ) {
      this.previousMessages = this.currentSnapshot.chatMessages;
      this.previousAttachments = this.currentSnapshot.chatAttachments;
    }

    this.currentSnapshot = snapshot;
    this.saveSession();
    return snapshot;
  }

  markDisconnected(): void {
    if (this.currentSnapshot) {
      this.currentSnapshot.connectionState = "disconnected";
      this.currentSnapshot.lastActiveAt = Date.now();
      this.saveSession();
    }
  }

  markReconnecting(): void {
    if (this.currentSnapshot) {
      this.currentSnapshot.connectionState = "reconnecting";
      this.currentSnapshot.lastActiveAt = Date.now();
      this.saveSession();
    }
    this.recoveryAttempts++;
  }

  markReconnected(gatewayConnId?: string): void {
    if (this.currentSnapshot) {
      this.currentSnapshot.connectionState = "connected";
      this.currentSnapshot.lastActiveAt = Date.now();
      if (gatewayConnId) {
        this.currentSnapshot.gatewayConnId = gatewayConnId;
      }
      this.recoveryAttempts = 0;
      this.saveSession();
    }
  }

  canAttemptRecovery(): boolean {
    return (
      this.config.enableSessionRecovery &&
      this.currentSnapshot !== null &&
      this.recoveryAttempts < this.config.maxRecoveryAttempts
    );
  }

  getRecoverySessionKey(): string | null {
    return this.currentSnapshot?.sessionKey ?? null;
  }

  getRestorableMessages(): { messages: unknown[]; attachments: unknown[] } {
    if (
      this.currentSnapshot &&
      this.currentSnapshot.connectionState === "disconnected" &&
      this.config.preserveChatHistoryOnDisconnect
    ) {
      return {
        messages: this.previousMessages.length > 0 ? this.previousMessages : this.currentSnapshot.chatMessages,
        attachments: this.previousAttachments.length > 0 ? this.previousAttachments : this.currentSnapshot.chatAttachments,
      };
    }
    return {
      messages: this.currentSnapshot?.chatMessages ?? [],
      attachments: this.currentSnapshot?.chatAttachments ?? [],
    };
  }

  isSessionStale(): boolean {
    if (!this.currentSnapshot) {
      return true;
    }
    const staleThreshold = 24 * 60 * 60 * 1000;
    return Date.now() - this.currentSnapshot.lastActiveAt > staleThreshold;
  }

  clearRecoveryData(): void {
    this.currentSnapshot = null;
    this.previousMessages = [];
    this.previousAttachments = [];
    this.recoveryAttempts = 0;
    try {
      localStorage.removeItem(this.config.sessionKeyPersistenceKey);
    } catch {}
  }

  getConfig(): SessionRecoveryConfig {
    return { ...this.config };
  }

  getCurrentSnapshot(): SessionSnapshot | null {
    return this.currentSnapshot ? { ...this.currentSnapshot } : null;
  }

  updateSnapshotMessages(messages: unknown[], attachments: unknown[]): void {
    if (this.currentSnapshot) {
      this.currentSnapshot.chatMessages = [...messages];
      this.currentSnapshot.chatAttachments = [...attachments];
      this.currentSnapshot.lastActiveAt = Date.now();
      this.saveSession();
    }
  }
}

let globalSessionRecovery: ZeroTokenSessionRecovery | null = null;

export function getZeroTokenSessionRecovery(): ZeroTokenSessionRecovery {
  if (!globalSessionRecovery) {
    globalSessionRecovery = new ZeroTokenSessionRecovery();
  }
  return globalSessionRecovery;
}

export function resetZeroTokenSessionRecovery(): void {
  globalSessionRecovery = null;
}
