# OpenClaw Zero Token 专用修复方案

## 问题概述

针对 **openclaw-zero-token** 项目的核心问题：

### 1. 心跳机制过于频繁打断对话
- **原问题**: `tickIntervalMs * 2 = 60s` 超时阈值过于严格
- **现象**: 网页端对话过程中被心跳超时打断
- **概率性问题**: 有概率触发会话断开，需重启网关

### 2. 网关重启后开新会话
- **原问题**: 断连后网关创建新会话，不保留原会话状态
- **现象**: 重启网关后 UI 连接到新的空白会话
- **用户感知**: 对话上下文丢失

### 3. 无法自动恢复记忆
- **原问题**: 会话断开后没有机制保存/恢复聊天历史
- **现象**: 重连后需要手动恢复上下文

---

## 修复方案

### 方案一: 心跳机制优化 (推荐)

**文件**: `src-fix/zero-token-heartbeat-fix.ts`

#### 核心改进

| 参数 | 原值 | 新值 | 说明 |
|------|------|------|------|
| `tickTimeoutMultiplier` | 2.0 | 3.0 | 超时阈值从 2 倍放宽到 3 倍 |
| `consecutiveMissesBeforeDisconnect` | 1 | 3 | 需连续 3 次超时才断开 |
| `minTickTimeoutMs` | 无 | 60,000 | 最小 60 秒超时保护 |

#### 工作原理

```typescript
// 心跳检查间隔
const checkInterval = Math.min(tickIntervalMs, 5000); // 最多 5 秒检查一次

// 超时判断 (原代码)
if (gap > tickIntervalMs * 2) { // 60 秒无 tick 就断开

// 超时判断 (新代码)
if (gap > tickTimeoutMs) { // 90 秒无 tick 才可能断开
  consecutiveMisses++;
  if (consecutiveMisses >= 3) { // 连续 3 次才真正断开
    // 触发断开
  }
}
```

#### 使用示例

```typescript
import { ZeroTokenHeartbeatManager } from './zero-token-heartbeat-fix.ts'

const heartbeat = new ZeroTokenHeartbeatManager({
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 3.0,
  consecutiveMissesBeforeDisconnect: 3,
  minTickTimeoutMs: 60_000,
})

heartbeat.setOnTickTimeout(() => {
  console.log('心跳超时，应触发重连而不是断开')
  // 这里可以做更温和的处理
})

heartbeat.start()
```

---

### 方案二: 会话恢复机制 (推荐)

**文件**: `src-fix/zero-token-session-recovery.ts`

#### 核心功能

1. **会话快照保存**: 断连前保存 sessionKey、runId、聊天历史
2. **自动重连到原会话**: 重连时尝试恢复到相同 sessionKey
3. **聊天历史保护**: 断开前的消息不丢失

#### 存储结构

```typescript
interface SessionSnapshot {
  sessionKey: string;
  runId: string | null;
  chatMessages: unknown[];
  chatAttachments: unknown[];
  lastActiveAt: number;
  connectionState: 'connected' | 'disconnected' | 'reconnecting';
  gatewayConnId?: string;
}
```

#### 使用示例

```typescript
import { ZeroTokenSessionRecovery } from './zero-token-session-recovery.ts'

const recovery = new ZeroTokenSessionRecovery({
  enableSessionRecovery: true,
  maxRecoveryAttempts: 3,
  preserveChatHistoryOnDisconnect: true,
})

// 连接断开时
function onDisconnect() {
  recovery.markDisconnected()
  recovery.updateSnapshotMessages(host.chatMessages, host.chatAttachments)
}

// 重新连接时
async function onReconnect() {
  recovery.markReconnecting()

  // 检查是否可以恢复原会话
  if (recovery.canAttemptRecovery()) {
    const sessionKey = recovery.getRecoverySessionKey()
    // 使用原 sessionKey 重新连接
    await connectToSession(sessionKey)
  }

  // 获取断开前的聊天历史
  const { messages, attachments } = recovery.getRestorableMessages()
  host.chatMessages = messages
  host.chatAttachments = attachments

  recovery.markReconnected()
}
```

---

### 方案三: 记忆恢复机制 (推荐)

**文件**: `src-fix/zero-token-memory-recovery.ts`

#### 核心功能

1. **Token 计数和压缩**: 当上下文超过阈值时自动压缩
2. **断开时保存记忆**: 准备恢复点
3. **重连时恢复上下文**: 自动恢复对话记忆

#### 工作流程

```
1. 正常对话 → 持续累积 token
2. Token 超阈值 → 自动压缩生成 context_summary
3. 断开连接 → 保存当前记忆快照
4. 重连成功 → 从快照恢复上下文
```

#### 使用示例

```typescript
import { ZeroTokenMemoryRecovery } from './zero-token-memory-recovery.ts'

const memory = new ZeroTokenMemoryRecovery({
  enableMemoryRecovery: true,
  compactionThresholdTokens: 150_000,  // 150k token 后压缩
  autoRestoreOnReconnect: true,
})

// 对话过程中持续更新
function onTokenUpdate(promptTokens: number, outputTokens: number) {
  const snapshot = memory.snapshotMemory({
    sessionKey: host.sessionKey,
    messages: host.chatMessages,
    promptTokens,
    outputTokens,
  })

  if (snapshot.context_summary) {
    console.log('内存已压缩')
  }
}

// 断开时准备恢复
function onDisconnect() {
  memory.prepareForDisconnect(host.sessionKey, host.chatMessages)
}

// 重连时恢复
function onReconnect() {
  const restored = memory.restoreOnReconnect()
  if (restored) {
    host.chatMessages = restored.messages
    console.log(`恢复了 ${restored.totalTokens} tokens 的上下文`)
  }
}
```

---

## 配置建议

### 开发环境 (需要快速调试)

```typescript
const config = {
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 3.0,
  consecutiveMissesBeforeDisconnect: 3,
  minTickTimeoutMs: 60_000,
}
```

### 生产环境 (需要稳定连接)

```typescript
const config = {
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 5.0,        // 150 秒才超时
  consecutiveMissesBeforeDisconnect: 5, // 连续 5 次超时
  minTickTimeoutMs: 120_000,          // 最小 2 分钟
  reconnectJitterMs: 5000,            // 更大抖动
}
```

### 移动端/弱网络环境

```typescript
const config = {
  tickIntervalMs: 30_000,
  tickTimeoutMultiplier: 10.0,       // 5 分钟超时
  consecutiveMissesBeforeDisconnect: 3,
  minTickTimeoutMs: 300_000,         // 最小 5 分钟
  reconnectJitterMs: 10000,
}
```

---

## 网关端配置

### 修改心跳间隔

**文件**: `src/gateway/server-constants.ts`

```typescript
// 原值
export const TICK_INTERVAL_MS = 30_000;

// 放宽到 60 秒 (减少心跳频率)
export const TICK_INTERVAL_MS = 60_000;
```

### 客户端超时放宽

**文件**: `src/gateway/client.ts`

```typescript
// 原代码
if (gap > this.tickIntervalMs * 2) {
  this.ws?.close(4000, "tick timeout")
}

// 修改为
if (gap > this.tickIntervalMs * 3) {  // 从 2 倍改为 3 倍
  this.consecutiveTickMisses++
  if (this.consecutiveTickMisses >= 3) {  // 添加连续计数
    this.ws?.close(4000, "tick timeout")
  }
}
```

---

## 完整集成示例

```typescript
// app-chat.ts 增强示例
import { ZeroTokenHeartbeatManager } from '../zero-token-heartbeat-fix.ts'
import { ZeroTokenSessionRecovery } from '../zero-token-session-recovery.ts'
import { ZeroTokenMemoryRecovery } from '../zero-token-memory-recovery.ts'

class EnhancedChatHost {
  private heartbeat: ZeroTokenHeartbeatManager
  private sessionRecovery: ZeroTokenSessionRecovery
  private memoryRecovery: ZeroTokenMemoryRecovery

  constructor() {
    this.heartbeat = new ZeroTokenHeartbeatManager()
    this.sessionRecovery = new ZeroTokenSessionRecovery()
    this.memoryRecovery = new ZeroTokenMemoryRecovery()

    this.heartbeat.setOnTickTimeout(() => {
      this.handleTickTimeout()
    })

    this.heartbeat.setOnTickMissed((count) => {
      console.warn(`Tick missed: ${count}`)
    })
  }

  private handleTickTimeout() {
    // 不直接断开，而是标记需要重连
    this.sessionRecovery.markDisconnected()
    this.memoryRecovery.prepareForDisconnect(
      this.sessionKey,
      this.chatMessages
    )

    // 尝试优雅重连
    this.attemptGracefulReconnect()
  }

  private async attemptGracefulReconnect() {
    if (!this.sessionRecovery.canAttemptRecovery()) {
      console.error('Recovery attempts exhausted')
      return
    }

    this.sessionRecovery.markReconnecting()

    try {
      const sessionKey = this.sessionRecovery.getRecoverySessionKey()
      await this.reconnect(sessionKey)

      // 恢复聊天历史
      const { messages, attachments } =
        this.sessionRecovery.getRestorableMessages()
      this.chatMessages = messages
      this.chatAttachments = attachments

      // 恢复记忆
      const memory = this.memoryRecovery.restoreOnReconnect()
      if (memory) {
        console.log(`Restored ${memory.totalTokens} tokens`)
      }

      this.sessionRecovery.markReconnected()
      this.heartbeat.recordTick()
    } catch (err) {
      console.error('Reconnect failed:', err)
      // 等待后重试
      const delay = this.heartbeat.calculateReconnectDelay(1)
      setTimeout(() => this.attemptGracefulReconnect(), delay)
    }
  }
}
```

---

## 测试

运行测试：

```bash
npm test -- src-fix/zero-token-heartbeat-fix.test.ts
npm test -- src-fix/zero-token-session-recovery.test.ts
npm test -- src-fix/zero-token-memory-recovery.test.ts
```

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `zero-token-heartbeat-fix.ts` | 心跳机制优化 |
| `zero-token-session-recovery.ts` | 会话恢复机制 |
| `zero-token-memory-recovery.ts` | 记忆恢复机制 |
| `zero-token-heartbeat-fix.test.ts` | 心跳测试 |
| `zero-token-session-recovery.test.ts` | 会话恢复测试 |
| `zero-token-memory-recovery.test.ts` | 记忆恢复测试 |

---

## 与原方案的区别

| 方面 | 之前通用方案 | Zero Token 专用方案 |
|------|-------------|-------------------|
| 心跳阈值 | `* 3` 倍 | `* 3` 倍 + 最小 60s |
| 连续判断 | 无 | 连续 3 次才断开 |
| 会话恢复 | 基础 | 完整快照 + 消息保留 |
| 记忆恢复 | 基础 | Token 感知 + 自动压缩 |
| 配置项 | 通用 | 针对网页端优化 |
