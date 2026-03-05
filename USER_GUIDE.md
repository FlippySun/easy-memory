# Easy Memory 使用教程

> **面向零基础用户的完整指南** — 从安装到使用，一步步教你让 AI 拥有跨会话记忆。

---

## 这是什么？

**Easy Memory** 是一个让 AI 助手（Claude、Cursor、GitHub Copilot 等）拥有"长期记忆"的工具。

正常情况下，你和 AI 的对话在关闭窗口后就丢失了。安装 Easy Memory 后，AI 可以：

- ✅ **记住**你告诉它的技术偏好、项目约定
- ✅ **搜索**之前保存过的知识
- ✅ **跨项目**共享记忆（比如你的编码风格在所有项目通用）
- ✅ **遗忘**过时的信息

---

## 目录

- [选择适合你的方案](#选择适合你的方案)
- [方案 C：远程代理模式（推荐优先）](#方案-c远程代理模式推荐优先--无需-docker)
- [方案 B：远程服务器部署（推荐团队/多设备）](#方案-b远程服务器部署推荐团队多设备)
- [方案 A：本地部署（可选）](#方案-a本地部署可选)
- [连接你的 AI 客户端](#连接你的-ai-客户端)
  - [Claude Desktop](#1-claude-desktop)
  - [Cursor](#2-cursor)
  - [VS Code（GitHub Copilot）](#3-vs-codegithub-copilot)
  - [JetBrains IDE](#4-jetbrains-ide)
- [使用教程：AI 记忆操作](#使用教程ai-记忆操作)
- [Web 管理面板](#web-管理面板)
- [常见问题 FAQ](#常见问题-faq)

---

## 选择适合你的方案

|              | 方案 C：远程代理（推荐优先） | 方案 B：远程部署       | 方案 A：本地部署（可选）   |
| ------------ | ---------------------------- | ---------------------- | -------------------------- |
| **适合谁**   | 有现成远端服务，只想连       | 团队协作，或多设备切换 | 个人开发者，只在一台电脑用 |
| **需要什么** | Node.js + API Key            | 一台云服务器（VPS）    | Mac/Linux/Windows + Docker |
| **数据存哪** | 云服务器上                   | 云服务器上             | 你的电脑本地               |
| **难度**     | ⭐ 极简                      | ⭐⭐⭐ 中等            | ⭐⭐ 简单                  |

> 💡 **不确定选哪个？**
>
> - 如果管理员已经帮你部署好了远端服务并给了你 API Key → 选**方案 C**
> - 如果你要团队共享且自己维护服务 → 选**方案 B**
> - 只有在没有远端服务时，再考虑**方案 A（本地自托管）**

### 30 秒快速接入（推荐）

如果你手上已经有：

- `EASY_MEMORY_URL`（例如 `https://memory.zhiz.chat`）
- `EASY_MEMORY_TOKEN`（`em_...`）

那就直接走方案 C：

1. 在 MCP 配置里填 `npx easy-memory@latest` + 上述两个 env
2. Reload Window / 重启客户端
3. 运行 `MCP: List Servers` 检查是否已连接

> 这条路径最稳定，也最不容易触发 OAuth 动态注册告警。

---

## 方案 A：本地部署（可选）

### 前置条件

你需要先安装以下两样东西：

| 工具               | 用途                     | 安装方法                                                                 |
| ------------------ | ------------------------ | ------------------------------------------------------------------------ |
| **Node.js 20+**    | 运行 Easy Memory         | [nodejs.org](https://nodejs.org/) 下载安装包                             |
| **Docker Desktop** | 运行向量数据库和 AI 模型 | [docker.com](https://www.docker.com/products/docker-desktop/) 下载安装包 |

安装完后，打开终端验证：

```bash
node --version   # 应该显示 v20.x.x 或更高
docker --version # 应该显示 Docker version 24.x.x 或更高
```

### 步骤 1：启动依赖服务

打开终端，逐行复制粘贴执行：

```bash
# 启动向量数据库 Qdrant（存储记忆的地方）
docker run -d --name qdrant \
  -p 6333:6333 \
  -v qdrant_data:/qdrant/storage \
  -e QDRANT__SERVICE__API_KEY=my-secret-key \
  qdrant/qdrant:latest

# 启动 Ollama（本地 AI 模型，用于理解语义）
docker run -d --name ollama \
  -p 11434:11434 \
  -v ollama_data:/root/.ollama \
  ollama/ollama:latest

# 下载语义理解模型（约 2GB，首次需要几分钟）
docker exec ollama ollama pull bge-m3
```

### 步骤 2：验证服务

```bash
# 检查 Qdrant 是否正常
curl http://localhost:6333/healthz
# 应该返回类似 "ok" 的内容

# 检查 Ollama 是否正常
curl http://localhost:11434/api/tags
# 应该返回包含 bge-m3 的 JSON
```

### 步骤 3：连接 AI 客户端

现在跳到 [连接你的 AI 客户端](#连接你的-ai-客户端) 章节，按你使用的工具配置即可。

> **⚠️ 注意**：每次重启电脑后，需要确保 Docker Desktop 已启动（两个容器会自动运行）。

---

## 方案 B：远程服务器部署（推荐团队/多设备）

### 前置条件

| 需求     | 说明                                           |
| -------- | ---------------------------------------------- |
| 一台 VPS | 最低 2核 CPU + 4GB 内存（Ollama 模型需约 2GB） |
| 一个域名 | 用于 HTTPS 访问（如 `memory.example.com`）     |
| SSH 工具 | 能连接到你的服务器                             |

### 步骤 1：登录服务器并下载项目

```bash
# SSH 登录你的服务器
ssh root@你的服务器IP

# 下载 Easy Memory
git clone https://github.com/FlippySun/easy-memory.git
cd easy-memory
```

### 步骤 2：配置环境变量

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置
nano .env   # 或用 vim .env
```

**必须修改以下 3 项**（把值改成你自己的强密码）：

```dotenv
# ⬇️ 改成一个随机字符串（比如 32 位随机密码），用于数据库加密
QDRANT_API_KEY=这里换成你的强密码1

# ⬇️ 改成一个随机字符串，这是 Master Token（管理员用）
HTTP_AUTH_TOKEN=这里换成你的强密码2

# ⬇️ 改成一个随机字符串，用于 Web 管理后台认证
ADMIN_TOKEN=这里换成你的强密码3

# ⬇️ Web 管理面板的登录用户名和密码
ADMIN_USERNAME=admin
ADMIN_PASSWORD=这里换成你的管理员密码
```

> 💡 **如何生成随机密码？** 在终端运行：`openssl rand -hex 16`

保存并退出编辑器（nano 按 `Ctrl+X`，然后 `Y`，回车）。

### 步骤 3：一键启动

```bash
# 使用生产配置启动（自动拉取 Docker 镜像 + AI 模型）
docker compose -f docker-compose.prod.yml up -d

# 等待 1-2 分钟（首次需要下载 AI 模型）

# 检查是否成功
curl http://localhost:3080/health
# 应该返回: {"status":"ok","mode":"http"}
```

### 步骤 4：配置 HTTPS（推荐 Caddy — 全自动 HTTPS）

**前提**：你的域名已经指向服务器 IP（添加 DNS A 记录）。

```bash
# 安装 Caddy（以 Ubuntu/Debian 为例）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# 复制配置模板
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile

# 编辑：把 memory.example.com 替换成你的域名
sudo nano /etc/caddy/Caddyfile

# 重载 Caddy（会自动申请免费 SSL 证书）
sudo systemctl reload caddy
```

验证 HTTPS：

```bash
curl https://你的域名/health
# 返回: {"status":"ok","mode":"http"}
```

### 步骤 5：为团队成员创建 Token

```bash
# 替换 <你的域名> 和 <ADMIN_TOKEN>
curl -X POST https://你的域名/api/admin/keys \
  -H "Authorization: Bearer <你的ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "小明-personal",
    "scopes": ["memory_save", "memory_search", "memory_forget", "memory_status"],
    "rate_limit": 30
  }'
```

返回结果中的 `key` 字段（以 `em_` 开头）就是该用户的 Token，**只显示一次**，请立即复制发给对应的人。

---

## 方案 C：远程代理模式（推荐优先 — 无需 Docker）

如果你已经有一台运行 Easy Memory 的远端服务器（管理员给了你 API Key 和服务地址），只需两步即可完成。

### 前置条件

| 工具            | 用途                | 安装方法                                     |
| --------------- | ------------------- | -------------------------------------------- |
| **Node.js 20+** | 运行本地 stdio 代理 | [nodejs.org](https://nodejs.org/) 下载安装包 |

不需要 Docker、不需要 Qdrant、不需要 Ollama — 所有计算都在远端服务器完成。

### 你需要从管理员处获取

- **API Key**：类似 `em_abc123...` 的字符串
- **服务地址**：类似 `https://memory.example.com` 的 URL

### 配置方法

直接跳到 [连接你的 AI 客户端](#连接你的-ai-客户端)，在每个客户端的**远程部署**部分找到配置即可。

> 💡 **原理**：`npx easy-memory` 检测到 `EASY_MEMORY_TOKEN` 和 `EASY_MEMORY_URL` 环境变量后，会自动切换为远程代理模式——本地进程仅做 stdio↔HTTP 桥接，所有记忆读写转发到远端服务器。

---

## 连接你的 AI 客户端

### 根键速查（非常重要）

| 客户端                   | MCP 配置根键 |
| ------------------------ | ------------ |
| VS Code (GitHub Copilot) | `servers`    |
| Claude Desktop / Cursor  | `mcpServers` |

键名写错会出现“配置看起来在，但工具列表为空”的假故障。

### 1. Claude Desktop

打开配置文件：

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

#### 本地部署（方案 A）

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "my-secret-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

#### 远程部署（方案 B）— 远程代理模式

> Claude Desktop 不原生支持 HTTP 远端连接，但可通过 **远程代理模式** 实现！本地仍走 stdio，但所有记忆操作会自动转发到远端服务器。

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory@latest"],
      "env": {
        "EASY_MEMORY_TOKEN": "em_你的API-Key",
        "EASY_MEMORY_URL": "https://你的域名"
      }
    }
  }
}
```

- `EASY_MEMORY_TOKEN` — 从管理员处获取的 API Key（`em_` 开头）
- `EASY_MEMORY_URL` — 远端 Easy Memory 服务地址（如 `https://memory.example.com`）

> 设置这两个环境变量后，npm 包会自动切换为远程代理模式，**无需本地 Qdrant 和 Ollama**。

配置完成后，**完全退出并重新打开** Claude Desktop（不是关闭窗口，是彻底退出应用）。

---

### 2. Cursor

打开 Cursor → `Settings` → 搜索 `MCP` → 点击 `Edit in mcp.json`

#### 本地部署（方案 A）

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "my-secret-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

#### 远程部署（方案 B）— 推荐：远程代理模式（stdio）

```json
{
  "mcpServers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory@latest"],
      "env": {
        "EASY_MEMORY_TOKEN": "em_你的API-Key",
        "EASY_MEMORY_URL": "https://你的域名"
      }
    }
  }
}
```

> 这是 stdio↔HTTP 代理模式，通常能避免 `type: "http"` 在部分客户端触发 OAuth 探测告警。

#### 可选：Streamable HTTP 直连（进阶）

```json
{
  "mcpServers": {
    "easy-memory": {
      "url": "https://你的域名/mcp",
      "headers": {
        "Authorization": "Bearer em_你的API-Key"
      }
    }
  }
}
```

> 如果你看到 OAuth / 动态客户端注册提示，请切回上面的远程代理模式。

配置完成后，重启 Cursor。

---

### 3. VS Code（GitHub Copilot）

在项目根目录创建 `.vscode/mcp.json` 文件：

#### 本地部署（方案 A）

```json
{
  "servers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_API_KEY": "my-secret-key",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

#### 远程部署（方案 B）— 推荐：远程代理模式（stdio）

```json
{
  "servers": {
    "easy-memory": {
      "command": "npx",
      "args": ["-y", "easy-memory@latest"],
      "env": {
        "EASY_MEMORY_TOKEN": "em_你的API-Key",
        "EASY_MEMORY_URL": "https://你的域名"
      }
    }
  }
}
```

> 这是 VS Code 下最稳妥的接入方式：不会先走 OAuth 客户端注册探测。

#### 可选：Streamable HTTP 直连（进阶）

```json
{
  "servers": {
    "easy-memory": {
      "type": "http",
      "url": "https://你的域名/mcp",
      "headers": {
        "Authorization": "Bearer em_你的API-Key"
      }
    }
  }
}
```

> ⚠️ 若 VS Code 报“授权服务器不支持动态客户端注册”，请改回上面的远程代理模式（stdio）。

保存后，在 VS Code 命令面板中运行 `MCP: List Servers` 确认连接状态。

---

### 4. JetBrains IDE

> 适用于 IntelliJ IDEA、WebStorm、PyCharm 等。

JetBrains IDE 支持远程 Streamable HTTP 模式（方案 B），在 AI Assistant MCP 配置中添加：

```json
{
  "mcpServers": {
    "easy-memory": {
      "url": "https://你的域名/mcp",
      "headers": {
        "Authorization": "Bearer em_你的API-Key"
      }
    }
  }
}
```

> JetBrains 本地 stdio 模式也计划支持，可关注 [JetBrains MCP 文档](https://www.jetbrains.com/help/idea/mcp.html) 更新。

---

## 使用教程：AI 记忆操作

配置完成后，你的 AI 助手就多了 4 个记忆工具。你可以直接用自然语言要求 AI 使用它们：

### 保存记忆

直接告诉 AI 你想记住什么：

```
请帮我记住：这个项目使用 pnpm 作为包管理器，代码风格遵循 Airbnb 规范。
```

```
保存一条记忆：数据库密码的更新周期是每 90 天轮换一次。
```

```
记住我的偏好：我喜欢用函数式组件而不是类组件。
```

### 搜索记忆

问 AI 它之前记住过什么：

```
搜索一下之前关于这个项目的编码规范记忆。
```

```
你还记得之前我让你记住的关于数据库部署相关的信息吗？
```

```
检索一下我之前存过的所有 React 相关的记忆。
```

### 遗忘记忆

当信息过时了：

```
之前保存的关于使用 npm 的记忆已经过时了，我们改用 pnpm 了，请归档掉旧的。
```

### 查看状态

```
检查一下 Easy Memory 服务的状态。
```

### 使用技巧

1. **保存时加上分类标签**：告诉 AI "这是一个编码规范" 或 "标签是 deployment"，方便后续精确检索
2. **指定项目隔离**：如果你有多个项目，可以说 "保存到 my-project 项目下"
3. **定期清理**：过时的信息及时标记为过时或归档，保持记忆库干净
4. **首次使用建议**：先存几条你最常用的编码偏好，后续新会话 AI 就能自动参考

---

## Web 管理面板

> 仅在远程部署（方案 B）时可用。

### 访问管理面板

打开浏览器，访问你的域名（如 `https://memory.example.com`），使用 `.env` 中设置的管理员用户名和密码登录。

### 功能一览

| 页面           | 功能       | 使用场景                           |
| -------------- | ---------- | ---------------------------------- |
| **Dashboard**  | 实时概览   | 查看服务当前状态、请求量、成功率   |
| **API Keys**   | 密钥管理   | 为团队成员创建/禁用/删除 Token     |
| **Bans**       | 封禁管理   | 封禁恶意 IP 或泄露的 Token         |
| **Analytics**  | 用量分析   | 查看各操作的调用次数和错误率       |
| **Audit Logs** | 审计日志   | 追踪每一次记忆操作的详细记录       |
| **Users**      | 用户管理   | 创建/删除管理面板的登录账户        |
| **Settings**   | 运行时配置 | 在线修改速率限制等配置（无需重启） |

### 管理面板截图说明

**Dashboard（仪表盘）**：显示系统模式（HTTP）、你的角色（admin/user）、以及快捷入口。

**API Keys（密钥管理）**：

- 点击 **Create Key** 创建新密钥
- 填写名称（如 `小明-工作`）、选择权限范围、设置速率限制
- 创建后 Token **只显示一次**，请立即复制

**Settings（运行时配置）**：

- 可在线修改速率限制、审计开关等参数
- 修改后点击 **Save Changes** 即时生效，无需重启服务

---

## 常见问题 FAQ

### Q: 首次启动很慢？

**A**: 正常。首次启动时需要下载 AI 语义模型 `bge-m3`（约 2GB），取决于网速可能需要 5-15 分钟。后续启动秒级完成。

### Q: `npx easy-memory` 运行后没有任何输出？

**A**: 正常行为。MCP 服务通过 stdin/stdout 和 AI 客户端通信，不会在终端打印任何内容。只要没有报错，就说明已经在等待客户端连接了。

### Q: 如何确认服务是否正常？

**A**:

本地模式 — 在 AI 客户端中发送：

```
检查 Easy Memory 的状态
```

HTTP 模式 — 用 curl 检查：

```bash
curl http://localhost:3080/health
# 正常返回: {"status":"ok","mode":"http"}
```

### Q: Docker 容器重启后数据会丢失吗？

**A**: 不会。

- **Qdrant / Ollama**：使用 Docker Volume 持久化，重启不丢失
- **Easy Memory 内部数据**（API Key、审计日志、分析数据等）：通过 `DATA_DIR` 环境变量指定存储目录，Docker Compose 已配置 Volume 映射到 `/data`，重启和升级均不受影响

### Q: 如何升级到最新版本？

**A**:

方案 A（本地 npx）— 自动使用最新版，无需手动升级。

方案 B（远程 Docker）：

```bash
cd /path/to/easy-memory
docker compose -f docker-compose.prod.yml pull easy-memory
docker compose -f docker-compose.prod.yml up -d easy-memory
```

### Q: Ollama 占用内存太大？

**A**: `bge-m3` 模型需要约 2GB 内存。如果服务器内存紧张，可以改用远程 Gemini Embedding（无需本地 Ollama）：

```dotenv
# .env 中修改
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=你的Google API Key
GEMINI_PROJECT_ID=你的GCP项目ID
```

然后在 `docker-compose.prod.yml` 中注释掉 `ollama` 和 `ollama-init` 服务即可。

### Q: 报错 `QDRANT_API_KEY` 不匹配？

**A**: 确保 `.env` 里的 `QDRANT_API_KEY` 和 Qdrant 容器启动时设置的一致。如果改了密钥，需要同时重启 Qdrant 和 Easy Memory：

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

### Q: Claude Desktop 连接失败？

**A**: 常见原因：

1. **Docker 没启动**（本地模式）— 确保 Docker Desktop 已打开，Qdrant 和 Ollama 容器正在运行
2. **配置文件格式错误** — JSON 语法必须严格正确（注意逗号和引号）
3. **没有重启 Claude** — 修改配置后必须**完全退出再重新打开** Claude Desktop（不是关闭窗口，是彻底退出应用）
4. **远程模式 Token 无效** — 确认 `EASY_MEMORY_TOKEN` 以 `em_` 开头，且未被管理员吊销

### Q: VS Code 提示“授权服务器不支持动态客户端注册”怎么办？

**A**: 这是 `type: "http"` 触发的 OAuth 探测提示，而 Easy Memory 当前使用的是 Bearer Token 模式，不是 OAuth 动态注册。

建议直接改用 **远程代理模式（stdio）**：

- `command`: `npx`
- `args`: `easy-memory@latest`
- `env`: `EASY_MEMORY_URL` + `EASY_MEMORY_TOKEN`

这通常即可消除告警并稳定握手。

### Q: AI 说“工具未出现在列表，握手未完成”是 VPS 挂了吗？

**A**: 不一定。先按这个顺序排查：

1. 修改 MCP 配置后执行 **Reload Window**
2. 在命令面板运行 `MCP: List Servers` 查看 server 状态
3. 检查 JSON 键名是否正确（VS Code 用 `servers`，Claude/Cursor 常见 `mcpServers`）
4. 检查远端健康：`/health` 返回 `{"status":"ok","mode":"http"}`
5. 检查鉴权行为：未带 token 访问 `/mcp` 返回 `401` 是正常，说明服务在线且在保护端点

如果 4、5 正常，多数是客户端配置/重载问题，不是 VPS 服务宕机。

### Q: 30 秒快速排障怎么做？

**A**: 按这个顺序走，几乎能覆盖大多数接入问题：

1. 确认根键（VS Code=`servers`，Claude/Cursor=`mcpServers`）
2. Reload Window / 重启客户端
3. 看 `MCP: List Servers`
4. 验证 `GET /health` 是否 `ok`
5. 若 `type:"http"` 弹 OAuth 动态注册提示，切回 stdio 远程代理模式

### Q: 多个项目的记忆会互相干扰吗？

**A**: 不会，你可以通过 `project` 参数（在 VS Code 中是 `PROJECT_SLUG` 环境变量）隔离不同项目的记忆。AI 搜索时只会返回当前项目的记忆。

### Q: 如何备份记忆数据？

**A**: 备份 Qdrant 的 Docker Volume：

```bash
# 找到 Volume 位置
docker volume inspect qdrant_data

# 或者用 Qdrant 的快照 API
curl -X POST http://localhost:6333/collections/easy_memory/snapshots
```

### Q: 安全吗？

**A**: Easy Memory 内置了多层安全措施：

- **内容脱敏**：自动检测并屏蔽 AWS Key、JWT Token、数据库密码等敏感信息
- **API Key 哈希存储**：密钥使用 SHA-256 哈希后存储，即使数据库泄露也无法还原
- **速率限制**：防止滥用（默认每分钟 60 次）
- **审计日志**：每次操作都有记录，可追溯

---

## 三种 Token 的区别

部署方案 B 时，你会接触到三种 Token，它们的权限不同：

```
┌─────────────────────────────────────────────────────┐
│  ADMIN_TOKEN（管理员令牌）                            │
│  ├── 用途：访问 Web 管理面板的 Admin API              │
│  ├── 谁用：运维/管理员                               │
│  └── 可以：创建/吊销 API Key、查看分析/审计数据       │
│                                                     │
│  HTTP_AUTH_TOKEN（Master 令牌）                       │
│  ├── 用途：直接调用所有 MCP 工具                     │
│  ├── 谁用：管理员自己用                              │
│  └── 特点：无速率限制，最高权限                      │
│                                                     │
│  API Key（用户令牌，em_xxx...）                       │
│  ├── 用途：普通用户调用 MCP 工具                     │
│  ├── 谁用：团队成员                                  │
│  └── 特点：可设速率限制、项目隔离、可随时吊销         │
└─────────────────────────────────────────────────────┘
```

- **个人用户**只需要 `HTTP_AUTH_TOKEN` 即可
- **团队管理者**用 `ADMIN_TOKEN` 管理后台，用 `HTTP_AUTH_TOKEN` 自己使用
- **团队成员**从管理者处获取 `API Key`（`em_` 开头）

---

## 快速检查清单

部署完成后，用这个清单确认一切正常：

- [ ] `curl http://localhost:3080/health` 返回 `{"status":"ok","mode":"http"}`
- [ ] AI 客户端配置文件已保存
- [ ] AI 客户端已重启
- [ ] 在 AI 中说 "检查 Easy Memory 状态"，AI 能返回正常状态
- [ ] 在 AI 中说 "记住：这是一个测试记忆"，AI 确认保存成功
- [ ] 在 AI 中说 "搜索测试记忆"，AI 能搜到刚才保存的内容
- [ ] （远程部署）HTTPS 访问正常
- [ ] （远程部署）Web 管理面板可以登录

**全部打勾？恭喜你，Easy Memory 已经就绪！🎉**

---

## 更多资源

- 📦 npm: [npmjs.com/package/easy-memory](https://www.npmjs.com/package/easy-memory)
- 🐳 Docker Hub: [hub.docker.com/r/thj8632/easy-memory](https://hub.docker.com/r/thj8632/easy-memory)
- 📖 GitHub: [github.com/FlippySun/easy-memory](https://github.com/FlippySun/easy-memory)
- 🏗️ 架构文档: [FEASIBILITY-ANALYSIS.md](FEASIBILITY-ANALYSIS.md)
- 📋 数据契约: [CORE_SCHEMA.md](CORE_SCHEMA.md)
- 🔌 集成指南（开发者向）: [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)
