# 计划：修复 WsBridge 订阅泄漏与广播回退问题

## 背景
在 `server/src/ws/bridge.ts` 中，`relayToBrowsers` 函数目前采用"故障开启"策略。如果消息（如 `terminal_update` 或 `timeline.replay`）缺少 `sessionName` 或其类型未被显式捕获，它会通过 `broadcastToBrowsers()` 泄露给所有连接的查看者。这在多用户环境中存在严重的隐私风险。

## 目标
- 将路由策略改为"默认拒绝"。
- 确保所有 session 作用域的数据仅路由至已订阅的浏览器。
- 严禁任何包含敏感内容的 session 数据（终端流、聊天历史）回退到广播逻辑。

## 详细变更

### 1. 重构 `relayToBrowsers` 逻辑
- 使用显式的 `return` 确保每个分支处理完后立即结束。
- **删除** 函数末尾的 `this.broadcastToBrowsers(JSON.stringify(msg))`。
- **白名单广播类型**：仅允许 `session_list`、`session_event`、`daemon.reconnected` 等明确需要全局更新的消息。
- **Session 作用域强制检查**：
  - 对于 `terminal_update`、`timeline.event`、`timeline.history`、`timeline.replay` 等，如果 `sessionName` / `sessionId` 丢失，直接 **丢弃** 并记录警告日志。

### 2. 受影响的消息类型及其路由策略
| 消息类型 | 路由策略 | 缺少 Session ID 时的行为 |
| :--- | :--- | :--- |
| `terminal_update` | 仅限订阅者 | 丢弃 |
| `timeline.event` | 仅限订阅者 | 丢弃 |
| `timeline.history` / `.replay` | 仅限订阅者 | 丢弃 |
| `command.ack` | 仅限订阅者 | 丢弃 |
| `subsession.response` | 仅限订阅者 | 丢弃 |
| `session.idle` / `.notification` | 仅限订阅者 | 丢弃 |
| `session_list` | 广播 (全局) | N/A |
| `session_event` | 广播 (全局) | N/A |
| `daemon.reconnected` | 广播 (全局) | N/A |

## 实施步骤
1. 修改 `server/src/ws/bridge.ts` 中的 `relayToBrowsers`。
2. 在 `server/test/bridge.test.ts` 中添加测试用例：
   - 验证缺少 `sessionName` 的 `terminal_update` 不会被广播。
   - 验证未知类型的消息不会被广播。
   - 验证 `session_list` 依然能正确广播。

## 验证指标
- 所有 session 作用域的测试用例必须通过。
- 运行 `vitest server/test/bridge.test.ts` 确认逻辑无误。
