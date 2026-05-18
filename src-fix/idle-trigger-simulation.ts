import { IdleDetector, SessionActivityTracker, type SessionActivityType } from "../src-fix/idle-detector.js";
import { LazyMemoryManager } from "../src-fix/lazy-memory-manager.js";
import { ChildSessionBridge, type MemorySaveRequest } from "../src-fix/child-session-bridge.js";

interface SimulatedChatMessage {
  id: string;
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface SimulatedSession {
  sessionKey: string;
  messages: SimulatedChatMessage[];
  isActive: boolean;
  lastActivity: number;
}

class IdleTriggerMemorySimulator {
  private activityTracker: SessionActivityTracker;
  private lazyMemoryManager: LazyMemoryManager;
  private childSessionBridge: ChildSessionBridge;
  private sessions = new Map<string, SimulatedSession>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private currentTime: number = 0;
  private speedMultiplier: number = 100;

  constructor() {
    this.activityTracker = new SessionActivityTracker();
    this.childSessionBridge = new ChildSessionBridge();
    this.lazyMemoryManager = new LazyMemoryManager(this.activityTracker, {
      idleTimeoutMs: 3000,
      memorySaveDebounceMs: 1000,
      enableChildSessionFork: true,
    });

    this.setupMemoryManager();
  }

  private setupMemoryManager(): void {
    this.lazyMemoryManager.setChildSessionCallback(async (request: MemorySaveRequest) => {
      return this.executeMemorySave(request);
    });

    this.lazyMemoryManager.onSaveComplete((result) => {
      console.log(`[Memory Save Complete] Session: ${result.sessionKey}, Success: ${result.success}, Duration: ${result.durationMs}ms`);
      if (result.tokensSaved) {
        console.log(`  Tokens saved: ${result.tokensSaved}, Messages pruned: ${result.messagesPruned}`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    });
  }

  private async executeMemorySave(request: MemorySaveRequest): Promise<{
    taskId: string;
    sessionKey: string;
    success: boolean;
    tokensSaved?: number;
    messagesPruned?: number;
    contextSummary?: string;
    durationMs: number;
    error?: string;
  }> {
    const startTime = Date.now();
    const session = this.sessions.get(request.sessionKey);

    if (!session) {
      return {
        taskId: "",
        sessionKey: request.sessionKey,
        success: false,
        error: "Session not found",
        durationMs: Date.now() - startTime,
      };
    }

    console.log(`[Child Session] Starting memory save for session: ${request.sessionKey}`);
    console.log(`  Reason: ${request.reason}, Priority: ${request.priority}`);
    console.log(`  Current messages: ${session.messages.length}`);

    await new Promise((r) => setTimeout(r, 500));

    const totalTokens = session.messages.length * 50;
    const shouldCompact = totalTokens > 10000;

    if (shouldCompact) {
      const prunedCount = Math.floor(session.messages.length * 0.3);
      session.messages = session.messages.slice(prunedCount);

      console.log(`[Child Session] Compacted messages from ${session.messages.length + prunedCount} to ${session.messages.length}`);

      return {
        taskId: `memory-save-${Date.now()}`,
        sessionKey: request.sessionKey,
        success: true,
        tokensSaved: Math.floor(totalTokens * 0.3),
        messagesPruned: prunedCount,
        contextSummary: `Compacted session: ${prunedCount} messages removed`,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      taskId: `memory-save-${Date.now()}`,
      sessionKey: request.sessionKey,
      success: true,
      tokensSaved: 0,
      messagesPruned: 0,
      contextSummary: "Session healthy, no compaction needed",
      durationMs: Date.now() - startTime,
    };
  }

  createSession(sessionKey: string): SimulatedSession {
    const session: SimulatedSession = {
      sessionKey,
      messages: [],
      isActive: true,
      lastActivity: Date.now(),
    };
    this.sessions.set(sessionKey, session);

    this.lazyMemoryManager.registerSession(sessionKey, "root");

    console.log(`[Session Created] ${sessionKey}`);
    return session;
  }

  simulateUserInput(sessionKey: string, content: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    const message: SimulatedChatMessage = {
      id: `msg-${Date.now()}`,
      type: "user",
      content,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    session.lastActivity = Date.now();
    this.activityTracker.recordActivity(sessionKey, "user_input");

    console.log(`[User Input] Session: ${sessionKey}, Content: "${content.substring(0, 50)}..."`);
  }

  simulateAIResponse(sessionKey: string, content: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    const message: SimulatedChatMessage = {
      id: `msg-${Date.now()}`,
      type: "assistant",
      content,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    session.lastActivity = Date.now();
    this.activityTracker.recordActivity(sessionKey, "ai_response");

    console.log(`[AI Response] Session: ${sessionKey}, Content: "${content.substring(0, 50)}..."`);
  }

  simulateToolExecution(sessionKey: string, toolName: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    session.lastActivity = Date.now();
    this.activityTracker.recordActivity(sessionKey, "tool_execution");

    console.log(`[Tool Execution] Session: ${sessionKey}, Tool: ${toolName}`);
  }

  simulateConversation(sessionKey: string, turns: number = 5): void {
    console.log(`\n=== Starting Conversation Simulation (${turns} turns) ===\n`);

    for (let i = 0; i < turns; i++) {
      this.simulateUserInput(sessionKey, `User message #${i + 1}: Can you help me with task ${i + 1}?`);

      const delay = 500;
      const content = `Assistant response #${i + 1}: I'm helping with task ${i + 1}. Let me execute some tools.`;
      this.simulateAIResponse(sessionKey, content);

      if (i % 2 === 0) {
        this.simulateToolExecution(sessionKey, "bash");
      }

      this.simulateToolExecution(sessionKey, "read");
    }

    console.log(`\n=== Conversation Complete (${turns} turns) ===\n`);
  }

  async simulateIdlePeriod(durationMs: number): Promise<void> {
    console.log(`\n=== Simulating Idle Period (${durationMs / 1000}s) ===\n`);

    const startTime = Date.now();
    while (Date.now() - startTime < durationMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async runFullScenario(): Promise<void> {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║     Idle-Triggered Memory Save Simulation                    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    const sessionKey = "session:user:main";

    this.createSession(sessionKey);

    console.log("\n--- Phase 1: Active Conversation ---");
    this.simulateConversation(sessionKey, 3);

    console.log("\n--- Phase 2: Brief Pause (2s) ---");
    await this.simulateIdlePeriod(2000);

    console.log("\n--- Phase 3: Resume Conversation ---");
    this.simulateConversation(sessionKey, 2);

    console.log("\n--- Phase 4: Extended Idle (5s - should trigger memory save) ---");
    await this.simulateIdlePeriod(5000);

    console.log("\n--- Phase 5: More Conversation ---");
    this.simulateConversation(sessionKey, 2);

    console.log("\n--- Phase 6: Another Extended Idle ---");
    await this.simulateIdlePeriod(5000);

    console.log("\n--- Checking Final State ---");
    const session = this.sessions.get(sessionKey);
    if (session) {
      console.log(`Final message count: ${session.messages.length}`);
    }

    const pending = this.lazyMemoryManager.getPendingTaskCount();
    const running = this.lazyMemoryManager.getRunningTaskCount();
    console.log(`Pending memory saves: ${pending}, Running: ${running}`);

    this.shutdown();
  }

  shutdown(): void {
    console.log("\n=== Shutting Down Simulator ===\n");
    this.lazyMemoryManager.shutdown();
    this.childSessionBridge.stop();

    for (const [sessionKey] of this.sessions) {
      this.lazyMemoryManager.unregisterSession(sessionKey);
    }
  }
}

async function main() {
  const simulator = new IdleTriggerMemorySimulator();
  await simulator.runFullScenario();
  process.exit(0);
}

main().catch(console.error);
