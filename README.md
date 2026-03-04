# Easy Memory

[![npm version](https://img.shields.io/npm/v/easy-memory)](https://www.npmjs.com/package/easy-memory)
[![Docker](https://img.shields.io/docker/v/thj8632/easy-memory?label=docker)](https://hub.docker.com/r/thj8632/easy-memory)
[![CI](https://github.com/FlippySun/easy-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/FlippySun/easy-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **让 AI 跨会话、跨项目持久化记忆。** 基于 Qdrant 向量数据库 + Ollama/Gemini Embedding 的 MCP 记忆服务。

Easy Memory 提供双 Shell 架构：

- **MCP Shell** — 通过 stdio 与 Claude Desktop / Cursor / VS Code 等 IDE 直接通信
- **HTTP Shell** — RESTful API，支持远程访问、多客户端共享记忆

---

## 目录

- [快速开始](#快速开始)
- [客户端配置](#客户端配置)
- [HTTP API](#http-api)
- [MCP Tools](#mcp-tools)
- [Docker 部署](#docker-部署)
- [环境变量](#环境变量)
- [Web UI 管理面板](#web-ui-管理面板)
- [架构文档](#架构文档)

---

## 快速开始

### 前置条件

| 依赖    | 版本 | 说明                 |
| ------- | ---- | -------------------- |
| Node.js | ≥ 20 | 运行 MCP Server      |
| Docker  | ≥ 24 | 运行 Qdrant + Ollama |

### 方式一：npx 直接运行（MCP 模式）

```bash
# 1. 启动 Qdrant + Ollama
docker run -d --name qdrant -p 6333:6333 -v qdrant_data:/qdrant/storage \
  -e QDRANT__SERVICE__API_KEY=your-api-key qdrant/qdrant:latest

docker run -d --name ollama -p 11434:11434 -v ollama_data:/root/.ollama \
  ollama/ollama:latest

# 2. 拉取 bge-m3 模型
docker exec ollama ollama pull bge-m3

# 3. 通过 npx 启动 MCP Server
npx easy-memory
```

### 方式二：Docker Compose 一键部署

```bash
git clone https://github.com/FlippySun/easy-memory.git && cd easy-memory
cp .env.example .env   # 编辑配置
docker compose up -d
docker exec ollama ollama pull bge-m3
```

### 方式三：从源码构建

```bash
git clone https://github.com/FlippySun/easy-memory.git && cd easy-memory
pnpm install
pnpm build

# MCP 模式
node dist/index.js

# HTTP 模式
EASY_MEMORY_MODE=http HTTP_AUTH_TOKEN=your-token node dist/index.js
```

---

## 客户端配置

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "your-api-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

### Cursor

编辑 Cursor Settings → MCP → 添加：

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "your-api-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

编辑 `.vscode/mcp.json`：

```json
{
  "servers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "your-api-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

### 远程 HTTP 模式

如果部署了 HTTP Shell，客户端可通过 HTTP API 接入 — 无需本地 Qdrant/Ollama。详见 [HTTP API](#http-api) 部分。

---

## HTTP API

所有 `/api/*` 端点需要 Bearer Token 认证：

```
Authorization: Bearer <HTTP_AUTH_TOKEN>
```

### `GET /health`

健康检查（无需认证）。

```bash
curl http://localhost:3080/health
# {"status":"ok","mode":"http"}
```

### `POST /api/save`

保存一条记忆。

```bash
curl -X POST http://localhost:3080/api/save \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "项目使用 pnpm 作为包管理器",
    "metadata": {
      "category": "convention",
      "tags": ["tooling", "pnpm"]
    }
  }'
```

**请求字段：**

| 字段         | 类型       | 必填 | 说明                                                                                      |
| ------------ | ---------- | ---- | ----------------------------------------------------------------------------------------- |
| `content`    | `string`   | ✅   | 记忆内容                                                                                  |
| `project`    | `string`   | ❌   | 项目标识（默认 `default`）                                                                |
| `source`     | `string`   | ❌   | 来源：`conversation` / `code_context` / `tool_output` / `documentation` / `user_feedback` |
| `fact_type`  | `string`   | ❌   | 类型：`observation` / `decision` / `preference` / `convention` / `dependency`             |
| `tags`       | `string[]` | ❌   | 标签列表                                                                                  |
| `confidence` | `number`   | ❌   | 置信度 0-1（默认 0.7）                                                                    |

### `POST /api/search`

语义搜索记忆（混合检索：向量 + BM25）。

```bash
curl -X POST http://localhost:3080/api/search \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "包管理器", "limit": 5}'
```

**请求字段：**

| 字段               | 类型       | 必填 | 说明                       |
| ------------------ | ---------- | ---- | -------------------------- |
| `query`            | `string`   | ✅   | 搜索查询                   |
| `project`          | `string`   | ❌   | 项目标识                   |
| `limit`            | `number`   | ❌   | 返回数量 1-20（默认 5）    |
| `threshold`        | `number`   | ❌   | 相似度阈值 0-1（默认 0.3） |
| `include_outdated` | `boolean`  | ❌   | 是否包含已归档记忆         |
| `tags`             | `string[]` | ❌   | 按标签过滤                 |

### `POST /api/forget`

归档/删除记忆。

```bash
curl -X POST http://localhost:3080/api/forget \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "uuid-of-memory",
    "action": "archive",
    "reason": "信息已过时"
  }'
```

**action 说明：**

- `archive` — 软删除（标记为归档，搜索时默认不返回）
- `outdated` — 标记为过时
- `delete` — 从向量库中彻底删除

### `GET /api/status`

系统状态检查。

```bash
curl -H "Authorization: Bearer your-token" http://localhost:3080/api/status
```

---

## MCP Tools

Easy Memory 暴露 4 个 MCP Tools：

| Tool            | 说明                   |
| --------------- | ---------------------- |
| `memory_save`   | 保存记忆到向量库       |
| `memory_search` | 语义检索相关记忆       |
| `memory_forget` | 归档/标记过时/删除记忆 |
| `memory_status` | 系统健康状态           |

---

## Docker 部署

### 开发环境

```bash
cp .env.example .env
docker compose up -d
docker exec ollama ollama pull bge-m3
```

### 生产环境

```bash
cp .env.example .env
# 编辑 .env: 设置强密码 QDRANT_API_KEY, HTTP_AUTH_TOKEN

docker compose -f docker-compose.prod.yml up -d
docker exec ollama ollama pull bge-m3

# 验证
curl http://your-server:3080/health
```

### 预构建镜像

```bash
docker pull thj8632/easy-memory:latest
# 或指定版本
docker pull thj8632/easy-memory:0.2.1
```

支持平台：`linux/amd64`, `linux/arm64`

---

## VPS 生产部署

### 前置条件

| 需求   | 说明                                |
| ------ | ----------------------------------- |
| VPS    | 2C/4G+ 内存（Ollama bge-m3 需 ~2G） |
| 域名   | A 记录解析到 VPS IP                 |
| Docker | Docker ≥ 24 + Docker Compose v2     |
| 端口   | 80/443 对外开放（反向代理用）       |

### 1. 部署服务

```bash
# 克隆代码
git clone https://github.com/FlippySun/easy-memory.git
cd easy-memory

# 配置环境变量
cp .env.example .env
vim .env
# 必须设置:
#   QDRANT_API_KEY=<强随机密钥>
#   HTTP_AUTH_TOKEN=<Master Token — 管理员自用>
#   ADMIN_TOKEN=<Admin Token — 管理后台>

# 启动
docker compose -f docker-compose.prod.yml up -d

# 验证
curl http://localhost:3080/health
# {"status":"ok","mode":"http"}
```

### 2. 反向代理 (HTTPS)

#### Caddy（推荐 — 自动 HTTPS）

```bash
cp deploy/Caddyfile.example /etc/caddy/Caddyfile
# 编辑: 替换 memory.example.com 为实际域名
sudo systemctl reload caddy
```

#### Nginx（手动证书）

```bash
cp deploy/nginx.conf.example /etc/nginx/conf.d/easy-memory.conf
# 编辑: 替换域名, 配置 SSL 证书
sudo certbot --nginx -d memory.example.com
sudo nginx -s reload
```

### 3. 三层认证架构

```
ADMIN_TOKEN（管理员）
  └─ 管理后台 /api/admin/*
  └─ 创建/吊销 Managed API Key
  └─ 查看 Analytics / Audit 数据

HTTP_AUTH_TOKEN（Master Token）
  └─ 直接访问所有 MCP 工具
  └─ 无 per-key rate limit 限制

Managed API Key（分发给普通用户）
  └─ Admin 通过 POST /api/admin/keys 创建
  └─ 可设置 rate limit、project 隔离
  └─ 可随时吊销/轮转
```

### 4. 用户管理

#### 管理员为用户创建 Token

```bash
curl -X POST https://memory.example.com/api/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "user-alice",
    "scopes": ["memory_save", "memory_search", "memory_forget", "memory_status"],
    "rate_limit": 30,
    "project": "alice-project"
  }'
# 返回: { "id": "...", "key": "em_abc123...", "name": "user-alice" }
# ⚠️ key 仅此一次返回，请安全保存并发给用户
```

#### 用户配置远程 MCP（SSE 模式）

VS Code / Cursor — 编辑 `.vscode/mcp.json`：

```json
{
  "servers": {
    "easy-memory": {
      "type": "sse",
      "url": "https://memory.example.com/sse",
      "headers": {
        "Authorization": "Bearer em_abc123..."
      }
    }
  }
}
```

JetBrains IDE — 添加 MCP Server：

```json
{
  "mcpServers": {
    "easy-memory": {
      "url": "https://memory.example.com/sse",
      "headers": { "Authorization": "Bearer em_abc123..." }
    }
  }
}
```

> **Note:** Claude Desktop 不原生支持 SSE 远端连接，需使用本地 stdio 桥接。

### 5. Admin API

所有 Admin API 需要 `ADMIN_TOKEN` 认证：

```
Authorization: Bearer <ADMIN_TOKEN>
```

| 功能         | 方法        | 路径                            |
| ------------ | ----------- | ------------------------------- |
| 创建 Key     | `POST`      | `/api/admin/keys`               |
| 列出全部 Key | `GET`       | `/api/admin/keys`               |
| 查看 Key     | `GET`       | `/api/admin/keys/:id`           |
| 更新 Key     | `PATCH`     | `/api/admin/keys/:id`           |
| 吊销 Key     | `DELETE`    | `/api/admin/keys/:id`           |
| 轮换 Key     | `POST`      | `/api/admin/keys/:id/rotate`    |
| 封禁 IP      | `POST`      | `/api/admin/bans`               |
| 列出 IP 封禁 | `GET`       | `/api/admin/bans`               |
| 解封 IP      | `DELETE`    | `/api/admin/bans/:ip`           |
| 系统总览     | `GET`       | `/api/admin/analytics/overview` |
| 用户用量     | `GET`       | `/api/admin/analytics/users`    |
| 搜索命中率   | `GET`       | `/api/admin/analytics/hit-rate` |
| 审计日志     | `GET`       | `/api/admin/audit/logs`         |
| 导出日志     | `GET`       | `/api/admin/audit/export`       |
| 运行时配置   | `GET/PATCH` | `/api/admin/config`             |

---

## 环境变量

| 变量                    | 默认值                   | 说明                                                       |
| ----------------------- | ------------------------ | ---------------------------------------------------------- |
| `EASY_MEMORY_MODE`      | `mcp`                    | 运行模式：`mcp` / `http`                                   |
| `QDRANT_URL`            | `http://localhost:6333`  | Qdrant 连接地址                                            |
| `QDRANT_API_KEY`        | `easy-memory-dev`        | Qdrant API Key                                             |
| `EMBEDDING_PROVIDER`    | `ollama`                 | Embedding 引擎：`ollama` / `gemini` / `auto`               |
| `OLLAMA_BASE_URL`       | `http://localhost:11434` | Ollama 地址                                                |
| `OLLAMA_MODEL`          | `bge-m3`                 | Ollama 模型名（1024 维）                                   |
| `OLLAMA_TIMEOUT_MS`     | `120000`                 | Ollama 请求超时（ms），首次加载模型需较长时间              |
| `GEMINI_API_KEY`        | —                        | Google Cloud Vertex AI API Key（`gemini`/`auto` 模式必填） |
| `GEMINI_PROJECT_ID`     | —                        | Google Cloud Project ID（`gemini`/`auto` 模式必填）        |
| `GEMINI_REGION`         | `us-central1`            | Google Cloud Vertex AI 区域                                |
| `GEMINI_MODEL`          | `gemini-embedding-001`   | Gemini Embedding 模型                                      |
| `DEFAULT_PROJECT`       | `default`                | 默认项目标识                                               |
| `HTTP_PORT`             | `3080`                   | HTTP Shell 监听端口                                        |
| `HTTP_HOST`             | `127.0.0.1`              | HTTP Shell 监听地址                                        |
| `HTTP_AUTH_TOKEN`       | —                        | HTTP API Bearer Token                                      |
| `TRUST_PROXY`           | `false`                  | 信任反向代理 X-Forwarded-\* 头                             |
| `REQUIRE_TLS`           | `false`                  | 拒绝非 HTTPS 请求（需 TRUST_PROXY=true）                   |
| `ADMIN_TOKEN`           | —                        | Admin API Token（留空则禁用管理后台）                      |
| `ADMIN_USERNAME`        | —                        | Admin 用户名 — 首次启动时自动创建管理员账户                |
| `ADMIN_PASSWORD`        | —                        | Admin 密码 — 与 ADMIN_USERNAME 配合使用                    |
| `RATE_LIMIT_PER_MINUTE` | `60`                     | 全局速率限制（次/分钟）                                    |
| `GEMINI_MAX_PER_HOUR`   | `200`                    | Gemini 每小时最大调用数                                    |
| `GEMINI_MAX_PER_DAY`    | `2000`                   | Gemini 每日最大调用数                                      |

---

## ⚠️ Breaking Changes (v0.2.0)

### Vertex AI 迁移：`GEMINI_PROJECT_ID` 新增必填

从 v0.2.0 起，Gemini Embedding 已从 Generative Language API (`generativelanguage.googleapis.com`) 迁移至 **Vertex AI** (`aiplatform.googleapis.com`)。

**影响范围：** 使用 `EMBEDDING_PROVIDER=gemini` 或 `EMBEDDING_PROVIDER=auto` 的所有部署。

**必须操作：**

1. 新增环境变量 `GEMINI_PROJECT_ID`（Google Cloud 项目 ID）
2. 可选设置 `GEMINI_REGION`（默认 `us-central1`）
3. 确保 `GEMINI_API_KEY` 有 Vertex AI 权限

```bash
# .env 变更示例
EMBEDDING_PROVIDER=gemini          # 或 auto
GEMINI_API_KEY=your-api-key        # 无变化
GEMINI_PROJECT_ID=my-gcp-project   # ⬅️ 新增必填
GEMINI_REGION=us-central1          # 可选，默认 us-central1
```

> **纯 Ollama 用户不受影响**（`EMBEDDING_PROVIDER=ollama` 为默认值）。

---

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # TypeScript 编译
pnpm typecheck        # 类型检查
pnpm test             # 单元测试 (842 tests)
pnpm build:web        # 构建 Web UI 前端
pnpm build:all        # 构建后端 + 前端
pnpm dev:web          # 前端开发模式 (HMR)
pnpm test:e2e         # E2E 测试 (需要 Qdrant + Ollama)
```

### 项目结构

```
src/
├── index.ts              # 入口 — 双模式路由
├── container.ts          # 依赖注入容器
├── api/                  # HTTP Shell (Hono)
│   ├── server.ts         # HTTP 路由 + 审计中间件 + SPA 静态文件
│   ├── admin-routes.ts   # Admin API (Key/Ban/Analytics/Audit/Config)
│   ├── auth-routes.ts    # Auth API (Login/Register/Users)
│   ├── admin-auth.ts     # Admin Token 鉴权
│   ├── schemas.ts
│   └── middlewares.ts    # 双层鉴权 (Master + API Key)
├── mcp/                  # MCP Shell (stdio)
│   └── server.ts
├── services/             # 核心服务
│   ├── qdrant.ts         # Qdrant 向量数据库
│   ├── embedding.ts      # Embedding 编排 (多引擎 fallback)
│   ├── embedding-providers.ts  # Ollama/Gemini Provider
│   ├── bm25.ts           # BM25 稀疏向量 (混合检索)
│   ├── analytics.ts      # SQLite 用量分析聚合
│   ├── audit.ts          # JSONL 审计日志 (缓冲写入)
│   ├── api-key-manager.ts # API Key 管理 (SHA-256 哈希)
│   ├── ban-manager.ts    # IP/Key 封禁
│   ├── runtime-config.ts # 运行时配置管理
│   └── auth.ts           # 用户认证 (scrypt + JWT)
├── tools/                # MCP Tool 处理器
│   ├── save.ts
│   ├── search.ts
│   ├── forget.ts
│   └── status.ts
├── transport/            # 安全 stdio 传输
│   └── SafeStdioTransport.ts
├── types/                # Schema & 类型
│   ├── schema.ts         # MCP 数据契约
│   ├── admin-schema.ts   # Admin API Schema
│   ├── audit-schema.ts   # 审计日志 Schema
│   └── auth-schema.ts    # Auth/RBAC Schema
└── utils/                # 工具
    ├── hash.ts           # SHA-256 去重
    ├── logger.ts         # stderr JSON 日志
    ├── sanitize.ts       # 内容脱敏
    ├── rate-limiter.ts   # 速率限制 (全局 + Per-Key)
    ├── ip.ts             # 代理感知 IP 提取
    └── shutdown.ts       # 优雅关闭
```

web/ # Web UI Admin Panel (React)
├── src/
│ ├── App.tsx # 路由 + 权限守卫
│ ├── api/client.ts # API 客户端 (JWT 自动注入)
│ ├── contexts/auth.tsx # Auth 上下文
│ ├── components/ # UI 组件 (Button/Card/Modal/Table...)
│ └── pages/ # 页面 (Login/Dashboard/ApiKeys/Bans/
│ # Analytics/AuditLogs/Users/Settings)
└── vite.config.ts # Vite 构建配置

````

---

## Web UI 管理面板

访问 `http://your-server:3080/` 打开 Web UI 管理面板。

### 首次设置

1. 设置环境变量创建管理员账户：
   ```bash
   ADMIN_USERNAME=your-admin-name
   ADMIN_PASSWORD=your-secure-password
   ADMIN_TOKEN=your-admin-token
````

2. 启动服务后通过浏览器打开 Web UI
   3 使用管理员账号密码登录

### 功能

- **Dashboard**: 实时概览（请求量/成功率/延迟/系统状态）
- **API Keys**: 密钥管理（创建/启用/禁用/删除）
- **Bans**: IP/Key 封禁管理
- **Analytics**: 用量分析（时间线/操作分布/错误追踪）
- **Audit Logs**: 审计日志（分页/筛选/导出）
- **Users**: 用户管理（创建/角色切换/启用禁用/删除）
- **Settings**: 运行时配置编辑

### 角色权限

| 权限         | Admin | User |
| ------------ | :---: | :--: |
| 用户管理     |  ✅   |  ❌  |
| API Key 管理 |  ✅   |  ❌  |
| Ban 管理     |  ✅   |  ❌  |
| 配置修改     |  ✅   |  ❌  |
| 分析查看     |  ✅   |  ✅  |
| 审计日志     |  ✅   |  ✅  |
| 记忆操作     |  ✅   |  ✅  |

### 构建

```bash
pnpm build:web    # 构建前端到 dist/web/
pnpm build:all    # 构建后端 + 前端
pnpm dev:web      # 前端开发模式 (HMR + API 代理)
```

---

## 架构文档

- [FEASIBILITY-ANALYSIS.md](FEASIBILITY-ANALYSIS.md) — 架构决策记录 (ADR)
- [AUDIT-LOGGING-WHITEPAPER.md](AUDIT-LOGGING-WHITEPAPER.md) — 后处理架构白皮书（鉴权·审计·管控）
- [CORE_SCHEMA.md](CORE_SCHEMA.md) — 数据契约与绝对红线
- [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) — 多端接入与 Prompt 调教

---

## License

[MIT](LICENSE) © FlippySun
