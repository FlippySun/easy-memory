/**
 * @module tests/api/server.test
 * @description HTTP API 路由单元测试 — mock 核心服务，验证 HTTP 协议适配。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/server.js";
import type { AppContainer } from "../../src/container.js";
import type { AppConfig } from "../../src/container.js";

// =========================================================================
// Mock Container Factory
// =========================================================================

function createMockContainer(overrides: Partial<AppConfig> = {}): AppContainer {
  const config: AppConfig = {
    qdrantUrl: "http://localhost:6333",
    qdrantApiKey: "test-key",
    embeddingProvider: "ollama",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    geminiApiKey: "",
    geminiModel: "gemini-embedding-001",
    defaultProject: "test-project",
    rateLimitPerMinute: 60,
    geminiMaxPerHour: 200,
    geminiMaxPerDay: 2000,
    mode: "http",
    httpPort: 3080,
    httpAuthToken: "test-token",
    httpHost: "127.0.0.1",
    trustProxy: false,
    requireTls: false,
    adminToken: "test-admin-token",
    ...overrides,
  };

  return {
    config,
    qdrant: {
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({
        name: "em_test-project",
        points_count: 42,
      }),
      getPointPayload: vi.fn().mockResolvedValue({
        lifecycle: "active",
        project: "test-project",
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
    rateLimiter: {
      checkRate: vi.fn(),
      recordGeminiCall: vi.fn(),
      isGeminiCircuitOpen: false,
      getStats: vi.fn().mockReturnValue({
        calls_last_minute: 0,
        gemini_calls_last_hour: 0,
        gemini_calls_today: 0,
        gemini_circuit_open: false,
      }),
      resetDaily: vi.fn(),
    } as any,
    bm25: {
      encode: vi.fn().mockReturnValue({ indices: [100], values: [1.0] }),
    } as any,
    audit: {
      buildEntry: vi
        .fn()
        .mockImplementation((params: Record<string, unknown>) => ({
          event_id: "evt-test",
          timestamp: new Date().toISOString(),
          key_prefix: String(params.keyPrefix ?? ""),
          user_agent: String(params.userAgent ?? ""),
          client_ip: String(params.clientIp ?? ""),
          operation: String(params.operation ?? "memory_status"),
          project: String(params.project ?? "test-project"),
          outcome: String(params.outcome ?? "success"),
          outcome_detail: String(params.outcomeDetail ?? ""),
          elapsed_ms: Number(params.elapsedMs ?? 0),
          http_method: String(params.httpMethod ?? "GET"),
          http_path: String(params.httpPath ?? "/api/status"),
          http_status: Number(params.httpStatus ?? 200),
        })),
      record: vi.fn(),
      recordEvent: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        total_events: 0,
        buffer_size: 0,
        events_written: 0,
        write_errors: 0,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as any,
    analytics: {
      isReady: true,
      ingestEvent: vi.fn().mockReturnValue(true),
      recordEvent: vi.fn(),
      queryEvents: vi.fn().mockReturnValue({
        data: [],
        pagination: {
          page: 1,
          page_size: 50,
          total_count: 0,
          total_pages: 0,
        },
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
      close: vi.fn(),
    } as any,
    apiKeyManager: {
      open: vi.fn(),
      close: vi.fn(),
      createKey: vi.fn(),
      getKeyById: vi.fn(),
      getKeyByHash: vi.fn(),
      validateKey: vi.fn(),
      listKeys: vi.fn().mockReturnValue({
        data: [],
        pagination: {
          page: 1,
          page_size: 20,
          total_count: 0,
          total_pages: 0,
        },
      }),
      updateKey: vi.fn(),
      revokeKey: vi.fn(),
      rotateKey: vi.fn(),
      recordUsage: vi.fn(),
      recordAdminAction: vi.fn(),
      listAdminActions: vi.fn().mockReturnValue({
        data: [],
        pagination: {
          page: 1,
          page_size: 50,
          total_count: 0,
          total_pages: 0,
        },
      }),
      hashKey: vi.fn().mockReturnValue("mocked-hash"),
    } as any,
    banManager: {
      open: vi.fn(),
      close: vi.fn(),
      createBan: vi.fn(),
      removeBan: vi.fn(),
      getBanById: vi.fn(),
      listBans: vi.fn().mockReturnValue({
        data: [],
        pagination: {
          page: 1,
          page_size: 20,
          total_count: 0,
          total_pages: 0,
        },
      }),
      isKeyBanned: vi.fn().mockReturnValue({ banned: false }),
      isIpBanned: vi.fn().mockReturnValue({ banned: false }),
    } as any,
    runtimeConfig: {
      getConfig: vi.fn().mockReturnValue({
        rate_limit_per_minute: 60,
        gemini_max_per_hour: 200,
        gemini_max_per_day: 2000,
        default_project: "test-project",
        require_tls: false,
        audit_enabled: true,
        raw_retention_days: 30,
        hourly_retention_days: 7,
        daily_retention_days: 90,
      }),
      getDefaults: vi.fn().mockReturnValue({}),
      getOverrides: vi.fn().mockReturnValue({}),
      updateConfig: vi.fn().mockReturnValue({}),
      resetConfig: vi.fn().mockReturnValue({}),
      isOverridden: vi.fn().mockReturnValue(false),
    } as any,
  };
}

// =========================================================================
// Tests
// =========================================================================

describe("HTTP API Server", () => {
  let container: AppContainer;

  beforeEach(() => {
    container = createMockContainer();
  });

  // ===== Health Check =====

  describe("GET /health", () => {
    it("should return 200 without auth", async () => {
      const app = createApp(container);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.mode).toBe("http");
    });
  });

  // ===== MCP Server Card =====

  describe("GET /.well-known/mcp/server-card.json", () => {
    it("should return server metadata without auth", async () => {
      const app = createApp(container);
      const res = await app.request("/.well-known/mcp/server-card.json");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.serverInfo.name).toBe("easy-memory");
      expect(body.serverInfo.version).toBeDefined();
      expect(body.authentication.required).toBe(true);
      expect(body.tools).toBeInstanceOf(Array);
      expect(body.tools.length).toBe(8);
      const toolNames = body.tools.map((t: any) => t.name);
      expect(toolNames).toContain("memory_save");
      expect(toolNames).toContain("memory_search");
      expect(toolNames).toContain("memory_forget");
      expect(toolNames).toContain("memory_status");
      expect(toolNames).toContain("easy_memory_save");
      expect(toolNames).toContain("easy_memory_search");
      expect(toolNames).toContain("easy_memory_forget");
      expect(toolNames).toContain("easy_memory_status");

      const canonicalSearch = body.tools.find(
        (t: any) => t.name === "memory_search",
      );
      const aliasSearch = body.tools.find(
        (t: any) => t.name === "easy_memory_search",
      );
      expect(aliasSearch.description).toContain("[PREFERRED ALIAS]");
      expect(aliasSearch.inputSchema).toEqual(canonicalSearch.inputSchema);
    });
  });

  // ===== MCP Streamable HTTP (/mcp) =====

  describe("POST /mcp", () => {
    it("should allow valid unbanned API key", async () => {
      (
        container.apiKeyManager.validateKey as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        id: "key-1",
        key_hash: "abcd1234hash",
        prefix: "em_test",
      });
      (
        container.banManager.isKeyBanned as ReturnType<typeof vi.fn>
      ).mockReturnValue({ banned: false });

      const app = createApp(container);
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer managed-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "vitest", version: "1.0.0" },
          },
        }),
      });

      expect(res.status).not.toBe(403);
      expect(container.apiKeyManager.recordUsage).toHaveBeenCalled();
    });

    it("should reject banned API key with 403", async () => {
      (
        container.apiKeyManager.validateKey as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        id: "key-2",
        key_hash: "efgh5678hash",
        prefix: "em_test",
      });
      (
        container.banManager.isKeyBanned as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        banned: true,
        reason: "manual ban",
        expires_at: null,
      });

      const app = createApp(container);
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer banned-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "vitest", version: "1.0.0" },
          },
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error?.message).toContain("banned");
    });
  });

  // ===== Auth =====

  describe("Authentication", () => {
    it("should reject unauthenticated /api/ requests", async () => {
      const app = createApp(container);
      const res = await app.request("/api/status");
      expect(res.status).toBe(401);
    });

    it("should accept authenticated requests", async () => {
      const app = createApp(container);
      const res = await app.request("/api/status", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
      expect((container.audit as any).buildEntry).toHaveBeenCalledTimes(1);
      expect((container.audit as any).record).toHaveBeenCalledTimes(1);
      expect((container.analytics as any).ingestEvent).toHaveBeenCalledTimes(1);
    });

    it("should skip auth when token is empty (dev mode)", async () => {
      container = createMockContainer({ httpAuthToken: "" });
      const app = createApp(container);
      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
    });
  });

  // ===== POST /api/save =====

  describe("POST /api/save", () => {
    it("should save a memory and return result", async () => {
      const app = createApp(container);
      const res = await app.request("/api/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          content: "Test memory content to save",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("saved");
      expect(body.id).toBeDefined();
    });
  });

  // ===== POST /api/search =====

  describe("POST /api/search", () => {
    it("should search memories and return result", async () => {
      const app = createApp(container);
      const res = await app.request("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          query: "test query",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.memories).toBeDefined();
      expect(body.system_note).toBeDefined();
    });
  });

  // ===== POST /api/forget =====

  describe("POST /api/forget", () => {
    it("should forget a memory", async () => {
      const app = createApp(container);
      const res = await app.request("/api/forget", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          id: "550e8400-e29b-41d4-a716-446655440000",
          action: "archive",
          reason: "test reason",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBeDefined();
      expect((container.qdrant as any).getPointPayload).toHaveBeenCalledWith(
        "test-project",
        "550e8400-e29b-41d4-a716-446655440000",
      );
    });
  });

  // ===== GET /api/status =====

  describe("GET /api/status", () => {
    it("should return system status", async () => {
      const app = createApp(container);
      const res = await app.request("/api/status", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.qdrant).toBe("ready");
      expect(body.embedding).toBe("ready");
      expect(body.session).toBeDefined();
    });

    it("should accept project query param", async () => {
      const app = createApp(container);
      const res = await app.request("/api/status?project=my-project", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
    });
  });
});
