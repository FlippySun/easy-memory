/**
 * @module status.test
 * @description handleStatus 单元测试 — Mock 服务状态验证
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStatus } from "../../src/tools/status.js";
import type { StatusHandlerDeps } from "../../src/tools/status.js";
import { RateLimiter } from "../../src/utils/rate-limiter.js";

function createMockDeps(): StatusHandlerDeps {
  return {
    qdrant: {
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({
        name: "em_test-project",
        points_count: 42,
      }),
      ensureCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      setPayload: vi.fn(),
    } as unknown as StatusHandlerDeps["qdrant"],
    embedding: {
      healthCheck: vi.fn().mockResolvedValue(true),
      embed: vi.fn(),
    } as unknown as StatusHandlerDeps["embedding"],
    defaultProject: "test-project",
  };
}

describe("handleStatus", () => {
  let deps: StatusHandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should return healthy status when all services are up", async () => {
    const result = await handleStatus({}, deps);

    expect(result.qdrant).toBe("ready");
    expect(result.embedding).toBe("ready");
    expect(result.collection).toEqual({
      name: "em_test-project",
      points_count: 42,
      schema_version: 2,
    });
  });

  it("should return unavailable when Qdrant is down", async () => {
    (deps.qdrant.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false,
    );

    const result = await handleStatus({}, deps);

    expect(result.qdrant).toBe("unavailable");
    expect(result.collection).toBeNull();
  });

  it("should return reconnecting when Embedding is down", async () => {
    (
      deps.embedding.healthCheck as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(false);

    const result = await handleStatus({}, deps);

    expect(result.embedding).toBe("reconnecting");
  });

  it("should use custom project", async () => {
    await handleStatus({ project: "custom-proj" }, deps);

    expect(deps.qdrant.getCollectionInfo).toHaveBeenCalledWith("custom-proj");
  });

  it("should handle collection info error gracefully", async () => {
    (
      deps.qdrant.getCollectionInfo as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("timeout"));

    const result = await handleStatus({}, deps);

    expect(result.qdrant).toBe("ready");
    expect(result.collection).toBeNull();
  });

  it("should return null collection when collection does not exist", async () => {
    (
      deps.qdrant.getCollectionInfo as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);

    const result = await handleStatus({}, deps);

    expect(result.collection).toBeNull();
  });

  // ----- Cost Guard -----

  it("should include cost_guard stats when rateLimiter is provided", async () => {
    const rateLimiter = new RateLimiter({
      maxCallsPerMinute: 100,
      geminiMaxCallsPerHour: 10,
      geminiMaxCallsPerDay: 50,
    });

    // 记录一些调用
    rateLimiter.checkRate();
    rateLimiter.recordGeminiCall();
    rateLimiter.recordGeminiCall();

    deps.rateLimiter = rateLimiter;
    const result = await handleStatus({}, deps);

    expect(result.cost_guard).toBeDefined();
    expect(result.cost_guard!.calls_last_minute).toBe(1);
    expect(result.cost_guard!.gemini_calls_last_hour).toBe(2);
    expect(result.cost_guard!.gemini_calls_today).toBe(2);
    expect(result.cost_guard!.gemini_circuit_open).toBe(false);
  });

  it("should NOT include cost_guard when rateLimiter is not provided", async () => {
    const result = await handleStatus({}, deps);
    expect(result.cost_guard).toBeUndefined();
  });

  // ----- Hybrid Search -----

  it("should report hybrid_search enabled when bm25 is injected", async () => {
    const { BM25Encoder } = await import("../../src/services/bm25.js");
    deps.bm25 = new BM25Encoder();
    const result = await handleStatus({}, deps);

    expect(result.hybrid_search).toBeDefined();
    expect(result.hybrid_search!.bm25_enabled).toBe(true);
    expect(result.hybrid_search!.fusion).toBe("rrf");
    expect(result.hybrid_search!.bm25_vocab_size).toBe(30000);
  });

  it("should report hybrid_search disabled when bm25 is not injected", async () => {
    const result = await handleStatus({}, deps);

    expect(result.hybrid_search).toBeDefined();
    expect(result.hybrid_search!.bm25_enabled).toBe(false);
    expect(result.hybrid_search!.fusion).toBe("disabled");
    expect(result.hybrid_search!.bm25_vocab_size).toBe(0);
  });
});
