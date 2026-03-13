# 认证安全整改 — 开发文档

基于 2026-03-13 安全审计报告，6 项整改任务。

---

## 实施后审查结果（2026-03-13）

本次按“代码已完成”进行了复审。结论：主方案已落地，但仍有 3 个问题需回修后才能算通过。

### 发现 1（高危）：Origin 校验可被前缀绕过

- 位置：`server/src/security/csrf.ts:63`
- 现状：`origin.startsWith(allowedOrigin)` 判定为通过。
- 风险：若允许 `https://app.example.com`，攻击源 `https://app.example.com.attacker.tld` 也会被放行，CSRF 防护被绕过。
- 建议修复：
  - 将 `Origin` / `Referer` 解析为 URL 后，仅比较 `origin.protocol + '//' + origin.host` 与白名单完全相等；
  - 禁止前缀匹配。

### 发现 2（中危）：自动 refresh 未携带 CSRF Header，续期可能失败

- 位置：`web/src/api.ts:21-26`（`doRefresh()`）
- 现状：`POST /api/auth/refresh` 仅带 `credentials: 'include'`，未带 `X-CSRF-Token`。
- 风险：当 `rcc_session` cookie 仍存在时，服务端 CSRF 中间件会拦截 refresh，导致前端续期失败并触发错误登出。
- 建议修复：
  - refresh 请求与普通写请求一致，附带 `X-CSRF-Token`；
  - 或在服务端仅对 refresh 路由做受控豁免（不推荐，优先前者）。

### 发现 3（中危）：缺失 Origin/Referer 时默认放行，CSRF 防护退化

- 位置：`server/src/security/csrf.ts:54`
- 现状：`!origin` 直接 `return true`。
- 风险：在部分请求路径中若缺失 `Origin/Referer`，写请求会绕过来源校验。
- 建议修复：
  - 对“cookie 会话 + 非幂等请求”要求必须存在 `Origin` 或 `Referer`，缺失即 403；
  - 仅在 `NODE_ENV=development` 下可放宽。

### 审查结论

- 状态：`NEEDS_FIX`
- 通过条件：以上 3 项修复并补对应测试后可通过。

---

## 实施后二次复审（2026-03-13，代码修复后）

本轮针对上一版 `NEEDS_FIX` 项进行了复审。

### 已确认修复

1. `server/src/security/csrf.ts` 已移除 `startsWith`，改为 URL 规范化后的精确匹配，前缀域名绕过已关闭。  
2. `web/src/api.ts` 的 refresh 已走 `rawFetch('/api/auth/refresh', { method: 'POST' })`，会自动携带 `X-CSRF-Token`。  
3. `server/src/security/csrf.ts` 对 cookie 会话写请求在生产环境要求 `Origin/Referer` 必须存在，缺失会 403。  

### 新发现（中危）

1. **OAuth 路由缺少 `Cache-Control: no-store` 响应头**  
   - 位置：`server/src/routes/github-auth.ts`（`GET /api/auth/github` 与 `GET /api/auth/github/callback`）  
   - 现状：`authRoutes` 下已统一加 `no-store`，但 GitHub OAuth 路由是独立 Router，未加同等缓存控制。  
   - 风险：OAuth 相关跳转/错误响应在浏览器或中间层缓存策略下可能被不当缓存，增加认证流程可见性与状态混淆风险。  
   - 建议修复：在 `githubAuthRoutes.use('/*', ...)` 增加 `Cache-Control: no-store` 和 `Pragma: no-cache`。  

### 二次复审结论

- 状态：`NEEDS_FIX`（仅剩 1 项中危）  
- 通过条件：补齐 OAuth 路由 no-store 头后可转 `PASS`。  

---

## 实施后三次复审（2026-03-13，最新代码）

按最新代码再次复审后，结论与二次复审一致：前两轮问题已修复，仍剩 1 个中危未闭环。

### 未闭环问题（中危）

1. **OAuth 路由仍未设置 `Cache-Control: no-store` / `Pragma: no-cache`**  
   - 位置：`server/src/routes/github-auth.ts`（`GET /api/auth/github` 与 `GET /api/auth/github/callback`）  
   - 核对结果：最新代码中未看到 `githubAuthRoutes.use('/*', ...)` 或等效 header 设置。  
   - 修复建议（最小改动）：
     ```ts
     githubAuthRoutes.use('/*', async (c, next) => {
       await next();
       c.header('Cache-Control', 'no-store');
       c.header('Pragma', 'no-cache');
     });
     ```

### 三次复审结论

- 状态：`NEEDS_FIX`  
- 通过条件：补齐上述 header 后，当前审查可转 `PASS`。  

---

## 实施后四次复审（2026-03-13，最终复核）

本轮复核确认上轮唯一未闭环问题已修复：

1. `server/src/routes/github-auth.ts` 在 `GET /api/auth/github` 与 `GET /api/auth/github/callback` 均已设置：
   - `Cache-Control: no-store`
   - `Pragma: no-cache`

### 四次复审结论

- 状态：`PASS`
- 结论：当前认证整改项已满足本轮审查通过条件，可进入合并/发布流程。

---

## 变更总览

| # | 级别 | 任务 | 涉及文件 | 优先级 |
|---|------|------|---------|--------|
| 1 | 高危 | OAuth 回调 Token 改 HttpOnly Cookie | `github-auth.ts`, `authorization.ts`, `app.tsx`, `api.ts` | P0 |
| 2 | 中高危 | 去掉 localStorage 持久化 JWT | `app.tsx`, `api.ts`, `ws-client.ts` | P0 |
| 3 | 中危 | OAuth State 会话绑定 + 一次性消费 | `github-auth.ts` | P0 |
| 4 | 新增 | CSRF 防护（Cookie 认证引入） | `index.ts`（中间件）, `api.ts` | P0 |
| 5 | 中危 | OAuth 回调对齐已有 refresh token 机制 | `github-auth.ts`, `app.tsx`, `api.ts` | P1 |
| 6 | 中低危 | 限速/锁定迁移 PostgreSQL | `lockout.ts`, 新增 migration | P2 |

**开发顺序**：P0 四项合并为一个 PR（认证流程一次切换），P1/P2 分开推进。

---

## 任务 1：OAuth 回调 Token 改 HttpOnly Cookie

### 现状

`github-auth.ts:91-95` 将 JWT 放入重定向 URL `?token=...&userId=...`，前端 `app.tsx:76-84` 从 `window.location.search` 读取。Token 进入浏览器历史、Referer 头、反代日志。

### 开发要求

#### 1.1 服务端：`server/src/routes/github-auth.ts` callback

- 删除 `redirectUrl.searchParams.set('token', sessionToken)` 和 `redirectUrl.searchParams.set('userId', user.id)`
- 改为 `setCookie(c, 'rcc_session', sessionToken, { httpOnly: true, secure: c.env.NODE_ENV === 'production', sameSite: 'Lax', path: '/', maxAge: 86400 })`
- 重定向到 `c.env.SERVER_URL`（不带任何 query params）

#### 1.2 服务端：`server/src/security/authorization.ts` resolveAuth()

- 在 Bearer 之前优先从 cookie 读取 token：
  ```typescript
  import { getCookie } from 'hono/cookie';
  const cookieToken = getCookie(c, 'rcc_session');
  ```
- 解析顺序：Cookie → `Authorization: Bearer` (API key `deck_*`) → Bearer (JWT)
- `Authorization: Bearer` **必须保留** — daemon、CLI、API key 依赖它

#### 1.3 前端：`web/src/app.tsx`

- 删除 L74-84 从 URL search params 读取 token 的 `useEffect`
- 删除 `localStorage.setItem('rcc_auth', ...)` 中的 token 字段
- 启动时调 `GET /api/auth/user/me` 判断登录态（而非读 localStorage token）

#### 1.4 前端：`web/src/api.ts`

- `apiFetch` 加 `credentials: 'include'`
- 保留 `Authorization: Bearer` header（仅当 `_token` 非空时设置，兼容非 cookie 场景）

#### 1.5 WebSocket 鉴权

当前 WS 使用 ws-ticket 机制（`POST /api/auth/ws-ticket` → 15 秒一次性 ticket → URL query `?ticket=`）。此流程不受影响——ws-ticket 请求本身会自动携带 cookie 鉴权。**无需改动 WS 鉴权逻辑**。

### 验收标准

- [ ] OAuth callback 重定向 URL **不含** token/userId query params
- [ ] 重定向后浏览器 `Set-Cookie` 头包含 `rcc_session`，属性为 `HttpOnly; SameSite=Lax; Path=/`
- [ ] 生产环境 cookie 带 `Secure` 标志；`NODE_ENV=development` 时不带
- [ ] `GET /api/auth/user/me` 仅凭 cookie 即可返回用户信息
- [ ] `Authorization: Bearer <api_key>` 仍可正常访问所有 API
- [ ] daemon 通过 `X-Server-Id` + Bearer token 鉴权不受影响
- [ ] WS 连接流程正常（ws-ticket 获取 + 连接）

---

## 任务 2：去掉 localStorage 持久化 JWT

### 现状

`app.tsx:44` 将完整 `AuthState`（含 token）存入 `localStorage.rcc_auth`。XSS 可直接窃取。

### 开发要求

#### 2.1 `web/src/app.tsx`

- `AuthState` 改为 `{ userId: string; baseUrl: string }`，去掉 `token` 字段
- `localStorage.rcc_auth` 仅存 `{ userId, baseUrl }`（用于 UI 快速判断是否可能已登录）
- 真正的登录态确认改为：启动时调 `GET /api/auth/user/me`，401 → 清 localStorage → 跳登录页
- 删除 `configure(state.baseUrl, state.token)` 中的 token 传递

#### 2.2 `web/src/api.ts`

- `configure()` 签名改为 `configure(baseUrl: string)`，去掉 token 参数
- `_token` 变量删除
- 所有请求依赖 `credentials: 'include'` 携带 cookie

#### 2.3 `web/src/ws-client.ts`

- WS ticket 获取请求（`POST /api/auth/ws-ticket`）改用 `credentials: 'include'`

### 验收标准

- [ ] `localStorage.rcc_auth` 中 **不含** token 字段
- [ ] `document.cookie` 中 **不可读** `rcc_session`（HttpOnly 阻止 JS 访问）
- [ ] 刷新页面后，通过 cookie 自动恢复登录态
- [ ] 清除 cookie 后刷新，跳转登录页

---

## 任务 3：OAuth State 会话绑定 + 一次性消费

### 现状

`github-auth.ts:11` state 为可验签 JWT，仅校验签名 + 过期。无会话绑定，可 replay。

### 开发要求

#### 3.1 `server/src/routes/github-auth.ts` — 发起 OAuth

```typescript
const stateValue = randomHex(32);
const stateJwt = signJwt({ nonce: stateValue }, c.env.JWT_SIGNING_KEY, 600);

setCookie(c, 'oauth_state', stateValue, {
  httpOnly: true,
  secure: c.env.NODE_ENV === 'production',
  sameSite: 'Lax',
  path: '/api/auth/github/callback',
  maxAge: 600,
});
```
- URL 中的 `state` 参数仍为 JWT（传给 GitHub）
- Cookie `oauth_state` 存明文 nonce（浏览器绑定）

#### 3.2 `server/src/routes/github-auth.ts` — callback 验证

```typescript
const cookieState = getCookie(c, 'oauth_state');
const jwtPayload = verifyJwt(state, c.env.JWT_SIGNING_KEY);
if (!cookieState || !jwtPayload || cookieState !== jwtPayload.nonce) {
  return c.json({ error: 'state_mismatch' }, 400);
}
deleteCookie(c, 'oauth_state', { path: '/api/auth/github/callback' });
```
- Cookie nonce 必须与 JWT 中的 nonce 一致
- 验证后立即删除 cookie（一次性消费）

### 验收标准

- [ ] OAuth 发起时设置 `oauth_state` cookie（HttpOnly, 600s TTL, path 限定 callback）
- [ ] Callback 验证 cookie nonce == JWT nonce
- [ ] 验证后 `oauth_state` cookie 被删除
- [ ] 重放同一 state（同一 callback URL 第二次请求）→ 400 `state_mismatch`
- [ ] 不带 `oauth_state` cookie 的 callback 请求 → 400

---

## 任务 4：CSRF 防护

### 背景

认证从 Bearer 切到 Cookie 后，浏览器自动带凭证，写操作接口可遭 CSRF。

### 开发要求

#### 4.1 服务端中间件：`server/src/index.ts` 或新建 `server/src/security/csrf.ts`

对所有通过 Cookie 鉴权的非幂等请求（`POST/PUT/PATCH/DELETE`）执行：

1. **Origin 校验**：`Origin` 或 `Referer` 必须在 `ALLOWED_ORIGINS` 中
2. **CSRF Token 校验**（double-submit cookie）：
   - 登录成功时签发 `rcc_csrf` cookie（**非** HttpOnly，JS 需读取）
   - 值为 `randomHex(32)`，签入 JWT 或直接比对
   - 前端写请求带 `X-CSRF-Token` header
   - 后端校验 `X-CSRF-Token` header == `rcc_csrf` cookie

3. **跳过条件**：请求通过 `Authorization: Bearer` 鉴权时（API key / daemon），不做 CSRF 检查

#### 4.2 `server/src/routes/github-auth.ts` callback

- 登录成功设置 `rcc_session` 时，同时设置 `rcc_csrf` cookie：
  ```typescript
  setCookie(c, 'rcc_csrf', randomHex(32), {
    httpOnly: false,  // 前端需要读
    secure: c.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });
  ```

#### 4.3 `web/src/api.ts`

- `apiFetch` 对非 GET 请求自动读取 `document.cookie` 中的 `rcc_csrf` 并设 `X-CSRF-Token` header：
  ```typescript
  if (method !== 'GET') {
    const csrf = document.cookie.match(/rcc_csrf=([^;]+)/)?.[1];
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  ```

### 验收标准

- [ ] 非幂等请求（POST/PUT/PATCH/DELETE）缺少 `X-CSRF-Token` header → 403
- [ ] 非幂等请求 `X-CSRF-Token` 与 cookie 不一致 → 403
- [ ] 非幂等请求 `Origin` 不在 `ALLOWED_ORIGINS` 中 → 403
- [ ] GET 请求不受 CSRF 检查影响
- [ ] `Authorization: Bearer` 鉴权的请求不受 CSRF 检查影响
- [ ] `NODE_ENV=development` 且无 `ALLOWED_ORIGINS` 时，Origin 校验放行

---

## 任务 5：OAuth 回调对齐 Refresh Token 机制

### 现状

`auth.ts` 已有完整 refresh 机制（access 15min + refresh 30d + rotation + family_id），但 `github-auth.ts:89` 签发的 session token 有效期 24h，绕过了 refresh 流程。

### 开发要求

#### 5.1 `server/src/routes/github-auth.ts` callback

- Access token 有效期改为 15 分钟（与 `auth.ts:286` 一致）：
  ```typescript
  const sessionToken = signJwt({ sub: user.id, type: 'web' }, c.env.JWT_SIGNING_KEY, 15 * 60);
  ```
- 同时签发 refresh token 并写入 DB：
  ```typescript
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(refreshId, user.id, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()).run();
  ```
- 两个 token 通过 cookie 传递：
  - `rcc_session`：access token, `path: /`, `maxAge: 900`
  - `rcc_refresh`：refresh token, `path: /api/auth/refresh`, `maxAge: 30 * 86400`

#### 5.2 `server/src/routes/auth.ts` — refresh endpoint 改造

- 当前 refresh token 通过 JSON body 传入；改为同时支持 cookie：
  ```typescript
  const refreshToken = getCookie(c, 'rcc_refresh') ?? parsed?.data?.refreshToken;
  ```
- 响应改为设置 cookie（而非 JSON body 返回 token）：
  ```typescript
  setCookie(c, 'rcc_session', accessToken, { httpOnly: true, secure: ..., sameSite: 'Lax', path: '/', maxAge: 900 });
  setCookie(c, 'rcc_refresh', newRefresh, { httpOnly: true, secure: ..., sameSite: 'Lax', path: '/api/auth/refresh', maxAge: 30 * 86400 });
  return c.json({ ok: true });
  ```
- 保留 JSON body 方式兼容 CLI/API

#### 5.3 新增 `POST /api/auth/logout`

```typescript
authRoutes.post('/logout', async (c) => {
  const userId = await resolveUserId(c);
  deleteCookie(c, 'rcc_session', { path: '/' });
  deleteCookie(c, 'rcc_refresh', { path: '/api/auth/refresh' });
  deleteCookie(c, 'rcc_csrf', { path: '/' });
  if (userId) {
    await c.env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .bind(Date.now(), userId).run();
  }
  return c.json({ ok: true });
});
```

#### 5.4 前端：`web/src/api.ts` 自动 refresh

```typescript
let refreshPromise: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const res = await doFetch('/api/auth/refresh', { method: 'POST' });
  return res.ok;
}

export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await doFetch(path, opts);
  if (res.status === 401 && path !== '/api/auth/refresh') {
    // Single-flight: 多个并发 401 共享同一个 refresh Promise
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
    }
    const ok = await refreshPromise;
    if (ok) return doFetch(path, opts).then(r => r.json());
    // refresh 也失败 → 跳登录
    window.location.href = '/login';
    throw new ApiError(401, 'session_expired');
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}
```

#### 5.5 认证接口禁止缓存

以下端点的响应必须设置 `Cache-Control: no-store` + `Pragma: no-cache`：
- `GET /api/auth/user/me`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/github/callback`（重定向响应）

可通过 Hono 中间件统一处理 `/api/auth/*` 路由：
```typescript
authRoutes.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});
```

#### 5.6 前端：Logout

- `app.tsx` logout handler 改为调 `POST /api/auth/logout`（清 cookie），再清 localStorage UI 状态

### 验收标准

- [ ] OAuth 登录后 `rcc_session` cookie 有效期 ≤ 15 分钟
- [ ] OAuth 登录后 `rcc_refresh` cookie 设置正确（HttpOnly, path `/api/auth/refresh`）
- [ ] Access token 过期后，前端自动 refresh → 无感续期
- [ ] 并发 10 个请求同时 401 时仅触发 1 次 refresh，其余等待后重试成功
- [ ] Refresh token 过期后，前端跳转登录页
- [ ] Logout 后所有 cookie 清除 + DB 中 refresh token 标记 used
- [ ] Logout 后旧 access token 15 分钟内过期（可接受窗口）
- [ ] `/api/auth/*` 响应头包含 `Cache-Control: no-store`
- [ ] CLI / API key 方式不受影响

---

## 任务 6：限速/锁定迁移 PostgreSQL

### 现状

`lockout.ts:11` 使用 `MemoryRateLimiter` 进程内存。多实例部署下状态不共享。

### 开发要求

#### 6.1 新增 migration

`server/src/db/migrations/NNNN_auth_lockout.sql`：

```sql
CREATE TABLE IF NOT EXISTS auth_lockout (
  identity    TEXT PRIMARY KEY,
  fail_count  INT NOT NULL DEFAULT 0,
  first_fail_at TIMESTAMPTZ,
  locked_until  TIMESTAMPTZ
);

CREATE INDEX idx_auth_lockout_locked ON auth_lockout (locked_until)
  WHERE locked_until IS NOT NULL;
```

#### 6.2 改造 `server/src/security/lockout.ts`

- `recordAuthFailure(db, identity)` — UPSERT 逻辑：
  - 首次失败后超过 15 分钟的旧记录重置 `fail_count=1`
  - 5 次失败后设 `locked_until = NOW() + 15 minutes`
- `checkAuthLockout(db, identity)` — 查询 `locked_until > NOW()`
- 所有调用方（`auth.ts` refresh 等）传入 `c.env.DB`

#### 6.3 清理

- 定期清理 migration 或 cron：`DELETE FROM auth_lockout WHERE locked_until < NOW() - INTERVAL '1 day'`
- 可加入现有 cron 调度（`index.ts:216` 的 5 分钟 cron）

### 验收标准

- [ ] `auth_lockout` 表创建成功（migration 通过）
- [ ] 5 次失败后 `checkAuthLockout` 返回 `locked: true`
- [ ] 锁定 15 分钟后自动解除
- [ ] 超过 15 分钟未失败的记录自动重置计数
- [ ] 多进程/多实例下锁定状态共享

---

## 测试规划

### 单元测试

新建 `server/src/routes/__tests__/github-auth.test.ts`：

```typescript
describe('OAuth callback', () => {
  it('sets rcc_session as HttpOnly cookie, no token in redirect URL', async () => {
    // Mock GitHub token exchange + user fetch
    // Assert: response is 302 redirect to SERVER_URL (no ?token= params)
    // Assert: Set-Cookie header contains rcc_session with HttpOnly flag
  });

  it('rejects callback with missing oauth_state cookie', async () => {
    // Send callback request without oauth_state cookie
    // Assert: 400 state_mismatch
  });

  it('rejects callback with mismatched state nonce', async () => {
    // Send callback with oauth_state cookie != JWT nonce
    // Assert: 400 state_mismatch
  });

  it('deletes oauth_state cookie after successful callback (one-time use)', async () => {
    // Assert: Set-Cookie oauth_state with Max-Age=0 or expires in past
  });

  it('issues refresh token cookie alongside access token', async () => {
    // Assert: Set-Cookie rcc_refresh with path=/api/auth/refresh
    // Assert: refresh_tokens table has new row
  });
});

describe('OAuth initiate', () => {
  it('sets oauth_state cookie with HttpOnly and correct path', async () => {
    // GET /api/auth/github
    // Assert: Set-Cookie oauth_state, HttpOnly, path=/api/auth/github/callback, maxAge=600
  });
});
```

新建或扩展 `server/src/security/__tests__/csrf.test.ts`：

```typescript
describe('CSRF middleware', () => {
  it('allows GET requests without CSRF token', async () => {
    // GET with cookie auth only → 200
  });

  it('blocks POST with cookie auth but no X-CSRF-Token', async () => {
    // POST with rcc_session cookie, no X-CSRF-Token → 403
  });

  it('blocks POST with mismatched X-CSRF-Token', async () => {
    // POST with rcc_session + X-CSRF-Token != rcc_csrf cookie → 403
  });

  it('allows POST with matching X-CSRF-Token', async () => {
    // POST with rcc_session + X-CSRF-Token == rcc_csrf cookie → pass through
  });

  it('skips CSRF check for Bearer auth (API key)', async () => {
    // POST with Authorization: Bearer deck_xxx, no CSRF token → pass through
  });

  it('skips CSRF check for daemon server-token auth', async () => {
    // POST with X-Server-Id + Bearer server-token → pass through
  });

  it('validates Origin header against ALLOWED_ORIGINS', async () => {
    // POST with cookie auth + wrong Origin → 403
    // POST with cookie auth + correct Origin → pass through
  });
});
```

新建或扩展 `server/src/security/__tests__/authorization.test.ts`：

```typescript
describe('resolveAuth with cookie support', () => {
  it('resolves user from rcc_session cookie', async () => {
    // Request with valid JWT in rcc_session cookie, no Authorization header
    // Assert: returns correct userId
  });

  it('prefers cookie over missing Authorization header', async () => {
    // Request with only cookie → auth succeeds
  });

  it('falls back to Bearer when no cookie present', async () => {
    // Request with Authorization: Bearer <jwt>, no cookie → auth succeeds
  });

  it('API key auth still works via Bearer', async () => {
    // Request with Authorization: Bearer deck_xxx → auth succeeds
  });

  it('daemon server-token auth still works', async () => {
    // Request with X-Server-Id + Bearer → auth succeeds
  });
});
```

扩展 `server/src/security/__tests__/lockout.test.ts`（DB 版）：

```typescript
describe('DB-backed auth lockout', () => {
  it('locks after 5 failures', async () => {
    for (let i = 0; i < 5; i++) await recordAuthFailure(db, 'test-ip');
    expect((await checkAuthLockout(db, 'test-ip')).locked).toBe(true);
  });

  it('unlocks after 15 minutes', async () => {
    // Insert lockout record with locked_until in the past
    expect((await checkAuthLockout(db, 'test-ip')).locked).toBe(false);
  });

  it('resets count after 15 minute window', async () => {
    // Insert old failure record, new failure should reset to count=1
  });
});
```

### 集成测试

扩展 `server/src/routes/__tests__/auth-flow.test.ts`（或新建）：

```typescript
describe('Full auth flow (integration)', () => {
  it('OAuth login → cookie auth → API access → refresh → logout', async () => {
    // 1. Simulate OAuth callback → get Set-Cookie headers
    // 2. Use cookies to call GET /api/auth/user/me → 200
    // 3. Wait/mock access token expiry
    // 4. Call any API → 401 → call POST /api/auth/refresh with rcc_refresh cookie → new cookies
    // 5. Call POST /api/auth/logout → cookies cleared
    // 6. Call GET /api/auth/user/me → 401
  });

  it('OAuth state replay is rejected', async () => {
    // 1. GET /api/auth/github → capture state + oauth_state cookie
    // 2. First callback with correct state + cookie → success
    // 3. Second callback with same state (cookie already deleted) → 400
  });

  it('CSRF protection blocks cross-origin POST', async () => {
    // 1. Login via OAuth → get rcc_session + rcc_csrf cookies
    // 2. POST /api/server without X-CSRF-Token → 403
    // 3. POST /api/server with wrong X-CSRF-Token → 403
    // 4. POST /api/server with correct X-CSRF-Token → pass
  });

  it('Bearer auth bypass CSRF (API key)', async () => {
    // POST with Authorization: Bearer deck_xxx, no CSRF → succeeds
  });

  it('lockout persists across connections', async () => {
    // 1. Send 5 failed refresh attempts
    // 2. New connection, same IP → 429
  });

  it('auth endpoints return Cache-Control: no-store', async () => {
    // GET /api/auth/user/me → Cache-Control: no-store
    // POST /api/auth/refresh → Cache-Control: no-store
    // POST /api/auth/logout → Cache-Control: no-store
  });
});
```

### 前端测试

扩展 `web/test/`：

```typescript
describe('api.ts', () => {
  it('sends credentials: include on all requests', () => {
    // Mock fetch, verify credentials option
  });

  it('attaches X-CSRF-Token from cookie on non-GET requests', () => {
    // Set document.cookie with rcc_csrf, call apiFetch POST
    // Verify X-CSRF-Token header matches
  });

  it('auto-refreshes on 401 and retries original request', async () => {
    // First call → 401, refresh call → 200, retry → 200
  });

  it('single-flight: concurrent 401s share one refresh call', async () => {
    // 10 parallel apiFetch calls all get 401
    // Assert: fetch('/api/auth/refresh') called exactly once
    // All 10 calls eventually resolve after refresh succeeds
  });

  it('redirects to login when refresh also fails', async () => {
    // First call → 401, refresh → 401 → location change
  });
});

describe('app.tsx auth state', () => {
  it('does not store token in localStorage', () => {
    // After login flow, check localStorage.rcc_auth has no token field
  });

  it('determines login state via /api/auth/user/me, not localStorage token', () => {
    // Mock /api/auth/user/me → 200, verify auth state set
    // Mock /api/auth/user/me → 401, verify redirect to login
  });
});
```

---

## 二次审查补充意见处理

| 项 | 内容 | 处置 |
|----|------|------|
| A | Refresh 并发控制（single-flight） | **已纳入** 任务 5.4 代码 |
| B | 认证接口 `Cache-Control: no-store` | **已纳入** 任务 5.5 |
| C | Cookie Domain / SameSite 策略 | **备注**：本期仅支持同源部署，跨域后续任务 |
| D | OAuth state 并发重放 | **P1 增强项**：引入服务端 nonce 存储，不阻塞 P0 |
| E | Logout CSRF + Bearer 优先级 | **已纳入** 任务 4（CSRF 中间件跳过 Bearer）+ 任务 5.3 |
| F | 审计字段 + 日志脱敏 | **P2**：`auth_method` 审计字段 + 脱敏规则，独立任务 |

### 备注：本期约束

- **同源部署**：前后端同源（`SameSite=Lax` 足够），不设 `Domain` 属性。跨子域部署需求出现时再评估 `SameSite=None; Secure` + CORS 配置。
- **Logout CSRF**：`POST /api/auth/logout` 走 CSRF 校验。若请求同时存在 cookie 与 Bearer，按 Bearer 身份处理，仅清 cookie，不影响 API key 流程。

---

## 回归检查清单

完成所有任务后，确认以下场景不受影响：

- [ ] daemon 启动 → `X-Server-Id` + Bearer token 鉴权 → WS 连接正常
- [ ] CLI 通过 API key (`deck_*`) 访问所有 API
- [ ] 浏览器 WS 连接：ws-ticket 获取（cookie 鉴权）→ ticket 连接
- [ ] 多 server 切换 → 各 server WS 独立工作
- [ ] 移动端（iOS/Android webview）cookie 行为正常
- [ ] `NODE_ENV=development` 本地 HTTP 调试 → cookie 无 Secure 标志 → 正常工作
- [ ] 并发 10 个请求同时 401 时仅触发 1 次 refresh，其余请求等待后重试成功
- [ ] 认证相关响应头包含 `Cache-Control: no-store`
