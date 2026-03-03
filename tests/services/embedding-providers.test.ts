/**
 * @module embedding-providers.test
 * @description EmbeddingProvider 单元测试 — Mock fetch 验证 Ollama/Gemini/validateVector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateVector,
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
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
    // 竞态场景: attempt 0 失败 → 进入 retry sleep → close() → sleep 结束 → safeFetch 前置守卫拦截
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

    // close() 在 retry sleep 期间被调用
    provider.close();

    // 推进时间让 sleep(1000) 结束
    await vi.advanceTimersByTimeAsync(2000);

    // 应拒绝为 "shutting down"，不应发起第 2 次 fetch
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
    expect(() => new GeminiEmbeddingProvider({ apiKey: "" })).toThrow(
      "API key is required",
    );
  });

  it("should create with API key and default config", () => {
    const provider = new GeminiEmbeddingProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("gemini");
    expect(provider.modelName).toBe("gemini-embedding-001");
    expect(provider.dimension).toBe(1024);
  });

  it("should create with custom config", () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      model: "custom-model",
      outputDimensionality: 512,
    });
    expect(provider.modelName).toBe("custom-model");
    expect(provider.dimension).toBe(512);
  });

  it("should call Gemini API with correct parameters (MRL)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embedding: { values: new Array(1024).fill(0.2) },
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = new GeminiEmbeddingProvider({
      apiKey: "test-key",
      model: "gemini-embedding-001",
      outputDimensionality: 1024,
    });
    await provider.embed("hello gemini");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toContain("gemini-embedding-001:embedContent");
    expect(url).not.toContain("key=");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      content: { parts: [{ text: "hello gemini" }] },
      outputDimensionality: 1024,
    });
  });

  it("should return embedding vector on success", async () => {
    const expectedVector = new Array(1024).fill(0.3);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: expectedVector } }),
    });

    const provider = new GeminiEmbeddingProvider({ apiKey: "k" });
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
          embedding: { values: new Array(1024).fill(0.1) },
        }),
      };
    });

    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
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
      maxRetries: 2,
    });
    await expect(provider.embed("fail")).rejects.toThrow("network down");
  });

  it("should throw on empty embedding response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: [] } }),
    });
    const provider = new GeminiEmbeddingProvider({
      apiKey: "k",
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
      const provider = new GeminiEmbeddingProvider({ apiKey: "k" });
      expect(await provider.healthCheck()).toBe(true);
    });

    it("should return false when Gemini is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new GeminiEmbeddingProvider({ apiKey: "k" });
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

      const provider = new GeminiEmbeddingProvider({ apiKey: "k" });
      const healthPromise = provider.healthCheck();
      provider.close();
      expect(await healthPromise).toBe(false);
    });
  });
});
