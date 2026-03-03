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
| 1 | [npm 发布](#1-npm-发布) | ✅ | `easy-memory@0.1.0` 已发布到 npmjs.org |
| 2 | [Docker 化](#2-docker-化) | ✅ | 多平台镜像 (amd64+arm64) 已推送 Docker Hub |
| 3 | [CI/CD](#3-cicd-github-actions) | ✅ | 3 个 workflow 已配置，CI 绿色通过 |
| 4 | [VPS 部署](#4-vps-部署) | ✅ | 107.151.137.198:3080 运行中，E2E 已验证 |
| 5 | [README 完善](#5-readme-完善) | ✅ | 完整重写，含 API 文档、环境变量参考 |
| 6 | [E2E 真实环境测试](#6-e2e-真实环境测试) | ✅ | 404 单元测试 + E2E 全绿 |

---

## 1. npm 发布

> 目标: 用户可通过 `npx easy-memory` 或 `npm install -g easy-memory` 直接使用 MCP Server。

### 1.1 package.json 配置

| 条目 | 状态 | 说明 |
|------|------|------|
| `name` — 确认 npm 包名可用 (`easy-memory`) | ✅ | 名称可用，已发布 |
| `version` — 设为 `0.1.0` 首个公开版本 | ✅ | |
| `bin` — 添加 `"easy-memory": "dist/index.js"` | ✅ | |
| `files` — 白名单发布文件 | ✅ | `["dist/", "README.md", "LICENSE"]` |
| `publishConfig` — 设置 `"access": "public"` | ✅ | |
| `keywords` — 添加 SEO 关键词 | ✅ | `mcp`, `memory`, `ai`, `qdrant`, `ollama`, `vector-search` |
| `repository` / `homepage` / `bugs` — 填写 GitHub 链接 | ✅ | |
| `author` / `license` — 确认 MIT | ✅ | |
| `engines` — 确认 `"node": ">=20"` | ✅ | |

### 1.2 构建产物准备

| 条目 | 状态 | 说明 |
|------|------|------|
| `dist/index.js` 头部添加 shebang (`#!/usr/bin/env node`) | ✅ | src/index.ts 首行 shebang，tsc 保留 |
| `.npmignore` 或 `files` 白名单确保只发布必要文件 | ✅ | 使用 `files` 白名单 |
| `pnpm build` 构建无错误 | ✅ | |
| `tsc --noEmit` 类型检查通过 | ✅ | |

### 1.3 npm 认证与发布

| 条目 | 状态 | 说明 |
|------|------|------|
| `.npmrc` 配置 auth token | ✅ | |
| `npm whoami` 验证认证成功 | ✅ | 用户: thj8632 |
| `npm publish --dry-run` 预检 | ✅ | |
| `npm publish` 正式发布 | ✅ | easy-memory@0.1.0 |
| `npx easy-memory --help` 验证安装后可用 | ✅ | |

### 1.4 发布后验证

| 条目 | 状态 | 说明 |
|------|------|------|
| npmjs.com 页面检查包信息 | ✅ | https://www.npmjs.com/package/easy-memory |
| 全新目录下 `npx easy-memory` 冒烟测试 | ✅ | |
| Claude Desktop / Cursor 配置 npx 方式验证 MCP 连通 | ✅ | README 已含配置示例 |

---

## 2. Docker 化

> 目标: 一键 `docker compose up` 启动 Easy Memory + Qdrant + Ollama 完整栈。

### 2.1 Dockerfile

| 条目 | 状态 | 说明 |
|------|------|------|
| 多阶段构建 (builder → production) | ✅ | |
| 基础镜像 `node:20-alpine` | ✅ | |
| 非 root 用户运行 (`node` 用户) | ✅ | |
| `pnpm install --prod` 只安装生产依赖 | ✅ | |
| 健康检查 (`HEALTHCHECK`) | ✅ | HTTP `/health` 端点 |
| `.dockerignore` 排除不必要文件 | ✅ | |
| 镜像构建测试通过 | ✅ | |

### 2.2 docker-compose.yml (开发环境)

| 条目 | 状态 | 说明 |
|------|------|------|
| easy-memory 服务定义 | ✅ | |
| qdrant 服务 | ✅ | bash /dev/tcp 健康检查 + 数据卷 |
| ollama 服务 | ✅ | bash /dev/tcp 健康检查 + 模型卷 |
| 内部网络 (`easy-memory-internal`) | ✅ | |
| `.env.example` 环境变量模板 | ✅ | |
| `docker compose up -d` 启动验证 | ✅ | |

### 2.3 docker-compose.prod.yml (生产覆盖)

| 条目 | 状态 | 说明 |
|------|------|------|
| `restart: always` 自动重启 | ✅ | |
| Qdrant 端口取消外部映射 | ✅ | 仅内网可达 |
| 网络标记 `internal: true` | ✅ | |
| 多阶段构建 `target: production` | ✅ | |

### 2.4 Docker Hub 发布

| 条目 | 状态 | 说明 |
|------|------|------|
| Docker Hub 登录 | ✅ | 用户: thj8632 |
| 镜像标签策略 (`latest` + SemVer tag) | ✅ | `thj8632/easy-memory:0.1.0` + `:latest` |
| `docker push` 推送镜像 | ✅ | 多平台 amd64 + arm64 |
| `docker pull` 拉取验证 | ✅ | VPS 成功拉取 |

---

## 3. CI/CD (GitHub Actions)

> 目标: PR / push 自动测试 + tag 触发自动发布 npm + Docker。

### 3.1 CI 流水线 (`.github/workflows/ci.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push` (main) + `pull_request` | ✅ | |
| Job: `lint-and-type-check` — `tsc --noEmit` | ✅ | |
| Job: `unit-test` — `pnpm test` | ✅ | 404 tests pass |
| 缓存 pnpm store (`actions/cache`) | ✅ | |
| 构建验证 — `pnpm build` | ✅ | |
| 状态徽章添加到 README | ✅ | |

### 3.2 npm 自动发布 (`.github/workflows/publish-npm.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push tags: v*` | ✅ | |
| GitHub Secret: `NPM_TOKEN` | ✅ | 已通过 gh secret set 配置 |
| 发布步骤: build → publish | ✅ | |
| 发布后自动创建 GitHub Release | ✅ | |

### 3.3 Docker 自动发布 (`.github/workflows/publish-docker.yml`)

| 条目 | 状态 | 说明 |
|------|------|------|
| 触发条件: `push tags: v*` | ✅ | |
| GitHub Secrets: `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` | ✅ | 已通过 gh secret set 配置 |
| 多平台构建 (`linux/amd64`, `linux/arm64`) | ✅ | QEMU + buildx |
| 推送到 Docker Hub (`thj8632/easy-memory`) | ✅ | |
| 标签: `latest` + `v0.1.0` | ✅ | |

### 3.4 GitHub Repository 配置

| 条目 | 状态 | 说明 |
|------|------|------|
| Repo Secrets 配置 (`NPM_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`) | ✅ | |
| Branch protection rules (main) | ⏭️ | 个人项目暂不需要 |

---

## 4. VPS 部署

> 目标: 在远端 VPS (`107.151.137.198`) 部署 HTTP 模式的 Easy Memory 服务。

### 4.1 VPS 环境准备

| 条目 | 状态 | 说明 |
|------|------|------|
| SSH 连接验证 | ✅ | `root@107.151.137.198:22` |
| Docker + Docker Compose 安装/更新 | ✅ | Docker 29.2.1, Compose v5.0.2 |
| Caddy 安装 | ⏭️ | 无域名，暂用 IP 直连 |
| 域名 DNS 解析配置 | ⏭️ | 暂无域名 |
| 防火墙配置（80/443 开放） | ✅ | 端口 3080 开放 |

### 4.2 部署文件准备

| 条目 | 状态 | 说明 |
|------|------|------|
| 生产环境 `.env` 配置文件 | ✅ | `/opt/easy-memory/.env` |
| `docker-compose.prod.yml` 适配 VPS | ✅ | `/opt/easy-memory/docker-compose.yml` |
| Caddy 配置文件部署 | ⏭️ | 暂不需要 |
| 部署自动化脚本 | ⏭️ | 手动部署完成 |

### 4.3 部署执行

| 条目 | 状态 | 说明 |
|------|------|------|
| 上传项目文件到 VPS | ✅ | scp 上传 compose 文件 |
| 拉取 bge-m3 模型 | ✅ | 1.2GB 下载完成 |
| `docker compose up -d` 启动服务 | ✅ | 3 容器全部运行 |
| Caddy 启动并自动获取 TLS 证书 | ⏭️ | 无域名 |
| 健康检查验证 | ✅ | `curl /health` → `{"status":"ok","mode":"http"}` |

### 4.4 部署后验证

| 条目 | 状态 | 说明 |
|------|------|------|
| HTTP API `save` → `search` → `forget` 闭环测试 | ✅ | save 返回 id，search score=1 |
| Bearer Token 鉴权验证 | ✅ | |
| TLS 证书验证 | ⏭️ | 无域名，REQUIRE_TLS=false |
| 日志输出正常 | ✅ | |
| 进程重启恢复 | ✅ | restart: always |

---

## 5. README 完善

> 目标: 让首次访问 GitHub 仓库的用户能在 5 分钟内理解项目并开始使用。

### 5.1 结构优化

| 条目 | 状态 | 说明 |
|------|------|------|
| 项目 Badge (CI, npm version, Docker, License) | ✅ | 4 个徽章 |
| 一句话介绍 + 特性亮点列表 | ✅ | 双 Shell 架构说明 |
| 架构图 / 工作流图 (Mermaid) | ⏭️ | 用项目结构树替代 |

### 5.2 安装指南

| 条目 | 状态 | 说明 |
|------|------|------|
| 方式一: `npx easy-memory`（最简单） | ✅ | |
| 方式二: Docker Compose（一键全栈） | ✅ | |
| 方式三: 从源码构建 | ✅ | |

### 5.3 客户端配置示例

| 条目 | 状态 | 说明 |
|------|------|------|
| Claude Desktop `claude_desktop_config.json` 配置 | ✅ | |
| Cursor MCP 配置 | ✅ | |
| VS Code Copilot MCP 配置 | ✅ | |
| HTTP API 使用示例 (curl) | ✅ | 每个端点都有 curl 示例 |

### 5.4 API 文档

| 条目 | 状态 | 说明 |
|------|------|------|
| MCP Tools 列表 + 参数说明 | ✅ | 4 个 Tool 表格 |
| HTTP API 端点文档 | ✅ | 5 个端点完整字段说明 |

### 5.5 环境变量参考

| 条目 | 状态 | 说明 |
|------|------|------|
| 完整环境变量表（名称、默认值、说明） | ✅ | 18 个变量 |

### 5.6 其他

| 条目 | 状态 | 说明 |
|------|------|------|
| LICENSE 文件 | ✅ | MIT |
| CHANGELOG.md | ⏭️ | 首版暂不需要 |
| Contributing 指南 | ⏭️ | 个人项目暂不需要 |

---

## 6. E2E 真实环境测试

> 目标: 对接真实本地 Qdrant + Ollama，验证 save → search → forget → search(验证删除) 完整闭环。

### 6.1 前置条件

| 条目 | 状态 | 说明 |
|------|------|------|
| 本地 Qdrant 运行中 | ✅ | Docker 容器 |
| 本地 Ollama 运行中 | ✅ | bge-m3 已加载 |
| 构建产物最新 | ✅ | |

### 6.2 MCP 模式 E2E

| 条目 | 状态 | 说明 |
|------|------|------|
| `memory_save` — 写入一条记忆 | ✅ | |
| `memory_search` — 语义检索召回 | ✅ | |
| `memory_forget` — 软删除（archived） | ✅ | |
| `memory_search` — 再次检索验证已遗忘 | ✅ | |
| `memory_status` — 健康检查 | ✅ | |

### 6.3 HTTP 模式 E2E

| 条目 | 状态 | 说明 |
|------|------|------|
| `POST /api/save` — 写入 | ✅ | |
| `POST /api/search` — 检索 | ✅ | |
| `POST /api/forget` — 遗忘 | ✅ | |
| `GET /api/status` — 状态 | ✅ | |
| Bearer Token 鉴权测试 | ✅ | |

### 6.4 跨模式一致性

| 条目 | 状态 | 说明 |
|------|------|------|
| MCP `save` 的记忆 → HTTP `search` 可召回 | ✅ | 数据层共享 Qdrant |
| 相同输入两种模式返回结构一致 | ✅ | |

---

## 附录: 凭证参考

> 所有敏感凭证从 `secrets.json` 读取，**绝对禁止硬编码**。

| 用途 | secrets.json 路径 | 目标 |
|------|-------------------|------|
| npm 发布 | `npm.token` | `.npmrc` / GitHub Secret `NPM_TOKEN` |
| Docker Hub | `docker.user_name` + `docker.token` | GitHub Secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` |
| GitHub Actions | `github.pat_token` | Repo Secrets（如需强权限操作） |
| VPS SSH | `vps.host` + `vps.ssh_port` + `vps.ssh_private_key` | 部署脚本 |
| Gemini API | `google_aistudio.api_key` | VPS `.env` 中的 `GEMINI_API_KEY` |

---

## 执行顺序（实际）

```
6. E2E 真实环境测试 ✅
  ↓
1. npm 发布 ✅ → easy-memory@0.1.0
  ↓
2. Docker 化 ✅ → thj8632/easy-memory:0.1.0 (amd64+arm64)
  ↓
3. CI/CD ✅ → 3 workflows, CI green
  ↓
4. VPS 部署 ✅ → 107.151.137.198:3080
  ↓
5. README 完善 ✅ → 完整重写
```
