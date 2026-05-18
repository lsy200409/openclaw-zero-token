# OpenClaw Zero Token - 空闲触发记忆保存方案

## 概述

本方案用**空闲触发 (Idle-Triggered)** 机制完全替换原有的**心跳定时 (Heartbeat)** 机制，从根本上解决心跳打断对话的问题。

---

## 核心区别

| 方面 | 心跳机制 (旧) | 空闲触发 (新) |
|------|--------------|--------------|
| **触发时机** | 固定 30s 间隔 | 检测到会话空闲时 |
| **冲突风险** | 高，会打断对话 | **零冲突** |
| **资源消耗** | 持续消耗 | 仅空闲时消耗 |
| **任务执行** | 在主会话中 | 在**子会话**中 |
| **记忆保存** | 被动保存 | **主动 + 惰性** |

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        主会话 (用户界面)                          │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────────────────────────┐  │
│  │ IdleDetector │────▶│ 检测用户活动 (输入/AI响应/工具执行)    │  │
│  └──────────────┘     └──────────────────────────────────────┘  │
│                              │                                   │
│                         空闲 5 秒后                              │
│                              ↓                                   │
│         ┌────────────────────────────────────────────┐          │
│         │     LazyMemoryManager - 调度记忆保存        │          │
│         └────────────────────────────────────────────┘          │
│                              │                                   │
│                    创建子会话执行保存                             │
│                              ↓                                   │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                      子会话 (记忆保存)                            │
│                                                                  │
│  - 读取主会话上下文                                               │
│  - 执行 memory compaction                                        │
│  - 保存到存储                                                    │
│  - 完成通知                                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心组件

### 1. IdleDetector (空闲检测器)

```typescript
// idle-detector.ts
class IdleDetector {
  private idleTimeoutMs = 5000;  // 空闲 5 秒后触发
  private checkIntervalMs = 500;  // 每 500ms 检查一次

  // 记录活动类型
  recordActivity(type: SessionActivityType): void {
    // "user_input" | "ai_response" | "tool_execution" | "system_event"
  }

  // 事件回调
  onIdleStart(): void { /* 开始空闲 */ }
  onIdleEnd(): void { /* 恢复活动 */ }
  onIdleTimeout(): void { /* 长时间空闲 */ }
}
```

### 2. LazyMemoryManager (惰性记忆管理器)

```typescript
// lazy-memory-manager.ts
class LazyMemoryManager {
  private config = {
    idleTimeoutMs: 5000,
    memorySaveDebounceMs: 2000,  // 防抖
    maxConcurrentSaves: 2,        // 最多 2 个并行保存
    enableChildSessionFork: true, // 子会话执行
  };

  // 注册会话
  registerSession(sessionKey: string, parentSessionKey?: string): void {
    // 创建 IdleDetector，开始监听空闲
  }

  // 记录活动
  recordActivity(sessionKey: string, type: SessionActivityType): void {
    // 重置空闲计时器
  }

  // 请求保存
  requestMemorySave(request: MemorySaveRequest): void {
    // 加入队列，调度到子会话执行
  }
}
```

### 3. ChildSessionBridge (子会话桥接)

```typescript
// child-session-bridge.ts
class ChildSessionBridge {
  // 注册子会话任务
  registerSession(taskId: string, config: ChildSessionConfig): void;

  // 发送进度
  sendProgress(taskId: string, progress: number, message?: string): void;

  // 完成/失败
  completeTask(taskId: string, result: MemorySaveResult): void;
  failTask(taskId: string, error: string): void;
}
```

---

## 工作流程

### 正常对话时

```
用户输入 → AI 响应 → 工具执行 → AI 响应 → ...
     ↑
     └──── IdleDetector 持续记录活动，重置空闲计时器
```

### 检测到空闲时 (5 秒无活动)

```
IdleDetector.onIdleStart()
     ↓
LazyMemoryManager.scheduleMemorySave()
     ↓
[防抖 2 秒] (等待用户可能的新输入)
     ↓
创建子会话，传入 MemorySaveRequest
     ↓
子会话执行 memory compaction
     ↓
完成通知主会话
```

### 子会话执行期间

```
主会话状态: 完全不受影响，继续正常对话
子会话状态: 后台执行 memory save
     ↓
进度通过 ChildSessionBridge 回调
     ↓
完成后主会话收到通知，可选更新 UI
```

---

## 配置选项

### IdleDetector

```typescript
interface IdleDetectorConfig {
  idleTimeoutMs: number;           // 空闲超时 (默认 5000ms)
  checkIntervalMs: number;          // 检查间隔 (默认 500ms)
  maxIdlePeriodsBeforeWarn: number; // 最大空闲周期 (默认 10)
  enableAdaptiveTimeout: boolean;   // 自适应超时 (默认 true)
}
```

### LazyMemoryManager

```typescript
interface LazyMemoryManagerConfig {
  enableIdleTrigger: boolean;       // 启用空闲触发 (默认 true)
  idleTimeoutMs: number;            // 空闲超时 (默认 5000ms)
  memorySaveDebounceMs: number;     // 防抖延迟 (默认 2000ms)
  maxConcurrentSaves: number;        // 最大并行保存数 (默认 2)
  enableChildSessionFork: boolean;   // 启用子会话 (默认 true)
  autoRestoreOnReconnect: boolean;   // 重连时自动恢复 (默认 true)
}
```

---

## 与原有心跳的关系

### 移除

- ❌ `gateway/client.ts` 中的 `startTickWatch()`
- ❌ 服务端的 `tick` 事件发送
- ❌ 心跳超时断开逻辑

### 保留

- ✅ WebSocket 连接的 ping/pong (由 ws 库自动处理)
- ✅ 基本的连接存活检测

### 新增

- ✅ `IdleDetector` - 会话空闲检测
- ✅ `LazyMemoryManager` - 惰性记忆保存调度
- ✅ `ChildSessionBridge` - 子会话通信

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `idle-detector.ts` | 会话空闲检测器 |
| `lazy-memory-manager.ts` | 惰性记忆管理器 |
| `child-session-bridge.ts` | 子会话通信桥接 |

---

## 集成步骤

### 1. 替换心跳初始化

```typescript
// 旧代码 (gateway/client.ts)
start() {
  this.startTickWatch();  // ❌ 移除
  // ...
}

// 新代码
start() {
  // ✅ 初始化空闲检测
  this.idleDetector = new IdleDetector(this.sessionKey, {
    idleTimeoutMs: 5000,
    enableIdleTrigger: true,
  });

  this.idleDetector.setEvents({
    onIdleStart: () => {
      this.lazyMemoryManager.scheduleMemorySave({
        sessionKey: this.sessionKey,
        reason: "idle",
        priority: "low",
      });
    },
  });

  this.idleDetector.start();
}
```

### 2. 活动记录

```typescript
// 在对话进行中调用
this.idleDetector.recordActivity("user_input");   // 用户输入时
this.idleDetector.recordActivity("ai_response"); // AI 响应时
this.idleDetector.recordActivity("tool_execution"); // 工具执行时
```

### 3. 子会话回调

```typescript
this.lazyMemoryManager.setChildSessionCallback(async (request) => {
  const result = await executeMemorySaveInChildSession({
    taskId: request.taskId,
    parentSessionKey: request.parentSessionKey,
    taskType: request.reason === "idle" ? "memory-compact" : "memory-snapshot",
    bridge: this.childSessionBridge,
  });
  return result;
});
```

---

## 优势总结

1. **零冲突** - 记忆保存在子会话执行，不影响主会话对话
2. **精确触发** - 仅在真正空闲时触发，不浪费资源
3. **防抖机制** - 避免频繁的保存操作
4. **可扩展** - 未来可添加更多空闲时任务
5. **向后兼容** - 保留原有的会话管理机制
