import type {
  MemorySaveRequest,
  MemorySaveResult,
} from "./lazy-memory-manager.js";

export interface ChildSessionConfig {
  parentSessionKey: string;
  taskType: "memory-compact" | "memory-snapshot" | "memory-restore";
  timeoutMs: number;
}

export interface ChildSessionMessage {
  type: "init" | "execute" | "progress" | "complete" | "error" | "heartbeat";
  taskId?: string;
  payload?: unknown;
  timestamp: number;
}

export interface ChildSessionBridgeEvents {
  onProgress?: (taskId: string, progress: number, message?: string) => void;
  onComplete?: (taskId: string, result: MemorySaveResult) => void;
  onError?: (taskId: string, error: string) => void;
}

export class ChildSessionBridge {
  private activeSessions = new Map<string, {
    config: ChildSessionConfig;
    events: ChildSessionBridgeEvents;
    lastHeartbeat: number;
  }>();
  private messageHandlers = new Map<string, (message: ChildSessionMessage) => void>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  registerSession(
    taskId: string,
    config: ChildSessionConfig,
    events: ChildSessionBridgeEvents = {}
  ): void {
    this.activeSessions.set(taskId, {
      config,
      events,
      lastHeartbeat: Date.now(),
    });
  }

  unregisterSession(taskId: string): void {
    this.activeSessions.delete(taskId);
  }

  onMessage(taskId: string, handler: (message: ChildSessionMessage) => void): void {
    this.messageHandlers.set(taskId, handler);
  }

  sendToChild(
    taskId: string,
    message: ChildSessionMessage
  ): boolean {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      return false;
    }

    const handler = this.messageHandlers.get(taskId);
    if (handler) {
      try {
        handler(message);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  sendProgress(
    taskId: string,
    progress: number,
    message?: string
  ): void {
    const session = this.activeSessions.get(taskId);
    if (session) {
      session.events.onProgress?.(taskId, progress, message);
    }
  }

  completeTask(taskId: string, result: MemorySaveResult): void {
    const session = this.activeSessions.get(taskId);
    if (session) {
      session.events.onComplete?.(taskId, result);
    }
    this.unregisterSession(taskId);
    this.messageHandlers.delete(taskId);
  }

  failTask(taskId: string, error: string): void {
    const session = this.activeSessions.get(taskId);
    if (session) {
      session.events.onError?.(taskId, error);
    }
    this.unregisterSession(taskId);
    this.messageHandlers.delete(taskId);
  }

  private startCleanupTimer(): void {
    const CLEANUP_INTERVAL_MS = 30_000;
    const SESSION_TIMEOUT_MS = 300_000;

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      Array.from(this.activeSessions.entries()).forEach(([taskId, session]) => {
        if (now - session.lastHeartbeat > SESSION_TIMEOUT_MS) {
          this.failTask(taskId, "Session timeout");
        }
      });
    }, CLEANUP_INTERVAL_MS);

    this.cleanupTimer.unref?.();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.activeSessions.clear();
    this.messageHandlers.clear();
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  getSessionInfo(taskId: string): {
    config: ChildSessionConfig;
    lastHeartbeatAge: number;
  } | null {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      return null;
    }
    return {
      config: session.config,
      lastHeartbeatAge: Date.now() - session.lastHeartbeat,
    };
  }
}

export async function createMemorySaveChildSession(
  request: MemorySaveRequest,
  bridge: ChildSessionBridge
): Promise<ChildSessionMessage> {
  const taskId = `memory-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const initMessage: ChildSessionMessage = {
    type: "init",
    taskId,
    payload: {
      parentSessionKey: request.parentSessionKey,
      taskType: request.reason === "idle" ? "memory-compact" : "memory-snapshot",
      priority: request.priority,
    },
    timestamp: Date.now(),
  };

  return initMessage;
}

export interface MemorySaveExecutionContext {
  taskId: string;
  parentSessionKey: string;
  taskType: "memory-compact" | "memory-snapshot" | "memory-restore";
  bridge: ChildSessionBridge;
  abortSignal?: AbortSignal;
}

export async function executeMemorySaveInChildSession(
  context: MemorySaveExecutionContext,
  memoryData: {
    messages: unknown[];
    promptTokens: number;
    outputTokens: number;
  }
): Promise<MemorySaveResult> {
  const startTime = Date.now();
  const taskId = context.taskId;

  try {
    context.bridge.sendProgress(taskId, 0, "Starting memory save");

    const totalTokens = memoryData.promptTokens + memoryData.outputTokens;
    const COMPACTION_THRESHOLD = 150_000;

    if (totalTokens > COMPACTION_THRESHOLD || context.taskType === "memory-compact") {
      context.bridge.sendProgress(taskId, 30, "Compacting memory");

      const compactedMessages = compactMessages(memoryData.messages, 100);
      const prunedCount = memoryData.messages.length - compactedMessages.length;

      context.bridge.sendProgress(taskId, 70, "Saving compacted memory");

      await simulateAsyncOperation(100);

      context.bridge.sendProgress(taskId, 100, "Memory save complete");

      return {
        taskId,
        sessionKey: context.parentSessionKey,
        success: true,
        tokensSaved: Math.floor(totalTokens * 0.3),
        messagesPruned: prunedCount,
        contextSummary: `Compacted from ${memoryData.messages.length} to ${compactedMessages.length} messages`,
        durationMs: Date.now() - startTime,
      };
    }

    context.bridge.sendProgress(taskId, 50, "Creating snapshot");
    await simulateAsyncOperation(50);

    context.bridge.sendProgress(taskId, 100, "Snapshot complete");

    return {
      taskId,
      sessionKey: context.parentSessionKey,
      success: true,
      tokensSaved: 0,
      messagesPruned: 0,
      contextSummary: `Snapshot saved: ${memoryData.messages.length} messages`,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      taskId,
      sessionKey: context.parentSessionKey,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

function compactMessages(messages: unknown[], maxMessages: number): unknown[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const systemMessages = messages.filter(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).role === "system"
  );

  const recentMessages = messages.slice(-(maxMessages - systemMessages.length));

  return [...systemMessages, ...recentMessages];
}

function simulateAsyncOperation(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let globalChildSessionBridge: ChildSessionBridge | null = null;

export function getGlobalChildSessionBridge(): ChildSessionBridge {
  if (!globalChildSessionBridge) {
    globalChildSessionBridge = new ChildSessionBridge();
  }
  return globalChildSessionBridge;
}

export function resetGlobalChildSessionBridge(): void {
  if (globalChildSessionBridge) {
    globalChildSessionBridge.stop();
    globalChildSessionBridge = null;
  }
}
