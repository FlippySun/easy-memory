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

| # | 板块 | 状态 | 备注 |
|---|------|------|------|
| 1 | [npm 发布](#1-npm-发布) | ⬜ | 配置 bin/files/publishConfig，发布到 npm |
| 2 | [Docker 化](#2-docker-化) | ⬜ | Dockerfile + docker-compose.yml 一键部署 |
| 3 | [CI/CD](#3-cicd-github-actions) | ⬜ | GitHub Actions 自动化流水线 |
| 4 | [VPS 部署](#4-vps-部署) | ⬜ | HTTP 模式 + Caddy 反向代理 |
| 5 | [README 完善](#5-readme-完善) | ⬜ | 用户文档、安装指南、使用示例 |
| 6 | [E2E 真实环境测试](#6-e2e-真实环境测试) | ⬜ | 本地 Qdrant + Ollama 闭环验证 |

---

## 1. npm 发布

> 目标: 用户可通过 `npx easy-memory` 或 `npm install -g easy-memory` 直接使用 MCP Server。

### 1.1 package.json 配置

| 条目 | 状态 | 说明 |
|------|------|------|
| `name` — 确认 npm 包名可用 (`easy-memory` 或 `@flippysun/easy-memory`) | ⬜ | `npm view easy-memory` 检查是否被占 |
| `version` — 设为 `0.1.0` 首个公开版本 | ⬜ | 遵循 SemVer |
| `bin` — 添加 `"easy-memory": "dist/index.js"` | ⬜ | 入口文件头部需要 `#!/usr/bin/env node` shebang |
| `files` — 白名单发布文件 | ⬜ | `["dist/", "README.md", "LICENSE"]` |
| `publishConfig` — 设置 `"access": "public"` | ⬜ | scoped 包默认 private，需显式公开 |
| `keywords` — 添加 SEO 关键词 | ⬜ | `mcp`, `memory`, `ai`, `qdrant`, `ollama`, `vector-search` |
| `repository` / `homepage` / `bugs` — 填写 GitHub 链接 | ⬜ | |
| `author` / `license` — 确认 MIT | ⬜ | |
| `engines` — 确认 `"node": ">=20"` | ✅ | 已配置 |

### 1.2 构建产物准备

| 条目 | 状态 | 说明 |
|------|------|------|
| `dist/index.js` 头部添加 shebang (`#!/usr/bin/env node`) | ⬜ | tsconfig 不支持自动添加，需构建后脚本或 banner 方案 |
| `.npmignore` 或 `files` 白名单确保只发布必要文件 | ⬜ | 排除 tests/, src/, .github/ 等 |
| `pnpm build` 构建无错误 | ✅ | 已验证 |
| `tsc --noEmit` 类型检查通过 | ⬜ | 需在发布前验证 |

### 1.3 npm 认证与发布

| 条目 | 状态 | 说明 |
|------|------|------|
| `.npmrc` 配置 auth token（从 `secrets.json → npm.token`） | ⬜ | `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` |
| `npm whoami` 验证认证成功 | ⬜ | |
| `npm publish --dry-run` 预检 | ⬜ | 检查发布内容是否正确 |
| `npm publish` 正式发布 | ⬜ | |
| `npx easy-memory --help` 验证安装后可用 | ⬜ | |

### 1.4 发布后验证

| 条目 | 状态 | 说明 |
|------|------|------|
| npmjs.com 页面检查包信息 | ⬜ | |
| 全新目录下 `npx easy-memory` 冒烟测试 | ⬜ | |
| Claude Desktop / Cursor 配置 npx 方式验证 MCP 连通 | ⬜ | |

---

## 2. Docker 化

> 目标: 一键 `docker compose up` 启动 Easy Memory + Qdrant + Ollama 完整栈。

### 2.1 Dockerfile

| 条目 | 状态 | 说明 |
|------|------|------|
| 多阶段构建 (builder → production) | ⬜ | 减小最终镜像体积 |
| 基础镜像 `node:20-alpine` | ⬜ | Alpine 最小化攻击面 |
| 非 root 用户运行 (`node` 用户) | ⬜ | 安全最佳实践 |
| `pnpm install --prod` 只安装生产依赖 | ⬜ | |
| 健康检查 (`HEALTHCHECK`) | ⬜ | HTTP 模式可用 `/health` 端点 |
| `.dockerignore` 排除不必要文件 | ⬜ | `node_modules`, `.git`, `tests/`, `secrets.json` |
| 镜像构建测试通过 | ⬜ | `docker build -t easy-memory .` |

### 2.2 docker-compose.yml (开发环境)

| 条目 | 状态 | 说明 |
|------|------|------|
| easy-memory 服务定义 | ⬜ | 构建上下文 + 环境变量 |
| qdrant 服务 (`qdrant/qdrant:v1.17.0`) | ⬜ | 健康检查 + 数据卷持久化 |
| ollama 服务 (`ollama/ollama:latest`) | ⬜ | 模型数据卷 + `OLLAMA_KEEP_ALIVE=-1` |
| 内部网络 (`easy-memory-internal`) | ⬜ | 服务间通信隔离 |
| `.env.example` 环境变量模板 | ⬜ | 所有可配置项的注释说明 |
| `docker compose up -d` 启动验证 | ⬜ | |

### 2.3 docker-compose.prod.yml (生产覆盖)

| 条目 | 状态 | 说明 |
|------|------|------|
| `restart: always` 自动重启 | ⬜ | |
| Qdrant 端口取消外部映射 | ⬜ | 仅内网可达 |
| 网络标记 `internal: true` | ⬜ | 禁止容器直连公网 |
| 多阶段构建 `target: production` | ⬜ | |

### 2.4 Docker Hub 发布

| 条目 | 状态 | 说明 |
|------|------|------|
| Docker Hub 登录（`secrets.json → docker.user_name` + `docker.token`） | ⬜ | |
| 镜像标签策略 (`latest` + SemVer tag) | ⬜ | `thj8632/easy-memory:0.1.0` |
| `docker push` 推送镜像 | ⬜ | |
| `docker pull` 拉取验证 | ⬜ | |

---

## 3. CI/CD (GitHub Actions)

> 目标: PR / push 自动测试 + tag 触发自动发布 npm + Docker。

### 3.1 CI 流水线 (`.github/workflows/ci.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push` (main) + `pull_request` | ⬜ | |
| Job: `lint-and-type-check` — `tsc --noEmit` | ⬜ | |
| Job: `unit-test` — `pnpm test` | ⬜ | Node 20 matrix |
| 缓存 pnpm store (`actions/cache`) | ⬜ | 加速安装 |
| 构建验证 — `pnpm build` | ⬜ | |
| 状态徽章添加到 README | ⬜ | |

### 3.2 npm 自动发布 (`.github/workflows/publish-npm.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push tags: v*` | ⬜ | 语义化版本 tag 触发 |
| GitHub Secret: `NPM_TOKEN` | ⬜ | 从 `secrets.json → npm.token` 配置到 GitHub Repo Secrets |
| 发布步骤: build → publish | ⬜ | |
| 发布后自动创建 GitHub Release | ⬜ | |

### 3.3 Docker 自动发布 (`.github/workflows/publish-docker.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push tags: v*` | ⬜ | 与 npm 同步 |
| GitHub Secrets: `DOCKER_USERNAME` + `DOCKER_TOKEN` | ⬜ | 从 `secrets.json → docker.*` 配置 |
| 多平台构建 (`linux/amd64`, `linux/arm64`) | ⬜ | QEMU + buildx |
| 推送到 Docker Hub (`thj8632/easy-memory`) | ⬜ | |
| 标签: `latest` + `v0.1.0` | ⬜ | |

### 3.4 GitHub Repository 配置

| 条目 | 状态 | 说明 |
|------|------|------|
| Repo Secrets 配置 (`NPM_TOKEN`, `DOCKER_USERNAME`, `DOCKER_TOKEN`) | ⬜ | |
| Branch protection rules (main) | ⬜ | 要求 CI 通过才能合并 |

---

## 4. VPS 部署

> 目标: 在远端 VPS (`107.151.137.198`) 部署 HTTP 模式的 Easy Memory 服务，通过 Caddy 反向代理提供 HTTPS。

### 4.1 VPS 环境准备

| 条目 | 状态 | 说明 |
|------|------|------|
| SSH 连接验证 (`secrets.json → vps.*`) | ⬜ | `ssh -p 22 root@107.151.137.198` |
| Docker + Docker Compose 安装/更新 | ⬜ | |
| Caddy 安装 | ⬜ | `apt install caddy` 或 Docker |
| 域名 DNS 解析配置（可选） | ⬜ | A 记录指向 VPS IP |
| 防火墙配置（80/443 开放） | ⬜ | `ufw allow 80,443/tcp` |

### 4.2 部署文件准备

| 条目 | 状态 | 说明 |
|------|------|------|
| 生产环境 `.env` 配置文件 | ⬜ | 基于 `container.ts` 中的 `AppConfig` |
| `docker-compose.prod.yml` 适配 VPS | ⬜ | `EASY_MEMORY_MODE=http` |
| Caddy 配置文件部署 | ⬜ | 基于 `deploy/Caddyfile.example` |
| 部署自动化脚本 (`deploy/deploy.sh`) | ⬜ | SSH + rsync/scp + 远端 docker compose |

### 4.3 部署执行

| 条目 | 状态 | 说明 |
|------|------|------|
| 上传项目文件到 VPS | ⬜ | |
| 拉取 bge-m3 模型 | ⬜ | `docker compose exec ollama ollama pull bge-m3` |
| `docker compose up -d` 启动服务 | ⬜ | |
| Caddy 启动并自动获取 TLS 证书 | ⬜ | 需要域名 |
| 健康检查验证 | ⬜ | `curl https://your-domain/health` |

### 4.4 部署后验证

| 条目 | 状态 | 说明 |
|------|------|------|
| HTTP API `save` → `search` → `forget` 闭环测试 | ⬜ | 通过 curl 或 Postman |
| Bearer Token 鉴权验证 | ⬜ | 无 token 返回 401 |
| TLS 证书验证 | ⬜ | `curl -vI https://your-domain` |
| 日志输出正常 | ⬜ | `docker compose logs -f easy-memory` |
| 进程重启恢复 | ⬜ | `docker compose restart easy-memory` |

---

## 5. README 完善

> 目标: 让首次访问 GitHub 仓库的用户能在 5 分钟内理解项目并开始使用。

### 5.1 结构优化

| 条目 | 状态 | 说明 |
|------|------|------|
| 项目 Badge (CI, npm version, Docker, License) | ⬜ | |
| 一句话介绍 + 特性亮点列表 | ⬜ | |
| 架构图 / 工作流图 (Mermaid) | ⬜ | |

### 5.2 安装指南

| 条目 | 状态 | 说明 |
|------|------|------|
| 方式一: `npx easy-memory`（最简单） | ⬜ | |
| 方式二: Docker Compose（一键全栈） | ⬜ | |
| 方式三: 从源码构建 | ⬜ | 已有，需完善 |

### 5.3 客户端配置示例

| 条目 | 状态 | 说明 |
|------|------|------|
| Claude Desktop `claude_desktop_config.json` 配置 | ⬜ | npx 方式 + Docker 方式 |
| Cursor MCP 配置 | ⬜ | |
| VS Code Copilot MCP 配置 | ⬜ | |
| HTTP API 使用示例 (curl) | ⬜ | |

### 5.4 API 文档

| 条目 | 状态 | 说明 |
|------|------|------|
| MCP Tools 列表 + 参数说明 | ⬜ | `memory_save`, `memory_search`, `memory_forget`, `memory_status` |
| HTTP API 端点文档 | ⬜ | `POST /api/save`, `POST /api/search`, `POST /api/forget`, `GET /api/status` |

### 5.5 环境变量参考

| 条目 | 状态 | 说明 |
|------|------|------|
| 完整环境变量表（名称、默认值、说明） | ⬜ | 基于 `container.ts → parseAppConfig` |

### 5.6 其他

| 条目 | 状态 | 说明 |
|------|------|------|
| LICENSE 文件 | ⬜ | MIT |
| CHANGELOG.md | ⬜ | v0.1.0 初始版本记录 |
| Contributing 指南 | ⬜ | 可选 |

---

## 6. E2E 真实环境测试

> 目标: 对接真实本地 Qdrant + Ollama，验证 save → search → forget → search(验证删除) 完整闭环。

### 6.1 前置条件

| 条目 | 状态 | 说明 |
|------|------|------|
| 本地 Qdrant 运行中 (`localhost:6333`) | ⬜ | `docker ps` 确认 |
| 本地 Ollama 运行中 (`localhost:11434`) | ⬜ | `ollama list` 确认 bge-m3 |
| 构建产物最新 (`pnpm build`) | ⬜ | |

### 6.2 MCP 模式 E2E

| 条目 | 状态 | 说明 |
|------|------|------|
| `memory_save` — 写入一条记忆 | ⬜ | |
| `memory_search` — 语义检索召回 | ⬜ | 验证相似度分数 > 阈值 |
| `memory_forget` — 软删除（archived） | ⬜ | |
| `memory_search` — 再次检索验证已遗忘 | ⬜ | 不应返回已归档记忆 |
| `memory_status` — 健康检查 | ⬜ | 所有组件 `ready` |

### 6.3 HTTP 模式 E2E

| 条目 | 状态 | 说明 |
|------|------|------|
| `POST /api/save` — 写入 | ⬜ | |
| `POST /api/search` — 检索 | ⬜ | |
| `POST /api/forget` — 遗忘 | ⬜ | |
| `GET /api/status` — 状态 | ⬜ | |
| Bearer Token 鉴权测试 | ⬜ | 无 token 返回 401 |

### 6.4 跨模式一致性

| 条目 | 状态 | 说明 |
|------|------|------|
| MCP `save` 的记忆 → HTTP `search` 可召回 | ⬜ | 验证数据层共享 |
| 相同输入两种模式返回结构一致 | ⬜ | |

---

## 附录: 凭证参考

> 所有敏感凭证从 `secrets.json` 读取，**绝对禁止硬编码**。

| 用途 | secrets.json 路径 | 目标 |
|------|-------------------|------|
| npm 发布 | `npm.token` | `.npmrc` / GitHub Secret `NPM_TOKEN` |
| Docker Hub | `docker.user_name` + `docker.token` | GitHub Secrets `DOCKER_USERNAME` + `DOCKER_TOKEN` |
| GitHub Actions | `github.pat_token` | Repo Secrets（如需强权限操作） |
| VPS SSH | `vps.host` + `vps.ssh_port` + `vps.ssh_private_key` | 部署脚本 |
| Gemini API | `google_aistudio.api_key` | VPS `.env` 中的 `GEMINI_API_KEY` |

---

## 执行顺序建议

```
6. E2E 真实环境测试 (先验证功能完整性)
  ↓
1. npm 发布 (配置 + 发布)
  ↓
2. Docker 化 (Dockerfile + compose)
  ↓
3. CI/CD (自动化流水线)
  ↓
4. VPS 部署 (远端部署 + 验证)
  ↓
5. README 完善 (最后完善文档)
```

> 💡 建议先跑通 E2E 确认功能无误，再进入发布流程。文档最后完善，因为发布过程中可能发现需要调整的内容。
