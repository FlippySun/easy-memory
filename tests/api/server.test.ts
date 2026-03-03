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
