import { IdleDetector, SessionActivityTracker } from "./idle-detector.js";

export interface LazyMemoryTask {
  id: string;
  type: "compact" | "snapshot" | "restore";
  sessionKey: string;
  parentSessionKey: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
}

export interface LazyMemoryManagerConfig {
  enableIdleTrigger: boolean;
  idleTimeoutMs: number;
  memorySaveDebounceMs: number;
  maxConcurrentSaves: number;
  enableChildSessionFork: boolean;
  autoRestoreOnReconnect: boolean;
}

export const DEFAULT_LAZY_MEMORY_CONFIG: LazyMemoryManagerConfig = {
  enableIdleTrigger: true,
  idleTimeoutMs: 5000,
  memorySaveDebounceMs: 2000,
  maxConcurrentSaves: 2,
  enableChildSessionFork: true,
  autoRestoreOnReconnect: true,
};

export type MemorySaveReason = "idle" | "manual" | "threshold" | "shutdown" | "scheduled";

export interface MemorySaveRequest {
  sessionKey: string;
  parentSessionKey: string;
  reason: MemorySaveReason;
  priority: "low" | "normal" | "high";
  forceCompact?: boolean;
}

export interface MemorySaveResult {
  taskId: string;
  sessionKey: string;
  success: boolean;
  tokensSaved?: number;
  messagesPruned?: number;
  contextSummary?: string;
  error?: string;
  durationMs: number;
}

type ChildSessionCallback = (
  request: MemorySaveRequest
) => Promise<MemorySaveResult>;

export class LazyMemoryManager {
  private config: LazyMemoryManagerConfig;
  private activityTracker: SessionActivityTracker;
  private idleDetectors = new Map<string, IdleDetector>();
  private pendingTasks = new Map<string, LazyMemoryTask>();
  private runningTasks = new Map<string, LazyMemoryTask>();
  private taskQueue: MemorySaveRequest[] = [];
  private childSessionCallback?: ChildSessionCallback;
  private onSaveCompleteCallbacks: Array<(result: MemorySaveResult) => void> = [];
  private isProcessingQueue = false;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    activityTracker: SessionActivityTracker,
    config?: Partial<LazyMemoryManagerConfig>
  ) {
    this.config = { ...DEFAULT_LAZY_MEMORY_CONFIG, ...config };
    this.activityTracker = activityTracker;
  }

  setChildSessionCallback(callback: ChildSessionCallback): void {
    this.childSessionCallback = callback;
  }

  onSaveComplete(callback: (result: MemorySaveResult) => void): () => void {
    this.onSaveCompleteCallbacks.push(callback);
    return () => {
      const index = this.onSaveCompleteCallbacks.indexOf(callback);
      if (index !== -1) {
        this.onSaveCompleteCallbacks.splice(index, 1);
      }
    };
  }

  registerSession(sessionKey: string, parentSessionKey?: string): IdleDetector {
    const parentKey = parentSessionKey ?? "root";

    const detector = this.activityTracker.createDetector(
      sessionKey,
      { idleTimeoutMs: this.config.idleTimeoutMs },
      {
        onIdleStart: () => {
          this.scheduleMemorySave({
            sessionKey,
            parentSessionKey: parentKey,
            reason: "idle",
            priority: "low",
          });
        },
        onIdleTimeout: () => {
          this.scheduleMemorySave({
            sessionKey,
            parentSessionKey: parentKey,
            reason: "idle",
            priority: "normal",
            forceCompact: true,
          });
        },
        onActivity: () => {},
        onIdleEnd: () => {
          this.cancelPendingSave(sessionKey);
        },
      }
    );

    detector.start();

    this.idleDetectors.set(sessionKey, detector);
    return detector;
  }

  unregisterSession(sessionKey: string): void {
    const detector = this.idleDetectors.get(sessionKey);
    if (detector) {
      detector.stop();
      this.idleDetectors.delete(sessionKey);
      this.activityTracker.removeDetector(sessionKey);
    }

    const debounceTimer = this.debounceTimers.get(sessionKey);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.debounceTimers.delete(sessionKey);
    }
  }

  private scheduleMemorySave(request: MemorySaveRequest): void {
    const existingDebounce = this.debounceTimers.get(request.sessionKey);
    if (existingDebounce) {
      clearTimeout(existingDebounce);
    }

    const debounceTimer = setTimeout(() => {
      this.debounceTimers.delete(request.sessionKey);
      this.enqueueTask(request);
    }, this.config.memorySaveDebounceMs);

    this.debounceTimers.set(request.sessionKey, debounceTimer);
  }

  private cancelPendingSave(sessionKey: string): void {
    const debounceTimer = this.debounceTimers.get(sessionKey);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.debounceTimers.delete(sessionKey);
    }

    this.taskQueue = this.taskQueue.filter(
      (t) => t.sessionKey !== sessionKey || t.reason !== "idle"
    );
  }

  requestMemorySave(request: MemorySaveRequest): void {
    this.enqueueTask(request);
  }

  private enqueueTask(request: MemorySaveRequest): void {
    const existing = this.taskQueue.findIndex(
      (t) =>
        t.sessionKey === request.sessionKey && t.reason === request.reason
    );

    if (existing !== -1) {
      this.taskQueue[existing] = request;
    } else {
      this.taskQueue.push(request);
    }

    this.taskQueue.sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }

    if (this.runningTasks.size >= this.config.maxConcurrentSaves) {
      return;
    }

    const nextTask = this.taskQueue.shift();
    if (!nextTask) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      await this.executeTask(nextTask);
    } finally {
      this.isProcessingQueue = false;
      this.processQueue();
    }
  }

  private async executeTask(request: MemorySaveRequest): Promise<void> {
    const task: LazyMemoryTask = {
      id: `memory-save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: request.forceCompact ? "compact" : "snapshot",
      sessionKey: request.sessionKey,
      parentSessionKey: request.parentSessionKey,
      status: "pending",
      createdAt: Date.now(),
    };

    this.pendingTasks.set(task.id, task);
    this.runningTasks.set(task.id, task);
    task.status = "running";

    const startTime = Date.now();

    try {
      if (!this.childSessionCallback) {
        throw new Error("Child session callback not configured");
      }

      const result = await this.childSessionCallback(request);

      task.status = "completed";
      task.completedAt = Date.now();
      task.result = result;

      const saveResult: MemorySaveResult = {
        taskId: task.id,
        sessionKey: task.sessionKey,
        success: true,
        tokensSaved: result.tokensSaved,
        messagesPruned: result.messagesPruned,
        contextSummary: result.contextSummary,
        durationMs: Date.now() - startTime,
      };

      this.notifySaveComplete(saveResult);
    } catch (error) {
      task.status = "failed";
      task.completedAt = Date.now();
      task.error = error instanceof Error ? error.message : String(error);

      const saveResult: MemorySaveResult = {
        taskId: task.id,
        sessionKey: task.sessionKey,
        success: false,
        error: task.error,
        durationMs: Date.now() - startTime,
      };

      this.notifySaveComplete(saveResult);
    } finally {
      this.pendingTasks.delete(task.id);
      this.runningTasks.delete(task.id);
    }
  }

  private notifySaveComplete(result: MemorySaveResult): void {
    for (const callback of this.onSaveCompleteCallbacks) {
      try {
        callback(result);
      } catch {}
    }
  }

  getTaskStatus(taskId: string): LazyMemoryTask | undefined {
    return this.pendingTasks.get(taskId) ?? this.runningTasks.get(taskId);
  }

  getPendingTaskCount(): number {
    return this.taskQueue.length;
  }

  getRunningTaskCount(): number {
    return this.runningTasks.size;
  }

  getConfig(): LazyMemoryManagerConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<LazyMemoryManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  pauseSession(sessionKey: string): void {
    const detector = this.idleDetectors.get(sessionKey);
    detector?.pause();
  }

  resumeSession(sessionKey: string): void {
    const detector = this.idleDetectors.get(sessionKey);
    detector?.resume();
  }

  forceSaveNow(sessionKey: string, parentSessionKey: string): string {
    const taskId = `memory-save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.enqueueTask({
      sessionKey,
      parentSessionKey,
      reason: "manual",
      priority: "high",
    });

    return taskId;
  }

  shutdown(): void {
    Array.from(this.idleDetectors.keys()).forEach((sessionKey) => {
      this.unregisterSession(sessionKey);
    });

    Array.from(this.debounceTimers.values()).forEach((timer) => {
      clearTimeout(timer);
    });
    this.debounceTimers.clear();

    this.taskQueue = [];
  }
}

let globalLazyMemoryManager: LazyMemoryManager | null = null;

export function getGlobalLazyMemoryManager(): LazyMemoryManager {
  if (!globalLazyMemoryManager) {
    const activityTracker = new SessionActivityTracker();
    globalLazyMemoryManager = new LazyMemoryManager(activityTracker);
  }
  return globalLazyMemoryManager;
}

export function resetGlobalLazyMemoryManager(): void {
  if (globalLazyMemoryManager) {
    globalLazyMemoryManager.shutdown();
    globalLazyMemoryManager = null;
  }
}
