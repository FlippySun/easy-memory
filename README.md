# Easy Memory — MCP 持久化记忆服务

> 让 AI 跨会话、跨项目持久化记忆。基于 Qdrant 向量数据库 + Ollama 本地 Embedding。
>
> **架构决策详情** → [FEASIBILITY-ANALYSIS.md](FEASIBILITY-ANALYSIS.md)（ADR 日志）
> **数据契约 & 红线** → [CORE_SCHEMA.md](CORE_SCHEMA.md)
> **多端接入 & Prompt 调教** → [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)

---

## 本地开发（Mac M4）

### 前置条件

| 依赖           | 版本                  | 说明                       |
| -------------- | --------------------- | -------------------------- |
| Docker Desktop | ≥ 4.x (Apple Silicon) | Ollama 自动使用 Metal 加速 |
| Node.js        | ≥ 20                  | 运行 MCP Server            |
| pnpm           | ≥ 9                   | 包管理                     |

### 1. 拿代码 & 装依赖

```bash
git clone <repo-url> && cd easy-memory
pnpm install
cp .env.example .env
```

### 2. 环境变量（`.env.example`）

```env
# ===== Embedding（配置时二选一，非运行时 fallback）[ADR: 破坏性修正①] =====
EMBEDDING_PROVIDER=ollama             # ollama | openai
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=bge-m3                   # 1024 维
# OPENAI_API_KEY=sk-...               # 仅 EMBEDDING_PROVIDER=openai
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # 1536 维

# ===== Qdrant =====
QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=dev-key-change-me      # ⚠️ 必须设置 [ADR: SEC-4]
QDRANT_CONNECT_TIMEOUT_MS=60000       # 指数退避上限 [ADR: LC-11]

# ===== 项目隔离 =====
PROJECT_SLUG=my-project               # Collection-per-Project

# ===== 传输 =====
TRANSPORT=stdio                       # stdio | sse
# SSE_PORT=3100                       # 仅 TRANSPORT=sse
# API_KEY=your-api-key                # 仅 TRANSPORT=sse [ADR: 补充四十四]
```

### 3. 启动全部服务

```bash
docker compose up -d
```

<details>
<summary><b>docker-compose.yml（点击展开）</b></summary>

```yaml
services:
  qdrant:
    image: qdrant/qdrant:v1.17.0
    environment:
      - QDRANT__SERVICE__API_KEY=${QDRANT_API_KEY}
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      # Qdrant 官方 readyz 端点
      test: ["CMD-SHELL", "wget -qO- http://localhost:6333/readyz || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 10
    ports:
      - "6333:6333" # 本地开发可暴露，生产关闭
    networks:
      - easy-memory-internal

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_data:/root/.ollama
    environment:
      - OLLAMA_KEEP_ALIVE=-1 # 模型常驻内存，避免冷启动 [ADR: 补充二十二]
    networks:
      - easy-memory-internal

  easy-memory:
    build: .
    depends_on:
      qdrant:
        condition: service_healthy
    env_file: .env
    stdin_open: true # stdio 模式需要
    networks:
      - easy-memory-internal

networks:
  easy-memory-internal:
    driver: bridge
    # ⚠️ 开发环境不加 internal:true — Ollama 需要联网下载模型
    # 生产环境通过 docker-compose.prod.yml 覆盖为 internal: true [ADR: SEC-4]

volumes:
  qdrant_data:
  ollama_data:
```

</details>

### 4. 预拉 Embedding 模型（首次）

```bash
docker compose exec ollama ollama pull bge-m3
```

### 5. 验证服务就绪

```bash
# Qdrant 健康
curl -sf http://localhost:6333/readyz && echo "✅ Qdrant ready"

# Ollama 模型就绪
docker compose exec ollama ollama list | grep bge-m3

# MCP Server 自检（需先构建）
pnpm build && echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js
```

---

## 生产部署（VPS）

### 环境变量模板

```env
# ===== 必填 =====
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=bge-m3
QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=<openssl rand -hex 32>      # ⚠️ 强随机密钥
PROJECT_SLUG=prod-project

# ===== SSE 远程访问 =====
TRANSPORT=sse
SSE_PORT=3100
API_KEY=<openssl rand -hex 32>             # ⚠️ 强随机密钥

# ===== 运维 =====
QDRANT_CONNECT_TIMEOUT_MS=60000
NODE_ENV=production
```

### 生产 Compose 覆盖

```yaml
# docker-compose.prod.yml
services:
  qdrant:
    restart: always
    ports: [] # ⚠️ 关闭端口映射，仅内网可达

  ollama:
    restart: always

  easy-memory:
    restart: always
    build:
      context: .
      target: production

networks:
  easy-memory-internal:
    internal: true # ⚠️ 生产环境禁止外部网络访问 [ADR: SEC-4]
    # 确保已预拉模型: docker compose exec ollama ollama pull bge-m3
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 安全检查清单

- [ ] `QDRANT_API_KEY` 已设置且 ≥ 32 字符随机值
- [ ] `API_KEY` 已设置（SSE 模式）
- [ ] Qdrant 端口 **未** 映射到宿主机
- [ ] Docker 网络标记为 `internal: true`
- [ ] `EMBEDDING_PROVIDER` 与集合向量维度匹配（切换模型需迁移）

---

## 调试

### 挂载调试器（本地）

```jsonc
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Easy Memory",
      "program": "${workspaceFolder}/src/index.ts",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["tsx"],
      "sourceMaps": true,
      "console": "integratedTerminal",
      "env": {
        "TRANSPORT": "stdio",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "dev-key",
        "OLLAMA_BASE_URL": "http://localhost:11434",
      },
    },
  ],
}
```

或直接命令行：

```bash
# 用 tsx 直接调试 TypeScript（无需编译）
npx tsx --inspect-brk src/index.ts

# MCP Inspector（SDK 内置协议级调试）
npx @modelcontextprotocol/inspector dist/index.js
```

### 日志

```bash
# easy-memory 结构化日志（stderr 输出 JSON）
docker compose logs -f easy-memory

# Qdrant 运维日志
docker compose logs -f qdrant

# Ollama 模型加载日志
docker compose logs -f ollama
```

### 常见问题

| 现象                        | 原因                       | 解决                                                                        |
| --------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `EPIPE` write 错误          | IDE 关闭后 stdout 管道断裂 | 正常现象，GracefulShutdown 三层防御已处理 [ADR: 补充五十一]                 |
| Embedding 首次超时          | Ollama 冷启动下载模型      | 预拉模型 `ollama pull bge-m3`，或等待 async warmup                          |
| Qdrant 连接失败             | 容器未就绪                 | 指数退避自动重连（1s→2s→4s→8s→16s→32s），或增大 `QDRANT_CONNECT_TIMEOUT_MS` |
| 僵尸 MCP 进程               | stdin 未正确关闭           | 内置 stdin close + SIGTERM 监听 + 5s watchdog 超时强杀 [ADR: 补充四十]      |
| 记忆搜索无结果              | Embedding 仍在 warmup      | 检查 `memory_status` → `embedding: "warming_up"` 时暂不可搜                 |
| `status: pending_embedding` | Embedding 服务暂时不可用   | 记忆已暂存 JSONL，RecoveryWorker 恢复后自动 flush [ADR: P0-10]              |
| 切换模型后向量不兼容        | 向量维度变更 (1024↔1536)   | 需执行迁移脚本（Phase 2），不可直接切换 [ADR: LC-10]                        |
