# 双壳接口层开发约束白皮书 (Shell Interfaces Constraints)

## 1. 架构定位与职责边界 (Architecture Positioning)

本系统采用“六边形架构（端口适配器）”模式：

- **核心领域层 (Domain)**：`src/services/` 和 `src/tools/` 是绝对的核心，包含业务逻辑、大模型交互、向量降维、自动降级与数据库事务。**核心层对“外壳”一无所知，禁止在此引入任何与 HTTP 或 MCP 相关的代码。**
- **外壳适配器层 (Adapters)**：`src/api/` (HTTP 接口) 和 `src/mcp/` (大模型工具协议) 属于外壳层。它们的唯一职责是：**解析外部协议 -> 权限校验 -> 调用核心层单例 -> 将结果格式化后返回**。

## 2. 依赖注入与单例契约 (Singleton Contract)

- **绝对禁止多次实例化**：不允许在 API 路由或 MCP 服务中直接 `new EmbeddingService()`。
- **统一获取**：所有对外层必须通过底层的依赖注入容器或专门的单例工厂（如 `src/container.ts`）获取核心服务实例，以确保 Qdrant 连接池、本地模型的任务队列是全局唯一且受控的。

## 3. HTTP 外壳防御规范 (API Security & Resiliency)

暴露在 VPS 上的 HTTP 接口必须满足“零信任”原则：

1. **身份鉴权 (Authentication)**：所有修改/读取向量数据的路由，必须强制经过 Token 鉴权中间件。
2. **强类型边界 (Schema Validation)**：所有进入 Controller 的 Payload 必须经过 Zod 校验，非预期的多余字段必须被静默剥离（`strip`），缺少的必填字段直接返回 HTTP 400，绝不能让脏数据流入核心服务层。
3. **熔断与兜底 (Error Boundary)**：必须配置全局异常处理中间件。核心层抛出的任何 Error（包括网络超时、数据库断连），在此处必须被捕获并转化为标准的 HTTP 响应，严禁将内部 Error Stack 暴露给调用方，严禁引发 Node 进程崩溃。

## 4. MCP 外壳防御规范 (Model Context Protocol Isolation)

作为直接供 AI Agent 调用的底层协议，稳定性压倒一切：

1. **纯净的输出流 (Stdio Purity)**：MCP 服务启动时，必须接管全局的 `console.log` 和 `console.info`，将其路由至 `stderr` 或直接丢弃。只有合法的 JSON-RPC 消息允许进入 `stdout`。
2. **防幻觉 Schema (Anti-Hallucination Schemas)**：在注册 MCP Tool 时，不仅要定义字段类型，必须在 `description` 中用明确的自然语言告知 AI 该工具的具体作用、参数的最大长度限制（例如文本截断策略），防止 AI 构造超大 payload 击穿内存。
3. **协议级错误返回**：如果核心落库失败，MCP 外壳不应抛出 Node 原生 Error，而应返回包含 `isError: true` 的标准 MCP 响应对象，以便 AI Agent 知道操作失败并尝试自我修复。

## 5. 进程生命周期 (Lifecycle & Graceful Shutdown)

- 启动入口（`src/index.ts`）必须接管操作系统的终止信号。
- 退出顺序必须严格遵守：**停止监听端口/协议 -> 阻塞等待 inflight 请求完成 -> 释放数据库与模型连接池 -> 终止进程**。

---

## 附录 A: 实施决策日志 (Implementation Decision Log)

> 以下记录在实际编码过程中发现并解决的暗病与设计决策。

### ADR-SHELL-01: Console 劫持时机 (2025-06)

**问题**: MCP SDK 内部或第三方依赖可能在 `McpServer` 构造期间调用 `console.log`，污染 stdout。
**决策**: `hijackConsole()` 必须在 `new McpServer()` **之前**调用。`console.debug` 静默丢弃（过于冗余），其余重定向到 `process.stderr`。
**影响范围**: `src/mcp/server.ts` — `startMcpShell()` 函数首行。

### ADR-SHELL-02: MCP Tool Handler 双层错误边界 (2025-06)

**问题**: `rateLimiter.checkRate()` 已有 try-catch，但核心层 handler (`handleSave/Search/Forget/Status`) 抛出的异常未被捕获，SDK 默认行为不一定返回 `isError: true`。
**决策**: 所有 4 个 tool callback 内部的业务调用包裹独立的 try-catch，返回 `{content: [{type:"text", text: JSON.stringify({status:"error", message})}], isError: true}`。
**影响范围**: `src/mcp/server.ts` — 4 个 `server.tool()` 回调。

### ADR-SHELL-03: HTTP 限流覆盖 (2025-06)

**问题**: MCP 壳已执行 `rateLimiter.checkRate()`，但 HTTP 壳完全跳过了限流。攻击者可通过 HTTP 旁路耗尽 Gemini API 配额。
**决策**: 在 `/api/*` 路由链中添加限流中间件（排除只读的 `GET /api/status`）。返回 HTTP 429。
**影响范围**: `src/api/server.ts` — 新增 `/api/*` 中间件。

### ADR-SHELL-04: HTTP Schema 纵深防御 — `.strip()` vs `.passthrough()` (2025-06)

**问题**: 核心层 `types/schema.ts` 使用 `.passthrough()` 保留未知字段（MCP 前向兼容）。但 HTTP 壳面对互联网流量，应剥离未知字段防止注入。
**决策**: 创建 `src/api/schemas.ts`，将核心 schema 重新定义为 `.strip()` 版本。路由层先 `safeParse` → 失败返回 400 + issues → 成功后用 `parsed.data` 传入核心层。
**影响范围**: 新文件 `src/api/schemas.ts`；`src/api/server.ts` 所有 POST 路由。

### ADR-SHELL-05: Bearer Auth 安全强化 (2025-06)

**问题 1 (RFC 7235)**: 原实现使用 `scheme !== "Bearer"` 进行严格大小写比较。RFC 7235 §2.1 规定 auth scheme 是 case-insensitive。
**问题 2 (Timing Attack)**: 原实现使用 `token !== authToken`（`!==` 运算符），在首个不同字符处短路，暴露 timing side-channel。
**决策**: scheme 比较改为 `toLowerCase()`；token 比较改为 `crypto.timingSafeEqual`（含等长防护）。
**影响范围**: `src/api/middlewares.ts` — `bearerAuth()` 函数。

### ADR-SHELL-06: JSON 解析与 Content-Type 防御 (2025-06)

**问题**: Hono `c.req.json()` 对畸形 JSON 抛出 `SyntaxError`，被 `globalErrorHandler` 捕获后返回 500。应返回 400。
**决策**:

1. `globalErrorHandler` 新增 `instanceof SyntaxError` 检测 → 返回 400。
2. 新增 `validateJsonContentType` 中间件，POST/PUT/PATCH 请求必须携带 `Content-Type: application/json`，否则返回 415。
   **影响范围**: `src/api/middlewares.ts`；`src/api/server.ts` 中间件链。

### ADR-SHELL-07: 全局 unhandledRejection 兜底 (2025-06)

**问题**: Node 20+ 对未处理的 Promise rejection 默认退出进程（`--unhandled-rejections=throw`），但无上下文日志。
**决策**: 在 `src/index.ts` 中注册 `process.on('unhandledRejection', ...)` handler，记录 error + stack 到 stderr。
**影响范围**: `src/index.ts` — `main()` 调用前。

### ADR-SHELL-08: HTTP 无鉴权启动警告 (2025-06)

**问题**: `httpAuthToken` 为空时 `bearerAuth` 静默跳过认证。VPS 部署时若忘记设置 `HTTP_AUTH_TOKEN`，HTTP API 完全裸露在公网。
**决策**: `startHttpShell()` 在服务启动后检测 token 为空时，输出 `log.warn` 级别的醒目警告。
**影响范围**: `src/api/server.ts` — `startHttpShell()` 函数。

### ADR-SHELL-09: Secure-by-default 绑定地址 + TLS 纵深防御 (2025-06)

**问题**: `@hono/node-server` 的 `serve()` 在不指定 `hostname` 时，Node.js `server.listen(port)` 默认绑定到所有网络接口 (`0.0.0.0`/`::`)。若 VPS 直接暴露 Node.js 端口，Bearer Token 在 HTTP 明文传输中可被 MITM 截获。
**决策**: 三层纵深防御:

1. **物理隔绝 (Primary)**: `HTTP_HOST` 默认值 `127.0.0.1`，`serve()` 强制传入 `hostname` 参数 → Node.js 端口仅本机回环地址可达，物理上不可能从公网直连。
2. **TLS 强制中间件 (Secondary)**: 新增 `tlsEnforcement(trustProxy, requireTls)` 中间件工厂，挂载于 `/api/*`。当 `TRUST_PROXY=true` + `REQUIRE_TLS=true` 时，验证 `X-Forwarded-Proto: https`，不满足返回 421 Misdirected Request。同时注入 `Strict-Transport-Security` 响应头防止浏览器协议降级。`/health` 端点天然豁免（不在 `/api/*` 路径下）。
3. **运维模板 (Operational)**: 提供 `deploy/Caddyfile.example` (自动 Let's Encrypt) 和 `deploy/nginx.conf.example` (手动 TLS) 两份反向代理配置模板。
   **安全守卫**:

- `REQUIRE_TLS=true` + `TRUST_PROXY=false` → 启动阶段 `throw Error` (fast-fail，矛盾配置)。
- `HTTP_HOST=0.0.0.0` + `!requireTls` → `log.warn` 强警告（可能是 Docker/K8s 场景，不阻止启动）。
- `HTTP_HOST=0.0.0.0` + `!httpAuthToken` → `log.warn CRITICAL`。
  **新增环境变量**: `HTTP_HOST` (默认 `127.0.0.1`), `TRUST_PROXY` (默认 `false`), `REQUIRE_TLS` (默认 `false`)。
  **影响范围**: `src/container.ts` (AppConfig + parseAppConfig), `src/api/middlewares.ts` (tlsEnforcement), `src/api/server.ts` (hostname 绑定 + 拓扑警告), `deploy/` (新增目录)。

### ADR-SHELL-10: Stdio 物理拓扑边界 — LOCAL-ONLY Transport (2025-06)

**问题**: MCP 协议的 stdio 传输层基于进程级 stdin/stdout 管道 (IPC)，物理上不可能跨网络连接。远端 VPS 上运行 `MODE=mcp` 后，本地 AI 客户端 (Claude Desktop / Roo Code) 无法通过公网 stdio 连接到远端服务器。
**决策**: 这是 stdio 协议的根本物理特性，非代码 Bug，无需代码层拦截。通过两个层面明确：

1. **运行时日志**: `MODE=mcp` 启动时输出 info 级别日志："MCP mode: stdio is a LOCAL-ONLY transport (stdin/stdout IPC). It CANNOT be accessed remotely. Use MODE=http for VPS deployment."
2. **文档明确**: 本 ADR 记录此物理局限，指导用户：VPS 部署 → `MODE=http`；本地 AI 客户端直连 → `MODE=mcp`。
   **影响范围**: `src/index.ts` (info 日志)。
