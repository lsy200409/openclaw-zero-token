export interface MemoryRecoveryEntry {
  sessionKey: string;
  memoryData: MemorySnapshot;
  timestamp: number;
  compacted: boolean;
}

export interface MemorySnapshot {
  sessionKey: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  messages: unknown[];
  context_summary?: string;
}

export interface ZeroTokenMemoryRecoveryConfig {
  enableMemoryRecovery: boolean;
  storageKey: string;
  maxStoredSessions: number;
  memoryTtlMs: number;
  autoRestoreOnReconnect: boolean;
  compactionThresholdTokens: number;
}

export const DEFAULT_ZERO_TOKEN_MEMORY_CONFIG: ZeroTokenMemoryRecoveryConfig = {
  enableMemoryRecovery: true,
  storageKey: "zero_token_memory_recovery",
  maxStoredSessions: 10,
  memoryTtlMs: 7 * 24 * 60 * 60 * 1000,
  autoRestoreOnReconnect: true,
  compactionThresholdTokens: 150_000,
};

export class ZeroTokenMemoryRecovery {
  private config: ZeroTokenMemoryRecoveryConfig;
  private memoryStore: Map<string, MemoryRecoveryEntry> = new Map();
  private currentMemory: MemorySnapshot | null = null;
  private pendingRestore: MemorySnapshot | null = null;

  constructor(config: Partial<ZeroTokenMemoryRecoveryConfig> = {}) {
    this.config = { ...DEFAULT_ZERO_TOKEN_MEMORY_CONFIG, ...config };
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(this.config.storageKey);
      if (raw) {
        const entries = JSON.parse(raw) as MemoryRecoveryEntry[];
        const now = Date.now();
        for (const entry of entries) {
          if (now - entry.timestamp < this.config.memoryTtlMs) {
            this.memoryStore.set(entry.sessionKey, entry);
          }
        }
      }
    } catch {
      this.memoryStore.clear();
    }
  }

  private saveToStorage(): void {
    try {
      const entries = Array.from(this.memoryStore.values());
      const sorted = entries.sort((a, b) => b.timestamp - a.timestamp);
      const toSave = sorted.slice(0, this.config.maxStoredSessions);
      localStorage.setItem(this.config.storageKey, JSON.stringify(toSave));
    } catch {}
  }

  snapshotMemory(params: {
    sessionKey: string;
    messages: unknown[];
    promptTokens: number;
    outputTokens: number;
  }): MemorySnapshot {
    const totalTokens = params.promptTokens + params.outputTokens;

    const snapshot: MemorySnapshot = {
      sessionKey: params.sessionKey,
      promptTokens: params.promptTokens,
      outputTokens: params.outputTokens,
      totalTokens,
      messages: this.pruneMessages(params.messages),
    };

    if (totalTokens > this.config.compactionThresholdTokens) {
      snapshot.context_summary = this.generateContextSummary(snapshot);
      snapshot.messages = this.compactMessages(snapshot.messages);
    }

    this.currentMemory = snapshot;
    return snapshot;
  }

  private pruneMessages(messages: unknown[]): unknown[] {
    const maxMessages = 100;
    if (messages.length <= maxMessages) {
      return [...messages];
    }
    return messages.slice(-maxMessages);
  }

  private generateContextSummary(memory: MemorySnapshot): string {
    const msgCount = memory.messages.length;
    const totalTokens = memory.totalTokens;
    return `[Context Summary] Session: ${memory.sessionKey}, Messages: ${msgCount}, Tokens: ${totalTokens}`;
  }

  private compactMessages(messages: unknown[]): unknown[] {
    if (messages.length <= 20) {
      return messages;
    }

    const systemMessages = messages.filter(
      (m: unknown) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "system"
    );

    const recentMessages = messages.slice(-15);

    return [...systemMessages, ...recentMessages];
  }

  storeMemory(memory: MemorySnapshot): void {
    if (!this.config.enableMemoryRecovery) {
      return;
    }

    const entry: MemoryRecoveryEntry = {
      sessionKey: memory.sessionKey,
      memoryData: memory,
      timestamp: Date.now(),
      compacted: memory.context_summary !== undefined,
    };

    this.memoryStore.set(memory.sessionKey, entry);
    this.saveToStorage();
  }

  getMemory(sessionKey: string): MemorySnapshot | null {
    const entry = this.memoryStore.get(sessionKey);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.config.memoryTtlMs) {
      this.memoryStore.delete(sessionKey);
      this.saveToStorage();
      return null;
    }

    return entry.memoryData;
  }

  prepareForDisconnect(sessionKey: string, currentMessages: unknown[]): void {
    if (!this.config.enableMemoryRecovery) {
      return;
    }

    if (this.currentMemory) {
      this.storeMemory(this.currentMemory);
    }

    this.pendingRestore = {
      sessionKey,
      promptTokens: this.estimateTokens(currentMessages),
      outputTokens: 0,
      totalTokens: this.estimateTokens(currentMessages),
      messages: this.pruneMessages(currentMessages),
    };
  }

  restoreOnReconnect(): MemorySnapshot | null {
    if (!this.config.autoRestoreOnReconnect || !this.pendingRestore) {
      return null;
    }

    const restored = { ...this.pendingRestore };
    this.pendingRestore = null;
    return restored;
  }

  hasPendingRestore(): boolean {
    return this.pendingRestore !== null;
  }

  getPendingRestore(): MemorySnapshot | null {
    return this.pendingRestore;
  }

  private estimateTokens(messages: unknown[]): number {
    const text = JSON.stringify(messages);
    return Math.ceil(text.length / 4);
  }

  clearMemory(sessionKey: string): void {
    this.memoryStore.delete(sessionKey);
    if (this.currentMemory?.sessionKey === sessionKey) {
      this.currentMemory = null;
    }
    if (this.pendingRestore?.sessionKey === sessionKey) {
      this.pendingRestore = null;
    }
    this.saveToStorage();
  }

  clearAllMemory(): void {
    this.memoryStore.clear();
    this.currentMemory = null;
    this.pendingRestore = null;
    try {
      localStorage.removeItem(this.config.storageKey);
    } catch {}
  }

  getStoredSessionCount(): number {
    return this.memoryStore.size;
  }

  getConfig(): ZeroTokenMemoryRecoveryConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ZeroTokenMemoryRecoveryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

let globalMemoryRecovery: ZeroTokenMemoryRecovery | null = null;

export function getZeroTokenMemoryRecovery(): ZeroTokenMemoryRecovery {
  if (!globalMemoryRecovery) {
    globalMemoryRecovery = new ZeroTokenMemoryRecovery();
  }
  return globalMemoryRecovery;
}

export function resetZeroTokenMemoryRecovery(): void {
  globalMemoryRecovery = null;
}
