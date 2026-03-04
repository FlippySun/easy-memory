# 🛡️ Easy Memory — 后处理架构白皮书：鉴权·审计·管控

> **版本**: v1.1  
> **日期**: 2026-03-05 (回写更新)  
> **定位**: Phase 2 功能白皮书 — 多租户鉴权、审计日志采集、运维管控体系  
> **适用范围**: HTTP API 模式（VPS 远端部署），MCP stdio 模式不受影响  
> **实施状态**: ✅ Phase 2 全部实施完成（30 个测试文件, 786 个测试用例全部通过）
>
> **⚠️ 命名规范说明**: 本白皮书规划阶段使用 `memory.save` (点号分隔) 作为 AuditAction 命名，实际实施中统一使用 `memory_save` (下划线分隔) 以与 MCP 工具名保持一致。后续出现的 `memory.save` / `memory.search` 等命名请自动对应为实际代码中的 `memory_save` / `memory_search`。

---

## 多智能体推演摘要

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 架构 Agent: SQLite > Redis (单机部署零新增依赖), better-sqlite3 同步 API 避免异步竞态
• 安全 Agent: Key 前缀路由 + SHA-256 哈希存储 + timing-safe 比较;
             IP banning 需防 X-Forwarded-For 伪造链 → 优先信任 X-Real-IP
• 状态/数据流 Agent: 现有 RateLimiter 是全局实例，per-key 限流需独立滑动窗口 Map
             — 内存占用需设 LRU 上限 (1000 entries)
• 兼容性 Agent: MCP stdio 模式物理隔离不受影响;
             HTTP_AUTH_TOKEN 单 token 模式必须作为 legacy fallback 保留
• DevOps Agent: SQLite 文件需通过 Docker volume 持久化;
             JSONL 日志需 logrotate; Admin API 纯 JSON 无需前端
• 总控共识: SQLite + SHA-256 + 前缀路由 + LRU per-key limiter + 渐进迁移(bootstrap key)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 目录

1. [现状分析与差距](#一现状分析与差距)
2. [系统架构总览](#二系统架构总览)
3. [多租户 API Key 鉴权体系](#三多租户-api-key-鉴权体系)
4. [多层限流与配额管理](#四多层限流与配额管理)
5. [IP / Key 封禁体系](#五ip--key-封禁体系)
6. [统一审计日志系统](#六统一审计日志系统)
7. [用量分析与运维看板](#七用量分析与运维看板)
8. [Admin 管控 API](#八admin-管控-api)
9. [向后兼容与迁移策略](#九向后兼容与迁移策略)
10. [安全威胁模型与防御矩阵](#十安全威胁模型与防御矩阵)
11. [存储层设计 — SQLite Schema](#十一存储层设计--sqlite-schema)
12. [部署与运维](#十二部署与运维)
13. [分阶段实施计划](#十三分阶段实施计划)
14. [设计决策日志 (ADR)](#十四设计决策日志-adr)

---

## 一、现状分析与差距

### 1.1 当前能力

| 维度         | 现状                                                | 差距                                   |
| ------------ | --------------------------------------------------- | -------------------------------------- |
| **鉴权**     | 单一静态 Bearer Token (`HTTP_AUTH_TOKEN`)           | 无多用户、无角色、无 Key 生命周期管理  |
| **限流**     | 全局滑动窗口 60次/分 + Gemini 熔断器                | 无 per-user/per-key 限流、无日配额     |
| **审计日志** | save/forget 写 JSONL + stderr                       | search 无日志、无用户标识、无客户端 IP |
| **管控**     | 无 Admin API                                        | 无法远程封禁用户、调整配额、查看统计   |
| **分析**     | 无                                                  | 无命中率、无用户画像、无使用趋势       |
| **安全**     | TLS 强制 + timing-safe 比较 + Prompt Injection 检测 | 无 IP 封禁、无暴力破解防护             |

### 1.2 不变的铁律

以下原则在本次升级中**绝对不可打破**：

1. **绝对禁止 `console.log`** — MCP stdio 通道保护
2. **upsert 必须 `wait: true`** — Qdrant 一致性
3. **content 写入前必须 `basicSanitize`** — 敏感信息脱敏
4. **search 输出必须 boundary markers 包裹** — Prompt Injection 防御
5. **MCP stdio 模式不受 HTTP 层变更影响** — 物理隔离

---

## 二、系统架构总览

### 2.1 请求处理流水线 (增强后)

```
外部请求 (HTTPS via Nginx/Caddy)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Hono HTTP Server                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 0: TLS Enforcement (现有)                       │    │
│  │   X-Forwarded-Proto: https 验证                       │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 1: IP Ban Check [新增]                          │    │
│  │   内存 Set O(1) 查询 → 403 Forbidden                 │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 2: Global Rate Limit (现有)                     │    │
│  │   全局滑动窗口 → 429 Too Many Requests                │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 3: Authentication [增强]                        │    │
│  │   Bearer Token → SHA-256 → SQLite lookup              │    │
│  │   支持: API Key / Legacy Token / 无鉴权(dev)          │    │
│  │   注入 AuthContext 到请求上下文                        │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 4: Per-Key Rate Limit + Daily Quota [新增]      │    │
│  │   LRU Map 滑动窗口 → 429 + Retry-After               │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 5: Authorization [新增]                         │    │
│  │   RBAC 权限检查 → 403 Forbidden                       │    │
│  │   Project 隔离检查                                    │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Layer 6: Audit Logger [新增]                          │    │
│  │   请求开始 → 计时器启动                                │    │
│  │   请求完成 → 写审计日志 (fire-and-forget)             │    │
│  └──────────────────┬───────────────────────────────────┘    │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Business Logic (现有 core handlers)                   │    │
│  │   handleSave / handleSearch / handleForget / ...      │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 新增组件依赖图

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 以下为实际实现的组件名称与架构。与原规划的对照请参见 §14.ADR-AUDIT-08。

```
AppContainer (扩展)
    │
    ├── QdrantService (不变)
    ├── EmbeddingService (不变)
    ├── RateLimiter (增强) ── checkPerKeyRate() Per-Key 滑动窗口限流
    ├── BM25Encoder (不变)
    │
    ├── [新增] ApiKeyManager      ── SQLite (better-sqlite3) + 内存缓存
    ├── [新增] BanManager          ── 内存热路径 (Map) + SQLite 持久化
    ├── [新增] AuditService        ── JSONL 缓冲写入 + 轮转 (fire-and-forget)
    ├── [新增] AnalyticsService    ── SQLite WAL + JSONL 增量导入 + 聚合定时器
    └── [新增] RuntimeConfigManager ── JSON 文件持久化
```

### 2.3 文件结构 (新增部分)

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 以下为实际落地的文件结构。遵循"就近合并"原则，将多个小功能融入已有模块，减少文件碎片化。

```
src/
├── services/
│   ├── api-key-manager.ts      # API Key CRUD + SQLite + 内存缓存 + 审计追踪
│   ├── audit.ts                # 统一审计日志 (JSONL 缓冲写入 + 自动轮转)
│   ├── analytics.ts            # 用量分析聚合器 (SQLite WAL + JSONL 导入 + 定时聚合)
│   ├── ban-manager.ts          # IP/Key 封禁管理 (内存热路径 + SQLite 持久化)
│   └── runtime-config.ts       # 运行时配置管理 (JSON 文件 + defaults 合并)
├── api/
│   ├── admin-routes.ts         # Admin 管控路由 (Key/Ban/Analytics/Audit/Config CRUD)
│   ├── admin-auth.ts           # Admin 独立鉴权 (ADMIN_TOKEN timing-safe 比较)
│   ├── middlewares.ts          # 增强: bearerAuth(config) 双层鉴权 (Master + Managed Key)
│   ├── server.ts               # 增强: 内联审计中间件 + Ban 检查 + Per-key 限流接入
│   └── schemas.ts              # HTTP 请求 Zod Schema (不变)
├── types/
│   ├── admin-schema.ts         # API Key, Ban, RuntimeConfig Zod schemas + 类型定义
│   └── audit-schema.ts         # AuditLogEntry 类型 + 工具函数 (extractKeyPrefix 等)
└── utils/
    ├── ip.ts                   # 代理感知 IP 提取 (getClientIp)
    └── rate-limiter.ts         # 增强: checkPerKeyRate() Per-Key 滑动窗口 + LRU 上限
```

> **关键合并决策**:
>
> - `auth-middleware.ts` → 合并进 `middlewares.ts` 的 `bearerAuth(config: BearerAuthConfig)`
> - `audit-middleware.ts` → 内联进 `server.ts` 的 `/api/*` 中间件 (try/finally 双写)
> - `per-key-rate-limiter.ts` → 合并进 `rate-limiter.ts` 的 `checkPerKeyRate()` 方法
> - `client-ip.ts` → 重命名为 `ip.ts` (getClientIp 函数)

---

## 三、多租户 API Key 鉴权体系

### 3.1 Key 格式设计

```
em_{role}_{random_hex}

示例:
  em_admin_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4
  em_user_7f8e9d0c1b2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d
  em_ro_3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d
```

| 段         | 长度     | 描述                                                          |
| ---------- | -------- | ------------------------------------------------------------- |
| `em_`      | 3 字符   | 全局前缀，方便 grep/rotation 扫描，标识来源                   |
| `{role}_`  | 4-6 字符 | `admin_` / `user_` / `ro_` — 可视化辨识（鉴权以 DB 记录为准） |
| `{random}` | 64 字符  | `crypto.randomBytes(32).toString('hex')` — 256-bit 随机熵     |

总长度：67-73 字符。

### 3.2 Key 哈希存储

```typescript
/**
 * 为什么用 SHA-256 而非 bcrypt/scrypt？
 *
 * 1. API Key 是高熵随机值 (256-bit)，不是人类密码 — 彩虹表/字典攻击不可行
 * 2. 每次请求都需要验证 — bcrypt ~100ms 延迟在热路径上不可接受
 * 3. SHA-256(256-bit random) 的碰撞/原像攻击计算不可行 (2^256 搜索空间)
 * 4. 即使 SQLite 文件泄露，攻击者也无法从 hash 反推原始 Key
 */
function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
```

### 3.3 角色与权限矩阵

| 操作                | `admin`  | `user`   | `readonly` | `legacy` |
| ------------------- | -------- | -------- | ---------- | -------- |
| `POST /api/save`    | ✅       | ✅       | ❌         | ✅       |
| `POST /api/search`  | ✅       | ✅       | ✅         | ✅       |
| `POST /api/forget`  | ✅       | ✅       | ❌         | ✅       |
| `GET /api/status`   | ✅       | ✅       | ✅         | ✅       |
| `GET /health`       | 无需鉴权 | 无需鉴权 | 无需鉴权   | 无需鉴权 |
| `/admin/*` 全部端点 | ✅       | ❌       | ❌         | ✅\*     |
| Project 访问范围    | 全部     | 受限     | 受限       | 全部     |

> `*` legacy token 在 bootstrap 阶段视为 admin，用于创建第一个 admin API Key。

```typescript
// src/api/authorization.ts

export type ApiKeyRole = "admin" | "user" | "readonly";
type Permission = "save" | "search" | "forget" | "status" | "admin";

const ROLE_PERMISSIONS: Record<ApiKeyRole, Set<Permission>> = {
  admin: new Set(["save", "search", "forget", "status", "admin"]),
  user: new Set(["save", "search", "forget", "status"]),
  readonly: new Set(["search", "status"]),
};

export function hasPermission(role: ApiKeyRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

export function canAccessProject(
  allowedProjects: string[],
  targetProject: string,
): boolean {
  if (allowedProjects.length === 0) return true; // 空 = 全部
  return allowedProjects.includes(targetProject);
}
```

### 3.4 Key 数据模型

```typescript
// src/types/auth.ts

export interface ApiKeyRecord {
  /** SHA-256 hash of the raw API key (SQLite primary key) */
  key_hash: string;

  /** 显示用前缀: em_admin_a1b2 (前 12 字符) — 用于日志/审计/列表展示 */
  key_prefix: string;

  /** 人类可读标签: "Alice-Cursor", "CI-Pipeline", "Bob-Home" */
  label: string;

  /** 角色 */
  role: ApiKeyRole;

  /** 该 Key 允许访问的 project 列表 (空 = 全部) */
  allowed_projects: string[];

  /** 自定义每分钟 Rate Limit (null = 使用全局默认值) */
  rate_limit_per_minute: number | null;

  /** 每日调用上限 (null = 无限制) */
  daily_quota: number | null;

  /** 创建时间 (ISO 8601) */
  created_at: string;

  /** 过期时间 (ISO 8601, null = 永不过期) */
  expires_at: string | null;

  /** 最后使用时间 */
  last_used_at: string | null;

  /** 今日使用计数 (运行时维护，非持久化) */
  daily_usage_count: number;

  /** 是否被封禁 */
  is_banned: boolean;

  /** 封禁原因 */
  ban_reason: string | null;

  /** 封禁时间 */
  banned_at: string | null;

  /** 软删除标记 */
  is_revoked: boolean;

  /** 备注（管理员可编辑） */
  notes: string;
}

/** 注入到 Hono Context 的鉴权结果 */
export interface AuthContext {
  auth_mode: "api_key" | "legacy_token" | "none";
  role: ApiKeyRole;
  key_id: string; // 显示用前缀 em_user_7f8e
  label: string;
  allowed_projects: string[];
  key_hash: string; // 内部用，用于 per-key 限流
}
```

### 3.5 Key 生命周期

```
    ┌──────────┐
    │ Bootstrap│  HTTP_AUTH_TOKEN 作为 bootstrap 凭证
    │  (一次性) │  创建第一个 admin API Key
    └────┬─────┘
         │
         ▼
    ┌──────────┐     POST /admin/keys/:id/rotate
    │  Active  │────────────────────────────────▶ ┌──────────┐
    │  (Key A) │                                  │  Active   │ (新 Key B)
    └────┬─────┘                                  └───────────┘
         │                                              │
    ┌────┴─────────────────┐                            │
    │ revoke               │ ban                        │
    ▼                      ▼                            │
  ┌────────┐        ┌──────────┐                        │
  │Revoked │        │  Banned  │                        │
  │(soft)  │        │(+reason) │                        │
  └────────┘        └──────────┘                        │
                                                        │
         expires_at reached ────────────────────────────┤
                                                        ▼
                                              ┌──────────────┐
                                              │   Expired    │
                                              │ (auto-reject)│
                                              └──────────────┘
```

### 3.6 鉴权中间件逻辑

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 实际实现未创建独立的 `auth-middleware.ts`，而是将增强鉴权逻辑合并到了 `src/api/middlewares.ts` 中的 `bearerAuth(config: BearerAuthConfig)` 函数。旧版 `bearerAuth(token: string)` 保留为 `bearerAuthSimple(token)` (@deprecated)。

```typescript
// src/api/middlewares.ts — 实际实现 (非伪代码)

export interface BearerAuthConfig {
  masterToken: string;
  apiKeyManager?: ApiKeyManager;
  banManager?: BanManager;
  rateLimiter?: RateLimiter;
}

export function bearerAuth(config: BearerAuthConfig) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or malformed Authorization header" }, 401);
    }
    const token = authHeader.slice(7);

    // ① Master Token — 直通 (admin 特权，跳过 per-key 限流)
    if (safeCompare(token, config.masterToken)) {
      c.set("authMode", "master");
      await next();
      return;
    }

    // ② Managed API Key — 完整鉴权链路
    if (config.apiKeyManager) {
      const keyRecord = config.apiKeyManager.validateKey(token);
      if (keyRecord) {
        // ②a 封禁检查
        if (config.banManager) {
          const banResult = config.banManager.isKeyBanned(keyRecord.id);
          if (banResult.banned) {
            return c.json({ error: "API key is banned", reason: banResult.reason }, 403);
          }
        }
        // ②b Per-Key 限流 (catch 已收窄: 仅 Rate limit 错误 → 429)
        if (config.rateLimiter) {
          try {
            config.rateLimiter.checkPerKeyRate(
              keyRecord.key_hash,
              keyRecord.rate_limit_per_minute,
            );
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes("Rate limit exceeded")) {
              return c.json({ error: "Too many requests for this key" }, 429);
            }
            throw err; // 非限流异常 → 上抛给 globalErrorHandler
          }
        }
        // ②c 记录用量 + 注入上下文
        config.apiKeyManager.recordUsage(keyRecord.id);
        c.set("authMode", "api_key");
        c.set("apiKeyRecord", keyRecord);
        await next();
        return;
      }
    }

    // ③ 所有层均未匹配 → 401
    return c.json({ error: "Invalid or expired token" }, 401);
  };
}
    key_hash: keyHash,
  });

  // ⑧ 异步更新 last_used_at (fire-and-forget)
  apiKeyStore.touchLastUsed(keyHash);

  await next();
}
```

---

## 四、多层限流与配额管理

### 4.1 双层限流架构

```
Request ──┬──▶ [Layer 1: IP Ban Check]      ── 403 Forbidden
          │
          ├──▶ [Layer 2: Global Rate Limit]  ── 429 (现有 RateLimiter)
          │      全局 60次/分 滑动窗口
          │
          ├──▶ [Layer 3: Auth + Key Lookup]  ── 401 Unauthorized
          │
          ├──▶ [Layer 4: Per-Key Rate Limit] ── 429 + Retry-After header
          │      每 Key 自定义 RPM
          │
          ├──▶ [Layer 5: Per-Key Daily Quota]── 429 + quota info
          │      每 Key 每日调用上限
          │
          └──▶ [Layer 6: Authorization]      ── 403 Forbidden
               │      RBAC 角色权限
               ▼
          [Business Logic]
```

### 4.2 Per-Key 限流器

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 未创建独立的 `PerKeyRateLimiter` 类和 `per-key-rate-limiter.ts` 文件。Per-Key 限流逻辑已整合进现有的 `src/utils/rate-limiter.ts` 中的 `RateLimiter` 类，通过新增 `checkPerKeyRate()` 方法实现。

```typescript
// src/utils/rate-limiter.ts — 实际实现 (集成在 RateLimiter 类中)

export class RateLimiter {
  // ... 现有全局限流逻辑 ...

  /** Per-Key 滑动窗口 Map — key_hash → timestamps[] */
  private perKeyWindows = new Map<string, number[]>();
  private readonly maxPerKeyEntries: number; // LRU 上限 (默认 1000)

  /**
   * Per-Key 滑动窗口限流检查。
   *
   * 设计决策:
   * - 集成到 RateLimiter 而非独立类 — 避免状态分裂，共享时间窗口逻辑
   * - LRU 驱逐: Map.keys().next().value 驱逐最旧条目
   * - 抛异常而非返回 null — 与全局 checkRate() 保持一致的控制流
   *
   * 调用点: bearerAuth 中间件 (catch 已收窄至仅捕获 "Rate limit exceeded")
   *
   * @throws Error("Rate limit exceeded") 当超出 per-key 限流阈值
   */
  checkPerKeyRate(keyHash: string, perKeyLimit: number): void {
    const now = Date.now();
    let timestamps = this.perKeyWindows.get(keyHash);

    if (!timestamps) {
      // LRU 驱逐
      if (this.perKeyWindows.size >= this.maxPerKeyEntries) {
        const oldestKey = this.perKeyWindows.keys().next().value;
        if (oldestKey !== undefined) this.perKeyWindows.delete(oldestKey);
      }
      timestamps = [];
      this.perKeyWindows.set(keyHash, timestamps);
    }

    // 清理过期时间戳 (1 分钟窗口)
    const windowStart = now - 60_000;
    const active = timestamps.filter((t) => t > windowStart);

    if (active.length >= perKeyLimit) {
      throw new Error(`Rate limit exceeded (${perKeyLimit}/min for this key)`);
    }

    active.push(now);
    this.perKeyWindows.set(keyHash, active);
  }
}
```

> **关键差异**: 白皮书原规划的日配额检查 (`dailyQuota`) 通过 `ApiKeyManager.recordUsage()` 在应用层管理，而非在限流器内实现，实现了关注点分离。

### 4.3 限流响应规范

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 12
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1709560800

{
  "error": "Rate limit exceeded (60/min)",
  "retry_after_seconds": 12
}
```

---

## 五、IP / Key 封禁体系

### 5.1 客户端 IP 提取 (代理感知)

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 文件路径从 `src/utils/client-ip.ts` 变更为 `src/utils/ip.ts`，函数名从 `extractClientIp` 变更为 `getClientIp`。签名从 `(headers, trustProxy)` 简化为 `(c: Context, trustProxy?: boolean)` — 直接接收 Hono Context，内部自行读取 header。IP 提取优先级调整为：X-Real-IP > X-Forwarded-For **第一个** IP（而非最后一个），与实际 VPS 部署场景匹配（Nginx 作为最外层代理时，第一个 IP 是真实客户端）。

```typescript
// src/utils/ip.ts — 实际实现

import type { Context } from "hono";

/**
 * 代理感知的客户端 IP 提取。
 *
 * 提取优先级:
 * 1. X-Real-IP — 单值，由 Nginx 直连设置 (最可靠)
 * 2. X-Forwarded-For 第一个 IP — 客户端 IP (仅在 trustProxy=true 时信任)
 * 3. 回退 "unknown"
 *
 * @param c - Hono Context 对象
 * @param trustProxy - 是否信任代理 header (默认 false)
 */
export function getClientIp(c: Context, trustProxy?: boolean): string {
  if (!trustProxy) return c.req.header("x-real-ip") || "unknown";

  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();

  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();

  return "unknown";
}
```

### 5.2 IP 封禁数据模型

```typescript
// src/services/ip-ban.ts

export interface IpBanRecord {
  ip: string; // IPv4/IPv6 或 CIDR
  reason: string;
  banned_at: string; // ISO 8601
  expires_at: string | null; // null = 永久
  banned_by: string; // 操作者 key_prefix
}

/**
 * IP 封禁检查器。
 *
 * 性能策略:
 * - 启动时从 SQLite 加载全部生效 ban 到内存 Set
 * - 写入时同时更新 SQLite + 内存
 * - 精确 IP: O(1) Set 查询
 * - CIDR 范围: 线性遍历 (通常 <100 条规则)
 * - 过期自动清理: 检查时判断 expires_at
 */
export class IpBanChecker {
  private exactBans = new Map<string, IpBanRecord>();
  private cidrBans: Array<IpBanRecord & { network: bigint; mask: bigint }> = [];

  isBanned(ip: string): { banned: boolean; reason?: string } {
    // 精确匹配
    const exact = this.exactBans.get(ip);
    if (exact) {
      if (exact.expires_at && new Date(exact.expires_at) < new Date()) {
        this.exactBans.delete(ip);
        return { banned: false };
      }
      return { banned: true, reason: exact.reason };
    }

    // CIDR 匹配
    for (const cidr of this.cidrBans) {
      if (cidr.expires_at && new Date(cidr.expires_at) < new Date()) continue;
      if (this.ipMatchesCidr(ip, cidr.network, cidr.mask)) {
        return { banned: true, reason: cidr.reason };
      }
    }

    return { banned: false };
  }

  // ... addBan, removeBan, loadFromDb methods
}
```

### 5.3 Key 封禁机制

```typescript
/**
 * Key 封禁设计决策:
 *
 * 1. 即时生效: SQLite 标记 is_banned=true, 下一次请求即被拒绝
 * 2. 可逆操作: 提供 unban 端点（完整审计记录）
 * 3. 响应区分: 403 (知道你是谁但禁止) vs 401 (不知道你是谁)
 * 4. 封禁时记录: 原因 + 操作者 + 时间戳
 *
 * 自动封禁触发器 (Phase 2 可选):
 * - 某 Key 24h 内触发 >1000 次 429 → 自动 ban Key
 * - 某 IP 连续 >100 次 401 → 自动 ban IP 30 分钟
 */
```

### 5.4 封禁中间件插入点

```
app.use('/api/*',  ipBanMiddleware);      // Layer 1
app.use('/api/*',  globalRateLimit);       // Layer 2 (现有)
app.use('/api/*',  enhancedAuthMiddleware); // Layer 3 (含 key ban 检查)
app.use('/api/*',  perKeyRateLimit);       // Layer 4
app.use('/api/*',  authorizationMiddleware);// Layer 5
app.use('/api/*',  auditMiddleware);       // Layer 6
```

---

## 六、统一审计日志系统

### 6.1 审计日志 Schema

```typescript
// src/types/audit.ts

export type AuditAction =
  // 数据操作
  | "memory.save"
  | "memory.search"
  | "memory.forget"
  | "memory.status"
  // 管理操作
  | "admin.key.create"
  | "admin.key.revoke"
  | "admin.key.rotate"
  | "admin.key.ban"
  | "admin.key.unban"
  | "admin.key.update"
  | "admin.ip.ban"
  | "admin.ip.unban"
  | "admin.config.update"
  // 安全事件
  | "auth.failure"
  | "auth.banned_attempt"
  | "auth.expired_key"
  | "rate_limit.global"
  | "rate_limit.per_key"
  | "quota.exhausted"
  | "ip.banned_attempt";

export interface AuditLogEntry {
  /** 唯一 ID (UUID v4) */
  id: string;

  /** ISO 8601 时间戳 (UTC) */
  ts: string;

  /** 操作类型 */
  action: AuditAction;

  /** 操作是否成功 */
  success: boolean;

  /** 鉴权上下文 */
  auth: {
    mode: "api_key" | "legacy_token" | "none" | "unauthenticated";
    key_id: string; // 前缀 em_user_7f8e (安全: 仅前 12 字符)
    label: string;
    role: string;
  };

  /** 客户端信息 */
  client: {
    ip: string;
    user_agent: string;
  };

  /** 请求上下文 */
  request: {
    method: string;
    path: string;
    project?: string;
  };

  /** 操作特定的元数据 */
  meta?: {
    // memory.save 专用
    memory_id?: string;
    content_hash?: string;
    content_preview?: string; // 前 50 字符，脱敏后
    fact_type?: string;
    tags?: string[];
    embedding_model?: string;
    save_status?: string; // saved | duplicate_merged | rejected_*

    // memory.search 专用
    query_hash?: string; // SHA-256(query) — 不泄露原文
    query_preview?: string; // 前 30 字符
    results_count?: number;
    top_score?: number;
    model_used?: string;
    hit_rate_score?: number; // 结果中 score > threshold 的比例

    // memory.forget 专用
    forget_action?: string;
    forget_reason?: string;

    // admin 操作专用
    target_key_prefix?: string;
    target_ip?: string;
    changes?: Record<string, unknown>;
  };

  /** 响应信息 */
  response: {
    status: number;
    elapsed_ms: number;
  };
}
```

### 6.2 审计日志服务

```typescript
// src/services/audit-logger.ts

/**
 * 统一审计日志服务。
 *
 * 双通道写入策略:
 * - Channel 1: JSONL 文件 (append-only) — 实时持久化，fire-and-forget
 * - Channel 2: SQLite audit_logs 表 — 供 Admin API 查询 (异步 best-effort)
 *
 * 性能保障:
 * - 写入操作不阻塞请求处理 (fire-and-forget async)
 * - 每条 JSONL < PIPE_BUF (4096B)，OS 保证原子写入
 * - SQLite 使用 WAL 模式，写入不阻塞读取
 *
 * 安全铁律:
 * - content 仅记录前 50 字符 preview + SHA-256 hash — 不泄露全文
 * - query 仅记录前 30 字符 preview + SHA-256 hash
 * - 原始 API Key 绝对不出现在日志中（仅 key_prefix）
 * - 审计日志本身不通过 MCP stdio 输出
 */
export class AuditLogger {
  constructor(
    private readonly jsonlPath: string,
    private readonly db: SqliteDatabase, // better-sqlite3 实例
  ) {}

  write(entry: AuditLogEntry): void {
    // JSONL channel (primary, fire-and-forget)
    const line = JSON.stringify(entry) + "\n";
    appendFile(this.jsonlPath, line).catch(() => {
      // JSONL 写入失败时静默 — stderr 已作为兜底
    });

    // SQLite channel (secondary, fire-and-forget)
    try {
      this.insertToDb(entry);
    } catch {
      // SQLite 写入失败时降级到 stderr
      safeLog("warn", "Audit SQLite write failed", { id: entry.id });
    }

    // stderr channel (tertiary backup)
    safeLog("info", `AUDIT:${entry.action}`, {
      key_id: entry.auth.key_id,
      project: entry.request.project,
      status: entry.response.status,
      elapsed_ms: entry.response.elapsed_ms,
    });
  }
}
```

### 6.3 审计中间件

> **⚠️ 实施偏差说明 (2026-03-04 回写)**: 未创建独立的 `src/api/audit-middleware.ts`。审计中间件以内联方式实现在 `src/api/server.ts` 的 `/api/*` 路由中间件中，原因是审计逻辑与路由上下文紧密耦合（需要读取 auth context、response status 等），独立文件会增加不必要的参数传递。

```typescript
// src/api/server.ts — 内联审计中间件 (实际实现)

// 在 /api/* 路由中间件链中：
app.use("/api/*", async (c, next) => {
  // 跳过 admin 路由（admin 路由有独立的审计逻辑）
  if (c.req.path.startsWith("/api/admin")) {
    await next();
    return;
  }

  // ① 请求到达: 提取 project (clone body 避免消耗原始流)
  let project = config.defaultProject;
  try {
    if (c.req.method === "POST") {
      const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
      if (body?.project && typeof body.project === "string") {
        project = body.project;
      }
    }
  } catch {
    /* 非 JSON 或无 body → 使用默认值 */
  }

  // ② 计时 + 执行 handler
  const start = Date.now();
  try {
    await next();
  } finally {
    // ③ 请求完成: 构建审计条目 + 双写
    try {
      const keyRecord = c.get("apiKeyRecord");
      const keyPrefix =
        keyRecord?.id ?? extractKeyPrefix(c.req.header("Authorization"));
      const elapsed = Date.now() - start;

      const entry = container.audit.buildEntry({
        operation: pathToOperation(c.req.path),
        project,
        key_prefix: keyPrefix,
        client_ip: getClientIp(c, config.trustProxy),
        user_agent: c.req.header("User-Agent") ?? "unknown",
        http_method: c.req.method,
        http_path: c.req.path,
        http_status: c.res.status,
        elapsed_ms: elapsed,
        outcome: c.res.status < 400 ? "success" : "error",
      });

      // 双写: JSONL (AuditService) + SQLite (AnalyticsService)
      container.audit.record(entry); // 缓冲异步写入 JSONL
      container.analytics.ingestEvent(entry); // 同步写入 SQLite
    } catch {
      // Fire-and-forget: 审计失败绝不阻塞业务响应
    }
  }
});
```

> **关键设计决策**:
>
> - `try { await next() } finally { audit }` 模式确保即使 handler 抛异常也会记录审计
> - Clone request body 避免消耗原始 body stream (handler 需要再次读取)
> - `c.res.status` 在 `finally` 中始终可读（即使异常被 globalErrorHandler 捕获并设置了 500）
> - 双写策略: JSONL (持久化，可恢复) + SQLite (实时查询，可聚合)

### 6.4 Search 命中率追踪

```typescript
/**
 * 搜索命中率计算方法:
 *
 * hit_rate_score = (results_count > 0 && top_score >= threshold) ? 1.0 : 0.0
 *
 * 聚合方式:
 * - 小时命中率 = sum(hit_rate_score) / total_searches_in_hour
 * - 日命中率 = sum(hit_rate_score) / total_searches_in_day
 *
 * 阈值策略:
 * - 默认阈值 0.65 (与 CORE_SCHEMA 中的 THRESHOLDS.SIMILARITY_FLOOR 一致)
 * - 用户自定义 threshold 时使用用户值
 *
 * 存储:
 * - 每次 search 的 results_count 和 top_score 记入审计日志
 * - Analytics 聚合器按小时/日 rollup 计算命中率
 */
```

---

## 七、用量分析与运维看板

### 7.1 分析聚合器

```typescript
// src/services/analytics.ts

/**
 * 用量分析聚合器 — 从审计日志 SQLite 表中定期计算统计指标。
 *
 * 聚合策略:
 * - 每 5 分钟执行一次增量聚合 (setInterval)
 * - 聚合结果写入 analytics_hourly / analytics_daily 表
 * - Admin API 从聚合表读取 (不实时扫描原始审计日志)
 *
 * 聚合维度:
 * - 时间: 小时 / 日
 * - 用户: key_prefix
 * - 项目: project
 * - 操作: action
 */
export class AnalyticsAggregator {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = 300_000): void {
    this.timer = setInterval(() => this.aggregate(), intervalMs);
    // 立即执行一次
    this.aggregate();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private aggregate(): void {
    // 小时聚合
    this.aggregateHourly();
    // 清理 >90 天的原始审计日志
    this.pruneOldLogs(90);
  }
}
```

### 7.2 核心指标定义

| 指标             | 计算方式                              | 维度                         | 用途         |
| ---------------- | ------------------------------------- | ---------------------------- | ------------ |
| **请求量**       | COUNT(\*)                             | 小时/日 × 用户 × 项目 × 操作 | 基础用量统计 |
| **搜索命中率**   | AVG(hit_rate_score)                   | 小时/日 × 项目               | 检索质量评估 |
| **平均延迟**     | AVG(elapsed_ms)                       | 小时/日 × 操作               | 性能监控     |
| **P95 延迟**     | PERCENTILE(elapsed_ms, 0.95)          | 日 × 操作                    | 性能异常检测 |
| **错误率**       | COUNT(status>=400) / COUNT(\*)        | 小时/日 × 用户               | 异常用户检测 |
| **存储增长**     | SUM(save成功)                         | 日 × 项目                    | 容量规划     |
| **限流触发次数** | COUNT(rate_limit.\*)                  | 小时 × 用户                  | 限流策略调优 |
| **鉴权失败次数** | COUNT(auth.failure)                   | 小时 × IP                    | 暴力破解检测 |
| **活跃用户数**   | COUNT(DISTINCT key_id)                | 日                           | 使用趋势     |
| **去重命中率**   | COUNT(duplicate_merged) / COUNT(save) | 日 × 项目                    | 数据质量评估 |

### 7.3 SQLite 聚合表

```sql
-- 小时级聚合表
CREATE TABLE IF NOT EXISTS analytics_hourly (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hour_bucket     TEXT NOT NULL,          -- '2026-03-04T15:00:00Z'
  key_id          TEXT NOT NULL DEFAULT '', -- em_user_xxx 或 '' (全局)
  project         TEXT NOT NULL DEFAULT '', -- project 名或 '' (全局)
  action          TEXT NOT NULL,           -- 'memory.save' | 'memory.search' | ...

  request_count   INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,

  avg_elapsed_ms  REAL DEFAULT 0,
  max_elapsed_ms  INTEGER DEFAULT 0,

  -- search 专用
  search_count       INTEGER DEFAULT 0,
  search_hit_count   INTEGER DEFAULT 0,    -- top_score >= threshold 的搜索次数
  avg_top_score      REAL DEFAULT 0,
  avg_results_count  REAL DEFAULT 0,

  -- save 专用
  save_count           INTEGER DEFAULT 0,
  save_success_count   INTEGER DEFAULT 0,
  save_duplicate_count INTEGER DEFAULT 0,
  save_rejected_count  INTEGER DEFAULT 0,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(hour_bucket, key_id, project, action)
);

-- 日级聚合表 (从 hourly 二次聚合)
CREATE TABLE IF NOT EXISTS analytics_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  day_bucket      TEXT NOT NULL,           -- '2026-03-04'
  key_id          TEXT NOT NULL DEFAULT '',
  project         TEXT NOT NULL DEFAULT '',

  total_requests     INTEGER NOT NULL DEFAULT 0,
  total_saves        INTEGER NOT NULL DEFAULT 0,
  total_searches     INTEGER NOT NULL DEFAULT 0,
  total_forgets      INTEGER NOT NULL DEFAULT 0,

  search_hit_rate    REAL DEFAULT 0,       -- 搜索命中率
  avg_latency_ms     REAL DEFAULT 0,
  p95_latency_ms     INTEGER DEFAULT 0,
  error_rate         REAL DEFAULT 0,

  unique_projects    INTEGER DEFAULT 0,      -- 该用户当日操作的不同 project 数

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(day_bucket, key_id, project)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_hourly_bucket ON analytics_hourly(hour_bucket);
CREATE INDEX IF NOT EXISTS idx_hourly_key ON analytics_hourly(key_id);
CREATE INDEX IF NOT EXISTS idx_daily_bucket ON analytics_daily(day_bucket);
CREATE INDEX IF NOT EXISTS idx_daily_key ON analytics_daily(key_id);
```

---

## 八、Admin 管控 API

### 8.1 路由总表

| 方法         | 路径                              | 权限  | 描述                            |
| ------------ | --------------------------------- | ----- | ------------------------------- |
| **Key 管理** |                                   |       |                                 |
| `POST`       | `/admin/keys`                     | admin | 创建新 API Key                  |
| `GET`        | `/admin/keys`                     | admin | 列出所有 API Key（含使用统计）  |
| `GET`        | `/admin/keys/:keyPrefix`          | admin | 获取特定 Key 详情               |
| `PATCH`      | `/admin/keys/:keyPrefix`          | admin | 更新 Key 属性（标签/限流/配额） |
| `DELETE`     | `/admin/keys/:keyPrefix`          | admin | 吊销 Key（软删除，保留审计）    |
| `POST`       | `/admin/keys/:keyPrefix/rotate`   | admin | 轮换 Key（旧 Key 立即失效）     |
| `POST`       | `/admin/keys/:keyPrefix/ban`      | admin | 封禁 Key                        |
| `POST`       | `/admin/keys/:keyPrefix/unban`    | admin | 解封 Key                        |
| **IP 封禁**  |                                   |       |                                 |
| `POST`       | `/admin/bans/ip`                  | admin | 封禁 IP                         |
| `DELETE`     | `/admin/bans/ip/:ip`              | admin | 解封 IP                         |
| `GET`        | `/admin/bans/ip`                  | admin | 列出所有 IP 封禁                |
| **用量分析** |                                   |       |                                 |
| `GET`        | `/admin/analytics/overview`       | admin | 系统总览统计                    |
| `GET`        | `/admin/analytics/users`          | admin | 用户维度用量排行                |
| `GET`        | `/admin/analytics/projects`       | admin | 项目维度统计                    |
| `GET`        | `/admin/analytics/timeline`       | admin | 时间序列用量趋势                |
| `GET`        | `/admin/analytics/search-quality` | admin | 搜索质量分析                    |
| **审计日志** |                                   |       |                                 |
| `GET`        | `/admin/audit/logs`               | admin | 查询审计日志（分页/过滤）       |
| `GET`        | `/admin/audit/export`             | admin | 导出审计日志（JSONL/CSV）       |
| **系统**     |                                   |       |                                 |
| `GET`        | `/admin/system/config`            | admin | 查看当前运行时配置              |
| `PATCH`      | `/admin/system/config`            | admin | 修改运行时配置                  |

### 8.2 Key 管理 API 详情

#### 创建 Key

```
POST /admin/keys
Authorization: Bearer em_admin_xxx

Request:
{
  "label": "Alice-Cursor-Home",
  "role": "user",
  "allowed_projects": ["alice-project", "shared-team"],
  "rate_limit_per_minute": 30,
  "daily_quota": 1000,
  "expires_in_days": 90,
  "notes": "Alice 的 Cursor 本地环境"
}

Response: 201 Created
{
  "raw_key": "em_user_a1b2c3...64hex",    ← ⚠️ 仅此一次返回!
  "key_prefix": "em_user_a1b2",
  "label": "Alice-Cursor-Home",
  "role": "user",
  "allowed_projects": ["alice-project", "shared-team"],
  "rate_limit_per_minute": 30,
  "daily_quota": 1000,
  "expires_at": "2026-06-02T00:00:00.000Z",
  "created_at": "2026-03-04T12:00:00.000Z"
}
```

#### 列出全部 Key

```
GET /admin/keys?page=1&per_page=20&role=user&include_banned=false

Response: 200
{
  "keys": [
    {
      "key_prefix": "em_user_a1b2",
      "label": "Alice-Cursor-Home",
      "role": "user",
      "allowed_projects": ["alice-project"],
      "rate_limit_per_minute": 30,
      "daily_quota": 1000,
      "created_at": "2026-03-04T12:00:00Z",
      "expires_at": "2026-06-02T00:00:00Z",
      "last_used_at": "2026-03-04T15:30:00Z",
      "is_banned": false,
      "is_revoked": false,
      "usage_today": 42,
      "usage_total": 1523
    }
  ],
  "total": 5,
  "page": 1,
  "per_page": 20
}
```

#### 封禁 Key

```
POST /admin/keys/em_user_a1b2/ban
Authorization: Bearer em_admin_xxx

Request:
{
  "reason": "异常高频调用,疑似滥用"
}

Response: 200
{
  "status": "banned",
  "key_prefix": "em_user_a1b2",
  "reason": "异常高频调用,疑似滥用",
  "banned_at": "2026-03-04T12:00:00Z"
}
```

### 8.3 分析 API 详情

#### 系统总览

```
GET /admin/analytics/overview?period=7d

Response: 200
{
  "period": "7d",
  "summary": {
    "total_requests": 12345,
    "total_saves": 3456,
    "total_searches": 7890,
    "total_forgets": 123,
    "active_keys": 5,
    "active_projects": 8,
    "search_hit_rate": 0.78,
    "avg_latency_ms": 45.2,
    "p95_latency_ms": 120,
    "error_rate": 0.02,
    "storage_growth_points": 3200
  },
  "top_users": [
    { "key_id": "em_user_a1b2", "label": "Alice", "request_count": 5000 },
    { "key_id": "em_user_c3d4", "label": "Bob", "request_count": 3000 }
  ],
  "top_projects": [
    { "project": "main-app", "request_count": 8000 },
    { "project": "side-project", "request_count": 2000 }
  ]
}
```

#### 搜索质量分析

```
GET /admin/analytics/search-quality?period=30d&project=main-app

Response: 200
{
  "period": "30d",
  "project": "main-app",
  "overall_hit_rate": 0.82,
  "avg_results_count": 3.5,
  "avg_top_score": 0.76,
  "daily_trend": [
    { "date": "2026-03-04", "hit_rate": 0.85, "searches": 120 },
    { "date": "2026-03-03", "hit_rate": 0.79, "searches": 98 },
    ...
  ],
  "score_distribution": {
    "0.9+": 120,
    "0.8-0.9": 350,
    "0.7-0.8": 280,
    "0.65-0.7": 100,
    "<0.65 (miss)": 50
  }
}
```

#### 用量时间线

```
GET /admin/analytics/timeline?period=24h&interval=1h

Response: 200
{
  "period": "24h",
  "interval": "1h",
  "data_points": [
    {
      "bucket": "2026-03-04T14:00:00Z",
      "saves": 15,
      "searches": 42,
      "forgets": 2,
      "errors": 1,
      "avg_latency_ms": 38
    },
    ...
  ]
}
```

### 8.4 审计日志查询

```
GET /admin/audit/logs?since=2026-03-01&until=2026-03-04&key_id=em_user_a1b2&action=memory.save&page=1&per_page=50

Response: 200
{
  "logs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "ts": "2026-03-04T12:00:00Z",
      "action": "memory.save",
      "success": true,
      "auth": { "key_id": "em_user_a1b2", "label": "Alice", "role": "user" },
      "client": { "ip": "203.0.113.42", "user_agent": "cursor/1.0" },
      "request": { "method": "POST", "path": "/api/save", "project": "main-app" },
      "meta": {
        "memory_id": "uuid-xxx",
        "content_hash": "sha256-xxx",
        "content_preview": "这是一个关于 React 性能优化的...",
        "fact_type": "observation",
        "tags": ["react", "performance"],
        "save_status": "saved"
      },
      "response": { "status": 200, "elapsed_ms": 52 }
    }
  ],
  "total": 1234,
  "page": 1,
  "per_page": 50
}
```

### 8.5 审计日志导出

```
GET /admin/audit/export?since=2026-03-01&format=jsonl
  → Content-Type: application/x-ndjson
  → Content-Disposition: attachment; filename="audit-2026-03-01-to-2026-03-04.jsonl"

GET /admin/audit/export?since=2026-03-01&format=csv
  → Content-Type: text/csv
  → Content-Disposition: attachment; filename="audit-2026-03-01-to-2026-03-04.csv"
```

### 8.6 运行时配置管理

```typescript
/**
 * 可运行时修改的配置项（不需要重启服务）:
 *
 * 1. rate_limit_per_minute - 全局速率限制
 * 2. gemini_max_per_hour - Gemini 小时预算
 * 3. gemini_max_per_day - Gemini 日预算
 * 4. default_key_rate_limit - 新 Key 默认速率
 * 5. default_key_daily_quota - 新 Key 默认日配额
 *
 * 不可运行时修改（需重启）:
 * - EMBEDDING_PROVIDER, QDRANT_URL, OLLAMA_BASE_URL 等基础设施配置
 * - HTTP_HOST, HTTP_PORT 等网络配置
 *
 * 持久化策略:
 * - 修改立即写入 SQLite config 表
 * - 重启时从 SQLite 读取 override 值覆盖环境变量默认
 */
```

```
PATCH /admin/system/config
Authorization: Bearer em_admin_xxx

Request:
{
  "rate_limit_per_minute": 120,
  "default_key_daily_quota": 2000
}

Response: 200
{
  "updated": {
    "rate_limit_per_minute": { "old": 60, "new": 120 },
    "default_key_daily_quota": { "old": 1000, "new": 2000 }
  },
  "reboot_required": false
}
```

---

## 九、向后兼容与迁移策略

### 9.1 三种运行模式

```
启动时判定鉴权模式:

  HTTP_AUTH_TOKEN 是否设置?
         │
    ┌────┴────┐
   Yes       No
    │         │
    ▼         ▼
  SQLite 中  无鉴权模式
  有 API Key? (dev mode)
    │
 ┌──┴──┐
 Yes   No
  │     │
  ▼     ▼
Dual  Legacy
Mode  Mode

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Legacy Mode (100% 向后兼容):
  - HTTP_AUTH_TOKEN 设置 + SQLite 无 Key
  - 所有请求用 HTTP_AUTH_TOKEN 验证
  - legacy token 视为 admin 角色
  - 可通过 POST /admin/keys 创建第一个 API Key (bootstrap)

Dual Mode (过渡期):
  - HTTP_AUTH_TOKEN 仍然有效 (admin 权限)
  - 同时接受 em_* API Key 请求
  - 审计日志标记 auth_mode='legacy_token' vs 'api_key'

API Key Only Mode (最终态):
  - 删除 HTTP_AUTH_TOKEN 环境变量
  - 仅 API Key 可鉴权
```

### 9.2 MCP stdio 模式

```typescript
/**
 * MCP stdio 模式完全不受影响:
 *
 * - stdio 是进程级 IPC，物理上不可能跨网络连接 [ADR-SHELL-10]
 * - 不经过任何 HTTP 中间件
 * - 无需鉴权 (本地进程天然可信)
 * - Auth/Admin/Audit 层仅在 HTTP shell (src/api/) 中激活
 * - MCP 模式下 SQLite 不初始化 (零开销)
 */
```

### 9.3 Bootstrap 流程

```
1. 首次部署 VPS
2. 设置 HTTP_AUTH_TOKEN 环境变量 (legacy mode)
3. 通过 legacy token 调用 POST /admin/keys 创建 admin Key
4. 分发 user/readonly Key 给不同用户
5. (可选) 删除 HTTP_AUTH_TOKEN，进入 API Key Only 模式
```

---

## 十、安全威胁模型与防御矩阵

### 10.1 攻击向量与防御

| #   | 攻击向量                         | 风险等级 | 防御措施                                                            | 层级     |
| --- | -------------------------------- | -------- | ------------------------------------------------------------------- | -------- |
| A1  | **暴力破解 API Key**             | 高       | timing-safe 比较 + 全局限流 + auth.failure 审计 + 可选自动 IP ban   | L2+L3    |
| A2  | **API Key 泄露**                 | 高       | SHA-256 哈希存储 + Key 轮换 + 即时吊销 + 过期机制                   | L3       |
| A3  | **X-Forwarded-For 伪造**         | 中       | 优先 X-Real-IP + TRUST_PROXY 控制 + Nginx 覆盖(非追加) XFF          | L1       |
| A4  | **SQLite 文件泄露**              | 中       | Key 仅存 SHA-256 hash + Docker volume 权限 600 + 不含原始 Key       | 存储     |
| A5  | **横向越权 (跨 project)**        | 高       | allowed_projects 约束 + 每次请求强制检查                            | L5       |
| A6  | **审计日志篡改**                 | 低       | JSONL append-only + SQLite WAL + 文件权限 644                       | 审计     |
| A7  | **DDoS 资源耗尽**                | 中       | 三层限流 (全局+Per-Key+日配额) + IP ban + Nginx 前端限流            | L1+L2+L4 |
| A8  | **时序侧信道**                   | 低       | timing-safe 比较(已实现) + SHA-256 固定时间                         | L3       |
| A9  | **Replay Attack**                | 低       | TLS 强制 + HSTS + token 不含时间戳(无法 replay 过期)                | L0       |
| A10 | **Admin API 滥用**               | 中       | Admin 操作自身也写审计日志 + admin Key 独立                         | L5+审计  |
| A11 | **Prompt Injection via content** | 高       | 已有防护(basicSanitize + boundary markers + injection detect)       | 业务层   |
| A12 | **日志中敏感信息泄露**           | 中       | content 仅记录 preview+hash / Key 仅记录 prefix / query 仅记录 hash | 审计     |

### 10.2 安全配置清单

```yaml
# .env.example 安全配置参考

# ===== 必须设置 =====
HTTP_AUTH_TOKEN=<strong-random-token>     # 至少 32 字符
QDRANT_API_KEY=<strong-random-key>

# ===== 网络安全 =====
HTTP_HOST=127.0.0.1                       # 绑定本地, Nginx 反代
TRUST_PROXY=true                          # 信任 Nginx X-Real-IP
REQUIRE_TLS=true                          # 强制 HTTPS

# ===== 限流 =====
RATE_LIMIT_PER_MINUTE=60                  # 全局 RPM
DEFAULT_KEY_RATE_LIMIT=30                 # 新 Key 默认 RPM
DEFAULT_KEY_DAILY_QUOTA=1000              # 新 Key 默认日配额

# ===== 数据持久化 =====
SQLITE_DB_PATH=/data/easy-memory.db       # Docker volume 挂载
AUDIT_LOG_PATH=/data/audit.jsonl          # Docker volume 挂载
```

---

## 十一、存储层设计 — SQLite Schema

### 11.1 为什么选 SQLite

| 对比项     | SQLite               | Redis               | PostgreSQL       |
| ---------- | -------------------- | ------------------- | ---------------- |
| 新增依赖   | better-sqlite3 (npm) | redis 容器          | postgres 容器    |
| 运维复杂度 | 零 (单文件)          | 需要 Docker 容器    | 需要 Docker 容器 |
| 类SQL查询  | ✅ 完整 SQL          | ❌ 有限             | ✅ 完整 SQL      |
| 持久化     | 自动 (文件)          | 需配置 RDB/AOF      | 自动             |
| 性能 (读)  | ~50μs/query          | ~200μs/query (网络) | ~500μs/query     |
| 性能 (写)  | ~100μs (WAL)         | ~200μs              | ~1ms             |
| 并发读     | ✅ WAL 模式          | ✅ 天然             | ✅ MVCC          |
| 适合规模   | 单机, <100GB         | 分布式              | 分布式           |

**结论**: 单机 VPS 部署，SQLite 的零依赖 + 同步 API + SQL 查询能力完美匹配需求。

### 11.2 完整 Schema

```sql
-- ===== 数据库初始化 =====
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ===== API Keys =====
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash             TEXT PRIMARY KEY,     -- SHA-256(raw_key)
  key_prefix           TEXT NOT NULL UNIQUE, -- 前 12 字符, 用于展示/查询
  label                TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK(role IN ('admin', 'user', 'readonly')),
  allowed_projects     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  rate_limit_per_minute INTEGER,             -- NULL = 使用全局默认
  daily_quota          INTEGER,              -- NULL = 无限制
  created_at           TEXT NOT NULL,
  expires_at           TEXT,                 -- NULL = 永不过期
  last_used_at         TEXT,
  is_banned            INTEGER NOT NULL DEFAULT 0,
  ban_reason           TEXT,
  banned_at            TEXT,
  is_revoked           INTEGER NOT NULL DEFAULT 0,
  revoked_at           TEXT,
  notes                TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_keys_role ON api_keys(role);

-- ===== IP Bans =====
CREATE TABLE IF NOT EXISTS ip_bans (
  ip                   TEXT PRIMARY KEY,     -- IPv4/IPv6 或 CIDR
  reason               TEXT NOT NULL,
  banned_at            TEXT NOT NULL,
  expires_at           TEXT,                 -- NULL = 永久
  banned_by            TEXT NOT NULL          -- admin key_prefix
);

-- ===== Audit Logs =====
CREATE TABLE IF NOT EXISTS audit_logs (
  id                   TEXT PRIMARY KEY,     -- UUID v4
  ts                   TEXT NOT NULL,        -- ISO 8601
  action               TEXT NOT NULL,
  success              INTEGER NOT NULL,     -- 0/1

  -- 鉴权上下文
  auth_mode            TEXT NOT NULL,
  auth_key_id          TEXT NOT NULL DEFAULT '',
  auth_label           TEXT NOT NULL DEFAULT '',
  auth_role            TEXT NOT NULL DEFAULT '',

  -- 客户端
  client_ip            TEXT NOT NULL DEFAULT '',
  client_user_agent    TEXT NOT NULL DEFAULT '',

  -- 请求
  req_method           TEXT NOT NULL,
  req_path             TEXT NOT NULL,
  req_project          TEXT DEFAULT '',

  -- 响应
  res_status           INTEGER NOT NULL,
  res_elapsed_ms       INTEGER NOT NULL,

  -- 操作元数据 (JSON)
  meta                 TEXT DEFAULT '{}'     -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_key ON audit_logs(auth_key_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(req_project);

-- ===== Analytics (Hourly) =====
CREATE TABLE IF NOT EXISTS analytics_hourly (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  hour_bucket          TEXT NOT NULL,        -- '2026-03-04T15:00:00Z'
  key_id               TEXT NOT NULL DEFAULT '',
  project              TEXT NOT NULL DEFAULT '',
  action               TEXT NOT NULL,

  request_count        INTEGER NOT NULL DEFAULT 0,
  success_count        INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,

  avg_elapsed_ms       REAL DEFAULT 0,
  max_elapsed_ms       INTEGER DEFAULT 0,

  -- search 专用
  search_count         INTEGER DEFAULT 0,
  search_hit_count     INTEGER DEFAULT 0,
  avg_top_score        REAL DEFAULT 0,
  avg_results_count    REAL DEFAULT 0,

  -- save 专用
  save_count           INTEGER DEFAULT 0,
  save_success_count   INTEGER DEFAULT 0,
  save_duplicate_count INTEGER DEFAULT 0,
  save_rejected_count  INTEGER DEFAULT 0,

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(hour_bucket, key_id, project, action)
);

CREATE INDEX IF NOT EXISTS idx_hourly_bucket ON analytics_hourly(hour_bucket);
CREATE INDEX IF NOT EXISTS idx_hourly_key ON analytics_hourly(key_id);

-- ===== Analytics (Daily) =====
CREATE TABLE IF NOT EXISTS analytics_daily (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  day_bucket           TEXT NOT NULL,
  key_id               TEXT NOT NULL DEFAULT '',
  project              TEXT NOT NULL DEFAULT '',

  total_requests       INTEGER NOT NULL DEFAULT 0,
  total_saves          INTEGER NOT NULL DEFAULT 0,
  total_searches       INTEGER NOT NULL DEFAULT 0,
  total_forgets        INTEGER NOT NULL DEFAULT 0,

  search_hit_rate      REAL DEFAULT 0,
  avg_latency_ms       REAL DEFAULT 0,
  p95_latency_ms       INTEGER DEFAULT 0,
  error_rate           REAL DEFAULT 0,
  unique_projects      INTEGER DEFAULT 0,

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(day_bucket, key_id, project)
);

CREATE INDEX IF NOT EXISTS idx_daily_bucket ON analytics_daily(day_bucket);
CREATE INDEX IF NOT EXISTS idx_daily_key ON analytics_daily(key_id);

-- ===== Runtime Config Overrides =====
CREATE TABLE IF NOT EXISTS config_overrides (
  key                  TEXT PRIMARY KEY,
  value                TEXT NOT NULL,        -- JSON 值
  updated_at           TEXT NOT NULL,
  updated_by           TEXT NOT NULL          -- admin key_prefix
);
```

### 11.3 SQLite 服务封装

```typescript
// src/services/sqlite.ts

import Database from "better-sqlite3";
import { log } from "../utils/logger.js";

/**
 * SQLite 管理服务 — 统一管理数据库连接、Schema 迁移、WAL 配置。
 *
 * 设计决策:
 * - 使用 better-sqlite3 (同步 API) — 避免异步竞态、性能最优
 * - WAL 模式 — 允许并发读写
 * - 单文件 — 通过 Docker volume 持久化
 * - Schema 版本管理 — 启动时自动迁移
 *
 * 铁律: 绝对禁止在 MCP stdio 模式下初始化 SQLite
 * (MCP 模式无需鉴权/审计，避免不必要的文件 IO)
 */
export class SqliteManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.runMigrations();
    log.info("SQLite initialized", { path: dbPath });
  }

  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
    log.info("SQLite closed");
  }

  private runMigrations(): void {
    // 执行上述 CREATE TABLE IF NOT EXISTS ...
    // 使用事务保证原子性
  }
}
```

---

## 十二、部署与运维

### 12.1 Docker volume 持久化

```yaml
# docker-compose.prod.yml 新增
services:
  easy-memory:
    volumes:
      - easy-memory-data:/data # SQLite + 审计日志
    environment:
      - SQLITE_DB_PATH=/data/easy-memory.db
      - AUDIT_LOG_PATH=/data/audit.jsonl

volumes:
  easy-memory-data:
    driver: local
```

### 12.2 日志轮转

```bash
# /etc/logrotate.d/easy-memory-audit (VPS 配置)

/data/audit.jsonl {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
    create 0644 node node
    copytruncate       # 不中断写入
}
```

### 12.3 备份策略

```bash
# SQLite 在线备份 (不阻塞写入)
sqlite3 /data/easy-memory.db ".backup '/backup/easy-memory-$(date +%Y%m%d).db'"

# 自动化: crontab 每日 02:00 UTC 备份
0 2 * * * sqlite3 /data/easy-memory.db ".backup '/backup/easy-memory-$(date +\%Y\%m\%d).db'" && find /backup -name 'easy-memory-*.db' -mtime +30 -delete
```

### 12.4 监控告警 (可选)

```typescript
/**
 * 可接入的监控方案 (Phase 2+):
 *
 * 1. Prometheus Metrics Endpoint (/metrics)
 *    - easy_memory_requests_total{action,status}
 *    - easy_memory_request_duration_seconds{action}
 *    - easy_memory_active_keys
 *    - easy_memory_search_hit_rate
 *    - easy_memory_rate_limit_hits_total
 *
 * 2. 告警规则
 *    - search_hit_rate < 0.5 持续 1h → 检索质量下降告警
 *    - error_rate > 0.1 持续 5m → 服务异常告警
 *    - auth.failure > 100/h → 暴力破解告警
 *    - daily_quota.exhausted → 配额耗尽通知
 */
```

---

## 十三、分阶段实施计划

### Phase 2A — 基础鉴权与审计 (MVP)

| #        | 任务                              | 依赖   | 工时估算 | 优先级 |
| -------- | --------------------------------- | ------ | -------- | ------ |
| 1        | SQLite 初始化 + Schema 迁移       | 无     | 2h       | P0     |
| 2        | API Key Store (CRUD + SHA-256)    | #1     | 4h       | P0     |
| 3        | 增强鉴权中间件 (Legacy + API Key) | #2     | 3h       | P0     |
| 4        | RBAC 授权中间件                   | #3     | 2h       | P0     |
| 5        | 统一审计日志服务 (JSONL + SQLite) | #1     | 3h       | P0     |
| 6        | 审计中间件 (自动采集)             | #5     | 2h       | P0     |
| 7        | Admin Key 管理路由 (CRUD + ban)   | #2, #3 | 4h       | P0     |
| 8        | 单元测试 (全模块 TDD)             | #1-#7  | 6h       | P0     |
| **小计** |                                   |        | **26h**  |        |

### Phase 2B — 限流增强与 IP 封禁

| #        | 任务                    | 依赖   | 工时估算 | 优先级 |
| -------- | ----------------------- | ------ | -------- | ------ |
| 9        | Per-Key Rate Limiter    | #3     | 3h       | P1     |
| 10       | IP Ban Checker + 中间件 | #1     | 3h       | P1     |
| 11       | Admin IP Ban 路由       | #10    | 2h       | P1     |
| 12       | Client IP 提取工具      | 无     | 1h       | P1     |
| 13       | Rate Limit 响应头规范   | #9     | 1h       | P1     |
| 14       | 单元测试                | #9-#13 | 4h       | P1     |
| **小计** |                         |        | **14h**  |        |

### Phase 2C — 分析与管控

| #        | 任务                            | 依赖    | 工时估算 | 优先级 |
| -------- | ------------------------------- | ------- | -------- | ------ |
| 15       | Analytics 聚合器 (hourly/daily) | #5      | 4h       | P2     |
| 16       | Admin Analytics 路由            | #15     | 4h       | P2     |
| 17       | Admin 审计日志查询/导出         | #5      | 3h       | P2     |
| 18       | 运行时配置管理                  | #1      | 2h       | P2     |
| 19       | Search 命中率追踪               | #5, #15 | 2h       | P2     |
| 20       | E2E 集成测试                    | #1-#19  | 4h       | P2     |
| 21       | Docker volume 配置更新          | 无      | 1h       | P2     |
| **小计** |                                 |         | **20h**  |        |

### 总工时估算: ~60h (约 8 个工作日)

---

## 十四、设计决策日志 (ADR)

### ADR-AUDIT-01: SHA-256 vs bcrypt 用于 API Key 哈希

- **场景**: API Key 存储在 SQLite 中，需要防止数据库文件泄露导致 Key 被恢复
- **决策**: SHA-256 (而非 bcrypt/scrypt)
- **原因**: API Key 是 256-bit 高熵随机值（非人类密码），SHA-256 的原像攻击不可行；bcrypt 的 ~100ms 延迟在每请求认证的热路径上不可接受
- **风险**: SHA-256 对低熵输入（如人类密码）不安全 — 但 API Key 不是人类密码

### ADR-AUDIT-02: SQLite vs Redis vs PostgreSQL

- **场景**: Key 存储 + 审计日志 + 分析聚合的持久化方案选择
- **决策**: SQLite (better-sqlite3)
- **原因**: 单机部署零新增基础设施依赖；同步 API 避免异步竞态；SQL 查询能力满足分析需求；WAL 模式支持并发读写；单文件部署通过 Docker volume 持久化
- **权衡**: 不适合分布式场景 — 但 Easy Memory 定位是单机/自托管服务

### ADR-AUDIT-03: 审计日志双通道 (JSONL + SQLite)

- **场景**: 审计日志既需要实时 append 性能，又需要结构化查询能力
- **决策**: JSONL 文件为主存储（fire-and-forget append），SQLite 为查询通道（异步 best-effort）
- **原因**: JSONL 单行 < PIPE_BUF 保证原子写入；SQLite 提供 Admin API 查询能力；双通道互为备份
- **风险**: SQLite 写入失败时审计数据只在 JSONL 中 — 可接受（JSONL 是真正的 source of truth）

### ADR-AUDIT-04: Per-Key 限流用内存 Map 而非 SQLite

- **场景**: Per-Key 限流需要高频读写（每次请求）
- **决策**: 内存 Map + LRU 淘汰（上限 1000 entries）
- **原因**: 热路径 ~μs 级延迟要求；SQLite 即使同步也有 ~50μs 开销；LRU 防止内存无限增长
- **权衡**: 服务重启后限流状态丢失 — 可接受（限流是实时防护，不需要持久化）

### ADR-AUDIT-05: Admin API 与 User API 同端口不同路径

- **场景**: Admin API 是否需要独立端口/进程
- **决策**: 同端口 (`/admin/*` 路径前缀)
- **原因**: 减少部署复杂度；RBAC 中间件已提供足够的权限隔离；Nginx 可按路径匹配做额外 IP 限制
- **风险**: 如果 Web 框架存在路径穿越漏洞可能绕过 — 用 Hono 的路由分组机制消除此风险

### ADR-AUDIT-06: X-Real-IP 优先于 X-Forwarded-For

- **场景**: 从反向代理后提取真实客户端 IP
- **决策**: 优先 X-Real-IP，次选 XFF 最右侧 IP
- **原因**: X-Real-IP 是单值（由直连代理设置，不可伪造链）；XFF 是可追加的链（攻击者可在请求中预注入假 IP）

### ADR-AUDIT-07: content 审计仅 preview + hash

- **场景**: 审计日志中记录用户存储的内容信息
- **决策**: 仅记录 content 前 50 字符 preview + SHA-256 hash，绝不记录全文
- **原因**: 审计日志可能被更广泛地访问/导出；全文存储违反最小权限原则；hash 足以进行去重/追溯
- **权衡**: 无法从审计日志中恢复原始内容 — 这是 feature 不是 bug (内容在 Qdrant 中)

### ADR-AUDIT-08: 文件合并策略 — "就近合并" 优于 "一功能一文件" (2026-03-04)

- **场景**: 白皮书原规划为 Phase 2 新增 6 个独立文件 (`auth-middleware.ts`, `audit-middleware.ts`, `authorization.ts`, `per-key-rate-limiter.ts`, `client-ip.ts`, `auth.ts`)
- **决策**: 将功能合并进已有模块，最终仅新增 2 个文件 (`ip.ts`, `admin-auth.ts`)，其余逻辑融入 `middlewares.ts`, `server.ts`, `rate-limiter.ts`
- **原因**:
  - 减少文件碎片化：6 个小文件（各 30-60 行）增加导航成本，不如合并进功能相近的已有模块
  - 降低参数传递开销：审计中间件需要读取 auth context、response status、container 实例等，独立文件需要传递 5+ 个参数
  - Per-key 限流与全局限流共享时间窗口逻辑，独立类会导致状态分裂
- **权衡**: 单个文件行数增加（`server.ts` +231 行, `middlewares.ts` +127 行），但通过清晰的注释和函数分段保持可读性
- **合并映射**:
  - `auth-middleware.ts` → `middlewares.ts::bearerAuth(config: BearerAuthConfig)`
  - `audit-middleware.ts` → `server.ts` 内联 `/api/*` 中间件
  - `per-key-rate-limiter.ts` → `rate-limiter.ts::checkPerKeyRate()`
  - `client-ip.ts` → `ip.ts::getClientIp()`
  - `authorization.ts` → `bearerAuth` 内联权限检查
  - `auth.ts` (types) → `admin-schema.ts` + Hono Context 类型扩展

### ADR-AUDIT-09: P7-FIX — Per-Key 限流 catch 收窄 (2026-03-04)

- **场景**: `bearerAuth` 中间件内的 `checkPerKeyRate()` 调用使用 `catch {}` 捕获所有异常
- **问题**: 如果 `checkPerKeyRate()` 内部出现非限流 bug（如 TypeError），异常被吞没并 **错误地** 返回 429 → 掩盖了真实 bug
- **决策**: 收窄 catch 条件，仅捕获 `err.message.includes("Rate limit exceeded")` 的异常，其他异常重新 throw 由 `globalErrorHandler` 处理
- **代码**:
  ```typescript
  try {
    rateLimiter.checkPerKeyRate(keyHash, limit);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Rate limit exceeded")) {
      return c.json({ error: "Too many requests" }, 429);
    }
    throw err; // 非限流异常 → 上抛
  }
  ```
- **风险等级**: Medium → 修复后降为 Low

### ADR-AUDIT-10: P8-FIX — 关闭序列容错 (2026-03-04)

- **场景**: 服务器关闭时按序调用 `audit.close()`, `analytics.close()`, `apiKeyManager.close()`, `banManager.close()`
- **问题**: 如果 `audit.close()` 的 flush 操作失败（如磁盘满），未被捕获的异常会阻止后续 3 个服务的 `close()` 调用 → 可能导致 SQLite 数据库锁泄漏
- **决策**: 每个 `close()` 调用包裹在独立的 `try-catch` 中，失败仅记录 stderr 日志，不阻塞后续关闭
- **代码**:
  ```typescript
  // ✅ 修复后
  try {
    await container.audit.close();
  } catch (e) {
    log.error("audit close failed", e);
  }
  try {
    container.analytics.close();
  } catch (e) {
    log.error("analytics close failed", e);
  }
  try {
    container.apiKeyManager.close();
  } catch (e) {
    log.error("apikey close failed", e);
  }
  try {
    container.banManager.close();
  } catch (e) {
    log.error("ban close failed", e);
  }
  ```
- **风险等级**: High → 修复后降为 Low

---

## 附录 A: 新增环境变量参考

| 变量名                    | 默认值                       | 描述                         |
| ------------------------- | ---------------------------- | ---------------------------- |
| `SQLITE_DB_PATH`          | `~/.easy-memory.db`          | SQLite 数据库文件路径        |
| `AUDIT_LOG_PATH`          | `~/.easy-memory-audit.jsonl` | 审计 JSONL 日志路径 (已存在) |
| `DEFAULT_KEY_RATE_LIMIT`  | `30`                         | 新 Key 默认 RPM              |
| `DEFAULT_KEY_DAILY_QUOTA` | `1000`                       | 新 Key 默认日配额            |
| `ANALYTICS_INTERVAL_MS`   | `300000`                     | 分析聚合间隔 (5分钟)         |
| `AUDIT_RETENTION_DAYS`    | `90`                         | 审计日志保留天数             |
| `MAX_PER_KEY_ENTRIES`     | `1000`                       | Per-Key 限流器 LRU 上限      |

## 附录 B: 新增依赖

| 包名                    | 版本    | 用途                | 生产/开发 |
| ----------------------- | ------- | ------------------- | --------- |
| `better-sqlite3`        | `^11.x` | SQLite 同步 API     | 生产      |
| `@types/better-sqlite3` | `^7.x`  | TypeScript 类型定义 | 开发      |

## 附录 C: 现有系统影响评估

> **2026-03-04 回写**: 以下为实际实施后的影响评估（Phase 2 全部完成）

| 组件                        | 实际影响                                                         | 状态            |
| --------------------------- | ---------------------------------------------------------------- | --------------- |
| `src/api/server.ts`         | +231 行: 内联审计中间件 + Ban 检查 + 增强中间件链 + 容错关闭序列 | ✅ 已修改       |
| `src/api/middlewares.ts`    | +127 行: bearerAuth(config) 双层鉴权 + bearerAuthSimple 保留     | ✅ 已修改       |
| `src/container.ts`          | +64 行: 新增 Phase 2 服务实例化 + 关闭生命周期                   | ✅ 已修改       |
| `src/utils/rate-limiter.ts` | +66 行: 新增 checkPerKeyRate() 方法                              | ✅ 已修改       |
| `src/mcp/server.ts`         | +23 行: MCP 模式适配                                             | ✅ 已修改       |
| `src/tools/save.ts`         | 审计迁移到统一中间件（移除独立 writeAuditLog）                   | ✅ 无需直接修改 |
| `src/tools/forget.ts`       | 同上                                                             | ✅ 无需直接修改 |
| `src/tools/search.ts`       | 搜索元数据由审计中间件自动采集                                   | ✅ 无需直接修改 |
| MCP stdio 模式              | **绝对不受影响** — 物理隔离                                      | ✅ 无变更       |
| Qdrant / Embedding / BM25   | **不受影响**                                                     | ✅ 无变更       |
| 测试覆盖                    | 30 文件, 786 个测试用例全部通过 (v1.1 更新)                      | ✅ 已验证       |

---

> **本白皮书为 Easy Memory Phase 2 的架构基石文档。所有实施工作以本文档为准，偏差已通过 ADR-AUDIT-08/09/10/11/12 记录。Phase 2 于 2026-03-04 全部完成实施。**

### ADR-AUDIT-11: mapPathToOperation() 返回值与 SQL 查询不匹配 (2026-03-05 回写)

- **场景**: 审计中间件的 `mapPathToOperation()` 返回操作名，AnalyticsService 的 SQL 聚合/查询硬编码操作名
- **问题**: `mapPathToOperation()` 原返回 `"save"`, `"search"`, `"forget"`, `"status"`，但 `analytics.ts` 的所有 SQL 查询 (hit rate, user usage, project usage, hourly rollup) 硬编码 `'memory_search'`, `'memory_save'` 等。导致 HTTP 模式产生的审计事件**永远无法被聚合查询命中** — 所有分析端点返回零值
- **根因**: 命名约定在两个模块间未对齐 — server.ts 使用路由简称，analytics.ts 使用 MCP 工具全名
- **决策**: 修复 `mapPathToOperation()` 返回 `"memory_save"` / `"memory_search"` / `"memory_forget"` / `"memory_status"`，与 SQL 查询和 MCP 工具名对齐
- **影响**: 修复前所有 HTTP 模式的分析数据静默丢失（数据存在于 SQLite 但聚合查询读不到）
- **风险等级**: Critical → 修复后降为 None

### ADR-AUDIT-12: Hono c.text() 覆盖自定义 Content-Type (2026-03-05 回写)

- **场景**: Admin API 的审计日志导出端点需要返回 `text/csv` 或 `application/x-ndjson` Content-Type
- **问题**: admin-routes.ts 先通过 `c.header('Content-Type', '...')` 设置自定义 MIME 类型，然后调用 `c.text(body)` 返回响应。但 Hono 的 `c.text()` 会**强制覆盖** Content-Type 为 `text/plain; charset=UTF-8`，导致浏览器/客户端无法识别 CSV/JSONL 文件类型
- **决策**: 将 `c.text(body)` 替换为 `c.body(body)`，`c.body()` 不会覆盖已设置的 header
- **影响**: 3 处修复 (CSV 主导出、JSONL 导出、CSV legacy 导出)
- **风险等级**: Medium → 修复后降为 None

---

## 附录 D: SQL Schema 实施偏差说明

> **⚠️ 2026-03-05 回写**: 本白皮书 §7.3 和 §11.2 中描述的 SQL Schema 为规划阶段设计，实际实施中进行了简化优化。以下为关键差异：

| 白皮书规划 | 实际实现 | 原因 |
|-----------|---------|------|
| `analytics_hourly` 表 | `analytics_rollups` 表 (含 `period` 列区分 hourly/daily) | 单表多 period 比双表更易维护，更灵活 |
| `analytics_daily` 表 | 同上 (`period='daily'` 行) | 合并入 rollups |
| `audit_logs` 表 | `audit_events` 表 | 命名更精准（"事件" vs "日志"） |
| `config_overrides` 表 | `runtime_config` 表 | 命名更直观 |
| 无 | `import_cursor` 表 | 新增：JSONL 增量导入进度追踪（cursor-based） |
| `auth_mode` / `auth_key_id` / `auth_label` / `auth_role` 列 | `key_prefix` 列 | 简化鉴权上下文存储 |
| `req_method` / `req_path` / `req_project` 列 | `operation` / `project` / `http_method` / `http_path` 列 | 更贴合查询维度 |
| `meta` JSON blob | `metadata` JSON blob | 字段重命名 |
