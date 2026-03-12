# Session 双向同步计划

## 现状问题

- Server DB 是被动接收方：daemon 推什么就存什么，server 自己没有维护 session 状态
- Daemon 重启后 store 可能为空，导致前端看不到任何 session（现已用孤儿扫描 workaround）
- Session 创建/关闭由客户端触发，server 只是转发给 daemon，自己不记录意图
- Daemon 掉线时 server 不知道哪些 session 还活着

## 目标

**Server DB 是 session 的权威来源。** Daemon 是执行者，按 server 的状态执行并上报。

---

## 设计

### 1. Server 端维护 session 意图状态

在 `sessions` 表增加 `desired_state` 字段：`running | stopped`

- 客户端发 session.start → server 记录 `desired_state=running`，再转发给 daemon
- 客户端发 session.stop  → server 记录 `desired_state=stopped`，再转发给 daemon
- Daemon 执行后上报 `actual_state`（即现有的 `state` 字段）

### 2. Daemon 连接时全量对齐

Daemon auth 成功后，server 主动推送一次 `sessions.snapshot`：

```json
{ "type": "sessions.snapshot", "sessions": [{ "name": "deck_cd_brain", "desired": "running", "actual": "running" }] }
```

Daemon 收到后做差分：
- `desired=running` 但本地没有 → 启动 session
- `desired=stopped` 但本地还在跑 → 停止 session
- 本地有但 server 没有 → 上报给 server（孤儿 session，仍保持运行）

### 3. Daemon 掉线处理

Server 检测到 daemon WS 断开时，将该 server 下所有 `actual_state=running` 的 session 标记为 `actual_state=disconnected`，前端显示对应状态。

Daemon 重连并对齐后恢复为 `running`。

---

## 实现步骤

### Step 1 — DB 迁移
- `sessions` 表加 `desired_state VARCHAR(20) DEFAULT 'running'`
- 写迁移文件 `server/migrations/000X_session_desired_state.sql`

### Step 2 — Server 推 sessions.snapshot
- `server/src/ws/bridge.ts`：auth 成功后查 DB 拼 `sessions.snapshot` 推给 daemon

### Step 3 — Daemon 处理 sessions.snapshot
- `src/daemon/command-handler.ts`：新增 `sessions.snapshot` handler，做差分对齐
- 替换掉 `syncSessionsFromWorker`（HTTP 轮询）改为 WS 推送

### Step 4 — session.start / session.stop 先写 DB
- `server/src/routes/session-mgmt.ts`：start 时写 `desired_state=running`，stop 时写 `desired_state=stopped`，再转发 daemon

### Step 5 — Daemon 掉线标记
- `server/src/ws/bridge.ts`：WS close 事件时批量更新 `actual_state=disconnected`

### Step 6 — 删除孤儿扫描 workaround
- `src/agent/session-manager.ts`：删除 `restoreFromStore` 中的孤儿发现逻辑（由 snapshot 对齐取代）

---

## 不做的事（保持简单）

- 不做 session 版本号/乐观锁（单 daemon 场景不需要）
- 不做多 daemon 并发冲突解决
- 不做 session 历史日志

## 文件改动一览

| 文件 | 变更 |
|------|------|
| `server/migrations/000X_session_desired_state.sql` | 新增 `desired_state` 字段 |
| `server/src/ws/bridge.ts` | auth 后推 snapshot；WS close 标记 disconnected |
| `server/src/routes/session-mgmt.ts` | start/stop 先写 desired_state |
| `server/src/db/queries.ts` | 对应 DB 查询更新 |
| `src/daemon/command-handler.ts` | 处理 sessions.snapshot，做差分 |
| `src/daemon/lifecycle.ts` | 删除 syncSessionsFromWorker HTTP 调用 |
| `src/agent/session-manager.ts` | 删除孤儿扫描，简化 restoreFromStore |
