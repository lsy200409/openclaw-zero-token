# 会话切换和记忆恢复方案

## 问题分析

### 当前问题

1. **按 "New Chat" 时**：Gateway 创建新的 `sessionId`，但 DeepSeek 的 `sessionId` 没有保存
2. **DeepSeek 的会话历史**：存储在 DeepSeek 服务器端，只通过 `sessionId` 关联
3. **会话切换**：无法加载之前在 DeepSeek 网页端的会话

### 根本原因

```typescript
// session-reset-service.ts - 总是生成新 sessionId
const nextSessionId = randomUUID(); // DeepSeek session ID 丢失
```

---

## 解决方案

### 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                     DeepSeek 服务器                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Session A  │  │ Session B  │  │ Session C  │             │
│  │ (对话历史)  │  │ (对话历史)  │  │ (对话历史)  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         ↑                ↑                ↑                      │
└─────────│────────────────│────────────────│──────────────────────┘
          │                │                │
          ↓                ↓                ↓
┌─────────────────────────────────────────────────────────────────┐
│                   本地存储 (deepseek-conversations.json)          │
│  {                                                               │
│    "sessions": [                                                │
│      { "gatewayId": "xxx", "deepseekId": "yyy", "title": "..." },│
│      ...                                                         │
│    ]                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 实现计划

### 阶段 1: 会话历史持久化

#### 1.1 新增存储文件

**文件**: `src/zero-token/streams/deepseek-conversations.ts`

```typescript
interface DeepseekConversationEntry {
  gatewaySessionId: string;      // Gateway 会话 ID
  deepseekSessionId: string;     // DeepSeek 会话 ID
  createdAt: number;             // 创建时间
  lastActiveAt: number;          // 最后活跃时间
  title: string;                 // 会话标题
  messageCount: number;          // 消息数量
}

interface DeepseekConversationsStore {
  version: number;
  sessions: DeepseekConversationEntry[];
  activeSessionId: string | null; // 当前活跃的 DeepSeek 会话
}
```

#### 1.2 修改 DeepSeek Stream

**文件**: `src/zero-token/streams/deepseek-web-stream.ts`

```typescript
// 保存会话到历史
function saveConversationToHistory(sessionId: string, summary: ConversationSummary) {
  const store = loadConversationsStore();
  const existing = store.sessions.find(s => s.deepseekSessionId === sessionId);

  if (existing) {
    existing.lastActiveAt = Date.now();
    existing.title = summary.title;
    existing.messageCount = summary.messageCount;
  } else {
    store.sessions.push({
      gatewaySessionId: getCurrentGatewaySessionId(),
      deepseekSessionId: sessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      title: summary.title,
      messageCount: summary.messageCount,
    });
  }

  store.activeSessionId = sessionId;
  saveConversationsStore(store);
}
```

---

### 阶段 2: New Chat 流程修改

#### 2.1 修改会话重置

**文件**: `src/gateway/session-reset-service.ts`

添加 `keepDeepseekSession` 选项：

```typescript
export async function performGatewaySessionReset(params: {
  key: string;
  reason: "new" | "reset";
  commandSource: string;
  keepDeepseekSession?: boolean; // 新增：是否保留 DeepSeek 会话
}) {
  // ...

  const next = await updateSessionStore(storePath, (store) => {
    // ...

    // 如果保留 DeepSeek 会话，不生成新的 sessionId
    const nextSessionId = params.keepDeepseekSession
      ? oldSessionId  // 复用旧的
      : randomUUID(); // 生成新的

    // ...
  });
}
```

#### 2.2 UI 层修改

**文件**: `ui/src/ui/app-chat.ts`

```typescript
async function handleNewChat(host: ChatHost) {
  // 1. 保存当前会话到历史
  await saveCurrentConversationToHistory(host);

  // 2. 重置 Gateway 会话（创建新的）
  await host.client.request("sessions.reset", {
    key: host.sessionKey,
    deepseekSessionId: undefined, // 不传递，让它生成新的
  });

  // 3. 清空本地 UI
  host.chatMessages = [];
  host.chatStream = null;
  host.chatRunId = null;

  // 4. 加载空白的聊天界面
  await loadChatHistory(host);
}
```

---

### 阶段 3: 会话切换和恢复

#### 3.1 会话列表扩展

**文件**: `ui/src/ui/controllers/sessions.ts`

```typescript
export interface SessionsState {
  // ... 现有字段
  deepseekConversations: DeepseekConversationEntry[]; // 新增
}

// 加载 DeepSeek 会话历史
export async function loadDeepseekConversations(state: SessionsState) {
  // 从 deepseek-conversations.json 读取
  const conversations = await loadConversationsFromFile();
  state.deepseekConversations = conversations;
}
```

#### 3.2 会话恢复

```typescript
// 切换到指定会话
export async function switchToConversation(
  state: SessionsState,
  entry: DeepseekConversationEntry
) {
  // 1. 重置当前 Gateway 会话
  await state.client.request("sessions.reset", {
    key: state.sessionKey,
  });

  // 2. 加载选定的 DeepSeek 会话
  // (通过 deepseekSessionId 连接 DeepSeek，获取历史)

  // 3. 更新本地状态
  state.chatMessages = []; // DeepSeek 会返回历史
}
```

---

## 文件修改清单

| 文件 | 修改内容 | 优先级 |
|------|---------|--------|
| `src/zero-token/streams/deepseek-conversations.ts` | 新增：会话历史存储 | P0 |
| `src/zero-token/streams/deepseek-web-stream.ts` | 保存/加载会话历史 | P0 |
| `src/gateway/session-reset-service.ts` | 支持保留 sessionId | P1 |
| `ui/src/ui/controllers/sessions.ts` | 会话历史管理 | P1 |
| `ui/src/ui/app-chat.ts` | New Chat 逻辑修改 | P1 |
| `ui/src/ui/views/sessions-render.ts` | 会话列表显示 | P2 |

---

## 数据流

### New Chat 流程

```
用户点击 New Chat
       ↓
保存当前会话到 deepseek-conversations.json
       ↓
调用 sessions.reset (新建 Gateway 会话)
       ↓
DeepSeek 生成新的 sessionId
       ↓
保存新的 (gatewayId, deepseekId) 映射
       ↓
清空 UI，显示空白对话
```

### 切换会话流程

```
用户在会话列表选择 "会话 B"
       ↓
查找 deepseek-conversations.json 中 "会话 B" 的 deepseekSessionId
       ↓
调用 sessions.reset 并传递 deepseekSessionId
       ↓
DeepSeek 返回 "会话 B" 的历史
       ↓
UI 显示历史对话
```

---

## 配置

### 会话历史文件位置

```
{OPENCLAW_STATE_DIR}/zero-token/deepseek-conversations.json
```

### 默认值

```typescript
const DEFAULT_CONFIG = {
  maxStoredConversations: 50,      // 最多保存 50 个会话
  conversationHistoryDays: 30,    // 保留 30 天
  autoSaveIntervalMs: 30000,      // 每 30 秒自动保存
};
```

---

## 注意事项

1. **DeepSeek API 限制**：需要确认 DeepSeek 支持通过 sessionId 恢复会话
2. **错误处理**：网络中断时需要优雅降级
3. **数据清理**：定期清理过期的会话记录
4. **并发处理**：多个标签页同时操作时的冲突问题
