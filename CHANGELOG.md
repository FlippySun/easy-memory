# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.5] - 2026-03-07

### Added

- **[MCP] Preferred alias tools**: 新增 `easy_memory_save`、`easy_memory_search`、`easy_memory_forget`、`easy_memory_status` 四个更强可发现的 MCP alias，同时保留原有 `memory_*` 作为兼容名。
- **[Tests] Alias parity coverage**: 新增 alias/canonical 行为等价测试，覆盖本地 MCP、远程代理和 server-card discoverability 元数据一致性。

### Changed

- **[MCP] Memory backend priority metadata**: 本地直连、远程代理与 server-card 全部统一为 easy-memory 为 primary memory backend 的对外语义。
- **[MCP] Version metadata alignment**: `src/mcp/server.ts`、`src/mcp/remote-server.ts` 与 `src/api/server.ts` 的服务版本元数据统一对齐到 `0.5.5`。
- **[Docs] Copilot instructions**: 仓库级 AI 指引更新为优先使用 `easy_memory_*` alias，并保留 `memory_*` 兼容名说明。
- **[CI] npm publish workflow idempotence**: `publish-npm.yml` 在 tag 发布前会先检查 npm 上是否已存在当前版本，已存在则自动跳过，避免手动补发后再次推 tag 导致 workflow 无谓失败。

### Tests

- **发布前验证通过**: focused Vitest (`tests/api/server.test.ts`, `tests/mcp/server.test.ts`, `tests/mcp/remote-server.test.ts`) 全绿，`pnpm typecheck` 通过。

## [0.5.4] - 2026-03-06

### Added

- **[Web] Analytics 增强**: 新增 Memory Growth 趋势图、Search Quality 指标面板、Performance Breakdown 柱状图（Avg/P95/Max 三维分析）
- **[Web] Audit Logs 增强**: 新增 device_id、git_branch、memory_scope 三个过滤维度 + 事件详情抽屉
- **[Web] Memory Browser 页面**: 全新记忆浏览页面，支持卡片/表格双视图、多维过滤（project/scope/type/lifecycle/device/branch/tag）、分页、编辑、归档
- **[API] Memory Browser API**: `GET /api/memories` 浏览 + `GET /api/memories/stats` 统计 + `PATCH /api/memories/:project/:id` 更新
- **[API] Enhanced Analytics API**: `GET /api/admin/analytics/memory-growth` + `search-quality` + `performance` + Audit Event Detail
- **[Security] 用户数据隔离**: `createUserScopeMiddleware` 实现 — 非 admin 用户仅可见/修改自己 API Key 创建的记忆
- **[Security] adminOrUserAuth 上下文注入**: JWT 认证成功后注入 `authUserId` / `authUserRole` 供下游中间件使用

### Fixed

- **[Critical] SQL operation name mismatch**: `analytics.ts` 中 `getMemoryGrowthTrend` 和 `getSearchQualityMetrics` 的 SQL 查询使用 `'save'`/`'search'` 但审计日志记录的是 `'memory_save'`/`'memory_search'`
- **[Critical] Performance 类型不匹配**: 前端使用 `avg_elapsed_ms`/`avg_embedding_ms`/`avg_qdrant_ms` 但后端返回 `avg_ms`/`p95_ms`/`max_ms`
- **[Critical] Enum 值不匹配**: MemoryBrowser/AuditLogs 的 memory_type（fact/preference/snippet → long_term/short_term）和 memory_scope（session/user → branch）下拉值与后端 Zod schema 不一致
- **[Critical] bearerAuth 阻断 Cookie JWT**: `/api/memories` 路由被 bearerAuth 拦截导致 Web UI 认证失败
- **[Critical] AbortSignal 未传递**: MemoryBrowser 的 browse() 调用创建了 AbortController 但未将 signal 传入 fetch
- **[Critical] Race condition**: AuditLogs handleRowClick 缺少 AbortController 导致快速点击竞态
- **[Bug] queryEvents 过滤条件缺失**: `analytics.ts` 的 `queryEvents()` 方法未将 `device_id`、`git_branch`、`memory_scope` 参数加入 SQL WHERE 子句，导致审计日志过滤无效
- **[Bug] 表格视图编辑失效**: MemoryBrowser 表格视图点击 Edit 按钮无反应 — 编辑表单仅在卡片视图渲染，`startEdit()` 添加自动视图切换逻辑
- **[Bug] 非管理员用户无法访问 Analytics/Audit**: `/api/admin/*` 统一使用 `adminAuth` 中间件阻断 user 角色，改为路由感知调度器 — analytics/audit 路径使用 `adminOrUserAuth` 支持权限检查

### Changed

- **[Frontend] patchLoading → patchingIds**: 从单布尔值改为 `Set<string>` 按 ID 跟踪，防止并发修改冲突
- **[Frontend] handleArchive/saveEdit**: 添加 await + 错误反馈，修复 fire-and-forget 问题
- **[Security] CSV 导出防注入**: 所有 CSV 字段统一使用 `csvEscape()` 双引号包裹，防御公式注入
- **[Security] 错误信息脱敏**: memory-routes 的 catch 块移除 `detail: msg` 字段，不再泄露 Qdrant 内部信息
- **[Frontend] MemoryBrowser**: weight 输入上限从 1 修正为 10，lifecycle 过滤新增 deprecated 选项

### Tests

- **所有测试通过**: 36 文件, 870 用例, tsc --noEmit clean, vite build clean

## [0.5.3] - 2026-03-06

### Fixed

- **[Schema] 审计日志分页上限一致性**: `AuditQuerySchema.page_size` 与 `PaginationSchema.page_size` 的 `max` 从 1000 统一降至 100，与 `ListBansQuerySchema`、`ListApiKeysQuerySchema` 保持一致。修复前 `/api/admin/audit/logs?page_size=101` 返回 200，修复后与其他管理端点行为一致返回 400。

### Changed

- **[MCP] `server.ts` 全面强化**: MCP 本地 stdio 服务器新增审计日志写入链路（`buildEntry` + `record` + `ingestEvent` 三连写），与 HTTP 模式保持对等；新增请求级 `project` 路由逻辑；完善工具错误处理。
- **[MCP] `remote-server.ts` 代理稳定性**: 改进远程代理模式的错误捕获与 backpressure 处理；增强 `EASY_MEMORY_URL` 连接失败时的用户友好错误信息。
- **[API] 认证与 RBAC 强化**: `admin-auth.ts` 完善 role downgrade 即时生效逻辑；`auth-routes.ts` 新增 `/api/auth/users` 用户列表端点（admin only）；`server.ts` 增加额外 audit middleware 覆盖路由。
- **[Tools] `forget.ts` / `save.ts` 改进**: `forget` 工具增加 soft-delete 后的 `getPointPayload` 验证；`save` 工具优化 hash 校验与脱敏顺序。
- **[Services] `qdrant.ts` 稳定性**: 新增 `getPointPayload` 方法；`upsert` 增加 wait 参数强制等待写入确认，防止幻读。
- **[Web] 管理面板 UI 细节优化**: Analytics、AuditLogs、Bans、Dashboard 页面修复分页参数溢出、筛选状态重置 bug；`api/client.ts` 统一处理 401 自动续登失败逻辑。

### Tests

- **测试 mock 漂移修复** (`tests/api/server.test.ts`): 补齐 `qdrant.getPointPayload`、`audit.buildEntry`、`audit.record`、`analytics.ingestEvent` 4 个缺失 mock，新增 audit 链路断言，消除假绿灯。
- **新增 RBAC 回归测试** (`tests/api/auth-rbac-regression.test.ts`): 覆盖 role promote/downgrade 流程及管理端点即时鉴权。
- **新增 MCP 服务测试** (`tests/mcp/server.test.ts`, `tests/mcp/remote-server.test.ts`): 单元测试 MCP 工具调用、审计链路、代理模式转发。
- **审计分页边界测试** (`tests/audit-analytics-comprehensive.test.ts`): 新增 `page_size=101→400` 边界用例及大量场景覆盖扩充。
- **总计: 36 文件, 869 测试用例全部通过**

### Added

- **[Infra] DATA_DIR 数据持久化**: 解决 Docker 容器重启后 SQLite 数据丢失问题
  - 新增 `src/utils/paths.ts`: 集中管理所有持久化文件路径 (`getDataDir()` + `DATA_PATHS`)
  - 6 个服务模块迁移: `api-key-manager`, `ban-manager`, `analytics`, `audit`, `runtime-config`, `logger` 全部使用 `DATA_PATHS`
  - Dockerfile: 创建 `/data` 目录并设置正确权限
  - docker-compose: 新增 `easy_memory_data:/data` Volume 映射
  - `DATA_DIR` 环境变量: Docker 中设为 `/data`，本地默认 `$HOME`

- **[MCP] Server Card 端点**: `/.well-known/mcp/server-card.json`
  - 无需认证的公开端点，返回服务元数据和 4 个 Tool 的完整 inputSchema
  - 支持 Smithery.ai 等 MCP 平台自动发现服务能力

- **[Config] MCP 平台注册配置文件**:
  - `smithery-config-schema.json`: Smithery stdio 模式环境变量 JSON Schema
  - `mcp-config-template.json`: mcp.so 提交表单的服务器配置模板

### Changed

- **package.json**: 丰富 `description` 和 `keywords` (新增 `mcp-server`, `persistent-memory`, `gemini`, `copilot`, `bm25`, `hybrid-search`, `semantic-search`)

### Docs

- **README.md**: 大幅扩充
  - 新增「远程代理模式」章节 (`EASY_MEMORY_TOKEN` + `EASY_MEMORY_URL`)
  - 新增「MCP Streamable HTTP 模式」章节 (直连远端 `/mcp`)
  - 扩充前置条件: Qdrant + Ollama 详细启动步骤与验证命令
  - 新增可选 Gemini Embedding 配置指南
  - 修复: 所有 SSE `/sse` 引用 → Streamable HTTP `/mcp`
  - 环境变量表新增: `DATA_DIR`, `EASY_MEMORY_TOKEN`, `EASY_MEMORY_URL`
  - 项目结构新增: `paths.ts`, `remote-server.ts`
- **USER_GUIDE.md**: 全面更新
  - 新增「方案 C: 远程代理模式」(最简部署方案)
  - 所有客户端远程配置: SSE `/sse` → Streamable HTTP `/mcp`
  - Claude Desktop 远程: "暂不支持" → 远程代理模式完整配置
  - JetBrains IDE: SSE → Streamable HTTP
  - FAQ 更新: Docker 数据持久化、Claude Desktop 远程连接
- **RELEASE_CHECKLIST.md**: 新增 Section 8「MCP 平台注册」(Smithery/Glama/mcp.so 完整发布流程)

### Tests

- 新增 `tests/utils/paths.test.ts`: 6 项路径管理测试
- 新增 server-card 端点测试 (`tests/api/server.test.ts`)
- 总计: **33 文件, 852 测试用例全部通过**

## [0.5.1] - 2025-07-07

### Fixed

- **[Critical] 前端登录页无限重载循环**: `request()` 中 401 refresh 失败后使用 `window.location.href = "/login"` 导致全页重载 → `AuthProvider` 重新 mount → `refreshUser()` 再次触发 → 无限循环（页面空白）。改用 `CustomEvent('auth:session-expired')` 通知 AuthContext 清除状态，由 React Router `<Navigate>` 处理跳转。

## [0.5.0] - 2025-07-07

### Added

- **[Security] JWT httpOnly Cookie 迁移**: 彻底消除 XSS 令牌窃取风险
  - JWT 从 `localStorage` 迁移到 `httpOnly` cookie (`em_access`)
  - Cookie 配置: `HttpOnly`, `Secure` (TLS 环境), `SameSite=Lax`, `Path=/`
  - 前端移除所有 `localStorage` 令牌操作，改用 `credentials: 'include'`
  - 后端认证中间件 (jwtAuth + adminAuth) 优先从 Cookie 读取，回退到 `Authorization` header (API 客户端向后兼容)

- **[Security] Refresh Token 机制**: Access Token 短生命周期 + 自动续签
  - Access Token 有效期从 2 小时缩短至 **15 分钟** (减小令牌暴露窗口)
  - Refresh Token: 7 天有效期，独立 `httpOnly` cookie (`em_refresh`, `SameSite=Strict`, `Path=/api/auth`)
  - SQLite `refresh_tokens` 表: 支持令牌轮转、家族追踪、复用检测
  - **令牌轮转** (Token Rotation): 每次 refresh 签发全新 access + refresh token 对，旧令牌即时撤销
  - **复用检测** (Reuse Detection): 已撤销令牌被复用 → 检测为盗用攻击 → 撤销整个令牌家族
  - **多标签页宽限期**: 60 秒内的并发 refresh 请求视为合法多标签页场景 (避免误判)
  - 新增 `POST /api/auth/refresh` — 令牌轮转端点
  - 新增 `POST /api/auth/logout` — 清除 cookies + 撤销所有用户 refresh tokens
  - 前端 401 自动 refresh: 锁机制防止并发 refresh 竞态，成功后重放原始请求

- **[Security] 级联安全守卫**:
  - 用户密码变更 → 自动撤销该用户所有 refresh tokens (强制重新登录)
  - 用户停用 (is_active=false) → 自动撤销所有 refresh tokens
  - 用户删除 → 级联删除所有 refresh tokens
  - `cleanupExpiredRefreshTokens()` 方法: 定期清理过期/已撤销令牌 (DB 卫生)

- **[Security] 被 Ban IP 登录策略**: 防止 Admin 自锁
  - `/api/auth/*` 路由免疫 IP Ban (与 `/api/admin/*` 一致)
  - Admin 被 ban 后仍可登录 → 通过 Admin Panel 解除 ban
  - 非 Admin 用户登录后记忆 API 仍被 ban 阻断 (不降低安全性)
  - 登录接口有独立限流 (10 次/分钟/IP) 防止滥用

### Changed

- **Access Token 有效期**: 7200s (2h) → 900s (15min)
- **Login API 响应**: 不再在 response body 返回 JWT token (通过 httpOnly cookie 传递)
- **jwtAuth 中间件**: 优先读取 `em_access` cookie，回退 `Authorization` header
- **adminAuth 中间件**: 同上，Cookie 路径仅支持 JWT (ADMIN_TOKEN 仍通过 header)
- **前端 AuthContext**: 移除 `localStorage` 依赖，`logout()` 调用后端端点清除 httpOnly cookies
- **前端 API Client**: `credentials: 'include'` + 自动 refresh + 并发 refresh 锁

### Tests

- 更新 `tests/services/auth.test.ts`: 适配新的 `login()` 返回结构
- 总计: **32 文件, 845 测试用例全部通过**

### Fixed (深度交叉审查)

- **[Critical] 前端 tryRefresh() 异常冒泡**: `catch` 分支将排队请求直接 `reject(err)`，导致并发 401 请求的 Unhandled Promise Rejection 绕过登录重定向 → 改为 `resolve(false)` 统一走重定向路径
- **[Critical] 前端 tryRefresh() 无超时保护**: 网关/中间人挂起 `/refresh` 请求时全局 API 永久死锁 → 引入 `AbortController` + 10 秒超时
- **[Critical] 后端 rotateRefreshToken() 非原子操作**: `INSERT` 新令牌 + `UPDATE` 旧令牌撤销之间存在幻读风险（崩溃可产生孤儿令牌）→ 包裹 `db.transaction()`
- **[Breaking] validateJsonContentType 中间件 415 拦截**: `POST /api/auth/logout` 和 `/refresh` 无 request body → `Content-Type` 校验拒绝请求 → Auth 路由豁免 Content-Type 检查
- **[Warning] logout() 异步状态延迟**: `await authApi.logout()` 期间前端仍持有已认证状态 → 幽灵请求 → 改为立即清除前端状态再执行后端清理

## [0.4.0] - 2025-07-06

### Added

- **[Phase 3] Web UI Admin Panel**: 完整的前端管理面板
  - **登录系统**: 用户名/密码登录，JWT 会话管理 (2小时过期)
  - **Dashboard**: 实时总览 — 请求量、成功率、平均延迟、系统状态
  - **API Keys 管理**: 创建 / 查看 / 启用 / 禁用 / 删除 API 密钥
  - **Ban 管理**: IP / Key 封禁创建 / 查看 / 解除
  - **Analytics 页面**: 请求时间线、操作分布柱状图、错误追踪 (支持 24h/7d/30d 时间范围切换)
  - **Audit Logs**: 审计日志浏览器 (分页 + 按操作/结果筛选)
  - **User Management**: 用户创建 / 角色切换 / 启用禁用 / 删除 (仅 admin)
  - **Settings**: 运行时配置可视化编辑 + 重置

- **[Phase 3] Auth 认证服务**: 零外部依赖的用户认证
  - `AuthService`: 用户 CRUD + 密码哈希 (scrypt, N=16384) + JWT 签发/验证 (HMAC-SHA256)
  - JWT 密钥从 `ADMIN_TOKEN` 安全派生 (HKDF-like)
  - Admin 用户种子: 通过 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量自动创建
  - Auth API: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/register`, `GET /api/auth/users`, `PATCH / DELETE /api/auth/users/:id`

- **[Phase 3] RBAC 权限系统**: 基于角色的访问控制
  - `admin`: 全部权限 (用户管理/Key管理/Ban管理/配置修改/分析/审计)
  - `user`: 只读权限 (分析查看/审计查看/记忆操作)
  - 前端路由级权限守卫 (`PermissionGuard`)

- **[Phase 3] SPA 静态文件服务**: Hono 提供 Web UI 静态文件
  - 自动 SPA 路由: 非 API 路径回退到 `index.html`
  - 智能缓存: 带 hash 的静态资源长缓存，HTML 无缓存
  - 安全: 目录穿越防护

### Stack

- **前端**: React 19 + Vite 6 + Tailwind CSS 4 + Lucide React + React Router 7
- **后端认证**: Node.js `crypto` 模块 (零新生产依赖)
- **构建**: `pnpm build:all` = 后端 tsc + 前端 vite build → `dist/web/`

### Tests

- 新增 `tests/services/auth.test.ts` (42 测试用例)
  - 密码哈希/验证、JWT 签发/验证/过期/篡改检测
  - AuthService CRUD: 登录/注册/更新/删除/RBAC
  - Admin 种子、最后一个 admin 删除保护
- 新增 `tests/types/auth-schema.test.ts` (14 测试用例)
  - 所有 Zod Schema 验证: Login/Register/UpdateUser/UserRole
  - ROLE_PERMISSIONS 结构完整性验证
- 总计: **32 文件, 845 测试用例全部通过**

### Security

- **[CRITICAL] 空 ADMIN_TOKEN JWT 伪造漏洞修复**: 当 `ADMIN_TOKEN` 为空字符串时，`deriveJwtSecret("")` 产生可预测的 HMAC-SHA256 密钥。攻击者可伪造 `sub:0` JWT token 绕过用户验证获取 admin 权限。修复：`jwtAuth` 中间件在 `adminToken` 为空时直接返回 503，拒绝所有认证请求。
- **[CRITICAL] deleteUser() 最后管理员保护绕过修复**: `deleteUser()` 中管理员计数查询未过滤 `is_active = 0` 的已禁用用户，可能导致唯一活跃管理员被删除。修复：添加 `AND is_active = 1` 条件。
- **[IMPORTANT] Auth 路由双重速率限制修复**: `/api/auth/*` 路由同时受全局速率限制器和自有登录限制器约束，导致限制过于严格。修复：全局速率限制器跳过 `/api/auth` 路径。
- **[IMPORTANT] Auth 路由双重审计记录修复**: `/api/auth/*` 路由同时被全局审计中间件和 `recordAuthAudit()` 记录，导致每次认证操作产生重复审计条目。修复：全局审计中间件跳过 `/api/auth` 路径。

### Fixed

- **Analytics 竞态条件修复**: 快速切换 timeRange 时，旧的 `Promise.all` 响应可能覆盖新数据。修复：引入 `AbortController` 和 `useRef`，切换时取消前一个请求。
- **登录权限闪烁修复**: 登录后 `permissions` 初始为空数组导致非 admin 用户短暂显示"无权限"。修复：在设置 `isAuthenticated` 前先获取完整权限，原子化更新状态。
- **Modal ESC 键支持**: 模态框现在支持 Escape 键关闭。
- **Analytics / AuditLogs 静默错误修复**: 数据加载失败时不再静默吞咽错误，改为显示错误提示信息。

## [0.3.0] - 2025-07-05

### Added

- **[Phase 2] Admin API**: 完整的管理后台，支持 `ADMIN_TOKEN` 独立认证
  - API Key CRUD: 创建 / 列出 / 查看 / 更新 / 吊销 / 轮换 (`/api/admin/keys`)
  - IP Ban 管理: 封禁 / 列出 / 解封 (`/api/admin/bans`)
  - 用量分析: 总览 / 用户用量 / 项目用量 / 操作统计 / 错误率 / 时间线 / 搜索命中率 (`/api/admin/analytics/*`)
  - 审计日志查询与导出 (CSV/JSONL) (`/api/admin/audit/*`)
  - 运行时配置管理 (GET/PATCH/Reset) (`/api/admin/config`)
- **[Phase 2] 审计日志采集**: JSONL 热写 + SQLite 冷分析双层架构
  - `AuditService`: 非阻塞 `record()` (<0.1ms), 缓冲异步 flush, 日志轮转、OOM 防护、flush 超时强制重置
  - `AnalyticsService`: SQLite WAL, JSONL cursor-based 导入, 小时/日聚合, 保留策略 (raw 30d/hourly 7d/daily 90d)
- **[Phase 2] 多租户鉴权**: 三层认证架构
  - `ADMIN_TOKEN`: 管理后台专用 (timing-safe compare)
  - `HTTP_AUTH_TOKEN`: Master Token 直接访问
  - Managed API Keys: Per-key rate limit / project 隔离 / 可吊销轮换 (SHA-256 哈希存储)
- **[Phase 2] 安全体系**: IP Ban + Per-Key Rate Limit + TLS 强制 + 代理感知 IP 提取
- **双写审计中间件**: try/finally 模式确保 500 错误也被审计
- **RuntimeConfigManager**: onChange 监听 + JSON 持久化 + 单独 error isolation

### Fixed

- **[BUG] mapPathToOperation() 输出与 SQL 查询不匹配** (Critical): 审计中间件返回 `"save"` 但 analytics SQL 硬编码 `'memory_save'`，导致所有 HTTP 模式分析数据静默丢失。修复为统一 `memory_*` 前缀。
- **[BUG] Hono c.text() 覆盖自定义 Content-Type** (Medium): CSV/JSONL 导出端点的 `c.text()` 强制设置 `text/plain`，导致浏览器无法识别文件类型。改为 `c.body()`。
- **[BUG] ADMIN_TOKEN 部署配置缺失**: docker-compose.prod.yml 和 .env.example 未包含 ADMIN_TOKEN，导致生产环境 Admin 功能静默禁用。

### Changed

- **白皮书整合**: 删除冗余的 `FEASIBILITY-ANALYSIS copy.md`，更新 `AUDIT-LOGGING-WHITEPAPER.md` 至 v1.1 (ADR-AUDIT-11/12 + 附录 D SQL Schema 偏差说明)
- **README 大幅扩充**: 新增 VPS 生产部署指南、三层认证架构、Admin API 参考、用户管理流程、远程 MCP SSE 配置示例
- **项目结构文档**: 更新 README 和 .env.example 以反映 Phase 2 新增文件

### Tests

- 新增 `audit-analytics-comprehensive.test.ts` (73 测试用例，20 测试套件)
  - 全管道 E2E / JSONL 导入管道 / 聚合引擎 / 保留策略
  - Admin Analytics/Audit/Config API E2E
  - RuntimeConfig onChange 监听器
  - AuditService 边界用例（OOM/超时/并发刷新）
  - AnalyticsService 查询边界 / buildEntry 健壮性 / 命中率 / 错误率
- 总计: **30 文件, 786 测试用例全部通过**

## [0.2.1] - 2025-07-03

### Fixed

- **[FIX H-5] Gemini healthCheck Vertex AI 兼容**: 修复 Vertex AI 不支持 GET model info 端点（返回 404）的问题。改用轻量 POST predict 调用（输入 `"ok"`，约 1 token），验证端到端连通性。

### Changed

- npm publish CI/CD 修复：移除 npm 2FA 限制以支持自动化发布。

## [0.2.0] - 2025-07-02

### ⚠ BREAKING CHANGES

- **Vertex AI Migration**: Gemini embedding provider 从 Google AI Studio 迁移至 **Google Cloud Vertex AI**。
  - 新增 **必需** 环境变量 `GEMINI_PROJECT_ID`（当 `EMBEDDING_PROVIDER` 为 `auto` 或 `gemini` 时）。
  - 新增可选环境变量 `GEMINI_REGION`（默认 `us-central1`）。
  - API endpoint 变更为 `{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models/{model}:predict`。
  - 认证方式: `x-goog-api-key` header（需要 GCP 项目级 API Key）。

### Added

- **[FIX H-1] NonRetryableError 分类**: 新增 `NonRetryableError` 类，HTTP 401/403/400/404 等永久性错误立即失败不重试。
- **[FIX H-2] 429 RESOURCE_EXHAUSTED 检测**: 区分临时限流（可重试）与配额耗尽（不可重试），配额耗尽时立即触发熔断器。
- **[FIX C-1] 熔断器 mid-retry 中止**: 重试循环中每次尝试前检查 `isCircuitOpen` 回调，防止并发雷暴期间浪费 API 调用。
- **[FIX F-2] Sleep 后二次熔断器检查**: 在指数退避 sleep 完成后再次检查熔断器状态，防止 sleep 间隙放过额外请求。
- **[FIX C-2] 跨模型向量过滤**: `memory_search` 新增 `cross_model` 参数（默认 `false`），仅返回与当前 embedding 模型匹配的向量，避免余弦距离无意义比较。向后兼容 `is_empty` 和 `"unknown"` 旧记录。
- **[FIX M-1] 重试 Jitter**: 指数退避延迟添加 ±20% 随机抖动，防止并发请求形成同步脉冲（Thundering Herd）。
- **[FIX M-3] HTTP/1.1 连接泄漏防护**: 错误响应体主动消费 (`response.text()`)，避免底层 socket 泄漏。
- **[FIX L-2] 模型名称归一化**: `save` 操作对 embedding model 名执行 `.toLowerCase()`，确保大小写不敏感匹配。
- **失败熔断器** (`rate-limiter.ts`): 新增 `recordGeminiFailure()` 计数器，连续 3 次失败触发 60 秒冷却期，自动恢复。
- **onFailure 回调** (`embedding.ts`): `EmbeddingService` 新增 `onFailure` 配置项，embed 失败时通知上层（用于触发失败熔断器）。
- **可取消 Sleep** (`embedding-providers.ts`): 重试 Sleep 注册到 `_pendingSleepRejects`，`close()` 调用时立即中断（不再等待 sleep 自然到期）。
- **Shutdown 前置守卫**: 重试循环和 `safeFetch` 均检查 `_closedByShutdown` 标志，防止 close 后泄漏请求。

### Fixed

- **[FIX F-1] GeminiProvider isCircuitOpen 转发**: 修复 `GeminiEmbeddingProvider` 构造函数未将 `isCircuitOpen` 回调转发到基类的严重 bug，该 bug 导致 Gemini（唯一需要熔断器的 Provider）的 mid-retry 熔断完全无效。
- **[FIX F-3] Ollama probe AbortController 注册**: 修复 healthCheck 中 dimension probe 的 `AbortController` 未加入 `_activeControllers`，可能导致 `close()` 后 probe 阻塞关闭最多 3 秒。
- **[FIX H-3] dailyReset 保护进行中的失败**: `resetDaily()` 在连续失败计数 > 0 时不重置失败熔断器，防止定时 reset 误清正在生效的熔断保护。
- **[FIX H-4] healthCheck 安全**: Gemini healthCheck 的 catch 块静默返回 `false`，防止 API Key/ProjectID 通过错误堆栈泄露到日志。

### Changed

- **Vertex AI 请求格式**: `{ instances: [{ content }], parameters: { outputDimensionality } }` → `{ predictions: [{ embeddings: { values } }] }`。
- **Gemini 默认超时**: 30s（远端网络），默认 3 次重试（对比 Ollama 120s/5 次）。
- **Docker Compose**: `docker-compose.yml` 和 `docker-compose.prod.yml` 新增 `GEMINI_PROJECT_ID` 和 `GEMINI_REGION` 环境变量透传。
- **`.env.example`**: 更新 Gemini 配置说明为 Vertex AI 格式。

### Tests

- 新增 447 条测试（原 444 + 3 新增审计修复测试），覆盖:
  - NonRetryableError 分类（401/403/400/404/408/5xx）
  - 429 RESOURCE_EXHAUSTED 检测
  - 熔断器 mid-retry 中止（Ollama + Gemini）
  - GeminiProvider isCircuitOpen 转发验证
  - Post-sleep 二次熔断器检查
  - 重试 Jitter ±20% 验证
  - `recordGeminiFailure` 连续失败与冷却恢复
  - `resetDaily` 保护进行中失败
  - 跨模型向量过滤
  - Save 模型名称归一化
  - onFailure 回调异常安全

## [0.1.0] - 2025-06-28

### Added

- 初始发布
- MCP 工具: `memory_save`, `memory_search`, `memory_forget`, `memory_status`
- 双引擎 embedding: Ollama (bge-m3) + Gemini (Google AI Studio) with auto-fallback
- Qdrant 向量数据库持久化存储
- HTTP API 模式 (Express)
- SafeStdioTransport (背压处理)
- 优雅关闭 (SIGTERM/stdin close + watchdog)
- 敏感信息脱敏 (AWS Key, JWT, PEM, DB URI)
- SHA-256 内容去重
- Docker Compose 部署 (Qdrant + Ollama)
- Nginx 反向代理配置
- 全面的单元测试覆盖
