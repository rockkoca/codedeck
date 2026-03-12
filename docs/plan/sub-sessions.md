# Sub-Sessions 悬浮面板

## 概述

底部增加一排子 session 预览条。每个子 session 是独立的 tmux session，支持 Claude Code / Codex / OpenCode / 任意 Shell。持久化到 PostgreSQL，跨端同步（换电脑/手机登录后自动重建）。

---

## 数据持久化原则

| 数据 | 存储位置 | 原因 |
|------|---------|------|
| sub-session 列表（类型、标签、cwd、是否关闭） | **PostgreSQL** | 跨端同步 |
| 用户默认 shell 偏好 | **PostgreSQL** (`user_quick_data.data` JSON 扩展) | 跨端 |
| 窗口位置 / 大小 | **localStorage** | 设备相关，每台设备独立 |
| 当前最小化/展开状态 | **localStorage** | 设备相关 |

---

## UI 结构

```
┌─────────────────────────────────────────────────────┐
│  主内容区（terminal / chat）                          │
├─────────────────────────────────────────────────────┤
│  SessionControls（输入栏）                            │
├─────────────────────────────────────────────────────┤
│  SubSessionBar                                       │
│  [⚡cc ▼ 上次回复预览…] [📦codex ▼ working…] [+]     │
└─────────────────────────────────────────────────────┘

悬浮窗（position:fixed，叠在所有内容上方，可拖动/缩放）：
┌──────────────────────────────┐
│ ⠿ fish shell  [💬|⌨] [─][×] │  ← 拖动 header，[💬|⌨] 切换 chat/terminal
│ ┌────────────────────────────┐│
│ │   ChatView 或 TerminalView ││
│ └────────────────────────────┘│
│ [⚡][input…            ][Send]│
└──────────────────────────────┘
  ↑ 8 方向 resize handle
```

**最小化卡片**（底部条内）：
- 图标 + 标签（`cc`, `codex`, `fish`…）
- chat 预览：最后一条 assistant 消息前 40 字 / `working…` / `idle`
- 点击展开 → 悬浮窗回到上次位置

---

## 数据模型

### PostgreSQL 新表

**migration: `server/src/db/migrations/002_sub_sessions.sql`**

```sql
CREATE TABLE IF NOT EXISTS sub_sessions (
  id           TEXT PRIMARY KEY,                        -- nanoid(8)
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                           -- 'claude-code' | 'codex' | 'opencode' | 'shell'
  shell_bin    TEXT,                                    -- e.g. '/opt/homebrew/bin/fish'（shell 类型时使用）
  cwd          TEXT,                                    -- 工作目录，NULL 表示 daemon 默认目录
  label        TEXT,                                    -- 用户自定义标签，NULL 时用 type 显示
  closed_at    BIGINT,                                  -- NULL = 活跃，非 NULL = 用户手动关闭，daemon 不重建
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_sessions_server ON sub_sessions(server_id);
```

**tmux session 命名**：`deck_sub_{id}`（8位 id，与普通 `deck_{project}_{role}` 区分）

### user_quick_data JSON 扩展

在现有 `user_quick_data.data` JSON 中新增字段（无需新表）：

```typescript
interface QuickData {
  // 现有字段...
  defaultShell?: string;   // e.g. '/opt/homebrew/bin/fish'，用户首次选择后记住
}
```

---

## 服务端 API

### 新增路由：`server/src/routes/sub-sessions.ts`

挂载到 `app.route('/api/server/:id/sub-sessions', subSessionRoutes)`

| Method | Path | 权限 | 说明 |
|--------|------|------|------|
| `GET`  | `/api/server/:id/sub-sessions` | owner/admin/member | 列出该 server 的所有活跃 sub-session（closed_at IS NULL） |
| `POST` | `/api/server/:id/sub-sessions` | owner/admin | 创建新 sub-session，返回 `{ id, sessionName }` |
| `PATCH`| `/api/server/:id/sub-sessions/:subId` | owner/admin | 更新 label / closed_at |
| `DELETE`| `/api/server/:id/sub-sessions/:subId` | owner/admin | 硬删除（可选，PATCH closed_at 更常用） |

POST body：
```typescript
{ type: string; shellBin?: string; cwd?: string; label?: string }
```

---

## Daemon WS 命令

复用现有 WS 通道（daemon ↔ browser），新增命令：

| 命令 | 方向 | 参数 | 说明 |
|------|------|------|------|
| `subsession.start` | browser→daemon | `{ id, type, shellBin?, cwd? }` | daemon 建 tmux session + 启动 agent/shell |
| `subsession.stop`  | browser→daemon | `{ sessionName }` | daemon kill tmux session |
| `subsession.rebuild_all` | browser→daemon | `{ subSessions: SubSessionRecord[] }` | 页面加载时，把 PG 中活跃的列表发给 daemon，daemon 重建未运行的 |
| `subsession.detect_shells` | browser→daemon | — | daemon 检测可用 shell，返回列表 |
| `subsession.read_response` | browser→daemon | `{ sessionName }` | 读最新一次问答结果 |
| `subsession.shells` | daemon→browser | `{ shells: string[] }` | detect 的响应 |
| `subsession.response` | daemon→browser | `{ sessionName, status: 'working'\|'idle', response?: string }` | read 的响应 |

**`subsession.read_response` 实现逻辑**（`src/daemon/subsession-manager.ts`）：
1. `detectStatusMulti(sessionName)` → 非 idle 返回 `{ status: 'working' }`
2. idle → 从 `timeline-store` 读 sessionName 的事件，找最后一条 `user.message` 之后的所有 `assistant.text`，拼接返回

**Shell 检测**：
```typescript
const CANDIDATES = ['fish', 'zsh', 'bash', 'sh'];
const SEARCH_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
// 遍历 SEARCH_PATHS × CANDIDATES，返回存在的路径列表
// 优先用 process.env.SHELL
```

---

## 新增 Agent Driver

**`src/agent/drivers/shell.ts`** — `ShellDriver`：

```typescript
class ShellDriver implements AgentDriver {
  readonly type = 'shell';
  buildLaunchCommand(_, opts) {
    return opts?.shellBin ?? process.env.SHELL ?? '/bin/bash';
  }
  detectStatus(lines) {
    // 检测 shell prompt：$ % › > 等结尾的行视为 idle
    const last = lines[lines.length - 1]?.trim() ?? '';
    if (/[$%›>#]\s*$/.test(last)) return 'idle';
    return 'unknown';
  }
  postLaunch() { return Promise.resolve(); }
  isOverlay() { return false; }
  async captureLastResponse(capturePane) {
    return (await capturePane()).join('\n');
  }
}
```

`src/agent/detect.ts` 中 `AgentType` 加入 `'shell'`。

---

## 前端组件

### 新增文件

| 文件 | 职责 |
|------|------|
| `web/src/hooks/useSubSessions.ts` | 状态管理：从 PG API 加载列表，增删，daemon 同步 |
| `web/src/components/SubSessionBar.tsx` | 底部条：最小化卡片 + `+` 按钮 |
| `web/src/components/SubSessionWindow.tsx` | 悬浮窗：拖拽/缩放/TerminalView/ChatView/输入栏 |
| `web/src/components/StartSubSessionDialog.tsx` | 类型选择弹窗（agent 或 shell，首次设默认） |

### 修改文件

| 文件 | 变更 |
|------|------|
| `web/src/app.tsx` | 集成 SubSessionBar + SubSessionWindows，terminal 订阅扩展到 sub-sessions |
| `web/src/ws-client.ts` | 新增 `subsession.*` 命令方法 |
| `web/src/api.ts` | 新增 `/api/server/:id/sub-sessions` CRUD 方法 |
| `web/src/styles.css` | 底部条、悬浮窗、resize handle、拖拽样式 |
| `server/src/routes/index.ts` | 挂载 subSessionRoutes |

### SubSession 前端类型

```typescript
interface SubSession {
  id: string;
  serverId: string;
  sessionName: string;        // deck_sub_{id}
  type: 'claude-code' | 'codex' | 'opencode' | 'shell';
  shellBin?: string;
  cwd?: string;
  label?: string;
  closedAt?: number;

  // 运行时（从 daemon ws 同步）
  state: 'running' | 'stopped' | 'starting' | 'unknown';
}

// localStorage（设备相关）
interface SubSessionLocalState {
  minimized: boolean;
  viewMode: 'terminal' | 'chat';  // 记住每个 sub-session 的模式选择
  window: { x: number; y: number; w: number; h: number };
  zIndex: number;
}
```

### 悬浮窗行为

- **拖动**：mousedown on header + mousemove on document，touchmove 支持移动端
- **缩放**：8方向 resize handle（corners + edges），min 300×200
- **Z-order**：点击任意窗口时该窗口 zIndex = max(当前所有) + 1，存 localStorage
- **最小化**：窗口折叠到底部条，位置记在 localStorage，展开时恢复原位
- **默认大小/位置**：首次打开居中，600×400；之后记住上次位置

---

## 实现顺序

1. **PG migration** (`002_sub_sessions.sql`) + server 路由 (`sub-sessions.ts`)
2. **ShellDriver** + `AgentType` 扩展
3. **daemon subsession-manager** + command-handler 新命令
4. **ws-client** 新增方法 + api.ts 新增 fetch
5. **useSubSessions hook**（PG 加载 + daemon 重建）
6. **StartSubSessionDialog**（类型选择 + shell 检测 + 默认记忆）
7. **SubSessionBar**（底部条，卡片预览）
8. **SubSessionWindow**（悬浮窗，拖拽缩放，内嵌 Terminal/Chat + 独立输入）
9. **app.tsx 集成**（terminal 订阅、z-index 管理、多窗口并行）

---

## 技术风险

| 风险 | 方案 |
|------|------|
| daemon 重启时 sub-session 重建 | 页面加载后发 `subsession.rebuild_all`，daemon 检查 tmux session 是否存在，不存在则重建 |
| sub-session 数量膨胀 | PATCH `closed_at` 软删除；GET 只返回 `closed_at IS NULL` |
| 多设备同时在线 | sub-session 状态通过 `session_list` WS 广播，各端收到后同步 |
| 移动端悬浮窗体验 | 移动端悬浮窗全屏覆盖，底部条只显示卡片，点击展开 |
| Shell idle 误判 | detectStatus 加 debounce（500ms 两次采样一致才算 idle） |
