# 📦 Easy Memory — 多端发布清单 (Release Checklist)

> **⚠️ 同步规则 (Sync Policy)**
>
> 此文档是"准备 & 发布"阶段的**唯一权威真相源 (Single Source of Truth)**。
> 后续对以下任何板块执行**新增、修改、删除**操作时，**必须同步更新此文档对应条目的状态**。
> AI Agent 在每次完成一个子任务后，应立即回到本文件打勾 ✅ 或更新备注。
>
> 状态标记: ⬜ 未开始 | 🔧 进行中 | ✅ 已完成 | ⏭️ 跳过 | ❌ 阻塞

---

## 总览

| #   | 板块                                               | 状态 | 备注                                                  |
| --- | -------------------------------------------------- | ---- | ----------------------------------------------------- |
| 1   | [npm 发布](#1-npm-发布)                            | ✅   | `easy-memory@0.5.4` 已发布到 npmjs.org                |
| 2   | [Docker 化](#2-docker-化)                          | ✅   | 多平台镜像 (amd64+arm64) `0.5.4` 已推送 Docker Hub    |
| 3   | [CI/CD](#3-cicd-github-actions)                    | ✅   | 3 个 workflow 已配置，CI 绿色通过                     |
| 4   | [VPS 部署](#4-vps-部署)                            | ✅   | `memory.zhiz.chat` HTTPS 运行中，Gemini+Ollama 双引擎 |
| 5   | [README 完善](#5-readme-完善)                      | ✅   | 完整重写，含 API 文档、环境变量参考                   |
| 6   | [E2E 真实环境测试](#6-e2e-真实环境测试)            | ✅   | 870 单元测试 + E2E 全绿                               |
| 7   | [Breaking Changes](#7-️-breaking-changes-记录-v020) | ✅   | Vertex AI 迁移 GEMINI_PROJECT_ID 必填                 |
| 8   | [MCP 平台注册](#8-mcp-平台注册)                    | 🔧   | Smithery 发布已受理；Glama/mcp.so 因外部限制阻塞      |

---

## 1. npm 发布

> 目标: 用户可通过 `npx easy-memory` 或 `npm install -g easy-memory` 直接使用 MCP Server。

### 1.1 package.json 配置

| 条目                                                  | 状态 | 说明                                                       |
| ----------------------------------------------------- | ---- | ---------------------------------------------------------- |
| `name` — 确认 npm 包名可用 (`easy-memory`)            | ✅   | 名称可用，已发布                                           |
| `version` — 当前版本 `0.5.4`                          | ✅   |                                                            |
| `bin` — 添加 `"easy-memory": "dist/index.js"`         | ✅   |                                                            |
| `files` — 白名单发布文件                              | ✅   | `["dist/", "README.md", "LICENSE"]`                        |
| `publishConfig` — 设置 `"access": "public"`           | ✅   |                                                            |
| `keywords` — 添加 SEO 关键词                          | ✅   | `mcp`, `memory`, `ai`, `qdrant`, `ollama`, `vector-search` |
| `repository` / `homepage` / `bugs` — 填写 GitHub 链接 | ✅   |                                                            |
| `author` / `license` — 确认 MIT                       | ✅   |                                                            |
| `engines` — 确认 `"node": ">=20"`                     | ✅   |                                                            |

### 1.2 构建产物准备

| 条目                                                     | 状态 | 说明                                |
| -------------------------------------------------------- | ---- | ----------------------------------- |
| `dist/index.js` 头部添加 shebang (`#!/usr/bin/env node`) | ✅   | src/index.ts 首行 shebang，tsc 保留 |
| `.npmignore` 或 `files` 白名单确保只发布必要文件         | ✅   | 使用 `files` 白名单                 |
| `pnpm build` 构建无错误                                  | ✅   |                                     |
| `tsc --noEmit` 类型检查通过                              | ✅   |                                     |

### 1.3 npm 认证与发布

| 条目                                    | 状态 | 说明              |
| --------------------------------------- | ---- | ----------------- |
| `.npmrc` 配置 auth token                | ✅   |                   |
| `npm whoami` 验证认证成功               | ✅   | 用户: thj8632     |
| `npm publish --dry-run` 预检            | ✅   |                   |
| `npm publish` 正式发布                  | ✅   | easy-memory@0.5.4 |
| `npx easy-memory --help` 验证安装后可用 | ✅   |                   |

### 1.4 发布后验证

| 条目                                               | 状态 | 说明                                      |
| -------------------------------------------------- | ---- | ----------------------------------------- |
| npmjs.com 页面检查包信息                           | ✅   | https://www.npmjs.com/package/easy-memory |
| 全新目录下 `npx easy-memory` 冒烟测试              | ✅   |                                           |
| Claude Desktop / Cursor 配置 npx 方式验证 MCP 连通 | ✅   | README 已含配置示例                       |

---

## 2. Docker 化

> 目标: 一键 `docker compose up` 启动 Easy Memory + Qdrant + Ollama 完整栈。

### 2.1 Dockerfile

| 条目                                 | 状态 | 说明                |
| ------------------------------------ | ---- | ------------------- |
| 多阶段构建 (builder → production)    | ✅   |                     |
| 基础镜像 `node:20-alpine`            | ✅   |                     |
| 非 root 用户运行 (`node` 用户)       | ✅   |                     |
| `pnpm install --prod` 只安装生产依赖 | ✅   |                     |
| 健康检查 (`HEALTHCHECK`)             | ✅   | HTTP `/health` 端点 |
| `.dockerignore` 排除不必要文件       | ✅   |                     |
| 镜像构建测试通过                     | ✅   |                     |

### 2.2 docker-compose.yml (开发环境)

| 条目                              | 状态 | 说明                            |
| --------------------------------- | ---- | ------------------------------- |
| easy-memory 服务定义              | ✅   |                                 |
| qdrant 服务                       | ✅   | bash /dev/tcp 健康检查 + 数据卷 |
| ollama 服务                       | ✅   | bash /dev/tcp 健康检查 + 模型卷 |
| 内部网络 (`easy-memory-internal`) | ✅   |                                 |
| `.env.example` 环境变量模板       | ✅   |                                 |
| `docker compose up -d` 启动验证   | ✅   | 含 `ollama-init` 自动拉取模型   |

### 2.3 docker-compose.prod.yml (生产覆盖)

| 条目                            | 状态 | 说明       |
| ------------------------------- | ---- | ---------- |
| `restart: always` 自动重启      | ✅   |            |
| Qdrant 端口取消外部映射         | ✅   | 仅内网可达 |
| 网络标记 `internal: true`       | ✅   |            |
| 多阶段构建 `target: production` | ✅   |            |

### 2.4 Docker Hub 发布

| 条目                                 | 状态 | 说明                                    |
| ------------------------------------ | ---- | --------------------------------------- |
| Docker Hub 登录                      | ✅   | 用户: thj8632                           |
| 镜像标签策略 (`latest` + SemVer tag) | ✅   | `thj8632/easy-memory:0.5.4` + `:latest` |
| `docker push` 推送镜像               | ✅   | 多平台 amd64 + arm64                    |
| `docker pull` 拉取验证               | ✅   | VPS 成功拉取                            |

---

## 3. CI/CD (GitHub Actions)

> 目标: PR / push 自动测试 + tag 触发自动发布 npm + Docker。

### 3.1 CI 流水线 (`.github/workflows/ci.yml`)

| 条目                                        | 状态 | 说明           |
| ------------------------------------------- | ---- | -------------- |
| 触发条件: `push` (main) + `pull_request`    | ✅   |                |
| Job: `lint-and-type-check` — `tsc --noEmit` | ✅   |                |
| Job: `unit-test` — `pnpm test`              | ✅   | 870 tests pass |
| 缓存 pnpm store (`actions/cache`)           | ✅   |                |
| 构建验证 — `pnpm build`                     | ✅   |                |
| 状态徽章添加到 README                       | ✅   |                |

### 3.2 npm 自动发布 (`.github/workflows/publish-npm.yml`)

| 条目                          | 状态 | 说明                      |
| ----------------------------- | ---- | ------------------------- |
| 触发条件: `push tags: v*`     | ✅   |                           |
| GitHub Secret: `NPM_TOKEN`    | ✅   | 已通过 gh secret set 配置 |
| 发布步骤: build → publish     | ✅   |                           |
| 发布后自动创建 GitHub Release | ✅   |                           |

### 3.3 Docker 自动发布 (`.github/workflows/publish-docker.yml`)

| 条目                                                     | 状态 | 说明                      |
| -------------------------------------------------------- | ---- | ------------------------- |
| 触发条件: `push tags: v*`                                | ✅   |                           |
| GitHub Secrets: `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` | ✅   | 已通过 gh secret set 配置 |
| 多平台构建 (`linux/amd64`, `linux/arm64`)                | ✅   | QEMU + buildx             |
| 推送到 Docker Hub (`thj8632/easy-memory`)                | ✅   |                           |
| 标签: `latest` + `v0.5.4`                                | ✅   |                           |

### 3.4 GitHub Repository 配置

| 条目                                                                     | 状态 | 说明             |
| ------------------------------------------------------------------------ | ---- | ---------------- |
| Repo Secrets 配置 (`NPM_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`) | ✅   |                  |
| Branch protection rules (main)                                           | ⏭️   | 个人项目暂不需要 |

---

## 4. VPS 部署

> 目标: 在远端 VPS (`memory.zhiz.chat`) 部署 HTTP 模式的 Easy Memory 服务，
> 含 Nginx 反向代理 (HTTPS) + Gemini 远端向量引擎支持。

### 4.1 VPS 环境准备

| 条目                              | 状态 | 说明                                          |
| --------------------------------- | ---- | --------------------------------------------- |
| SSH 连接验证                      | ✅   | `root@zhiz.chat:22` (域名直连)                |
| Docker + Docker Compose 安装/更新 | ✅   | Docker 29.2.1, Compose v5.0.2                 |
| Nginx 反向代理 (宝塔)             | ✅   | `memory.zhiz.chat` → `127.0.0.1:3080`         |
| 域名 DNS 解析配置                 | ✅   | `*.zhiz.chat` → VPS IP (通配符)               |
| SSL/TLS 证书                      | ✅   | Let's Encrypt 通配符 `*.zhiz.chat` (自动续签) |
| 防火墙配置                        | ✅   | 80/443 开放，3080 仅本机可达                  |

### 4.2 部署文件准备

| 条目                          | 状态 | 说明                                                  |
| ----------------------------- | ---- | ----------------------------------------------------- |
| 生产环境 `.env` 配置文件      | ✅   | `/opt/easy-memory/.env`                               |
| `docker-compose.yml` 适配 VPS | ✅   | 含 `ollama-init` 自动拉取模型                         |
| Nginx 反向代理配置            | ✅   | `/www/server/panel/vhost/nginx/memory.zhiz.chat.conf` |

### 4.3 反向代理配置

| 条目                  | 状态 | 说明                                                |
| --------------------- | ---- | --------------------------------------------------- |
| Nginx vhost 创建      | ✅   | `memory.zhiz.chat` → `proxy_pass 127.0.0.1:3080`    |
| SSL 证书挂载          | ✅   | 复用 `*.zhiz.chat` 通配符证书                       |
| HSTS 头               | ✅   | `Strict-Transport-Security: max-age=31536000`       |
| X-Forwarded-\* 头透传 | ✅   | `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` |
| 端口安全              | ✅   | Docker 端口 `127.0.0.1:3080` 仅本机可达             |
| `TRUST_PROXY=true`    | ✅   | 信任反代头                                          |
| `REQUIRE_TLS=true`    | ✅   | 拒绝非 HTTPS 请求                                   |

### 4.4 Gemini 远端向量引擎部署

> **⚠️ 重要**: VPS 作为公共服务，**必须**启用 Gemini 双引擎模式。

| 条目                      | 状态 | 说明                                                              |
| ------------------------- | ---- | ----------------------------------------------------------------- |
| `GEMINI_API_KEY` 配置     | ✅   | 从 `secrets.json → google_aistudio.api_key` 读取并写入 VPS `.env` |
| `EMBEDDING_PROVIDER=auto` | ✅   | Gemini 优先，Ollama 自动兜底                                      |
| 断路器验证                | ✅   | Gemini 429 限流 → 自动降级 Ollama → 请求成功                      |
| 日志确认双引擎工作        | ✅   | 日志可见 `Fallback to ollama succeeded`                           |

**部署 Gemini 到 VPS 的步骤**:

1. 从 `secrets.json` 读取 `google_aistudio.api_key`
2. SSH 到 VPS: `ssh root@zhiz.chat`
3. 编辑 `/opt/easy-memory/.env`:
   ```
   EMBEDDING_PROVIDER=auto
   GEMINI_API_KEY=<从 secrets.json 获取的 key>
   ```
4. 重启服务: `cd /opt/easy-memory && docker compose down && docker compose up -d`
5. 验证: `curl https://memory.zhiz.chat/health` 确认服务正常

### 4.5 部署执行

| 条目                            | 状态 | 说明                                                       |
| ------------------------------- | ---- | ---------------------------------------------------------- |
| 上传项目文件到 VPS              | ✅   | scp 上传 compose 文件                                      |
| 拉取 bge-m3 模型                | ✅   | `ollama-init` 容器自动拉取                                 |
| `docker compose up -d` 启动服务 | ✅   | 4 容器全部 healthy                                         |
| 健康检查验证                    | ✅   | `curl https://memory.zhiz.chat/health` → `{"status":"ok"}` |

### 4.6 部署后验证

| 条目                                           | 状态 | 说明                                |
| ---------------------------------------------- | ---- | ----------------------------------- |
| HTTP API `save` → `search` → `forget` 闭环测试 | ✅   | HTTPS 域名 E2E 验证通过             |
| Bearer Token 鉴权验证                          | ✅   |                                     |
| TLS 证书验证                                   | ✅   | Let's Encrypt 通配符，HSTS          |
| 日志输出正常                                   | ✅   |                                     |
| 进程重启恢复                                   | ✅   | restart: always                     |
| Gemini 双引擎验证                              | ✅   | auto 模式：Gemini → Ollama 降级正常 |

---

## 5. README 完善

> 目标: 让首次访问 GitHub 仓库的用户能在 5 分钟内理解项目并开始使用。

### 5.1 结构优化

| 条目                                          | 状态 | 说明              |
| --------------------------------------------- | ---- | ----------------- |
| 项目 Badge (CI, npm version, Docker, License) | ✅   | 4 个徽章          |
| 一句话介绍 + 特性亮点列表                     | ✅   | 双 Shell 架构说明 |
| 架构图 / 工作流图 (Mermaid)                   | ⏭️   | 用项目结构树替代  |

### 5.2 安装指南

| 条目                                | 状态 | 说明 |
| ----------------------------------- | ---- | ---- |
| 方式一: `npx easy-memory`（最简单） | ✅   |      |
| 方式二: Docker Compose（一键全栈）  | ✅   |      |
| 方式三: 从源码构建                  | ✅   |      |

### 5.3 客户端配置示例

| 条目                                             | 状态 | 说明                   |
| ------------------------------------------------ | ---- | ---------------------- |
| Claude Desktop `claude_desktop_config.json` 配置 | ✅   |                        |
| Cursor MCP 配置                                  | ✅   |                        |
| VS Code Copilot MCP 配置                         | ✅   |                        |
| HTTP API 使用示例 (curl)                         | ✅   | 每个端点都有 curl 示例 |

### 5.4 API 文档

| 条目                      | 状态 | 说明                 |
| ------------------------- | ---- | -------------------- |
| MCP Tools 列表 + 参数说明 | ✅   | 4 个 Tool 表格       |
| HTTP API 端点文档         | ✅   | 5 个端点完整字段说明 |

### 5.5 环境变量参考

| 条目                                 | 状态 | 说明      |
| ------------------------------------ | ---- | --------- |
| 完整环境变量表（名称、默认值、说明） | ✅   | 18 个变量 |

### 5.6 其他

| 条目              | 状态 | 说明             |
| ----------------- | ---- | ---------------- |
| LICENSE 文件      | ✅   | MIT              |
| CHANGELOG.md      | ⏭️   | 首版暂不需要     |
| Contributing 指南 | ⏭️   | 个人项目暂不需要 |

---

## 7. ⚠️ Breaking Changes 记录 (v0.2.0+)

> 目标: 记录所有向后不兼容的配置/API 变更，确保用户升级时不会因缺少信息而导致服务中断。

### 7.1 Vertex AI 迁移 — `GEMINI_PROJECT_ID` 新增必填

| 条目            | 说明                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **影响版本**    | v0.2.0+                                                                                            |
| **影响范围**    | `EMBEDDING_PROVIDER=gemini` 或 `auto` 的所有部署                                                   |
| **变更原因**    | Gemini Embedding 从 Generative Language API 迁移至 Vertex AI（更好的区域控制、配额管理、MRL 支持） |
| **破坏性表现**  | 缺少 `GEMINI_PROJECT_ID` 时服务启动立即抛出异常 → **crash**                                        |
| **修复方式**    | 新增环境变量 `GEMINI_PROJECT_ID=<your-gcp-project-id>`                                             |
| **Ollama 用户** | **不受影响**（`EMBEDDING_PROVIDER=ollama` 为默认值）                                               |
| **README 同步** | ✅ 已在 README.md 新增 Breaking Changes 章节                                                       |

---

## 6. E2E 真实环境测试

> 目标: 对接真实本地 Qdrant + Ollama，验证 save → search → forget → search(验证删除) 完整闭环。

### 6.1 前置条件

| 条目               | 状态 | 说明          |
| ------------------ | ---- | ------------- |
| 本地 Qdrant 运行中 | ✅   | Docker 容器   |
| 本地 Ollama 运行中 | ✅   | bge-m3 已加载 |
| 构建产物最新       | ✅   |               |

### 6.2 MCP 模式 E2E

| 条目                                 | 状态 | 说明 |
| ------------------------------------ | ---- | ---- |
| `memory_save` — 写入一条记忆         | ✅   |      |
| `memory_search` — 语义检索召回       | ✅   |      |
| `memory_forget` — 软删除（archived） | ✅   |      |
| `memory_search` — 再次检索验证已遗忘 | ✅   |      |
| `memory_status` — 健康检查           | ✅   |      |

### 6.3 HTTP 模式 E2E

| 条目                      | 状态 | 说明 |
| ------------------------- | ---- | ---- |
| `POST /api/save` — 写入   | ✅   |      |
| `POST /api/search` — 检索 | ✅   |      |
| `POST /api/forget` — 遗忘 | ✅   |      |
| `GET /api/status` — 状态  | ✅   |      |
| Bearer Token 鉴权测试     | ✅   |      |

### 6.4 跨模式一致性

| 条目                                     | 状态 | 说明              |
| ---------------------------------------- | ---- | ----------------- |
| MCP `save` 的记忆 → HTTP `search` 可召回 | ✅   | 数据层共享 Qdrant |
| 相同输入两种模式返回结构一致             | ✅   |                   |

---

## 8. MCP 平台注册

> 目标: 将 Easy Memory 注册到主流 MCP 服务目录平台，方便用户发现和安装。

### 8.1 代码准备（所有平台共用）

| 条目                                                 | 状态 | 说明                                                                      |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `/.well-known/mcp/server-card.json` 端点已实现       | ✅   | HTTP 服务公开元数据，无需认证，含 4 个 Tool 完整 inputSchema              |
| `smithery-config-schema.json` 配置 Schema 文件已创建 | ✅   | JSON Schema，定义 MCP stdio 模式的 env 配置项                             |
| `mcp-config-template.json` 通用配置模板已创建        | ✅   | mcp.so 等平台的服务器配置模板                                             |
| VPS 部署已更新 server-card 端点                      | ✅   | 已验证 `https://memory.zhiz.chat/.well-known/mcp/server-card.json` 可访问 |

### 8.2 Smithery.ai

> 主页: https://smithery.ai | 文档: https://smithery.ai/docs/build/publish
> API Key 路径: `secrets.json → smithery.ai.api_key`

**发布方式 A — URL 模式（远程服务器，推荐）**

| 步骤                                               | 状态 | 说明                      |
| -------------------------------------------------- | ---- | ------------------------- |
| 1. 访问 https://smithery.ai/new                    | ⏭️   | 本次改用 CLI 自动发布流程 |
| 2. 输入 Server URL: `https://memory.zhiz.chat/mcp` | ⏭️   | 本次改用 CLI 自动发布流程 |
| 3. 完成扫描流程                                    | ⏭️   | 本次改用 CLI 自动发布流程 |
| 4. 填写描述信息                                    | ⏭️   | 本次改用 CLI 自动发布流程 |
| 5. 发布确认                                        | ⏭️   | 本次改用 CLI 自动发布流程 |

**发布方式 B — CLI 模式（备选）**

```bash
# 1. 安装 CLI
npm install -g @smithery/cli@latest

# 2. 登录（浏览器 OAuth）
smithery auth login

# 3. 创建命名空间（如未创建）
smithery namespace list
# → 访问 smithery.ai 网页创建命名空间

# 4. 发布 URL 模式
SMITHERY_API_KEY="<secrets.json → smithery.ai.api_key>" \
  smithery mcp publish "https://memory.zhiz.chat/mcp" \
  -n @<namespace>/easy-memory \
  --config-schema smithery-config-schema.json

# 5. 验证
smithery mcp search easy-memory
```

**本次执行结果（2026-03-05）**:

- ✅ `namespace list` 返回可用命名空间：`FlippySun`
- ✅ 已执行发布：`smithery mcp publish "https://memory.zhiz.chat/mcp" -n FlippySun/easy-memory --config-schema smithery-config-schema.json`
- ✅ 发布受理成功：`Release 971380e4-0fff-4cb9-98bd-ec5c8ebc6f88 accepted`
- 🔧 检索索引存在延迟：`smithery mcp search` 暂未即时返回 `easy-memory`

**Smithery 描述模板:**

```
Easy Memory — MCP Persistent Memory Service

Give your AI assistant persistent memory across sessions. Easy Memory stores and retrieves knowledge using vector similarity search (Qdrant + Ollama/Gemini), enabling Claude, Cursor, VS Code Copilot, and other MCP clients to remember facts, decisions, code patterns, and more.

Features:
• 4 MCP Tools: memory_save, memory_search, memory_forget, memory_status
• Hybrid search: Vector similarity + BM25 keyword matching
• Dual embedding engine: Ollama (local, free) + Gemini (cloud, auto-fallback)
• Prompt injection safety: Memory content wrapped in boundary markers
• Multi-project isolation: Separate memory spaces per project
• Docker one-click deployment with Qdrant + Ollama

Transport: Streamable HTTP (remote) / stdio (local npm)
```

### 8.3 Glama.ai

> 主页: https://glama.ai | MCP 目录: https://glama.ai/mcp/servers
> API Key 路径: `secrets.json → glama.ai.api_key`

| 步骤                                        | 状态 | 说明                                                                |
| ------------------------------------------- | ---- | ------------------------------------------------------------------- |
| 1. 访问 https://glama.ai/mcp/servers/submit | ✅   | `submit` 路径 404，已切换到 `https://glama.ai/mcp/servers` 验证入口 |
| 2. 填写 Server 信息                         | ❌   | 点击 `Add Server` 后跳转 GitHub OAuth 登录页，需人工登录            |
| 3. 配置 API Key（如需鉴权）                 | ❌   | `https://glama.ai/mcp/api` 仅公开查询接口（GET），无提交接口        |
| 4. 提交审核                                 | ❌   | 阻塞于 OAuth 登录前置条件（需人工）                                 |
| 5. 验证上线                                 | ❌   | 未完成提交，无法进入上线验证                                        |

**Glama 提交信息:**

| 字段        | 值                                                                       |
| ----------- | ------------------------------------------------------------------------ |
| Name        | Easy Memory                                                              |
| GitHub URL  | https://github.com/FlippySun/easy-memory                                 |
| npm Package | easy-memory                                                              |
| Description | MCP persistent memory service. Vector search via Qdrant + Ollama/Gemini. |
| Category    | Memory / Knowledge Management                                            |

### 8.4 mcp.so

> 主页: https://mcp.so | 提交: https://mcp.so/submit
> 无需 API Key，直接填写表单提交。

| 步骤                          | 状态 | 说明                                             |
| ----------------------------- | ---- | ------------------------------------------------ |
| 1. 访问 https://mcp.so/submit | ❌   | HTTPS 证书异常（`ERR_CERT_COMMON_NAME_INVALID`） |
| 2. 填写表单信息               | ❌   | 受阻于站点不可用，无法进入提交表单               |
| 3. 提交                       | ❌   | 受阻于站点不可用，无法提交                       |
| 4. 验证上线                   | ❌   | 未完成提交，无法验证                             |

**mcp.so 提交表单填写:**

| 字段          | 值                                       |
| ------------- | ---------------------------------------- |
| Type          | Server                                   |
| Name          | Easy Memory                              |
| URL           | https://github.com/FlippySun/easy-memory |
| Server Config | 见 `mcp-config-template.json`            |

**Server Config（粘贴到表单）:**

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory@latest"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "your-qdrant-api-key",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "EMBEDDING_PROVIDER": "ollama",
        "DEFAULT_PROJECT": "default"
      }
    }
  }
}
```

### 8.5 发布后验证（所有平台）

| 条目                               | 状态 | 说明                                                                        |
| ---------------------------------- | ---- | --------------------------------------------------------------------------- |
| Smithery 页面可搜索到 easy-memory  | 🔧   | 发布已受理，等待索引同步（release: `971380e4-0fff-4cb9-98bd-ec5c8ebc6f88`） |
| Glama 页面可搜索到 easy-memory     | ❌   | 阻塞：提交需 GitHub OAuth 人工登录                                          |
| mcp.so 页面可搜索到 easy-memory    | ❌   | 阻塞：站点证书异常/HTTP 落入反诈拦截页                                      |
| 各平台展示的配置示例可直接复制使用 | 🔧   | Smithery 已进入发布流程；其余平台待阻塞解除                                 |

---

## 附录: 凭证参考

> 所有敏感凭证从 `secrets.json` 读取，**绝对禁止硬编码**。

| 用途           | secrets.json 路径                                   | 目标                                                    |
| -------------- | --------------------------------------------------- | ------------------------------------------------------- |
| npm 发布       | `npm.token`                                         | `.npmrc` / GitHub Secret `NPM_TOKEN`                    |
| Docker Hub     | `docker.user_name` + `docker.token`                 | GitHub Secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` |
| GitHub Actions | `github.pat_token`                                  | Repo Secrets（如需强权限操作）                          |
| VPS SSH        | `vps.host` + `vps.ssh_port` + `vps.ssh_private_key` | `ssh root@zhiz.chat` 或 `ssh root@<VPS IP>`             |
| Gemini API     | `google_aistudio.api_key`                           | VPS `.env` 中的 `GEMINI_API_KEY`                        |
| Smithery.ai    | `smithery.ai.api_key`                               | CLI `SMITHERY_API_KEY` 或网页登录                       |
| Glama.ai       | `glama.ai.api_key`                                  | 网页提交 API Key                                        |
| mcp.so         | —                                                   | 无需 API Key，GitHub OAuth 登录                         |

---

## 执行顺序（实际）

```
6. E2E 真实环境测试 ✅ → 870 单元测试 + E2E 全绿
  ↓
1. npm 发布 ✅ → easy-memory@0.5.4
  ↓
2. Docker 化 ✅ → thj8632/easy-memory:0.5.4 (amd64+arm64)
  ↓
3. CI/CD ✅ → 3 workflows, CI green (v0.5.4 tag triggered)
  ↓
4. VPS 部署 ✅ → memory.zhiz.chat (HTTPS + Gemini 双引擎, v0.5.4)
  ↓
5. README 完善 ✅ → 完整重写
  ↓
8. MCP 平台注册 🔧 → Smithery.ai / Glama.ai / mcp.so
```
