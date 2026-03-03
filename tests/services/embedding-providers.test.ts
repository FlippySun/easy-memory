/**
 * @module embedding-providers.test
 * @description EmbeddingProvider 单元测试 — Mock fetch 验证 Ollama/Gemini/validateVector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateVector,
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
  NonRetryableError,
} from "../../src/services/embedding-providers.js";

// =========================================================================
// validateVector
// =========================================================================

describe("validateVector", () => {
  it("should pass for correct vector", () => {
    expect(() => validateVector(new Array(1024).fill(0.1), 1024)).not.toThrow();
  });

  it("should throw on dimension mismatch", () => {
    expect(() => validateVector([0.1, 0.2], 1024)).toThrow(
      "dimension mismatch",
    );
  });

  it("should throw on NaN value", () => {
    const vec = new Array(1024).fill(0.1);
    vec[100] = NaN;
    expect(() => validateVector(vec, 1024)).toThrow("NaN");
  });

  it("should throw on Infinity value", () => {
    const vec = new Array(1024).fill(0.1);
    vec[50] = Infinity;
    expect(() => validateVector(vec, 1024)).toThrow("Infinity");
  });

  it("should throw on negative Infinity", () => {
    const vec = new Array(1024).fill(0.1);
    vec[0] = -Infinity;
    expect(() => validateVector(vec, 1024)).toThrow("Infinity");
  });

  it("should pass for zero vector", () => {
    expect(() => validateVector(new Array(1024).fill(0), 1024)).not.toThrow();
  });
});

// =========================================================================
// OllamaEmbeddingProvider
// =========================================================================

describe("OllamaEmbeddingProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should create with default config", () => {
    const provider = new OllamaEmbeddingProvider();
    expect(provider.name).toBe("ollama");
    expect(provider.modelName).toBe("bge-m3");
    expect(provider.dimension).toBe(1024);
  });

  it("should create with custom config", () => {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://custom:11434",
      model: "custom-model",
    });
    expect(provider.modelName).toBe("custom-model");
  });

  it("should call Ollama API with correct parameters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(1024).fill(0.1) }),
    });
    globalThis.fetch = mockFetch;

    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://test:11434",
      model: "test-model",
    });
    await provider.embed("hello world");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://test:11434/api/embeddings");
    expect(JSON.parse(options.body as string)).toEqual({
      model: "test-model",
      prompt: "hello world",
    });
  });

  it("should return embedding vector on success", async () => {
    const expectedVector = new Array(1024).fill(0.5);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: expectedVector }),
    });

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed("test");
    expect(result).toEqual(expectedVector);
    expect(result).toHaveLength(1024);
  });

  it("should retry on failure with exponential backoff", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("network error");
      }
      return {
        ok: true,
        json: async () => ({ embedding: new Array(1024).fill(0.1) }),
      };
    });

    const provider = new OllamaEmbeddingProvider({ maxRetries: 3 });
    const result = await provider.embed("retry test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(3);
  });

  it("should throw after exhausting retries", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("always fails"));
    const provider = new OllamaEmbeddingProvider({ maxRetries: 2 });
    await expect(provider.embed("fail")).rejects.toThrow("always fails");
  });

  it("should throw on non-ok HTTP response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    const provider = new OllamaEmbeddingProvider({ maxRetries: 1 });
    await expect(provider.embed("error")).rejects.toThrow("500");
  });

  it("should throw on empty embedding response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [] }),
    });
    const provider = new OllamaEmbeddingProvider({ maxRetries: 1 });
    await expect(provider.embed("empty")).rejects.toThrow("empty embedding");
  });

  it("should timeout after configured duration", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_url: string, init: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            });
          });
        },
      );

    const provider = new OllamaEmbeddingProvider({
      timeoutMs: 100,
      maxRetries: 1,
    });
    await expect(provider.embed("timeout")).rejects.toThrow("timed out");
  });

  it("should report 'shutting down' when close() aborts active request", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_url: string, init: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            });
          });
        },
      );

    const provider = new OllamaEmbeddingProvider({
      timeoutMs: 60_000,
      maxRetries: 1,
    });

    const embedPromise = provider.embed("test");
    await vi.advanceTimersByTimeAsync(50);
    provider.close();

    await expect(embedPromise).rejects.toThrow("shutting down");
  });

  it("should NOT make new requests after close() during retry sleep", async () => {
    // 竞态场景: attempt 0 失败 → 进入 retry sleep → close() → sleep 立即 reject → safeFetch 永远不会发起
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      throw new Error("transient error");
    });

    const provider = new OllamaEmbeddingProvider({
      timeoutMs: 60_000,
      maxRetries: 3,
    });

    const embedPromise = provider.embed("test");

    // 等待 attempt 0 的 fetch 失败
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchCallCount).toBe(1);

    // close() 在 retry sleep 期间被调用 — sleep 立即 reject
    provider.close();

    // 应拒绝为 "shutting down"，不应发起第 2 次 fetch
    await expect(embedPromise).rejects.toThrow("shutting down");
    expect(fetchCallCount).toBe(1);
  });

  it("should cancel sleep immediately when close() is called during retry sleep (FIX-2)", async () => {
    // FIX-2 验证: close() 应立即中断 pending sleep，不需等待 sleep 自然到期
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      throw new Error("transient error");
    });

    const provider = new OllamaEmbeddingProvider({
      timeoutMs: 60_000,
      maxRetries: 5,
    });

    const embedPromise = provider.embed("test");

    // 等待 attempt 0 的 fetch 失败
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchCallCount).toBe(1);

    // close() 在 retry sleep 期间被调用 — sleep 应立即 reject
    provider.close();

    // 不需要推进时间 — close() 立即中断 sleep
    await expect(embedPromise).rejects.toThrow("shutting down");
    expect(fetchCallCount).toBe(1);
  });

  describe("healthCheck", () => {
    it("should return true when Ollama is reachable and dimension matches", async () => {
      let callIndex = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        callIndex++;
        if (callIndex === 1) {
          // /api/tags
          return { ok: true };
        }
        // /api/embeddings probe
        return {
          ok: true,
          json: async () => ({ embedding: new Array(1024).fill(0.1) }),
        };
      });
      const provider = new OllamaEmbeddingProvider();
      expect(await provider.healthCheck()).toBe(true);
    });

    it("should return false when Ollama is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new OllamaEmbeddingProvider();
      expect(await provider.healthCheck()).toBe(false);
    });

    // [FIX C-3]: 维度探测
    it("should return false when dimension probe reveals mismatch", async () => {
      let callIndex = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { ok: true };
        }
        // Probe returns 768d instead of expected 1024d
        return {
          ok: true,
          json: async () => ({ embedding: new Array(768).fill(0.1) }),
        };
      });
      const provider = new OllamaEmbeddingProvider({ dimension: 1024 });
      expect(await provider.healthCheck()).toBe(false);
    });

    it("should still pass healthCheck if probe request fails (graceful degradation)", async () => {
      let callIndex = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { ok: true };
        }
        // Probe fails
        throw new Error("model not found");
      });
      const provider = new OllamaEmbeddingProvider();
      // Should still return true — probe failure is non-fatal
      expect(await provider.healthCheck()).toBe(true);
    });

    it("should abort healthCheck when close() is called during check", async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async (_url: string, init: { signal: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted", "AbortError"),
                );
              });
            });
          },
        );

      const provider = new OllamaEmbeddingProvider();
      const healthPromise = provider.healthCheck();
      // close() 应能中止 healthCheck 的 inflight 请求
      provider.close();
      // healthCheck 捕获 abort 返回 false（非抛异常）
      expect(await healthPromise).toBe(false);
    });
  });
});

// =========================================================================
// GeminiEmbeddingProvider
// =========================================================================

describe("GeminiEmbeddingProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should throw if API key is missing", () => {
    expect(
      () => new GeminiEmbeddingProvider({ apiKey: "", projectId: "p" }),
    ).toThrow("API key is required");
  });

  it("should throw if Project ID is missing", () => {
    expect(
      () => new GeminiEmbeddingProvider({ apiKey: "k", projectId: "" }),
    ).toThrow("Project ID is required");
  });

  it("should create with API key, project ID and default config", () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      projectId: "test-project",
    });
    expect(provider.name).toBe("gemini");
    expect(provider.modelName).toBe("gemini-embedding-001");
    expect(provider.dimension).toBe(1024);
  });

  it("should create with custom config", () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      projectId: "test-project",
      model: "custom-model",
      outputDimensionality: 512,
    });
    expect(provider.modelName).toBe("custom-model");
    expect(provider.dimension).toBe(512);
  });

  it("should call Vertex AI API with correct parameters (MRL)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        predictions: [{ embeddings: { values: new Array(1024).fill(0.2) } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      projectId: "test-project",
      region: "us-central1",
      model: "gemini-embedding-001",
      outputDimensionality: 1024,
    });
    await provider.embed("hello gemini");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-embedding-001:predict",
    );
    expect(options.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      instances: [{ content: "hello gemini" }],
      parameters: { outputDimensionality: 1024 },
    });
  });

  it("should return embedding vector on success", async () => {
    const expectedVector = new Array(1024).fill(0.3);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        predictions: [{ embeddings: { values: expectedVector } }],
      }),
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
    });
    const result = await provider.embed("test");
    expect(result).toEqual(expectedVector);
    expect(result).toHaveLength(1024);
  });

  it("should handle 429 rate limit", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, statusText: "Too Many Requests" };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [{ embeddings: { values: new Array(1024).fill(0.1) } }],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 2,
    });
    const result = await provider.embed("rate limited");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(2);
  });

  it("should throw after exhausting retries", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 2,
    });
    await expect(provider.embed("fail")).rejects.toThrow("network down");
  });

  it("should throw on empty embedding response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [] } }] }),
    });
    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 1,
    });
    await expect(provider.embed("empty")).rejects.toThrow("empty embedding");
  });

  it("should timeout after configured duration", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_url: string, init: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            });
          });
        },
      );

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      timeoutMs: 100,
      maxRetries: 1,
    });
    await expect(provider.embed("timeout")).rejects.toThrow("timed out");
  });

  it("should report 'shutting down' when close() aborts active request", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_url: string, init: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            });
          });
        },
      );

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      timeoutMs: 60_000,
      maxRetries: 1,
    });

    const embedPromise = provider.embed("test");
    await vi.advanceTimersByTimeAsync(50);
    provider.close();

    await expect(embedPromise).rejects.toThrow("shutting down");
  });

  describe("healthCheck", () => {
    it("should return true when Gemini is reachable", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      const provider = new GeminiEmbeddingProvider({
        apiKey: "k",
        projectId: "p",
      });
      expect(await provider.healthCheck()).toBe(true);
    });

    it("should return false when Gemini is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new GeminiEmbeddingProvider({
        apiKey: "k",
        projectId: "p",
      });
      expect(await provider.healthCheck()).toBe(false);
    });

    it("should abort healthCheck when close() is called during check", async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async (_url: string, init: { signal: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted", "AbortError"),
                );
              });
            });
          },
        );

      const provider = new GeminiEmbeddingProvider({
        apiKey: "k",
        projectId: "p",
      });
      const healthPromise = provider.healthCheck();
      provider.close();
      expect(await healthPromise).toBe(false);
    });
  });
});

// =========================================================================
// [FIX H-1] NonRetryableError — 4xx 不重试
// =========================================================================

describe("NonRetryableError classification (FIX H-1)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should throw NonRetryableError on 401 without retrying", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "unauthorized",
    });
    globalThis.fetch = fetchSpy;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "bad-key",
      projectId: "p",
      maxRetries: 3,
    });

    await expect(provider.embed("test")).rejects.toThrow(NonRetryableError);
    // 关键: 只调用了 1 次，没有重试
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should throw NonRetryableError on 403 without retrying", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "forbidden",
    });
    globalThis.fetch = fetchSpy;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 3,
    });

    await expect(provider.embed("test")).rejects.toThrow(NonRetryableError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should throw NonRetryableError on 400 without retrying", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "bad request",
    });
    globalThis.fetch = fetchSpy;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 3,
    });

    await expect(provider.embed("test")).rejects.toThrow(NonRetryableError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("should still retry on 5xx server errors", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => "unavailable",
        };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [
            {
              embeddings: { values: new Array(1024).fill(0.1) },
            },
          ],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 5,
    });
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(3); // 重试了 2 次后成功
  });

  it("should NOT treat 408 Request Timeout as non-retryable", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 2) {
        return {
          ok: false,
          status: 408,
          statusText: "Request Timeout",
          text: async () => "timeout",
        };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [
            {
              embeddings: { values: new Array(1024).fill(0.1) },
            },
          ],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 3,
    });
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(2); // 408 允许重试
  });

  it("NonRetryableError should carry statusCode", () => {
    const err = new NonRetryableError("test error", 401);
    expect(err.name).toBe("NonRetryableError");
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("test error");
    expect(err).toBeInstanceOf(Error);
  });
});

// =========================================================================
// [FIX H-2] 429 RESOURCE_EXHAUSTED → NonRetryableError
// =========================================================================

describe("429 RESOURCE_EXHAUSTED detection (FIX H-2)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should throw NonRetryableError on 429 with RESOURCE_EXHAUSTED body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () =>
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded",
          },
        }),
    });
    globalThis.fetch = fetchSpy;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 3,
    });

    await expect(provider.embed("test")).rejects.toThrow(NonRetryableError);
    await expect(provider.embed("test")).rejects.toThrow(/quota/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // 每次调用只 fetch 1 次（不重试）
  });

  it("should retry on temporary 429 (no RESOURCE_EXHAUSTED in body)", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () =>
            JSON.stringify({ error: "rate limited temporarily" }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [
            {
              embeddings: { values: new Array(1024).fill(0.1) },
            },
          ],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 5,
    });
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(3); // 2 次 429 重试后成功
  });

  it("should handle 429 body read failure gracefully (treat as retryable)", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 2) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => {
            throw new Error("body read failed");
          },
        };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [
            {
              embeddings: { values: new Array(1024).fill(0.1) },
            },
          ],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
      maxRetries: 3,
    });
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(2);
  });
});

// =========================================================================
// [FIX C-1] Circuit Breaker Mid-Retry Check
// =========================================================================

describe("Circuit breaker mid-retry abort (FIX C-1)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should abort retry when isCircuitOpen returns true before attempt 2+", async () => {
    let circuitOpen = false;
    let fetchCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // 第一次调用失败 → 触发重试
        // 同时在重试前打开熔断器
        circuitOpen = true;
        throw new Error("temporary failure");
      }
      // 不应到达这里
      return {
        ok: true,
        json: async () => ({ embedding: new Array(1024).fill(0.1) }),
      };
    });

    const provider = new OllamaEmbeddingProvider({
      maxRetries: 5,
      isCircuitOpen: () => circuitOpen,
    });

    await expect(provider.embed("test")).rejects.toThrow(
      /circuit breaker opened during retry/,
    );
    // 只有第一次 fetch 被调用（重试前被熔断器阻止）
    expect(fetchCallCount).toBe(1);
  });

  it("should NOT check circuit breaker on first attempt (attempt 0)", async () => {
    // 即使熔断器打开，第一次尝试仍应执行（由 EmbeddingService 层控制首次过滤）
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(1024).fill(0.1) }),
    });

    const provider = new OllamaEmbeddingProvider({
      maxRetries: 3,
      isCircuitOpen: () => true, // 始终打开
    });

    // 第一次尝试成功，不应被熔断器阻止
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
  });

  it("should allow retry when isCircuitOpen is undefined (backward compat)", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("failure");
      }
      return {
        ok: true,
        json: async () => ({ embedding: new Array(1024).fill(0.1) }),
      };
    });

    // 不传 isCircuitOpen — 应正常重试
    const provider = new OllamaEmbeddingProvider({ maxRetries: 5 });
    const result = await provider.embed("test");
    expect(result).toHaveLength(1024);
    expect(callCount).toBe(3);
  });
});

// =========================================================================
// [FIX F-1] GeminiProvider isCircuitOpen Forwarding
// =========================================================================

describe("GeminiProvider isCircuitOpen forwarding (FIX F-1)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should abort retry when isCircuitOpen returns true (Gemini-specific)", async () => {
    let circuitOpen = false;
    let fetchCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        circuitOpen = true;
        // 5xx → retryable
        return {
          ok: false,
          status: 500,
          statusText: "Server Error",
          text: async () => "",
        };
      }
      return {
        ok: true,
        json: async () => ({
          predictions: [{ embeddings: { values: new Array(1024).fill(0.1) } }],
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      projectId: "test-project",
      maxRetries: 5,
      isCircuitOpen: () => circuitOpen,
    });

    await expect(provider.embed("test")).rejects.toThrow(
      /circuit breaker opened/,
    );
    expect(fetchCallCount).toBe(1);
  });

  it("should verify isCircuitOpen is accessible on GeminiProvider base class", () => {
    const cb = () => false;
    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      projectId: "test-project",
      isCircuitOpen: cb,
    });
    // Access protected field via cast
    expect((provider as any).isCircuitOpen).toBe(cb);
  });
});

// =========================================================================
// [FIX F-2] Post-Sleep Circuit Breaker Check
// =========================================================================

describe("Post-sleep circuit breaker check (FIX F-2)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("should abort after sleep if circuit opens during sleep period", async () => {
    let fetchCallCount = 0;
    let circuitOpen = false;

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        throw new Error("temporary failure");
      }
      return {
        ok: true,
        json: async () => ({ embedding: new Array(1024).fill(0.1) }),
      };
    });

    const provider = new OllamaEmbeddingProvider({
      maxRetries: 5,
      isCircuitOpen: () => circuitOpen,
    });

    // Start embed, first attempt fails, then sleep starts
    const embedPromise = provider.embed("test");

    // Simulate circuit opening during sleep period
    circuitOpen = true;

    await expect(embedPromise).rejects.toThrow(/circuit breaker opened/);
    // Only the first fetch call should have been made
    expect(fetchCallCount).toBe(1);
  });
});

// =========================================================================
// [FIX M-1] Jitter Verification
// =========================================================================

describe("Retry delay jitter (FIX M-1)", () => {
  it("OllamaProvider getRetryDelay should produce values within ±20% of base", () => {
    const provider = new OllamaEmbeddingProvider();
    // Collect multiple samples to verify jitter exists
    const samples = new Set<number>();
    const mathRandomSpy = vi.spyOn(Math, "random");

    // Test with deterministic random values
    mathRandomSpy.mockReturnValueOnce(0); // 0.8 * base
    const minVal = (provider as any).getRetryDelay(1); // base = 1000, result = 800
    expect(minVal).toBe(800);

    mathRandomSpy.mockReturnValueOnce(1); // 1.2 * base
    const maxVal = (provider as any).getRetryDelay(1); // base = 1000, result = 1200
    expect(maxVal).toBe(1200);

    mathRandomSpy.mockReturnValueOnce(0.5); // 1.0 * base
    const midVal = (provider as any).getRetryDelay(1); // base = 1000, result = 1000
    expect(midVal).toBe(1000);

    mathRandomSpy.mockRestore();
  });

  it("GeminiProvider getRetryDelay should produce values within ±20% of base", () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
      projectId: "p",
    });

    const mathRandomSpy = vi.spyOn(Math, "random");

    // Gemini base = 2000 for attempt 1
    mathRandomSpy.mockReturnValueOnce(0); // 0.8 * 2000 = 1600
    expect((provider as any).getRetryDelay(1)).toBe(1600);

    mathRandomSpy.mockReturnValueOnce(1); // 1.2 * 2000 = 2400
    expect((provider as any).getRetryDelay(1)).toBe(2400);

    // attempt 2: base = 4000
    mathRandomSpy.mockReturnValueOnce(0.5); // 1.0 * 4000 = 4000
    expect((provider as any).getRetryDelay(2)).toBe(4000);

    mathRandomSpy.mockRestore();
  });
});
