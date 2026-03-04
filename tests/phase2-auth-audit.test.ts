/**
 * @module e2e-phase2-auth-audit
 * @description Phase 2 全量集成测试 — 鉴权·审计·管控体系端到端验证。
 *
 * 覆盖 7 项修复:
 * 1. 审计中间件 (AuditService.record + AnalyticsService.ingestEvent 双写)
 * 2. 双层鉴权 (Master Token + Managed API Key)
 * 3. Per-Key 限流 (RateLimiter.checkPerKeyRate)
 * 4. 共享 IP 提取 (getClientIp)
 * 5. BanManager 资源泄漏修复 (ownsDb)
 * 6. SQLite DB 共享连接 (ApiKeyManager → BanManager)
 * 7. RuntimeConfig onChange 联动
 *
 * 运行方式:
 *   pnpm vitest run tests/e2e-phase2-auth-audit.test.ts
 *
 * 依赖: 无需外部 Docker 服务 (Qdrant/Ollama 全 mock)。
 * 使用真实 SQLite (tmp) + 真实 RateLimiter + 真实 AuditService。
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../src/api/server.js";
import type { AppContainer } from "../src/container.js";
import type { AppConfig } from "../src/container.js";
import { ApiKeyManager } from "../src/services/api-key-manager.js";
import { BanManager } from "../src/services/ban-manager.js";
import { RateLimiter } from "../src/utils/rate-limiter.js";
import { RuntimeConfigManager } from "../src/services/runtime-config.js";
import { AuditService } from "../src/services/audit.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// =========================================================================
// Test Infrastructure — 真实服务 + Mock 外壳
// =========================================================================

const MASTER_TOKEN = "test-master-token-secure-32chars";
const ADMIN_TOKEN = "test-admin-token-for-management";

/** 临时目录 — 用于 SQLite DB 和 JSONL 审计日志 */
let tmpDir: string;

/** Real services */
let apiKeyManager: ApiKeyManager;
let banManager: BanManager;
let rateLimiter: RateLimiter;
let runtimeConfig: RuntimeConfigManager;
let auditService: AuditService;

/** Spy targets */
let auditRecordSpy: ReturnType<typeof vi.spyOn>;
let auditBuildEntrySpy: ReturnType<typeof vi.spyOn>;
let analyticsIngestSpy: ReturnType<typeof vi.fn>;

// =========================================================================
// Container Factory — 真实鉴权/审计/管控 + Mock 存储层
// =========================================================================

function buildContainer(overrides: Partial<AppConfig> = {}): AppContainer {
  const config: AppConfig = {
    qdrantUrl: "http://localhost:6333",
    qdrantApiKey: "test-key",
    embeddingProvider: "ollama",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    geminiApiKey: "",
    geminiProjectId: "",
    geminiRegion: "us-central1",
    geminiModel: "gemini-embedding-001",
    defaultProject: "test-project",
    ollamaTimeoutMs: 10_000,
    rateLimitPerMinute: 60,
    geminiMaxPerHour: 200,
    geminiMaxPerDay: 2000,
    mode: "http",
    httpPort: 3080,
    httpAuthToken: MASTER_TOKEN,
    httpHost: "127.0.0.1",
    trustProxy: true,
    requireTls: false,
    adminToken: ADMIN_TOKEN,
    ...overrides,
  };

  const analytics = {
    isReady: true,
    ingestEvent: analyticsIngestSpy,
    recordEvent: vi.fn(),
    queryEvents: vi.fn().mockReturnValue({
      data: [],
      pagination: { page: 1, page_size: 50, total_count: 0, total_pages: 0 },
    }),
    queryRollups: vi.fn().mockReturnValue([]),
    exportEvents: vi.fn().mockReturnValue([]),
    getUserUsage: vi.fn().mockReturnValue([]),
    getProjectUsage: vi.fn().mockReturnValue([]),
    getErrorRate: vi.fn().mockReturnValue({
      total_requests: 0,
      error_count: 0,
      error_rate: 0,
      rate_limited_count: 0,
      rejected_count: 0,
    }),
    getHitRate: vi.fn().mockReturnValue({
      total_searches: 0,
      hit_count: 0,
      miss_count: 0,
      hit_rate: 0,
    }),
    runAggregation: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(),
    close: vi.fn(),
  } as any;

  return {
    config,
    qdrant: {
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({
        name: "em_test-project",
        points_count: 42,
      }),
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue("em_test-project"),
      upsert: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      hybridSearch: vi.fn().mockResolvedValue([]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    } as any,
    embedding: {
      embed: vi.fn().mockResolvedValue(new Array(1024).fill(0)),
      embedWithMeta: vi.fn().mockResolvedValue({
        vector: new Array(1024).fill(0),
        model: "bge-m3",
        provider: "ollama",
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
      modelName: "bge-m3",
      primaryProvider: "ollama",
      providerNames: ["ollama"],
    } as any,
    rateLimiter,
    bm25: {
      encode: vi.fn().mockReturnValue({ indices: [100], values: [1.0] }),
    } as any,
    audit: auditService,
    analytics,
    apiKeyManager,
    banManager,
    runtimeConfig,
  };
}

// =========================================================================
// Lifecycle
// =========================================================================

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "em-phase2-test-"));

  // 真实 ApiKeyManager (临时 SQLite DB)
  apiKeyManager = new ApiKeyManager({
    dbPath: join(tmpDir, "admin.db"),
    keyPrefix: "em_",
  });
  apiKeyManager.open();

  // 真实 BanManager (共享 ApiKeyManager 的 DB)
  banManager = new BanManager({ dbPath: join(tmpDir, "admin.db") });
  const adminDb = apiKeyManager.getDatabase();
  if (adminDb) {
    banManager.open(adminDb);
  } else {
    banManager.open();
  }

  // 真实 RateLimiter
  rateLimiter = new RateLimiter({
    maxCallsPerMinute: 60,
    geminiMaxCallsPerHour: 200,
    geminiMaxCallsPerDay: 2000,
  });

  // 真实 AuditService (临时 JSONL)
  auditService = new AuditService({
    logPath: join(tmpDir, "audit.jsonl"),
    enabled: true,
    flushIntervalMs: 60_000, // 禁用自动刷盘，手动控制
    maxBufferSize: 1000,
  });
  auditService.start();

  // 真实 RuntimeConfigManager
  runtimeConfig = new RuntimeConfigManager({
    defaults: {
      rate_limit_per_minute: 60,
      gemini_max_per_hour: 200,
      gemini_max_per_day: 2000,
      default_project: "test-project",
      require_tls: false,
      audit_enabled: true,
      raw_retention_days: 30,
      hourly_retention_days: 7,
      daily_retention_days: 90,
    },
  });

  // Spies
  auditRecordSpy = vi.spyOn(auditService, "record");
  auditBuildEntrySpy = vi.spyOn(auditService, "buildEntry");
  analyticsIngestSpy = vi.fn();
});

afterAll(async () => {
  await auditService.close();
  apiKeyManager.close();
  banManager.close();

  // 清理临时目录
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试
  }
});

beforeEach(() => {
  auditRecordSpy.mockClear();
  auditBuildEntrySpy.mockClear();
  analyticsIngestSpy.mockClear();
});

// =========================================================================
// Test Suite 1: 双层鉴权 — Master Token vs Managed API Key
// =========================================================================

describe("Fix #2: 双层鉴权 (Dual-Auth)", () => {
  it("Master Token → authMode='master', 直通无 per-key 检查", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qdrant).toBe("ready");
  });

  it("Managed API Key → authMode='api_key', 成功认证", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // 创建 managed key
    const created = apiKeyManager.createKey(
      { name: "test-key-dual-auth" },
      "system",
    );

    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });

    expect(res.status).toBe(200);
  });

  it("无效 Token → 401 Unauthorized", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/api/status", {
      headers: { Authorization: "Bearer totally-invalid-token-xyz" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid");
  });

  it("已吊销的 API Key → 401 Unauthorized", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const created = apiKeyManager.createKey(
      { name: "revoked-key-test" },
      "system",
    );
    apiKeyManager.revokeKey(created.id);

    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });

    expect(res.status).toBe(401);
  });

  it("缺少 Authorization header → 401", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/api/status");
    expect(res.status).toBe(401);
  });

  it("Basic scheme (非 Bearer) → 401", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/api/status", {
      headers: { Authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` },
    });

    expect(res.status).toBe(401);
  });

  it("开发模式 (httpAuthToken 为空) → 跳过鉴权", async () => {
    const container = buildContainer({ httpAuthToken: "" });
    const app = createApp(container);

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// Test Suite 2: Per-Key Rate Limiting
// =========================================================================

describe("Fix #3: Per-Key 限流", () => {
  it("Managed key 超过 per-key 限流 → 429", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // 创建限流很低的 key (每分钟 3 次)
    const created = apiKeyManager.createKey(
      { name: "rate-limited-key", rate_limit_per_minute: 3 },
      "system",
    );

    const makeReq = () =>
      app.request("/api/status", {
        headers: { Authorization: `Bearer ${created.key}` },
      });

    // 前 3 次应该成功
    for (let i = 0; i < 3; i++) {
      const res = await makeReq();
      expect(res.status).toBe(200);
    }

    // 第 4 次应该被限流
    const res = await makeReq();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many requests");
  });

  it("Master Token 走全局限流而非 per-key", async () => {
    const container = buildContainer({ rateLimitPerMinute: 100 });
    const app = createApp(container);

    // Master token 不受 per-key 限制
    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("不同 key 的限流独立", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const key1 = apiKeyManager.createKey(
      { name: "key-independent-1", rate_limit_per_minute: 2 },
      "system",
    );
    const key2 = apiKeyManager.createKey(
      { name: "key-independent-2", rate_limit_per_minute: 2 },
      "system",
    );

    // key1 用尽 2 次
    await app.request("/api/status", {
      headers: { Authorization: `Bearer ${key1.key}` },
    });
    await app.request("/api/status", {
      headers: { Authorization: `Bearer ${key1.key}` },
    });

    // key2 应该仍然可用
    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${key2.key}` },
    });
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// Test Suite 3: Per-Key Ban
// =========================================================================

describe("Fix #2+#5: Per-Key Ban 检查", () => {
  it("Banned API Key → 403 Forbidden", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const created = apiKeyManager.createKey(
      { name: "key-to-ban" },
      "system",
    );

    // Ban this key
    banManager.createBan(
      {
        type: "api_key",
        target: created.id,
        reason: "Abuse detected in testing",
      },
      "system",
    );

    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toContain("banned");
    expect(body.ban_reason).toBe("Abuse detected in testing");
  });

  it("移除 Ban 后 Key 恢复访问", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const created = apiKeyManager.createKey(
      { name: "key-ban-then-unban" },
      "system",
    );

    // Ban
    const ban = banManager.createBan(
      {
        type: "api_key",
        target: created.id,
        reason: "Temporary ban for testing",
      },
      "system",
    );

    // 确认被 ban
    const resBanned = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(resBanned.status).toBe(403);

    // 移除 ban
    banManager.removeBan(ban.id);

    // 确认恢复
    const resUnbanned = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(resUnbanned.status).toBe(200);
  });
});

// =========================================================================
// Test Suite 4: IP Ban
// =========================================================================

describe("Fix #4: IP Ban + 共享 IP 提取", () => {
  it("Banned IP → 403 on /api/* routes", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // Ban IP (server.ts 使用 getClientIp 从 X-Forwarded-For 提取)
    banManager.createBan(
      {
        type: "ip",
        target: "10.0.0.99",
        reason: "DDoS source",
      },
      "system",
    );

    const res = await app.request("/api/status", {
      headers: {
        Authorization: `Bearer ${MASTER_TOKEN}`,
        "X-Forwarded-For": "10.0.0.99",
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toContain("IP address is banned");
    expect(body.ban_reason).toBe("DDoS source");

    // 清理: 移除 ban
    const bans = banManager.listBans({ type: "ip", page: 1, page_size: 50 });
    for (const ban of bans.data) {
      if (ban.target === "10.0.0.99") {
        banManager.removeBan(ban.id);
      }
    }
  });

  it("非 banned IP → 正常通过", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/api/status", {
      headers: {
        Authorization: `Bearer ${MASTER_TOKEN}`,
        "X-Forwarded-For": "192.168.1.1",
      },
    });

    expect(res.status).toBe(200);
  });

  it("Admin 路由不受 IP ban 影响", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // Ban an IP
    banManager.createBan(
      {
        type: "ip",
        target: "10.0.0.50",
        reason: "Test ban",
      },
      "system",
    );

    // Admin 路由应跳过 ban 检查
    const res = await app.request("/api/admin/health", {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "X-Forwarded-For": "10.0.0.50",
      },
    });

    expect(res.status).toBe(200);

    // 清理
    const bans = banManager.listBans({ type: "ip", page: 1, page_size: 50 });
    for (const ban of bans.data) {
      if (ban.target === "10.0.0.50") {
        banManager.removeBan(ban.id);
      }
    }
  });
});

// =========================================================================
// Test Suite 5: 审计中间件双写
// =========================================================================

describe("Fix #1: 审计中间件 (Audit Middleware)", () => {
  it("成功请求触发 AuditService.record() + AnalyticsService.ingestEvent()", async () => {
    const container = buildContainer();
    const app = createApp(container);

    await app.request("/api/status", {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });

    // 审计中间件应调用 buildEntry + record
    expect(auditBuildEntrySpy).toHaveBeenCalledTimes(1);
    expect(auditRecordSpy).toHaveBeenCalledTimes(1);

    // 验证 buildEntry 参数
    const buildArgs = auditBuildEntrySpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(buildArgs.operation).toBe("memory_status");
    expect(buildArgs.httpMethod).toBe("GET");
    expect(buildArgs.httpPath).toBe("/api/status");
    expect(buildArgs.httpStatus).toBe(200);
    expect(buildArgs.keyPrefix).toBe("master");

    // AnalyticsService.ingestEvent 也应被调用
    expect(analyticsIngestSpy).toHaveBeenCalledTimes(1);
  });

  it("Managed key 请求的审计记录包含 key_prefix", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const created = apiKeyManager.createKey(
      { name: "audit-key-prefix-test" },
      "system",
    );

    await app.request("/api/status", {
      headers: { Authorization: `Bearer ${created.key}` },
    });

    expect(auditBuildEntrySpy).toHaveBeenCalledTimes(1);
    const buildArgs = auditBuildEntrySpy.mock.calls[0]![0] as Record<string, unknown>;

    // keyPrefix 应该是 key_hash 的前 8 字符
    const keyRecord = apiKeyManager.validateKey(created.key!);
    const expectedPrefix = keyRecord!.key_hash.slice(0, 8);
    expect(buildArgs.keyPrefix).toBe(expectedPrefix);
  });

  it("POST /api/save 的审计记录 operation='memory_save'", async () => {
    const container = buildContainer();
    const app = createApp(container);

    await app.request("/api/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MASTER_TOKEN}`,
      },
      body: JSON.stringify({
        content: "Test memory for audit",
        project: "my-project",
      }),
    });

    expect(auditBuildEntrySpy).toHaveBeenCalledTimes(1);
    const buildArgs = auditBuildEntrySpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(buildArgs.operation).toBe("memory_save");
    expect(buildArgs.project).toBe("my-project");
    expect(buildArgs.httpMethod).toBe("POST");
  });

  it("Admin 路由跳过通用审计中间件", async () => {
    const container = buildContainer();
    const app = createApp(container);

    await app.request("/api/admin/health", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    // 通用审计中间件跳过 admin 路由
    expect(auditBuildEntrySpy).not.toHaveBeenCalled();
    expect(auditRecordSpy).not.toHaveBeenCalled();
  });

  it("审计记录包含客户端 IP", async () => {
    const container = buildContainer();
    const app = createApp(container);

    await app.request("/api/status", {
      headers: {
        Authorization: `Bearer ${MASTER_TOKEN}`,
        "X-Forwarded-For": "203.0.113.42, 10.0.0.1",
      },
    });

    const buildArgs = auditBuildEntrySpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(buildArgs.clientIp).toBe("203.0.113.42");
  });

  it("审计失败不影响请求响应", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // 让 record 抛出异常
    auditRecordSpy.mockImplementationOnce(() => {
      throw new Error("Disk full");
    });

    const res = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });

    // 请求应仍然成功
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// Test Suite 6: DB 共享连接 + BanManager ownsDb
// =========================================================================

describe("Fix #5+#6: SQLite DB 共享 + ownsDb 生命周期", () => {
  it("ApiKeyManager.getDatabase() 返回有效的 DB 实例", () => {
    const db = apiKeyManager.getDatabase();
    expect(db).not.toBeNull();
  });

  it("BanManager 共享 DB 时关闭不影响 ApiKeyManager", () => {
    // 创建独立实例测试
    const tmpDbPath = join(tmpDir, "lifecycle-test.db");
    const akm = new ApiKeyManager({ dbPath: tmpDbPath });
    akm.open();

    const bm = new BanManager({ dbPath: tmpDbPath });
    const db = akm.getDatabase();
    expect(db).not.toBeNull();
    bm.open(db!);

    // BanManager.close() 不应关闭共享 DB
    bm.close();

    // ApiKeyManager 应仍然可用
    const key = akm.createKey({ name: "after-bm-close" }, "system");
    expect(key.id).toBeDefined();

    akm.close();
  });

  it("BanManager 独立打开时 close() 正确关闭 DB", () => {
    const tmpDbPath = join(tmpDir, "independent-bm.db");
    const bm = new BanManager({ dbPath: tmpDbPath });
    bm.open();

    // 验证 ban 功能可用
    const ban = bm.createBan(
      { type: "ip", target: "1.2.3.4", reason: "test" },
      "system",
    );
    expect(ban.id).toBeDefined();

    // 关闭后清理
    bm.close();
  });

  it("Ban 通过共享 DB 可跨服务查询", () => {
    // 在 banManager 中创建 ban，验证跟 apiKeyManager 共享同一 DB
    const key = apiKeyManager.createKey(
      { name: "cross-service-ban-test" },
      "system",
    );

    const ban = banManager.createBan(
      { type: "api_key", target: key.id, reason: "Cross-service test" },
      "system",
    );

    // 检查 ban 状态
    const check = banManager.isKeyBanned(key.id);
    expect(check.banned).toBe(true);

    // 清理
    banManager.removeBan(ban.id);
  });
});

// =========================================================================
// Test Suite 7: RuntimeConfig onChange 联动
// =========================================================================

describe("Fix #7: RuntimeConfig onChange 联动", () => {
  it("updateConfig 触发 onChange 监听器", () => {
    const listener = vi.fn();
    const unsub = runtimeConfig.onChange(listener);

    runtimeConfig.updateConfig({ rate_limit_per_minute: 120 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        rate_limit_per_minute: 120,
      }),
      expect.arrayContaining(["rate_limit_per_minute"]),
    );

    // 还原
    runtimeConfig.resetConfig(["rate_limit_per_minute"]);
    unsub();
  });

  it("resetConfig 触发 onChange 监听器", () => {
    const listener = vi.fn();
    runtimeConfig.updateConfig({ audit_enabled: false });

    const unsub = runtimeConfig.onChange(listener);
    runtimeConfig.resetConfig(["audit_enabled"]);

    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("unsubscribe 后不再收到通知", () => {
    const listener = vi.fn();
    const unsub = runtimeConfig.onChange(listener);
    unsub();

    runtimeConfig.updateConfig({ rate_limit_per_minute: 999 });
    expect(listener).not.toHaveBeenCalled();

    // 还原
    runtimeConfig.resetConfig(["rate_limit_per_minute"]);
  });

  it("监听器异常不阻塞其他监听器", () => {
    const badListener = vi.fn(() => {
      throw new Error("Listener explosion");
    });
    const goodListener = vi.fn();

    const unsub1 = runtimeConfig.onChange(badListener);
    const unsub2 = runtimeConfig.onChange(goodListener);

    // 不应抛出
    expect(() => {
      runtimeConfig.updateConfig({ default_project: "new-project" });
    }).not.toThrow();

    expect(goodListener).toHaveBeenCalledTimes(1);

    // 还原
    runtimeConfig.resetConfig(["default_project"]);
    unsub1();
    unsub2();
  });
});

// =========================================================================
// Test Suite 8: 完整链路 — API Key 生命周期 E2E
// =========================================================================

describe("完整链路: API Key 生命周期", () => {
  it("创建 → 使用 → 审计 → 限流 → Ban → 吊销", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // ① 创建 API Key (通过 admin API)
    const createRes = await app.request("/api/admin/keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        name: "lifecycle-e2e-key",
        rate_limit_per_minute: 5,
      }),
    });
    expect(createRes.status).toBe(201);
    const keyData = (await createRes.json()) as { id: string; key: string };
    expect(keyData.key).toBeDefined();
    expect(keyData.id).toBeDefined();

    // ② 使用 API Key 发起请求
    auditRecordSpy.mockClear();
    analyticsIngestSpy.mockClear();

    const useRes = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${keyData.key}` },
    });
    expect(useRes.status).toBe(200);

    // ③ 验证审计记录
    expect(auditRecordSpy).toHaveBeenCalledTimes(1);
    expect(analyticsIngestSpy).toHaveBeenCalledTimes(1);

    // ④ 消耗限流 (已用 1 次, 限制 5 次)
    for (let i = 0; i < 4; i++) {
      const r = await app.request("/api/status", {
        headers: { Authorization: `Bearer ${keyData.key}` },
      });
      expect(r.status).toBe(200);
    }
    // 第 6 次应被限流
    const rateLimited = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${keyData.key}` },
    });
    expect(rateLimited.status).toBe(429);

    // ⑤ Ban this key (通过 admin API)
    const banRes = await app.request("/api/admin/bans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        type: "api_key",
        target: keyData.id,
        reason: "Lifecycle test ban",
      }),
    });
    expect(banRes.status).toBe(201);

    // ⑥ 吊销 key (通过 admin API)
    const revokeRes = await app.request(`/api/admin/keys/${keyData.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(revokeRes.status).toBe(200);

    // ⑦ 使用吊销后的 key → 401
    const revokedRes = await app.request("/api/status", {
      headers: { Authorization: `Bearer ${keyData.key}` },
    });
    expect(revokedRes.status).toBe(401);
  });
});

// =========================================================================
// Test Suite 9: 中间件链顺序验证
// =========================================================================

describe("中间件链顺序正确性", () => {
  it("IP ban 先于鉴权检查 (fail-fast)", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // Ban an IP
    const ban = banManager.createBan(
      { type: "ip", target: "172.16.0.1", reason: "Priority test" },
      "system",
    );

    // 即使没有 Auth header，也应返回 403 (不是 401)
    const res = await app.request("/api/status", {
      headers: {
        "X-Forwarded-For": "172.16.0.1",
      },
    });
    expect(res.status).toBe(403);

    // 清理
    banManager.removeBan(ban.id);
  });

  it("GET /api/status 跳过全局限流", async () => {
    const container = buildContainer({ rateLimitPerMinute: 2 });
    const app = createApp(container);

    // 发送多个 GET /api/status 请求 (只读健康检查)
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/status", {
        headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("Health check (/health) 无需鉴权", async () => {
    const container = buildContainer();
    const app = createApp(container);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("Content-Type 校验在鉴权之后", async () => {
    const container = buildContainer();
    const app = createApp(container);

    // 无 Auth → 应先返回 401 而非 415
    const res = await app.request("/api/save", {
      method: "POST",
      body: "plain text",
    });
    expect(res.status).toBe(401);
  });
});

// =========================================================================
// Test Suite 10: RateLimiter stats 完整性
// =========================================================================

describe("RateLimiter Per-Key Stats", () => {
  it("getStats() 包含 per_key_limiter_count", () => {
    const stats = rateLimiter.getStats();
    expect(stats).toHaveProperty("per_key_limiter_count");
    expect(typeof stats.per_key_limiter_count).toBe("number");
  });
});
