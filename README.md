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
- [架构文档](#架构文档)

---

## 快速开始

### 前置条件

| 依赖    | 版本   | 说明                         |
| ------- | ------ | ---------------------------- |
| Node.js | ≥ 20   | 运行 MCP Server              |
| Docker  | ≥ 24   | 运行 Qdrant + Ollama         |

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

| 字段         | 类型       | 必填 | 说明                                           |
| ------------ | ---------- | ---- | ---------------------------------------------- |
| `content`    | `string`   | ✅   | 记忆内容                                       |
| `project`    | `string`   | ❌   | 项目标识（默认 `default`）                      |
| `source`     | `string`   | ❌   | 来源：`conversation` / `code_context` / `tool_output` / `documentation` / `user_feedback` |
| `fact_type`  | `string`   | ❌   | 类型：`observation` / `decision` / `preference` / `convention` / `dependency` |
| `tags`       | `string[]` | ❌   | 标签列表                                       |
| `confidence` | `number`   | ❌   | 置信度 0-1（默认 0.7）                          |

### `POST /api/search`

语义搜索记忆（混合检索：向量 + BM25）。

```bash
curl -X POST http://localhost:3080/api/search \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "包管理器", "limit": 5}'
```

**请求字段：**

| 字段               | 类型       | 必填 | 说明                         |
| ------------------ | ---------- | ---- | ---------------------------- |
| `query`            | `string`   | ✅   | 搜索查询                     |
| `project`          | `string`   | ❌   | 项目标识                     |
| `limit`            | `number`   | ❌   | 返回数量 1-20（默认 5）       |
| `threshold`        | `number`   | ❌   | 相似度阈值 0-1（默认 0.3）    |
| `include_outdated` | `boolean`  | ❌   | 是否包含已归档记忆            |
| `tags`             | `string[]` | ❌   | 按标签过滤                   |

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

| Tool             | 说明                     |
| ---------------- | ------------------------ |
| `memory_save`    | 保存记忆到向量库          |
| `memory_search`  | 语义检索相关记忆          |
| `memory_forget`  | 归档/标记过时/删除记忆    |
| `memory_status`  | 系统健康状态              |

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
docker pull thj8632/easy-memory:0.1.0
```

支持平台：`linux/amd64`, `linux/arm64`

---

## 环境变量

| 变量                   | 默认值                      | 说明                                           |
| ---------------------- | --------------------------- | ---------------------------------------------- |
| `EASY_MEMORY_MODE`     | `mcp`                       | 运行模式：`mcp` / `http`                       |
| `QDRANT_URL`           | `http://localhost:6333`     | Qdrant 连接地址                                |
| `QDRANT_API_KEY`       | `easy-memory-dev`           | Qdrant API Key                                 |
| `EMBEDDING_PROVIDER`   | `ollama`                    | Embedding 引擎：`ollama` / `gemini` / `auto`   |
| `OLLAMA_BASE_URL`      | `http://localhost:11434`    | Ollama 地址                                    |
| `OLLAMA_MODEL`         | `bge-m3`                    | Ollama 模型名（1024 维）                        |
| `OLLAMA_TIMEOUT_MS`    | `120000`                    | Ollama 请求超时（ms），首次加载模型需较长时间    |
| `GEMINI_API_KEY`       | —                           | Google Gemini API Key（`gemini`/`auto` 模式必填）|
| `GEMINI_MODEL`         | `gemini-embedding-001`      | Gemini Embedding 模型                           |
| `DEFAULT_PROJECT`      | `default`                   | 默认项目标识                                    |
| `HTTP_PORT`            | `3080`                      | HTTP Shell 监听端口                             |
| `HTTP_HOST`            | `127.0.0.1`                 | HTTP Shell 监听地址                             |
| `HTTP_AUTH_TOKEN`      | —                           | HTTP API Bearer Token                           |
| `TRUST_PROXY`          | `false`                     | 信任反向代理 X-Forwarded-* 头                   |
| `REQUIRE_TLS`          | `false`                     | 拒绝非 HTTPS 请求（需 TRUST_PROXY=true）        |
| `RATE_LIMIT_PER_MINUTE`| `60`                        | 全局速率限制（次/分钟）                          |
| `GEMINI_MAX_PER_HOUR`  | `200`                       | Gemini 每小时最大调用数                          |
| `GEMINI_MAX_PER_DAY`   | `2000`                      | Gemini 每日最大调用数                            |

---

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # TypeScript 编译
pnpm typecheck        # 类型检查
pnpm test             # 单元测试 (404 tests)
pnpm test:e2e         # E2E 测试 (需要 Qdrant + Ollama)
```

### 项目结构

```
src/
├── index.ts              # 入口 — 双模式路由
├── container.ts          # 依赖注入容器
├── api/                  # HTTP Shell (Hono)
│   ├── server.ts
│   ├── schemas.ts
│   └── middlewares.ts
├── mcp/                  # MCP Shell (stdio)
│   └── server.ts
├── services/             # 核心服务
│   ├── qdrant.ts         # Qdrant 向量数据库
│   ├── embedding.ts      # Embedding 编排 (多引擎 fallback)
│   ├── embedding-providers.ts  # Ollama/Gemini Provider
│   └── bm25.ts           # BM25 稀疏向量 (混合检索)
├── tools/                # MCP Tool 处理器
│   ├── save.ts
│   ├── search.ts
│   ├── forget.ts
│   └── status.ts
├── transport/            # 安全 stdio 传输
│   └── SafeStdioTransport.ts
├── types/                # Schema & 类型
│   └── schema.ts
└── utils/                # 工具
    ├── hash.ts           # SHA-256 去重
    ├── logger.ts         # stderr JSON 日志
    ├── sanitize.ts       # 内容脱敏
    ├── rate-limiter.ts   # 速率限制
    └── shutdown.ts       # 优雅关闭
```

---

## 架构文档

- [FEASIBILITY-ANALYSIS.md](FEASIBILITY-ANALYSIS.md) — 架构决策记录 (ADR)
- [CORE_SCHEMA.md](CORE_SCHEMA.md) — 数据契约与绝对红线
- [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) — 多端接入与 Prompt 调教

---

## License

[MIT](LICENSE) © FlippySun
